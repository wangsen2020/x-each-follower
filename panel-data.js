// Pure dashboard lookup and durable-recovery decisions.
// Indexes are per pass: callers must rebuild after in-place monitor edits.

export const STARTUP_DURABLE_KEYS = [
  'rows',
  'monitor',
  'analysisRows',
  'profileCache',
  'mutualNetwork',
  'commentTracking',
  'mutualAutoFollowSettings',
  'commentAutoFollowSettings',
  'unreciprocatedTracker'
];

export const LOG_DURABLE_KEYS = ['autoFollowLogs', 'monitorLogs', 'unreciprocatedLogs'];

export function localKeyPresent(record, key) {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return false;
  const value = record[key];
  return value !== undefined && value !== null;
}

export function keysMissingFromLocal(record, keys) {
  return keys.filter(key => !localKeyPresent(record, key));
}

// Undefined means "do not apply": local won the race, or the backup is missing.
export function recoveredValueIfStillMissing(latestRecord, key, recovered) {
  if (localKeyPresent(latestRecord, key)) return undefined;
  if (recovered == null) return undefined;
  return recovered;
}

function handleKey(value) {
  const raw = value?.handle;
  return raw ? String(raw).toLowerCase() : '';
}

export function buildRelationshipIndex(monitor = {}) {
  const queueStatus = new Map();
  let visits = 0;
  let sawEmptyHandle = false;
  let emptyHandleStatus = 'saved';
  for (const item of monitor.queue || []) {
    visits += 1;
    const key = handleKey(item);
    if (!key) {
      if (!sawEmptyHandle) {
        sawEmptyHandle = true;
        emptyHandleStatus = item?.status || 'saved';
      }
      continue;
    }
    if (!queueStatus.has(key)) queueStatus.set(key, item?.status || 'saved');
  }
  const followers = new Set();
  for (const item of monitor.users || []) {
    visits += 1;
    const key = handleKey(item);
    if (key) followers.add(key);
  }
  const following = new Set();
  for (const item of monitor.followingUsers || []) {
    visits += 1;
    const key = handleKey(item);
    if (key) following.add(key);
  }
  for (const user of monitor.users || []) {
    visits += 1;
    const key = handleKey(user);
    if (!key) continue;
    const status = user.state === 'following' || user.relationship?.following === true
      ? 'following'
      : (queueStatus.get(key) || 'saved');
    if (user.state === 'following' || status === 'followed') following.add(key);
  }
  return {queueStatus, followers, following, sawEmptyHandle, emptyHandleStatus, visits};
}

export function monitorUserStatus(user, index) {
  if (user?.state === 'following' || user?.relationship?.following === true) return 'following';
  const key = handleKey(user);
  if (!key) return index?.sawEmptyHandle ? (index.emptyHandleStatus || 'saved') : 'saved';
  return index?.queueStatus.get(key) || 'saved';
}

export function commentRelationshipLabel(user, index) {
  const key = handleKey(user);
  const following = Boolean(key && index.following.has(key)) || user?.relationship?.following === true;
  const followedBy = Boolean(key && index.followers.has(key)) || user?.relationship?.followedBy === true;
  return following && followedBy ? '互相关注' : '未互关';
}

export function applyRelationshipSnapshot(user, index) {
  if (!user?.handle) return user;
  const key = handleKey(user);
  const relationship = {...(user.relationship || {})};
  if (index.following.has(key)) relationship.following = true;
  else if (typeof relationship.following !== 'boolean') relationship.following = false;
  if (index.followers.has(key) && typeof relationship.followedBy !== 'boolean') relationship.followedBy = true;
  return {...user, relationship, relationshipKnown: typeof relationship.followedBy === 'boolean'};
}

export function snapshotMutualUsers(users, index) {
  return (users || []).map(user => applyRelationshipSnapshot(user, index));
}

function rememberCandidate(candidates, user, sourcePath) {
  const key = handleKey(user);
  if (!key || candidates.has(key)) return;
  candidates.set(key, {handle: key, payload: user, sourcePath});
}

// Same membership as the panel's not-mutual list: monitor rows first, then mutual
// candidates, one row per handle. Raw relationship fields stay on the payload.
export function deriveNotMutualUsers(snapshot = {}) {
  const monitor = snapshot.monitor || {};
  const index = buildRelationshipIndex(monitor);
  const candidates = new Map();
  for (const [indexInList, user] of (monitor.followingUsers || []).entries()) {
    if (!user?.handle) continue;
    const followedBy = user.relationship?.followedBy;
    if (followedBy === false || (followedBy !== true && !index.followers.has(handleKey(user)))) {
      rememberCandidate(candidates, user, ['monitor', 'followingUsers', indexInList]);
    }
  }
  for (const [indexInList, user] of (monitor.users || []).entries()) {
    if (!user?.handle) continue;
    if (user.relationship?.following === true && user.relationship?.followedBy === false) {
      rememberCandidate(candidates, user, ['monitor', 'users', indexInList]);
    }
  }
  for (const [indexInList, user] of (snapshot.mutualNetwork?.users || []).entries()) {
    if (!user?.handle) continue;
    const key = handleKey(user);
    if (user.relationship?.following === true && (user.relationship?.followedBy === false || (user.relationship?.followedBy !== true && !index.followers.has(key)))) {
      rememberCandidate(candidates, user, ['mutualNetwork', 'users', indexInList]);
    }
  }
  return [...candidates.values()];
}

