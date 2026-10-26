import test, {beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory, IDBKeyRange, IDBObjectStore} from 'fake-indexeddb';
import {durableGetStrict, durableSet, durableKeysStrict, durableAppendIncremental, durableCompactSnapshots} from '../src/platform/persistent-db.js';

let connections, dispatches, originalPut;
beforeEach(() => {
  connections = []; dispatches = [];
  const factory = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  globalThis.indexedDB = {open(...args) {
    const request = factory.open(...args);
    request.addEventListener('success', () => {
      const db = request.result, close = db.close.bind(db), item = {closes: 0};
      connections.push(item);
      db.close = () => { item.closes++; close(); };
    });
    return request;
  }};
  globalThis.chrome = {
    tabs: {query: async () => [{id: 7, status: 'complete', url: 'https://x.com/home'}], get: async () => ({id: 7, status: 'complete'})},
    scripting: {executeScript: async ({func, args}) => {
      dispatches.push(args[0]);
      // executeScript serializes this function: no module closures may be required.
      const injected = (0, eval)(`(${func.toString()})`);
      return [{result: await injected(...args)}];
    }}
  };
  originalPut = IDBObjectStore.prototype.put;
});
afterEach(() => { IDBObjectStore.prototype.put = originalPut; });

function abortAfterPut(key) {
  IDBObjectStore.prototype.put = function (value, actualKey) {
    const request = originalPut.call(this, value, actualKey), tx = this.transaction;
    if (actualKey === key) request.addEventListener('success', () => tx.abort(), {once: true});
    return request;
  };
}

test('an aborted append rejects, rolls back atomically and releases the next queued read without retrying', {timeout: 2000}, async () => {
  const first = await durableAppendIncremental({operationId: 'kept', payload: {value: 1}});
  assert.equal(first.seq, 1);
  abortAfterPut('recordIncremental:v1:head');
  const before = dispatches.length;
  const failed = durableAppendIncremental({operationId: 'aborted', payload: {value: 2}});
  const nextRead = durableGetStrict('recordIncremental:v1:head');
  await assert.rejects(failed, /事务已中止|abort/i);
  assert.equal((await nextRead).seq, 1);
  assert.deepEqual(dispatches.slice(before), ['appendIncremental', 'get']);
  assert.equal(await durableGetStrict('recordIncremental:v1:seq:00000002'), undefined);
  assert.equal(await durableGetStrict('recordIncremental:v1:op:aborted'), undefined);
  IDBObjectStore.prototype.put = originalPut;
  const explicitRetry = await durableAppendIncremental({operationId: 'aborted', payload: {value: 2}});
  assert.equal(explicitRetry.seq, 2);
  assert.equal((await durableAppendIncremental({operationId: 'aborted', payload: {value: 2}})).seq, 2);
  assert.equal((await durableGetStrict('recordIncremental:v1:head')).seq, 2);
  assert.ok(connections.every(item => item.closes === 1));
});

test('ordinary backup writes wait for commit and preserve the previous value on abort', {timeout: 2000}, async () => {
  await durableSet('backup', {value: 'original'});
  abortAfterPut('backup');
  await assert.rejects(durableSet('backup', {value: 'lost'}), /事务已中止|abort/i);
  assert.deepEqual(await durableGetStrict('backup'), {value: 'original'});
  assert.deepEqual(dispatches, ['set', 'set', 'get']);
  assert.ok(connections.every(item => item.closes === 1));
});

test('successful reads, missing reads and key scans all release their connection', async () => {
  await durableSet('kept', {value: 1});
  for (let i = 0; i < 25; i++) await durableGetStrict(i % 2 ? 'kept' : 'missing');
  assert.deepEqual(await durableKeysStrict('kept'), ['kept']);
  assert.equal(connections.length, 27);
  assert.ok(connections.every(item => item.closes === 1));
});

test('blocked opens release the queue and close a late connection without replaying the operation', {timeout: 8000}, async () => {
  const normal = globalThis.indexedDB;
  let pending, lateCloses = 0;
  globalThis.indexedDB = {open() {
    pending = {};
    queueMicrotask(() => pending.onblocked());
    return pending;
  }};
  await assert.rejects(durableSet('blocked-write', {value: 1}), /旧连接阻塞/);
  pending.result = {close() { lateCloses++; }};
  pending.onsuccess();
  assert.equal(lateCloses, 1);
  globalThis.indexedDB = normal;
  assert.equal(await durableGetStrict('blocked-write'), undefined);
  assert.deepEqual(dispatches, ['set', 'get']);
});


