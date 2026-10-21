// Background and queue access to the record service. Callers pass one page
// or one handle set. This module never reads or writes a legacy module blob.

import {readAutoFollowAttempts, wasAutoFollowAttempted} from '../../shared/auto-follow-history.js';
import {evaluateMutualProfile, parseCount} from '../relationships/scoring.js';

const PAGE_LIMIT = 100;
const BIG_KEYS = new Set(['monitor', 'mutualNetwork', 'commentTracking', 'profileCache', 'unreciprocatedTracker', 'rows', 'analysisRows', 'autoFollowLogs', 'monitorLogs', 'unreciprocatedLogs']);

export function createBackgroundRecords({service, extensionUrl = ''} = {}) {
  if (!service || typeof service.handle !== 'function') throw new Error('记录服务未注入');
  async function call(message) {
    const result = await service.handle(message, extensionUrl);
    if (!result?.ok) throw new Error(result?.error || '记录操作失败');
    return result;
  }
  async function ready() {
    const {status} = await call({op: 'status'});
    if (!status?.cutover) {
      const error = new Error('记录迁移尚未完成，已停止读取旧的整包数据');
      error.name = 'RecordNotReadyError';
      throw error;
    }
    return status;
  }
  function chunks(items, size) {
    const groups = [];
    for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
    return groups;
  }
  return {
    ready,
    async metadata(key) {
      await ready();
      const {metadata} = await call({op: 'metadata', key});
      return metadata || {};
    },
    async mergeRoot(key, fields) {
      await ready();
      const {value} = await call({op: 'mergeRoot', key, fields});
      return value;
    },
    async lookup({module, handle, accountId = 'unassigned'} = {}) {
      await ready();
      const {record} = await call({op: 'lookup', module, handle, accountId});
      return record || null;
    },
    async lookupAll({sourceKey, bucket, handle, tweetId} = {}) {
      await ready();
      if (!sourceKey) throw new Error('lookupAll requires sourceKey');
      if (!handle && (tweetId == null || tweetId === '')) throw new Error('lookupAll requires a handle or tweetId');
      const result = await call({op: 'lookupAll', sourceKey, bucket, handle, tweetId});
      if (!Array.isArray(result.records)) throw new Error('lookupAll did not return records');
      return result.records;
    },
    async patch({module, userKey, patch, expectedHandle, operationId}) {
      await ready();
      const {result} = await call({op: 'patch', module, userKey, patch, expectedHandle, operationId});
      return result;
    },
    async profiles(handles) {
      await ready();
      const list = [...new Set((handles || []).map(handle => String(handle || '').replace(/^@/, '').toLowerCase()).filter(Boolean))];
      const rows = [];
      for (const group of chunks(list, PAGE_LIMIT)) {
        const {profiles} = await call({op: 'profiles', handles: group});
        rows.push(...(profiles || []));
      }
      return rows;
    },
    async relations(handles) {
      await ready();
      const list = [...new Set((handles || []).map(handle => String(handle || '').replace(/^@/, '').toLowerCase()).filter(Boolean))];
      const rows = [];
      for (const group of chunks(list, PAGE_LIMIT)) {
        const {relations} = await call({op: 'relations', handles: group});
        rows.push(...(relations || []));
      }
      return rows;
    },
    async sourcePage({sourceKey, limit = PAGE_LIMIT, cursor = null} = {}) {
      await ready();
      const size = Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > PAGE_LIMIT) throw new Error('limit must be an integer from 1 to 100');
      const {page} = await call({op: 'sourcePage', sourceKey, limit: size, cursor});
      return page || {records: [], nextCursor: null};
    },
    async batch({sourceKey, changes} = {}) {
      await ready();
      const list = changes || [];
      let updated = 0;
      for (const group of chunks(list, PAGE_LIMIT)) {
        if (!group.length) continue;
        const {result} = await call({op: 'batch', sourceKey, changes: group});
        updated += Number(result?.updated) || group.length;
      }
      return {updated};
    }
  };
}

