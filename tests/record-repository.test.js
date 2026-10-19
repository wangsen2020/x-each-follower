import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import {createRecordRepository, RecordCursorInvalidError, RECORD_PAGE_MAX} from '../record-repository.js';

function repo(name) {
  return createRecordRepository({indexedDB, IDBKeyRange, dbName: name, now: () => 1000});
}

function record(userKey, sortKey, extra = {}) {
  return {userKey, sortKey, ...extra};
}

test('preserves unknown fields and string ids', async () => {
  const store = repo('records-fields');
  const tweetId = '9007199254740993';
  const saved = await store.putRecords({
    accountId: 'acct-1',
    module: 'comments',
    operationId: 'op-fields',
    records: [record('user-1', 's', {tweetId, legacyNote: {kept: true}, status: 'open'})]
  });
  assert.equal(typeof saved.records[0].tweetId, 'string');
  assert.equal(saved.records[0].tweetId, tweetId);
  assert.deepEqual(saved.records[0].legacyNote, {kept: true});
  const again = await store.putRecords({
    accountId: 'acct-1',
    module: 'comments',
    operationId: 'op-fields-2',
    records: [record('user-1', 's', {status: 'open'})]
  });
  assert.equal(again.records[0].tweetId, tweetId);
  assert.deepEqual(again.records[0].legacyNote, {kept: true});
  assert.equal((await store.getRecord('acct-1', 'comments', 'user-1')).id, 'user-1');
  await assert.rejects(() => store.putRecords({
    accountId: 'acct-1', module: 'comments', operationId: 'op-num', records: [{userKey: 15, sortKey: 's'}]
  }), /string/);
  await assert.rejects(() => store.putRecords({
    accountId: 'acct-1', module: 'comments', operationId: 'op-sort', records: [{userKey: 'user-2', sortKey: 2}]
  }), /sortKey/);
});

test('pages with a stable keyset and isolates account and module', async () => {
  const store = repo('records-page');
  const sortFor = {a: '1', b: '1', c: '2', d: '3', e: '4'};
  const records = ['c', 'a', 'b', 'd', 'e'].map(userKey => record(userKey, sortFor[userKey], {status: userKey === 'e' ? 'closed' : 'open'}));
  await store.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-page', records});
  await store.putRecords({accountId: 'acct-2', module: 'fans', operationId: 'op-other-account', records: [record('a', 'same', {status: 'open'})]});
  await store.putRecords({accountId: 'acct-1', module: 'mutual', operationId: 'op-other-module', records: [record('a', 'same', {status: 'open'})]});
  const first = await store.queryPage({accountId: 'acct-1', module: 'fans', limit: 2});
  assert.deepEqual(first.records.map(item => item.userKey), ['a', 'b']);
  const second = await store.queryPage({accountId: 'acct-1', module: 'fans', limit: 2, cursor: first.nextCursor});
  assert.deepEqual(second.records.map(item => item.userKey), ['c', 'd']);
  const third = await store.queryPage({accountId: 'acct-1', module: 'fans', limit: 2, cursor: second.nextCursor});
  assert.deepEqual(third.records.map(item => item.userKey), ['e']);
  assert.equal(third.nextCursor, null);
  const filtered = await store.queryPage({accountId: 'acct-1', module: 'fans', filter: {status: 'open'}, limit: 10});
  assert.deepEqual(filtered.records.map(item => item.userKey), ['a', 'b', 'c', 'd']);
  const backward = await store.queryPage({accountId: 'acct-1', module: 'fans', sort: 'desc', limit: 2});
  assert.deepEqual(backward.records.map(item => item.userKey), ['e', 'd']);
  const backwardNext = await store.queryPage({accountId: 'acct-1', module: 'fans', sort: 'desc', limit: 2, cursor: backward.nextCursor});
  assert.deepEqual(backwardNext.records.map(item => item.userKey), ['c', 'b']);
  await assert.rejects(() => store.queryPage({accountId: 'acct-1', module: 'fans', limit: RECORD_PAGE_MAX + 1}), /limit/);
  await assert.rejects(() => store.queryPage({accountId: 'acct-1', module: 'fans', filter: {q: 'ada'}, limit: 10}), /unsupported filter/);
});

test('invalidates a cursor after a committed revision change', async () => {
  const store = repo('records-revision');
  await store.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-1', records: [record('a', '1'), record('b', '2'), record('c', '3')]});
  const page = await store.queryPage({accountId: 'acct-1', module: 'fans', limit: 1});
  await store.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-2', records: [record('d', '4')]});
  await assert.rejects(() => store.queryPage({accountId: 'acct-1', module: 'fans', limit: 1, cursor: page.nextCursor}), RecordCursorInvalidError);
  const fresh = await store.queryPage({accountId: 'acct-1', module: 'fans', limit: 100});
  assert.equal(fresh.records.length, 4);
  assert.equal(fresh.revision, 2);
});

