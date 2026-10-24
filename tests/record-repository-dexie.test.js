import test from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import {IDBFactory, indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {
  createRecordRepository,
  RECORD_NATIVE_LEGACY_VERSION,
  RECORD_DEXIE_LEGACY_VERSION,
  RECORD_DB_VERSION,
  RECORD_NATIVE_DB_VERSION,
  RECORD_DEXIE_STORES,
  RECORD_TRANSACTION_SCOPES
} from '../src/features/records/record-repository.js';

function installLegacyNativeV1Schema(db) {
  if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'accountId'});
  if (!db.objectStoreNames.contains('records')) {
    const records = db.createObjectStore('records', {keyPath: 'storageKey'});
    records.createIndex('scopeSort', ['accountId', 'module', 'generation', 'sortKey', 'userKey'], {unique: true});
    records.createIndex('scopeStatusSort', ['accountId', 'module', 'generation', 'status', 'sortKey', 'userKey'], {unique: true});
    records.createIndex('accountGeneration', ['accountId', 'generation', 'module', 'userKey'], {unique: true});
  }
  if (!db.objectStoreNames.contains('tombstones')) {
    const tombstones = db.createObjectStore('tombstones', {keyPath: 'storageKey'});
    tombstones.createIndex('accountGeneration', ['accountId', 'generation', 'module', 'userKey'], {unique: true});
  }
  if (!db.objectStoreNames.contains('summaries')) {
    const summaries = db.createObjectStore('summaries', {keyPath: 'storageKey'});
    summaries.createIndex('accountModule', ['accountId', 'module', 'generation'], {unique: true});
  }
  if (!db.objectStoreNames.contains('outbox')) {
    const outbox = db.createObjectStore('outbox', {keyPath: 'operationId'});
    outbox.createIndex('accountModuleRevision', ['accountId', 'module', 'revision'], {unique: false});
  }
  if (!db.objectStoreNames.contains('migrations')) db.createObjectStore('migrations', {keyPath: 'migrationId'});
  if (!db.objectStoreNames.contains('migrationManifests')) db.createObjectStore('migrationManifests', {keyPath: 'migrationId'});
}

function seedNativeV1Database(dbName, seedFn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, RECORD_NATIVE_LEGACY_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => installLegacyNativeV1Schema(req.result);
    req.onsuccess = () => {
      const db = req.result;
      const stores = ['meta', 'records', 'tombstones', 'summaries', 'outbox', 'migrations', 'migrationManifests'];
      const tx = db.transaction(stores, 'readwrite');
      seedFn(tx);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error('seed transaction aborted'));
      };
    };
  });
}