// Panel syncAllActiveFollowedUsers, without mutating the snapshot.
export function deriveTrackerUsers(snapshot = {}) {
  const existing = new Map();
  for (const [indexInList, user] of (snapshot.unreciprocatedTracker?.users || []).entries()) {
    const key = handleKey(user);
    if (!key || existing.has(key)) continue;
    existing.set(key, {handle: key, payload: user, sourcePath: ['unreciprocatedTracker', 'users', indexInList], derived: false});
  }
  const now = '';
  const indexed = (list, sourcePath) => (list || []).map((user, indexInList) => ({user, sourcePath: sourcePath.concat(indexInList)}));
  const pool = [
    ...indexed(snapshot.monitor?.followingUsers, ['monitor', 'followingUsers']),
    ...indexed(snapshot.monitor?.users, ['monitor', 'users']).filter(entry => entry.user?.relationship?.following === true || entry.user?.state === 'following'),
    ...indexed(snapshot.mutualNetwork?.users, ['mutualNetwork', 'users']).filter(entry => entry.user?.relationship?.following === true || entry.user?.followedAt),
    ...indexed(snapshot.commentTracking?.users, ['commentTracking', 'users']).filter(entry => entry.user?.relationship?.following === true || entry.user?.followedAt)
  ];
  for (const entry of pool) {
    const key = handleKey(entry.user);
    if (!key || existing.has(key)) continue;
    const followedBy = entry.user.relationship?.followedBy === true;
    existing.set(key, {
      handle: key,
      derived: true,
      // Provenance only. Mutations upsert the tracker by handle and never write this path.
      originPath: entry.sourcePath,
      sourcePath: ['unreciprocatedTracker', 'synthetic', key],
      payload: {
        id: entry.user.id || '',
        handle: entry.user.handle,
        name: entry.user.name || entry.user.handle,
        avatarUrl: entry.user.avatarUrl || '',
        bio: entry.user.bio || '',
        followersText: entry.user.followersText || '',
        followingText: entry.user.followingText || '',
        followedAt: entry.user.followedAt || now,
        followBackAt: entry.user.followBackAt || null,
        relationship: {following: true, followedBy},
        status: followedBy ? 'mutual' : 'pending',
        exempt: false
      }
    });
  }
  return [...existing.values()].filter(row => row.payload?.status !== 'unfollowed');
}

export function shouldPaintLogs(modalHidden) {
  return modalHidden === false;
}

// A startup restore is the only reason to scan mojibake a second time.
export function shouldRescanMojibake(restoredCount) {
  return restoredCount > 0;
}

export function tabRenderTargets(previousTab, nextTab) {
  if (previousTab === nextTab) return [];
  if (nextTab === 'followQueue') return ['followQueue'];
  if (nextTab === 'monitor') return ['monitor'];
  if (nextTab === 'candidates') return ['mutual'];
  if (nextTab === 'comments') return ['comments', 'commentSettings'];
  if (nextTab === 'unreciprocated') return ['unreciprocated'];
  return [];
}

// null fields mean the change does not touch that slot. Empty arrays stay present.
export function localStorageChangePlan(changes, area) {
  const idle = {commentRender: false, logs: null, commentStatus: undefined, commentTracking: null, commentAuto: undefined};
  if (area !== 'local' || !changes) return idle;
  return {
    commentRender: Boolean(changes.commentTracking || changes.commentAutoFollowSettings || changes.commentTrackingStatus || changes.monitor),
    logs: changes.autoFollowLogs ? (changes.autoFollowLogs.newValue || []) : null,
    commentStatus: changes.commentTrackingStatus ? (changes.commentTrackingStatus.newValue || null) : undefined,
    commentTracking: changes.commentTracking ? (changes.commentTracking.newValue || {users: [], posts: []}) : null,
    commentAuto: changes.commentAutoFollowSettings?.newValue
  };
}

// Writers must not append until this resolves. A thrown read is retryable.
export async function loadDurableLogBuffer(name, storage) {
  if (!LOG_DURABLE_KEYS.includes(name)) return {action: 'skip'};
  const readLocal = async () => {
    try {
      return await storage.localGet(name);
    } catch (error) {
      const failure = new Error('local log read failed');
      failure.cause = error;
      failure.retryable = true;
      throw failure;
    }
  };
  const saved = await readLocal();
  if (localKeyPresent(saved, name)) return {action: 'assign', value: saved[name], persist: false};
  let recovered;
  try {
    recovered = await storage.durableGet(name);
  } catch (error) {
    const failure = new Error('durable log read failed');
    failure.cause = error;
    failure.retryable = true;
    throw failure;
  }
  const latest = await readLocal();
  if (localKeyPresent(latest, name)) return {action: 'assign', value: latest[name], persist: false};
  const value = recoveredValueIfStillMissing(latest, name, recovered);
  if (!Array.isArray(value)) return {action: 'skip'};
  return {action: 'assign', value, persist: true};
}

export function takeLogBufferTask(tasks, name, loader) {
  if (!tasks[name]) {
    const task = Promise.resolve().then(loader).then(
      value => value,
      error => {
        if (tasks[name] === task) delete tasks[name];
        throw error;
      }
    );
    tasks[name] = task;
  }
  return tasks[name];
}