export async function selectCommentCandidates(records, cfg = {}, storage = globalThis.chrome?.storage?.local) {
  const cap = Math.max(1, Math.min(20, Number(cfg.batchLimit) || 10));
  const processed = new Set((cfg.processedHandles || []).map(handle => String(handle || '').toLowerCase()));
  const minFollowers = Math.max(0, Number(cfg.minFollowers) || 0);
  const chosen = [];
  let cursor = null;
  do {
    const page = await records.sourcePage({sourceKey: 'commentTracking', limit: 100, cursor});
    const users = [];
    for (const row of page.records || []) {
      const bucket = row.bucket || row.sourcePath?.[1];
      if (bucket === 'users' && row.payload?.handle) users.push(row.payload);
    }
    const attempts = users.length ? await readAutoFollowAttempts(users, storage) : {};
    const relations = users.length ? await records.relations(users.map(user => user.handle)) : [];
    const following = new Set(relations.filter(row => row.following).map(row => String(row.handle || '').toLowerCase()));
    for (const user of users) {
      const handle = String(user.handle || '').toLowerCase();
      if (!handle || processed.has(handle) || wasAutoFollowAttempted(handle, attempts)) continue;
      if (['skipped', 'followed', 'failed'].includes(user.autoFollowState)) continue;
      const mutual = user.relationship?.following === true && user.relationship?.followedBy === true;
      if (user.followedAt || following.has(handle) || user.relationship?.following === true || mutual) continue;
      const known = parseCount(String(user.followersText || ''));
      if (known !== null && known < minFollowers) continue;
      const pre = evaluateMutualProfile(user);
      if (pre.countsKnown && pre.isNotRecommended) continue;
      chosen.push(user);
      if (chosen.length >= cap) return chosen;
    }
    cursor = page.nextCursor || null;
  } while (cursor);
  return chosen;
}

export async function mergeCollectedReplies(records, {post, replies, mergeCommentTracking}) {
  const wanted = [...new Set((replies || []).map(reply => String(reply?.handle || '').replace(/^@/, '').toLowerCase()).filter(Boolean))];
  const existing = [];
  for (const handle of wanted) {
    const rows = await records.lookupAll({sourceKey: 'commentTracking', bucket: 'users', handle});
    const row = rows.find(item => (item.bucket || item.sourcePath?.[1]) === 'users') || rows[0];
    if (row?.payload) existing.push(structuredClone(row.payload));
  }
  const postRows = await records.lookupAll({sourceKey: 'commentTracking', bucket: 'posts', tweetId: String(post.tweetId)});
  const postRow = postRows.find(item => item.payload?.tweetId === post.tweetId) || postRows[0] || null;
  const merged = mergeCommentTracking({
    users: existing,
    posts: postRow?.payload ? [structuredClone(postRow.payload)] : []
  }, post, replies);
  const changes = [];
  for (const user of merged.users || []) {
    const handle = String(user.handle || '').toLowerCase();
    if (!wanted.includes(handle)) continue;
    changes.push({
      handle,
      sourceBucket: 'users',
      create: !existing.some(item => String(item.handle || '').toLowerCase() === handle),
      patch: user
    });
  }
  if (changes.length) await records.batch({sourceKey: 'commentTracking', changes});
  const nextPost = (merged.posts || []).find(item => item.tweetId === post.tweetId);
  if (nextPost && postRow?.userKey) {
    await records.patch({module: 'posts', userKey: postRow.userKey, patch: nextPost, operationId: `comment-post:${post.tweetId}:${nextPost.collectedAt || ''}`});
  } else if (nextPost) {
    await records.batch({sourceKey: 'commentTracking', changes: [{
      handle: String(post.tweetId),
      sourceBucket: 'posts',
      create: true,
      patch: {...nextPost, handle: String(post.tweetId), tweetId: post.tweetId}
    }]});
  }
  return {handles: changes.map(change => change.handle), tweetId: post.tweetId};
}

export function isWholeModuleRead(keys) {
  if (keys == null) return true;
  const list = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys));
  return list.some(key => BIG_KEYS.has(key));
}