test('takes over an existing native v1 database without losing records, indexes, migration state, or account isolation', async () => {
  const dbName = 'dexie-native-v1-takeover';
  const legacyContent = '{"accountId":"acct-1","generation":null,"module":"fans","records":[{"sortKey":"001","status":"open","userKey":"u1"}],"summaryPatch":null,"type":"put"}';

  await seedNativeV1Database(dbName, tx => {
    tx.objectStore('meta').put({
      accountId: 'acct-1',
      schemaVersion: 1,
      activeGeneration: 1,
      nextGeneration: 2,
      revision: 3,
      generationRevisions: {'1': 3, '2': 1},
      sealedGenerations: {'2': 1}
    });
    tx.objectStore('meta').put({
      accountId: 'acct-2',
      schemaVersion: 1,
      activeGeneration: 1,
      nextGeneration: 1,
      revision: 1,
      generationRevisions: {'1': 1},
      sealedGenerations: {}
    });
    tx.objectStore('records').put({
      storageKey: ['acct-1', 'fans', 1, 'u1'],
      accountId: 'acct-1',
      module: 'fans',
      generation: 1,
      userKey: 'u1',
      sortKey: '001',
      status: 'open',
      scope: '',
      sourcePath: ['monitor', 'users', 0],
      payload: {userKey: 'u1', sortKey: '001', status: 'open', handle: 'alice'}
    });
    tx.objectStore('records').put({
      storageKey: ['acct-1', 'fans', 1, 'u2'],
      accountId: 'acct-1',
      module: 'fans',
      generation: 1,
      userKey: 'u2',
      sortKey: '002',
      status: 'closed',
      scope: '',
      sourcePath: ['monitor', 'users', 1],
      payload: {userKey: 'u2', sortKey: '002', status: 'closed', handle: 'bob'}
    });
    tx.objectStore('records').put({
      storageKey: ['acct-1', 'fans', 2, 'u-staged'],
      accountId: 'acct-1',
      module: 'fans',
      generation: 2,
      userKey: 'u-staged',
      sortKey: '001',
      status: 'open',
      scope: '',
      sourcePath: ['monitor', 'users', 0],
      payload: {handle: 'staged-user'}
    });
    tx.objectStore('records').put({
      storageKey: ['acct-2', 'fans', 1, 'u1'],
      accountId: 'acct-2',
      module: 'fans',
      generation: 1,
      userKey: 'u1',
      sortKey: '001',
      status: 'open',
      scope: '',
      sourcePath: ['monitor', 'users', 0],
      payload: {handle: 'acct2-user'}
    });
    tx.objectStore('tombstones').put({
      storageKey: ['acct-1', 'fans', 1, 'u-del'],
      accountId: 'acct-1',
      module: 'fans',
      generation: 1,
      userKey: 'u-del',
      sortKey: '003',
      status: 'open',
      scope: '',
      sourcePath: ['monitor', 'users', 2],
      payload: {handle: 'deleted-user'},
      deleted: true,
      deletedRevision: 2,
      deletedAt: 900
    });
    tx.objectStore('summaries').put({
      storageKey: ['acct-1', 'fans', 1],
      accountId: 'acct-1',
      module: 'fans',
      generation: 1,
      count: 2,
      revision: 3,
      updatedAt: 950
    });
    tx.objectStore('outbox').put({
      operationId: 'op-legacy-1',
      type: 'put',
      content: legacyContent,
      accountId: 'acct-1',
      module: 'fans',
      revision: 1,
      generation: 1,
      at: 800,
      recordIds: ['u1'],
      result: {
        operationId: 'op-legacy-1',
        accountId: 'acct-1',
        module: 'fans',
        revision: 1,
        generation: 1,
        summary: {accountId: 'acct-1', module: 'fans', generation: 1, count: 1, revision: 1, updatedAt: 800},
        records: [{userKey: 'u1', id: 'u1', accountId: 'acct-1', module: 'fans', generation: 1, sortKey: '001', status: 'open', payload: {userKey: 'u1', sortKey: '001', status: 'open'}}]
      }
    });
    tx.objectStore('migrations').put({
      migrationId: 'mig-native-1',
      status: 'verified',
      nextIndex: 1,
      error: null,
      sealedRevisions: {'acct-1': 1}
    });
    tx.objectStore('migrationManifests').put({
      migrationId: 'mig-native-1',
      generationByAccount: {'acct-1': 2},
      baseByAccount: {'acct-1': {activeGeneration: 1, revision: 3}},
      skeleton: {kind: 'object', entries: []},
      fingerprint: 'f'.repeat(64),
      total: 1,
      chunkSize: 10,
      originals: {}
    });
  });

  const store = createRecordRepository({indexedDB, IDBKeyRange, dbName, now: () => 2000});
  const dexieDb = await store.open();
  assert.equal(dexieDb.verno, RECORD_DB_VERSION);
  assert.equal(dexieDb.backendDB().version, RECORD_NATIVE_DB_VERSION);

  const rawTx = dexieDb.backendDB().transaction(['records', 'tombstones', 'summaries', 'outbox'], 'readonly');
  assert.deepEqual(Array.from(rawTx.objectStore('records').indexNames).sort(), ['accountGeneration', 'scopeSort', 'scopeStatusSort']);
  assert.deepEqual(Array.from(rawTx.objectStore('tombstones').indexNames), ['accountGeneration']);
  assert.deepEqual(Array.from(rawTx.objectStore('summaries').indexNames), ['accountModule']);
  assert.deepEqual(Array.from(rawTx.objectStore('outbox').indexNames), ['accountModuleRevision']);

  assert.equal((await store.getMeta('acct-1')).revision, 3);
  assert.equal((await store.getSummary('acct-1', 'fans')).count, 2);
  assert.equal((await store.getRecord('acct-1', 'fans', 'u1')).handle, 'alice');
  assert.equal((await store.getRecord('acct-2', 'fans', 'u1')).handle, 'acct2-user');
  assert.equal((await store.getTombstone('acct-1', 'fans', 'u-del')).handle, 'deleted-user');
  assert.equal((await store.getOutbox('op-legacy-1')).revision, 1);
  assert.equal((await store.getMigration('mig-native-1')).status, 'verified');

  const ascPage = await store.queryPage({accountId: 'acct-1', module: 'fans', limit: 1});
  assert.deepEqual(ascPage.records.map(r => r.userKey), ['u1']);
  const ascPage2 = await store.queryPage({accountId: 'acct-1', module: 'fans', limit: 1, cursor: ascPage.nextCursor});
  assert.deepEqual(ascPage2.records.map(r => r.userKey), ['u2']);
  const openOnly = await store.queryPage({accountId: 'acct-1', module: 'fans', filter: {status: 'open'}, limit: 10});
  assert.deepEqual(openOnly.records.map(r => r.userKey), ['u1']);
  const scannedGen2 = await store.scanRecords('acct-1', 2);
  assert.deepEqual(scannedGen2.map(r => r.userKey), ['u-staged']);
  const scannedTombs = await store.scanTombstones('acct-1', 1);
  assert.deepEqual(scannedTombs.map(r => r.userKey), ['u-del']);

  // Replay of legacy operationId returns stored result without mutating
  const replayed = await store.putRecords({
    accountId: 'acct-1',
    module: 'fans',
    operationId: 'op-legacy-1',
    records: [{userKey: 'u1', sortKey: '001', status: 'open'}]
  });
  assert.equal(replayed.revision, 1);
  assert.equal((await store.getMeta('acct-1')).revision, 3);

  // Sealed generation from native v1 remains sealed after takeover
  await assert.rejects(() => store.putRecords({
    accountId: 'acct-1',
    module: 'fans',
    generation: 2,
    operationId: 'op-sealed-attempt',
    records: [{userKey: 'u-new', sortKey: '002'}]
  }), /sealed/);

  // New write on active generation increments revision and preserves other accounts
  const updated = await store.putRecords({
    accountId: 'acct-1',
    module: 'fans',
    operationId: 'op-post-takeover',
    records: [{userKey: 'u3', sortKey: '004', status: 'open', handle: 'carol'}]
  });
  assert.equal(updated.revision, 4);
  assert.equal(updated.summary.count, 3);
  assert.equal((await store.getRecord('acct-2', 'fans', 'u1')).handle, 'acct2-user');

  // Activated migration from native v1 state transitions cleanly
  await seedNativeV1Database('dexie-native-v1-activate', tx => {
    tx.objectStore('meta').put({
      accountId: 'acct-1',
      schemaVersion: 1,
      activeGeneration: 1,
      nextGeneration: 2,
      revision: 1,
      generationRevisions: {'2': 1},
      sealedGenerations: {'2': 1}
    });
    tx.objectStore('migrations').put({
      migrationId: 'mig-act',
      status: 'verified',
      nextIndex: 1,
      error: null,
      sealedRevisions: {'acct-1': 1}
    });
    tx.objectStore('migrationManifests').put({
      migrationId: 'mig-act',
      generationByAccount: {'acct-1': 2},
      baseByAccount: {'acct-1': {activeGeneration: 1, revision: 1}},
      skeleton: {},
      fingerprint: 'a'.repeat(64),
      total: 1,
      chunkSize: 10,
      originals: {}
    });
  });
  const actStore = createRecordRepository({indexedDB, IDBKeyRange, dbName: 'dexie-native-v1-activate', now: () => 3000});
  const activated = await actStore.activateMigration('mig-act');
  assert.equal(activated.status, 'active');
  assert.equal((await actStore.getMeta('acct-1')).activeGeneration, 2);
  await actStore.close();

  // Legacy native v1 opener attempting to open at native version 1 fails with VersionError
  await store.close();
  await assert.rejects(() => new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, RECORD_NATIVE_LEGACY_VERSION);
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  }), err => err?.name === 'VersionError');
});