test('commits records, summary, and outbox together and replays an operation id', async () => {
  const store = repo('records-atomic');
  const written = await store.putRecords({
    accountId: 'acct-1',
    module: 'logs',
    operationId: 'op-atomic',
    summaryPatch: {label: 'kept'},
    records: [record('a', '1', {body: 'one'}), record('b', '2')]
  });
  assert.equal(written.revision, 1);
  assert.equal(written.summary.count, 2);
  assert.equal(written.summary.label, 'kept');
  const replay = await store.putRecords({
    accountId: 'acct-1',
    module: 'logs',
    operationId: 'op-atomic',
    summaryPatch: {label: 'kept'},
    records: [record('a', '1', {body: 'one'}), record('b', '2')]
  });
  assert.deepEqual(replay, written);
  assert.equal((await store.getSummary('acct-1', 'logs')).count, 2);
  assert.equal(await store.getRecord('acct-1', 'logs', 'c'), null);
  const outbox = await store.getOutbox('op-atomic');
  assert.equal(outbox.revision, written.revision);
  assert.deepEqual(outbox.recordIds, ['a', 'b']);
  const removed = await store.deleteRecords({accountId: 'acct-1', module: 'logs', operationId: 'op-delete', userKeys: ['a']});
  assert.equal(removed.summary.count, 1);
  assert.equal(removed.records[0].deleted, true);
  assert.equal(removed.records[0].body, 'one');
  assert.equal(await store.getRecord('acct-1', 'logs', 'a'), null);
  const restored = await store.putRecords({accountId: 'acct-1', module: 'logs', operationId: 'op-restore', records: [record('a', '1')]});
  assert.equal(restored.records[0].body, 'one');
  assert.equal(restored.summary.count, 2);
});

test('rolls back record writes when the outbox put aborts', async () => {
  const failing = {
    open(name, version) {
      const request = indexedDB.open(name, version);
      return new Proxy(request, {
        set(target, prop, value) {
          if (prop === 'onsuccess') {
            target.onsuccess = event => {
              const db = target.result;
              const original = db.transaction.bind(db);
              db.transaction = (stores, mode) => {
                const tx = original(stores, mode);
                const objectStore = tx.objectStore.bind(tx);
                tx.objectStore = storeName => {
                  const store = objectStore(storeName);
                  if (storeName === 'outbox' && mode === 'readwrite') {
                    store.put = () => {
                      const failed = {};
                      queueMicrotask(() => {
                        try { tx.abort(); } catch { /* already finished */ }
                        failed.error = new Error('forced abort');
                        failed.onerror?.(event);
                      });
                      return failed;
                    };
                  }
                  return store;
                };
                return tx;
              };
              return value.call(target, event);
            };
            return true;
          }
          target[prop] = value;
          return true;
        }
      });
    }
  };
  const store = createRecordRepository({indexedDB: failing, IDBKeyRange, dbName: 'records-abort', now: () => 1000});
  await assert.rejects(() => store.putRecords({
    accountId: 'acct-1', module: 'fans', operationId: 'op-abort', records: [record('a', '1', {legacyNote: 'no'})]
  }));
  assert.equal(await store.getRecord('acct-1', 'fans', 'a'), null);
  assert.equal(await store.getOutbox('op-abort'), null);
  assert.equal(await store.getMeta('acct-1'), null);
});

test('tuple keys keep identifiers that contain NUL bytes distinct', async () => {
  const store = repo('records-nul');
  await store.putRecords({accountId: 'a\u0000b', module: 'c', operationId: 'op-nul-a', records: [record('d', '1', {side: 'left'})]});
  await store.putRecords({accountId: 'a', module: 'b\u0000c', operationId: 'op-nul-b', records: [record('d', '1', {side: 'right'})]});
  assert.equal((await store.getRecord('a\u0000b', 'c', 'd')).side, 'left');
  assert.equal((await store.getRecord('a', 'b\u0000c', 'd')).side, 'right');
});

test('keeps a business id that is not the user key', async () => {
  const store = repo('records-business-id');
  const input = {userKey: 'b1', id: '9007199254740993', sortKey: 's', note: 'kept'};
  const unsafe = {userKey: 'b2', id: 9007199254740993, sortKey: 't'};
  const saved = await store.putRecords({accountId: 'acct-1', module: 'comments', operationId: 'op-id', records: [input, unsafe]});
  assert.equal(saved.records[0].userKey, 'b1');
  assert.equal(saved.records[0].id, '9007199254740993');
  assert.equal(saved.records[0].payload.id, '9007199254740993');
  assert.equal(saved.records[0].payload.userKey, 'b1');
  assert.equal('storageKey' in saved.records[0].payload, false);
  assert.equal(saved.records[1].payload.id, unsafe.id);
  assert.equal(typeof saved.records[1].payload.id, 'number');
  assert.notEqual(saved.records[1].id, 'b2');
  const loaded = await store.getRecord('acct-1', 'comments', 'b1');
  assert.equal(loaded.id, '9007199254740993');
  assert.equal(loaded.payload.note, 'kept');
});

