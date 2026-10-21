import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {durableGet, durableSet, durableKeys, durableAppendIncremental} from '../src/platform/persistent-db.js';

function dropNullFields(value) {
  if (Array.isArray(value)) return value.map(dropNullFields);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null) out[key] = dropNullFields(item);
    }
    return out;
  }
  return value;
}

test('durable transport keeps nulls that object scripting args would drop', async () => {
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  globalThis.chrome = {
    tabs: {
      query: async () => [{id: 7}],
      get: async () => ({id: 7, status: 'complete'})
    },
    scripting: {
      executeScript: async ({func, args}) => {
        const transported = args.map(arg => typeof arg === 'string' ? arg : dropNullFields(arg));
        const result = await func(...transported);
        return [{result: typeof result === 'string' ? result : dropNullFields(result)}];
      }
    }
  };
  const value = {
    nextEligibleAt: null,
    followBackAt: null,
    config: {lastRunAt: null, keep: 1},
    nested: [null, {id: 2, gone: null}]
  };
  await durableSet('sample', value);
  const direct = dropNullFields(value);
  assert.equal(Object.hasOwn(direct, 'nextEligibleAt'), false);
  const loaded = await durableGet('sample');
  assert.equal(loaded.nextEligibleAt, null);
  assert.equal(loaded.followBackAt, null);
  assert.equal(loaded.config.lastRunAt, null);
  assert.equal(loaded.config.keep, 1);
  assert.equal(loaded.nested[0], null);
  assert.equal(loaded.nested[1].id, 2);
  assert.equal(loaded.nested[1].gone, null);
  assert.equal(Object.hasOwn(loaded, 'missing'), false);
  assert.equal(await durableGet('absent'), undefined);
  const opened = indexedDB.open('x-each-follower', 1);
  const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore('records').put({note: null, items: [1, null]}, 'legacy-raw');
  });
  const legacy = await durableGet('legacy-raw');
  assert.equal(legacy.note, null);
  assert.equal(legacy.items[1], null);
});

test('durableKeys and durableAppendIncremental handle atomic transactions and lagging head reconciliation', async () => {
  // 1. durableKeys
  await durableSet('recordLegacySnapshotBackup:v2:hash1', {fingerprint: 'hash1', snapshot: {rows: [1]}});
  await durableSet('recordLegacySnapshotBackup:v2:hash2', {fingerprint: 'hash2', snapshot: {rows: [2]}});
  await durableSet('otherKey', {rows: []});
  const keys = await durableKeys('recordLegacySnapshotBackup:v2:');
  assert.equal(keys.length, 2);
  assert.equal(keys[0], 'recordLegacySnapshotBackup:v2:hash1');
  assert.equal(keys[1], 'recordLegacySnapshotBackup:v2:hash2');

  // 2. durableAppendIncremental
  const entry1 = {operationId: 'op-1', kind: 'batch', module: 'comments', userKey: 'u1'};
  const res1 = await durableAppendIncremental(entry1);
  assert.equal(res1.seq, 1);
  assert.equal(res1.status, 'stored');
  const head1 = await durableGet('recordIncremental:v1:head');
  assert.equal(head1.seq, 1);
  assert.equal(head1.operationId, 'op-1');

  // 3. Idempotent retry with same operationId
  const res1Retry = await durableAppendIncremental(entry1);
  assert.equal(res1Retry.seq, 1);

  // 4. Simulate lagging head: manually set head back to 0 while seq 1 exists
  await durableSet('recordIncremental:v1:head', {seq: 0, operationId: 'op-0'});
  const entry2 = {operationId: 'op-2', kind: 'batch', module: 'comments', userKey: 'u2'};
  const res2 = await durableAppendIncremental(entry2);
  assert.equal(res2.seq, 2); // Automatically reconciled head and assigned 2!
  const head2 = await durableGet('recordIncremental:v1:head');
  assert.equal(head2.seq, 2);
  assert.equal(head2.operationId, 'op-2');

  // 5. Append 30 additional entries so op-1 is well beyond the old 20-entry window
  for (let i = 3; i <= 35; i++) {
    await durableAppendIncremental({operationId: `op-${i}`, kind: 'batch', module: 'comments', userKey: `u${i}`});
  }
  const headAfter35 = await durableGet('recordIncremental:v1:head');
  assert.equal(headAfter35.seq, 35);

  // 6. Retry early operation op-1 (34 entries back, > 20 window): must be recognized as duplicate!
  const resEarlyRetry = await durableAppendIncremental(entry1);
  assert.equal(resEarlyRetry.seq, 1);
  const headAfterRetry = await durableGet('recordIncremental:v1:head');
  assert.equal(headAfterRetry.seq, 35); // Head not rolled back
});
