import {QUOTE_TAG_DEFAULTS, normalizeQuoteTags, validateQuoteTags} from './quote-tags.js';
// Extension-origin follow queue. Open this database from the extension, never from an x.com tab.
// Durable outcomes live in their own store so UI log truncation cannot drop dedupe evidence.

const DB_VERSION = 1;
const DEFAULT_DB_NAME = 'x-each-follower-follow-queue';
const STORES = ['jobs', 'outcomes', 'settings'];

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
  grokEnabled: false,
  autoPublish: false
});

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
    else if (Array.isArray(item.attempts)) attempts = item.attempts.map(attempt => clone(attempt));
    else if (typeof prev.attempts === 'number' && prev.attempts > 0) attempts = prev.attempts;
    else if (Array.isArray(prev.attempts)) attempts = prev.attempts;
    else attempts = [];
    map.set(item.taskId, {
      taskId: String(item.taskId),
      followJobId: item.followJobId || prev.followJobId || followJobId,
      targetUserId: item.targetUserId || prev.targetUserId || '',
      originalAuthorId: item.originalAuthorId || prev.originalAuthorId || '',
      originalPostId: item.originalPostId || prev.originalPostId || '',
      originalPostUrl: item.originalPostUrl || prev.originalPostUrl || '',
      language: item.language != null ? String(item.language) : (prev.language || ''),
      baseText: item.baseText != null ? String(item.baseText) : (prev.baseText || ''),
      text: item.text != null ? String(item.text) : (prev.text || ''),
      reason: item.reason != null ? String(item.reason) : (prev.reason || ''),
      channel: item.channel || prev.channel || '',
      status: item.status || prev.status || '',
      publishedPostId: item.publishedPostId || prev.publishedPostId || '',
      publishedPostUrl: item.publishedPostUrl || prev.publishedPostUrl || '',
      attempts
    });
  }
  return [...map.values()];
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeSettings(input, base) {
  const merged = {...base, ...(input && typeof input === 'object' ? input : {})};
  const next = {...FOLLOW_QUEUE_DEFAULT_SETTINGS};
  next.enabled = merged.enabled === true;
  next.onlyRecommended = merged.onlyRecommended !== false;
  next.grokEnabled = merged.grokEnabled === true;
  next.autoPublish = merged.autoPublish === true;
  for (const [key, [min, max]] of Object.entries(SETTING_BOUNDS)) {
    next[key] = clampInt(merged[key], min, max, FOLLOW_QUEUE_DEFAULT_SETTINGS[key]);
  }
  if (next.jitter > next.every) next.jitter = Math.max(1, next.every);
  next.ratioThreshold = Math.max(0, Math.min(1, Number(merged.ratioThreshold)));
  if (!Number.isFinite(next.ratioThreshold)) next.ratioThreshold = FOLLOW_QUEUE_DEFAULT_SETTINGS.ratioThreshold;
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

function blankJob({id, accountId, targetUserId, targetKey, handle, canonical, sources, now}) {
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
    evaluations: []
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
  outcomes.put({
    key,
    accountId: record.accountId,
    targetKey: record.targetKey,
    targetUserId: record.targetUserId || '',
    handleCanonical: record.handleCanonical || '',
    state: record.state,
    followResult: clone(record.followResult),
    evaluations: clone(record.evaluations || []),
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
    updatedAt: job.updatedAt
  };
}

function applyDurableState(job, outcome) {
  if (!outcome || !DURABLE_STATES.includes(outcome.state)) return false;
  if (job.state !== 'pending' && job.state !== 'retry') return false;
  job.state = outcome.state;
  job.stage = outcome.state === 'uncertain' ? 'verify' : outcome.state;
  job.followResult = clone(outcome.followResult);
  job.evaluations = mergeEvaluations(job.evaluations, outcome.evaluations, job.id);
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
        const jobs = db.createObjectStore('jobs', {keyPath: 'id'});
        jobs.createIndex('accountId', 'accountId', {unique: false});
        jobs.createIndex('accountTarget', ['accountId', 'targetKey'], {unique: true});
        db.createObjectStore('outcomes', {keyPath: 'key'});
        db.createObjectStore('settings', {keyPath: 'accountId'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('failed to open follow queue'));
    }).catch(error => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  };

  async function withTransaction(mode, work) {
    const db = await open();
    const tx = db.transaction(STORES, mode);
    const stores = {
      jobs: tx.objectStore('jobs'),
      outcomes: tx.objectStore('outcomes'),
      settings: tx.objectStore('settings')
    };
    let settled = false;
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => { settled = true; resolve(); };
      tx.onabort = () => { settled = true; reject(tx.error || new Error('follow queue transaction aborted')); };
      tx.onerror = () => { settled = true; reject(tx.error || new Error('follow queue transaction failed')); };
    });
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

  async function readJobs(jobs) {
    return requestResult(jobs.getAll());
  }

  async function readOutcomes(outcomes) {
    return requestResult(outcomes.getAll());
  }

  function newId() {
    if (globalThis.crypto?.randomUUID) return `fq_${crypto.randomUUID()}`;
    return `fq_${now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  }

  return {
    async enqueue({accountId, targetUserId, handle, sources, initialState, followResult} = {}) {
      const account = requireAccountId(accountId);
      const userId = userIdString(targetUserId);
      const canonical = canonicalHandle(handle);
      if (!userId && !canonical) throw new Error('target user id or handle is required');
      const seenAt = now();
      const normalizedSources = (Array.isArray(sources) ? sources : []).map(source => normalizeSource(source, seenAt));
      const shown = displayHandle(handle, canonical);

      return withTransaction('readwrite', async ({jobs, outcomes}) => {
        const all = await readJobs(jobs);
        const durable = await readOutcomes(outcomes);
        const targetKey = userId ? `id:${userId}` : `handle:${canonical}`;
        const accountJobs = all.filter(job => job.accountId === account && !job.redirectTo);
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
          jobs.put(primary);
          jobs.put(provisional);
          return clone(leaseHeld(provisional) ? provisional : primary);
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
            now: seenAt
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
        }

        const durableHit = pickDurable(durable, account, primary, canonical);
        if (durableHit && (primary.state === 'pending' || primary.state === 'retry')) {
          applyDurableState(primary, durableHit);
        } else if (durableHit && leaseHeld(primary)) {
          // The in-flight follow keeps its lease until expiration. The stored outcome
          // waits on importedHold so renew cannot extend work the outcome already closed.
          writeImportedHold(primary, durableHit.state, durableHit.followResult);
          primary.evaluations = mergeEvaluations(primary.evaluations, durableHit.evaluations, primary.id);
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
        return clone(primary);
      });
    },

    async list({accountId} = {}) {
      const account = requireAccountId(accountId);
      return withTransaction('readonly', async ({jobs}) => {
        const all = await readJobs(jobs);
        return all
          .filter(job => job.accountId === account)
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map(job => clone(job));
      });
    },

    async claim({accountId, owner, leaseMs} = {}) {
      const account = requireAccountId(accountId);
      if (typeof owner !== 'string' || owner === '') throw new Error('lease owner is required');
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive number');
      const seenAt = now();
      return withTransaction('readwrite', async ({jobs, outcomes}) => {
        const all = await readJobs(jobs);
        for (const job of all) {
          if (job.state === 'running' && !(job.lease?.expiresAt > seenAt)) {
            if (!applyImportedHold(job)) {
              job.state = 'uncertain';
              job.stage = 'verify';
            }
            job.updatedAt = seenAt;
            releaseLease(job);
            jobs.put(job);
            rememberOutcome(outcomes, job);
          }
        }
        const active = all.some(job => job.state === 'running' && job.lease?.expiresAt > seenAt);
        if (active) return null;
        // enabled/migration confirmation is not a store concern. Codex gates production claims in the scheduler.
        const eligible = all
          .filter(job => job.accountId === account && !job.redirectTo && (job.state === 'pending' || job.state === 'retry'))
          .filter(job => sourceAuthorized(job))
          .filter(job => !(job.nextEligibleAt > seenAt))
          .sort((a, b) => {
            if (a.state !== b.state) return a.state === 'pending' ? -1 : 1;
            return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
          });
        const job = eligible[0];
        if (!job) return null;
        job.state = 'running';
        job.stage = job.stage === 'queued' ? 'claimed' : job.stage;
        job.updatedAt = seenAt;
        job.lease = {
          owner,
          version: (job.lease?.version || 0) + 1,
          expiresAt: seenAt + leaseMs
        };
        jobs.put(job);
        return clone(job);
      });
    },

    async settle({id, owner, version, state, patch} = {}) {
      if (typeof id !== 'string' || id === '') throw new Error('job id is required');
      if (!Object.prototype.hasOwnProperty.call(STATE_RANK, state)) throw new Error('invalid follow queue state');
      const seenAt = now();
      return withTransaction('readwrite', async ({jobs, outcomes}) => {
        const all = await readJobs(jobs);
        const job = all.find(item => item.id === id);
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
            job.state = 'followed';
            job.updatedAt = seenAt;
            releaseLease(job);
            jobs.put(job);
            rememberOutcome(outcomes, job);
            return {ok: true, job: clone(job)};
          }
          applyImportedHold(job);
          if (Array.isArray(changes.evaluations)) {
            job.evaluations = mergeEvaluations(job.evaluations, changes.evaluations, job.id);
          }
          releaseLease(job);
          job.updatedAt = seenAt;
          jobs.put(job);
          rememberOutcome(outcomes, job);
          return {ok: false, reason: 'imported-hold', job: clone(job)};
        }
        if (typeof changes.stage === 'string') job.stage = changes.stage;
        if (Number.isFinite(changes.nextEligibleAt)) job.nextEligibleAt = changes.nextEligibleAt;
        if (changes.followResult && typeof changes.followResult === 'object') {
          job.followResult = clone(changes.followResult);
        }
        if (Array.isArray(changes.evaluations)) {
          job.evaluations = mergeEvaluations(job.evaluations, changes.evaluations, job.id);
        }
        job.state = state;
        job.updatedAt = seenAt;
        if (state !== 'running') {
          job.lease = {owner: '', version: lease.version, expiresAt: 0};
        }
        jobs.put(job);
        rememberOutcome(outcomes, job);
        return {ok: true, job: clone(job)};
      });
    },

    async resolveJob({accountId, id, state, stage, followResult, nextEligibleAt, evaluations} = {}) {
      const account = requireAccountId(accountId);
      if (typeof id !== 'string' || id === '') throw new Error('job id is required');
      if (state != null && (!Object.prototype.hasOwnProperty.call(STATE_RANK, state) || state === 'running')) {
        throw new Error('invalid follow queue state');
      }
      const seenAt = now();
      return withTransaction('readwrite', async ({jobs, outcomes}) => {
        const all = await readJobs(jobs);
        const job = all.find(item => item.id === id && item.accountId === account);
        if (!job) return {ok: false, reason: 'missing'};
        if (leaseHeld(job) && job.lease.expiresAt > seenAt) return {ok: false, reason: 'leased'};
        if (state != null) job.state = state;
        if (typeof stage === 'string') job.stage = stage;
        if (followResult && typeof followResult === 'object') job.followResult = clone(followResult);
        if (Number.isFinite(nextEligibleAt)) job.nextEligibleAt = nextEligibleAt;
        if (Array.isArray(evaluations)) {
          job.evaluations = mergeEvaluations(job.evaluations, evaluations, job.id);
        }
        delete job.importedHold;
        releaseLease(job);
        job.updatedAt = seenAt;
        if (job.state === 'pending' || job.state === 'retry') {
          const durable = await readOutcomes(outcomes);
          for (const outcome of durable) {
            if (outcome.accountId !== account) continue;
            const keyMatch = outcome.key === outcomeKey(account, job.targetKey);
            const idMatch = !!job.targetUserId && outcome.targetUserId === job.targetUserId;
            const handleMatch = !!job.handleCanonical && outcome.handleCanonical === job.handleCanonical;
            if (keyMatch || idMatch || handleMatch) outcomes.delete(outcome.key);
          }
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
            updatedAt: job.updatedAt
          });
        }
        jobs.put(job);
        return {ok: true, job: clone(job)};
      });
    },

    async importOutcome({accountId, targetUserId, handle, sources, state, followResult} = {}) {
      if (!DURABLE_STATES.includes(state)) {
        throw new Error('importOutcome state must be followed, skipped, excluded, or uncertain');
      }
      return this.enqueue({accountId, targetUserId, handle, sources, initialState: state, followResult});
    },

    async renew({id, owner, version, leaseMs} = {}) {
      if (typeof id !== 'string' || id === '') throw new Error('job id is required');
      if (typeof owner !== 'string' || owner === '') throw new Error('lease owner is required');
      if (!Number.isFinite(version)) throw new Error('lease version is required');
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive number');
      const seenAt = now();
      return withTransaction('readwrite', async ({jobs}) => {
        const all = await readJobs(jobs);
        const job = all.find(item => item.id === id);
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
        return {ok: true, job: clone(job)};
      });
    },

    async updateSources({accountId, modules} = {}) {
      const account = requireAccountId(accountId);
      const flags = {};
      for (const key of ['fans', 'mutual', 'comments']) {
        if (modules && typeof modules[key] === 'boolean') flags[key] = modules[key];
      }
      return withTransaction('readwrite', async ({jobs}) => {
        const all = await readJobs(jobs);
        const touched = [];
        for (const job of all) {
          if (job.accountId !== account || !Array.isArray(job.sources)) continue;
          let changed = false;
          for (const source of job.sources) {
            if (!Object.prototype.hasOwnProperty.call(flags, source.module)) continue;
            if (source.enabled !== flags[source.module]) {
              source.enabled = flags[source.module];
              changed = true;
            }
          }
          if (!changed) continue;
          job.updatedAt = now();
          jobs.put(job);
          touched.push(clone(job));
        }
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
      return withTransaction('readwrite', async ({settings: store}) => {
        const stored = await requestResult(store.get(account));
        const next = normalizeSettings(settings, normalizeSettings(stored, FOLLOW_QUEUE_DEFAULT_SETTINGS));
        store.put({...next, accountId: account});
        return next;
      });
    }
  };
}