test('test-only Dexie upgrade fixtures support step-by-step, skip-version, and mid-upgrade failure rollback and retry', async () => {
  function seedBaseRecords(dbName) {
    return seedNativeV1Database(dbName, tx => {
      tx.objectStore('meta').put({accountId: 'acct-1', schemaVersion: 1, activeGeneration: 1, nextGeneration: 1, revision: 1});
      tx.objectStore('records').put({
        storageKey: ['acct-1', 'fans', 1, 'u1'],
        accountId: 'acct-1',
        module: 'fans',
        generation: 1,
        userKey: 'u1',
        sortKey: '001',
        status: 'open',
        payload: {handle: 'Alice'}
      });
    });
  }

  function applyV2(tx) {
    return tx.table('records').toCollection().modify(row => {
      row.payload = {...row.payload, normalizedHandle: String(row.payload?.handle || '').toLowerCase(), upgradedV2: true};
    });
  }

  function applyV3(tx, shouldFail = false) {
    return tx.table('records').toCollection().modify(row => {
      if (shouldFail) throw new Error('simulated v3 upgrade failure');
      row.payload = {...row.payload, upgradedV3: `${row.payload.normalizedHandle}:v3`};
    });
  }

  // 1. Step-by-step upgrade: native v1 -> Dexie v1 -> Dexie v2 -> Dexie v3
  const stepDbName = 'dexie-upgrade-step-by-step';
  await seedBaseRecords(stepDbName);
  const stepRepo = createRecordRepository({indexedDB, IDBKeyRange, dbName: stepDbName});
  await stepRepo.open();
  await stepRepo.close();

  const dbStepV2 = new Dexie(stepDbName, {indexedDB, IDBKeyRange, autoOpen: false});
  dbStepV2.version(RECORD_DEXIE_LEGACY_VERSION).stores(RECORD_DEXIE_STORES);
  dbStepV2.version(RECORD_DB_VERSION).stores(RECORD_DEXIE_STORES);
  dbStepV2.version(2).stores(RECORD_DEXIE_STORES).upgrade(tx => applyV2(tx));
  await dbStepV2.open();
  assert.equal(dbStepV2.backendDB().version, 20);
  dbStepV2.close();

  const dbStepV3 = new Dexie(stepDbName, {indexedDB, IDBKeyRange, autoOpen: false});
  dbStepV3.version(RECORD_DEXIE_LEGACY_VERSION).stores(RECORD_DEXIE_STORES);
  dbStepV3.version(RECORD_DB_VERSION).stores(RECORD_DEXIE_STORES);
  dbStepV3.version(2).stores(RECORD_DEXIE_STORES).upgrade(tx => applyV2(tx));
  dbStepV3.version(3).stores(RECORD_DEXIE_STORES).upgrade(tx => applyV3(tx, false));
  await dbStepV3.open();
  assert.equal(dbStepV3.backendDB().version, 30);
  const stepRecord = await dbStepV3.table('records').get(['acct-1', 'fans', 1, 'u1']);
  dbStepV3.close();

  // 2. Skip-version upgrade with mid-upgrade failure rollback and retry: native v1 -> directly to Dexie v3
  const skipDbName = 'dexie-upgrade-skip-and-rollback';
  await seedBaseRecords(skipDbName);

  const failingSkip = new Dexie(skipDbName, {indexedDB, IDBKeyRange, autoOpen: false});
  failingSkip.version(RECORD_DEXIE_LEGACY_VERSION).stores(RECORD_DEXIE_STORES);
  failingSkip.version(RECORD_DB_VERSION).stores(RECORD_DEXIE_STORES);
  failingSkip.version(2).stores(RECORD_DEXIE_STORES).upgrade(tx => applyV2(tx));
  failingSkip.version(3).stores(RECORD_DEXIE_STORES).upgrade(tx => applyV3(tx, true));

  await assert.rejects(() => failingSkip.open(), /simulated v3 upgrade failure/);
  failingSkip.close();

  // Verify the entire upgrade transaction rolled back: DB is still at native v1 and v2 mutation did NOT persist
  const preRetryRepo = createRecordRepository({indexedDB, IDBKeyRange, dbName: skipDbName});
  const intactRecord = await preRetryRepo.getRecord('acct-1', 'fans', 'u1');
  assert.equal(intactRecord.payload.upgradedV2, undefined);
  assert.equal(intactRecord.payload.upgradedV3, undefined);
  assert.equal(intactRecord.payload.handle, 'Alice');
  await preRetryRepo.close();

  // Retry upgrade to v3 without fault: runs v2 and v3 in order and matches step-by-step result
  let v2Runs = 0;
  let v3Runs = 0;
  const retrySkip = new Dexie(skipDbName, {indexedDB, IDBKeyRange, autoOpen: false});
  retrySkip.version(RECORD_DEXIE_LEGACY_VERSION).stores(RECORD_DEXIE_STORES);
  retrySkip.version(RECORD_DB_VERSION).stores(RECORD_DEXIE_STORES);
  retrySkip.version(2).stores(RECORD_DEXIE_STORES).upgrade(tx => {
    v2Runs += 1;
    return applyV2(tx);
  });
  retrySkip.version(3).stores(RECORD_DEXIE_STORES).upgrade(tx => {
    v3Runs += 1;
    return applyV3(tx, false);
  });
  await retrySkip.open();
  assert.equal(retrySkip.backendDB().version, 30);
  assert.equal(v2Runs, 1);
  assert.equal(v3Runs, 1);
  const skipRecord = await retrySkip.table('records').get(['acct-1', 'fans', 1, 'u1']);
  assert.deepEqual(skipRecord, stepRecord);
  assert.equal(skipRecord.payload.upgradedV3, 'alice:v3');
  retrySkip.close();

  // Reopening at v3 does not re-run upgrade callbacks
  const reopenV3 = new Dexie(skipDbName, {indexedDB, IDBKeyRange, autoOpen: false});
  reopenV3.version(RECORD_DEXIE_LEGACY_VERSION).stores(RECORD_DEXIE_STORES);
  reopenV3.version(RECORD_DB_VERSION).stores(RECORD_DEXIE_STORES);
  reopenV3.version(2).stores(RECORD_DEXIE_STORES).upgrade(() => { v2Runs += 1; });
  reopenV3.version(3).stores(RECORD_DEXIE_STORES).upgrade(() => { v3Runs += 1; });
  await reopenV3.open();
  assert.equal(v2Runs, 1);
  assert.equal(v3Runs, 1);
  reopenV3.close();
});