test('rejects a cursor whose tuple scope, type, or length does not match', async () => {
  const store = repo('records-cursor-scope');
  await store.putRecords({accountId: 'acct-a', module: 'fans', operationId: 'op-a', records: [record('secret', '1', {status: 'open'})]});
  await store.putRecords({accountId: 'acct-b', module: 'fans', operationId: 'op-b', records: [record('visible', '1', {status: 'open'}), record('next', '2', {status: 'open'})]});
  const page = await store.queryPage({accountId: 'acct-b', module: 'fans', limit: 1});
  const parsed = JSON.parse(page.nextCursor);
  parsed.last[0] = 'acct-a';
  await assert.rejects(() => store.queryPage({accountId: 'acct-b', module: 'fans', limit: 1, cursor: JSON.stringify(parsed)}), RecordCursorInvalidError);
  parsed.last = ['acct-b', 'fans', '1', 'visible'];
  await assert.rejects(() => store.queryPage({accountId: 'acct-b', module: 'fans', limit: 1, cursor: JSON.stringify(parsed)}), RecordCursorInvalidError);
  parsed.last = ['acct-b', 'fans', 1];
  await assert.rejects(() => store.queryPage({accountId: 'acct-b', module: 'fans', limit: 1, cursor: JSON.stringify(parsed)}), RecordCursorInvalidError);
  const isolated = await store.queryPage({accountId: 'acct-b', module: 'fans', limit: 10});
  assert.deepEqual(isolated.records.map(item => item.userKey), ['visible', 'next']);
});

test('rejects replay of the same operation id with another module, type, or content', async () => {
  const store = repo('records-replay-identity');
  const written = await store.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-shared', records: [record('a', '1', {name: 'ada'})]});
  await assert.rejects(() => store.putRecords({
    accountId: 'acct-1', module: 'comments', operationId: 'op-shared', records: [record('a', '1')]
  }), /another module/);
  await assert.rejects(() => store.deleteRecords({
    accountId: 'acct-1', module: 'fans', operationId: 'op-shared', userKeys: ['a']
  }), /type/);
  await assert.rejects(() => store.putRecords({
    accountId: 'acct-1', module: 'fans', operationId: 'op-shared', records: [record('b', '2')]
  }), /content/);
  assert.equal(await store.getRecord('acct-1', 'comments', 'a'), null);
  assert.equal((await store.getSummary('acct-1', 'fans')).count, 1);
  assert.equal((await store.getRecord('acct-1', 'fans', 'a')).name, 'ada');
  const exact = await store.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-shared', records: [record('a', '1', {name: 'ada'})]});
  assert.deepEqual(exact, written);
});

test('retries a failed open, closes on versionchange, bounds blocked opens, and can close', async () => {
  let attempts = 0;
  const flaky = {
    open(name, version) {
      attempts += 1;
      if (attempts === 1) {
        const request = {};
        queueMicrotask(() => request.onerror?.({preventDefault() {}}));
        Object.defineProperty(request, 'error', {get: () => new Error('open failed')});
        return request;
      }
      return indexedDB.open(name, version);
    }
  };
  const retried = createRecordRepository({indexedDB: flaky, IDBKeyRange, dbName: 'records-retry', now: () => 1000});
  await assert.rejects(() => retried.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-retry', records: [record('a', '1')]}));
  const saved = await retried.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-retry', records: [record('a', '1')]});
  assert.equal(saved.records[0].userKey, 'a');

  let connected = null;
  const wrapped = {
    open(name, version) {
      const request = indexedDB.open(name, version);
      return new Proxy(request, {
        set(target, prop, value) {
          if (prop === 'onsuccess') {
            target.onsuccess = event => {
              connected = target.result;
              return value.call(target, event);
            };
            return true;
          }
          target[prop] = value;
          return true;
        }
      });
    }
  };
  const versioned = createRecordRepository({indexedDB: wrapped, IDBKeyRange, dbName: 'records-versionchange', now: () => 1000});
  await versioned.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-v1', records: [record('a', '1')]});
  connected.onversionchange();
  assert.throws(() => connected.transaction('meta', 'readonly'));
  await versioned.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-v2', records: [record('b', '2')]});
  assert.equal((await versioned.getRecord('acct-1', 'fans', 'b')).userKey, 'b');

  const blocked = {
    open() {
      const request = {};
      queueMicrotask(() => request.onblocked?.({}));
      return request;
    }
  };
  const stalling = createRecordRepository({indexedDB: blocked, IDBKeyRange, dbName: 'records-blocked', now: () => 1000, blockedTimeoutMs: 20});
  await assert.rejects(() => stalling.getMeta('acct-1'), /blocked/);

  const closable = repo('records-close');
  await closable.putRecords({accountId: 'acct-1', module: 'fans', operationId: 'op-close', records: [record('a', '1')]});
  await closable.close();
  await closable.close();
  assert.equal((await closable.getRecord('acct-1', 'fans', 'a')).userKey, 'a');
});
