const DAY = 24 * 60 * 60 * 1000;

export function followbackKey(user) {
  const id = String(user?.id || user?.rest_id || '').trim();
  const handle = String(user?.handle || '').replace(/^@/, '').toLowerCase();
  return handle ? `handle:${handle}` : `id:${id}`;
}

function validDate(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}

// Legacy follow actions recorded a date before source metadata existed.
export function resolveFollowedAt(candidates, now = Date.now()) {
  const dated = candidates.filter(user => validDate(user?.followedAt));
  const real = dated.filter(user => user.followedAtSource !== 'estimated').sort((a, b) => validDate(a.followedAt) - validDate(b.followedAt))[0];
  const selected = real || dated.sort((a, b) => validDate(a.followedAt) - validDate(b.followedAt))[0];
  return {
    followedAt: new Date(selected ? validDate(selected.followedAt) : now - DAY).toISOString(),
    followedAtSource: real ? 'confirmed' : 'estimated'
  };
}

export function compareFollowback({followingUsers = [], followerUsers = [], previousUsers = [], overdueDays = 14, now = Date.now(), followersComplete = false} = {}) {
  const followers = new Set();
  const handles = new Set();
  for (const user of followerUsers) {
    followers.add(followbackKey(user));
    if (user?.handle) handles.add(String(user.handle).toLowerCase());
  }
  const previous = new Map(previousUsers.map(user => [followbackKey(user), user]));
  const previousByHandle = new Map(previousUsers.map(user => [String(user.handle || '').replace(/^@/, '').toLowerCase(), user]));
  const users = [];
  const seen = new Set();
  for (const user of followingUsers) {
    if (!user?.handle) continue;
    const key = followbackKey(user);
    if (seen.has(key)) continue;
    seen.add(key);
    const old = previous.get(key) || previousByHandle.get(String(user.handle).replace(/^@/, '').toLowerCase()) || {};
    const member = followers.has(key) || handles.has(String(user.handle).toLowerCase());
    const explicit = user.relationship?.followedBy;
    const followedBy = member || explicit === true ? true : explicit === false || followersComplete ? false : null;
    const date = resolveFollowedAt([user, old], now);
    const age = Math.max(0, now - Date.parse(date.followedAt));
    const status = followedBy === true ? 'mutual' : followedBy === null ? 'unknown' : age !== null && age >= overdueDays * DAY ? 'overdue' : 'pending';
    users.push({
      ...old, ...user,
      // Persist the comparison to the tracker, never to the following-list source.
      __sourceKey: old.__sourceKey || 'unreciprocatedTracker',
      __sourceBucket: old.__sourceBucket || 'synthetic',
      __userKey: old.__userKey,
      ...date,
      accountAvailability: old.accountAvailability || user.accountAvailability,
      firstObservedFollowingAt: old.firstObservedFollowingAt || user.firstObservedFollowingAt || new Date(now).toISOString(),
      relationship: {...old.relationship, ...user.relationship, following: true, followedBy},
      relationshipKnown: followedBy !== null,
      status,
      daysSinceFollowed: age === null ? null : Math.floor(age / DAY),
      everMutual: old.everMutual === true || old.status === 'mutual' || followedBy === true,
      followBackAt: followedBy === true ? (old.followBackAt || new Date(now).toISOString()) : old.followBackAt || null,
      lostMutualDetectedAt: followedBy === false && (old.everMutual === true || old.status === 'mutual') ? (old.lostMutualDetectedAt || new Date(now).toISOString()) : old.lostMutualDetectedAt || null
    });
  }
  // Keep recorded unfollows when a fresh comparison only contains active following.
  for (const old of previousUsers) {
    const key = followbackKey(old);
    if (old.status === 'unfollowed' && !seen.has(key)) {
      seen.add(key);
      users.push({...old});
    }
  }
  return users;
}

export function sortFollowbackUsers(users, tab) {
  return [...users].sort((a, b) => {
    if (tab === 'unfollowed') return (validDate(b.unfollowedAt) || 0) - (validDate(a.unfollowedAt) || 0) || followbackKey(a).localeCompare(followbackKey(b));
    const left = validDate(a.followedAt) ?? Number.POSITIVE_INFINITY;
    const right = validDate(b.followedAt) ?? Number.POSITIVE_INFINITY;
    return left - right || followbackKey(a).localeCompare(followbackKey(b));
  });
}

export function needsFollowbackOverlay(user, persistedUser, sourceUser) {
  if (persistedUser) return accountAvailabilityStatus(user) !== accountAvailabilityStatus(persistedUser)
    || user?.status !== persistedUser.status
    || (user?.relationship?.followedBy ?? null) !== (persistedUser.relationship?.followedBy ?? null)
    || (user?.followedAtSource || 'unknown') !== (persistedUser.followedAtSource || 'unknown')
    || (user?.followedAt || null) !== (persistedUser.followedAt || null)
    || Boolean(user?.exempt) !== Boolean(persistedUser.exempt)
    || (user?.lostMutualDetectedAt || null) !== (persistedUser.lostMutualDetectedAt || null);
  const inferredStatus = sourceUser?.relationship?.followedBy === true ? 'mutual'
    : sourceUser?.relationship?.followedBy === false ? 'pending' : 'unknown';
  return user?.status !== inferredStatus || Boolean(user?.followedAt) || user?.followedAtSource === 'confirmed'
    || user?.exempt === true || Boolean(user?.lostMutualDetectedAt);
}


export function accountAvailabilityStatus(user) {
  const status = user?.accountAvailability?.status;
  return ['ok', 'not_found', 'suspended', 'identity_unresolved'].includes(status) ? status : 'unknown';
}
export function isAccountUnavailable(user) {
  return ['not_found', 'suspended'].includes(accountAvailabilityStatus(user));
}
export function mergeFollowbackAvailability(user, evidence) {
  if (!['ok', 'not_found', 'suspended', 'identity_unresolved'].includes(evidence?.status) || !Number.isFinite(evidence.checkedAt)) return user;
  if (evidence.checkedAt < (user.accountAvailability?.checkedAt || 0) || accountAvailabilityStatus(user) === evidence.status) return user;
  return {...user, accountAvailability: {status: evidence.status, checkedAt: evidence.checkedAt}};
}
export function matchesAccountAvailability(user, filter = 'all') {
  return filter === 'all' || (filter === 'unavailable' ? isAccountUnavailable(user) : accountAvailabilityStatus(user) === filter);
}