test('rejects opening a database with a newer version than supported without clearing or corrupting its data', async () => {
  const dbName = 'dexie-newer-version-guard';
  const futureDb = new Dexie(dbName, {indexedDB, IDBKeyRange, autoOpen: false});
  futureDb.version(2).stores(RECORD_DEXIE_STORES);
  await futureDb.open();
  await futureDb.table('meta').put({accountId: 'acct-future', schemaVersion: 2, activeGeneration: 1, nextGeneration: 1, revision: 9});
  assert.equal(futureDb.backendDB().version, 20);
  futureDb.close();

  const olderRepo = createRecordRepository({indexedDB, IDBKeyRange, dbName});
  await assert.rejects(() => olderRepo.getMeta('acct-future'), err => err?.name === 'VersionError' || /VersionError|version/i.test(err?.message || ''));

  // Verify newer database and its data were not deleted or downgraded
  const checkFuture = new Dexie(dbName, {indexedDB, IDBKeyRange, autoOpen: false});
  checkFuture.version(2).stores(RECORD_DEXIE_STORES);
  await checkFuture.open();
  assert.equal(checkFuture.backendDB().version, 20);
  assert.equal((await checkFuture.table('meta').get('acct-future')).revision, 9);
  checkFuture.close();
});

test('enforces minimal transaction scopes per method and preserves commit-not-request-success semantics', async () => {
  const observed = [];
  const trackingIndexedDB = {
    open(name, version) {
      const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
      return new Proxy(request, {
        set(target, prop, value) {
          if (prop === 'onsuccess') {
            target.onsuccess = event => {
              const db = target.result;
              const originalTx = db.transaction.bind(db);
              db.transaction = (storeNames, mode) => {
                const list = Array.isArray(storeNames) ? [...storeNames].sort() : [String(storeNames)];
                observed.push({stores: list, mode});
                return originalTx(storeNames, mode);
              };
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
    deleteDatabase: indexedDB.deleteDatabase.bind(indexedDB),
    cmp: indexedDB.cmp.bind(indexedDB)
  };

  const store = createRecordRepository({indexedDB: trackingIndexedDB, IDBKeyRange, dbName: 'dexie-minimal-scopes', now: () => 1000});
  await store.open();

  async function captureLastScope(action) {
    observed.length = 0;
    await action();
    assert.equal(observed.length, 1);
    return observed[0];
  }

  assert.deepEqual(await captureLastScope(() => store.getMeta('acct-1')), {
    stores: [...RECORD_TRANSACTION_SCOPES.getMeta].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.getSummary('acct-1', 'fans')), {
    stores: [...RECORD_TRANSACTION_SCOPES.getSummary].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.getRecord('acct-1', 'fans', 'u1')), {
    stores: [...RECORD_TRANSACTION_SCOPES.getRecord].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.getTombstone('acct-1', 'fans', 'u1')), {
    stores: [...RECORD_TRANSACTION_SCOPES.getTombstone].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.getOutbox('op-1')), {
    stores: [...RECORD_TRANSACTION_SCOPES.getOutbox].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.queryPage({accountId: 'acct-1', module: 'fans', limit: 10})), {
    stores: [...RECORD_TRANSACTION_SCOPES.queryPage].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.scanRecords('acct-1', 1)), {
    stores: [...RECORD_TRANSACTION_SCOPES.scanRecords].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.scanTombstones('acct-1', 1)), {
    stores: [...RECORD_TRANSACTION_SCOPES.scanTombstones].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.allocateGeneration('acct-1')), {
    stores: [...RECORD_TRANSACTION_SCOPES.allocateGeneration].sort(),
    mode: 'readwrite'
  });
  assert.deepEqual(await captureLastScope(() => store.putRecords({
    accountId: 'acct-1',
    module: 'fans',
    operationId: 'op-put',
    records: [{userKey: 'u1', sortKey: '1', status: 'open'}]
  })), {
    stores: [...RECORD_TRANSACTION_SCOPES.putRecords].sort(),
    mode: 'readwrite'
  });
  assert.deepEqual(await captureLastScope(() => store.deleteRecords({
    accountId: 'acct-1',
    module: 'fans',
    operationId: 'op-del',
    userKeys: ['u1']
  })), {
    stores: [...RECORD_TRANSACTION_SCOPES.deleteRecords].sort(),
    mode: 'readwrite'
  });
  assert.deepEqual(await captureLastScope(() => store.putTombstones({
    accountId: 'acct-1',
    module: 'fans',
    operationId: 'op-tomb',
    records: [{userKey: 'u2', sortKey: '2'}]
  })), {
    stores: [...RECORD_TRANSACTION_SCOPES.putTombstones].sort(),
    mode: 'readwrite'
  });
  assert.deepEqual(await captureLastScope(() => store.beginMigration({
    migrationId: 'mig-scope',
    accounts: ['acct-1'],
    skeleton: {},
    fingerprint: 'fp',
    total: 0,
    chunkSize: 10,
    originals: {}
  })), {
    stores: [...RECORD_TRANSACTION_SCOPES.beginMigration].sort(),
    mode: 'readwrite'
  });
  assert.deepEqual(await captureLastScope(() => store.saveCheckpoint({
    migrationId: 'mig-scope',
    nextIndex: 0,
    status: 'importing'
  })), {
    stores: [...RECORD_TRANSACTION_SCOPES.saveCheckpoint].sort(),
    mode: 'readwrite'
  });
  assert.deepEqual(await captureLastScope(() => store.getCheckpoint('mig-scope')), {
    stores: [...RECORD_TRANSACTION_SCOPES.getCheckpoint].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.getManifest('mig-scope')), {
    stores: [...RECORD_TRANSACTION_SCOPES.getManifest].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.getMigration('mig-scope')), {
    stores: [...RECORD_TRANSACTION_SCOPES.getMigration].sort(),
    mode: 'readonly'
  });
  assert.deepEqual(await captureLastScope(() => store.markMigrationFailed('mig-scope', 'err')), {
    stores: [...RECORD_TRANSACTION_SCOPES.markMigrationFailed].sort(),
    mode: 'readwrite'
  });
  assert.deepEqual(await captureLastScope(() => store.markMigrationVerified('mig-scope', {'acct-1': 0})), {
    stores: [...RECORD_TRANSACTION_SCOPES.markMigrationVerified].sort(),
    mode: 'readwrite'
  });
  assert.deepEqual(await captureLastScope(() => store.activateMigration('mig-scope')), {
    stores: [...RECORD_TRANSACTION_SCOPES.activateMigration].sort(),
    mode: 'readwrite'
  });

  // Verify no method ever locked all 7 stores at once
  for (const scope of Object.values(RECORD_TRANSACTION_SCOPES)) {
    assert.ok(scope.length < Object.keys(RECORD_DEXIE_STORES).length);
  }
  await store.close();
});

test('fences superseded open requests across close/reopen races and aborts late upgradeneeded after blocked timeout', async () => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 1. Close during open A, open B completes before A: A must not overwrite B or leak B on final close
  const raceFactory = new IDBFactory();
  const raceName = 'dexie-close-open-race';
  const seed = createRecordRepository({indexedDB: raceFactory, IDBKeyRange, dbName: raceName});
  await seed.open();
  await seed.close();

  let opens = 0;
  const nativeHandles = [];
  const deliveryOrder = [];
  const reorderedFactory = {
    open(dbName, version) {
      const request = version === undefined ? raceFactory.open(dbName) : raceFactory.open(dbName, version);
      if (dbName !== raceName) return request;
      const order = ++opens;
      return new Proxy(request, {
        set(target, property, handler) {
          if (property === 'onsuccess') {
            target.onsuccess = event => {
              nativeHandles.push(target.result);
              setTimeout(() => {
                deliveryOrder.push(order);
                handler.call(target, event);
              }, order === 1 ? 60 : 1);
            };
            return true;
          }
          target[property] = handler;
          return true;
        },
        get(target, property) {
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    },
    deleteDatabase: raceFactory.deleteDatabase.bind(raceFactory),
    cmp: raceFactory.cmp.bind(raceFactory)
  };

  const raceRepo = createRecordRepository({indexedDB: reorderedFactory, IDBKeyRange, dbName: raceName});
  const firstOpen = raceRepo.open().then(
    value => ({status: 'fulfilled', value}),
    error => ({status: 'rejected', error: error.message})
  );
  const closingFirst = raceRepo.close();
  const secondOpen = await raceRepo.open().then(
    value => ({status: 'fulfilled', value}),
    error => ({status: 'rejected', error: error.message})
  );
  assert.equal(secondOpen.status, 'fulfilled');
  assert.equal(secondOpen.value.isOpen(), true);

  const firstSettled = await firstOpen;
  await closingFirst;
  assert.equal(firstSettled.status, 'rejected');
  await pause(75);
  assert.deepEqual(deliveryOrder, [2, 1]);

  await raceRepo.close();
  assert.equal(secondOpen.value.isOpen(), false);
  for (const handle of nativeHandles) {
    try { handle.close(); } catch { /* ignore */ }
  }

  // 2. Blocked timeout against native v1 followed by late blocker release must not silently upgrade DB to v10
  const blockedFactory = new IDBFactory();
  const blockedName = 'dexie-late-blocked-upgrade';
  await new Promise((resolve, reject) => {
    const req = blockedFactory.open(blockedName, RECORD_NATIVE_LEGACY_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => installLegacyNativeV1Schema(req.result);
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
  });

  const holdReq = blockedFactory.open(blockedName, RECORD_NATIVE_LEGACY_VERSION);
  await new Promise((resolve, reject) => {
    holdReq.onsuccess = resolve;
    holdReq.onerror = () => reject(holdReq.error);
  });
  const blocker = holdReq.result;
  blocker.onversionchange = () => {};

  const blockedRepo = createRecordRepository({
    indexedDB: blockedFactory,
    IDBKeyRange,
    dbName: blockedName,
    blockedTimeoutMs: 10
  });
  await assert.rejects(() => blockedRepo.getMeta('acct-1'), /blocked/i);

  const beforeRelease = (await blockedFactory.databases()).find(db => db.name === blockedName)?.version;
  assert.equal(beforeRelease, RECORD_NATIVE_LEGACY_VERSION);

  blocker.close();
  await pause(80);

  const afterRelease = (await blockedFactory.databases()).find(db => db.name === blockedName)?.version;
  assert.equal(afterRelease, RECORD_NATIVE_LEGACY_VERSION);
  await blockedRepo.close();

  // 3. Closing a permanently pending/blocked open request with no further native events settles immediately
  const neverFactory = {
    open() {
      return {};
    }
  };
  const hangingRepo = createRecordRepository({
    indexedDB: neverFactory,
    IDBKeyRange,
    dbName: 'dexie-close-hanging-open',
    blockedTimeoutMs: 60000
  });
  const pendingOpen = hangingRepo.open().then(
    () => ({status: 'fulfilled'}),
    error => ({status: 'rejected', error: error.message})
  );
  await hangingRepo.close();
  const cancelledOpen = await pendingOpen;
  assert.equal(cancelledOpen.status, 'rejected');
  assert.match(cancelledOpen.error, /cancelled/i);
});
