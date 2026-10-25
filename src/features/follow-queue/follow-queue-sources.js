import {isPendingFanFollowBack} from '../relationships/fan-followback-policy.js';
// Legacy monitor, mutual, and comment records are not account-scoped.
// The caller must confirm they belong to accountId before calling this adapter.
// Old module switches are not authorization. Only sourceEnabled === true enables a source.

const IMPORT_RANK = {skipped: 1, uncertain: 2, excluded: 3, followed: 4};

function requireAccountId(accountId) {
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error('missing account; follow queue source adapter fails closed');
  }
  return accountId.trim();
}

function canonicalHandle(handle) {
  return String(handle || '').trim().replace(/^@+/, '').toLowerCase();
}

function verifiedRestId(user) {
  if (!user || typeof user !== 'object') return '';
  const raw = user.targetUserId ?? user.rest_id ?? user.restId;
  if (typeof raw !== 'string') return '';
  const id = raw.trim();
  return /^\d+$/.test(id) ? id : '';
}

function attemptRecord(attempts, canonical) {
  if (!attempts || typeof attempts !== 'object' || !canonical) return null;
  const record = attempts[`autoFollowAttempt:${canonical}`] || attempts[canonical];
  return record && typeof record === 'object' ? record : null;
}

function preferState(current, incoming) {
  if (!incoming) return current || '';
  if (!current) return incoming;
  return (IMPORT_RANK[incoming] || 0) >= (IMPORT_RANK[current] || 0) ? incoming : current;
}

function heldState(user, attempt, forceFollowed) {
  const auto = user?.autoFollowState;
  let state = '';
  const following = user?.relationship?.following === true
    || (forceFollowed && user?.relationship?.following !== false);
  if (following) state = 'followed';
  else if (user?.state === 'following' || user?.followedAt || attempt?.state === 'followed' || auto === 'followed') state = 'uncertain';
  if (attempt?.state === 'excluded') state = preferState(state, 'excluded');
  if (attempt?.state === 'skipped' || auto === 'skipped') state = preferState(state, 'skipped');
  if (
    attempt?.state === 'failed'
    || attempt?.state === 'processing'
    || auto === 'failed'
    || auto === 'rate_limited'
  ) state = preferState(state, 'uncertain');
  return state;
}

function asUser(entry) {
  if (typeof entry === 'string') return {handle: entry};
  if (entry && typeof entry === 'object') return entry;
  return null;
}

function pushUrl(urls, value) {
  const url = value == null ? '' : String(value).trim();
  if (url && !urls.includes(url)) urls.push(url);
}

function processedHandlesOf(value) {
  const list = Array.isArray(value) ? value : value?.processedHandles;
  if (!Array.isArray(list)) return [];
  const handles = [];
  for (const item of list) {
    const canonical = canonicalHandle(typeof item === 'string' ? item : item?.handle);
    if (canonical && !handles.includes(canonical)) handles.push(canonical);
  }
  return handles;
}

function commentUrls(user, posts) {
  const urls = [];
  const postList = Array.isArray(posts) ? posts : [];
  for (const source of user?.sources || []) {
    if (!source || typeof source !== 'object') continue;
    if (source.url) pushUrl(urls, source.url);
    else if (source.tweetId) {
      const post = postList.find(item => item && item.tweetId === source.tweetId);
      if (post?.url) pushUrl(urls, post.url);
    }
  }
  return urls;
}

export function collectFollowQueueCandidates({
  accountId,
  monitor,
  mutualNetwork,
  commentTracking,
  attempts,
  sourceEnabled,
  mutualAutoFollowSettings,
  commentAutoFollowSettings
} = {}) {
  const account = requireAccountId(accountId);
  const enabled = {
    fans: sourceEnabled?.fans === true,
    mutual: sourceEnabled?.mutual === true,
    comments: sourceEnabled?.comments === true
  };
  const merged = new Map();

  function take(entry, module, urls, forceFollowed) {
    const user = asUser(entry);
    if (!user) return;
    const canonical = canonicalHandle(user.handle);
    if (!canonical) return;
    const shown = String(user.handle).trim().replace(/^@+/, '') || canonical;
    const attempt = attemptRecord(attempts, canonical);
    const state = heldState(user, attempt, forceFollowed === true);
    let row = merged.get(canonical);
    if (!row) {
      row = {
        accountId: account,
        targetUserId: '',
        handle: shown,
        sources: [],
        state: '',
        followResult: null,
        restIds: new Set()
      };
      merged.set(canonical, row);
    }
    if (module === 'fans' && isPendingFanFollowBack(user)) row.followBackCandidate = true;
    const restId = verifiedRestId(user);
    if (restId) row.restIds.add(restId);
    const sourceUrls = urls.length ? urls : [''];
    for (const url of sourceUrls) {
      if (!row.sources.some(source => source.module === module && source.url === url)) {
        row.sources.push({module, url, enabled: enabled[module] === true});
      }
    }
    row.state = preferState(row.state, state);
    if (row.state === 'followed' && !row.followResult) {
      row.followResult = {following: true, imported: true};
    } else if (!row.followResult && attempt?.reason && row.state) {
      row.followResult = {reason: String(attempt.reason), imported: true};
    }
  }

  const monitorUsers = monitor?.users || [];
  const queue = monitor?.queue || [];
  const followingUsers = monitor?.followingUsers || [];
  for (const entry of [...monitorUsers, ...queue]) take(entry, 'fans', []);
  for (const entry of followingUsers) take(entry, 'fans', [], true);
  for (const entry of mutualNetwork?.users || []) take(entry, 'mutual', []);
  const posts = commentTracking?.posts || [];
  for (const entry of commentTracking?.users || []) {
    const user = asUser(entry);
    take(user, 'comments', commentUrls(user, posts));
  }

  const processed = [
    ...processedHandlesOf(monitor?.autoFollow),
    ...processedHandlesOf(mutualNetwork?.autoFollow),
    ...processedHandlesOf(commentTracking?.autoFollow),
    ...processedHandlesOf(mutualAutoFollowSettings),
    ...processedHandlesOf(commentAutoFollowSettings)
  ];
  for (const canonical of processed) {
    let row = merged.get(canonical);
    if (!row) {
      row = {
        accountId: account,
        targetUserId: '',
        handle: canonical,
        sources: [],
        state: '',
        followResult: null,
        restIds: new Set()
      };
      merged.set(canonical, row);
    }
    row.state = preferState(row.state, 'uncertain');
    if (!row.followResult && row.state === 'uncertain') {
      row.followResult = {reason: 'processed-handle', imported: true};
    }
  }

  return [...merged.values()].map(row => {
    const conflict = row.restIds.size > 1;
    const state = conflict ? 'uncertain' : row.state;
    const candidate = {
      accountId: row.accountId,
      targetUserId: conflict || row.restIds.size !== 1 ? '' : [...row.restIds][0],
      handle: row.handle,
      sources: row.sources
    };
    if (row.sources.some(source => source.module === 'fans')) candidate.followBackCandidate = !conflict && row.followBackCandidate === true;
    if (state) candidate.state = state;
    if (conflict) {
      candidate.followResult = {reason: 'conflicting-rest-ids', imported: true};
    } else if (row.followResult && state) candidate.followResult = row.followResult;
    return candidate;
  });
}
