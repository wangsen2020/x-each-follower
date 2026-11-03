// Read model only: source records and execution history remain untouched.
import {needsFanEnrichment} from './fan-review-flow.js';
export const FAN_DIRECTORY_VERSION = 7;
export const FAN_TABS = {
  fanAll: 'all',
  fanFollowing: 'following',
  fanPending: 'pending',
  fanOutstanding: 'outstanding',
  fanReview: 'review',
  fanRemoved: 'removed',
  fanMutual: 'mutual',
  fanUnknown: 'unknown',
  fanNone: 'none'
};
export const FAN_LABELS = {
  following: '已关注',
  pending: '待回关',
  review: '待审核',
  removed: '已移除',
  mutual: '已互关',
  unknown: '待核实',
  none: '无关系'
};

export const FAN_REVIEW_RESULT_FILTERS = ['', 'pass', 'review', 'uncertain', 'unlabeled'];
export function matchesFanReviewResult(payload, result = '') {
  if(!FAN_REVIEW_RESULT_FILTERS.includes(result))throw Error('无效的审核结果筛选');
  if(!result)return true;
  if(payload?.fanCategory!=='review')return false;
  const decision=payload.fanReview?.decision;
  return result==='unlabeled'?!['pass','review','uncertain'].includes(decision):decision===result;
}

function time(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return Date.parse(value || '') || 0;
}

function observation(user, field) {
  return Math.max(time(user[`${field}ObservedAt`]), time(user.relationshipObservedAt), time(user.relationshipVerifiedAt));
}

function reviewStamp(review = {}) {
  return Math.max(
    Number(review.decisionVersion) || 0,
    time(review.manualUpdatedAt),
    time(review.removedAt),
    time(review.approvedAt),
    time(review.analyzedAt),
    time(review.updatedAt)
  );
}

function resolveFanReview(ordered) {
  const candidates = ordered
    .map(row => row.payload?.fanReview)
    .filter(review => review && typeof review === 'object');
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => (
    (Number(b.decisionVersion) || 0) - (Number(a.decisionVersion) || 0)
    || reviewStamp(b) - reviewStamp(a)
  ));
  return structuredClone(sorted[0]);
}

function fact(row, field) {
  const user = row.payload || {};
  let value = user.relationship?.[field];
  if (typeof value !== 'boolean' && field === 'following') {
    if (row.sourcePath?.[1] === 'followingUsers' || user.state === 'following' || user.status === 'followed') value = true;
    else if (user.state === 'follow_back') value = false;
  }
  if (typeof value !== 'boolean' && field === 'followedBy' && user.state === 'follow_back') value = true;
  return typeof value === 'boolean' ? {value, at: observation(user, field)} : null;
}

function resolve(rows, field) {
  const facts = rows.map(row => fact(row, field)).filter(Boolean);
  const latest = Math.max(0, ...facts.map(item => item.at));
  const values = new Set(facts.filter(item => item.at === latest).map(item => item.value));
  return {value: values.size === 1 ? [...values][0] : null, conflict: values.size > 1, at: latest};
}

