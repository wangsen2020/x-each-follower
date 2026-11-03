import {removalHistoryRows} from '../relationships/fan-removal-history.js';
import {fanRowOwned,fanRetentionDecision,fanRetentionBlocks,fanTargetId,hasNewerFanRelationship} from '../relationships/fan-retention.js';
// Live record service. Archive migration stays lossless and immutable.
// Dashboard pages use the projection index. Legacy modules are merged, never replaced by a page.

import {canonicalValue, createRecordRepository} from './record-repository.js';
import {createRecordMigration, hashCanonical, flattenLegacySnapshot, moduleForPath} from './record-migration.js';
import {createRecordProjection} from './record-projection.js';
import {SNAPSHOT_CATALOG, SNAPSHOT_PREFIX, SNAPSHOT_LOG_PREFIX, BACKUP_SETTINGS_KEY, validateBackupSettings, splitSnapshot, readSnapshot, verifySnapshotRestore} from './record-snapshots.js';
import {resolveFollowedAt, matchesAccountAvailability} from '../relationships/followback-monitor.js';
import {filterMutualTrackingUsers} from '../relationships/scoring.js';
import {mutualUserCategory, personalRelationshipLabel} from '../relationships/network-api.js';
import {applyRelationshipSnapshot, buildRelationshipIndex, commentRelationshipLabel, deriveNotMutualUsers, deriveTrackerUsers} from '../relationships/relationship-rules.js';
import {createStorageWriteQueue} from '../../platform/storage-write-queue.js';
import {PROFILE_ACCESS_PREFIX} from '../../platform/x/profile-access.js';
import {fanDirectoryRow, FAN_DIRECTORY_VERSION, FAN_TABS, normalizeFanSearch, exactFanSearchHandle, matchesFanReviewResult, FAN_REVIEW_RESULT_FILTERS} from '../relationships/fan-directory.js';
import {needsFanEnrichment} from '../relationships/fan-review-flow.js';
import {unfollowLogReceipts,mergeUnfollowHistory,unfollowHistoryRows} from '../relationships/unfollow-history.js';
import {REPLY_USER_ID_REPAIR_VERSION, replyIdEvidence, planReplyUserIdRepair, repairAutoUnfollowLedger} from './reply-user-id-repair.js';

export const LEGACY_RECORD_KEYS = [
  'monitor', 'rows', 'profileCache', 'mutualNetwork', 'commentTracking',
  'unreciprocatedTracker', 'analysisRows', 'autoFollowLogs', 'monitorLogs', 'unreciprocatedLogs'
];

export const CONFIG_KEYS = [
  'mutualAutoFollowSettings', 'commentAutoFollowSettings', 'unreciprocatedSettings', 'followQueueBinding'
];

export const RECORD_MODULES = [
  'fans', 'mutual', 'comments', 'posts', 'unreciprocated',
  'profiles', 'logs', 'analysis', 'rows', 'extra', 'unassigned'
];

const MODULE_KEYS = {
  fans: ['monitor'],
  mutual: ['mutualNetwork', 'profileCache', 'monitor'],
  comments: ['commentTracking', 'monitor'],
  posts: ['commentTracking'],
  unreciprocated: ['unreciprocatedTracker'],
  profiles: ['profileCache'],
  logs: ['autoFollowLogs', 'monitorLogs', 'unreciprocatedLogs'],
  analysis: ['analysisRows'],
  rows: ['rows'],
  extra: LEGACY_RECORD_KEYS,
  unassigned: LEGACY_RECORD_KEYS
};

const BUSINESS = new Set(['fans', 'mutual', 'comments', 'posts', 'unreciprocated', 'profiles', 'logs', 'analysis', 'rows']);
const BACKUP_PREFIX = 'recordLegacySnapshotBackup:v2:';
const INCREMENTAL_PREFIX = 'recordIncremental:v1:';
const INCREMENTAL_HEAD = 'recordIncremental:v1:head';
const COLLECTION_FIELDS = new Set(['users', 'queue', 'followingUsers', 'posts', 'rows']);
const RELATION_RANK = {'互相关注': 0, '对方关注你': 1, '你关注对方': 2, '未互关': 3, '你未关注对方': 4, '关系未知': 5};
const FAN_REVIEW_PROJECTION_VERSION = 3;

const fanId = value => typeof value === 'string' && /^\d+$/.test(value) ? value : '';
function fanIds(payload = {}) {
  return [...new Set([payload.id, payload.rest_id, payload.restId, payload.targetUserId].map(fanId).filter(Boolean))];
}
function fanOwnerClaims(payload = {}) {
  return [...new Set([payload.ownerAccountId,payload.fanReview?.ownerAccountId,payload.fanReview?.accountId,
    payload.fanReview?.grant?.ownerAccountId,payload.fanGrant?.ownerAccountId,payload.fanReview?.migration?.ownerAccountId]
    .filter(value => typeof value === 'string' && value && value !== 'unassigned'))];
}

function confirmedFanRemoval(payload, accountId, targetUserId) {
  if (!targetUserId) return null;
  if (payload.followResult?.targetUserId && payload.followResult.targetUserId !== targetUserId) return null;
  for (const receipt of [payload.followerRemoval, payload.fanReview?.removalReceipt, payload.followResult?.followerRemoval]) {
    if (!receipt || receipt.removed !== true || !(Number(receipt.verifiedAt) > 0 || Date.parse(receipt.verifiedAt) > 0)) continue;
    const receiptId = fanId(receipt.targetUserId || payload.targetUserId || (fanIds(payload).length === 1 ? fanIds(payload)[0] : ''));
    if (receiptId !== targetUserId || (receipt.accountId && receipt.accountId !== accountId)
      || (receipt.ownerAccountId && receipt.ownerAccountId !== accountId)) continue;
    return clone({...receipt, accountId, targetUserId});
  }
  return null;
}

// Keep workflow separate from relationship facts, including malformed legacy removal labels.
function reviewDirectoryRow(rows) {
  const directory = fanDirectoryRow(rows);
  if (!directory) return null;
  const sources = rows.filter(row => row.sourceKey === 'monitor' && row.accountId === directory.accountId
    && ['users', 'queue', 'followingUsers'].includes(row.sourcePath?.[1]));
  const ids = new Set(sources.flatMap(row => fanIds(row.payload)));
  const ownerClaims = new Set(sources.flatMap(row => fanOwnerClaims(row.payload)));
  const ownerConflict = ownerClaims.size > 1 || directory.accountId !== 'unassigned' && [...ownerClaims].some(owner => owner !== directory.accountId);
  const identityConflict = ownerConflict || ids.size > 1 || sources.some(row => row.payload?.status === 'identity_mismatch' || row.payload?.legacyHandleIdentityConflict);
  const id = ids.size === 1 ? [...ids][0] : '';
  const receipt = !identityConflict && sources.map(row => confirmedFanRemoval(row.payload || {}, row.accountId, id)).find(Boolean);
  const review = directory.payload.fanReview;
  const workflow = review?.state || review?.workflow;
  const removalClaim = directory.payload.fanCategory === 'removed' || workflow === 'removed';
  let category = directory.payload.fanCategory;
  if(removalClaim&&!receipt&&category==='removed')category='unknown';
  if(!identityConflict&&directory.payload.relationshipKnown&&directory.payload.relationship?.following===false&&directory.payload.relationship?.followedBy===false)category='none';
  // Current relationship facts take precedence over historical workflow labels.
  // A confirmed removal remains an audit record in its separate category.
  if (category !== 'none' && directory.payload.relationshipKnown && directory.payload.relationship?.following !== true
    && ((removalClaim && !receipt) || ['review', 'initial', 'failed'].includes(workflow))) category = 'review';
  if (receipt && directory.payload.relationship?.following !== true && directory.payload.relationship?.followedBy !== true) category = 'removed';
  if (identityConflict) category = 'unknown';
  if(!identityConflict&&directory.payload.relationship?.following===false&&directory.payload.relationship?.followedBy===true
    &&needsFanEnrichment(review))category='unknown';
  if (identityConflict) {
    // A handle can be reassigned. Do not borrow a biography, grant or AI decision from the other ID.
    const primary = sources.find(row => row.userKey === directory.sourceUserKey) || sources[0];
    for (const key of ['id','rest_id','restId','targetUserId','bio','name','avatarUrl','followersText','followingText','fanGrant','fanReview']) {
      if (Object.hasOwn(primary.payload, key)) directory.payload[key] = clone(primary.payload[key]);
      else delete directory.payload[key];
    }
    directory.payload.legacyHandleIdentityConflict = true;
    directory.payload.relationship = {following:null,followedBy:null};
    directory.payload.relationshipKnown = false;
    directory.payload.fanRelationshipReason = '同名账号的用户 ID 不一致，需要重新核实';
    directory.view = directory.payload.relationship;
  }
  directory.payload.fanCategory = category;
  directory.payload.status = category === 'pending' ? 'pending' : ['mutual','following'].includes(category) ? 'followed' : category;
  directory.status = directory.payload.status;
  directory.tabs = category === 'none' ? ['none'] : ['all', category,...(!identityConflict&&directory.payload.relationshipKnown
    &&directory.payload.relationship?.following===false&&directory.payload.relationship?.followedBy===true?['outstanding']:[])];
  if (removalClaim && !receipt) directory.payload.fanRelationshipReason = '历史移除标记缺少确认回执，等待审核';
  return directory;
}

function reviewDirectoryRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.sourceKey !== 'monitor' || !row.handle) continue;
    const key = `${row.accountId}\0${row.handle}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(reviewDirectoryRow).filter(Boolean);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function encodePath(path) {
  return path.map(part => encodeURIComponent(String(part))).join('/');
}

function encodeCursor(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeCursor(cursor) {
  try {
    const binary = atob(String(cursor).replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || payload.v !== 1 || typeof payload.sortKey !== 'string' || typeof payload.userKey !== 'string') throw new Error('bad');
    return payload;
  } catch {
    const error = new Error('cursor is invalid');
    error.name = 'RecordCursorInvalidError';
    throw error;
  }
}

function invertText(value) {
  const text = String(value || '');
  let out = '';
  for (const char of text) out += String.fromCharCode(0xffff - char.charCodeAt(0));
  return out;
}

function handleOf(payload) {
  return String(payload?.handle || '').toLowerCase();
}

function externalIdOf(payload) {
  const id = payload?.tweetId ?? payload?.id;
  if (id == null || id === '') return undefined;
  return String(id);
}

function sourceKeyOf(path) {
  return path?.[0] || '';
}

function isFollowBack(payload, path) {
  return path?.[1] === 'queue' && (payload?.relationship?.followedBy === true || (payload?.state === 'follow_back' && payload?.relationship?.followedBy !== false))
    && !['followed','identity_mismatch','no_longer_following'].includes(payload?.status)
    && payload?.state !== 'following' && payload?.relationship?.following !== true;
}

function isFollowingFan(payload, path) {
  return path?.[1] === 'users' && (payload?.state === 'following' || payload?.status === 'followed');
}

function tabsFor(moduleName, payload, path, index) {
  if (moduleName === 'fans') {
    const tabs = ['all'];
    if (isFollowBack(payload, path)) tabs.push('followBack');
    if (isFollowingFan(payload, path)) tabs.push('following');
    if (path?.[0] === 'monitor' && path?.[1] === 'users') tabs.push('archive');
    if (isFollowBack(payload, path) && payload?.status === 'pending') tabs.push('pendingQueue');
    return tabs;
  }
  if (moduleName === 'mutual') return ['all', mutualUserCategory(applyRelationshipSnapshot(payload, index))];
  if (moduleName === 'comments') {
    const tabs = ['all'];
    if (commentRelationshipLabel(payload, index) !== '互相关注') tabs.push('notMutual');
    return tabs;
  }
  if (moduleName === 'unreciprocated') {
    if (payload?.status === 'unfollowed') return ['unfollowed'];
    const tabs = ['all', payload?.status || 'unknown'];
    if (payload?.status === 'pending' || payload?.status === 'overdue') tabs.push('unreciprocated');
    return tabs;
  }
  return ['all'];
}

function sortKeyFor(moduleName, payload, path, index) {
  const handle = handleOf(payload) || encodePath(path || []);
  const leaf = path?.[path.length - 1];
  const tie = String(Number.isInteger(leaf) ? leaf : 0).padStart(8, '0');
  const dated = value => value ? `0|${invertText(value)}|${tie}|${handle}` : `1|${tie}|${handle}`;
  if (moduleName === 'comments') return dated(payload?.lastSeenAt);
  if (moduleName === 'fans') return dated(payload?.discoveredAt);
  if (moduleName === 'logs') return dated(payload?.at);
  if (moduleName === 'unreciprocated') {
    if (payload?.status === 'unfollowed') {
      const at = Date.parse(payload.unfollowedAt);
      return `0|${String(Number.isFinite(at) ? 999999999999999 - at : 999999999999999).padStart(15, '0')}|${tie}|${handle}`;
    }
    const followedAt = Date.parse(payload?.followedAt);
    return `${Number.isFinite(followedAt) ? '0' : '1'}|${Number.isFinite(followedAt) ? String(followedAt).padStart(15, '0') : '999999999999999'}|${tie}|${handle}`;
  }
  if (moduleName === 'mutual') {
    const view = applyRelationshipSnapshot(payload, index);
    const rank = RELATION_RANK[personalRelationshipLabel(view)] ?? 5;
    return `${rank}|${String(payload?.name || payload?.handle || '')}|${tie}|${handle}`;
  }
  const identity = payload?.tweetId || payload?.id || handle;
  return `${encodePath(path || [])}|${tie}|${identity}`;
}

function collectRows(snapshot) {
  const rows = [];
  function visit(value, path) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, path.concat(index)));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const business = path.length > 0 ? moduleForPath(path) : '';
    if (BUSINESS.has(business)) {
      const accountId = typeof value.accountId === 'string' && value.accountId.trim() ? value.accountId : 'unassigned';
      rows.push({
        accountId,
        module: business,
        sourcePath: path.slice(),
        payload: clone(value)
      });
    }
    for (const key of Object.keys(value)) visit(value[key], path.concat(key));
  }
  visit(snapshot, []);
  return rows;
}

function relationRecords(snapshot) {
  const index = buildRelationshipIndex(snapshot.monitor || {});
  const records = new Map();
  function add(handle, patch) {
    const key = String(handle || '').toLowerCase();
    if (!key) return;
    const current = records.get(key) || {handle: key, follower: false, following: false, queued: false};
    records.set(key, {...current, ...patch, handle: key});
  }
  for (const handle of index.followers) add(handle, {follower: true});
  for (const handle of index.following) add(handle, {following: true});
  for (const [handle, status] of index.queueStatus) add(handle, {queued: true, queueStatus: status});
  let notMutual = 0;
  const notMutualHandles = new Set();
  for (const user of snapshot.monitor?.followingUsers || []) {
    const key = handleOf(user);
    if (!key) continue;
    const followedBy = user.relationship?.followedBy;
    if (followedBy === false || (followedBy !== true && !index.followers.has(key))) {
      notMutualHandles.add(key);
      add(key, {notMutual: true});
    }
  }
  for (const user of snapshot.monitor?.users || []) {
    const key = handleOf(user);
    if (!key || notMutualHandles.has(key)) continue;
    if (user.relationship?.following === true && user.relationship?.followedBy === false) {
      notMutualHandles.add(key);
      add(key, {notMutual: true});
    }
  }
  for (const user of snapshot.mutualNetwork?.users || []) {
    const key = handleOf(user);
    if (!key || notMutualHandles.has(key)) continue;
    if (user.relationship?.following === true && (user.relationship?.followedBy === false || (!user.relationship?.followedBy && !index.followers.has(key)))) {
      notMutualHandles.add(key);
      add(key, {notMutual: true});
    }
  }
  notMutual = notMutualHandles.size;
  for (const record of records.values()) {
    const user = {handle: record.handle, relationship: {following: record.following, followedBy: record.follower}};
    record.label = record.following && record.follower ? '互相关注' : commentRelationshipLabel(user, index);
    record.mutualLabel = personalRelationshipLabel(user);
    record.rank = RELATION_RANK[record.mutualLabel] ?? 5;
    record.category = mutualUserCategory(user);
  }
  const followBack = (snapshot.monitor?.queue || []).filter(isFollowBackRow).length;
  const following = (snapshot.monitor?.users || []).filter(user => user?.state === 'following' || user?.status === 'followed' || user?.relationship?.following === true).length;
  return {
    records: [...records.values()],
    summary: {
      accountId: 'unassigned',
      module: 'relations',
      tabs: {following, followBack, notMutual, followers: index.followers.size},
      total: records.size
    }
  };
}

function isFollowBackRow(payload) {
  return payload?.relationship?.followedBy === true && payload?.status !== 'followed'
    && payload?.status !== 'identity_mismatch' && payload?.status !== 'no_longer_following'
    && payload?.state !== 'following' && payload?.relationship?.following !== true;
}

function derivedRows(snapshot, index) {
  const rows = [];
  deriveNotMutualUsers(snapshot).forEach((entry, position) => {
    rows.push({
      accountId: 'unassigned',
      module: 'fans',
      sourcePath: entry.sourcePath,
      sourceKey: 'derived:notMutual',
      userKey: `not-mutual/${entry.handle}`,
      payload: clone(entry.payload),
      tabs: ['notMutual'],
      sortKey: `${String(position).padStart(6, '0')}|${entry.handle}`
    });
  });
  for (const entry of deriveTrackerUsers(snapshot)) {
    if (!entry.derived) continue;
    const status = entry.payload.status || 'pending';
    rows.push({
      accountId: 'unassigned',
      module: 'unreciprocated',
      sourcePath: entry.sourcePath,
      sourceKey: 'derived:tracker',
      userKey: `derived-tracker/${entry.handle}`,
      payload: clone(entry.payload),
      tabs: ['all', status],
      sortKey: sortKeyFor('unreciprocated', entry.payload, entry.sourcePath, index)
    });
  }
  return rows;
}

function sourceIndex(row) {
  const leaf = row.sourcePath?.[row.sourcePath.length - 1];
  return Number.isInteger(leaf) ? leaf : Number.MAX_SAFE_INTEGER;
}

function descendingDate(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

function compareProjectionRows(moduleName, a, b) {
  const handleOrder = () => String(a.handle || '').localeCompare(String(b.handle || ''));
  const stable = () => sourceIndex(a) - sourceIndex(b) || handleOrder();
  if (moduleName === 'fans') return descendingDate(a.payload?.discoveredAt, b.payload?.discoveredAt) || stable();
  if (moduleName === 'comments') return descendingDate(a.payload?.lastSeenAt, b.payload?.lastSeenAt) || stable();
  if (moduleName === 'unreciprocated') {
    const date = row => Date.parse(row.payload?.followedAt) || Number.POSITIVE_INFINITY;
    return date(a) - date(b)
      || handleOrder();
  }
  if (moduleName === 'mutual') {
    const rank = row => RELATION_RANK[personalRelationshipLabel({relationship: row.view || row.payload?.relationship})] ?? 5;
    const name = row => String(row.payload?.name || row.payload?.handle || '');
    return rank(a) - rank(b) || name(a).localeCompare(name(b)) || handleOrder();
  }
  return String(a.userKey).localeCompare(String(b.userKey));
}

function assignPanelOrder(grouped) {
  const byModule = new Map();
  for (const rows of grouped.values()) {
    for (const row of rows) {
      if (!byModule.has(row.module)) byModule.set(row.module, []);
      byModule.get(row.module).push(row);
    }
  }
  for (const [moduleName, rows] of byModule) {
    rows.sort((a, b) => compareProjectionRows(moduleName, a, b));
    rows.forEach((row, index) => {
      row.sortKey = `${String(index).padStart(8, '0')}|${row.userKey}`;
    });
  }
}

function buildProjectionRows(snapshot) {
  const index = buildRelationshipIndex(snapshot.monitor || {});
  const relations = relationRecords(snapshot);
  const grouped = new Map();
  for (const row of collectRows(snapshot)) {
    const tabs = tabsFor(row.module, row.payload, row.sourcePath, index);
    const sortKey = sortKeyFor(row.module, row.payload, row.sourcePath, index);
    const userKey = encodePath(row.sourcePath);
    const stored = {
      accountId: row.accountId,
      module: row.module,
      userKey,
      sortKey,
      tabs,
      tab: tabs[0],
      handle: handleOf(row.payload),
      status: typeof row.payload?.status === 'string' ? row.payload.status : '',
      sourceKey: sourceKeyOf(row.sourcePath),
      sourcePath: row.sourcePath,
      ...(externalIdOf(row.payload) ? {externalId: externalIdOf(row.payload)} : {}),
      payload: row.payload,
      view: row.module === 'mutual' || row.module === 'comments'
        ? applyRelationshipSnapshot(row.payload, index).relationship
        : null
    };
    const bucket = `${row.accountId}\n${row.module}\n${stored.sourceKey}`;
    if (!grouped.has(bucket)) grouped.set(bucket, []);
    grouped.get(bucket).push(stored);
  }
  for (const extra of derivedRows(snapshot, index)) {
    const stored = {
      ...extra,
      tab: extra.tabs[0],
      handle: handleOf(extra.payload),
      status: typeof extra.payload?.status === 'string' ? extra.payload.status : ''
    };
    const bucket = `unassigned\n${extra.module}\n${extra.sourceKey}`;
    if (!grouped.has(bucket)) grouped.set(bucket, []);
    grouped.get(bucket).push(stored);
  }
  return {grouped, relations};
}

function locatedPath(root, sourcePath, handle) {
  if (!Array.isArray(sourcePath) || sourcePath.length < 2) return sourcePath;
  const parent = parentOf(root, sourcePath);
  const leaf = sourcePath[sourcePath.length - 1];
  const current = parent?.[leaf];
  const found = String(current?.handle || '').toLowerCase();
  if (!handle || found === handle) return sourcePath;
  if (!Array.isArray(parent)) throw new Error('stored record handle does not match its path');
  const index = parent.findIndex(user => String(user?.handle || '').toLowerCase() === handle);
  if (index < 0) throw new Error('stored record handle was not found');
  return sourcePath.slice(0, -1).concat(index);
}

function summaryFor(accountId, moduleName, rows) {
  const tabs = {};
  for (const row of rows) {
    for (const tab of row.tabs) tabs[tab] = (tabs[tab] || 0) + 1;
  }
  return {accountId, module: moduleName, tabs, total: rows.length};
}

function membershipOf(row) {
  return (row.tabs || []).map(tab => ({
    accountId: row.accountId,
    module: row.module,
    tab,
    userKey: row.userKey,
    sortKey: row.sortKey
  }));
}

function matches(moduleName, row, filter) {
  const payload = row.payload || {};
  if(moduleName==='fans'&&!matchesFanReviewResult(payload,filter.reviewResult||''))return false;
  if (filter.searchHandle && row.handle !== filter.searchHandle) return false;
  if (Array.isArray(filter.statuses) && filter.statuses.length && !filter.statuses.includes(payload.status || row.status)) return false;
  if (filter.dateUnknown && Number.isFinite(Date.parse(payload.followedAt))) return false;
  if (filter.dateKnown && !Number.isFinite(Date.parse(payload.followedAt))) return false;
  if (filter.availability && !matchesAccountAvailability(payload, filter.availability)) return false;
  if (filter.status && payload.status !== filter.status && row.status !== filter.status) return false;
  if (moduleName === 'mutual' && (filter.search || (filter.tags && filter.tags.length) || filter.tab)) {
    if (filter.tab && filter.tab !== 'all' && mutualUserCategory(payload) !== filter.tab) return false;
    if (filter.search || (filter.tags && filter.tags.length)) {
      const matched = filterMutualTrackingUsers([payload], filter.search || '', {}, filter.tags || []);
      if (matched.length === 0) return false;
    }
    return true;
  }
  if (!filter.search) return true;
  const keyword = String(filter.search).trim().toLowerCase();
  if (!keyword) return true;
  const replies = (payload.sources || []).flatMap(source => (source.replies || []).map(reply => reply?.text || '')).join(' ');
  const posts = (payload.posts || []).map(post => typeof post === 'string' ? post : (post?.text || '')).join(' ');
  return [row.searchText, payload.handle, payload.name, payload.bio, payload.text, payload.event, replies, posts]
    .some(value => String(value || '').toLowerCase().includes(keyword));
}

function parentOf(root, path) {
  let parent = root;
  for (const part of path.slice(1, -1)) {
    if (parent == null || typeof parent !== 'object') throw new Error('legacy path is missing');
    parent = parent[part];
  }
  return parent;
}

function mergeLegacyValue(root, sourcePath, {patch, replace, remove}) {
  const next = clone(root);
  const parent = parentOf(next, sourcePath);
  const leaf = sourcePath[sourcePath.length - 1];
  if (parent == null || typeof parent !== 'object') throw new Error('legacy path is missing');
  if (remove) {
    if (Array.isArray(parent)) {
      const index = Number(leaf);
      if (!Number.isInteger(index) || parent[index] == null) throw new Error('legacy record is missing');
      parent.splice(index, 1);
    } else {
      delete parent[leaf];
    }
    return next;
  }
  const current = parent[leaf];
  if (current == null || typeof current !== 'object') throw new Error('legacy record is missing');
  parent[leaf] = replace ? {...current, ...stripRecordMeta(replace)} : {...current, ...stripRecordMeta(patch)};
  return next;
}

function stripRecordMeta(payload) {
  const clean = {...(payload || {})};
  delete clean.__userKey;
  delete clean.__expectedHandle;
  delete clean.__sourceBucket;
  delete clean.__sourceKey;
  return clean;
}

function upsertByHandle(list, payload) {
  const clean = stripRecordMeta(payload);
  const handle = handleOf(clean);
  const next = [...(list || [])];
  const index = handle ? next.findIndex(item => String(item?.handle || '').toLowerCase() === handle) : -1;
  if (index >= 0) next[index] = {...next[index], ...clean};
  else next.push(clean);
  return next;
}

function appendLegacyValue(root, moduleName, record) {
  const next = clone(root || {});
  const payload = stripRecordMeta(record.payload);
  if (moduleName === 'comments' || moduleName === 'fans' || moduleName === 'mutual' || moduleName === 'unreciprocated') {
    next.users = upsertByHandle(next.users, payload);
  } else if (moduleName === 'posts') {
    next.posts = upsertByHandle(next.posts, payload);
  } else if (moduleName === 'profiles') {
    const handle = handleOf(payload);
    if (!handle) throw new Error('profile handle is required');
    next[handle] = {...(next[handle] && typeof next[handle] === 'object' ? next[handle] : {}), ...payload};
  } else if (Array.isArray(next)) {
    return [...next, payload];
  } else {
    throw new Error('new records in this module need a source path');
  }
  return next;
}

export function createRecordRuntime({
  storage,
  durableGet,
  durableSet,
  durableKeys,
  durableGetStrict,
  durableKeysStrict,
  durableAppendIncremental,
  durableCompactSnapshots,
  onBackupSettingsChanged,
  readUnfollowLogs,
  indexedDB: indexedDBImpl,
  IDBKeyRange: keyRangeImpl,
  dbName = 'x-each-follower-records',
  queue,
  now = () => Date.now(),
  hooks = {},
  extensionOrigin = ''
} = {}) {
  if (!storage?.local?.get || !storage.local.set) throw new Error('storage.local get and set are required');
  if (typeof durableGet !== 'function' || typeof durableSet !== 'function') throw new Error('durable backup access is required');
  // Recovery must see storage failures. Forgiving durableGet/durableKeys stay available for best-effort callers.
  const readRecovery = typeof durableGetStrict === 'function' ? durableGetStrict : durableGet;
  const listRecovery = typeof durableKeysStrict === 'function' ? durableKeysStrict : durableKeys;
  const indexed = indexedDBImpl || globalThis.indexedDB;
  const keyRange = keyRangeImpl || globalThis.IDBKeyRange;
  const repository = createRecordRepository({indexedDB: indexed, IDBKeyRange: keyRange, dbName, now});
  const projection = createRecordProjection({indexedDB: indexed, IDBKeyRange: keyRange, dbName: `${dbName}-dashboard`, now});
  const writes = queue || createStorageWriteQueue();
  let migrationApi = null;
  let run = null;
  let absorbOpen = false;
  let opened = false;
  const cancels = new Set();
  const progress = {
    stage: 'idle', completed: 0, total: 0, migrationId: null, fingerprint: null, error: null, cutover: false
  };
  // Diagnostic-only state: never used as a recovery cursor or to skip a journal entry.
  let replayTrace = null;
  function beginReplayTrace(start = 1) {
    replayTrace = {startedAt: now(), finishedAt: null, completed: start - 1, total: null,
      seq: null, kind: '', module: '', step: '', stepStartedAt: null, steps: {}, recent: [], error: null};
  }
  async function replayStep(step, action) {
    if (!replayTrace) return action();
    const trace = replayTrace;
    const startedAt = now();
    trace.step = step;
    trace.stepStartedAt = startedAt;
    let failed = false;
    try { return await action(); }
    catch (error) { failed = true; trace.error = String(error?.message || error); throw error; }
    finally {
      const ms = Math.max(0, now() - startedAt);
      const stats = trace.steps[step] ||= {count: 0, totalMs: 0, maxMs: 0, lastMs: 0};
      stats.count++; stats.totalMs += ms; stats.maxMs = Math.max(stats.maxMs, ms); stats.lastMs = ms;
      trace.recent.push({seq: trace.seq, step, ms, failed});
      if (trace.recent.length > 12) trace.recent.shift();
      if (!failed) { trace.step = ''; trace.stepStartedAt = null; }
    }
  }

  function migration() {
    migrationApi ??= createRecordMigration({
      repository: {
        ...repository,
        async saveCheckpoint(args) {
          const saved = await repository.saveCheckpoint(args);
          if (!progress.total || saved.nextIndex > progress.total) throw new Error('migration progress is ahead of the import total');
          progress.completed = saved.nextIndex;
          progress.stage = 'importing';
          await projection.writeState(publicProgress());
          if (hooks.onCheckpoint) await hooks.onCheckpoint({...saved, completed: progress.completed, total: progress.total});
          return saved;
        }
      }
    });
    return migrationApi;
  }

  function publicProgress() {
    const result = clone(progress);
    // Persisted snapshots may belong to a stopped worker. Only this worker's
    // live trace can claim that an operation is currently running.
    delete result.replay;
    if (replayTrace) result.replay = {...clone(replayTrace),
      elapsedMs: Math.max(0, (replayTrace.finishedAt ?? now()) - replayTrace.startedAt),
      stepElapsedMs: replayTrace.stepStartedAt == null ? 0 : Math.max(0, (replayTrace.finishedAt ?? now()) - replayTrace.stepStartedAt)};
    return result;
  }

  async function discoverBaseline() {
    let localSnapshot = {};
    let localFlatCount = 0;
    let localReadError = null;
    try {
      localSnapshot = await readLegacy(LEGACY_RECORD_KEYS);
      localFlatCount = (await flattenLegacySnapshot(localSnapshot)).records.length;
    } catch (err) {
      localReadError = err;
    }

    if (localFlatCount > 0) {
      const fingerprint = await hashCanonical(localSnapshot);
      return {
        sourceType: 'local',
        snapshot: localSnapshot,
        fingerprint,
        total: localFlatCount
      };
    }

    try {
      let v2Keys = [];
      if (typeof listRecovery === 'function') {
        v2Keys = await listRecovery(BACKUP_PREFIX);
      }
      const candidates = [];
      for (const key of v2Keys) {
        const item = await readRecovery(key);
        if (item?.version != null && item.version !== 2) {
          throw new Error('不支持的持久化快照版本，已停止恢复');
        }
        if (item && item.fingerprint && key.endsWith(item.fingerprint) && item.snapshot) {
          const calculated = await hashCanonical(item.snapshot);
          if (calculated === item.fingerprint) {
            candidates.push(item);
          }
        }
      }

      if (candidates.length > 0) {
        const nonEmpty = [];
        for (const cand of candidates) {
          const flat = await flattenLegacySnapshot(cand.snapshot);
          if (flat.records.length > 0) {
            nonEmpty.push({...cand, total: flat.records.length});
          }
        }
        if (nonEmpty.length > 0) {
          nonEmpty.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
          const best = nonEmpty[0];
          return {
            sourceType: 'durable-v2',
            snapshot: clone(best.snapshot),
            fingerprint: best.fingerprint,
            savedAt: best.savedAt,
            total: best.total
          };
        }
      } else if (v2Keys.length > 0) {
        const err = new Error('持久化快照数据损坏（指纹或内容校验失败），拒绝作为空基线恢复');
        err.name = 'BaselineRecoveryAccessError';
        throw err;
      }

      let v1Keys = [];
      if (typeof listRecovery === 'function') {
        const allBackupKeys = await listRecovery('recordLegacySnapshotBackup:');
        v1Keys = allBackupKeys.filter(k => !k.startsWith(BACKUP_PREFIX));
        // The original format used an unversioned fingerprint suffix. A future
        // versioned namespace is not an old-format snapshot we can interpret.
        if (v1Keys.some(key => key.slice('recordLegacySnapshotBackup:'.length).includes(':'))) {
          throw new Error('不支持的持久化快照版本，已停止恢复');
        }
      }
      const v1Candidates = [];
      for (const key of v1Keys) {
        const item = await readRecovery(key);
        if (item?.version != null && item.version !== 1) {
          throw new Error('不支持的持久化快照版本，已停止恢复');
        }
        if (item && item.fingerprint && item.snapshot) {
          const calculated = await hashCanonical(item.snapshot);
          if (calculated === item.fingerprint) {
            v1Candidates.push(item);
          }
        }
      }
      if (v1Candidates.length > 0) {
        const nonEmpty = [];
        for (const cand of v1Candidates) {
          const flat = await flattenLegacySnapshot(cand.snapshot);
          if (flat.records.length > 0) {
            nonEmpty.push({...cand, total: flat.records.length});
          }
        }
        if (nonEmpty.length > 0) {
          nonEmpty.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
          const best = nonEmpty[0];
          return {
            sourceType: 'durable-v1',
            snapshot: clone(best.snapshot),
            fingerprint: best.fingerprint,
            savedAt: best.savedAt,
            total: best.total
          };
        }
      } else if (v1Keys.length > 0) {
        throw new Error('持久化快照数据损坏（指纹或内容校验失败），拒绝作为空基线恢复');
      }

      const durableSnapshot = {};
      for (const key of LEGACY_RECORD_KEYS) {
        const val = await readRecovery(key);
        if (val !== undefined && val !== null) durableSnapshot[key] = clone(val);
      }
      const durableFlat = await flattenLegacySnapshot(durableSnapshot);
      if (durableFlat.records.length > 0) {
        const fingerprint = await hashCanonical(durableSnapshot);
        return {
          sourceType: 'durable-legacy-keys',
          snapshot: durableSnapshot,
          fingerprint,
          total: durableFlat.records.length
        };
      }
    } catch (durableError) {
      const err = new Error(`持久化备份来源访问失败: ${durableError?.message || durableError}`);
      err.name = 'BaselineRecoveryAccessError';
      throw err;
    }

    if (localReadError) {
      const err = new Error(`本地旧存储读取失败: ${localReadError?.message || localReadError}`);
      err.name = 'BaselineRecoveryAccessError';
      throw err;
    }

    return {
      sourceType: 'empty',
      snapshot: {},
      fingerprint: await hashCanonical({}),
      total: 0
    };
  }

  async function reconcileIncrementalHead() {
    const head = (await durableGet(INCREMENTAL_HEAD)) || {seq: 0};
    let curSeq = head.seq || 0;
    let advanced = false;
    let lastOpId = head.operationId || null;
    while (true) {
      const nextSeqKey = `${INCREMENTAL_PREFIX}seq:${String(curSeq + 1).padStart(8, '0')}`;
      const nextEntry = await durableGet(nextSeqKey);
      if (!nextEntry || typeof nextEntry !== 'object') break;
      curSeq += 1;
      lastOpId = nextEntry.operationId || lastOpId;
      advanced = true;
    }
    if (advanced) {
      await durableSet(INCREMENTAL_HEAD, {seq: curSeq, operationId: lastOpId});
    }
    return curSeq;
  }

  let openRun = null, userIdUpgrade = null, userIdUpgradeComplete = false, userIdUpgradeResult = null;
  async function ensureOpen() {
    if (!opened) {
      openRun ||= openRecords().finally(() => { openRun = null; });
      await openRun;
    }
    if (progress.cutover) { await upgradeReplyUserIds(); await upgradeUnfollowHistory(); }
  }

  let historyUpgrade=null,historyReady=false;
  async function upgradeUnfollowHistory() {
    if(historyReady)return;
    if(!historyUpgrade)historyUpgrade=sequenceMutation(async()=>{
      while(await retryPending(100)===100){ /* finish interrupted upgrade journals before advancing the log cursor */ }
      const checkpoint=await projection.readState(),meta=checkpoint.metadata?.unreciprocatedTracker||{};
      const saved=readUnfollowLogs?await storage.local.get(['followQueueBinding']):{};
      const binding=saved.followQueueBinding||{};
      const owner=checkpoint.fanReviewLegacyOwnerAccountId||meta.unfollowHistoryLegacyOwner||(binding.activated?binding.accountId:'')||'unassigned';
      let history={...(meta.unfollowHistory||{})},cursor=null;
      const startedAt=new Date(now()).toISOString();
      if(readUnfollowLogs)do{
        const page=await readUnfollowLogs({cursor,since:meta.unfollowHistoryUpgrade?.since||null});
        history=mergeUnfollowHistory(history,(page.entries||[]).flatMap(log=>unfollowLogReceipts(log,{accountId:owner,handle:binding.handle})));
        cursor=page.nextCursor;
      }while(cursor);
      for(const sourceKey of ['unreciprocatedTracker','derived:tracker']){
        cursor=null;do{
          const page=await projection.scanBySource({sourceKey,limit:100,cursor});
          for(const row of page.records){const p=row.payload||{},at=Date.parse(p.unfollowedAt||'');
            if(p.status==='unfollowed'&&Number.isFinite(at))history=mergeUnfollowHistory(history,[{accountId:row.accountId==='unassigned'?owner:row.accountId,
              handle:row.handle,targetUserId:p.id||'',name:p.name||row.handle,at,source:'stored-outcome'}]);
          }cursor=page.nextCursor;
        }while(cursor);
      }
      if(readUnfollowLogs||Object.keys(history).length)await mergeRootBody('unreciprocatedTracker',{unfollowHistory:history,
        unfollowHistoryLegacyOwner:owner,
        unfollowHistoryUpgrade:{version:1,since:startedAt,at:now(),count:Object.keys(history).length}});
      historyReady=true;
    }).finally(()=>{historyUpgrade=null;});
    return historyUpgrade;
  }
  async function historicalUnfollows(accountId) {
    const state=await projection.readState();
    return unfollowHistoryRows(state.metadata?.unreciprocatedTracker?.unfollowHistory||{},accountId,state.fanReviewLegacyOwnerAccountId||state.metadata?.unreciprocatedTracker?.unfollowHistoryLegacyOwner);
  }

  // Runs on the first ready access after an extension upgrade, before readers
  // or schedulers receive records. Use the existing journal, not a CDP repair.
  async function upgradeReplyUserIds() {
    if (userIdUpgradeComplete) return;
    if (!userIdUpgrade) userIdUpgrade = sequenceMutation(async () => {
      const checkpoint = await projection.readState();
      if (checkpoint.replyUserIdRepair?.version === REPLY_USER_ID_REPAIR_VERSION && checkpoint.replyUserIdRepair.status === 'done') {
        userIdUpgradeResult = checkpoint.replyUserIdRepair;
        userIdUpgradeComplete = true; return;
      }
      while (await retryPending(100) === 100) { /* recover interrupted journal writes */ }
      const saved = await storage.local.get(['followQueueBinding']);
      const binding = saved.followQueueBinding;
      const legacyOwner = checkpoint.fanReviewLegacyOwnerAccountId || (binding?.activated ? binding.accountId : '');
      const seeds = [];
      let cursor = null;
      do {
        const page = await projection.scanBySource({sourceKey:'commentTracking',limit:100,cursor});
        seeds.push(...page.records.filter(row => replyIdEvidence(row).length));
        cursor = page.nextCursor;
      } while (cursor);
      const plans = [], seen = new Set();
      for (const seed of seeds) {
        const plan = planReplyUserIdRepair(seed, await projection.rowsByHandleKey(seed.handle), legacyOwner);
        if (!plan || seen.has(plan.owner + ':' + plan.handle)) continue;
        seen.add(plan.owner + ':' + plan.handle); plans.push(plan);
      }
      let records = 0;
      for (const plan of plans) for (const {row,patch} of plan.changes) {
        await applyMutation('patch', {module:row.module,accountId:row.accountId,userKey:row.userKey,expectedHandle:row.handle,
          patch:{...patch,accountId:row.accountId,userIdRepair:{version:REPLY_USER_ID_REPAIR_VERSION,previousIds:plan.previousIds,replacementId:plan.replacementId,at:now()}},
          operationId:`reply-user-id-v1:${row.accountId}:${row.module}:${row.userKey}`});
        records++;
      }
      // Re-read after record writes; never overwrite a ledger captured before IO.
      const ledger = (await storage.local.get(['autoUnfollowState'])).autoUnfollowState;
      const repaired = repairAutoUnfollowLedger(ledger, plans, now());
      if (repaired.changed) await storage.local.set({autoUnfollowState:repaired.ledger});
      userIdUpgradeResult = {version:REPLY_USER_ID_REPAIR_VERSION,status:'done',at:now(),handles:plans.length,records,reviews:repaired.changed};
      await projection.writeState({replyUserIdRepair:userIdUpgradeResult});
      userIdUpgradeComplete = true;
    }).finally(() => { userIdUpgrade = null; });
    return userIdUpgrade;
  }

  async function openRecords() {
    if (opened) return;
    const state = await projection.readState();
    if (state.cutover) {
      if (state.total === 0 || !state.total) {
        let hasExternalData = false;
        let baselineError = null;
        try {
          const baseline = await discoverBaseline();
          if (baseline.sourceType !== 'empty' && baseline.total > 0) {
            hasExternalData = true;
          }
        } catch (err) {
          baselineError = err;
        }
        if (hasExternalData || baselineError) {
          Object.assign(progress, {
            stage: 'repair-required',
            completed: 0,
            total: 0,
            error: baselineError ? `基线核对访问异常，暂停就绪以防丢失: ${baselineError.message}` : '检测到历史完整快照未恢复，需从持久快照重建',
            cutover: false
          });
          await projection.writeState(publicProgress());
          opened = true;
          return;
        }
      }
      Object.assign(progress, {
        stage: 'ready',
        completed: state.completed,
        total: state.total,
        migrationId: state.migrationId,
        fingerprint: state.fingerprint,
        error: null,
        cutover: true
      });
    } else if (state.stage && state.stage !== 'idle') {
      Object.assign(progress, state);
    }
    opened = true;
    if (progress.cutover) {
      await retryPending(20);
    }
  }

  async function readLegacy(keys) {
    if (!Array.isArray(keys) || keys.length === 0 || keys.some(key => typeof key !== 'string')) throw new Error('legacy reads must name keys');
    const stored = await storage.local.get(keys);
    const snapshot = {};
    for (const key of keys) {
      if (stored && Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== undefined) snapshot[key] = clone(stored[key]);
    }
    return snapshot;
  }

  async function preserveBackup(snapshot, fingerprint) {
    const key = `${BACKUP_PREFIX}${fingerprint}`;
    const existing = await durableGet(key);
    if (existing?.snapshot != null && existing.fingerprint === fingerprint) {
      if (await hashCanonical(existing.snapshot) === fingerprint) return;
      throw new Error('durable legacy backup does not match its fingerprint');
    }
    if (existing != null) throw new Error('durable legacy backup already exists');
    await durableSet(key, {fingerprint, snapshot: clone(snapshot), savedAt: now(), immutable: true});
    const stored = await durableGet(key);
    if (!stored?.snapshot || await hashCanonical(stored.snapshot) !== fingerprint) throw new Error('durable legacy backup was not stored completely');
  }

  async function publishProjection(snapshot) {
    const built = buildProjectionRows(snapshot);
    const byModule = new Map();
    for (const rows of built.grouped.values()) {
      for (const row of rows) {
        const key = `${row.accountId}\n${row.module}\n${row.sourceKey}`;
        if (!byModule.has(key)) byModule.set(key, []);
        byModule.get(key).push(row);
      }
    }
    for (const rows of byModule.values()) {
      const first = rows[0];
      await projection.replaceModuleRows(first.accountId, first.module, first.sourceKey, {
        rows,
        membership: rows.flatMap(membershipOf),
        summary: summaryFor(first.accountId, first.module, rows)
      });
    }
    await projection.putRelations(built.relations.records, built.relations.summary);
    await projection.writeState({fanDirectoryVersion:0,fanDirectoryDirtyHandles:[]});
    const metadata = {};
    for (const key of ['monitor', 'mutualNetwork', 'commentTracking', 'unreciprocatedTracker']) metadata[key] = scalarRoot(snapshot[key]);
    await bumpRevision({metadata});
  }

  function scalarRoot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const fields = {};
    for (const [name, field] of Object.entries(value)) {
      if (Array.isArray(field) || (field && typeof field === 'object')) continue;
      fields[name] = field;
    }
    return fields;
  }

  async function bumpRevision(extra = {}) {
    const state = await projection.readState();
    const metadata = extra.metadata ? {...(state.metadata || {}), ...extra.metadata} : state.metadata;
    await projection.writeState({revision: (state.revision || 0) + 1, ...(metadata ? {metadata} : {})});
  }

  // Full legacy absorb is migration-only. After cutover it would rebuild from a stale
  // snapshot and resurrect rows that incremental writes already changed or deleted.
  async function absorbKey(key) {
    if (progress.cutover && !absorbOpen) return;
    const related = ['monitor', 'mutualNetwork', 'commentTracking', 'unreciprocatedTracker'].includes(key)
      ? ['monitor', 'mutualNetwork', 'commentTracking', 'unreciprocatedTracker']
      : [key];
    const snapshot = await readLegacy(related);
    const built = buildProjectionRows(snapshot);
    await projection.clearSource(key);
    const derived = new Set();
    if (key === 'monitor' || key === 'mutualNetwork') derived.add('derived:notMutual');
    if (related.length > 1) derived.add('derived:tracker');
    for (const sourceKey of derived) await projection.clearSource(sourceKey);
    const allowed = new Set([key, ...derived]);
    if (key === 'monitor') {
      allowed.add('mutualNetwork');
      allowed.add('commentTracking');
    }
    const replaced = new Set();
    for (const rows of built.grouped.values()) {
      if (!rows.length || !allowed.has(rows[0].sourceKey)) continue;
      const first = rows[0];
      replaced.add(`${first.module}\n${first.sourceKey}`);
      await projection.replaceModuleRows(first.accountId, first.module, first.sourceKey, {
        rows,
        membership: rows.flatMap(membershipOf)
      });
    }
    const keyModules = {
      monitor: ['fans'],
      mutualNetwork: ['mutual'],
      commentTracking: ['comments', 'posts'],
      unreciprocatedTracker: ['unreciprocated'],
      profileCache: ['profiles'],
      analysisRows: ['analysis'],
      rows: ['rows'],
      autoFollowLogs: ['logs'],
      monitorLogs: ['logs'],
      unreciprocatedLogs: ['logs']
    };
    if (![...replaced].some(item => item.endsWith(`\n${key}`))) {
      for (const moduleName of keyModules[key] || []) {
        await projection.replaceModuleRows('unassigned', moduleName, key, {rows: [], membership: []});
      }
    }
    if (key === 'monitor' || key === 'mutualNetwork') {
      const relations = relationRecords(snapshot);
      await projection.putRelations(relations.records, relations.summary);
    }
    if (key === 'monitor') await projection.writeState({fanDirectoryVersion:0,fanDirectoryDirtyHandles:[]});
    await bumpRevision({metadata: {[key]: scalarRoot(snapshot[key])}});
    const state = await projection.readState();
    const live = await hashCanonical(snapshot[key] ?? null);
    const dirty = (state.dirtyKeys || []).filter(item => item !== key);
    const echoHashes = {...(state.echoHashes || {})};
    delete echoHashes[key];
    await projection.writeState({dirtyKeys: dirty, echoHashes});
    if (await hashCanonical((await readLegacy([key]))[key] ?? null) !== live) {
      await projection.writeState({dirtyKeys: [...dirty, key]});
    }
  }

  async function dirtyKeys() {
    const state = await projection.readState();
    return new Set(state.dirtyKeys || []);
  }

  async function flushDirty(moduleName) {
    if (progress.cutover) return;
    const relevant = (MODULE_KEYS[moduleName] || []).filter(key => true);
    const pending = [...await dirtyKeys()].filter(key => relevant.includes(key));
    for (const key of pending) {
      await writes.enqueue(() => absorbKey(key));
    }
  }

  async function absorbPendingDirty() {
    const pending = [...await dirtyKeys()];
    absorbOpen = true;
    try {
      for (const key of pending) await writes.enqueue(() => absorbKey(key));
    } finally {
      absorbOpen = false;
    }
    return pending;
  }

  // Fresh projection rebuilds only. A ready checkpoint skips this so warm
  // reads do not walk the incremental journal.
  async function replayIncrementalAfterRebuild() {
    beginReplayTrace();
    progress.stage = 'replaying';
    progress.cutover = false;
    progress.error = null;
    await replayStep('checkpoint', () => projection.writeState(publicProgress()));
    let cursor = null;
    for (;;) {
      const page = await replayBackups({limit: 100, cursor, deferReady: true});
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
      progress.stage = 'replaying';
      progress.cutover = false;
      progress.error = null;
      await replayStep('checkpoint', () => projection.writeState(publicProgress()));
    }
  }

  async function commitReadyProjection() {
    await absorbPendingDirty();
    await replayIncrementalAfterRebuild();
    const pending = [...await replayStep('read-dirty-keys', dirtyKeys)];
    progress.stage = 'ready';
    progress.completed = progress.total;
    progress.cutover = true;
    progress.error = null;
    await replayStep('finalize-ready', () => projection.writeState({...publicProgress(), dirtyKeys: pending}));
    if (replayTrace) replayTrace.finishedAt = now();
    return publicProgress();
  }

  async function migrate() {
    const result = await migrateArchive();
    if (progress.cutover) await upgradeReplyUserIds();
    if (progress.cutover) await upgradeUnfollowHistory();
    return result;
  }

  async function migrateArchive() {
    if (run) return run;
    run = (async () => {
      try {
        await ensureOpen();
        if (progress.cutover) {
          if (progress.total === 0 || !progress.total) {
            try {
              const baseline = await discoverBaseline();
              if (baseline.sourceType !== 'empty' && baseline.total > 0) {
                progress.cutover = false;
              }
            } catch (err) {
              progress.cutover = false;
              progress.stage = 'repair-required';
              progress.error = `基线探查异常: ${err.message}`;
              await projection.writeState(publicProgress());
              throw err;
            }
          }
        }
        if (progress.cutover) {
          await retryPending(20);
          return publicProgress();
        }
        const restored = await restoreLatestSnapshot();
        if (restored) {
          await replayIncrementalAfterRebuild();
          progress.stage = 'ready'; progress.cutover = true; progress.error = null;
          await projection.writeState(publicProgress());
          return publicProgress();
        }
        progress.stage = 'discovering';
        replayTrace = null;
        progress.cutover = false;
        progress.error = null;
        await projection.writeState(publicProgress());

        const baseline = await discoverBaseline();
        let snapshot = baseline.snapshot;

        if (baseline.total === 0 && baseline.sourceType === 'empty') {
          progress.stage = 'ready';
          progress.total = 0;
          progress.completed = 0;
          progress.cutover = true;
          progress.error = null;
          progress.fingerprint = baseline.fingerprint;
          progress.migrationId = `legacy-${baseline.fingerprint.slice(0, 32)}`;
          await projection.writeState({
            ...publicProgress(),
            metadata: {emptyBaseline: true, discoveredAt: now()}
          });
          return publicProgress();
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const fingerprint = await hashCanonical(snapshot);
          const migrationId = `legacy-${fingerprint.slice(0, 32)}`;
          const flat = await flattenLegacySnapshot(snapshot);
          progress.total = flat.records.length;
          progress.completed = 0;
          progress.migrationId = migrationId;
          progress.fingerprint = fingerprint;

          progress.stage = 'backup';
          await projection.writeState(publicProgress());
          const existing = await repository.getMigration(migrationId);
          if (existing?.status === 'active' && existing.fingerprint === fingerprint) {
            await publishProjection(snapshot);
            return await commitReadyProjection();
          }
          if (progress.total > 0) {
            await preserveBackup(snapshot, fingerprint);
          }
          progress.stage = 'snapshot-staged';
          await projection.writeState(publicProgress());
          const staged = await migration().stage(snapshot, migrationId);
          if (staged.nextIndex !== progress.total) throw new Error('migration import is incomplete');
          if (baseline.sourceType === 'local') {
            const fresh = await readLegacy(LEGACY_RECORD_KEYS);
            if (await hashCanonical(fresh) !== fingerprint) {
              const changed = [];
              for (const key of LEGACY_RECORD_KEYS) {
                if (await hashCanonical(snapshot[key] ?? null) !== await hashCanonical(fresh[key] ?? null)) changed.push(key);
              }
              const state = await projection.readState();
              await projection.writeState({dirtyKeys: [...new Set([...(state.dirtyKeys || []), ...changed])]});
              snapshot = fresh;
              continue;
            }
          }
          if (hooks.beforeVerify) await hooks.beforeVerify({repository, migrationId, snapshot, fingerprint});
          progress.stage = 'verifying';
          progress.completed = progress.total;
          await projection.writeState(publicProgress());
          const verified = await migration().verify(snapshot, migrationId);
          if (verified?.status !== 'verified' && verified?.status !== 'active') throw new Error('migration verification did not finish');
          if (baseline.sourceType === 'local') {
            const duringVerify = await readLegacy(LEGACY_RECORD_KEYS);
            const changedDuringVerify = [];
            for (const key of LEGACY_RECORD_KEYS) {
              if (await hashCanonical(snapshot[key] ?? null) !== await hashCanonical(duringVerify[key] ?? null)) changedDuringVerify.push(key);
            }
            if (changedDuringVerify.length) {
              const state = await projection.readState();
              await projection.writeState({dirtyKeys: [...new Set([...(state.dirtyKeys || []), ...changedDuringVerify])]});
            }
          }
          progress.stage = 'activating';
          const job = await migration().activate(migrationId);
          if (job.status !== 'active') throw new Error('migration did not become active');
          await publishProjection(snapshot);
          return await commitReadyProjection();
        }
        if (!progress.cutover) throw new Error('legacy source kept changing');
        return publicProgress();
      } catch (error) {
        if (replayTrace) { replayTrace.finishedAt = now(); replayTrace.error = String(error?.message || error); }
        progress.stage = error?.name === 'BaselineRecoveryAccessError' ? 'repair-required' : 'failed';
        progress.cutover = false;
        progress.error = String(error?.message || error);
        await projection.writeState(publicProgress()).catch(() => {});
        throw error;
      } finally {
        run = null;
      }
    })();
    return run;
  }

  function requireReady() {
    if (!progress.cutover) throw new Error('record migration is not ready');
  }

  function accountOf(record, explicit) {
    const owned = typeof record?.accountId === 'string' && record.accountId.trim() ? record.accountId : null;
    if (explicit && explicit !== 'unassigned' && !owned) throw new Error('missing record ownership cannot be assigned to an account');
    if (explicit && owned && explicit !== owned) throw new Error('record accountId does not match');
    return owned || 'unassigned';
  }

  let directoryBuild = null;
  async function ensureFanDirectory() {
    const checkpoint = await projection.readState();
    if (checkpoint.fanDirectoryVersion === FAN_DIRECTORY_VERSION && checkpoint.fanReviewProjectionVersion === FAN_REVIEW_PROJECTION_VERSION && !checkpoint.fanDirectoryDirtyHandles?.length) return;
    if (!directoryBuild) directoryBuild = sequenceMutation(async () => {
      const state = await projection.readState();
      if (state.fanDirectoryVersion === FAN_DIRECTORY_VERSION && state.fanReviewProjectionVersion === FAN_REVIEW_PROJECTION_VERSION) {
        for (const handle of state.fanDirectoryDirtyHandles || []) await recomputeHandle(handle);
        return;
      }
      const rows = [];
      let cursor = null;
      do {
        const page = await projection.scanBySource({sourceKey:'monitor', limit:200, cursor});
        rows.push(...page.records);
        cursor = page.nextCursor;
      } while (cursor);
      const groups = new Map();
      let previousCursor = null;
      do {
        const page = await projection.scanBySource({sourceKey:'derived:fanDirectory',limit:200,cursor:previousCursor});
        for (const row of page.records) if (!groups.has(row.accountId)) groups.set(row.accountId, []);
        previousCursor = page.nextCursor;
      } while (previousCursor);
      for (const row of reviewDirectoryRows(rows)) {
        if (!groups.has(row.accountId)) groups.set(row.accountId, []);
        groups.get(row.accountId).push(row);
      }
      // This is a derived index only. No legacy snapshot or X state is changed.
      await projection.clearSource('derived:fanDirectory');
      for (const [accountId, records] of groups) await projection.replaceModuleRows(accountId, 'fanDirectory', 'derived:fanDirectory', {
        rows:records, membership:records.flatMap(membershipOf)
      });
      await projection.writeState({fanDirectoryVersion:FAN_DIRECTORY_VERSION,fanReviewProjectionVersion:FAN_REVIEW_PROJECTION_VERSION,fanDirectoryDirtyHandles:[]});
    }).finally(() => {directoryBuild = null;});
    return directoryBuild;
  }

  function presentDirectory(row) {
    return {...present(row), module:'fans', userKey:row.sourceUserKey};
  }

  async function fanRemovalHistory(accountId) {
    const state=await projection.readState();
    const owner=accountId==='unassigned'?state.fanReviewLegacyOwnerAccountId:accountId;
    if(!owner)return [];
    const prefix='followQueueFanRemovalIntent:'+owner+':';
    const tombstone=(await storage.local.get(['followQueueRemovalTombstones:'+owner]))['followQueueRemovalTombstones:'+owner]||{};
    const keys=storage.local.getKeys?(await storage.local.getKeys()).filter(key=>key.startsWith(prefix)):Object.keys(tombstone.byId||{}).map(id=>prefix+id);
    const receipts=Object.values(await storage.local.get(keys));
    let cursor=null;
    do{const page=await projection.queryPage({accountId,module:'fanDirectory',tab:'removed',limit:100,cursor});
      for(const row of page.records){const p=row.payload||{},receipt=p.followerRemoval||p.fanReview?.removalReceipt;if(receipt)receipts.push({...receipt,handle:row.handle,accountId:receipt.accountId||owner});}cursor=page.nextCursor;
    }while(cursor);
    return removalHistoryRows(receipts,owner).map(row=>({...row,accountId}));
  }
  async function directorySummary(accountId) {
    const saved = await projection.getSummary(accountId, 'fans');
    const directory = await projection.getSummary(accountId, 'fanDirectory');
    return {...saved, tabs:{...(saved?.tabs || {}), ...Object.fromEntries(Object.entries(FAN_TABS).map(([tab, category]) => [tab,directory?.tabs?.[category] || 0])),fanRemoved:(await fanRemovalHistory(accountId)).length}};
  }

  async function query(request = {}) {
    await ensureOpen();
    requireReady();
    const moduleName = request.module;
    if (!RECORD_MODULES.includes(moduleName)) throw new Error('module is not queryable');
    const limit = request.limit == null ? 50 : request.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
    const accountId = request.accountId || 'unassigned';
    await flushDirty(moduleName);
    const filter = request.filter && typeof request.filter === 'object' ? {...request.filter} : {};
    if(moduleName==='fans'&&!FAN_REVIEW_RESULT_FILTERS.includes(filter.reviewResult||''))throw Error('无效的审核结果筛选');
    const tab = filter.tab || 'all';
    const directory = moduleName === 'fans' && Object.hasOwn(FAN_TABS, tab);
    if (directory) {
      await ensureFanDirectory();
      filter.searchHandle = exactFanSearchHandle(filter.search);
      if (filter.search) filter.search = normalizeFanSearch(filter.search);
    }
    const storedModule = directory ? 'fanDirectory' : moduleName;
    const storedTab = directory ? FAN_TABS[tab] : tab;
    const show = directory ? presentDirectory : present;
    const complex = Boolean(filter.reviewResult || filter.search || (filter.tags && filter.tags.length) || (Array.isArray(filter.statuses) && filter.statuses.length) || filter.dateUnknown || filter.dateKnown || filter.availability);
    const revision = (await projection.readState()).revision || 0;
    const filterHash = canonicalValue({module: moduleName, accountId, tab, filter});
    const parsed = request.cursor ? decodeCursor(request.cursor) : null;
    if (parsed && (parsed.accountId !== accountId || parsed.module !== moduleName || parsed.tab !== tab || parsed.complex !== complex || parsed.filterHash !== filterHash || parsed.revision !== revision)) {
      const error = new Error('cursor is invalid');
      error.name = 'RecordCursorInvalidError';
      throw error;
    }
    const stamp = cursor => cursor ? encodeCursor({
      v: 1, accountId, module: moduleName, tab, complex, filterHash, revision, sortKey: cursor.sortKey, userKey: cursor.userKey
    }) : null;
    if(directory&&tab==='fanRemoved'){
      const history=(await fanRemovalHistory(accountId)).filter(row=>!filter.search||row.searchText.includes(filter.search.toLowerCase()));
      const remaining=history.filter(row=>!parsed||row.sortKey>parsed.sortKey||row.sortKey===parsed.sortKey&&row.userKey>parsed.userKey);
      const records=remaining.slice(0,limit);
      return {records:records.map(present),nextCursor:remaining.length>limit?stamp(records.at(-1)):null,scanned:history.length,matched:history.length,revision,summary:await directorySummary(accountId)};
    }
    // Historical rows may have been indexed by followedAt in an older version.
    // Sort the history subset before pagination without rewriting source records.
    if(moduleName==='unreciprocated' && tab==='unfollowed'){
      const history=[];let cursor=null,scanned=0;
      do{
        const page=await projection.queryPage({accountId,module:moduleName,tab,limit:100,cursor});
        scanned+=page.scanned;history.push(...page.records.filter(row=>matches(moduleName,row,filter)));cursor=page.nextCursor;
      }while(cursor);
      const unique=new Map(history.map(row=>[row.handle,row]));
      for(const row of await historicalUnfollows(accountId))if(matches(moduleName,row,filter))unique.set(row.handle,row);
      history.splice(0,history.length,...unique.values());
      for(const row of history){const at=Date.parse(row.payload?.unfollowedAt);row.sortKey=String(Number.isFinite(at)?999999999999999-at:999999999999999).padStart(15,'0');}
      history.sort((a,b)=>a.sortKey.localeCompare(b.sortKey)||a.userKey.localeCompare(b.userKey));
      const remaining=history.filter(row=>!parsed||row.sortKey>parsed.sortKey||(row.sortKey===parsed.sortKey&&row.userKey>parsed.userKey));
      const records=remaining.slice(0,limit);
      return {records:records.map(present),nextCursor:remaining.length>limit?stamp(records.at(-1)):null,scanned,matched:history.length,revision};
    }
    const onStep = hooks.onCursorStep;
    if (directory && complex) {
      const token = request.cancelToken || null;
      let cursor = null, scanned = 0, matched = 0;
      const found = [];
      do {
        const batch = await projection.scanBatches({accountId,module:storedModule,tab:storedTab,limit:200,maxScan:200,cursor,
          match:row => matches(moduleName,row,filter), shouldStop:() => token != null && cancels.has(token),onStep});
        scanned += batch.scanned;
        for (const row of batch.records) {
          matched++;
          if (found.length <= limit && (!parsed || row.sortKey > parsed.sortKey || (row.sortKey === parsed.sortKey && row.userKey > parsed.userKey))) found.push(row);
        }
        cursor = batch.nextCursor;
        if (token != null && cancels.has(token)) return {records:[],nextCursor:null,scanned,cancelled:true,matched:null,revision};
      } while (cursor);
      const records = found.slice(0,limit);
      return {records:records.map(show),nextCursor:found.length > limit ? stamp(records.at(-1)) : null,scanned,matched,revision,summary:await directorySummary(accountId)};
    }
    if (!complex) {
      const page = await projection.queryPage({
        accountId,
        module: storedModule,
        tab: storedTab,
        limit,
        cursor: parsed,
        onStep
      });
      if (page.scanned > limit + 1) throw new Error('index page scanned more than one extra row');
      return {records: page.records.map(show), nextCursor: stamp(page.nextCursor), scanned: page.scanned, matched: directory ? (await projection.getSummary(accountId,'fanDirectory'))?.tabs?.[storedTab] || 0 : null, revision,
        ...(directory ? {summary:await directorySummary(accountId)} : {})};
    }
    const token = request.cancelToken || null;
    const records = [];
    let scanned = 0;
    let resume = parsed;
    let cancelled = false;
    while (records.length < limit) {
      const batch = await projection.scanBatches({
        accountId,
        module: storedModule,
        tab: storedTab,
        limit: limit - records.length,
        cursor: resume,
        maxScan: 200,
        match: row => matches(moduleName, row, filter),
        shouldStop: () => token != null && cancels.has(token),
        onStep
      });
      if (batch.scanned > 200) throw new Error('search batch exceeded 200');
      hooks.onSearchBatch?.(batch.scanned);
      records.push(...batch.records);
      scanned += batch.scanned;
      resume = batch.nextCursor;
      if (token != null && cancels.has(token)) { cancelled = true; break; }
      if (batch.done || !resume) break;
    }
    return {
      records: records.map(show),
      nextCursor: stamp(resume),
      scanned,
      cancelled,
      matched: null,
      revision
    };
  }

  async function audit() {
    await ensureOpen();
    requireReady();
    const names = ['fans', 'mutual', 'comments', 'posts', 'unreciprocated', 'profiles', 'logs', 'relations'];
    const summaries = {};
    for (const moduleName of names) summaries[moduleName] = await projection.getSummary('unassigned', moduleName);
    const state = await projection.readState();
    return {summaries, revision: state.revision || 0, fingerprint: state.fingerprint, cutover: state.cutover === true};
  }

  function present(row) {
    return {
      accountId: row.accountId,
      module: row.module,
      userKey: row.userKey,
      sortKey: row.sortKey,
      status: row.status,
      sourcePath: row.sourcePath,
      payload: clone(row.payload),
      view: row.view ? clone(row.view) : null,
      handle: row.handle
    };
  }

  async function getRecord(request = {}) {
    await ensureOpen();
    requireReady();
    await flushDirty(request.module);
    const row = await projection.getRow(request.accountId || 'unassigned', request.module, request.userKey);
    return row ? present(row) : null;
  }

  async function summary(request = {}) {
    await ensureOpen();
    requireReady();
    if (request.module) await flushDirty(request.module);
    const saved = await projection.getSummary(request.accountId || 'unassigned', request.module);
    if(request.module==='unreciprocated'){
      const handles=new Set((await historicalUnfollows(request.accountId||'unassigned')).map(row=>row.handle));
      let cursor=null;do{const page=await projection.queryPage({accountId:request.accountId||'unassigned',module:'unreciprocated',tab:'unfollowed',limit:100,cursor});
        for(const row of page.records)handles.add(row.handle);cursor=page.nextCursor;
      }while(cursor);
      return {...saved,tabs:{...saved?.tabs,unfollowed:handles.size}};
    }
    if (request.module !== 'fans') return saved;
    await ensureFanDirectory();
    return directorySummary(request.accountId || 'unassigned');
  }

  async function relations(request = {}) {
    await ensureOpen();
    requireReady();
    await flushDirty('fans');
    const handles = request.handles || [];
    if (!Array.isArray(handles) || handles.length > 100) throw new Error('relations lookup accepts at most 100 handles');
    return projection.getRelations(handles);
  }

  async function relationSummary() {
    await ensureOpen();
    requireReady();
    await flushDirty('fans');
    return projection.getSummary('unassigned', 'relations');
  }

  async function fanDirectory(request = {}) {
    await ensureOpen();
    requireReady();
    await flushDirty('fans');
    await ensureFanDirectory();
    if (!Array.isArray(request.handles) || request.handles.length > 100) throw new Error('fan directory lookup accepts at most 100 handles');
    return projection.rowsByHandle(request.accountId || 'unassigned','fanDirectory',request.handles.map(handle => String(handle).toLowerCase()));
  }

  async function fanReviewOwner() {
    await ensureOpen();requireReady();
    return (await projection.readState()).fanReviewLegacyOwnerAccountId || '';
  }

  // Called after the lossless archive migration and before any fan/queue scheduler starts.
  // The coordinator supplies one owner's history; this service never mutates the queue database.
  async function migrateFanReview(request = {}) {
    await ensureOpen();requireReady();await flushDirty('fans');
    const accountId = typeof request.accountId === 'string' ? request.accountId.trim() : '';
    if (!accountId || accountId === 'unassigned') throw new Error('fan review migration requires a confirmed owner');
    if (!Array.isArray(request.jobs || [])) throw new Error('fan review migration jobs must be an array');
    // Native queue receipts can retain optional fields such as live:undefined.
    // Archive their JSON evidence without changing the original queue records;
    // undefined cannot participate in the strict canonical journal checksum.
    const jobs = (request.jobs || []).filter(job => job?.accountId === accountId)
      .map(job => JSON.parse(JSON.stringify(job)));
    const tombstones = request.tombstones || {};
    return sequenceMutation(async () => {
      const checkpoint = await projection.readState();
      if (request.includeUnassigned === true && checkpoint.fanReviewLegacyOwnerAccountId && checkpoint.fanReviewLegacyOwnerAccountId !== accountId) {
        throw new Error('legacy fan records already belong to another owner');
      }
      if (request.includeUnassigned === true) await projection.writeState({fanReviewLegacyOwnerAccountId:accountId});
      const rows = [];let cursor = null;
      do {
        const page = await projection.scanBySource({sourceKey:'monitor',limit:200,cursor});
        rows.push(...page.records.filter(row => (row.accountId === accountId || request.includeUnassigned === true && row.accountId === 'unassigned')
          && ['users','queue','followingUsers'].includes(row.sourcePath?.[1])
          && !fanOwnerClaims(row.payload).some(owner => owner !== accountId)));
        cursor = page.nextCursor;
      } while (cursor);
      const groups = new Map();
      for (const row of rows) {
        const key = `${row.accountId}\0${row.handle}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const result = {version:3,scanned:groups.size,updated:0,review:0,removed:0,skipped:0};
      const jobsByHandle = new Map(),jobsById = new Map();
      for (const job of jobs) {
        const handle = String(job.handle || '').replace(/^@/, '').toLowerCase(),id = fanId(job.targetUserId);
        if (!jobsByHandle.has(handle)) jobsByHandle.set(handle, []);
        jobsByHandle.get(handle).push(job);
        if (id) {if (!jobsById.has(id)) jobsById.set(id, []);jobsById.get(id).push(job);}
      }
      for (const sources of groups.values()) {
        const directory = fanDirectoryRow(sources);
        if (!directory) continue;
        const handle = directory.handle,ids = new Set(sources.flatMap(row => fanIds(row.payload)));
        const id = ids.size === 1 ? [...ids][0] : '';
        const related = id ? [...new Set([...(jobsById.get(id) || []),...(jobsByHandle.get(handle) || []).filter(job => !fanId(job.targetUserId))])]
          : (jobsByHandle.get(handle) || []).filter(job => !fanId(job.targetUserId));
        const tombstone = (id && tombstones.byId?.[id]) || tombstones.byHandle?.[handle];
        const matchingTombstone = tombstone && (!tombstone.accountId || tombstone.accountId === accountId)
          && (!tombstone.targetUserId || tombstone.targetUserId === id) ? tombstone : null;
        const identityConflict = ids.size > 1 || sources.some(row => row.payload.status === 'identity_mismatch' || row.payload.legacyHandleIdentityConflict);
        const receipts = [...sources.map(row => confirmedFanRemoval(row.payload, accountId, id)),...related.map(job => confirmedFanRemoval(job, accountId, id))];
        const receipt = !identityConflict && receipts.find(Boolean);
        const removedClaim = sources.some(row => row.payload.fanReview?.state === 'removed' || row.payload.status === 'removed' || row.payload.state === 'removed_follower' || row.payload.followerRemovedAt);
        const pendingExternal = related.some(job => job.followResult?.attemptedAt && !job.followResult?.succeeded
          || job.followResult?.followerRemoval?.attemptedAt && !job.followResult?.followerRemoval?.removed);
        const problematic = related.filter(job => ['skipped','excluded','uncertain','running'].includes(job.state)
          || job.followResult?.attemptedAt && !job.followResult?.succeeded
          || job.followResult?.followerRemoval?.attemptedAt && !job.followResult?.followerRemoval?.removed
          || (job.state === 'followed' || job.followResult?.succeeded) && directory.payload.relationship?.following !== true);
        const legacyBlocked = sources.some(row => ['skipped','excluded','uncertain','identity_mismatch','no_longer_following'].includes(row.payload.status)
          || ['skipped','excluded','uncertain'].includes(row.payload.autoFollowState));
        const legacyUnknown = directory.payload.fanCategory === 'unknown';
        let reason = identityConflict ? '历史账号身份冲突，等待审核'
          : !id ? '历史账号缺少稳定用户 ID，等待审核'
          : removedClaim && !receipt ? '历史移除标记缺少确认回执，等待审核'
          : matchingTombstone ? matchingTombstone.reason || '历史排除或移除记录，等待审核'
          : problematic.length ? problematic.map(job => job.reason || job.followResult?.reason || `历史队列状态：${job.state}`).join('；')
          : legacyBlocked ? '历史规则拦截或执行结果不明，等待审核'
          : legacyUnknown ? directory.payload.fanRelationshipReason || '历史关系信息不完整，等待审核' : '';
        const canShowRemoved = receipt && directory.payload.relationship?.following !== true && directory.payload.relationship?.followedBy !== true;
        const state = canShowRemoved ? 'removed' : reason ? 'review' : '';
        const ownerPatchFor = row => {
          if (request.includeUnassigned !== true) return {};
          const patch = row.payload.ownerAccountId !== accountId ? {ownerAccountId:accountId} : {};
          const review = row.payload.fanReview;
          if (review && (!review.ownerAccountId || id && !review.targetUserId)) {
            patch.fanReview = {...review,ownerAccountId:accountId,...(id && !review.targetUserId ? {targetUserId:id} : {})};
          }
          return patch;
        };
        if (!state) {
          for (const row of sources) {
            // Ordinary history inherits the durable, exclusive projection owner.
            // Avoid thousands of identical per-source journals for an ownership-only upgrade.
            if (!row.payload.fanReview) continue;
            const patch = ownerPatchFor(row);
            if (!Object.keys(patch).length) continue;
            await applyBatchBody('monitor',[{accountId:row.accountId,userKey:row.userKey,handle:row.handle,sourceBucket:row.sourcePath[1],patch}],row.accountId);
            result.updated++;
          }
          result.skipped++;continue;
        }
        if (canShowRemoved) reason = receipt.reason || '已确认移除此关注者';
        let changed = false;
        for (const row of sources) {
          const previous = row.payload.fanReview;
          // Explicit current decisions win over a generic migration; identity/removal contradictions fail closed.
          const ownerPatch = ownerPatchFor(row);
          if (previous && previous.source !== 'legacy-migration' && !identityConflict && id && !matchingTombstone && !pendingExternal && !canShowRemoved
            && !(removedClaim && (!receipt || !confirmedFanRemoval(row.payload, accountId, id)))) {
            if (Object.keys(ownerPatch).length) {
              await applyBatchBody('monitor',[{accountId:row.accountId,userKey:row.userKey,handle:row.handle,sourceBucket:row.sourcePath[1],patch:ownerPatch}],row.accountId);
              result.updated++;changed = true;
            }
            continue;
          }
          const legacy = previous?.source === 'legacy-migration' ? previous.legacyReview : clone(previous);
          const fanReview = {
            ...(previous || {}),state,workflow:state,source:'legacy-migration',reason,ownerAccountId:accountId,
            ...(id ? {targetUserId:id} : {}),
            decision:state === 'removed' ? 'remove' : 'review',
            ...(legacy ? {legacyReview:legacy} : {}),
            ...(receipt ? {removalReceipt:receipt} : {}),
            migration:{version:3,ownerAccountId:accountId,targetUserId:id,identityConflict,
              sourceRecords:sources.map(source => ({accountId:source.accountId,userKey:source.userKey,targetUserIds:fanIds(source.payload)})),
              queueHistory:clone(related),...(matchingTombstone ? {tombstone:clone(matchingTombstone)} : {})}
          };
          if (!Object.keys(ownerPatch).length && previous && canonicalValue(previous) === canonicalValue(fanReview)) continue;
          await applyBatchBody('monitor',[{accountId:row.accountId,userKey:row.userKey,handle:row.handle,sourceBucket:row.sourcePath[1],patch:{...ownerPatch,fanReview}}],row.accountId);
          result.updated++;changed = true;
        }
        if (changed) result[state]++;
        else result.skipped++;
      }
      await projection.writeState({fanReviewMigrationVersion:3});
      return result;
    });
  }

  async function fanInspectionTargets(request = {}) {
    await ensureOpen();requireReady();await flushDirty('fans');await ensureFanDirectory();
    const filter={...(request.filter || {})};
    const tab=FAN_TABS[filter.tab || 'fanAll'];
    if (!tab) throw new Error('无效粉丝分类');
    filter.searchHandle=exactFanSearchHandle(filter.search);filter.search=normalizeFanSearch(filter.search);
    const selected=Array.isArray(request.handles) ? new Set(request.handles.map(h=>String(h).toLowerCase())) : null;
    const handles=[];let cursor=null;
    do {
      const page=await projection.scanBatches({accountId:request.accountId || 'unassigned',module:'fanDirectory',tab,limit:200,maxScan:200,cursor,
        match:row=>(!selected || selected.has(row.handle)) && matches('fans',row,filter)});
      handles.push(...page.records.map(row=>row.handle));cursor=page.nextCursor;
    }while(cursor);
    return [...new Set(handles)];
  }

  async function profiles(request = {}) {
    await ensureOpen();
    requireReady();
    const handles = request.handles || [];
    if (!Array.isArray(handles) || handles.length < 1 || handles.length > 100) throw new Error('profile lookup accepts 1 to 100 handles');
    await flushDirty('profiles');
    const rows = await projection.rowsByHandle(request.accountId || 'unassigned', 'profiles', handles);
    return rows.map(present);
  }

  async function config(request = {}) {
    await ensureOpen();
    if (!CONFIG_KEYS.includes(request.key)) throw new Error('config key is not available');
    if (request.value === undefined) {
      const stored = await storage.local.get([request.key]);
      return stored?.[request.key] ?? null;
    }
    await sequenceMutation(() => writes.enqueue(async () => {
      await storage.local.set({[request.key]: request.value});
    }));
    return request.value;
  }

  function legacyKeyFor(moduleName, sourcePath) {
    if (sourcePath?.[0]) return sourcePath[0];
    return MODULE_KEYS[moduleName]?.[0];
  }

  async function mergeRoot(key, fields) {
    await ensureOpen();
    requireReady();
    if (!LEGACY_RECORD_KEYS.includes(key)) throw new Error('module has no legacy mirror');
    return sequenceMutation(() => mergeRootBody(key, fields));
  }

  async function mergeRootBody(key, fields) {
    const state = await projection.readState();
    const metadata = {...(state.metadata || {})};
    const current = {...(metadata[key] || {})};
    for (const [name, value] of Object.entries(fields || {})) {
      if (COLLECTION_FIELDS.has(name) && Array.isArray(value)) throw new Error('mergeRoot does not replace record collections');
      current[name] = value;
    }
    metadata[key] = current;
    await projection.writeState({metadata, revision: (state.revision || 0) + 1});
    await persistIncremental({
      operationId: `merge-root:${key}:${crypto.randomUUID()}`,
      kind: 'mergeRoot',
      sourceKey: key,
      payload: current
    });
    return {updated: Object.keys(fields || {})};
  }

  function assertExpectedHandle(existing, expectedHandle) {
    if (expectedHandle == null || expectedHandle === '') return;
    if (String(existing?.handle || '').toLowerCase() !== String(expectedHandle).toLowerCase()) {
      throw new Error('record handle does not match the requested row');
    }
  }

  let mutationChain = Promise.resolve();
  function sequenceMutation(work) {
    const run = mutationChain.then(work, work);
    mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function indexFromRelation(handle, relation) {
    return {
      following: new Set(relation?.following ? [handle] : []),
      followers: new Set(relation?.follower ? [handle] : []),
      queueStatus: new Map(relation?.queueStatus ? [[handle, relation.queueStatus]] : [])
    };
  }

  async function materializeRow({previous, payload, moduleName, accountId, sourcePath, sourceKey}) {
    const handle = handleOf(payload);
    const relation = handle ? (await projection.getRelations([handle]))[0] : null;
    const index = indexFromRelation(handle, relation);
    const tabs = tabsFor(moduleName, payload, sourcePath, index);
    const view = moduleName === 'mutual' || moduleName === 'comments'
      ? applyRelationshipSnapshot({...payload, handle: payload.handle || handle}, index).relationship
      : null;
    const userKey = previous?.userKey || encodePath(sourcePath);
    return {
      accountId,
      module: moduleName,
      userKey,
      sortKey: sortKeyFor(moduleName, payload, sourcePath, index),
      tabs,
      tab: tabs[0],
      handle,
      status: typeof payload.status === 'string' ? payload.status : '',
      sourceKey: sourceKey || previous?.sourceKey || sourceKeyOf(sourcePath),
      sourcePath,
      ...(externalIdOf(payload) ? {externalId: externalIdOf(payload)} : {}),
      payload,
      view
    };
  }

  function trackerTemplate(source, related = []) {
    const user = source.payload || {};
    const candidates = [user, ...related.filter(row => row.accountId === source.accountId).map(row => row.payload || {})];
    const date = candidates.some(item => Number.isFinite(Date.parse(item.followedAt))) ? resolveFollowedAt(candidates) : {followedAt: '', followedAtSource: 'unknown'};
    const followedBy = typeof user.relationship?.followedBy === 'boolean' ? user.relationship.followedBy : null;
    return {
      id: user.id || '',
      handle: user.handle,
      name: user.name || user.handle,
      avatarUrl: user.avatarUrl || '',
      bio: user.bio || '',
      followersText: user.followersText || '',
      followingText: user.followingText || '',
      ...date,
      followBackAt: user.followBackAt || null,
      relationship: {following: true, followedBy},
      status: followedBy === true ? 'mutual' : followedBy === false ? 'pending' : 'unknown',
      exempt: false
    };
  }

  function notMutualSource(rows) {
    const fan = rows.some(row => row.sourceKey === 'monitor' && row.sourcePath?.[1] === 'users');
    for (const row of rows) {
      if (row.sourceKey === 'monitor' && row.sourcePath?.[1] === 'followingUsers') {
        const followedBy = row.payload?.relationship?.followedBy;
        if (followedBy === false || (followedBy !== true && !fan)) return row;
      }
    }
    for (const row of rows) {
      if (row.sourceKey === 'monitor' && row.sourcePath?.[1] === 'users' && row.payload?.relationship?.following === true && row.payload?.relationship?.followedBy === false) return row;
    }
    for (const row of rows) {
      if (row.module === 'mutual' && row.sourcePath?.[1] === 'users') {
        const relationship = row.payload?.relationship || {};
        if (relationship.following === true && (relationship.followedBy === false || (relationship.followedBy !== true && !fan))) return row;
      }
    }
    return null;
  }

  function trackerSource(rows) {
    const pool = [];
    for (const row of rows) if (row.sourceKey === 'monitor' && row.sourcePath?.[1] === 'followingUsers') pool.push(row);
    for (const row of rows) {
      if (row.sourceKey === 'monitor' && row.sourcePath?.[1] === 'users' && (row.payload?.relationship?.following === true || row.payload?.state === 'following')) pool.push(row);
    }
    for (const row of rows) if (row.module === 'mutual' && (row.payload?.relationship?.following === true || row.payload?.followedAt)) pool.push(row);
    for (const row of rows) if (row.module === 'comments' && (row.payload?.relationship?.following === true || row.payload?.followedAt)) pool.push(row);
    return pool[0] || null;
  }

  async function refreshBoundViews(handle, relation, rows) {
    const index = indexFromRelation(handle, relation);
    for (const row of rows) {
      if (row.module !== 'mutual' && row.module !== 'comments') continue;
      const view = applyRelationshipSnapshot(row.payload, index).relationship;
      const tabs = tabsFor(row.module, row.payload, row.sourcePath, index);
      const sortKey = sortKeyFor(row.module, row.payload, row.sourcePath, index);
      if (JSON.stringify(view) === JSON.stringify(row.view) && JSON.stringify(tabs) === JSON.stringify(row.tabs) && sortKey === row.sortKey) continue;
      const next = {...row, view, tabs, tab: tabs[0], sortKey};
      await projection.mutateRow({row: next, membership: membershipOf(next)}, [row.accountId, row.module, row.userKey]);
    }
  }

  async function recomputeHandle(handle, track = (_step, action) => action()) {
    if (!handle) return;
    const rows = await track('read-related-rows', () => projection.rowsByHandleKey(handle));
    const directoryAccounts = new Set(rows.filter(row => row.sourceKey === 'monitor' || row.sourceKey === 'derived:fanDirectory').map(row => row.accountId));
    for (const accountId of directoryAccounts) {
      const previous = rows.find(row => row.module === 'fanDirectory' && row.accountId === accountId);
      const next = reviewDirectoryRow(rows.filter(row => row.accountId === accountId));
      if (next || previous) await track('refresh-fan-directory', () => projection.mutateRow(next ? {row:next, membership:membershipOf(next)} : null,
        previous ? [accountId,'fanDirectory',handle] : null));
    }
    const monitor = rows.filter(row => row.sourceKey === 'monitor');
    const users = monitor.filter(row => row.sourcePath?.[1] === 'users');
    const following = monitor.filter(row => row.sourcePath?.[1] === 'followingUsers');
    const queue = monitor.filter(row => row.sourcePath?.[1] === 'queue');
    let relation = null;
    if (users.length || following.length || queue.length) {
      const current = (await track('read-relations', () => projection.getRelations([handle])))[0] || {handle};
      relation = {...current, handle, follower: users.length > 0};
      relation.following = following.length > 0 || users.some(row => row.payload?.state === 'following' || row.payload?.status === 'followed' || row.payload?.relationship?.following === true);
      relation.queued = queue.some(row => row.payload?.status !== 'followed');
      relation.queueStatus = queue[0]?.payload?.status || '';
      relation.notMutual = Boolean(notMutualSource(rows));
      const index = indexFromRelation(handle, relation);
      const user = {handle, relationship: {following: relation.following, followedBy: relation.follower}};
      relation.label = relation.following && relation.follower ? '互相关注' : commentRelationshipLabel(user, index);
      relation.mutualLabel = personalRelationshipLabel(user);
      relation.rank = RELATION_RANK[relation.mutualLabel] ?? 5;
      relation.category = mutualUserCategory(user);
      await track('write-relation', () => projection.upsertRelation(relation));
    } else {
      await track('delete-relation', () => projection.deleteRelation(handle));
    }
    const chosen = notMutualSource(rows);
    const derived = rows.find(row => row.sourceKey === 'derived:notMutual');
    if (!chosen && derived) await track('delete-derived-row', () => projection.mutateRow(null, [derived.accountId, derived.module, derived.userKey]));
    if (chosen) {
      const next = {
        accountId: chosen.accountId,
        module: 'fans',
        userKey: `not-mutual/${handle}`,
        sourceKey: 'derived:notMutual',
        sourcePath: chosen.sourcePath.slice(),
        payload: clone(chosen.payload),
        handle,
        status: '',
        tabs: ['notMutual'],
        tab: 'notMutual',
        sortKey: `2|${chosen.sortKey}`,
        view: null
      };
      await track('write-derived-row', () => projection.mutateRow({row: next, membership: membershipOf(next)}, derived ? [derived.accountId, derived.module, derived.userKey] : null));
    }
    const real = rows.find(row => row.sourceKey === 'unreciprocatedTracker' && row.sourcePath?.[1] === 'users');
    const synthetic = rows.find(row => row.sourceKey === 'derived:tracker' || row.sourcePath?.[1] === 'synthetic');
    const state = await projection.readState();
    // Old relationship flags in retained customer profiles must not recreate a
    // tracker after the current owner's verified no-relationship cleanup.
    const source = trackerSource(rows.filter(row=>{
      const owner=row.accountId==='unassigned'?[row.payload?.ownerAccountId,row.payload?.accountId,row.payload?.fanReview?.ownerAccountId,row.payload?.fanGrant?.ownerAccountId,state.fanReviewLegacyOwnerAccountId].find(id=>id&&id!=='unassigned'):row.accountId;
      const marker=state.metadata?.monitor?.fanRetentionExclusions?.[owner+':'+handle];
      return !(marker?.scope==='fans'&&fanRowOwned(row,owner,state.fanReviewLegacyOwnerAccountId)&&fanRetentionBlocks(marker,{sourceKey:'monitor',moduleName:row.module,payload:row.payload}));
    }));
    if (real && synthetic) await track('delete-tracker-row', () => projection.mutateRow(null, [synthetic.accountId, synthetic.module, synthetic.userKey]));
    if (!real && source) {
      const generated = trackerTemplate(source, rows);
      const previous = synthetic?.payload || {};
      const keepStatus = previous.status && previous.status !== 'pending' && previous.status !== 'mutual';
      const followedBy = generated.relationship.followedBy ?? previous.relationship?.followedBy ?? null;
      const payload = {
        ...previous,
        ...generated,
        ...([generated, previous].some(user => Number.isFinite(Date.parse(user.followedAt))) ? resolveFollowedAt([generated, previous]) : {}),
        relationship: {...generated.relationship, followedBy},
        status: keepStatus ? previous.status : followedBy === true ? 'mutual' : followedBy === false ? 'pending' : 'unknown',
        exempt: previous.exempt === true ? true : generated.exempt
      };
      const next = await track('prepare-tracker-row', () => materializeRow({
        previous: synthetic,
        payload,
        moduleName: 'unreciprocated',
        accountId: synthetic?.accountId || source.accountId || 'unassigned',
        sourcePath: ['unreciprocatedTracker', 'synthetic', handle],
        sourceKey: 'derived:tracker'
      }));
      next.userKey = synthetic?.userKey || `derived-tracker/${handle}`;
      await track('write-tracker-row', () => projection.mutateRow({row: next, membership: membershipOf(next)}, synthetic ? [synthetic.accountId, synthetic.module, synthetic.userKey] : null));
    } else if (!real && !source && synthetic) {
      await track('delete-tracker-row', () => projection.mutateRow(null, [synthetic.accountId, synthetic.module, synthetic.userKey]));
    }
    await track('refresh-related-views', () => refreshBoundViews(handle, relation, rows));
    if (state.fanDirectoryDirtyHandles?.includes(handle)) await projection.writeState({fanDirectoryDirtyHandles:state.fanDirectoryDirtyHandles.filter(item => item !== handle)});
  }

  async function commitRow(previous, row, entry) {
    const saved = present(row);
    const backup = {...entry, ...(previous?.handle && previous.handle !== row.handle ? {previousHandle:previous.handle} : {}), status: 'pending', savedAt: now(), result: saved};
    await projection.commitWithBackup(
      previous ? [previous.accountId, previous.module, previous.userKey] : null,
      {row, membership: membershipOf(row)},
      backup
    );
    if (previous?.handle && previous.handle !== row.handle) await recomputeHandle(previous.handle);
    if (row.handle) await recomputeHandle(row.handle);
    await bumpRevision();
    await persistIncremental(backup);
    if(row.module==='unreciprocated'&&row.payload?.status==='unfollowed'){
      const state=await projection.readState(),p=row.payload,at=Date.parse(p.unfollowedAt||'');
      if(Number.isFinite(at)){
        const history=mergeUnfollowHistory(state.metadata?.unreciprocatedTracker?.unfollowHistory||{},[{accountId:row.accountId==='unassigned'?state.fanReviewLegacyOwnerAccountId||state.metadata?.unreciprocatedTracker?.unfollowHistoryLegacyOwner||'unassigned':row.accountId,
          handle:row.handle,targetUserId:p.id||'',name:p.name||row.handle,at,source:'stored-outcome'}]);
        await mergeRootBody('unreciprocatedTracker',{unfollowHistory:history});
      }
    }
    const stored = await projection.getRow(row.accountId, row.module, row.userKey);
    return stored ? present(stored) : saved;
  }

  async function persistIncremental(entry) {
    const operationId = entry.operationId;
    const existing = await projection.getBackup(operationId);
    if (existing?.status === 'stored') return existing;
    if (typeof durableAppendIncremental === 'function') {
      const res = await durableAppendIncremental(entry);
      const stored = res?.entry || res || entry;
      await projection.putBackup({...stored, status: 'stored'});
      return stored;
    }
    await writes.enqueue(async () => {
      const head = (await durableGet(INCREMENTAL_HEAD)) || {seq: 0};
      let curSeq = head.seq || 0;
      while (true) {
        const nextSeqKey = `${INCREMENTAL_PREFIX}seq:${String(curSeq + 1).padStart(8, '0')}`;
        const existingAtNext = await durableGet(nextSeqKey);
        if (!existingAtNext) break;
        curSeq += 1;
        if (existingAtNext.operationId === operationId) {
          if (curSeq > (head.seq || 0)) {
            await durableSet(INCREMENTAL_HEAD, {seq: curSeq, operationId: existingAtNext.operationId});
          }
          await projection.putBackup(existingAtNext);
          return existingAtNext;
        }
      }
      const seq = curSeq + 1;
      const body = {...entry, seq, status: 'stored'};
      const seqKey = `${INCREMENTAL_PREFIX}seq:${String(seq).padStart(8, '0')}`;
      const published = await durableGet(seqKey);
      if (published && published.operationId !== operationId) throw new Error('incremental sequence was already published');
      if (!published) await durableSet(seqKey, body);
      await durableSet(INCREMENTAL_HEAD, {seq, operationId});
      await projection.putBackup(published ? {...published, status: 'stored'} : body);
    });
    return entry;
  }

  async function retryPending(limit) {
    const pending = await projection.pendingBackups(limit);
    for (const entry of pending) await persistIncremental(entry);
    return pending.length;
  }

  async function recoverBackups() {
    await ensureOpen();
    let recovered = 0;
    for (;;) {
      const count = await retryPending(20);
      recovered += count;
      if (count < 20) break;
    }
    return {recovered};
  }

  async function restoreLatestSnapshot() {
    let catalog;
    try { catalog = await readRecovery(SNAPSHOT_CATALOG); }
    catch (cause) {
      const error = new Error(`持久化备份来源访问失败: ${cause?.message || cause}`);
      error.name = 'BaselineRecoveryAccessError';
      throw error;
    }
    if (!catalog?.snapshots?.length) {
      const head = await readRecovery(INCREMENTAL_HEAD);
      if (head?.baseSeq > 0) throw new Error('完整快照目录缺失，禁止使用不完整的旧基线恢复');
      return null;
    }
    let failure;
    for (const descriptor of catalog.snapshots) {
      try {
        const {image} = await readSnapshot(readRecovery, descriptor);
        await projection.importSnapshot(image);
        const state = await projection.readState();
        // Only copy progress fields. Copying metadata into progress would let a
        // later progress checkpoint overwrite metadata applied from increments.
        Object.assign(progress, {completed: state.completed, total: state.total,
          migrationId: state.migrationId, fingerprint: state.fingerprint,
          stage: 'replaying', cutover: false, error: null});
        await projection.writeState({...publicProgress(), snapshotBaseSeq: descriptor.seq});
        return descriptor;
      } catch (error) { failure = error; }
    }
    throw failure || new Error('没有可恢复的完整快照');
  }

  async function backupSettings(value) {
    if (value !== undefined) {
      const settings = validateBackupSettings(value);
      await storage.local.set({[BACKUP_SETTINGS_KEY]: settings});
      await onBackupSettingsChanged?.(settings);
      return settings;
    }
    return validateBackupSettings((await storage.local.get([BACKUP_SETTINGS_KEY]))[BACKUP_SETTINGS_KEY]);
  }

  let backupRun = null;
  async function backupStatus() {
    const [catalog, head, saved] = await Promise.all([readRecovery(SNAPSHOT_CATALOG), readRecovery(INCREMENTAL_HEAD), storage.local.get(['recordBackupLastAttempt'])]);
    const latest = catalog?.snapshots?.[0];
    return {snapshotCount: catalog?.snapshots?.length || 0,
      incrementalCount: Math.max(0, (head?.seq || 0) - (head?.baseSeq || 0)),
      lastBackupAt: latest?.savedAt || null, verification: latest?.verification || null,
      running: !!backupRun, lastAttempt: saved.recordBackupLastAttempt || null};
  }

  async function maintainBackups(request = {}) {
    if (backupRun) return backupRun;
    backupRun = (async () => {
      try {
        const result = await performBackupMaintenance(request);
        if (!result.skipped) await storage.local.set({recordBackupLastAttempt: {at: now(), ok: true}});
        return result;
      } catch (error) {
        await storage.local.set({recordBackupLastAttempt: {at: now(), ok: false, error: String(error.message || error)}});
        throw error;
      } finally { backupRun = null; }
    })();
    return backupRun;
  }

  async function performBackupMaintenance({force = false} = {}) {
    const settings = await backupSettings();
    if (!settings.enabled && !force) return {skipped: true, reason: 'disabled'};
    await ensureOpen();
    requireReady();
    if (typeof durableCompactSnapshots !== 'function') throw new Error('快照存储接口不可用');
    return sequenceMutation(async () => {
      await recoverBackups();
      const head = await readRecovery(INCREMENTAL_HEAD) || {seq: 0};
      const catalog = await readRecovery(SNAPSHOT_CATALOG);
      const latest = catalog?.snapshots?.[0];
      if (!force && latest && (head.seq === latest.seq ||
          (head.seq - latest.seq < settings.incrementalLimit && now() - latest.savedAt < settings.maxAgeHours * 3600000))) {
        const localDeleted = await projection.compactBackups(catalog.compactedThrough || 0);
        return {skipped: true, seq: head.seq, retained: catalog.snapshots.length, localDeleted};
      }
      const image = await projection.exportSnapshot();
      const {business, logs} = splitSnapshot(image);
      const fingerprint = await hashCanonical(business);
      const id = `${head.seq}-${now()}-${fingerprint.slice(0, 12)}`;
      const descriptor = {id, seq: head.seq, savedAt: now(), fingerprint};
      await durableSet(SNAPSHOT_LOG_PREFIX + id, {logs});
      await durableSet(SNAPSHOT_PREFIX + id, {version: 1, seq: head.seq, business, fingerprint, logFingerprint: await hashCanonical(logs)});
      const stored = await readSnapshot(readRecovery, descriptor);
      const verification = await verifySnapshotRestore({image: stored.image, indexedDB: indexed, IDBKeyRange: keyRange,
        dbName: `${dbName}-restore-check-${id}`});
      const result = await durableCompactSnapshots({expectedHead: head.seq, retain: settings.retain, snapshot: {...descriptor, verified: true, verification}});
      const localDeleted = await projection.compactBackups(result.compactedThrough);
      await projection.writeState({snapshotBaseSeq: head.seq});
      return {...result, localDeleted, verification};
    });
  }

  async function mutate(kind, request = {}) {
    await ensureOpen();
    requireReady();
    return sequenceMutation(() => applyMutation(kind, request));
  }

  async function suppressRetainedRow({accountId,sourceKey,moduleName,payload}) {
    const state=await projection.readState(),markers=state.metadata?.monitor?.fanRetentionExclusions||{};
    const owner=accountId==='unassigned'?([payload.ownerAccountId,payload.accountId,state.fanReviewLegacyOwnerAccountId].find(id=>id&&id!=='unassigned')||'unassigned'):accountId;
    const marker=markers[owner+':'+handleOf(payload)];
    if(marker?.scope==='account'){
      const access=(await storage.local.get([PROFILE_ACCESS_PREFIX+handleOf(payload)]))[PROFILE_ACCESS_PREFIX+handleOf(payload)];
      if(access?.status==='ok'&&access.checkedAt>marker.observedAt)return false;
    }
    return fanRetentionBlocks(marker,{accountId,sourceKey,moduleName,payload});
  }

  async function fanCleanupCandidates(request={}) {
    await ensureOpen();requireReady();await flushDirty('fans');
    const owner=request.ownerId;if(!owner||owner==='unassigned')throw Error('缺少清理归属账号');
    await sequenceMutation(()=>persistFanRetentionOwner(owner));
    const state=await projection.readState(),groups=new Map();let cursor=null;
    do {
      const page=await projection.scanBySource({sourceKey:'monitor',limit:200,cursor});
      for(const row of page.records)if(fanRowOwned(row,owner,state.fanReviewLegacyOwnerAccountId)){
        if(!groups.has(row.handle))groups.set(row.handle,[]);groups.get(row.handle).push(row);
      }
      cursor=page.nextCursor;
    }while(cursor);
    const handles=[...groups.keys()],access=handles.length?await storage.local.get(handles.map(h=>PROFILE_ACCESS_PREFIX+h)):{};
    const candidates=[];
    for(const[handle,rows]of groups){const decision=fanRetentionDecision(rows,access[PROFILE_ACCESS_PREFIX+handle]);if(decision)candidates.push({handle,...decision});}
    // A previous attempt may have removed records before queue cleanup failed.
    const orphanTrackers=new Set();
    for(const sourceKey of ['derived:tracker','unreciprocatedTracker']){
      let trackerCursor=null;
      do{
        const page=await projection.scanBySource({sourceKey,limit:200,cursor:trackerCursor});
        for(const row of page.records){const marker=state.metadata?.monitor?.fanRetentionExclusions?.[owner+':'+row.handle];
          if(marker?.scope==='fans'&&fanRowOwned(row,owner,state.fanReviewLegacyOwnerAccountId)&&fanRetentionBlocks(marker,{sourceKey:'monitor',moduleName:row.module,payload:row.payload})){
            const related=(await projection.rowsByHandleKey(row.handle)).filter(r=>fanRowOwned(r,owner,state.fanReviewLegacyOwnerAccountId));
            if(!hasNewerFanRelationship(related,marker))orphanTrackers.add(row.handle);
          }
        }
        trackerCursor=page.nextCursor;
      }while(trackerCursor);
    }
    for(const[key,marker]of Object.entries(state.metadata?.monitor?.fanRetentionExclusions||{})){
      if(marker.ownerId===owner&&!groups.has(key.slice(owner.length+1)))candidates.push({handle:key.slice(owner.length+1),...marker,orphan:true,hasRecords:orphanTrackers.has(key.slice(owner.length+1))});
    }
    return {candidates,scanned:handles.length};
  }

  async function cleanupFanRecord(request={}) {
    await ensureOpen();requireReady();
    const handle=String(request.handle||'').replace(/^@/,'').toLowerCase(),owner=request.ownerId;
    if(!owner||owner==='unassigned'||!/^[a-z0-9_]{1,15}$/.test(handle))throw Error('清理目标或归属账号无效');
    return sequenceMutation(async()=>{
      await recoverBackups();await persistFanRetentionOwner(owner);const state=await projection.readState();
      const rows=(await projection.rowsByHandleKey(handle)).filter(row=>fanRowOwned(row,owner,state.fanReviewLegacyOwnerAccountId));
      const access=(await storage.local.get([PROFILE_ACCESS_PREFIX+handle]))[PROFILE_ACCESS_PREFIX+handle];
      const prior=state.metadata?.monitor?.fanRetentionExclusions?.[owner+':'+handle];
      if(prior?.scope==='fans'&&!rows.some(row=>row.sourceKey==='monitor')&&hasNewerFanRelationship(rows,prior))return {handle,deleted:0,skipped:true,reason:'relationship-renewed'};
      const decision=fanRetentionDecision(rows,access)||(!rows.some(row=>row.sourceKey==='monitor')&&prior?.scope==='fans'?prior:null);
      if(!decision)return {handle,deleted:0,skipped:true};
      const ids=[...new Set(rows.filter(r=>decision.scope==='fans'?r.sourceKey==='monitor':r.module!=='logs').map(r=>fanTargetId(r.payload)).filter(Boolean))];
      if(decision.scope==='account'&&ids.length>1)return {handle,deleted:0,skipped:true,reason:'identity-conflict'};
      if(request.targetIds?.length&&ids.some(id=>!request.targetIds.includes(id)))return {handle,deleted:0,skipped:true,reason:'identity-changed'};
      const markers={...(state.metadata?.monitor?.fanRetentionExclusions||{})};
      const marker={...decision,ownerId:owner,targetIds:decision.targetIds.length?decision.targetIds:ids.length?ids:markers[owner+':'+handle]?.targetIds||[]};
      const independentlyUsed=rows.some(row=>['mutual','comments','analysis','rows'].includes(row.module));
      const modules=new Set(['fans','mutual','comments','unreciprocated','profiles','analysis','rows']);
      const targets=(decision.scope==='account'?rows:rows.filter(row=>row.sourceKey==='monitor'||row.module==='unreciprocated'||!independentlyUsed&&row.module==='profiles'))
        .filter(row=>modules.has(row.module)&&row.sourceKey!=='derived:notMutual')
        .filter(row=>decision.scope==='account'||!decision.targetIds.length||!fanTargetId(row.payload)||decision.targetIds.includes(fanTargetId(row.payload)));
      const removedRows=targets.map(row=>({accountId:row.accountId,module:row.module,userKey:row.userKey,handle,targetUserId:fanTargetId(row.payload)}));
      if(targets.length||canonicalValue(markers[owner+':'+handle]||{})!==canonicalValue(marker)){
        const key=owner+':'+handle;
        // One durable deletion plan owns every bucket for this identity. A
        // restart can replay the whole plan after any partial local deletion.
        await persistIncremental({operationId:`fan-retention:${key}:${await hashCanonical({marker,removedRows})}`,
          kind:'fanRetention',handle,payload:{key,marker,removedRows}});
        markers[key]=marker;
        await projection.writeState({metadata:{...(state.metadata||{}),monitor:{...(state.metadata?.monitor||{}),fanRetentionExclusions:markers}},
          fanDirectoryDirtyHandles:targets.length?[...new Set([...(state.fanDirectoryDirtyHandles||[]),handle])]:state.fanDirectoryDirtyHandles||[]});
      }
      const deleted=await applyFanCleanupRows(removedRows);
      if(deleted){await recomputeHandle(handle);await bumpRevision();}
      const remaining=(await projection.rowsByHandleKey(handle)).filter(row=>fanRowOwned(row,owner,state.fanReviewLegacyOwnerAccountId));
      if(remaining.some(row=>row.sourceKey==='monitor'))throw Error('粉丝记录清理后仍有残留');
      return {handle,deleted,...decision,targetIds:marker.targetIds};
    });
  }

  async function persistFanRetentionOwner(owner){
    const state=await projection.readState();
    if(state.fanReviewLegacyOwnerAccountId!==owner||state.fanRetentionOwnerJournaled===owner)return;
    // The exclusive legacy owner is already confirmed. Preserve that proof for
    // rebuilding into a fresh database, where old rows still say unassigned.
    await persistIncremental({operationId:`fan-retention-owner:${owner}`,kind:'fanRetentionOwner',ownerId:owner});
    await projection.writeState({fanRetentionOwnerJournaled:owner});
  }

  async function applyFanCleanupRows(removedRows=[]) {
    let deleted=0;
    for(const item of removedRows){
      const row=await projection.getRow(item.accountId,item.module,item.userKey);
      if(!row||row.handle!==item.handle||item.targetUserId&&fanTargetId(row.payload)!==item.targetUserId)continue;
      await projection.mutateRow(null,[row.accountId,row.module,row.userKey]);deleted++;
    }
    return deleted;
  }

  async function deleteFanAccount(request = {}) {
    await ensureOpen();
    requireReady();
    const handle = String(request.handle || '').replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error('账号格式无效');
    return sequenceMutation(async () => {
      await recoverBackups();
      const rows = (await projection.rowsByHandleKey(handle)).filter(row => row.module === 'fans' && row.sourceKey === 'monitor' && row.accountId === (request.accountId || 'unassigned'));
      let deleted = 0;
      for (const row of rows) {
        const result = await applyMutation('delete', {module:'fans', accountId:row.accountId, userKey:row.userKey, expectedHandle:handle, operationId:crypto.randomUUID()});
        if (!result.missing) deleted++;
      }
      return {handle, deleted};
    });
  }

  async function deleteAccountRows(rows, handle) {
    const modules = new Set(['fans', 'mutual', 'comments', 'unreciprocated', 'profiles', 'analysis', 'rows']);
    const targets = rows.filter(row => modules.has(row.module) && row.sourceKey !== 'derived:notMutual')
      .sort((a, b) => Number(a.module === 'unreciprocated') - Number(b.module === 'unreciprocated'));
    let deleted = 0;
    for (const row of targets) {
      const result = await applyMutation('delete', {module:row.module, accountId:row.accountId,
        userKey:row.userKey, expectedHandle:handle, exactKeyOnly:true, operationId:crypto.randomUUID()});
      if (!result.missing) deleted++;
    }
    return {handle, deleted};
  }

  async function deleteLocalAccount(request = {}) {
    await ensureOpen();requireReady();
    const handle=String(request.handle||'').replace(/^@/,'').toLowerCase();
    if(!/^[a-z0-9_]{1,15}$/.test(handle) || !request.ownerId)throw new Error('删除目标或所属账号无效');
    return sequenceMutation(async()=>{
      await recoverBackups();
      const owner = String(request.ownerId);
      const rows=(await projection.rowsByHandleKey(handle)).filter(row=>['unassigned',owner].includes(row.accountId) && row.module!=='logs'
        && [row.payload?.accountId,...fanOwnerClaims(row.payload || {})].filter(id=>id && id!=='unassigned').every(id=>id===owner));
      // Manual confirmation selects this handle under its owner. Legacy source
      // IDs may disagree (including old reply Tweet IDs); no X action is issued.
      // An explicit local delete does not depend on API/availability analysis and
      // is not a scheduling tombstone. Fresh collection may create a new record.
      return deleteAccountRows(rows,handle);
    });
  }

  async function deleteUnavailableAccount(request = {}) {
    await ensureOpen();
    requireReady();
    const handle = String(request.handle || '').replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error('账号格式无效');
    return sequenceMutation(async () => {
      await recoverBackups();
      const rows = await projection.rowsByHandleKey(handle);
      const evidence = rows.map(row => row.payload?.accountAvailability).filter(Boolean);
      const accessKey = PROFILE_ACCESS_PREFIX + handle;
      const access = (await storage.local.get([accessKey]))[accessKey];
      if (access) evidence.push(access);
      const latest = evidence.sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0))[0];
      if (!['suspended', 'not_found'].includes(latest?.status) || evidence.some(e=>e.checkedAt===latest?.checkedAt&&!['suspended','not_found'].includes(e.status))) {
        if(request.automatic)return {handle,deleted:0,skipped:true};
        throw new Error('账号尚未确认为封禁或不存在，请先重新检查');
      }
      return deleteAccountRows(rows,handle);
    });
  }

  async function applyMutation(kind, request = {}) {
    const moduleName = request.module;
    if (!RECORD_MODULES.includes(moduleName)) throw new Error('module is not queryable');
    if (typeof request.operationId !== 'string' || request.operationId.trim() === '') throw new Error('operationId must be a non-empty string');
    const prior = await projection.getBackup(request.operationId);
    if (prior?.status === 'stored') return prior.result;
    if (prior?.status === 'pending') {
      await persistIncremental(prior);
      return prior.result;
    }
    // Delete has no payload to assert ownership against. Its compound lookup
    // already contains the explicit owner; payload validation applies to writes.
    const accountId = kind==='delete'?(typeof request.accountId==='string'&&request.accountId.trim()?request.accountId:'unassigned')
      :accountOf(request.record || request.patch || {}, request.accountId);
    if (kind === 'delete') {
      let existing = request.userKey ? await projection.getRow(accountId, moduleName, request.userKey) : null;
      if (existing && request.expectedHandle && String(existing.handle || '').toLowerCase() !== String(request.expectedHandle).toLowerCase()) existing = null;
      if (!existing && request.expectedHandle && !request.exactKeyOnly) {
        existing = (await projection.rowsByHandle(accountId, moduleName, [request.expectedHandle]))[0] || null;
      }
      if (!existing) return {deleted: request.userKey || null, missing: true};
      assertExpectedHandle(existing, request.expectedHandle);
      const target = await sourceTarget(existing);
      const result = {deleted: target.userKey};
      const backup = {
        operationId: request.operationId,
        kind: 'delete',
        module: target.module,
        accountId:target.accountId,
        userKey: target.userKey,
        handle: target.handle,
        sourceKey: target.sourceKey,
        sourcePath: target.sourcePath,
        removed: true,
        status: 'pending',
        savedAt: now(),
        result
      };
      await projection.commitWithBackup([target.accountId, target.module, target.userKey], null, backup);
      if (target.handle) await recomputeHandle(target.handle);
      await bumpRevision();
      await persistIncremental(backup);
      return result;
    }
    const requestedKey = request.userKey || request.record?.userKey;
    let existing = requestedKey ? await projection.getRow(accountId, moduleName, requestedKey) : null;
    if (!existing && request.record) {
      const handle = handleOf(request.record.payload || request.record);
      if (handle) {
        const groups = await projection.rowsByHandleAll(accountId, moduleName, [handle]);
        const matches = groups.flat();
        existing = matches.find(row => row.sourcePath?.[1] === 'users' || row.sourceKey === 'profileCache') || matches[0] || null;
      }
    }
    if (kind === 'patch') {
      if (!existing) throw new Error('record was not found');
      assertExpectedHandle(existing, request.expectedHandle);
      existing = await sourceTarget(existing);
      const payload = {...existing.payload, ...stripRecordMeta(request.patch || {})};
      if(await suppressRetainedRow({accountId,sourceKey:existing.sourceKey,moduleName,payload}))return {skipped:true,reason:'fan-retention'};
      const row = await materializeRow({
        previous: existing,
        payload,
        moduleName,
        accountId,
        sourcePath: existing.sourcePath,
        sourceKey: existing.sourceKey
      });
      return commitRow(existing, row, {
        operationId: request.operationId,
        kind: 'patch',
        module: moduleName,
        userKey: row.userKey,
        handle: row.handle,
        sourceKey: row.sourceKey,
        sourcePath: row.sourcePath,
        payload
      });
    }
    const record = request.record;
    const incoming = stripRecordMeta(record.payload || record);
    const payload = {...(existing?.payload || {}), ...incoming};
    delete payload.userKey;
    const sourceKey = existing?.sourceKey || legacyKeyFor(moduleName);
    const sourcePath = existing?.sourcePath || canonicalSourcePath(moduleName, sourceKey, 'users', handleOf(payload) || request.operationId);
    if(await suppressRetainedRow({accountId,sourceKey,moduleName,payload}))return {skipped:true,reason:'fan-retention'};
    const row = await materializeRow({
      previous: existing,
      payload,
      moduleName,
      accountId,
      sourcePath,
      sourceKey
    });
    return commitRow(existing, row, {
      operationId: request.operationId,
      kind: 'put',
      module: moduleName,
      userKey: row.userKey,
      handle: row.handle,
      sourceKey: row.sourceKey,
      sourcePath: row.sourcePath,
      payload
    });
  }

  async function applyBatch(request = {}) {
    await ensureOpen();
    requireReady();
    const changes = request.changes || [];
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) throw new Error('batch accepts at most 100 changes');
    if (!LEGACY_RECORD_KEYS.includes(request.sourceKey)) throw new Error('batch sourceKey is not a legacy record');
    return sequenceMutation(() => applyBatchBody(request.sourceKey, changes, request.accountId));
  }

  function canonicalSourcePath(moduleName, sourceKey, bucket, leaf) {
    if (bucket === 'map' || moduleName === 'profiles' || sourceKey === 'profileCache') return [sourceKey || 'profileCache', leaf];
    if (bucket === 'synthetic') return ['unreciprocatedTracker', 'synthetic', leaf];
    if (moduleName === 'logs' || moduleName === 'analysis' || moduleName === 'rows') return [sourceKey, leaf];
    return [sourceKey, bucket || 'users', leaf];
  }

  function moduleForBatch(sourceKey, bucket) {
    if (sourceKey === 'monitor') return 'fans';
    if (sourceKey === 'mutualNetwork') return 'mutual';
    if (sourceKey === 'commentTracking') return bucket === 'posts' ? 'posts' : 'comments';
    if (sourceKey === 'unreciprocatedTracker') return 'unreciprocated';
    if (sourceKey === 'profileCache') return 'profiles';
    if (sourceKey === 'analysisRows') return 'analysis';
    if (sourceKey === 'rows') return 'rows';
    if (sourceKey === 'autoFollowLogs' || sourceKey === 'monitorLogs' || sourceKey === 'unreciprocatedLogs') return 'logs';
    return 'extra';
  }

  function matchesBucket(row, sourceKey, bucket, identity) {
    if (bucket === 'map') return row.sourceKey === sourceKey && row.sourcePath?.length === 2;
    if (bucket === 'synthetic') return row.sourcePath?.[1] === 'synthetic' || row.sourceKey === 'derived:tracker';
    if (bucket === 'posts') {
      if (row.sourceKey !== sourceKey || row.sourcePath?.[1] !== 'posts') return false;
      if (!identity) return true;
      return String(row.payload?.id || row.payload?.tweetId || '') === identity || row.userKey === identity;
    }
    return row.sourceKey === sourceKey && row.sourcePath?.[1] === bucket;
  }

  async function sourceTarget(existing) {
    if (existing?.sourceKey !== 'derived:notMutual') return existing;
    const sourceModule = existing.sourcePath?.[0] === 'mutualNetwork' ? 'mutual' : 'fans';
    const source = await projection.getRow(existing.accountId, sourceModule, encodePath(existing.sourcePath));
    if (!source) throw new Error('derived row has no source record');
    return source;
  }

  async function applyBatchBody(sourceKey, changes, requestAccount) {
    await recoverBackups();
    let skipped = 0;
    for (const change of changes) {
      const patch = stripRecordMeta(change.patch || {});
      const handle = String(change.handle || patch.handle || '').toLowerCase();
      const bucket = change.sourceBucket || 'users';
      const moduleName = moduleForBatch(sourceKey, bucket);
      const identity = String(change.tweetId || change.userKey || patch.id || patch.tweetId || '');
      const requestedAccount = change.accountId || patch.accountId || requestAccount || null;
      let candidates = [];
      if (change.userKey && requestedAccount) {
        const row = await projection.getRow(requestedAccount, moduleName, change.userKey);
        if (row) candidates = [row];
      }
      if (!candidates.length && handle) candidates = await projection.rowsByHandleKey(handle);
      if (!candidates.length && bucket === 'posts' && identity) candidates = await projection.rowsByExternalId(sourceKey, identity);
      if (requestedAccount) candidates = candidates.filter(row => row.accountId === requestedAccount);
      let existing = candidates.find(row => matchesBucket(row, sourceKey, bucket, identity));
      if (!existing && change.userKey) {
        const accountId = requestedAccount || 'unassigned';
        existing = await projection.getRow(accountId, moduleName, change.userKey);
      }
      if (existing?.sourceKey === 'derived:notMutual') existing = await sourceTarget(existing);
      if(sourceKey==='profileCache'&&Object.hasOwn(change,'expectedTargetUserId')){
        const expected=fanId(change.expectedTargetUserId),ids=fanIds(existing?.payload||{});
        const declarations=[existing?.payload,patch].flatMap(p=>[p?.id,p?.targetUserId,p?.rest_id,p?.restId]).filter(v=>v!==null&&v!==undefined&&v!=='');
        if(!expected||declarations.some(v=>typeof v!=='string'||v!==expected)||ids.some(id=>id!==expected)||!fanIds(patch).includes(expected)){
          const error=new Error('profile cache stable user ID changed');error.name='RecordIdentityConflictError';throw error;
        }
      }
      if (sourceKey === 'monitor' && (Object.hasOwn(change,'expectedTargetUserId') || Object.hasOwn(change,'expectedOwnerAccountId') || Object.hasOwn(change,'expectedFanReviewVersion'))) {
        const reject = (name,message) => {const error=new Error(message);error.name=name;throw error;};
        if (!existing) reject('RecordIdentityConflictError','guarded fan record was not found');
        if (Object.hasOwn(change,'expectedTargetUserId')) {
          const expected=fanId(change.expectedTargetUserId),ids=fanIds(existing.payload);
          if (!expected || ids.length !== 1 || ids[0] !== expected) reject('RecordIdentityConflictError','fan record stable user ID changed');
          if (['id','rest_id','restId','targetUserId'].some(key=>Object.hasOwn(patch,key) && fanId(patch[key])!==expected)) reject('RecordIdentityConflictError','guarded fan patch changes the stable user ID');
        }
        if (Object.hasOwn(change,'expectedOwnerAccountId')) {
          const expected=change.expectedOwnerAccountId,claims=fanOwnerClaims(existing.payload);
          const legacyOwner=existing.accountId==='unassigned' ? (await projection.readState()).fanReviewLegacyOwnerAccountId : null;
          if (typeof expected!=='string' || !expected || expected==='unassigned' || claims.some(owner=>owner!==expected) || fanOwnerClaims(patch).some(owner=>owner!==expected)
            || existing.accountId!==expected && !(existing.accountId==='unassigned' && (legacyOwner===expected || claims.includes(expected)))) {
            reject('RecordIdentityConflictError','fan record owner changed');
          }
        }
        if (Object.hasOwn(change,'expectedFanReviewVersion')) {
          const expected=change.expectedFanReviewVersion,actual=Number(existing.payload.fanReview?.decisionVersion)||0;
          if (!Number.isInteger(expected) || expected<0 || expected!==actual) reject('RecordReviewConflictError','fan review decision changed');
        }
      }
      const operationId = change.operationId || crypto.randomUUID();
      const accountId = existing?.accountId || requestedAccount || patch.accountId || 'unassigned';
      if (change.remove) {
        if (!existing) continue;
        const result = {deleted: existing.userKey};
        const backup = {
          operationId, kind: 'delete', accountId:existing.accountId, module: existing.module, userKey: existing.userKey, handle: existing.handle,
          sourceKey: existing.sourceKey, sourcePath: existing.sourcePath, removed: true, status: 'pending', savedAt: now(), result
        };
        await projection.commitWithBackup([existing.accountId, existing.module, existing.userKey], null, backup);
        if (existing.handle) await recomputeHandle(existing.handle);
        await bumpRevision();
        await persistIncremental(backup);
        continue;
      }
      if (!existing && !change.create && bucket !== 'synthetic') throw new Error('batch record was not found');
      const payload = {...(existing?.payload || {}), ...patch};
      if (handle) payload.handle = patch.handle || existing?.payload?.handle || handle;
      if(await suppressRetainedRow({accountId,sourceKey,moduleName,payload})){skipped++;continue;}
      if (existing && canonicalValue(payload) === canonicalValue(existing.payload)) { skipped++; continue; }
      const leaf = identity || handle || operationId;
      const sourcePath = existing?.sourcePath || canonicalSourcePath(moduleName, sourceKey, bucket, leaf);
      const row = await materializeRow({
        previous: existing,
        payload,
        moduleName,
        accountId,
        sourcePath,
        sourceKey: bucket === 'synthetic' ? 'derived:tracker' : (existing?.sourceKey || sourceKey)
      });
      await commitRow(existing, row, {
        operationId,
        kind: 'batch',
        module: moduleName,
        userKey: row.userKey,
        handle: row.handle,
        accountId,
        sourceKey: row.sourceKey,
        sourcePath,
        payload
      });
    }
    return {updated: changes.length - skipped, skipped};
  }

  async function sourcePage(request = {}) {
    await ensureOpen();
    requireReady();
    if (!LEGACY_RECORD_KEYS.includes(request.sourceKey) && request.sourceKey !== 'derived:tracker' && request.sourceKey !== 'derived:notMutual') {
      throw new Error('sourceKey is not iterable');
    }
    const limit = request.limit == null ? 50 : request.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
    const parsed = request.cursor ? decodeCursor(request.cursor) : null;
    if (parsed && (parsed.sourceKey !== request.sourceKey || parsed.kind !== 'source' || typeof parsed.accountId !== 'string' || typeof parsed.module !== 'string')) {
      const error = new Error('cursor is invalid');
      error.name = 'RecordCursorInvalidError';
      throw error;
    }
    const page = await projection.scanBySource({
      sourceKey: request.sourceKey,
      limit,
      cursor: parsed ? {accountId: parsed.accountId, module: parsed.module, userKey: parsed.userKey} : null
    });
    const stamp = cursor => cursor ? encodeCursor({
      v: 1, kind: 'source', sourceKey: request.sourceKey, sortKey: cursor.userKey, userKey: cursor.userKey,
      module: cursor.module, accountId: cursor.accountId, tab: 'source', complex: false, filterHash: request.sourceKey, revision: 0
    }) : null;
    return {records: page.records.map(present), nextCursor: stamp(page.nextCursor)};
  }

  async function lookupAll(request = {}) {
    await ensureOpen();
    requireReady();
    const sourceKey = request.sourceKey;
    const bucket = request.bucket || request.sourceBucket;
    if (sourceKey && !LEGACY_RECORD_KEYS.includes(sourceKey) && sourceKey !== 'derived:tracker' && sourceKey !== 'derived:notMutual') {
      throw new Error('sourceKey is not iterable');
    }
    const handle = String(request.handle || '').toLowerCase();
    const tweetId = request.tweetId == null || request.tweetId === '' ? '' : String(request.tweetId);
    if (!handle && !tweetId) throw new Error('lookupAll requires a handle or tweetId');
    let rows = [];
    if (handle) rows = await projection.rowsByHandleKey(handle);
    else rows = await projection.rowsByExternalId(sourceKey || 'commentTracking', tweetId);
    if (tweetId && handle) rows = rows.filter(row => row.externalId === tweetId || String(row.payload?.tweetId || row.payload?.id || '') === tweetId);
    if (request.module) rows = rows.filter(row => row.module === request.module);
    if (request.accountId) rows = rows.filter(row => row.accountId === request.accountId);
    if (sourceKey) rows = rows.filter(row => row.sourceKey === sourceKey || (bucket === 'synthetic' && row.sourceKey === 'derived:tracker'));
    if (bucket) rows = rows.filter(row => matchesBucket(row, sourceKey || row.sourceKey, bucket, tweetId));
    if (rows.length > 100) throw new Error('lookupAll matched more than 100 rows');
    return rows.map(row => ({
      ...present(row),
      sourceKey: row.sourceKey,
      bucket: row.sourceKey === 'profileCache' && row.sourcePath?.length === 2 ? 'map' : (row.sourcePath?.[1] || null)
    }));
  }

  async function applyReplay(entry) {
    if(entry.kind==='fanRetentionOwner'&&entry.ownerId){
      const state=await projection.readState();
      if(state.fanReviewLegacyOwnerAccountId&&state.fanReviewLegacyOwnerAccountId!==entry.ownerId)throw Error('恢复的粉丝历史归属相互冲突');
      await projection.writeState({fanReviewLegacyOwnerAccountId:entry.ownerId,fanRetentionOwnerJournaled:entry.ownerId});
      // Older deletion plans can precede this newly durable owner proof. Repair
      // only affected derived trackers created while replay still lacked it.
      const affected=new Set();let cursor=null;
      do{
        const page=await projection.scanBySource({sourceKey:'derived:tracker',limit:200,cursor});
        for(const row of page.records){const marker=state.metadata?.monitor?.fanRetentionExclusions?.[entry.ownerId+':'+row.handle];
          if(marker?.scope==='fans'&&fanRowOwned(row,entry.ownerId,entry.ownerId)&&fanRetentionBlocks(marker,{sourceKey:'monitor',moduleName:row.module,payload:row.payload}))affected.add(row.handle);
        }
        cursor=page.nextCursor;
      }while(cursor);
      for(const handle of affected)await recomputeHandle(handle,replayStep);
    }else if(entry.kind==='fanRetention'&&entry.payload?.key&&entry.payload?.marker){
      const state=await projection.readState(),metadata={...(state.metadata||{})},monitor={...(metadata.monitor||{})};
      monitor.fanRetentionExclusions={...(monitor.fanRetentionExclusions||{}),[entry.payload.key]:entry.payload.marker};
      await projection.writeState({metadata:{...metadata,monitor}});
      await applyFanCleanupRows(entry.payload.removedRows);
    } else if (entry.kind === 'mergeRoot' && entry.sourceKey) {
      const state = await replayStep('read-metadata', () => projection.readState());
      const metadata = {...(state.metadata || {})};
      metadata[entry.sourceKey] = {...(metadata[entry.sourceKey] || {}), ...(entry.payload || {})};
      await replayStep('write-metadata', () => projection.writeState({metadata}));
    } else if (entry.removed) {
      if (entry.userKey && entry.module) {
        const accountId = entry.accountId || entry.result?.accountId || 'unassigned';
        const existing = await replayStep('read-row', () => projection.getRow(accountId, entry.module, entry.userKey));
        if (existing) await replayStep('delete-row', () => projection.mutateRow(null, [existing.accountId, existing.module, existing.userKey]));
      }
    } else if (entry.payload && entry.module && entry.userKey) {
      const accountId = entry.accountId || entry.result?.accountId || 'unassigned';
      if(await suppressRetainedRow({accountId,sourceKey:entry.sourceKey,moduleName:entry.module,payload:entry.payload}))return;
      const previous = await replayStep('read-row', () => projection.getRow(accountId, entry.module, entry.userKey));
      const row = await replayStep('prepare-row', () => materializeRow({
        previous,
        payload: entry.payload,
        moduleName: entry.module,
        accountId,
        sourcePath: entry.sourcePath || previous?.sourcePath || [entry.sourceKey || entry.module, entry.userKey],
        sourceKey: entry.sourceKey || previous?.sourceKey
      }));
      row.userKey = entry.userKey;
      await replayStep('write-row', () => projection.mutateRow({row, membership: membershipOf(row)}, previous ? [previous.accountId, previous.module, previous.userKey] : null));
    }
    if (entry.previousHandle && entry.previousHandle !== entry.handle) await recomputeHandle(entry.previousHandle, replayStep);
    if (entry.handle) await recomputeHandle(entry.handle, replayStep);
  }

  function replayReadError(seq, cause) {
    const error = new Error(seq == null
      ? `增量日志头读取失败，重放未完成且不会按空日志结束: ${cause?.message || cause}`
      : `增量序号 ${seq} 读取失败，重放已停止且不会越过缺口: ${cause?.message || cause}`);
    error.name = 'IncrementalReplayError';
    error.recoverable = true;
    error.reason = 'read-failed';
    if (seq != null) error.seq = seq;
    if (cause) error.cause = cause;
    return error;
  }

  function replayGapError(seq) {
    const error = new Error(`增量序号 ${seq} 缺失，重放已停止且不会越过缺口`);
    error.name = 'IncrementalReplayError';
    error.recoverable = true;
    error.reason = 'missing';
    error.seq = seq;
    return error;
  }

  async function stopReplay(error) {
    if (replayTrace) { replayTrace.finishedAt = now(); replayTrace.error = String(error?.message || error); }
    progress.stage = 'repair-required';
    progress.cutover = false;
    progress.error = String(error?.message || error);
    try {
      await projection.writeState(publicProgress());
    } catch {
      // Keep the in-memory not-ready status when the projection itself cannot be saved.
    }
    throw error;
  }

  async function replayBackups(request = {}) {
    await ensureOpen();
    const limit = request.limit == null ? 50 : request.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
    const state = await projection.readState();
    const start = request.cursor ? Number(decodeCursor(request.cursor).seq) : (Number(state.snapshotBaseSeq) || 0) + 1;
    if (!replayTrace || (!request.cursor && !request.deferReady)) beginReplayTrace(start);
    let head;
    try {
      head = await replayStep('read-head', () => readRecovery(INCREMENTAL_HEAD));
    } catch (cause) {
      await stopReplay(replayReadError(null, cause));
    }
    replayTrace.total = Number(head?.seq) || 0;
    if (!head?.seq || !Number.isInteger(start) || start < 1) return {applied: 0, nextCursor: null};
    let applied = 0;
    let seq = start;
    for (; seq <= head.seq && applied < limit; seq += 1) {
      replayTrace.seq = seq;
      replayTrace.kind = '';
      replayTrace.module = '';
      const seqKey = `${INCREMENTAL_PREFIX}seq:${String(seq).padStart(8, '0')}`;
      let entry;
      try {
        entry = await replayStep('read-entry', () => readRecovery(seqKey));
      } catch (cause) {
        await stopReplay(replayReadError(seq, cause));
      }
      if (!entry || typeof entry !== 'object') await stopReplay(replayGapError(seq));
      replayTrace.kind = String(entry.kind || 'record');
      replayTrace.module = String(entry.module || entry.sourceKey || '');
      await applyReplay(entry);
      applied += 1;
      replayTrace.completed = seq;
    }
    await replayStep('update-revision', bumpRevision);
    const nextCursor = seq <= head.seq ? encodeCursor({v: 1, kind: 'replay', seq, sortKey: String(seq), userKey: String(seq)}) : null;
    // A partial page must stay unready. Otherwise a crash reports cutover
    // before the rest of the journal is applied.
    if (nextCursor && !progress.cutover) {
      progress.stage = 'replaying';
      progress.cutover = false;
      progress.error = null;
      await replayStep('checkpoint', () => projection.writeState(publicProgress()));
    } else if (!request.deferReady && !nextCursor && !progress.cutover) {
      progress.stage = 'ready';
      progress.cutover = true;
      progress.error = null;
      await replayStep('finalize-ready', () => projection.writeState(publicProgress()));
    }
    if (!nextCursor && !request.deferReady) replayTrace.finishedAt = now();
    return {applied, nextCursor};
  }

  function assertCaller(senderUrl) {
    if (!extensionOrigin) return;
    if (!senderUrl || !senderUrl.startsWith(extensionOrigin)) throw new Error('仅扩展内部可访问记录');
  }

  async function handle(message = {}, senderUrl = '') {
    assertCaller(senderUrl);
    const op = message.op;
    if (op === 'status') {
      await ensureOpen();
      return {ok: true, status: {...publicProgress(),dataUpgrades:{replyUserIdRepair:userIdUpgradeResult}}};
    }
    if (op === 'migrate') return {ok: true, status: await migrate()};
    if (op === 'query') return {ok: true, page: await query(message)};
    if (op === 'get') return {ok: true, record: await getRecord(message)};
    if (op === 'put') return {ok: true, result: await mutate('put', message)};
    if (op === 'patch') return {ok: true, result: await mutate('patch', message)};
    if (op === 'delete') return {ok: true, result: await mutate('delete', message)};
    if(op==='fanCleanupCandidates')return {ok:true,...await fanCleanupCandidates(message)};
    if(op==='cleanupFanRecord')return {ok:true,result:await cleanupFanRecord(message)};
    if (op === 'deleteFanAccount') return {ok:true, result:await deleteFanAccount(message)};
    if (op === 'deleteLocalAccount') return {ok:true, result:await deleteLocalAccount(message)};
    if (op === 'deleteUnavailableAccount') return {ok: true, result: await deleteUnavailableAccount(message)};
    if (op === 'summary') return {ok: true, summary: await summary(message)};
    if (op === 'relations') return {ok: true, relations: await relations(message)};
    if (op === 'fanDirectory') return {ok:true,records:(await fanDirectory(message)).map(presentDirectory)};
    if (op === 'fanReviewOwner') return {ok:true,ownerAccountId:await fanReviewOwner()};
    if (op === 'migrateFanReview') return {ok:true,result:await migrateFanReview(message)};
    if (op === 'fanInspectionTargets') return {ok:true,handles:await fanInspectionTargets(message)};
    if (op === 'relationSummary') return {ok: true, summary: await relationSummary()};
    if (op === 'profiles') return {ok: true, profiles: await profiles(message)};
    if (op === 'config') return {ok: true, value: await config(message)};
    if (op === 'mergeRoot') return {ok: true, value: await mergeRoot(message.key, message.fields)};
    if (op === 'batch') return {ok: true, result: await applyBatch(message)};
    if (op === 'sourcePage') return {ok: true, page: await sourcePage(message)};
    if (op === 'lookupAll') return {ok: true, records: await lookupAll(message)};
    if (op === 'recoverBackups') return {ok: true, result: await recoverBackups()};
    if (op === 'maintainBackups') return {ok: true, result: await maintainBackups(message)};
    if (op === 'backupStatus') return {ok: true, result: await backupStatus()};
    if (op === 'backupSettings') return {ok: true, settings: await backupSettings(message.value)};
    if (op === 'replayBackups') return {ok: true, result: await replayBackups(message)};
    if (op === 'lookup') {
      await ensureOpen();
      requireReady();
      const rows = await projection.rowsByHandle(message.accountId || 'unassigned', message.module, [message.handle]);
      return {ok: true, record: rows[0] ? present(rows[0]) : null};
    }
    if (op === 'metadata') {
      await ensureOpen();
      requireReady();
      const state = await projection.readState();
      const metadata = state.metadata || {};
      return {ok: true, metadata: message.key ? (metadata[message.key] || {}) : metadata};
    }
    if (op === 'audit') return {ok: true, audit: await audit()};
    if (op === 'cancel') {
      if (typeof message.cancelToken !== 'string' || message.cancelToken === '') throw new Error('cancelToken is required');
      cancels.add(message.cancelToken);
      return {ok: true, cancelled: true};
    }
    throw new Error('unsupported record operation');
  }

  return {
    status: () => publicProgress(),
    noteLegacyChange: async changes => {
      await ensureOpen();
      if (progress.cutover) return;
      if (!changes || typeof changes !== 'object') return;
      const state = await projection.readState();
      const dirty = new Set(state.dirtyKeys || []);
      const echoHashes = {...(state.echoHashes || {})};
      for (const key of LEGACY_RECORD_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
        const value = Object.prototype.hasOwnProperty.call(changes[key] || {}, 'newValue') ? changes[key].newValue : undefined;
        if (value !== undefined && echoHashes[key] && await hashCanonical(value) === echoHashes[key]) {
          delete echoHashes[key];
          continue;
        }
        dirty.add(key);
      }
      await projection.writeState({dirtyKeys: [...dirty], echoHashes});
    },
    migrate,
    query,
    getRecord,
    summary,
    relations,
    relationSummary,
    profiles,
    config,
    putRecord: request => mutate('put', request),
    patchRecord: request => mutate('patch', request),
    deleteRecord: request => mutate('delete', request),
    sourcePage,
    lookupAll,
    fanDirectory,
    fanReviewOwner,
    fanInspectionTargets,
    migrateFanReview,
    batch: applyBatch,
    recoverBackups,
    maintainBackups,
    replayBackups,
    handle,
    cancel(token) { cancels.add(token); }
  };
}
