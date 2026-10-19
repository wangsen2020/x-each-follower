import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordProjection} from '../record-projection.js';

function createLifecycleDb() {
  const stores = new Map();
  let failOpens = 0;
  let closingThrows = 0;
  let abortNextPut = false;
  let puts = 0;
  const connections = [];

  function ensure(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function finishLater(tx) {
    if (!tx || tx._done) return;
    setTimeout(() => {
      if (tx._done) return;
      tx._done = true;
      if (tx.error) tx.onabort?.();
      else tx.oncomplete?.();
    }, 0);
  }

  function storeApi(name, tx) {
    const data = ensure(name);
    return {
      indexNames: {contains: () => false},
      createIndex() {},
      deleteIndex() {},
      get(key) {
        const request = {};
        setTimeout(() => {
          request.result = data.get(JSON.stringify(key)) || null;
          request.onsuccess?.();
          finishLater(tx);
        }, 0);
        return request;
      },
      put(value) {
        puts += 1;
        if (abortNextPut) {
          abortNextPut = false;
          setTimeout(() => {
            tx.error = new Error('transaction aborted');
            finishLater(tx);
          }, 0);
          return {};
        }
        const key = value?.id != null ? JSON.stringify(value.id) : JSON.stringify(value);
        data.set(key, value);
        finishLater(tx);
        return {};
      },
      openCursor() {
        const request = {};
        setTimeout(() => {
          request.result = null;
          request.onsuccess?.();
        }, 0);
        return request;
      }
    };
  }

  function makeDb() {
    const db = {
      objectStoreNames: {contains: storeName => stores.has(storeName)},
      createObjectStore(name) {
        ensure(name);
        return storeApi(name, null);
      },
      close() {
        db._closed = true;
        db.onclose?.();
      },
      transaction(storeNames) {
        if (db._closed || closingThrows > 0) {
          if (closingThrows > 0) closingThrows -= 1;
          const error = new Error('The database connection is closing');
          error.name = 'InvalidStateError';
          throw error;
        }
        const tx = {
          error: null,
          objectStore(storeName) {
            return storeApi(storeName, tx);
          }
        };
        return tx;
      }
    };
    connections.push(db);
    return db;
  }

  return {
    connections,
    get puts() { return puts; },
    failNextOpen() { failOpens += 1; },
    throwClosingOnce() { closingThrows += 1; },
    abortNextPut() { abortNextPut = true; },
    indexedDB: {
      open(_name, _version) {
        const request = {};
        queueMicrotask(() => {
          if (failOpens > 0) {
            failOpens -= 1;
            request.error = new Error('open failed');
            request.onerror?.();
            return;
          }
          const db = makeDb();
          request.result = db;
          request.transaction = {objectStore: name => db.createObjectStore(name)};
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      }
    },
    IDBKeyRange: {bound() { return {}; }, only() { return {}; }}
  };
}

function projection(fake, name) {
  return createRecordProjection({
    indexedDB: fake.indexedDB,
    IDBKeyRange: fake.IDBKeyRange,
    dbName: name,
    now: () => 1000
  });
}

test('reopens after versionchange and forced close, and retries a failed open', async () => {
  const fake = createLifecycleDb();
  const store = projection(fake, 'projection-lifecycle');
  await store.writeState({stage: 'ready', cutover: true});
  const connected = fake.connections.at(-1);
  connected.onversionchange();
  assert.equal(connected._closed, true);
  const afterVersion = await store.readState();
  assert.equal(afterVersion.stage, 'ready');
  assert.equal(afterVersion.cutover, true);
  fake.connections.at(-1).close();
  const afterClose = await store.writeState({stage: 'ready', note: 'reopened'});
  assert.equal(afterClose.note, 'reopened');
  assert.equal((await store.readState()).note, 'reopened');

  const flaky = createLifecycleDb();
  flaky.failNextOpen();
  const retry = projection(flaky, 'projection-retry');
  await assert.rejects(() => retry.readState(), /open failed/);
  const recovered = await retry.writeState({stage: 'idle'});
  assert.equal(recovered.stage, 'idle');
  assert.equal((await retry.readState()).stage, 'idle');
});

test('fails an aborted write without replaying it and retries only a closing transaction', async () => {
  const fake = createLifecycleDb();
  const store = projection(fake, 'projection-abort');
  await store.writeState({stage: 'kept', token: 'original'});
  const putsBefore = fake.puts;
  fake.abortNextPut();
  await assert.rejects(() => store.writeState({stage: 'lost', token: 'aborted'}), /transaction aborted/);
  const preserved = await store.readState();
  assert.equal(preserved.stage, 'kept');
  assert.equal(preserved.token, 'original');
  const next = await store.writeState({stage: 'kept', token: 'next'});
  assert.equal(next.token, 'next');
  assert.equal((await store.readState()).token, 'next');
  assert.equal(fake.puts, putsBefore + 2);

  const closing = createLifecycleDb();
  const raced = projection(closing, 'projection-closing');
  await raced.writeState({stage: 'before'});
  closing.throwClosingOnce();
  const saved = await raced.writeState({stage: 'after'});
  assert.equal(saved.stage, 'after');
  assert.equal((await raced.readState()).stage, 'after');
});
