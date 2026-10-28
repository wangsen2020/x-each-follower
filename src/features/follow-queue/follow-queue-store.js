import {QUOTE_TAG_DEFAULTS, normalizeQuoteTags, validateQuoteTags} from '../grok/quote-tags.js';
import {compareFollowQueuePriority, followQueuePriority} from './follow-queue-priority.js';
// Extension-origin follow queue. Open this database from the extension, never from an x.com tab.
// Durable outcomes live in their own store so UI log truncation cannot drop dedupe evidence.

const DB_VERSION = 7;
const DEFAULT_DB_NAME = 'x-each-follower-follow-queue';
const STORES = ['jobs', 'outcomes', 'settings', 'meta'];
const PAGE_MAX = 100;
const SEARCH_BATCH = 200;
const SOURCE_FIELDS = {fans: 'sourceFansAt', mutual: 'sourceMutualAt', comments: 'sourceCommentsAt'};
const SOURCE_INDEXES = {fans: 'sourceFans', mutual: 'sourceMutual', comments: 'sourceComments'};
const JOB_STATES = ['pending', 'running', 'followed', 'skipped', 'retry', 'uncertain', 'excluded'];

export const FOLLOW_QUEUE_DEFAULT_SETTINGS = Object.freeze({
  ...QUOTE_TAG_DEFAULTS,
  enabled: false,
  every: 8,
  jitter: 2,
  batchLimit: 5,
  inspectLimit: 20,
  timeBudgetMinutes: 10,
  scrollRounds: 5,
  dwellSeconds: 15,
  dwellJitter: 5,
  minFollowers: 50,
  ratioThreshold: 0.8,
  onlyRecommended: true,
  followBackAllowAll: false,
  skipRiskContent: true,
  grokProfileAssessment: true,
  grokEnabled: false,
  autoPublish: false,
  followBackSuffixEnabled: false,
  knowledgeEnabled: false,
  publicationMode: 'quote',
  quoteParticipationRate: 60,
  quoteLengthMode: 'adaptive'
});

export const PUBLICATION_MODES = Object.freeze(['reply', 'quote', 'article', 'original']);
export const QUOTE_LENGTH_MODES = Object.freeze(['adaptive', 'concise', 'deep']);

const SETTING_BOUNDS = {
  every: [1, 240],
  jitter: [1, 120],
  batchLimit: [1, 50],
  inspectLimit: [1, 200],
  timeBudgetMinutes: [1, 120],
  scrollRounds: [1, 8],
  dwellSeconds: [2, 60],
  dwellJitter: [1, 30],
  minFollowers: [0, 100_000_000],
  ratioThreshold: [0, 1]
};

const DURABLE_STATES = ['followed', 'skipped', 'excluded', 'uncertain'];
const IMPORT_RANK = {skipped: 1, uncertain: 2, excluded: 3, followed: 4};

const STATE_RANK = {
  pending: 1,
  retry: 2,
  skipped: 3,
  excluded: 4,
  followed: 5,
  uncertain: 6,
  running: 7
};

function requireAccountId(accountId) {
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error('missing account; follow queue fails closed');
  }
  return accountId.trim();
}

function userIdString(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') {
    throw new Error('user id must be a decimal string supplied by the caller');
  }
  const id = value.trim();
  if (!/^\d+$/.test(id)) throw new Error('user id must be a decimal string supplied by the caller');
  return id;
}

function canonicalHandle(handle) {
  if (handle == null || handle === '') return '';
  if (typeof handle !== 'string') throw new Error('handle must be a string');
  return handle.trim().replace(/^@+/, '').toLowerCase();
}

function displayHandle(handle, canonical) {
  if (!canonical) return '';
  const raw = String(handle).trim().replace(/^@+/, '');
  return raw || canonical;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function cloneJob(job) {
  if (!job || typeof job !== 'object') return clone(job);
  const copy = clone(job);
  if (Array.isArray(copy.evaluations)) {
    copy.evaluations = copy.evaluations.map(ev => (
      ev && typeof ev === 'object'
        ? {...ev, publicationMode: resolveEvaluationPublicationMode(ev.publicationMode, undefined)}
        : ev
    ));
  }
  return copy;
}

function sourceKey(source) {
  return `${source.module}\0${source.url || ''}`;
}

function normalizeSource(source, seenAt) {
  if (!source || typeof source !== 'object') throw new Error('source must be an object');
  if (source.module !== 'fans' && source.module !== 'mutual' && source.module !== 'comments') {
    throw new Error('source module must be fans, mutual, or comments');
  }
  const url = source.url == null ? '' : String(source.url);
  return {
    module: source.module,
    url,
    enabled: source.enabled === true,
    discoveredAt: Number.isFinite(source.discoveredAt) ? source.discoveredAt : seenAt
  };
}

function mergeSources(existing, incoming) {
  const map = new Map();
  for (const source of existing || []) map.set(sourceKey(source), clone(source));
  for (const source of incoming) {
    const key = sourceKey(source);
    if (!map.has(key)) map.set(key, clone(source));
  }
  return [...map.values()];
}

function mergeAliases(existing, handle, canonical, seenAt) {
  const aliases = Array.isArray(existing) ? existing.map(item => clone(item)) : [];
  if (!canonical) return aliases;
  if (!aliases.some(item => item.canonical === canonical)) {
    aliases.push({canonical, handle, seenAt});
  }
  return aliases;
}

function hasQuoteDecision(decision) {
  return Boolean(
    decision &&
    typeof decision === 'object' &&
    !Array.isArray(decision) &&
    typeof decision.selected === 'boolean' &&
    Number.isFinite(decision.rate) &&
    Number.isFinite(decision.roll)
  );
}

function defaultQuoteRandom() {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is required for quote sampling');
  }
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / (2 ** 32);
}

function isMeaningfulObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function isMeaningfulValue(value) {
  if (value == null || value === '') return false;
  if (typeof value === 'object') {
    return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
  }
  return true;
}

function nonEmptyString(next, prev) {
  if (next != null && String(next) !== '') return String(next);
  if (prev != null && String(prev) !== '') return String(prev);
  return '';
}

function mergeGrokCalls(prevCalls, nextCalls) {
  if (nextCalls == null) return clone(prevCalls);
  if (typeof nextCalls === 'number' && Number.isFinite(nextCalls)) {
    if (nextCalls > 0) {
      return typeof prevCalls === 'number' && Number.isFinite(prevCalls)
        ? Math.max(prevCalls, nextCalls)
        : nextCalls;
    }
    return prevCalls !== undefined ? clone(prevCalls) : 0;
  }
  if (typeof nextCalls === 'object' && !Array.isArray(nextCalls)) {
    const keys = Object.keys(nextCalls);
    if (keys.length === 0) return clone(prevCalls);
    if (prevCalls && typeof prevCalls === 'object' && !Array.isArray(prevCalls)) {
      const merged = {...clone(prevCalls)};
      for (const key of keys) {
        const nextVal = nextCalls[key];
        const prevVal = prevCalls[key];
        if (typeof nextVal === 'number' && Number.isFinite(nextVal)) {
          merged[key] = (nextVal === 0 && typeof prevVal === 'number' && prevVal > 0) ? prevVal : nextVal;
        } else if (nextVal != null && nextVal !== '') {
          merged[key] = clone(nextVal);
        }
      }
      return merged;
    }
    const hasPositive = keys.some(k => typeof nextCalls[k] === 'number' ? nextCalls[k] > 0 : Boolean(nextCalls[k]));
    if (!hasPositive && prevCalls !== undefined) return clone(prevCalls);
    return clone(nextCalls);
  }
  return prevCalls !== undefined ? clone(prevCalls) : undefined;
}

function resolveEvaluationPublicationMode(prevMode, nextMode) {
  if (PUBLICATION_MODES.includes(prevMode)) return prevMode;
  if (PUBLICATION_MODES.includes(nextMode)) return nextMode;
  return FOLLOW_QUEUE_DEFAULT_SETTINGS.publicationMode;
}

