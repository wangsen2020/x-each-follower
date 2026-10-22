// Live record service. Archive migration stays lossless and immutable.
// Dashboard pages use the projection index. Legacy modules are merged, never replaced by a page.

import {canonicalValue, createRecordRepository} from './record-repository.js';
import {createRecordMigration, hashCanonical, flattenLegacySnapshot, moduleForPath} from './record-migration.js';
import {createRecordProjection} from './record-projection.js';
import {filterMutualTrackingUsers} from '../relationships/scoring.js';
import {mutualUserCategory, personalRelationshipLabel} from '../relationships/network-api.js';
import {applyRelationshipSnapshot, buildRelationshipIndex, commentRelationshipLabel, deriveNotMutualUsers, deriveTrackerUsers} from '../relationships/relationship-rules.js';
import {createStorageWriteQueue} from '../../platform/storage-write-queue.js';

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
    return ['all', payload?.status || 'pending'];
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
    const rank = payload?.status === 'overdue' ? '0' : '1';
    return `${rank}|${String(payload?.followedAt || '')}|${tie}|${handle}`;
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
    const rank = row => row.payload?.status === 'overdue' ? 0 : 1;
    return rank(a) - rank(b)
      || (Date.parse(a.payload?.followedAt) || 0) - (Date.parse(b.payload?.followedAt) || 0)
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
  return [payload.handle, payload.name, payload.bio, payload.text, payload.event, replies, posts]
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
    return clone(progress);
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
        v1Keys = allBackupKeys.filter(k => !k.startsWith('recordLegacySnapshotBackup:v2:'));
      }
      const v1Candidates = [];
      for (const key of v1Keys) {
        const item = await readRecovery(key);
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

  async function ensureOpen() {
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
    progress.stage = 'replaying';
    progress.cutover = false;
    progress.error = null;
    await projection.writeState(publicProgress());
    let cursor = null;
    for (;;) {
      const page = await replayBackups({limit: 100, cursor, deferReady: true});
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
      progress.stage = 'replaying';
      progress.cutover = false;
      progress.error = null;
      await projection.writeState(publicProgress());
    }
  }

  async function commitReadyProjection() {
    await absorbPendingDirty();
    await replayIncrementalAfterRebuild();
    const pending = [...await dirtyKeys()];
    progress.stage = 'ready';
    progress.completed = progress.total;
    progress.cutover = true;
    progress.error = null;
    await projection.writeState({...publicProgress(), dirtyKeys: pending});
    return publicProgress();
  }

  async function migrate() {
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
        progress.stage = 'discovering';
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

  async function query(request = {}) {
    await ensureOpen();
    requireReady();
    const moduleName = request.module;
    if (!RECORD_MODULES.includes(moduleName)) throw new Error('module is not queryable');
    const limit = request.limit == null ? 50 : request.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
    const accountId = request.accountId || 'unassigned';
    await flushDirty(moduleName);
    const filter = request.filter && typeof request.filter === 'object' ? request.filter : {};
    const tab = filter.tab || 'all';
    const complex = Boolean(filter.search || (filter.tags && filter.tags.length));
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
    const onStep = hooks.onCursorStep;
    if (!complex) {
      const page = await projection.queryPage({
        accountId,
        module: moduleName,
        tab,
        limit,
        cursor: parsed,
        onStep
      });
      if (page.scanned > limit + 1) throw new Error('index page scanned more than one extra row');
      return {records: page.records.map(present), nextCursor: stamp(page.nextCursor), scanned: page.scanned, matched: null, revision};
    }
    const token = request.cancelToken || null;
    const records = [];
    let scanned = 0;
    let resume = parsed;
    let cancelled = false;
    while (records.length < limit) {
      const batch = await projection.scanBatches({
        accountId,
        module: moduleName,
        tab,
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
      records: records.map(present),
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
    return projection.getSummary(request.accountId || 'unassigned', request.module);
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

  function trackerTemplate(source) {
    const user = source.payload || {};
    const followedBy = user.relationship?.followedBy === true;
    return {
      id: user.id || '',
      handle: user.handle,
      name: user.name || user.handle,
      avatarUrl: user.avatarUrl || '',
      bio: user.bio || '',
      followersText: user.followersText || '',
      followingText: user.followingText || '',
      followedAt: user.followedAt || '',
      followBackAt: user.followBackAt || null,
      relationship: {following: true, followedBy},
      status: followedBy ? 'mutual' : 'pending',
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

  async function recomputeHandle(handle) {
    if (!handle) return;
    const rows = await projection.rowsByHandleKey(handle);
    const monitor = rows.filter(row => row.sourceKey === 'monitor');
    const users = monitor.filter(row => row.sourcePath?.[1] === 'users');
    const following = monitor.filter(row => row.sourcePath?.[1] === 'followingUsers');
    const queue = monitor.filter(row => row.sourcePath?.[1] === 'queue');
    let relation = null;
    if (users.length || following.length || queue.length) {
      const current = (await projection.getRelations([handle]))[0] || {handle};
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
      await projection.upsertRelation(relation);
    } else {
      await projection.deleteRelation(handle);
    }
    const chosen = notMutualSource(rows);
    const derived = rows.find(row => row.sourceKey === 'derived:notMutual');
    if (!chosen && derived) await projection.mutateRow(null, [derived.accountId, derived.module, derived.userKey]);
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
      await projection.mutateRow({row: next, membership: membershipOf(next)}, derived ? [derived.accountId, derived.module, derived.userKey] : null);
    }
    const real = rows.find(row => row.sourceKey === 'unreciprocatedTracker' && row.sourcePath?.[1] === 'users');
    const synthetic = rows.find(row => row.sourceKey === 'derived:tracker' || row.sourcePath?.[1] === 'synthetic');
    const source = trackerSource(rows);
    if (real && synthetic) await projection.mutateRow(null, [synthetic.accountId, synthetic.module, synthetic.userKey]);
    if (!real && source) {
      const generated = trackerTemplate(source);
      const previous = synthetic?.payload || {};
      const keepStatus = previous.status && previous.status !== 'pending' && previous.status !== 'mutual';
      const payload = {
        ...generated,
        status: keepStatus ? previous.status : generated.status,
        exempt: previous.exempt === true ? true : generated.exempt
      };
      const next = await materializeRow({
        previous: synthetic,
        payload,
        moduleName: 'unreciprocated',
        accountId: synthetic?.accountId || source.accountId || 'unassigned',
        sourcePath: ['unreciprocatedTracker', 'synthetic', handle],
        sourceKey: 'derived:tracker'
      });
      next.userKey = synthetic?.userKey || `derived-tracker/${handle}`;
      await projection.mutateRow({row: next, membership: membershipOf(next)}, synthetic ? [synthetic.accountId, synthetic.module, synthetic.userKey] : null);
    } else if (!real && !source && synthetic) {
      await projection.mutateRow(null, [synthetic.accountId, synthetic.module, synthetic.userKey]);
    }
    await refreshBoundViews(handle, relation, rows);
  }

  async function commitRow(previous, row, entry) {
    const saved = present(row);
    const backup = {...entry, status: 'pending', savedAt: now(), result: saved};
    await projection.commitWithBackup(
      previous ? [previous.accountId, previous.module, previous.userKey] : null,
      {row, membership: membershipOf(row)},
      backup
    );
    if (row.handle) await recomputeHandle(row.handle);
    await bumpRevision();
    await persistIncremental(backup);
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

  async function mutate(kind, request = {}) {
    await ensureOpen();
    requireReady();
    return sequenceMutation(() => applyMutation(kind, request));
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
    const accountId = accountOf(request.record || request.patch || {}, request.accountId);
    if (kind === 'delete') {
      let existing = request.userKey ? await projection.getRow(accountId, moduleName, request.userKey) : null;
      if (existing && request.expectedHandle && String(existing.handle || '').toLowerCase() !== String(request.expectedHandle).toLowerCase()) existing = null;
      if (!existing && request.expectedHandle) {
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
      const operationId = change.operationId || crypto.randomUUID();
      const accountId = existing?.accountId || requestedAccount || patch.accountId || 'unassigned';
      if (change.remove) {
        if (!existing) continue;
        const result = {deleted: existing.userKey};
        const backup = {
          operationId, kind: 'delete', module: existing.module, userKey: existing.userKey, handle: existing.handle,
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
    return {updated: changes.length};
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
    if (entry.kind === 'mergeRoot' && entry.sourceKey) {
      const state = await projection.readState();
      const metadata = {...(state.metadata || {})};
      metadata[entry.sourceKey] = {...(metadata[entry.sourceKey] || {}), ...(entry.payload || {})};
      await projection.writeState({metadata});
    } else if (entry.removed) {
      if (entry.userKey && entry.module) {
        const accountId = entry.accountId || entry.result?.accountId || 'unassigned';
        const existing = await projection.getRow(accountId, entry.module, entry.userKey);
        if (existing) await projection.mutateRow(null, [existing.accountId, existing.module, existing.userKey]);
      }
    } else if (entry.payload && entry.module && entry.userKey) {
      const accountId = entry.accountId || entry.result?.accountId || 'unassigned';
      const previous = await projection.getRow(accountId, entry.module, entry.userKey);
      const row = await materializeRow({
        previous,
        payload: entry.payload,
        moduleName: entry.module,
        accountId,
        sourcePath: entry.sourcePath || previous?.sourcePath || [entry.sourceKey || entry.module, entry.userKey],
        sourceKey: entry.sourceKey || previous?.sourceKey
      });
      row.userKey = entry.userKey;
      await projection.mutateRow({row, membership: membershipOf(row)}, previous ? [previous.accountId, previous.module, previous.userKey] : null);
    }
    if (entry.handle) await recomputeHandle(entry.handle);
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
    let head;
    try {
      head = await readRecovery(INCREMENTAL_HEAD);
    } catch (cause) {
      await stopReplay(replayReadError(null, cause));
    }
    const start = request.cursor ? Number(decodeCursor(request.cursor).seq) : 1;
    if (!head?.seq || !Number.isInteger(start) || start < 1) return {applied: 0, nextCursor: null};
    let applied = 0;
    let seq = start;
    for (; seq <= head.seq && applied < limit; seq += 1) {
      const seqKey = `${INCREMENTAL_PREFIX}seq:${String(seq).padStart(8, '0')}`;
      let entry;
      try {
        entry = await readRecovery(seqKey);
      } catch (cause) {
        await stopReplay(replayReadError(seq, cause));
      }
      if (!entry || typeof entry !== 'object') await stopReplay(replayGapError(seq));
      await applyReplay(entry);
      applied += 1;
    }
    await bumpRevision();
    const nextCursor = seq <= head.seq ? encodeCursor({v: 1, kind: 'replay', seq, sortKey: String(seq), userKey: String(seq)}) : null;
    // A partial page must stay unready. Otherwise a crash reports cutover
    // before the rest of the journal is applied.
    if (nextCursor && !progress.cutover) {
      progress.stage = 'replaying';
      progress.cutover = false;
      progress.error = null;
      await projection.writeState(publicProgress());
    } else if (!request.deferReady && !nextCursor && !progress.cutover) {
      progress.stage = 'ready';
      progress.cutover = true;
      progress.error = null;
      await projection.writeState(publicProgress());
    }
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
      return {ok: true, status: publicProgress()};
    }
    if (op === 'migrate') return {ok: true, status: await migrate()};
    if (op === 'query') return {ok: true, page: await query(message)};
    if (op === 'get') return {ok: true, record: await getRecord(message)};
    if (op === 'put') return {ok: true, result: await mutate('put', message)};
    if (op === 'patch') return {ok: true, result: await mutate('patch', message)};
    if (op === 'delete') return {ok: true, result: await mutate('delete', message)};
    if (op === 'summary') return {ok: true, summary: await summary(message)};
    if (op === 'relations') return {ok: true, relations: await relations(message)};
    if (op === 'relationSummary') return {ok: true, summary: await relationSummary()};
    if (op === 'profiles') return {ok: true, profiles: await profiles(message)};
    if (op === 'config') return {ok: true, value: await config(message)};
    if (op === 'mergeRoot') return {ok: true, value: await mergeRoot(message.key, message.fields)};
    if (op === 'batch') return {ok: true, result: await applyBatch(message)};
    if (op === 'sourcePage') return {ok: true, page: await sourcePage(message)};
    if (op === 'lookupAll') return {ok: true, records: await lookupAll(message)};
    if (op === 'recoverBackups') return {ok: true, result: await recoverBackups()};
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
    recoverBackups,
    replayBackups,
    handle,
    cancel(token) { cancels.add(token); }
  };
}
