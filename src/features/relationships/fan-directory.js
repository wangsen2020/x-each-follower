// Read model only: source records and execution history remain untouched.
export const FAN_DIRECTORY_VERSION = 2;
export const FAN_TABS = {fanAll:'all', fanFollowing:'following', fanPending:'pending', fanMutual:'mutual', fanUnknown:'unknown', fanNone:'none'};
export const FAN_LABELS = {following:'已关注', pending:'待回关', mutual:'已互关', unknown:'待核实', none:'无关系'};

function time(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return Date.parse(value || '') || 0;
}

function observation(user, field) {
  return Math.max(time(user[`${field}ObservedAt`]), time(user.relationshipObservedAt), time(user.relationshipVerifiedAt));
}

function fact(row, field) {
  const user = row.payload || {};
  let value = user.relationship?.[field];
  if (typeof value !== 'boolean' && field === 'following') {
    if (row.sourcePath?.[1] === 'followingUsers' || user.state === 'following' || user.status === 'followed') value = true;
    else if (user.state === 'follow_back') value = false;
  }
  if (typeof value !== 'boolean' && field === 'followedBy' && user.state === 'follow_back') value = true;
  return typeof value === 'boolean' ? {value, at:observation(user, field)} : null;
}

function resolve(rows, field) {
  const facts = rows.map(row => fact(row, field)).filter(Boolean);
  const latest = Math.max(0, ...facts.map(item => item.at));
  const values = new Set(facts.filter(item => item.at === latest).map(item => item.value));
  return {value:values.size === 1 ? [...values][0] : null, conflict:values.size > 1, at:latest};
}

export function fanDirectoryRow(rows) {
  const sources = rows.filter(row => row.sourceKey === 'monitor' && ['users','queue','followingUsers'].includes(row.sourcePath?.[1]));
  if (!sources.length) return null;
  const ordered = [...sources].sort((a,b) => Math.max(observation(b.payload || {},'following'),observation(b.payload || {},'followedBy')) - Math.max(observation(a.payload || {},'following'),observation(a.payload || {},'followedBy'))
    || (a.sourcePath?.[1] === 'users' ? 0 : 1) - (b.sourcePath?.[1] === 'users' ? 0 : 1) || a.userKey.localeCompare(b.userKey));
  const source = ordered[0];
  const handle = String(source.handle || source.payload?.handle || '').toLowerCase();
  if (!handle) return null;
  const ids = new Set(sources.map(row => String(row.payload?.id || row.payload?.rest_id || '')).filter(Boolean));
  const following = resolve(sources, 'following');
  const followedBy = resolve(sources, 'followedBy');
  const identityConflict = ids.size > 1 || sources.some(row => row.payload?.status === 'identity_mismatch');
  const relationship = {following:identityConflict ? null : following.value, followedBy:identityConflict ? null : followedBy.value};
  let category = relationship.following === true && relationship.followedBy === true ? 'mutual'
    : relationship.following === true && relationship.followedBy === false ? 'following'
    : relationship.following === false && relationship.followedBy === true ? 'pending'
    : relationship.following === false && relationship.followedBy === false ? 'none' : 'unknown';
  const undatedPending = category === 'pending' && (!following.at || !followedBy.at);
  if (undatedPending) category='unknown';
  const reason = identityConflict ? '同名账号的用户 ID 不一致，需要重新核实'
    : undatedPending ? '历史待回关记录缺少核验时间，需要重新核实'
    : following.conflict || followedBy.conflict ? '本地关系记录相互矛盾，需要重新核实'
    : category === 'unknown' ? '关注关系尚未读全，需要重新核实' : '';
  const payload = {...source.payload};
  for (const field of ['name','bio','avatarUrl','followersText','followingText']) {
    payload[field] = ordered.map(row => row.payload?.[field]).find(value => value != null && value !== '') || payload[field] || '';
  }
  Object.assign(payload, {relationship, relationshipKnown:category !== 'unknown', fanCategory:category, fanRelationshipReason:reason,
    fanRelationshipObservedAt:Math.max(following.at,followedBy.at), status:category === 'pending' ? 'pending' : ['mutual','following'].includes(category) ? 'followed' : category});
  return {accountId:source.accountId, module:'fanDirectory', userKey:handle, handle, sourceKey:'derived:fanDirectory',
    sourcePath:source.sourcePath, sourceUserKey:source.userKey, sortKey:handle, tabs:['all',category], tab:'all', payload,
    status:payload.status, view:relationship,
    searchText:sources.flatMap(row => [row.payload?.handle,row.payload?.name,row.payload?.bio]).filter(Boolean).join(' ').toLowerCase()};
}

export function buildFanDirectory(rows) {
  const groups = new Map();
  for (const row of rows) {
    const handle = String(row.handle || row.payload?.handle || '').toLowerCase();
    if (!handle || row.sourceKey !== 'monitor') continue;
    const key = `${row.accountId}\0${handle}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(fanDirectoryRow).filter(Boolean);
}

export function fanDirectoryFromMonitor(monitor = {}) {
  const rows = ['users','queue','followingUsers'].flatMap(bucket => (monitor[bucket] || []).map((payload,index) => ({
    accountId:payload.accountId || 'unassigned', module:'fans', sourceKey:'monitor', sourcePath:['monitor',bucket,index],
    userKey:payload.__userKey || `${bucket}/${index}`, payload, handle:payload.handle
  })));
  return buildFanDirectory(rows);
}

export function normalizeFanSearch(value) {
  const raw = String(value || '').trim();
  const profile = raw.match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/?(?:[?#].*)?$/i);
  return (profile ? profile[1] : raw.replace(/^@/, '')).toLowerCase();
}

export function exactFanSearchHandle(value) {
  const raw=String(value || '').trim();
  if (/^@[a-zA-Z0-9_]{1,15}$/.test(raw)) return raw.slice(1).toLowerCase();
  const profile=raw.match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]{1,15})\/?(?:[?#].*)?$/i);
  return profile ? profile[1].toLowerCase() : '';
}
