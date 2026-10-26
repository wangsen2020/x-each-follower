import test from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb';
import {
  createRecordRepository,
  RECORD_DEXIE_LEGACY_VERSION,
  RECORD_DB_VERSION,
  RECORD_DEXIE_STORES
} from '../src/features/records/record-repository.js';
import {createRecordMigration, hashCanonical, flattenLegacySnapshot} from '../src/features/records/record-migration.js';
import {createRecordRuntime} from '../src/features/records/record-runtime.js';

function createQuotaError(message = 'The quota has been exceeded.') {
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'QuotaExceededError');
  }
  const err = new Error(message);
  err.name = 'QuotaExceededError';
  return err;
}

function createFaultInjectingIDBFactory(baseFactory = new IDBFactory()) {
  let failMatcher = null;

  function patchStore(store, tx) {
    if (!store || store.__quotaPatched) return store;
    Object.defineProperty(store, '__quotaPatched', {value: true});
    for (const method of ['put', 'add']) {
      if (typeof store[method] !== 'function') continue;
      const orig = store[method].bind(store);
      store[method] = (...args) => {
        if (failMatcher && failMatcher({storeName: store.name, method, value: args[0], mode: tx.mode})) {
          const failed = {};
          const quotaErr = createQuotaError(`QuotaExceededError on ${store.name}.${method}`);
          queueMicrotask(() => {
            failed.error = quotaErr;
            failed.onerror?.({target: failed, type: 'error', preventDefault() {}, stopPropagation() {}});
            try { tx.abort(); } catch { /* already finished */ }
          });
          return failed;
        }
        return orig(...args);
      };
    }
    return store;
  }

  function patchTx(tx) {
    if (!tx || tx.__quotaPatched) return tx;
    Object.defineProperty(tx, '__quotaPatched', {value: true});
    const origObjectStore = tx.objectStore.bind(tx);
    tx.objectStore = storeName => patchStore(origObjectStore(storeName), tx);
    return tx;
  }

  function patchDb(db) {
    if (!db || db.__quotaPatched) return db;
    Object.defineProperty(db, '__quotaPatched', {value: true});
    const origTx = db.transaction.bind(db);
    db.transaction = (storeNames, mode) => patchTx(origTx(storeNames, mode));
    return db;
  }

  const indexedDB = {
    open(name, version) {
      const request = version === undefined ? baseFactory.open(name) : baseFactory.open(name, version);
      return new Proxy(request, {
        set(target, prop, value) {
          if (prop === 'onupgradeneeded' && typeof value === 'function') {
            target.onupgradeneeded = event => {
              patchDb(target.result);
              if (target.transaction) patchTx(target.transaction);
              return value.call(target, event);
            };
            return true;
          }
          if (prop === 'onsuccess' && typeof value === 'function') {
            target.onsuccess = event => {
              patchDb(target.result);
              return value.call(target, event);
            };
            return true;
          }
          target[prop] = value;
          return true;
        },
        get(target, prop) {
          const val = target[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        }
      });
    },
    deleteDatabase: baseFactory.deleteDatabase.bind(baseFactory),
    cmp: baseFactory.cmp.bind(baseFactory),
    databases: typeof baseFactory.databases === 'function' ? baseFactory.databases.bind(baseFactory) : undefined
  };

  return {
    indexedDB,
    baseFactory,
    setQuotaFailure(matcher) {
      failMatcher = matcher;
    },
    clearQuotaFailure() {
      failMatcher = null;
    }
  };
}

function memoryStorage(data = {}) {
  return {
    data,
    local: {
      async get(keys) {
        if (!Array.isArray(keys)) throw new Error('legacy read must be a key list');
        const out = {};
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = structuredClone(data[key]);
        }
        return out;
      },
      async set(payload) {
        for (const [key, value] of Object.entries(payload)) {
          data[key] = structuredClone(value);
        }
      },
      async remove() {
        throw new Error('runtime must not delete legacy storage');
      }
    }
  };
}

function memoryDurable(initial = new Map()) {
  const saved = new Map(initial);
  const store = {
    saved,
    failKeys: null,
    failGetKey: null,
    async get(key) {
      if (store.failGetKey && store.failGetKey(key)) throw new Error(`durable get failed for ${key}`);
      return saved.has(key) ? structuredClone(saved.get(key)) : undefined;
    },
    async set(key, value) {
      saved.set(key, structuredClone(value));
    },
    async keys(prefix = '') {
      if (store.failKeys && store.failKeys(prefix)) throw new Error(`durable keys failed for ${prefix}`);
      const matched = [];
      for (const k of saved.keys()) {
        if (!prefix || String(k).startsWith(prefix)) matched.push(k);
      }
      return matched.sort();
    }
  };
  return store;
}

