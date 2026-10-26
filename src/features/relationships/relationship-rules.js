// Pure relationship rules shared by records and the dashboard.
// Indexes are per pass: callers must rebuild after in-place monitor edits.

function handleKey(value) {
  const raw = value?.handle;
  return raw ? String(raw).toLowerCase() : '';
}

// A disagreement between source collections needs a fresh X check. Historical
// profileCache is excluded: it can predate a later successful follow.
export function inactiveFollowingHandles(snapshot = {}) {
  const inactive = new Set();
  for (const list of [
    snapshot.monitor?.users, snapshot.monitor?.queue, snapshot.monitor?.followingUsers,
    snapshot.mutualNetwork?.users, snapshot.commentTracking?.users,
    snapshot.unreciprocatedTracker?.users
  ]) {
    for (const user of list || []) {
      const key = handleKey(user);
      if (key && (user?.relationship?.following === false
        || user?.status === 'unfollowed' || user?.status === 'no_longer_following')) inactive.add(key);
    }
  }
  return inactive;
}

export function buildRelationshipIndex(monitor = {}) {
  const inactive = inactiveFollowingHandles({monitor});
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
    if (key && !inactive.has(key)) following.add(key);
  }
  for (const user of monitor.users || []) {
    visits += 1;
    const key = handleKey(user);
    if (!key) continue;
    const active = user.relationship?.following === true
      || (user.relationship?.following == null && user.state === 'following');
    const status = active
      ? 'following'
      : (queueStatus.get(key) || 'saved');
    if (active && !inactive.has(key)) following.add(key);
  }
  return {queueStatus, followers, following, sawEmptyHandle, emptyHandleStatus, visits};
}

export function monitorUserStatus(user, index) {
  if (user?.relationship?.following === false) return 'saved';
  if (user?.state === 'following' || user?.relationship?.following === true) return 'following';
  const key = handleKey(user);
  if (!key) return index?.sawEmptyHandle ? (index.emptyHandleStatus || 'saved') : 'saved';
  return index?.queueStatus?.get?.(key) || 'saved';
}

export function commentRelationshipLabel(user, index) {
  const key = handleKey(user);
  const following = user?.relationship?.following === false ? false
    : Boolean(key && index?.following?.has?.(key)) || user?.relationship?.following === true;
  const followedBy = Boolean(key && index?.followers?.has?.(key)) || user?.relationship?.followedBy === true;
  return following && followedBy ? '互相关注' : '未互关';
}

export function applyRelationshipSnapshot(user, index) {
  if (!user?.handle) return user;
  const key = handleKey(user);
  const relationship = {...(user.relationship || {})};
  const following = index && typeof index === 'object' ? index.following : null;
  const followers = index && typeof index === 'object' ? index.followers : null;
  if (relationship.following !== false && following && typeof following.has === 'function' && following.has(key)) relationship.following = true;
  else if (typeof relationship.following !== 'boolean') relationship.following = false;
  if (followers && typeof followers.has === 'function' && followers.has(key) && typeof relationship.followedBy !== 'boolean') relationship.followedBy = true;
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
  const inactive = inactiveFollowingHandles(snapshot);
  for (const [indexInList, user] of (monitor.followingUsers || []).entries()) {
    if (!user?.handle || user.relationship?.following === false || inactive.has(handleKey(user))) continue;
    const followedBy = user.relationship?.followedBy;
    if (followedBy === false || (followedBy !== true && !index.followers.has(handleKey(user)))) {
      rememberCandidate(candidates, user, ['monitor', 'followingUsers', indexInList]);
    }
  }
  for (const [indexInList, user] of (monitor.users || []).entries()) {
    if (!user?.handle || inactive.has(handleKey(user))) continue;
    if (user.relationship?.following === true && user.relationship?.followedBy === false) {
      rememberCandidate(candidates, user, ['monitor', 'users', indexInList]);
    }
  }
  for (const [indexInList, user] of (snapshot.mutualNetwork?.users || []).entries()) {
    if (!user?.handle || inactive.has(handleKey(user))) continue;
    const key = handleKey(user);
    if (user.relationship?.following === true && (user.relationship?.followedBy === false || (user.relationship?.followedBy !== true && !index.followers.has(key)))) {
      rememberCandidate(candidates, user, ['mutualNetwork', 'users', indexInList]);
    }
  }
  return [...candidates.values()];
}

// Panel syncAllActiveFollowedUsers, without mutating the snapshot.
export function deriveTrackerUsers(snapshot = {}) {
  const inactive = inactiveFollowingHandles(snapshot);
  const existing = new Map();
  for (const [indexInList, user] of (snapshot.unreciprocatedTracker?.users || []).entries()) {
    const key = handleKey(user);
    if (!key || existing.has(key)) continue;
    existing.set(key, {handle: key, payload: user, sourcePath: ['unreciprocatedTracker', 'users', indexInList], derived: false});
  }
  const now = '';
  const indexed = (list, sourcePath) => (list || []).map((user, indexInList) => ({user, sourcePath: sourcePath.concat(indexInList)}));
  const pool = [
    ...indexed(snapshot.monitor?.followingUsers, ['monitor', 'followingUsers']).filter(entry => entry.user?.relationship?.following !== false),
    ...indexed(snapshot.monitor?.users, ['monitor', 'users']).filter(entry => entry.user?.relationship?.following === true),
    ...indexed(snapshot.mutualNetwork?.users, ['mutualNetwork', 'users']).filter(entry => entry.user?.relationship?.following === true),
    ...indexed(snapshot.commentTracking?.users, ['commentTracking', 'users']).filter(entry => entry.user?.relationship?.following === true)
  ];
  for (const entry of pool) {
    const key = handleKey(entry.user);
    if (!key || existing.has(key) || inactive.has(key)) continue;
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
  return [...existing.values()].filter(row => !inactive.has(row.handle));
}