function mergeEvaluations(existing, incoming, followJobId) {
  const map = new Map();
  for (const item of existing || []) {
    if (item?.taskId) map.set(item.taskId, clone(item));
  }
  for (const item of incoming || []) {
    if (!item || typeof item !== 'object' || !item.taskId) continue;
    const prev = map.get(item.taskId) || {};
    let attempts;
    if (typeof item.attempts === 'number' && item.attempts > 0) attempts = item.attempts;
    else if (Array.isArray(item.attempts) && item.attempts.length > 0) attempts = item.attempts.map(attempt => clone(attempt));
    else if (typeof prev.attempts === 'number' && prev.attempts > 0) attempts = prev.attempts;
    else if (Array.isArray(prev.attempts) && prev.attempts.length > 0) attempts = prev.attempts.map(attempt => clone(attempt));
    else if (Array.isArray(item.attempts)) attempts = [];
    else if (Array.isArray(prev.attempts)) attempts = [];
    else attempts = [];

    const candidatePosts = Array.isArray(item.candidatePosts) && item.candidatePosts.length > 0
      ? clone(item.candidatePosts)
      : (Array.isArray(prev.candidatePosts) && prev.candidatePosts.length > 0 ? clone(prev.candidatePosts) : []);

    const automaticComment = item.automaticComment === true || prev.automaticComment === true;

    const merged = {
      taskId: String(item.taskId),
      followJobId: item.followJobId || prev.followJobId || followJobId,
      targetUserId: item.targetUserId || prev.targetUserId || '',
      originalAuthorId: item.originalAuthorId || prev.originalAuthorId || '',
      originalPostId: item.originalPostId || prev.originalPostId || '',
      originalPostUrl: item.originalPostUrl || prev.originalPostUrl || '',
      publicationMode: resolveEvaluationPublicationMode(prev.publicationMode, item.publicationMode),
      article: isMeaningfulObject(item.article) ? clone(item.article) : (prev.article ? clone(prev.article) : null),
      coverAttemptedAt: item.coverAttemptedAt ?? prev.coverAttemptedAt ?? 0,
      ...(Array.isArray(item.knowledgeUsed) && item.knowledgeUsed.length ? {knowledgeUsed:clone(item.knowledgeUsed).slice(0,5)} : Array.isArray(prev.knowledgeUsed) ? {knowledgeUsed:clone(prev.knowledgeUsed)} : {}),
      relayJobId: nonEmptyString(item.relayJobId, prev.relayJobId).slice(0,128),
      articleDraftUrl: item.articleDraftUrl || prev.articleDraftUrl || '',
      language: nonEmptyString(item.language, prev.language),
      baseText: nonEmptyString(item.baseText, prev.baseText),
      text: nonEmptyString(item.text, prev.text),
      reason: item.reason != null ? String(item.reason) : (prev.reason || ''),
      channel: item.channel || prev.channel || '',
      status: item.status || prev.status || '',
      automaticComment,
      retryAt: item.retryAt ?? prev.retryAt ?? 0,
      originalPostText: nonEmptyString(item.originalPostText, prev.originalPostText),
      candidatePosts,
      publishedPostId: item.publishedPostId || prev.publishedPostId || '',
      publishedPostUrl: item.publishedPostUrl || prev.publishedPostUrl || '',
      attempts
    };

    const quoteDecision = hasQuoteDecision(prev.quoteDecision)
      ? clone(prev.quoteDecision)
      : (isMeaningfulObject(item.quoteDecision)
        ? clone(item.quoteDecision)
        : (isMeaningfulObject(prev.quoteDecision) ? clone(prev.quoteDecision) : undefined));
    if (quoteDecision !== undefined) merged.quoteDecision = quoteDecision;

    const reasonCode = nonEmptyString(item.reasonCode, prev.reasonCode);
    if (reasonCode !== '') merged.reasonCode = reasonCode;

    const quality = isMeaningfulValue(item.quality)
      ? clone(item.quality)
      : (isMeaningfulValue(prev.quality) ? clone(prev.quality) : undefined);
    if (quality !== undefined) merged.quality = quality;

    const lengthPolicy = isMeaningfulValue(item.lengthPolicy)
      ? clone(item.lengthPolicy)
      : (isMeaningfulValue(prev.lengthPolicy) ? clone(prev.lengthPolicy) : undefined);
    if (lengthPolicy !== undefined) merged.lengthPolicy = lengthPolicy;

    const grokCalls = mergeGrokCalls(prev.grokCalls, item.grokCalls);
    if (grokCalls !== undefined) merged.grokCalls = grokCalls;

    const generationAttemptedAt = (typeof item.generationAttemptedAt === 'number' && item.generationAttemptedAt > 0)
      ? item.generationAttemptedAt
      : ((typeof prev.generationAttemptedAt === 'number' && prev.generationAttemptedAt > 0)
        ? prev.generationAttemptedAt
        : (item.generationAttemptedAt === 0 || prev.generationAttemptedAt === 0 ? 0 : undefined));
    if (generationAttemptedAt !== undefined) merged.generationAttemptedAt = generationAttemptedAt;
    if (Number.isFinite(item.publishedAttemptedAt) || Number.isFinite(prev.publishedAttemptedAt)) {
      merged.publishedAttemptedAt=item.publishedAttemptedAt > 0 ? item.publishedAttemptedAt
        : prev.publishedAttemptedAt > 0 ? prev.publishedAttemptedAt : 0;
    }
    const recoveryHistory = new Map();
    for (const entry of [...(prev.recoveryHistory || []), ...(item.recoveryHistory || [])]) {
      if (entry?.id && !recoveryHistory.has(entry.id)) recoveryHistory.set(entry.id, clone(entry));
    }
    if (recoveryHistory.size) merged.recoveryHistory = [...recoveryHistory.values()];
    if (typeof item.recoveryDraftOnly === 'boolean' || typeof prev.recoveryDraftOnly === 'boolean') {
      merged.recoveryDraftOnly = typeof item.recoveryDraftOnly === 'boolean' ? item.recoveryDraftOnly : prev.recoveryDraftOnly;
    }

    map.set(item.taskId, merged);
  }
  for (const entry of map.values()) {
    if (entry && typeof entry === 'object') {
      entry.publicationMode = resolveEvaluationPublicationMode(entry.publicationMode, undefined);
    }
  }
  return [...map.values()];
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function isValidQuoteRate(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

function validateExplicitQuoteSettings(input) {
  if (!input || typeof input !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(input, 'publicationMode')) {
    if (!PUBLICATION_MODES.includes(input.publicationMode)) {
      throw new Error('发帖形式请选择评论、引用评论或文章');
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'quoteParticipationRate')) {
    if (!isValidQuoteRate(input.quoteParticipationRate)) {
      throw new Error('引用概率请输入 0—100 的整数');
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'quoteLengthMode')) {
    if (!QUOTE_LENGTH_MODES.includes(input.quoteLengthMode)) {
      throw new Error('篇幅仅支持自适应（adaptive）、精简（concise）或深入（deep）');
    }
  }
}

function normalizeSettings(input, base) {
  const merged = {...base, ...(input && typeof input === 'object' ? input : {})};
  const next = {...FOLLOW_QUEUE_DEFAULT_SETTINGS};
  next.enabled = merged.enabled === true;
  next.onlyRecommended = merged.onlyRecommended !== false;
  next.followBackAllowAll = merged.followBackAllowAll === true;
  next.skipRiskContent = merged.skipRiskContent !== false;
  next.grokProfileAssessment = merged.grokProfileAssessment !== false;
  next.grokEnabled = merged.grokEnabled === true;
  next.autoPublish = merged.autoPublish === true;
  next.knowledgeEnabled = merged.knowledgeEnabled === true;
  next.followBackSuffixEnabled = merged.followBackSuffixEnabled === true;
  next.publicationMode = PUBLICATION_MODES.includes(merged.publicationMode)
    ? merged.publicationMode
    : (PUBLICATION_MODES.includes(base?.publicationMode)
      ? base.publicationMode
      : FOLLOW_QUEUE_DEFAULT_SETTINGS.publicationMode);
  for (const [key, [min, max]] of Object.entries(SETTING_BOUNDS)) {
    next[key] = clampInt(merged[key], min, max, FOLLOW_QUEUE_DEFAULT_SETTINGS[key]);
  }
  if (next.jitter > next.every) next.jitter = Math.max(1, next.every);
  next.ratioThreshold = Math.max(0, Math.min(1, Number(merged.ratioThreshold)));
  if (!Number.isFinite(next.ratioThreshold)) next.ratioThreshold = FOLLOW_QUEUE_DEFAULT_SETTINGS.ratioThreshold;
  next.quoteParticipationRate = isValidQuoteRate(merged.quoteParticipationRate)
    ? merged.quoteParticipationRate
    : (isValidQuoteRate(base?.quoteParticipationRate)
      ? base.quoteParticipationRate
      : FOLLOW_QUEUE_DEFAULT_SETTINGS.quoteParticipationRate);
  next.quoteLengthMode = QUOTE_LENGTH_MODES.includes(merged.quoteLengthMode)
    ? merged.quoteLengthMode
    : (QUOTE_LENGTH_MODES.includes(base?.quoteLengthMode)
      ? base.quoteLengthMode
      : FOLLOW_QUEUE_DEFAULT_SETTINGS.quoteLengthMode);
  Object.assign(next, normalizeQuoteTags(merged));
  validateQuoteTags(next);
  return next;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function profileProjection(input) {
  if (!input || typeof input !== 'object') return null;
  const source = input.profile && typeof input.profile === 'object' ? input.profile : input;
  const profile = {};
  for (const field of ['name', 'bio', 'avatarUrl', 'followersText', 'followingText']) {
    if (source[field] != null && String(source[field]).trim() !== '') profile[field] = String(source[field]);
  }
  const blue = source.blueVerified ?? source.is_blue_verified ?? source.isBlueVerified;
  if (typeof blue === 'boolean') profile.blueVerified = blue;
  if (typeof source.verified === 'boolean') profile.verified = source.verified;
  return Object.keys(profile).length ? profile : null;
}

function mergeStoredProfile(job, input) {
  const incoming = profileProjection(input);
  if (!job || !incoming) return;
  job.profile = {...(job.profile && typeof job.profile === 'object' ? job.profile : {}), ...incoming};
}

function blankJob({id, accountId, targetUserId, targetKey, handle, canonical, sources, now, profile}) {
  return {
    id,
    accountId,
    action: 'follow',
    targetUserId,
    targetKey,
    handle,
    handleCanonical: canonical,
    aliases: mergeAliases([], handle, canonical, now),
    sources,
    state: 'pending',
    stage: 'queued',
    createdAt: now,
    updatedAt: now,
    nextEligibleAt: now,
    lease: {owner: '', version: 0, expiresAt: 0},
    followResult: null,
    evaluations: [],
    profile: profileProjection(profile)
  };
}

function outcomeKey(accountId, targetKey) {
  return `${accountId}\0${targetKey}`;
}

async function rememberOutcome(outcomes, record) {
  if (!record?.targetKey || !DURABLE_STATES.includes(record.state)) return;
  const key = outcomeKey(record.accountId, record.targetKey);
  const existing = await requestResult(outcomes.get(key));
  if (existing && (IMPORT_RANK[existing.state] || 0) > (IMPORT_RANK[record.state] || 0)) return;
  const quoteDecision = hasQuoteDecision(record.quoteDecision)
    ? clone(record.quoteDecision)
    : (hasQuoteDecision(existing?.quoteDecision) ? clone(existing.quoteDecision) : undefined);
  outcomes.put({
    key,
    accountId: record.accountId,
    targetKey: record.targetKey,
    targetUserId: record.targetUserId || '',
    handleCanonical: record.handleCanonical || '',
    state: record.state,
    followResult: clone(record.followResult),
    evaluations: mergeEvaluations(existing?.evaluations, record.evaluations, record.id),
    ...(quoteDecision ? {quoteDecision} : {}),
    updatedAt: record.updatedAt
  });
}

function outcomeFromJob(job) {
  return {
    accountId: job.accountId,
    targetKey: job.targetKey,
    targetUserId: job.targetUserId,
    handleCanonical: job.handleCanonical,
    state: job.state,
    followResult: job.followResult,
    evaluations: job.evaluations,
    ...(hasQuoteDecision(job.quoteDecision) ? {quoteDecision: clone(job.quoteDecision)} : {}),
    updatedAt: job.updatedAt
  };
}

function aliasIndexKey(accountId, canonical) {
  return `${accountId}\0${canonical}`;
}

function postIndexKey(accountId, postId) {
  return `${accountId}\0${postId}`;
}

function projectJob(job) {
  if (!job || typeof job !== 'object' || !job.accountId) return job;
  job.priority = followQueuePriority(job);
  job.priorityDescending = -job.priority;
  if (!Number.isFinite(job.createdAt)) job.createdAt = 0;
  if (!Number.isFinite(job.nextEligibleAt)) job.nextEligibleAt = 0;
  if (typeof job.state !== 'string' || job.state === '') job.state = 'pending';
  const aliases = new Set();
  const addAlias = canonical => {
    if (canonical) aliases.add(aliasIndexKey(job.accountId, canonical));
  };
  addAlias(job.handleCanonical || '');
  if (typeof job.targetKey === 'string' && job.targetKey.startsWith('handle:')) addAlias(job.targetKey.slice('handle:'.length));
  for (const alias of Array.isArray(job.aliases) ? job.aliases : []) addAlias(alias?.canonical || '');
  job.aliasKeys = [...aliases];
  const posts = new Set();
  for (const evaluation of Array.isArray(job.evaluations) ? job.evaluations : []) {
    if (evaluation?.originalPostId) posts.add(postIndexKey(job.accountId, String(evaluation.originalPostId)));
  }
  job.evaluationPostKeys = [...posts];
  const modules = new Set((Array.isArray(job.sources) ? job.sources : []).map(source => source?.module).filter(Boolean));
  for (const [module, field] of Object.entries(SOURCE_FIELDS)) {
    if (modules.has(module)) job[field] = job.createdAt;
    else delete job[field];
  }
  return job;
}

function keyRange() {
  const range = globalThis.IDBKeyRange;
  if (!range) throw new Error('IDBKeyRange is required');
  return range;
}

function ensureIndex(store, name, keyPath, options) {
  const names = store.indexNames;
  if (names && typeof names.contains === 'function') {
    if (!names.contains(name)) store.createIndex(name, keyPath, options);
    return;
  }
  if (typeof store.createIndex === 'function') store.createIndex(name, keyPath, options);
}

function cursorWalk(source, range, visit) {
  return new Promise((resolve, reject) => {
    const request = source.openCursor(range);
    request.onerror = () => reject(request.error || new Error('follow queue cursor failed'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      Promise.resolve(visit(cursor)).then(action => {
        if (action === 'stop') resolve();
        else cursor.continue();
      }).catch(reject);
    };
  });
}

async function collectKeyed(source, range) {
  const rows = [];
  await cursorWalk(source, range, cursor => {
    rows.push(cursor.value);
  });
  return rows;
}

function accountCreatedRange(account) {
  const range = keyRange();
  return range.bound([account], [account, []], false, true);
}

function stateCreatedRange(account, state) {
  const range = keyRange();
  return range.bound([account, state], [account, state, []], false, true);
}

function dueRange(account, state, seenAt) {
  const range = keyRange();
  return range.bound(
    [account, state, Number.NEGATIVE_INFINITY],
    [account, state, seenAt, Number.POSITIVE_INFINITY, '\uffff'],
    false,
    false
  );
}

function matchesSource(job, source) {
  if (!source || source === 'all') return true;
  return Array.isArray(job?.sources) && job.sources.some(item => item && item.module === source);
}

function matchesSearch(job, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const profile = job?.profile && typeof job.profile === 'object' ? job.profile : {};
  const handleMatch = [job?.handle, profile.name, profile.bio].some(value => String(value || '').toLowerCase().includes(needle));
  const idMatch = job?.targetUserId && String(job.targetUserId).includes(needle);
  return handleMatch || idMatch;
}

function sortJobs(rows) {
  return rows.sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));
}

function encodeCursor(payload) {
  return JSON.stringify(payload);
}

function decodeCursor(raw) {
  if (raw == null || raw === '') return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { throw new Error('invalid follow queue cursor'); }
  }
  if (!parsed || parsed.v !== 1 || typeof parsed.id !== 'string' || !Number.isFinite(parsed.createdAt)) {
    throw new Error('invalid follow queue cursor');
  }
  return parsed;
}

function applyDurableState(job, outcome) {
  if (!outcome || !DURABLE_STATES.includes(outcome.state)) return false;
  if (job.state !== 'pending' && job.state !== 'retry') return false;
  job.state = outcome.state;
  job.stage = outcome.state === 'uncertain' ? 'verify' : outcome.state;
  job.followResult = clone(outcome.followResult);
  job.evaluations = mergeEvaluations(job.evaluations, outcome.evaluations, job.id);
  if (!hasQuoteDecision(job.quoteDecision) && hasQuoteDecision(outcome.quoteDecision)) {
    job.quoteDecision = clone(outcome.quoteDecision);
  }
  delete job.importedHold;
  return true;
}

function importedHoldActive(job) {
  return !!(job?.importedHold && DURABLE_STATES.includes(job.importedHold.state));
}

function succeededFollowResult(result) {
  return !!(result && typeof result === 'object' && (result.added === true || result.following === true || result.succeeded === true));
}

function writeImportedHold(job, state, followResult) {
  const current = IMPORT_RANK[job.importedHold?.state] || 0;
  const incoming = IMPORT_RANK[state] || 0;
  if (incoming < current) return false;
  // A confirmed follow stays ahead of a later skipped or uncertain import.
  if (incoming < IMPORT_RANK.followed && succeededFollowResult(job.importedHold?.followResult || job.followResult)) {
    return false;
  }
  job.importedHold = {
    state,
    followResult: followResult && typeof followResult === 'object' ? clone(followResult) : null
  };
  return true;
}

function releaseLease(job) {
  job.lease = {owner: '', version: job.lease?.version || 0, expiresAt: 0};
}

function applyImportedHold(job) {
  const hold = job.importedHold;
  if (!hold || !DURABLE_STATES.includes(hold.state)) return false;
  job.state = hold.state;
  job.stage = hold.state === 'uncertain' ? 'verify' : hold.state;
  job.followResult = clone(hold.followResult);
  delete job.importedHold;
  return true;
}

function realUserId(job) {
  return typeof job?.targetUserId === 'string' ? job.targetUserId : '';
}

function handleAliasMatch(job, canonical) {
  if (!canonical || !job) return false;
  if (job.handleCanonical === canonical || job.targetKey === `handle:${canonical}`) return true;
  return Array.isArray(job.aliases) && job.aliases.some(alias => alias && alias.canonical === canonical);
}

function leaseHeld(job) {
  return !!(job && job.state === 'running' && job.lease && job.lease.owner && job.lease.version > 0);
}

function sourceAuthorized(job) {
  return Array.isArray(job?.sources) && job.sources.some(source => source && source.enabled === true);
}

function absorbProvenance(target, extra, shown, canonical, seenAt, normalizedSources) {
  target.sources = mergeSources(mergeSources(target.sources, extra?.sources), normalizedSources);
  target.aliases = mergeAliases(target.aliases, extra?.handle, extra?.handleCanonical, seenAt);
  target.aliases = mergeAliases(target.aliases, shown, canonical, seenAt);
  target.evaluations = mergeEvaluations(target.evaluations, extra?.evaluations, target.id);
  if (!hasQuoteDecision(target.quoteDecision) && hasQuoteDecision(extra?.quoteDecision)) {
    target.quoteDecision = clone(extra.quoteDecision);
  }
  if (!target.followResult && extra?.followResult) target.followResult = clone(extra.followResult);
  if (shown) target.handle = shown;
  if (canonical && !target.handleCanonical) target.handleCanonical = canonical;
  target.updatedAt = seenAt;
}

function statesBlockCollapse(left, right) {
  if (!left || !right || left === right || left.id === right.id) return false;
  return leaseHeld(left) && leaseHeld(right);
}

function pickDurable(durable, account, job, canonical) {
  if (!job) return null;
  const rows = durable.filter(item => item.accountId === account && DURABLE_STATES.includes(item.state));
  const byKey = rows.find(item => item.targetKey === job.targetKey);
  if (byKey) return byKey;
  if (job.targetUserId) {
    return rows.find(item => item.targetUserId === job.targetUserId) || null;
  }
  if (!canonical) return null;
  const byHandle = rows.filter(item => item.handleCanonical === canonical);
  const ids = [...new Set(byHandle.map(item => item.targetUserId).filter(Boolean))];
  if (ids.length !== 1 && byHandle.some(item => item.targetUserId)) return null;
  return byHandle.length === 1 ? byHandle[0] : null;
}

function pickHeldState(left, right) {
  const leftImport = IMPORT_RANK[left] || 0;
  const rightImport = IMPORT_RANK[right] || 0;
  if (leftImport !== rightImport) return leftImport > rightImport ? left : right;
  return (STATE_RANK[left] || 0) >= (STATE_RANK[right] || 0) ? left : right;
}

export function createFollowQueueStore({indexedDB: indexedDBImpl, dbName = DEFAULT_DB_NAME, now = () => Date.now()} = {}) {
  const factory = indexedDBImpl || globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is required');
  let databasePromise;

  const open = () => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = factory.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const names = db.objectStoreNames;
        const has = name => !!(names && typeof names.contains === 'function' && names.contains(name));
        const jobs = has('jobs') ? request.transaction.objectStore('jobs') : db.createObjectStore('jobs', {keyPath: 'id'});
        const outcomes = has('outcomes') ? request.transaction.objectStore('outcomes') : db.createObjectStore('outcomes', {keyPath: 'key'});
        if (!has('settings')) db.createObjectStore('settings', {keyPath: 'accountId'});
        if (!has('meta')) db.createObjectStore('meta', {keyPath: 'key'});
        ensureIndex(jobs, 'accountId', 'accountId', {unique: false});
        ensureIndex(jobs, 'accountTarget', ['accountId', 'targetKey'], {unique: true});
        ensureIndex(jobs, 'byState', 'state', {unique: false});
        ensureIndex(jobs, 'accountPriorityAsc', ['accountId', 'priority', 'createdAt', 'id'], {unique: true});
        ensureIndex(jobs, 'accountPriorityDesc', ['accountId', 'priorityDescending', 'createdAt', 'id'], {unique: true});
        ensureIndex(jobs, 'accountStatePriorityAsc', ['accountId', 'state', 'priority', 'createdAt', 'id'], {unique: true});
        ensureIndex(jobs, 'accountStatePriorityDesc', ['accountId', 'state', 'priorityDescending', 'createdAt', 'id'], {unique: true});
        ensureIndex(jobs, 'accountCreated', ['accountId', 'createdAt', 'id'], {unique: true});
        ensureIndex(jobs, 'accountStateCreated', ['accountId', 'state', 'createdAt', 'id'], {unique: true});
        ensureIndex(jobs, 'accountStateDue', ['accountId', 'state', 'nextEligibleAt', 'createdAt', 'id'], {unique: true});
        ensureIndex(jobs, 'accountUser', ['accountId', 'targetUserId'], {unique: false});
        ensureIndex(jobs, 'accountHandle', ['accountId', 'handleCanonical'], {unique: false});
        ensureIndex(jobs, 'aliasKey', 'aliasKeys', {unique: false, multiEntry: true});
        ensureIndex(jobs, 'evaluationPostKey', 'evaluationPostKeys', {unique: false, multiEntry: true});
        ensureIndex(jobs, 'sourceFans', ['accountId', 'sourceFansAt', 'id'], {unique: true});
        ensureIndex(jobs, 'sourceMutual', ['accountId', 'sourceMutualAt', 'id'], {unique: true});
        ensureIndex(jobs, 'sourceComments', ['accountId', 'sourceCommentsAt', 'id'], {unique: true});
        ensureIndex(outcomes, 'accountTarget', ['accountId', 'targetKey'], {unique: false});
        ensureIndex(outcomes, 'accountUser', ['accountId', 'targetUserId'], {unique: false});
        ensureIndex(outcomes, 'accountHandle', ['accountId', 'handleCanonical'], {unique: false});
        if (typeof jobs.openCursor === 'function') {
          const backfill = jobs.openCursor();
          backfill.onsuccess = () => {
            const cursor = backfill.result;
            if (!cursor) return;
            projectJob(cursor.value);
            cursor.update(cursor.value);
            cursor.continue();
          };
        }
      };
      let abandoned = false;
      request.onblocked = () => {
        if (abandoned) return;
        abandoned = true;
        databasePromise = undefined;
        reject(new Error('follow queue database upgrade is blocked by another connection'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned) {
          try { db.close(); } catch { /* late success after the blocked open was abandoned */ }
          return;
        }
        db.onversionchange = () => {
          try { db.close(); } catch { /* already closing */ }
          databasePromise = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('failed to open follow queue'));
    }).catch(error => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  };

  async function withJobsTransaction(mode, work) {
    const db = await open();
    const tx = db.transaction(['jobs'], mode);
    const jobs = tx.objectStore('jobs');
    let settled = false;
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => { settled = true; resolve(); };
      tx.onabort = () => { settled = true; reject(tx.error || new Error('follow queue transaction aborted')); };
      tx.onerror = () => { settled = true; reject(tx.error || new Error('follow queue transaction failed')); };
    });
    const rawJobPut = jobs.put.bind(jobs);
    jobs.put = value => rawJobPut(projectJob(value));
    try {
      const value = await work({jobs});
      await done;
      return value;
    } catch (error) {
      if (!settled) {
        try { tx.abort(); } catch { /* already finished or aborted */ }
        await done.catch(() => {});
      }
      throw error;
    }
  }

  async function withTransaction(mode, work) {
    const db = await open();
    const tx = db.transaction(STORES, mode);
    const stores = {
      jobs: tx.objectStore('jobs'),
      outcomes: tx.objectStore('outcomes'),
      settings: tx.objectStore('settings'),
      meta: tx.objectStore('meta')
    };
    let settled = false;
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => { settled = true; resolve(); };
      tx.onabort = () => { settled = true; reject(tx.error || new Error('follow queue transaction aborted')); };
      tx.onerror = () => { settled = true; reject(tx.error || new Error('follow queue transaction failed')); };
    });
    const rawJobPut = stores.jobs.put.bind(stores.jobs);
    stores.jobs.put = value => rawJobPut(projectJob(value));
    try {
      const value = await work(stores);
      await done;
      return value;
    } catch (error) {
      if (!settled) {
        try { tx.abort(); } catch { /* already finished or aborted */ }
        await done.catch(() => {});
      }
      throw error;
    }
  }

  async function bumpRevision(meta) {
    const current = (await requestResult(meta.get('revision'))) || {key: 'revision', value: 0};
    const value = (Number(current.value) || 0) + 1;
    meta.put({key: 'revision', value});
    return value;
  }

  async function revisionOf(meta) {
    const current = await requestResult(meta.get('revision'));
    return Number(current?.value) || 0;
  }

  async function jobsForIdentity(jobs, account, userId, canonical) {
    const map = new Map();
    const add = async (indexName, range) => {
      const rows = await collectKeyed(jobs.index(indexName), range);
      for (const job of rows) {
        if (job && job.accountId === account && !job.redirectTo) map.set(job.id, job);
      }
    };
    const only = value => keyRange().only(value);
    if (userId) {
      await add('accountUser', only([account, userId]));
      await add('accountTarget', only([account, `id:${userId}`]));
    }
    if (canonical) {
      await add('accountHandle', only([account, canonical]));
      await add('accountTarget', only([account, `handle:${canonical}`]));
      await add('aliasKey', only(aliasIndexKey(account, canonical)));
    }
    return sortJobs([...map.values()]);
  }

  async function durableForJob(outcomes, account, job, canonical) {
    const only = value => keyRange().only(value);
    const byKey = await requestResult(outcomes.index('accountTarget').get([account, job.targetKey]));
    if (byKey && byKey.accountId === account && DURABLE_STATES.includes(byKey.state)) return byKey;
    if (job.targetUserId) {
      const rows = await collectKeyed(outcomes.index('accountUser'), only([account, job.targetUserId]));
      return rows.find(item => item.accountId === account && DURABLE_STATES.includes(item.state)) || null;
    }
    if (!canonical) return null;
    const byHandle = (await collectKeyed(outcomes.index('accountHandle'), only([account, canonical])))
      .filter(item => item.accountId === account && DURABLE_STATES.includes(item.state));
    const ids = [...new Set(byHandle.map(item => item.targetUserId).filter(Boolean))];
    if (ids.length !== 1 && byHandle.some(item => item.targetUserId)) return null;
    return byHandle.length === 1 ? byHandle[0] : null;
  }

  async function deleteDurableMatches(outcomes, account, job) {
    const keys = new Set();
    const take = async (indexName, query) => {
      await cursorWalk(outcomes.index(indexName), keyRange().only(query), cursor => {
        if (cursor.value?.key) keys.add(cursor.value.key);
      });
    };
    if (job.targetKey) await take('accountTarget', [account, job.targetKey]);
    if (job.targetUserId) await take('accountUser', [account, job.targetUserId]);
    if (job.handleCanonical) await take('accountHandle', [account, job.handleCanonical]);
    for (const key of keys) outcomes.delete(key);
  }

  function newId() {
    if (globalThis.crypto?.randomUUID) return `fq_${crypto.randomUUID()}`;
    return `fq_${now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  }

  return {
    async enqueue({accountId, targetUserId, handle, sources, initialState, followResult, profile, followBackCandidate} = {}) {
      const account = requireAccountId(accountId);
      const userId = userIdString(targetUserId);
      const canonical = canonicalHandle(handle);
      if (!userId && !canonical) throw new Error('target user id or handle is required');
      const seenAt = now();
      const normalizedSources = (Array.isArray(sources) ? sources : []).map(source => normalizeSource(source, seenAt));
      const shown = displayHandle(handle, canonical);

      return withTransaction('readwrite', async ({jobs, outcomes, meta}) => {
        const targetKey = userId ? `id:${userId}` : `handle:${canonical}`;
        const deletedById = userId && await requestResult(meta.get(`deleted:${account}:id:${userId}`));
        const deletedByHandle = canonical && await requestResult(meta.get(`deleted:${account}:handle:${canonical}`));
        if (deletedById || (deletedByHandle && (!userId || !deletedByHandle.targetUserId || deletedByHandle.targetUserId === userId))) {
          return {deleted:true, state:'excluded', accountId:account, targetUserId:userId, handle:shown, reason:'该账号已从队列删除'};
        }
        const accountJobs = await jobsForIdentity(jobs, account, userId, canonical);
        let primary = null;
        let provisional = null;

        if (userId) {
          primary = accountJobs.find(job => job.targetUserId === userId || job.targetKey === `id:${userId}`) || null;
          if (canonical) {
            provisional = accountJobs.find(job => job !== primary && !realUserId(job) && (job.targetKey === `handle:${canonical}` || job.handleCanonical === canonical)) || null;
          }
        } else {
          const hits = accountJobs.filter(job => handleAliasMatch(job, canonical));
          const distinctIds = [...new Set(hits.map(realUserId).filter(Boolean))];
          if (distinctIds.length >= 2) {
            primary = hits.find(job => !realUserId(job)) || null;
          } else if (distinctIds.length === 1) {
            primary = hits.find(job => job.targetUserId === distinctIds[0]) || hits[0];
            provisional = hits.find(job => job !== primary && !realUserId(job)) || null;
          } else {
            primary = hits[0] || null;
          }
        }

        if (primary && provisional && primary.id !== provisional.id && statesBlockCollapse(primary, provisional)) {
          const primaryLease = clone(primary.lease);
          const provisionalLease = clone(provisional.lease);
          const primaryState = primary.state;
          const provisionalState = provisional.state;
          absorbProvenance(primary, provisional, shown, canonical, seenAt, normalizedSources);
          absorbProvenance(provisional, primary, shown, canonical, seenAt, []);
          primary.lease = primaryLease;
          provisional.lease = provisionalLease;
          primary.state = primaryState;
          provisional.state = provisionalState;
          mergeStoredProfile(primary, {profile});
          mergeStoredProfile(provisional, {profile});
          jobs.put(primary);
          jobs.put(provisional);
          return cloneJob(leaseHeld(provisional) ? provisional : primary);
        }

        if (primary && provisional && primary.id !== provisional.id) {
          const survivor = leaseHeld(provisional) && !leaseHeld(primary) ? provisional : primary;
          const other = survivor === primary ? provisional : primary;
          const lease = clone(survivor.lease);
          const state = survivor.state;
          absorbProvenance(survivor, other, shown, canonical, seenAt, normalizedSources);
          survivor.lease = lease;
          survivor.state = state === 'running' ? 'running' : pickHeldState(state, other.state);
          if (leaseHeld(survivor) && DURABLE_STATES.includes(other.state)) {
            writeImportedHold(survivor, other.state, other.followResult);
            survivor.evaluations = mergeEvaluations(survivor.evaluations, other.evaluations, survivor.id);
            const promotedId = userId || realUserId(other) || realUserId(survivor);
            if (promotedId) {
              survivor.targetUserId = promotedId;
              survivor.targetKey = `id:${survivor.targetUserId}`;
            }
          } else if (!realUserId(survivor) && (userId || realUserId(other))) {
            survivor.targetUserId = userId || realUserId(other);
            survivor.targetKey = `id:${survivor.targetUserId}`;
          }
          jobs.delete(other.id);
          primary = survivor;
        } else if (!primary && provisional) {
          primary = provisional;
          if (userId && !realUserId(primary)) {
            primary.targetUserId = userId;
            primary.targetKey = `id:${userId}`;
          }
        }

        if (!primary) {
          primary = blankJob({
            id: newId(),
            accountId: account,
            targetUserId: userId,
            targetKey,
            handle: shown,
            canonical,
            sources: normalizedSources,
            now: seenAt,
            profile
          });
        } else {
          const lease = clone(primary.lease);
          const state = primary.state;
          primary.sources = mergeSources(primary.sources, normalizedSources);
          primary.aliases = mergeAliases(primary.aliases, shown, canonical, seenAt);
          if (shown) primary.handle = shown;
          if (canonical) primary.handleCanonical = canonical;
          if (userId && (!realUserId(primary) || realUserId(primary) === userId)) primary.targetUserId = userId;
          primary.updatedAt = seenAt;
          if (leaseHeld(primary)) primary.lease = lease;
          if (state === 'running') primary.state = 'running';
          mergeStoredProfile(primary, {profile});
        }

        if (typeof followBackCandidate === 'boolean') primary.followBackCandidate = followBackCandidate;
        const durableHit = await durableForJob(outcomes, account, primary, canonical);
        if (durableHit && (primary.state === 'pending' || primary.state === 'retry')) {
          applyDurableState(primary, durableHit);
        } else if (durableHit && leaseHeld(primary)) {
          // The in-flight follow keeps its lease until expiration. The stored outcome
          // waits on importedHold so renew cannot extend work the outcome already closed.
          writeImportedHold(primary, durableHit.state, durableHit.followResult);
          primary.evaluations = mergeEvaluations(primary.evaluations, durableHit.evaluations, primary.id);
          if (!hasQuoteDecision(primary.quoteDecision) && hasQuoteDecision(durableHit.quoteDecision)) {
            primary.quoteDecision = clone(durableHit.quoteDecision);
          }
        }
        if (DURABLE_STATES.includes(initialState) && leaseHeld(primary)) {
          if (writeImportedHold(primary, initialState, followResult)) {
            rememberOutcome(outcomes, {
              accountId: primary.accountId,
              targetKey: primary.targetKey,
              targetUserId: primary.targetUserId,
              handleCanonical: primary.handleCanonical,
              state: primary.importedHold.state,
              followResult: primary.importedHold.followResult,
              evaluations: primary.evaluations,
              updatedAt: seenAt
            });
          }
        } else if (DURABLE_STATES.includes(initialState) && !leaseHeld(primary)) {
          const currentRank = IMPORT_RANK[primary.state] || 0;
          const incoming = IMPORT_RANK[initialState] || 0;
          const keepSucceeded = succeededFollowResult(primary.followResult) && incoming < IMPORT_RANK.followed;
          if (incoming >= currentRank && !keepSucceeded) {
            primary.state = initialState;
            primary.stage = initialState === 'uncertain' ? 'verify' : initialState;
            if (followResult && typeof followResult === 'object') primary.followResult = clone(followResult);
            delete primary.importedHold;
          }
        }
        jobs.put(primary);
        if (DURABLE_STATES.includes(primary.state)) rememberOutcome(outcomes, primary);
        await bumpRevision(meta);
        return cloneJob(primary);
      });
    },

    async get(id) {
      if (typeof id !== 'string' || id === '') throw new Error('job id is required');
      return withTransaction('readonly', async ({jobs}) => cloneJob(await requestResult(jobs.get(id))) || null);
    },

    async lookup({accountId, handle, targetUserId, id} = {}) {
      if (id) return this.get(id);
      const account = requireAccountId(accountId);
      const userId = targetUserId ? userIdString(targetUserId) : '';
      const canonical = handle == null || handle === '' ? '' : canonicalHandle(handle);
      if (!userId && !canonical) return null;
      return withTransaction('readonly', async ({jobs}) => {
        const rows = userId
          ? await collectKeyed(jobs.index('accountUser'), keyRange().only([account, userId]))
          : await collectKeyed(jobs.index('accountHandle'), keyRange().only([account, canonical]));
        const visible = rows.filter(job => job.accountId === account && !job.redirectTo);
        return cloneJob(sortJobs(visible).at(-1) || null);
      });
    },

    async listByTarget({accountId, targetUserId} = {}) {
      const account = requireAccountId(accountId);
      const userId = userIdString(targetUserId);
      return withTransaction('readonly', async ({jobs}) => {
        const rows = await collectKeyed(jobs.index('accountUser'), keyRange().only([account, userId]));
        return sortJobs(rows.filter(job => job.accountId === account)).map(job => cloneJob(job));
      });
    },

    async listByState({accountId, state} = {}) {
      const account = requireAccountId(accountId);
      if (!JOB_STATES.includes(state)) throw new Error('invalid follow queue state');
      return withTransaction('readonly', async ({jobs}) => {
        const rows = await collectKeyed(jobs.index('accountStateCreated'), stateCreatedRange(account, state));
        return rows.filter(job => job.accountId === account && job.state === state).map(job => cloneJob(job));
      });
    },

    async hasPostEvaluation({accountId, postId} = {}) {
      const account = requireAccountId(accountId);
      if (postId == null || postId === '') return false;
      return withTransaction('readonly', async ({jobs}) => {
        const rows = await collectKeyed(jobs.index('evaluationPostKey'), keyRange().only(postIndexKey(account, String(postId))));
        return rows.some(job => job.accountId === account);
      });
    },

    async countStates({accountId} = {}) {
      const account = requireAccountId(accountId);
      return withTransaction('readonly', async ({jobs}) => {
        const stats = {total: 0, pending: 0, running: 0, followed: 0, skipped: 0, retry: 0, uncertain: 0, excluded: 0};
        for (const state of JOB_STATES) {
          const count = await requestResult(jobs.index('accountStateCreated').count(stateCreatedRange(account, state)));
          stats[state] = count;
          stats.total += count;
        }
        return stats;
      });
    },

    async queryPage({accountId, state = 'all', source = 'all', q = '', order = null, cursor = null, page = 1, limit = 20, signal = null} = {}) {
      const account = requireAccountId(accountId);
      const status = state == null || state === '' ? 'all' : String(state);
      const moduleName = source == null || source === '' ? 'all' : String(source);
      const query = String(q || '');
      const searching = query.trim() !== '';
      if (status !== 'all' && !JOB_STATES.includes(status)) throw new Error('invalid follow queue state');
      if (!['all', 'fans', 'mutual', 'comments'].includes(moduleName)) throw new Error('invalid follow queue source');
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new Error(`limit must be an integer from 1 to ${PAGE_MAX}`);
      if (page != null && page !== 1) throw new Error('follow queue pages use a cursor');
      if (order != null && !['asc', 'desc'].includes(order)) throw new Error('invalid follow queue order');
      const parsed = decodeCursor(cursor);
      return withTransaction('readonly', async ({jobs, meta}) => {
        const revision = await revisionOf(meta);
        if (parsed) {
          if (parsed.accountId !== account || parsed.state !== status || parsed.source !== moduleName || parsed.q !== query || parsed.revision !== revision || (parsed.order || null) !== order || (order && !Number.isFinite(parsed.priorityKey))) {
            throw new Error('invalid follow queue cursor');
          }
        }
        const sourceOnly = moduleName !== 'all';
        const priorityState = Boolean(order && status !== 'all');
        const indexName = priorityState ? (order === 'asc' ? 'accountStatePriorityAsc' : 'accountStatePriorityDesc')
          : order ? (order === 'asc' ? 'accountPriorityAsc' : 'accountPriorityDesc') : sourceOnly
          ? SOURCE_INDEXES[moduleName]
          : (status === 'all' ? 'accountCreated' : 'accountStateCreated');
        const indexed = jobs.index(indexName);
        const baseRange = priorityState ? keyRange().bound([account, status], [account, status, []], false, true)
          : order ? accountCreatedRange(account) : sourceOnly
          ? accountCreatedRange(account)
          : (status === 'all' ? accountCreatedRange(account) : stateCreatedRange(account, status));
        let range = baseRange;
        if (parsed) {
          const lower = priorityState ? [account, status, parsed.priorityKey, parsed.createdAt, parsed.id]
            : order ? [account, parsed.priorityKey, parsed.createdAt, parsed.id] : sourceOnly || status === 'all'
            ? [account, parsed.createdAt, parsed.id]
            : [account, status, parsed.createdAt, parsed.id];
          const upper = priorityState ? [account, status, []]
            : order || sourceOnly || status === 'all' ? [account, []] : [account, status, []];
          range = keyRange().bound(lower, upper, true, true);
        }
        const bounded = searching || (sourceOnly && status !== 'all') || Boolean(order && (sourceOnly || status !== 'all'));
        const countable = !searching && !(sourceOnly && status !== 'all');
        const countIndex = jobs.index(sourceOnly ? SOURCE_INDEXES[moduleName] : status === 'all' ? 'accountCreated' : 'accountStateCreated');
        const countRange = !sourceOnly && status !== 'all' ? stateCreatedRange(account, status) : accountCreatedRange(account);
        const total = countable ? await requestResult(countIndex.count(countRange)) : null;
        const rows = [];
        let examined = 0;
        let lastSeen = null;
        let hitBatch = false;
        if (signal?.aborted) throw new Error('follow queue query cancelled');
        await cursorWalk(indexed, range, cursorRow => {
          if (signal?.aborted) throw new Error('follow queue query cancelled');
          const job = cursorRow.value;
          if (job.accountId !== account || job.redirectTo) return;
          lastSeen = job;
          examined += 1;
          const stateOk = status === 'all' || job.state === status;
          const sourceOk = !sourceOnly || matchesSource(job, moduleName);
          if (stateOk && sourceOk && matchesSearch(job, query) && rows.length <= limit) rows.push(job);
          if (rows.length > limit) return 'stop';
          if (bounded && examined >= SEARCH_BATCH) {
            hitBatch = true;
            return 'stop';
          }
        });
        const pageRows = rows.slice(0, limit).map(job => cloneJob(job));
        const hasMore = rows.length > limit || (hitBatch && lastSeen != null);
        const anchor = hitBatch && rows.length <= limit ? lastSeen : pageRows[pageRows.length - 1];
        const nextCursor = hasMore && anchor ? encodeCursor({
          v: 1,
          accountId: account,
          state: status,
          source: moduleName,
          q: query,
          order,
          priorityKey: order === 'asc' ? anchor.priority : anchor.priorityDescending,
          revision,
          createdAt: anchor.createdAt,
          id: anchor.id
        }) : null;
        const stats = {total: 0, pending: 0, running: 0, followed: 0, skipped: 0, retry: 0, uncertain: 0, excluded: 0};
        for (const name of JOB_STATES) {
          stats[name] = await requestResult(jobs.index('accountStateCreated').count(stateCreatedRange(account, name)));
          stats.total += stats[name];
        }
        return {
          jobs: pageRows,
          nextCursor,
          hasMore: Boolean(nextCursor),
          total,
          totalKnown: total != null,
          scanned: examined,
          scanBatch: SEARCH_BATCH,
          scanLimited: hitBatch,
          scanExhausted: !hitBatch && rows.length <= limit,
          stats,
          revision
        };
      });
    },

    async backfillProfiles({accountId, profiles, cursor = null, limit = 50} = {}) {
      const account = requireAccountId(accountId);
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new Error(`limit must be an integer from 1 to ${PAGE_MAX}`);
      const parsed = cursor == null || cursor === '' ? null : decodeCursor(cursor);
      const byHandle = new Map();
      const incoming = profiles instanceof Map ? [...profiles.values()] : (Array.isArray(profiles) ? profiles : []);
      for (const profile of incoming) {
        const canonical = canonicalHandle(profile?.handle || profile?.handleCanonical || '');
        if (canonical) byHandle.set(canonical, profile);
      }
      return withTransaction('readwrite', async ({jobs, meta}) => {
        const revision = await revisionOf(meta);
        if (parsed && (parsed.accountId !== account || parsed.revision !== revision || parsed.kind !== 'profile-backfill')) {
          throw new Error('invalid follow queue cursor');
        }
        const range = parsed
          ? keyRange().bound([account, parsed.createdAt, parsed.id], [account, []], true, true)
          : accountCreatedRange(account);
        const rows = [];
        let updated = 0;
        await cursorWalk(jobs.index('accountCreated'), range, cursorRow => {
          const job = cursorRow.value;
          if (job.accountId !== account) return;
          rows.push(job);
          if (rows.length > limit) return 'stop';
        });
        const page = rows.slice(0, limit);
        for (const job of page) {
          const canonical = job.handleCanonical || canonicalHandle(job.handle);
          const profile = byHandle.get(canonical);
          if (!profile) continue;
          const before = JSON.stringify(job.profile || null);
          mergeStoredProfile(job, {profile});
          if (JSON.stringify(job.profile || null) === before) continue;
          job.updatedAt = now();
          jobs.put(job);
          updated += 1;
        }
        if (updated) await bumpRevision(meta);
        const nextRevision = updated ? revision + 1 : revision;
        const more = rows.length > limit;
        const last = page[page.length - 1];
        const nextCursor = more && last ? encodeCursor({
          v: 1,
          kind: 'profile-backfill',
          accountId: account,
          revision: nextRevision,
          createdAt: last.createdAt,
          id: last.id
        }) : null;
        return {updated, scanned: page.length, nextCursor, done: !more};
      });
    },

    async list({accountId} = {}) {
      const account = requireAccountId(accountId);
      return withTransaction('readonly', async ({jobs}) => {
        const rows = await collectKeyed(jobs.index('accountCreated'), accountCreatedRange(account));
        return sortJobs(rows.filter(job => job.accountId === account)).map(job => cloneJob(job));
      });
    },

    async claim({accountId, owner, leaseMs, excludeIds = []} = {}) {
      const account = requireAccountId(accountId);
      if (typeof owner !== 'string' || owner === '') throw new Error('lease owner is required');
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive number');
      const seenAt = now();
      return withTransaction('readwrite', async ({jobs, outcomes, meta}) => {
        let active = false;
        let changed = false;
        await cursorWalk(jobs.index('byState'), keyRange().only('running'), cursor => {
          const job = cursor.value;
          if (job.state !== 'running') return;
          if (job.lease?.expiresAt > seenAt) {
            active = true;
            return;
          }
          if (!applyImportedHold(job)) {
            const result = job.followResult || {};
            const safeBeforeAction = ['queued','claimed','pending','retry'].includes(job.stage)
              && !result.attemptedAt && !result.followerRemoval?.attemptedAt && !succeededFollowResult(result)
              && !(job.evaluations || []).some(ev => ev.generationAttemptedAt || ev.publishedPostId || ev.publishedPostUrl || ['generating','publishing','published','posted','uncertain'].includes(ev.status));
            job.state = safeBeforeAction ? 'retry' : 'uncertain';
            job.stage = safeBeforeAction ? 'queued' : 'verify';
            if (safeBeforeAction) {
              job.nextEligibleAt = seenAt;
              job.followResult = {...result, reason:'执行中断，尚未发送关注操作，自动恢复执行'};
            }
          }
          job.updatedAt = seenAt;
          releaseLease(job);
          jobs.put(job);
          rememberOutcome(outcomes, job);
          changed = true;
        });
        if (active) {
          if (changed) await bumpRevision(meta);
          return null;
        }
        // Enablement and migration pause are not enforced in this store.
        // follow-queue-runtime does not yet reject claims while a migration is in progress.
        let job = null;
        // Read the best ready candidate in each executable state, then compare them.
        // Followers who already follow us retain priority 100; other profiles use
        // the locally observed follower-count bands from follow-queue-priority.js.
        for (const state of ['pending', 'retry']) {
          await cursorWalk(jobs.index('accountStatePriorityDesc'), keyRange().bound(
            [account, state], [account, state, []], false, true
          ), cursor => {
            const candidate = cursor.value;
            if (candidate.accountId !== account || candidate.redirectTo || excludeIds.includes(candidate.id)) return;
            if (candidate.state !== state || !sourceAuthorized(candidate)) return;
            if (candidate.nextEligibleAt > seenAt) return;
            if (!job || compareFollowQueuePriority(candidate, job) < 0) job = candidate;
            return 'stop';
          });
        }
        if (!job) {
          if (changed) await bumpRevision(meta);
          return null;
        }
        job.priority = followQueuePriority(job);
        job.priorityDescending = -job.priority;
        job.state = 'running';
        job.stage = job.stage === 'queued' ? 'claimed' : job.stage;
        job.updatedAt = seenAt;
        job.lease = {
          owner,
          version: (job.lease?.version || 0) + 1,
          expiresAt: seenAt + leaseMs
        };
        jobs.put(job);
        await bumpRevision(meta);
        return cloneJob(job);
      });
    },

    async settle({id, owner, version, state, patch} = {}) {
      if (typeof id !== 'string' || id === '') throw new Error('job id is required');
      if (!Object.prototype.hasOwnProperty.call(STATE_RANK, state)) throw new Error('invalid follow queue state');
      const seenAt = now();
      return withTransaction('readwrite', async ({jobs, outcomes, meta}) => {
        const job = await requestResult(jobs.get(id));
        if (!job) return {ok: false, reason: 'missing'};
        const lease = job.lease || {owner: '', version: 0, expiresAt: 0};
        if (lease.owner !== owner || lease.version !== version) {
          return {ok: false, reason: 'stale'};
        }
        if (!(lease.expiresAt > seenAt)) {
          return {ok: false, reason: 'expired'};
        }
        if (job.state !== 'running') {
          return {ok: false, reason: 'stale'};
        }
        const changes = patch && typeof patch === 'object' ? patch : {};
        if (importedHoldActive(job)) {
          if (state === 'running') return {ok: false, reason: 'imported-hold'};
          if (state === 'followed' || succeededFollowResult(changes.followResult)) {
            delete job.importedHold;
            if (typeof changes.stage === 'string') job.stage = changes.stage;
            if (Number.isFinite(changes.nextEligibleAt)) job.nextEligibleAt = changes.nextEligibleAt;
            if (changes.followResult && typeof changes.followResult === 'object') {
              job.followResult = clone(changes.followResult);
            }
            if (Array.isArray(changes.evaluations)) {
              job.evaluations = mergeEvaluations(job.evaluations, changes.evaluations, job.id);
            }
            if (!hasQuoteDecision(job.quoteDecision) && hasQuoteDecision(changes.quoteDecision)) {
              job.quoteDecision = clone(changes.quoteDecision);
            }
            job.state = 'followed';
            job.updatedAt = seenAt;
            releaseLease(job);
            jobs.put(job);
            rememberOutcome(outcomes, job);
            await bumpRevision(meta);
            return {ok: true, job: cloneJob(job)};
          }
          applyImportedHold(job);
          if (Array.isArray(changes.evaluations)) {
            job.evaluations = mergeEvaluations(job.evaluations, changes.evaluations, job.id);
          }
          if (!hasQuoteDecision(job.quoteDecision) && hasQuoteDecision(changes.quoteDecision)) {
            job.quoteDecision = clone(changes.quoteDecision);
          }
          releaseLease(job);
          job.updatedAt = seenAt;
          jobs.put(job);
          rememberOutcome(outcomes, job);
          await bumpRevision(meta);
          return {ok: false, reason: 'imported-hold', job: cloneJob(job)};
        }
        if (typeof changes.stage === 'string') job.stage = changes.stage;
        if(changes.lastDiagnostic===null)delete job.lastDiagnostic;
        if(changes.lastDiagnostic&&typeof changes.lastDiagnostic==='object')job.lastDiagnostic=clone(changes.lastDiagnostic);
        if (Number.isFinite(changes.nextEligibleAt)) job.nextEligibleAt = changes.nextEligibleAt;
        if (changes.followResult && typeof changes.followResult === 'object') {
          job.followResult = clone(changes.followResult);
        }
        if (Array.isArray(changes.evaluations)) {
          job.evaluations = mergeEvaluations(job.evaluations, changes.evaluations, job.id);
        }
        if (!hasQuoteDecision(job.quoteDecision) && hasQuoteDecision(changes.quoteDecision)) {
          job.quoteDecision = clone(changes.quoteDecision);
        }
        job.state = state;
        job.updatedAt = seenAt;
        if (state !== 'running') {
          job.lease = {owner: '', version: lease.version, expiresAt: 0};
        }
        if (changes.profile && typeof changes.profile === 'object') job.profile = clone(changes.profile);
        jobs.put(job);
        rememberOutcome(outcomes, job);
        await bumpRevision(meta);
        return {ok: true, job: cloneJob(job)};
      });
    },

    async markDeletedHandle({accountId,handle}={}) {
      const account=requireAccountId(accountId),key=canonicalHandle(handle);
      if(!/^[a-z0-9_]{1,15}$/.test(key))throw new Error('账号格式无效');
      return withTransaction('readwrite',async({meta})=>{
        meta.put({key:`deleted:${account}:handle:${key}`,accountId:account,targetUserId:'',deletedAt:now()});
        await bumpRevision(meta);return {ok:true};
      });
    },
    async deleteJob({accountId, id} = {}) {
      const account = requireAccountId(accountId);
      if (typeof id !== 'string' || !id) throw new Error('job id is required');
      return withTransaction('readwrite', async ({jobs, outcomes, meta}) => {
        const job = await requestResult(jobs.get(id));
        if (!job || job.accountId !== account) return {ok:false, reason:'未找到该账号的队列任务'};
        const matches = (await jobsForIdentity(jobs, account, job.targetUserId, job.handleCanonical))
          .filter(other => other.id === job.id || (job.targetUserId && other.targetUserId === job.targetUserId) || (!other.targetUserId && other.handleCanonical === job.handleCanonical));
        if (matches.some(other => other.state === 'running' || (leaseHeld(other) && other.lease.expiresAt > now()))) {
          return {ok:false, reason:'任务正在执行，请结束后再删除'};
        }
        for (const row of matches) {
          const stamp = {accountId:account, targetUserId:row.targetUserId || job.targetUserId || '', deletedAt:now()};
          if (row.targetUserId) meta.put({...stamp, key:`deleted:${account}:id:${row.targetUserId}`});
          for (const handle of new Set([row.handleCanonical, ...(row.aliases || []).map(alias=>canonicalHandle(alias.handle))].filter(Boolean))) {
            meta.put({...stamp, key:`deleted:${account}:handle:${handle}`});
          }
          outcomes.delete(outcomeKey(account, row.targetKey));
          jobs.delete(row.id);
        }
        await bumpRevision(meta);
        return {ok:true, deleted:matches.length, handle:job.handle};
      });
    },

    async resolveJob({accountId, id, state, stage, followResult, nextEligibleAt, evaluations, quoteDecision} = {}) {
      const account = requireAccountId(accountId);
      if (typeof id !== 'string' || id === '') throw new Error('job id is required');
      if (state != null && (!Object.prototype.hasOwnProperty.call(STATE_RANK, state) || state === 'running')) {
        throw new Error('invalid follow queue state');
      }
      const seenAt = now();
      return withTransaction('readwrite', async ({jobs, outcomes, meta}) => {
        const job = await requestResult(jobs.get(id));
        if (!job || job.accountId !== account) return {ok: false, reason: 'missing'};
        if (leaseHeld(job) && job.lease.expiresAt > seenAt) return {ok: false, reason: 'leased'};
        if (state != null) job.state = state;
        if (typeof stage === 'string') job.stage = stage;
        if (followResult && typeof followResult === 'object') job.followResult = clone(followResult);
        if (Number.isFinite(nextEligibleAt)) job.nextEligibleAt = nextEligibleAt;
        if (Array.isArray(evaluations)) {
          job.evaluations = mergeEvaluations(job.evaluations, evaluations, job.id);
        }
        if (!hasQuoteDecision(job.quoteDecision) && hasQuoteDecision(quoteDecision)) {
          job.quoteDecision = clone(quoteDecision);
        }
        delete job.importedHold;
        releaseLease(job);
        job.updatedAt = seenAt;
        if (job.state === 'pending' || job.state === 'retry') {
          await deleteDurableMatches(outcomes, account, job);
        } else if (DURABLE_STATES.includes(job.state)) {
          await rememberOutcome(outcomes, job);
          outcomes.put({
            key: outcomeKey(job.accountId, job.targetKey),
            accountId: job.accountId,
            targetKey: job.targetKey,
            targetUserId: job.targetUserId || '',
            handleCanonical: job.handleCanonical || '',
            state: job.state,
            followResult: clone(job.followResult),
            evaluations: clone(job.evaluations || []),
            ...(hasQuoteDecision(job.quoteDecision) ? {quoteDecision: clone(job.quoteDecision)} : {}),
            updatedAt: job.updatedAt
          });
        }
        jobs.put(job);
        await bumpRevision(meta);
        return {ok: true, job: cloneJob(job)};
      });
    },

    async ensureQuoteDecision({accountId, id, rate, random} = {}) {
      const account = requireAccountId(accountId);
      if (typeof id !== 'string' || id.trim() === '') throw new Error('job id is required');
      if (!isValidQuoteRate(rate)) {
        throw new Error('引用概率请输入 0—100 的整数');
      }
      if (random !== undefined && typeof random !== 'function') {
        throw new Error('random must be a function');
      }
      const sampleFn = random || defaultQuoteRandom;
      const seenAt = now();
      return withJobsTransaction('readwrite', async ({jobs}) => {
        const job = await requestResult(jobs.get(id));
        if (!job || job.accountId !== account) return {ok: false, reason: 'missing'};
        if (hasQuoteDecision(job.quoteDecision)) {
          return {ok: true, decision: clone(job.quoteDecision), job: cloneJob(job)};
        }
        const roll = Number(sampleFn());
        if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
          throw new Error('random roll must be a finite number in [0, 1)');
        }
        const decision = {
          version: 1,
          rate,
          roll,
          selected: roll < (rate / 100),
          decidedAt: seenAt
        };
        job.quoteDecision = decision;
        job.updatedAt = seenAt;
        jobs.put(job);
        return {ok: true, decision: clone(decision), job: cloneJob(job)};
      });
    },

    async importOutcome({accountId, targetUserId, handle, sources, state, followResult, profile} = {}) {
      if (!DURABLE_STATES.includes(state)) {
        throw new Error('importOutcome state must be followed, skipped, excluded, or uncertain');
      }
      return this.enqueue({accountId, targetUserId, handle, sources, initialState: state, followResult, profile});
    },

    async renew({id, owner, version, leaseMs} = {}) {
      if (typeof id !== 'string' || id === '') throw new Error('job id is required');
      if (typeof owner !== 'string' || owner === '') throw new Error('lease owner is required');
      if (!Number.isFinite(version)) throw new Error('lease version is required');
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive number');
      const seenAt = now();
      return withTransaction('readwrite', async ({jobs, meta}) => {
        const job = await requestResult(jobs.get(id));
        if (!job) return {ok: false, reason: 'missing'};
        if (importedHoldActive(job)) return {ok: false, reason: 'imported-hold'};
        const lease = job.lease || {owner: '', version: 0, expiresAt: 0};
        if (job.state !== 'running' || lease.owner !== owner || lease.version !== version) {
          return {ok: false, reason: 'stale'};
        }
        if (!(lease.expiresAt > seenAt)) return {ok: false, reason: 'expired'};
        job.lease = {owner, version: lease.version + 1, expiresAt: seenAt + leaseMs};
        job.updatedAt = seenAt;
        jobs.put(job);
        await bumpRevision(meta);
        return {ok: true, job: cloneJob(job)};
      });
    },

    async updateSources({accountId, modules} = {}) {
      const account = requireAccountId(accountId);
      const flags = {};
      for (const key of ['fans', 'mutual', 'comments']) {
        if (modules && typeof modules[key] === 'boolean') flags[key] = modules[key];
      }
      return withTransaction('readwrite', async ({jobs, meta}) => {
        const touched = [];
        await cursorWalk(jobs.index('accountCreated'), accountCreatedRange(account), cursor => {
          const job = cursor.value;
          if (job.accountId !== account || !Array.isArray(job.sources)) return;
          let changed = false;
          for (const source of job.sources) {
            if (!Object.prototype.hasOwnProperty.call(flags, source.module)) continue;
            if (source.enabled !== flags[source.module]) {
              source.enabled = flags[source.module];
              changed = true;
            }
          }
          if (!changed) return;
          job.updatedAt = now();
          jobs.put(job);
          touched.push(clone(job));
        });
        if (touched.length) await bumpRevision(meta);
        return touched;
      });
    },

    async getSettings(accountId) {
      const account = requireAccountId(accountId);
      return withTransaction('readonly', async ({settings}) => {
        const stored = await requestResult(settings.get(account));
        return normalizeSettings(stored, FOLLOW_QUEUE_DEFAULT_SETTINGS);
      });
    },

    async saveSettings(accountId, settings) {
      const account = requireAccountId(accountId);
      validateExplicitQuoteSettings(settings);
      return withTransaction('readwrite', async ({settings: store, meta}) => {
        const stored = await requestResult(store.get(account));
        const next = normalizeSettings(settings, normalizeSettings(stored, FOLLOW_QUEUE_DEFAULT_SETTINGS));
        store.put({...next, accountId: account});
        await bumpRevision(meta);
        return next;
      });
    }
  };
}