test('QuotaExceededError during multi-store repository writes and Dexie upgrade rolls back atomically and succeeds on retry without clearing data', async () => {
  const fault = createFaultInjectingIDBFactory();
  const dbName = 'acceptance-quota-rollback';
  const store = createRecordRepository({
    indexedDB: fault.indexedDB,
    IDBKeyRange,
    dbName,
    now: () => 5000
  });

  // Seed baseline committed data across 2 accounts
  const initialA = await store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'op-seed-a',
    summaryPatch: {label: 'baseline-a'},
    records: [
      {userKey: 'u1', sortKey: '001', status: 'open', handle: 'alice', outcome: 'followed'},
      {userKey: 'u2', sortKey: '002', status: 'pending', handle: 'bob', outcome: 'queued'}
    ]
  });
  assert.equal(initialA.revision, 1);
  assert.equal(initialA.summary.count, 2);

  await store.putRecords({
    accountId: 'acct-b',
    module: 'fans',
    operationId: 'op-seed-b',
    records: [{userKey: 'u1', sortKey: '001', status: 'open', handle: 'acct-b-alice'}]
  });

  const quotaPutRequest = {
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'op-quota-put',
    summaryPatch: {label: 'mutated-on-quota'},
    records: [
      {userKey: 'u1', sortKey: '001', status: 'closed', handle: 'alice-mutated'},
      {userKey: 'u3', sortKey: '003', status: 'open', handle: 'charlie'}
    ]
  };
  const quotaDelRequest = {
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'op-quota-del',
    userKeys: ['u1']
  };

  // 1. Inject QuotaExceededError on outbox.put (the final store written in applyOperation after records, meta, and summaries)
  fault.setQuotaFailure(({storeName, method}) => storeName === 'outbox' && method === 'put');
  await assert.rejects(
    () => store.putRecords(quotaPutRequest),
    err => err?.name === 'QuotaExceededError' || /QuotaExceededError/.test(err?.message || '')
  );

  // Verify entire 5-store transaction rolled back: meta, summary, records, and outbox untouched
  assert.equal((await store.getMeta('acct-a')).revision, 1);
  const summaryAfterPutFail = await store.getSummary('acct-a', 'fans');
  assert.equal(summaryAfterPutFail.count, 2);
  assert.equal(summaryAfterPutFail.revision, 1);
  assert.equal(summaryAfterPutFail.label, 'baseline-a');
  assert.equal((await store.getRecord('acct-a', 'fans', 'u1')).handle, 'alice');
  assert.equal((await store.getRecord('acct-a', 'fans', 'u1')).status, 'open');
  assert.equal(await store.getRecord('acct-a', 'fans', 'u3'), null);
  assert.equal(await store.getOutbox('op-quota-put'), null);
  assert.equal((await store.getRecord('acct-b', 'fans', 'u1')).handle, 'acct-b-alice');

  // 2. Inject QuotaExceededError during deleteRecords on tombstones.put after records.delete already ran
  fault.setQuotaFailure(({storeName, method}) => storeName === 'tombstones' && method === 'put');
  await assert.rejects(
    () => store.deleteRecords(quotaDelRequest),
    err => err?.name === 'QuotaExceededError' || /QuotaExceededError/.test(err?.message || '')
  );
  assert.equal((await store.getRecord('acct-a', 'fans', 'u1')).handle, 'alice');
  assert.equal(await store.getTombstone('acct-a', 'fans', 'u1'), null);
  assert.equal((await store.getSummary('acct-a', 'fans')).count, 2);
  assert.equal((await store.getMeta('acct-a')).revision, 1);

  // 3. Clear quota failure and retry the EXACT same request bodies and operationIds cleanly
  fault.clearQuotaFailure();
  const retriedPut = await store.putRecords(quotaPutRequest);
  assert.equal(retriedPut.revision, 2);
  assert.equal(retriedPut.summary.count, 3);
  assert.equal(retriedPut.summary.label, 'mutated-on-quota');
  assert.equal((await store.getRecord('acct-a', 'fans', 'u1')).handle, 'alice-mutated');
  assert.equal((await store.getRecord('acct-a', 'fans', 'u3')).handle, 'charlie');
  assert.equal((await store.getOutbox('op-quota-put')).revision, 2);

  const retriedDel = await store.deleteRecords(quotaDelRequest);
  assert.equal(retriedDel.revision, 3);
  assert.equal(retriedDel.summary.count, 2);
  assert.equal(await store.getRecord('acct-a', 'fans', 'u1'), null);
  assert.equal((await store.getTombstone('acct-a', 'fans', 'u1')).deleted, true);
  assert.equal((await store.getRecord('acct-a', 'fans', 'u2')).handle, 'bob');
  await store.close();

  // 4. QuotaExceededError inside a Dexie version upgrade callback rolls back the versionchange transaction and keeps v1 intact
  let recordPutsInUpgrade = 0;
  fault.setQuotaFailure(({storeName, method}) => {
    if (storeName === 'records' && method === 'put') {
      recordPutsInUpgrade += 1;
      return recordPutsInUpgrade >= 2;
    }
    return false;
  });

  const upgradeFailDb = new Dexie(dbName, {indexedDB: fault.indexedDB, IDBKeyRange, autoOpen: false});
  upgradeFailDb.version(RECORD_DEXIE_LEGACY_VERSION).stores(RECORD_DEXIE_STORES);
  upgradeFailDb.version(RECORD_DB_VERSION).stores(RECORD_DEXIE_STORES);
  upgradeFailDb.version(2).stores(RECORD_DEXIE_STORES).upgrade(tx =>
    tx.table('records').toCollection().modify(row => {
      row.payload = {...row.payload, quotaUpgradedV2: true};
    })
  );

  await assert.rejects(
    () => upgradeFailDb.open(),
    err => err?.name === 'QuotaExceededError' || err?.inner?.name === 'QuotaExceededError' || /QuotaExceededError/.test(`${err?.message || ''} ${err?.inner?.message || ''}`)
  );
  upgradeFailDb.close();
  fault.clearQuotaFailure();

  // Verify database remained at Dexie v1 (native v10) and even the first modified row rolled back
  const verifyV1 = createRecordRepository({indexedDB: fault.indexedDB, IDBKeyRange, dbName});
  const intactU2 = await verifyV1.getRecord('acct-a', 'fans', 'u2');
  const intactU3 = await verifyV1.getRecord('acct-a', 'fans', 'u3');
  const intactB = await verifyV1.getRecord('acct-b', 'fans', 'u1');
  assert.equal(intactU2.payload.quotaUpgradedV2, undefined);
  assert.equal(intactU3.payload.quotaUpgradedV2, undefined);
  assert.equal(intactB.payload.quotaUpgradedV2, undefined);
  await verifyV1.close();

  // Retry the v2 upgrade after space is freed -> succeeds and upgrades all records
  const upgradeRetryDb = new Dexie(dbName, {indexedDB: fault.indexedDB, IDBKeyRange, autoOpen: false});
  upgradeRetryDb.version(RECORD_DEXIE_LEGACY_VERSION).stores(RECORD_DEXIE_STORES);
  upgradeRetryDb.version(RECORD_DB_VERSION).stores(RECORD_DEXIE_STORES);
  upgradeRetryDb.version(2).stores(RECORD_DEXIE_STORES).upgrade(tx =>
    tx.table('records').toCollection().modify(row => {
      row.payload = {...row.payload, quotaUpgradedV2: true};
    })
  );
  await upgradeRetryDb.open();
  assert.equal(upgradeRetryDb.backendDB().version, 20);
  const upgradedU2 = await upgradeRetryDb.table('records').get(['acct-a', 'fans', 1, 'u2']);
  const upgradedB = await upgradeRetryDb.table('records').get(['acct-b', 'fans', 1, 'u1']);
  assert.equal(upgradedU2.payload.quotaUpgradedV2, true);
  assert.equal(upgradedB.payload.quotaUpgradedV2, true);
  upgradeRetryDb.close();
});