export function fanDirectoryRow(rows) {
  const sources = rows.filter(row => row.sourceKey === 'monitor' && ['users', 'queue', 'followingUsers'].includes(row.sourcePath?.[1]));
  if (!sources.length) return null;
  const ordered = [...sources].sort((a, b) => Math.max(observation(b.payload || {}, 'following'), observation(b.payload || {}, 'followedBy')) - Math.max(observation(a.payload || {}, 'following'), observation(a.payload || {}, 'followedBy'))
    || (a.sourcePath?.[1] === 'users' ? 0 : 1) - (b.sourcePath?.[1] === 'users' ? 0 : 1) || a.userKey.localeCompare(b.userKey));
  const source = ordered[0];
  const handle = String(source.handle || source.payload?.handle || '').toLowerCase();
  if (!handle) return null;
  const ids = new Set(sources.map(row => String(row.payload?.id || row.payload?.rest_id || '')).filter(Boolean));
  const following = resolve(sources, 'following');
  const followedBy = resolve(sources, 'followedBy');
  const identityConflict = ids.size > 1 || sources.some(row => row.payload?.status === 'identity_mismatch');
  const relationship = {following: identityConflict ? null : following.value, followedBy: identityConflict ? null : followedBy.value};
  let category = relationship.following === true && relationship.followedBy === true ? 'mutual'
    : relationship.following === true && relationship.followedBy === false ? 'following'
    : relationship.following === false && relationship.followedBy === true ? 'pending'
    : relationship.following === false && relationship.followedBy === false ? 'none' : 'unknown';
  const undatedPending = category === 'pending' && (!following.at || !followedBy.at);
  const undatedNone = category === 'none' && (!following.at || !followedBy.at);
  if (undatedPending || undatedNone) category = 'unknown';

  let fanReview = resolveFanReview(ordered);
  const legacyRemovedRow = ordered.find(row =>
    row.payload?.state === 'removed_follower'
    || row.payload?.status === 'removed'
    || Boolean(row.payload?.followerRemovedAt)
  );
  if (!identityConflict) {
    if (
      (fanReview?.state === 'removed' || legacyRemovedRow)
      && relationship.following !== true
      && relationship.followedBy !== true
    ) {
      category = 'removed';
      fanReview = {
        state: 'removed',
        decision: 'remove',
        reason: fanReview?.reason || legacyRemovedRow?.payload?.reason || '已移除此关注者',
        tags: fanReview?.tags || legacyRemovedRow?.payload?.tags || [],
        evidence: fanReview?.evidence || [],
        ...(fanReview || {})
      };
    } else if (category === 'pending' && fanReview?.state !== 'approved') {
      category = needsFanEnrichment(fanReview) ? 'unknown' : 'review';
    }
  }

  const reason = identityConflict ? '同名账号的用户 ID 不一致，需要重新核实'
    : category === 'unknown' && source.payload?.fanInspectionFailure?.reason ? source.payload.fanInspectionFailure.reason
    : undatedPending && category === 'unknown' ? '历史待回关记录缺少核验时间，需要重新核实'
    : following.conflict || followedBy.conflict ? '本地关系记录相互矛盾，需要重新核实'
    : category === 'removed' ? (fanReview?.reason || '已移除此关注者')
    : category === 'review' ? (fanReview?.reason || '等待初审或人工审核确认')
    : category === 'unknown' && needsFanEnrichment(fanReview) ? (fanReview.enrichmentCompletedAt?'补采后资料仍不足，可重新核实':'资料待补充，完成后重新审核')
    : category === 'unknown' ? '关注关系尚未读全，需要重新核实' : '';
  const payload = {...source.payload};
  for (const field of ['name', 'bio', 'avatarUrl', 'followersText', 'followingText']) {
    payload[field] = ordered.map(row => row.payload?.[field]).find(value => value != null && value !== '') || payload[field] || '';
  }
  const fanGrant = fanReview?.grant || ordered.map(row => row.payload?.fanGrant).find(Boolean) || null;
  if (fanReview) payload.fanReview = fanReview;
  if (fanGrant) payload.fanGrant = fanGrant;
  Object.assign(payload, {
    relationship,
    relationshipKnown: typeof relationship.following==='boolean'&&typeof relationship.followedBy==='boolean'&&!undatedPending&&!undatedNone,
    fanCategory: category,
    fanRelationshipReason: reason,
    fanRelationshipObservedAt: Math.max(following.at, followedBy.at),
    status: category === 'pending' ? 'pending' : ['mutual', 'following'].includes(category) ? 'followed' : category
  });
  const reviewSearch = fanReview
    ? [fanReview.reason, ...(fanReview.tags || []), ...(fanReview.evidence || []).map(e => typeof e === 'string' ? e : (e?.text || e?.reason || ''))]
    : [];
  return {
    accountId: source.accountId,
    module: 'fanDirectory',
    userKey: handle,
    handle,
    sourceKey: 'derived:fanDirectory',
    sourcePath: source.sourcePath,
    sourceUserKey: source.userKey,
    sortKey: handle,
    tabs: category === 'none' ? ['none'] : ['all', category,...(relationship.following===false&&relationship.followedBy===true&&!undatedPending?['outstanding']:[])],
    tab: 'all',
    payload,
    status: payload.status,
    view: relationship,
    searchText: [
      ...sources.flatMap(row => [row.payload?.handle, row.payload?.name, row.payload?.bio, ...(row.payload?.tags || [])]),
      ...reviewSearch
    ].filter(Boolean).join(' ').toLowerCase()
  };
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
  const rows = ['users', 'queue', 'followingUsers'].flatMap(bucket => (monitor[bucket] || []).map((payload, index) => ({
    accountId: payload.accountId || 'unassigned',
    module: 'fans',
    sourceKey: 'monitor',
    sourcePath: ['monitor', bucket, index],
    userKey: payload.__userKey || `${bucket}/${index}`,
    payload,
    handle: payload.handle
  })));
  return buildFanDirectory(rows);
}

export function normalizeFanSearch(value) {
  const raw = String(value || '').trim();
  const profile = raw.match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/?(?:[?#].*)?$/i);
  return (profile ? profile[1] : raw.replace(/^@/, '')).toLowerCase();
}

export function exactFanSearchHandle(value) {
  const raw = String(value || '').trim();
  if (/^@[a-zA-Z0-9_]{1,15}$/.test(raw)) return raw.slice(1).toLowerCase();
  const profile = raw.match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]{1,15})\/?(?:[?#].*)?$/i);
  return profile ? profile[1].toLowerCase() : '';
}