test('indexed appends do not deserialize the historical tail again and retries stay idempotent', async () => {
  await durableSet('recordIncremental:v1:seq:00000001', {seq: 1, operationId: 'legacy'});
  await durableSet('recordIncremental:v1:head', {seq: 1});
  const original = IDBObjectStore.prototype.getAll;
  let reads = 0;
  IDBObjectStore.prototype.getAll = function (...args) { reads++; return original.apply(this, args); };
  try {
    assert.equal((await durableAppendIncremental({operationId: 'new-one'})).seq, 2);
    assert.equal(reads, 1);
    for (let i = 0; i < 10; i++) await durableAppendIncremental({operationId: 'more-' + i});
    assert.equal(reads, 1);
    assert.equal((await durableAppendIncremental({operationId: 'legacy'})).seq, 1);
    assert.equal((await durableAppendIncremental({operationId: 'new-one'})).seq, 2);
    assert.equal((await durableGetStrict('recordIncremental:v1:head')).seq, 12);
  } finally { IDBObjectStore.prototype.getAll = original; }
});


test('validated append checks only the tail and an imported gap invalidates the checkpoint', async () => {
  await durableAppendIncremental({operationId: 'first'});
  const original = IDBObjectStore.prototype.getAllKeys;
  let lower;
  IDBObjectStore.prototype.getAllKeys = function (range, ...rest) { lower = range?.lower; return original.call(this, range, ...rest); };
  try {
    await durableAppendIncremental({operationId: 'second'});
    assert.equal(lower, 'recordIncremental:v1:seq:00000001');
    await durableAppendIncremental({operationId: 'third'});
    assert.equal(lower, 'recordIncremental:v1:seq:00000002');
    await durableSet('recordIncremental:v1:seq:00000005', {seq: 5, operationId: 'imported-gap'});
    await assert.rejects(durableAppendIncremental({operationId: 'after-gap'}), /gap/);
    assert.equal(lower, 'recordIncremental:v1:seq:');
    assert.equal(await durableGetStrict('recordIncremental:v1:seq:00000004'), undefined);
  } finally { IDBObjectStore.prototype.getAllKeys = original; }
});

test('snapshot compaction is guarded, atomic, retains three restore points and preserves unrelated logs', async () => {
  const compact = async (id, seq) => {
    await durableSet('recordSnapshots:v1:image:' + id, {seq, fingerprint: id});
    await durableSet('recordLogArchives:v1:' + id, {logs: {rows: []}});
    return durableCompactSnapshots({expectedHead: seq, snapshot: {id, seq, fingerprint: id, verified: true}});
  };
  await durableSet('executionLog:keep', {important: true});
  await durableAppendIncremental({operationId: 'one'});
  await assert.rejects(durableCompactSnapshots({expectedHead: 0, snapshot: {id: 'bad'}}), /变化/);
  await durableSet('recordSnapshots:v1:image:unverified', {seq: 1, fingerprint: 'bad'});
  await assert.rejects(durableCompactSnapshots({expectedHead: 1, snapshot: {id: 'unverified', fingerprint: 'bad'}}), /验证/);
  abortAfterPut('recordSnapshots:v1:catalog');
  await assert.rejects(compact('a', 1), /中止|失败|abort/);
  assert.equal((await durableGetStrict('recordIncremental:v1:seq:00000001')).operationId, 'one');
  IDBObjectStore.prototype.put = originalPut;
  assert.equal((await compact('a', 1)).deleted, 1);
  assert.equal((await durableAppendIncremental({operationId: 'one'})).seq, 1);
  assert.equal((await durableAppendIncremental({operationId: 'two'})).seq, 2);
  await compact('b', 2);
  await durableAppendIncremental({operationId: 'three'});
  await compact('c', 3);
  await durableAppendIncremental({operationId: 'four'});
  const result = await compact('d', 4);
  assert.equal(result.retained, 3);
  assert.equal(result.compactedThrough, 2);
  assert.equal(await durableGetStrict('recordSnapshots:v1:image:a'), undefined);
  assert.equal(await durableGetStrict('recordIncremental:v1:seq:00000002'), undefined);
  assert.equal((await durableGetStrict('recordIncremental:v1:seq:00000003')).seq, 3);
  assert.deepEqual(await durableGetStrict('executionLog:keep'), {important: true});
  assert.equal((await durableAppendIncremental({operationId: 'five'})).seq, 5);
});