test('rejects unsupported, malformed, or unreadable backups at legacy migration and recovery entry paths without treating them as empty restore', async () => {
  // 1. Direct migration/flatten entry paths reject non-plain-object snapshots
  const repo = createRecordRepository({indexedDB: new IDBFactory(), IDBKeyRange, dbName: 'acceptance-malformed-import'});
  const migration = createRecordMigration({repository: repo});
  for (const invalidSnapshot of [null, undefined, 'raw-json-string', 42, ['array-root']]) {
    await assert.rejects(() => flattenLegacySnapshot(invalidSnapshot), /snapshot must be an object/);
    await assert.rejects(() => migration.stage(invalidSnapshot, 'mig-invalid'), /snapshot must be an object/);
    await assert.rejects(() => migration.importSnapshot({snapshot: invalidSnapshot, migrationId: 'mig-invalid'}), /snapshot must be an object|canonical value cannot be undefined/);
  }
  assert.equal(await repo.getMigration('mig-invalid'), null);
  await repo.close();

  // 4. Runtime discoverBaseline with malformed non-object snapshot in v2 backup key rejects and does not cut over as empty
  const malformedV2Durable = memoryDurable();
  await malformedV2Durable.set('recordLegacySnapshotBackup:v2:malformed-snap', {
    fingerprint: 'malformed-snap',
    snapshot: 'not-an-object',
    savedAt: 1000,
    immutable: true
  });
  const malformedV2Runtime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: malformedV2Durable.get,
    durableGetStrict: malformedV2Durable.get,
    durableKeys: malformedV2Durable.keys,
    durableKeysStrict: malformedV2Durable.keys,
    durableSet: malformedV2Durable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-malformed-v2-backup'
  });
  await assert.rejects(() => malformedV2Runtime.migrate(), /持久化快照数据损坏|持久化备份来源访问失败/);
  assert.equal(malformedV2Runtime.status().cutover, false);
  assert.equal(malformedV2Runtime.status().stage, 'repair-required');

  // 4b. Runtime discoverBaseline with v2 backup whose fingerprint matches a non-object snapshot rejects in flattenLegacySnapshot
  const stringFp = await hashCanonical('not-an-object');
  const matchingNonObjectV2Durable = memoryDurable();
  await matchingNonObjectV2Durable.set(`recordLegacySnapshotBackup:v2:${stringFp}`, {
    fingerprint: stringFp,
    snapshot: 'not-an-object',
    savedAt: 1000,
    immutable: true
  });
  const matchingNonObjectV2Runtime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: matchingNonObjectV2Durable.get,
    durableGetStrict: matchingNonObjectV2Durable.get,
    durableKeys: matchingNonObjectV2Durable.keys,
    durableKeysStrict: matchingNonObjectV2Durable.keys,
    durableSet: matchingNonObjectV2Durable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-matching-non-object-v2'
  });
  await assert.rejects(() => matchingNonObjectV2Runtime.migrate(), /snapshot must be an object/);
  assert.equal(matchingNonObjectV2Runtime.status().cutover, false);
  assert.equal(matchingNonObjectV2Runtime.status().stage, 'repair-required');

  // 4c. Runtime discoverBaseline with v1 backup whose fingerprint matches a non-object snapshot rejects in flattenLegacySnapshot
  const matchingNonObjectV1Durable = memoryDurable();
  await matchingNonObjectV1Durable.set(`recordLegacySnapshotBackup:${stringFp}`, {
    fingerprint: stringFp,
    snapshot: 'not-an-object',
    savedAt: 1000,
    immutable: true
  });
  const matchingNonObjectV1Runtime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: matchingNonObjectV1Durable.get,
    durableGetStrict: matchingNonObjectV1Durable.get,
    durableKeys: matchingNonObjectV1Durable.keys,
    durableKeysStrict: matchingNonObjectV1Durable.keys,
    durableSet: matchingNonObjectV1Durable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-matching-non-object-v1'
  });
  await assert.rejects(() => matchingNonObjectV1Runtime.migrate(), /snapshot must be an object/);
  assert.equal(matchingNonObjectV1Runtime.status().cutover, false);
  assert.equal(matchingNonObjectV1Runtime.status().stage, 'repair-required');

  // 4d. Runtime discoverBaseline with malformed legacy v1 wrapper (`recordLegacySnapshotBackup:bad` with mismatching fingerprint and non-empty snapshot) rejects, keeps cutover false, and preserves backup data
  const malformedV1Payload = {
    fingerprint: 'bad',
    snapshot: {monitor: {users: [{id: '101', handle: 'v1_preserved_user', accountId: 'acct-v1'}]}},
    savedAt: 1500,
    immutable: true
  };
  const malformedV1Durable = memoryDurable();
  await malformedV1Durable.set('recordLegacySnapshotBackup:bad', malformedV1Payload);
  const malformedV1Runtime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: malformedV1Durable.get,
    durableGetStrict: malformedV1Durable.get,
    durableKeys: malformedV1Durable.keys,
    durableKeysStrict: malformedV1Durable.keys,
    durableSet: malformedV1Durable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-malformed-v1-wrapper'
  });
  await assert.rejects(() => malformedV1Runtime.migrate(), /持久化快照数据损坏/);
  assert.equal(malformedV1Runtime.status().cutover, false);
  assert.equal(malformedV1Runtime.status().stage, 'repair-required');
  assert.deepEqual(await malformedV1Durable.get('recordLegacySnapshotBackup:bad'), malformedV1Payload);

  // 4e. Runtime discoverBaseline with explicit future key (`recordLegacySnapshotBackup:v3:<validhash>` with version 3) rejects instead of accepting as v1, keeps cutover false, and preserves backup data
  const v3Snapshot = {monitor: {users: [{id: '202', handle: 'v3_future_user', accountId: 'acct-v3'}]}};
  const v3Hash = await hashCanonical(v3Snapshot);
  const v3Key = `recordLegacySnapshotBackup:v3:${v3Hash}`;
  const v3Payload = {
    version: 3,
    fingerprint: v3Hash,
    snapshot: v3Snapshot,
    savedAt: 2500,
    immutable: true
  };
  const futureV3Durable = memoryDurable();
  await futureV3Durable.set(v3Key, v3Payload);
  const futureV3Runtime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: futureV3Durable.get,
    durableGetStrict: futureV3Durable.get,
    durableKeys: futureV3Durable.keys,
    durableKeysStrict: futureV3Durable.keys,
    durableSet: futureV3Durable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-future-v3-backup-key'
  });
  await assert.rejects(() => futureV3Runtime.migrate(), /不支持的持久化快照版本/);
  assert.equal(futureV3Runtime.status().cutover, false);
  assert.equal(futureV3Runtime.status().stage, 'repair-required');
  assert.deepEqual(await futureV3Durable.get(v3Key), v3Payload);

  // 4f. Optional wrapper version mismatch variants: v2 key with version: 3 and v1 key with version: 2 both reject with 不支持的持久化快照版本 and preserve data
  const v2WrongVerKey = `recordLegacySnapshotBackup:v2:${v3Hash}`;
  const v2WrongVerPayload = {
    version: 3,
    fingerprint: v3Hash,
    snapshot: v3Snapshot,
    savedAt: 2600,
    immutable: true
  };
  const v2WrongVerDurable = memoryDurable();
  await v2WrongVerDurable.set(v2WrongVerKey, v2WrongVerPayload);
  const v2WrongVerRuntime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: v2WrongVerDurable.get,
    durableGetStrict: v2WrongVerDurable.get,
    durableKeys: v2WrongVerDurable.keys,
    durableKeysStrict: v2WrongVerDurable.keys,
    durableSet: v2WrongVerDurable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-v2-wrapper-version-mismatch'
  });
  await assert.rejects(() => v2WrongVerRuntime.migrate(), /不支持的持久化快照版本/);
  assert.equal(v2WrongVerRuntime.status().cutover, false);
  assert.deepEqual(await v2WrongVerDurable.get(v2WrongVerKey), v2WrongVerPayload);

  const v1WrongVerKey = `recordLegacySnapshotBackup:${v3Hash}`;
  const v1WrongVerPayload = {
    version: 2,
    fingerprint: v3Hash,
    snapshot: v3Snapshot,
    savedAt: 2700,
    immutable: true
  };
  const v1WrongVerDurable = memoryDurable();
  await v1WrongVerDurable.set(v1WrongVerKey, v1WrongVerPayload);
  const v1WrongVerRuntime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: v1WrongVerDurable.get,
    durableGetStrict: v1WrongVerDurable.get,
    durableKeys: v1WrongVerDurable.keys,
    durableKeysStrict: v1WrongVerDurable.keys,
    durableSet: v1WrongVerDurable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-v1-wrapper-version-mismatch'
  });
  await assert.rejects(() => v1WrongVerRuntime.migrate(), /不支持的持久化快照版本/);
  assert.equal(v1WrongVerRuntime.status().cutover, false);
  assert.deepEqual(await v1WrongVerDurable.get(v1WrongVerKey), v1WrongVerPayload);

  // 4g. Valid v1 recovery control: unversioned key `recordLegacySnapshotBackup:<hash>` (with omitted version or version: 1) recovers cleanly so guard is not overbroad
  const validV1Snapshot = {
    monitor: {users: [{id: '303', handle: 'valid_v1_user', accountId: 'acct-v1', status: 'followed', state: 'following'}]}
  };
  const validV1Hash = await hashCanonical(validV1Snapshot);
  const validV1Key = `recordLegacySnapshotBackup:${validV1Hash}`;
  const validV1Durable = memoryDurable();
  await validV1Durable.set(validV1Key, {
    fingerprint: validV1Hash,
    snapshot: validV1Snapshot,
    savedAt: 3000,
    immutable: true
  });
  const validV1Runtime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: validV1Durable.get,
    durableGetStrict: validV1Durable.get,
    durableKeys: validV1Durable.keys,
    durableKeysStrict: validV1Durable.keys,
    durableSet: validV1Durable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-valid-v1-recovery-control'
  });
  const validV1Status = await validV1Runtime.migrate();
  assert.equal(validV1Status.cutover, true);
  assert.equal(validV1Status.stage, 'ready');
  assert.equal(validV1Status.total, 1);
  const validV1Page = await validV1Runtime.query({accountId: 'acct-v1', module: 'fans', limit: 10});
  assert.equal(validV1Page.records.length, 1);
  assert.equal(validV1Page.records[0].handle, 'valid_v1_user');

  // 5. Runtime discoverBaseline when local chrome.storage.local.get fails and durable has no data rejects instead of treating as empty install
  const emptyDurable = memoryDurable();
  const failingLocalStorage = {
    local: {
      async get() {
        throw new Error('chrome.storage.local read corrupted');
      },
      async set() {}
    }
  };
  const localFailRuntime = createRecordRuntime({
    storage: failingLocalStorage,
    durableGet: emptyDurable.get,
    durableGetStrict: emptyDurable.get,
    durableKeys: emptyDurable.keys,
    durableKeysStrict: emptyDurable.keys,
    durableSet: emptyDurable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-local-read-fail'
  });
  await assert.rejects(() => localFailRuntime.migrate(), /本地旧存储读取失败.*chrome\.storage\.local read corrupted/);
  assert.equal(localFailRuntime.status().cutover, false);
  assert.equal(localFailRuntime.status().stage, 'repair-required');

  // 6. Runtime discoverBaseline when durable legacy key read throws partway through rejects instead of returning partial/empty baseline
  const partialFailDurable = memoryDurable();
  partialFailDurable.failGetKey = key => key === 'mutualNetwork';
  const partialFailRuntime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: partialFailDurable.get,
    durableGetStrict: partialFailDurable.get,
    durableKeys: partialFailDurable.keys,
    durableKeysStrict: partialFailDurable.keys,
    durableSet: partialFailDurable.set,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    dbName: 'acceptance-durable-partial-read-fail'
  });
  await assert.rejects(() => partialFailRuntime.migrate(), /持久化备份来源访问失败.*mutualNetwork/);
  assert.equal(partialFailRuntime.status().cutover, false);
  assert.equal(partialFailRuntime.status().stage, 'repair-required');
});

test('preserves multi-account ownership, unowned unassigned boundary, and business execution evidence across baseline recovery and incremental replay', async () => {
  const idb = new IDBFactory();
  const legacySnapshot = {
    accountId: 'root-account-must-not-leak-to-unowned-records',
    monitor: {
      enabled: true,
      users: [
        {
          id: '1000000000000000001',
          handle: 'Alice_A',
          accountId: 'acct-alpha',
          state: 'following',
          status: 'followed',
          discoveredAt: '2026-10-20T08:00:00.000Z',
          relationship: {following: true, followedBy: true},
          followResult: {outcome: 'followed', at: '2026-10-20T08:05:00.000Z'}
        },
        {
          id: '2000000000000000002',
          handle: 'Bob_B',
          accountId: 'acct-beta',
          state: 'follow_back',
          status: 'pending',
          discoveredAt: '2026-10-21T08:00:00.000Z',
          relationship: {following: false, followedBy: true}
        },
        {
          id: '3000000000000000003',
          handle: 'Unowned_Fan',
          state: 'following',
          status: 'followed',
          discoveredAt: '2026-10-22T08:00:00.000Z',
          relationship: {following: true, followedBy: false}
        }
      ],
      queue: [
        {
          id: 'q-alpha-1',
          handle: 'Queue_Alpha',
          accountId: 'acct-alpha',
          status: 'uncertain',
          state: 'follow_back',
          outcome: 'uncertain_timeout',
          attemptCount: 2,
          lastAttemptAt: '2026-10-23T10:00:00.000Z',
          relationship: {following: false, followedBy: true}
        },
        {
          id: 'q-beta-1',
          handle: 'Queue_Beta',
          accountId: 'acct-beta',
          status: 'pending',
          state: 'follow_back',
          outcome: 'queued',
          relationship: {following: false, followedBy: true}
        }
      ],
      followingUsers: [
        {
          id: '1000000000000000001',
          handle: 'Alice_A',
          accountId: 'acct-alpha',
          relationship: {following: true, followedBy: true}
        }
      ]
    },
    unreciprocatedTracker: {
      users: [
        {
          id: '4000000000000000004',
          handle: 'Greeted_Alpha',
          accountId: 'acct-alpha',
          followedAt: '2026-10-10T09:00:00.000Z',
          followedAtSource: 'confirmed',
          status: 'overdue',
          exempt: true,
          greeting: {
            status: 'sent',
            sentAt: '2026-10-11T09:00:00.000Z',
            messageId: 'dm-alpha-001',
            text: 'Hello from alpha'
          },
          accountAvailability: {status: 'ok', checkedAt: 1700000000000},
          relationship: {following: true, followedBy: false}
        },
        {
          id: '5000000000000000005',
          handle: 'Deleted_Beta',
          accountId: 'acct-beta',
          followedAt: '2026-10-05T09:00:00.000Z',
          status: 'unfollowed',
          deleted: true,
          reason: 'manual_remove',
          greeting: {status: 'skipped', reason: 'dm_closed'}
        }
      ]
    },
    commentTracking: {
      users: [
        {
          handle: 'Commenter_Alpha',
          accountId: 'acct-alpha',
          status: 'followed',
          lastSeenAt: '2026-10-24T01:00:00.000Z',
          autoFollowOutcome: 'followed_with_grok_reply',
          sources: [
            {
              tweetId: '9007199254740993',
              url: 'https://x.com/alpha/status/9007199254740993',
              replies: [{replyId: 'r-1', text: 'Great thread!', quotedSent: true}]
            }
          ]
        }
      ],
      posts: [
        {
          tweetId: '9007199254740993',
          accountId: 'acct-alpha',
          text: 'Alpha root post'
        }
      ]
    }
  };

  const durable = memoryDurable();
  const fp = await hashCanonical(legacySnapshot);
  await durable.set(`recordLegacySnapshotBackup:v2:${fp}`, {
    fingerprint: fp,
    snapshot: legacySnapshot,
    savedAt: 10000,
    immutable: true
  });

  // Seed incremental journal entries across accounts (one patch on acct-alpha queue outcome, one patch on acct-beta queue status)
  await durable.set('recordIncremental:v1:seq:00000001', {
    operationId: 'op-inc-alpha-1',
    seq: 1,
    status: 'stored',
    kind: 'patch',
    accountId: 'acct-alpha',
    module: 'fans',
    userKey: 'monitor/queue/0',
    handle: 'queue_alpha',
    sourceKey: 'monitor',
    sourcePath: ['monitor', 'queue', 0],
    payload: {
      ...legacySnapshot.monitor.queue[0],
      outcome: 'uncertain_verified_followed',
      verifiedAt: '2026-10-24T12:00:00.000Z'
    }
  });
  await durable.set('recordIncremental:v1:seq:00000002', {
    operationId: 'op-inc-beta-1',
    seq: 2,
    status: 'stored',
    kind: 'patch',
    accountId: 'acct-beta',
    module: 'fans',
    userKey: 'monitor/queue/1',
    handle: 'queue_beta',
    sourceKey: 'monitor',
    sourcePath: ['monitor', 'queue', 1],
    payload: {
      ...legacySnapshot.monitor.queue[1],
      status: 'followed',
      outcome: 'followed_success'
    }
  });
  await durable.set('recordIncremental:v1:head', {seq: 2, operationId: 'op-inc-beta-1'});

  const dbName = 'acceptance-account-and-evidence-recovery';
  const runtime = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: durable.get,
    durableGetStrict: durable.get,
    durableKeys: durable.keys,
    durableKeysStrict: durable.keys,
    durableSet: durable.set,
    indexedDB: idb,
    IDBKeyRange,
    dbName
  });

  const migStatus = await runtime.migrate();
  assert.equal(migStatus.cutover, true);
  assert.equal(migStatus.stage, 'ready');

  // 1. Verify account isolation in projection queries: acct-alpha, acct-beta, and unassigned do not leak into each other
  const alphaFans = await runtime.query({accountId: 'acct-alpha', module: 'fans', limit: 50});
  const betaFans = await runtime.query({accountId: 'acct-beta', module: 'fans', limit: 50});
  const unassignedFans = await runtime.query({accountId: 'unassigned', module: 'fans', limit: 50});

  assert.equal(alphaFans.records.every(r => r.accountId === 'acct-alpha'), true);
  assert.equal(betaFans.records.every(r => r.accountId === 'acct-beta'), true);
  assert.equal(unassignedFans.records.every(r => r.accountId === 'unassigned'), true);

  assert.equal(alphaFans.records.some(r => r.handle === 'bob_b' || r.handle === 'unowned_fan'), false);
  assert.equal(betaFans.records.some(r => r.handle === 'alice_a' || r.handle === 'unowned_fan'), false);
  assert.equal(unassignedFans.records.some(r => r.handle === 'unowned_fan'), true);

  // 2. Verify business execution evidence survived recovery + incremental replay without reset
  const alphaQueue = alphaFans.records.find(r => r.handle === 'queue_alpha');
  assert.equal(alphaQueue.payload.status, 'uncertain');
  assert.equal(alphaQueue.payload.outcome, 'uncertain_verified_followed');
  assert.equal(alphaQueue.payload.attemptCount, 2);
  assert.equal(alphaQueue.payload.verifiedAt, '2026-10-24T12:00:00.000Z');

  const betaQueue = betaFans.records.find(r => r.handle === 'queue_beta');
  assert.equal(betaQueue.payload.status, 'followed');
  assert.equal(betaQueue.payload.outcome, 'followed_success');

  const alphaTracker = await runtime.query({accountId: 'acct-alpha', module: 'unreciprocated', limit: 50});
  assert.equal(alphaTracker.records.length, 1);
  const greeted = alphaTracker.records[0];
  assert.equal(greeted.handle, 'greeted_alpha');
  assert.equal(greeted.payload.exempt, true);
  assert.equal(greeted.payload.followedAt, '2026-10-10T09:00:00.000Z');
  assert.equal(greeted.payload.followedAtSource, 'confirmed');
  assert.deepEqual(greeted.payload.greeting, {
    status: 'sent',
    sentAt: '2026-10-11T09:00:00.000Z',
    messageId: 'dm-alpha-001',
    text: 'Hello from alpha'
  });

  const alphaComments = await runtime.query({accountId: 'acct-alpha', module: 'comments', limit: 50});
  assert.equal(alphaComments.records.length, 1);
  assert.equal(alphaComments.records[0].payload.autoFollowOutcome, 'followed_with_grok_reply');
  assert.equal(alphaComments.records[0].payload.sources[0].replies[0].quotedSent, true);

  // 3. Verify underlying Dexie archive repository preserved tombstones, deleted flags, and per-account generations
  const archiveRepo = createRecordRepository({indexedDB: idb, IDBKeyRange, dbName});
  const deletedBetaTomb = await archiveRepo.getTombstone('acct-beta', 'unreciprocated', 'unreciprocatedTracker/users/1');
  assert.ok(deletedBetaTomb);
  assert.equal(deletedBetaTomb.deleted, true);
  assert.equal(deletedBetaTomb.payload.reason, 'manual_remove');
  assert.deepEqual(deletedBetaTomb.payload.greeting, {status: 'skipped', reason: 'dm_closed'});
  assert.equal(await archiveRepo.getRecord('acct-beta', 'unreciprocated', 'unreciprocatedTracker/users/1'), null);
  await archiveRepo.close();

  // 4. Verify account ownership boundary rejects cross-account mutation or assigning unowned record to a specific account
  await assert.rejects(
    () => runtime.putRecord({
      accountId: 'acct-alpha',
      module: 'fans',
      operationId: 'op-cross-account-reject',
      record: {accountId: 'acct-beta', payload: {handle: 'intruder', accountId: 'acct-beta'}}
    }),
    /record accountId does not match/
  );
  await assert.rejects(
    () => runtime.putRecord({
      accountId: 'acct-alpha',
      module: 'fans',
      operationId: 'op-missing-owner-reject',
      record: {payload: {handle: 'no_owner'}}
    }),
    /missing record ownership cannot be assigned to an account/
  );
});
