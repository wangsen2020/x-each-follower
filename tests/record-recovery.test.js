import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {createRecordRuntime, LEGACY_RECORD_KEYS} from '../record-runtime.js';
import {hashCanonical} from '../record-migration.js';

function memoryStorage(data = {}) {
  const calls = [];
  return {
    data,
    calls,
    local: {
      async get(keys) {
        calls.push(keys);
        if (!Array.isArray(keys)) throw new Error('legacy read must be a key list');
        const out = {};
        for (const key of keys) if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = structuredClone(data[key]);
        return out;
      },
      async set(payload) {
        calls.push(['set', Object.keys(payload)]);
        for (const [key, value] of Object.entries(payload)) data[key] = structuredClone(value);
      },
      async remove() { throw new Error('runtime must not delete legacy storage'); }
    }
  };
}

function memoryDurable(initial = new Map()) {
  const saved = new Map(initial);
  const writes = [];
  const store = {
    saved,
    writes,
    failGet: false,
    failSet: false,
    async get(key) {
      if (store.failGet) throw new Error('durable get failed');
      return saved.has(key) ? structuredClone(saved.get(key)) : undefined;
    },
    async set(key, value) {
      if (store.failSet) throw new Error('durable set failed');
      writes.push(key);
      saved.set(key, structuredClone(value));
    },
    async keys(prefix = '') {
      if (store.failGet) throw new Error('durable keys failed');
      const matched = [];
      for (const k of saved.keys()) {
        if (!prefix || String(k).startsWith(prefix)) matched.push(k);
      }
      return matched.sort();
    }
  };
  return store;
}

function sampleUsers(count, prefix = 'user') {
  return Array.from({length: count}, (_, i) => ({
    handle: `${prefix}${String(i).padStart(3, '0')}`,
    name: `User ${i}`,
    bio: `Bio for ${prefix}${i}`,
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    status: 'pending'
  }));
}

test('1. 新扩展本地为空，从持久化 v2 快照完整恢复基线数据', async () => {
  const fullSnapshot = {
    commentTracking: {users: sampleUsers(10, 'comment')},
    mutualNetwork: {users: sampleUsers(5, 'mutual')},
    monitor: {users: sampleUsers(8, 'fan'), queue: [], followingUsers: []}
  };
  const fingerprint = await hashCanonical(fullSnapshot);
  const durable = memoryDurable();
  await durable.set(`recordLegacySnapshotBackup:v2:${fingerprint}`, {
    fingerprint,
    snapshot: fullSnapshot,
    savedAt: 1000,
    immutable: true
  });

  // 本地存储完全为空
  const emptyStorage = memoryStorage({});
  const service = createRecordRuntime({
    storage: emptyStorage,
    durableGet: durable.get,
    durableSet: durable.set,
    durableKeys: durable.keys,
    indexedDB,
    IDBKeyRange,
    dbName: 'recovery-test-v2-full'
  });

  const res = await service.migrate();
  assert.equal(res.cutover, true);
  assert.equal(res.stage, 'ready');
  assert.equal(res.total, 23); // 10 + 5 + 8
  assert.equal(res.completed, 23);

  const commentsQuery = await service.query({module: 'comments', limit: 50});
  assert.equal(commentsQuery.records.length, 10);
  const mutualQuery = await service.query({module: 'mutual', limit: 50});
  assert.equal(mutualQuery.records.length, 5);
  const fansQuery = await service.query({module: 'fans', limit: 50});
  assert.equal(fansQuery.records.length, 8);
});

test('2. 存在多个快照时按有效指纹及 savedAt 选择最新有效快照', async () => {
  const oldSnapshot = {commentTracking: {users: sampleUsers(3, 'old')}};
  const oldFingerprint = await hashCanonical(oldSnapshot);
  const newSnapshot = {commentTracking: {users: sampleUsers(7, 'new')}};
  const newFingerprint = await hashCanonical(newSnapshot);

  const durable = memoryDurable();
  await durable.set(`recordLegacySnapshotBackup:v2:${oldFingerprint}`, {
    fingerprint: oldFingerprint,
    snapshot: oldSnapshot,
    savedAt: 1000,
    immutable: true
  });
  await durable.set(`recordLegacySnapshotBackup:v2:${newFingerprint}`, {
    fingerprint: newFingerprint,
    snapshot: newSnapshot,
    savedAt: 2000,
    immutable: true
  });

  const service = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: durable.get,
    durableSet: durable.set,
    durableKeys: durable.keys,
    indexedDB,
    IDBKeyRange,
    dbName: 'recovery-test-v2-latest'
  });

  const res = await service.migrate();
  assert.equal(res.cutover, true);
  assert.equal(res.total, 7);
  const q = await service.query({module: 'comments', limit: 50});
  assert.equal(q.records.length, 7);
  assert.equal(q.records[0].handle, 'new000');
});

test('3. 快照损坏（指纹或内容不匹配）时拒绝恢复并报错，严禁当作空基线', async () => {
  const snapshot = {commentTracking: {users: sampleUsers(5)}};
  const realFingerprint = await hashCanonical(snapshot);
  const durable = memoryDurable();
  // 伪造错误指纹
  await durable.set(`recordLegacySnapshotBackup:v2:corrupted-key`, {
    fingerprint: 'corrupted-key',
    snapshot, // 内容真实 hash 为 realFingerprint，与 corrupted-key 不符
    savedAt: 1000,
    immutable: true
  });

  const service = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: durable.get,
    durableSet: durable.set,
    durableKeys: durable.keys,
    indexedDB,
    IDBKeyRange,
    dbName: 'recovery-test-corrupt'
  });

  await assert.rejects(service.migrate(), /损坏|指纹|校验失败/);
  assert.equal(service.status().cutover, false);
});

test('4. 持久化存储读取异常时阻断迁移并抛错，绝不折算为空基线', async () => {
  const durable = memoryDurable();
  durable.failGet = true; // 模拟连接/标签异常

  const service = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: durable.get,
    durableSet: durable.set,
    durableKeys: durable.keys,
    indexedDB,
    IDBKeyRange,
    dbName: 'recovery-test-access-fail'
  });

  await assert.rejects(service.migrate(), /持久化备份来源访问失败|durable/);
  assert.equal(service.status().cutover, false);
});

test('5. 增量只改动 1 条历史对象，恢复后全部历史对象完好保留且增量生效', async () => {
  const snapshot = {
    commentTracking: {users: sampleUsers(10, 'comment')}
  };
  const fingerprint = await hashCanonical(snapshot);
  const durable = memoryDurable();
  await durable.set(`recordLegacySnapshotBackup:v2:${fingerprint}`, {
    fingerprint,
    snapshot,
    savedAt: 1000,
    immutable: true
  });

  // 在增量日志中只修改第 1 个用户
  const updatedUserKey = 'commentTracking/users/0';
  await durable.set('recordIncremental:v1:seq:00000001', {
    operationId: 'op-patch-user0',
    seq: 1,
    status: 'stored',
    kind: 'batch',
    module: 'comments',
    userKey: updatedUserKey,
    handle: 'comment000',
    payload: {
      handle: 'comment000',
      name: 'Updated Name 0',
      bio: 'Modified Bio',
      lastSeenAt: '2026-02-01T00:00:00.000Z',
      status: 'followed'
    }
  });
  await durable.set('recordIncremental:v1:head', {seq: 1, operationId: 'op-patch-user0'});

  const service = createRecordRuntime({
    storage: memoryStorage({}),
    durableGet: durable.get,
    durableSet: durable.set,
    durableKeys: durable.keys,
    indexedDB,
    IDBKeyRange,
    dbName: 'recovery-test-incremental-overlay'
  });

  const res = await service.migrate();
  assert.equal(res.cutover, true);
  // 所有 10 条全部保留！
  const q = await service.query({module: 'comments', limit: 50});
  assert.equal(q.records.length, 10);
  const u0 = q.records.find(r => r.handle === 'comment000');
  assert.equal(u0.payload.name, 'Updated Name 0');
  assert.equal(u0.payload.bio, 'Modified Bio');
  const u1 = q.records.find(r => r.handle === 'comment001');
  assert.equal(u1.payload.name, 'User 1'); // 未被增量改动的依然原样保留！
});

test('6. 增量序号对账与自愈：head 落后时不报错，对账推进 head 并分配下一序号', async () => {
  const durable = memoryDurable();
  // 模拟现场：head 记录为 1584，但已有 1585 条且 status=stored。
  // 1..1584 必须连续存在，重放才会在缺口处停下而不是把滞后 head 当成空洞。
  for (let seq = 1; seq <= 1584; seq += 1) {
    durable.saved.set(`recordIncremental:v1:seq:${String(seq).padStart(8, '0')}`, {
      operationId: `op-existing-${seq}`,
      seq,
      status: 'stored'
    });
  }
  await durable.set('recordIncremental:v1:head', {seq: 1584, operationId: 'op-old-1584'});
  await durable.set('recordIncremental:v1:seq:00001585', {
    operationId: 'op-existing-1585',
    seq: 1585,
    status: 'stored',
    kind: 'batch',
    module: 'comments',
    userKey: 'u-1585',
    payload: {handle: 'user1585'}
  });

  const snapshot = {commentTracking: {users: sampleUsers(2, 'sync')}};
  const service = createRecordRuntime({
    storage: memoryStorage(snapshot),
    durableGet: durable.get,
    durableSet: durable.set,
    durableKeys: durable.keys,
    indexedDB,
    IDBKeyRange,
    dbName: `recovery-test-head-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`
  });
  await service.migrate();

  // 此时以新 operationId 写入一条记录，绝不抛出 incremental sequence was already published
  const patchRes = await service.patchRecord({
    module: 'comments',
    userKey: 'commentTracking/users/0',
    operationId: 'op-new-1586',
    patch: {bio: 'advanced head safely'}
  });
  assert.equal(patchRes.payload.bio, 'advanced head safely');

  // 验证 head 推进到了 1586
  const head = await durable.get('recordIncremental:v1:head');
  assert.equal(head.seq, 1586);
  assert.equal(head.operationId, 'op-new-1586');

  // 验证 1585 依然完好无损没有被覆盖
  const entry1585 = await durable.get('recordIncremental:v1:seq:00001585');
  assert.equal(entry1585.operationId, 'op-existing-1585');

  // 验证 1586 写入成功
  const entry1586 = await durable.get('recordIncremental:v1:seq:00001586');
  assert.equal(entry1586.operationId, 'op-new-1586');
  assert.equal(entry1586.payload.bio, 'advanced head safely');
});

test('7. 已错误以空基线 cutover 的实例（total=0 但持久快照非空），启动时自动识别并修复重建', async () => {
  const fullSnapshot = {
    commentTracking: {users: sampleUsers(8, 'reconstructed')}
  };
  const fingerprint = await hashCanonical(fullSnapshot);
  const durable = memoryDurable();
  const dbName = 'recovery-test-erroneous-cutover';

  // 1. 先在持久快照为空时，让 service1 完成一次错误的空基线 cutover
  const emptyStorage = memoryStorage({});
  const service1 = createRecordRuntime({
    storage: emptyStorage,
    durableGet: durable.get,
    durableSet: durable.set,
    durableKeys: durable.keys,
    indexedDB,
    IDBKeyRange,
    dbName
  });

  const initialRes = await service1.migrate();
  assert.equal(initialRes.cutover, true);
  assert.equal(initialRes.total, 0);

  // 2. 此时外部非空持久快照恢复/就绪
  await durable.set(`recordLegacySnapshotBackup:v2:${fingerprint}`, {
    fingerprint,
    snapshot: fullSnapshot,
    savedAt: 1000,
    immutable: true
  });

  // 3. 在同一数据库 dbName 上重新启动 service（模拟扩展重载或页面刷新）
  const service2 = createRecordRuntime({
    storage: emptyStorage,
    durableGet: durable.get,
    durableSet: durable.set,
    durableKeys: durable.keys,
    indexedDB,
    IDBKeyRange,
    dbName
  });

  // 4. 执行 migrate，断言同一数据库自动识别坏状态并从快照重建 8 条记录！
  const res = await service2.migrate();
  assert.equal(res.total, 8);
  assert.equal(res.completed, 8);
  assert.equal(res.cutover, true);
  const q = await service2.query({module: 'comments', limit: 50});
  assert.equal(q.records.length, 8);
  assert.equal(q.records[0].handle, 'reconstructed000');
});

function productionAdapters(store, calls) {
  return {
    async durableGet(key) {
      calls.looseGet += 1;
      try { return await store.get(key); } catch { return undefined; }
    },
    async durableKeys(prefix) {
      calls.looseKeys += 1;
      try { return await store.keys(prefix); } catch { return []; }
    },
    durableGetStrict: async key => {
      calls.strictGet += 1;
      return store.get(key);
    },
    durableKeysStrict: async prefix => {
      calls.strictKeys += 1;
      return store.keys(prefix);
    },
    durableSet: (key, value) => store.set(key, value)
  };
}

function readDashboardState(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`${name}-dashboard`);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('state', 'readonly');
      const getReq = tx.objectStore('state').get('runtime');
      getReq.onsuccess = () => {
        const value = getReq.result;
        db.close();
        resolve(value || null);
      };
      getReq.onerror = () => {
        db.close();
        reject(getReq.error);
      };
    };
  });
}

test('background wires strict durable reads into recovery and still keeps forgiving wrappers', () => {
  const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(source, /import\s*\{[^}]*\bdurableGet\b[^}]*\bdurableGetStrict\b[^}]*\bdurableKeysStrict\b[^}]*\}\s*from\s*'\.\/persistent-db\.js'/);
  assert.match(source, /createRecordRuntime\(\{[\s\S]*?\bdurableGet\b[\s\S]*?\bdurableKeys\b[\s\S]*?\bdurableGetStrict\b[\s\S]*?\bdurableKeysStrict\b[\s\S]*?\}\)/);
});

test('8. 生产容错包装读失败时严格枚举阻断空基线，成功的空存储仍可空基线就绪', async () => {
  const failing = memoryDurable();
  failing.failGet = true;
  const calls = {looseGet: 0, looseKeys: 0, strictGet: 0, strictKeys: 0};
  const adapters = productionAdapters(failing, calls);
  const blocked = createRecordRuntime({
    storage: memoryStorage({}),
    ...adapters,
    indexedDB,
    IDBKeyRange,
    dbName: 'recovery-prod-strict-read-fail'
  });
  await assert.rejects(blocked.migrate(), /持久化备份来源访问失败|durable keys failed/);
  assert.equal(blocked.status().cutover, false);
  assert.equal(blocked.status().stage, 'repair-required');
  assert.ok(blocked.status().error);
  assert.ok(calls.strictKeys >= 1);
  assert.equal(calls.looseKeys, 0);

  const emptyCalls = {looseGet: 0, looseKeys: 0, strictGet: 0, strictKeys: 0};
  const emptyStore = memoryDurable();
  const empty = createRecordRuntime({
    storage: memoryStorage({}),
    ...productionAdapters(emptyStore, emptyCalls),
    indexedDB,
    IDBKeyRange,
    dbName: 'recovery-prod-genuine-empty'
  });
  const ready = await empty.migrate();
  assert.equal(ready.cutover, true);
  assert.equal(ready.stage, 'ready');
  assert.equal(ready.total, 0);
  assert.equal(emptyCalls.looseKeys, 0);
  assert.ok(emptyCalls.strictKeys >= 1);

  const reopenCalls = {looseGet: 0, looseKeys: 0, strictGet: 0, strictKeys: 0};
  const reopenStore = memoryDurable();
  reopenStore.failGet = true;
  const reopened = createRecordRuntime({
    storage: memoryStorage({}),
    ...productionAdapters(reopenStore, reopenCalls),
    indexedDB,
    IDBKeyRange,
    dbName: 'recovery-prod-genuine-empty'
  });
  await assert.rejects(reopened.migrate(), /持久化备份来源访问失败|durable keys failed/);
  assert.equal(reopened.status().cutover, false);
  assert.equal(reopened.status().stage, 'repair-required');
  assert.equal(reopenCalls.looseKeys, 0);
});

test('9. 增量重放在缺失或读取失败的序号处停止，不越过缺口，连续日志仍可就绪', async () => {
  const dbName = 'recovery-replay-gap';
  const durable = memoryDurable();
  await durable.set('recordIncremental:v1:head', {seq: 3, operationId: 'op-3'});
  await durable.set('recordIncremental:v1:seq:00000001', {
    operationId: 'op-1', seq: 1, status: 'stored', kind: 'mergeRoot', sourceKey: 'monitor', payload: {kept: true}
  });
  await durable.set('recordIncremental:v1:seq:00000003', {
    operationId: 'op-3', seq: 3, status: 'stored', kind: 'mergeRoot', sourceKey: 'monitor', payload: {kept: true, later: true}
  });
  const calls = {looseGet: 0, looseKeys: 0, strictGet: 0, strictKeys: 0};
  const missing = createRecordRuntime({
    storage: memoryStorage({}),
    ...productionAdapters(durable, calls),
    indexedDB,
    IDBKeyRange,
    dbName
  });
  const missingError = await missing.replayBackups({limit: 50}).then(() => null, error => error);
  assert.equal(missingError?.name, 'IncrementalReplayError');
  assert.equal(missingError?.recoverable, true);
  assert.equal(missingError?.reason, 'missing');
  assert.equal(missingError?.seq, 2);
  assert.match(missingError.message, /缺失/);
  assert.equal(missing.status().cutover, false);
  assert.equal(missing.status().stage, 'repair-required');
  const missingState = await readDashboardState(dbName);
  assert.equal(missingState.cutover, false);
  assert.equal(missingState.metadata?.monitor?.kept, true);
  assert.equal(missingState.metadata?.monitor?.later, undefined);
  assert.equal(calls.looseGet, 0);

  const failedName = 'recovery-replay-read-fail';
  const failing = memoryDurable();
  const readable = failing.get.bind(failing);
  failing.get = async key => {
    if (key === 'recordIncremental:v1:seq:00000002') throw new Error('sequence bridge down');
    return readable(key);
  };
  await failing.set('recordIncremental:v1:head', {seq: 3, operationId: 'op-3'});
  await failing.set('recordIncremental:v1:seq:00000001', {
    operationId: 'op-1', seq: 1, status: 'stored', kind: 'mergeRoot', sourceKey: 'monitor', payload: {kept: true}
  });
  await failing.set('recordIncremental:v1:seq:00000002', {
    operationId: 'op-2', seq: 2, status: 'stored', kind: 'mergeRoot', sourceKey: 'monitor', payload: {kept: true, middle: true}
  });
  await failing.set('recordIncremental:v1:seq:00000003', {
    operationId: 'op-3', seq: 3, status: 'stored', kind: 'mergeRoot', sourceKey: 'monitor', payload: {kept: true, later: true}
  });
  const failed = createRecordRuntime({
    storage: memoryStorage({}),
    ...productionAdapters(failing, {looseGet: 0, looseKeys: 0, strictGet: 0, strictKeys: 0}),
    indexedDB,
    IDBKeyRange,
    dbName: failedName
  });
  const readError = await failed.replayBackups({limit: 50}).then(() => null, error => error);
  assert.equal(readError?.name, 'IncrementalReplayError');
  assert.equal(readError?.recoverable, true);
  assert.equal(readError?.reason, 'read-failed');
  assert.equal(readError?.seq, 2);
  assert.match(readError.message, /sequence bridge down/);
  assert.equal(failed.status().cutover, false);
  assert.equal(failed.status().stage, 'repair-required');
  const failedState = await readDashboardState(failedName);
  assert.equal(failedState.metadata?.monitor?.kept, true);
  assert.equal(failedState.metadata?.monitor?.middle, undefined);
  assert.equal(failedState.metadata?.monitor?.later, undefined);

  const headFailName = 'recovery-replay-head-fail';
  const headStore = memoryDurable();
  const readHead = headStore.get.bind(headStore);
  headStore.get = async key => {
    if (key === 'recordIncremental:v1:head') throw new Error('head bridge down');
    return readHead(key);
  };
  await headStore.set('recordIncremental:v1:seq:00000001', {
    operationId: 'op-1', seq: 1, status: 'stored', kind: 'mergeRoot', sourceKey: 'monitor', payload: {later: true}
  });
  const headFailed = createRecordRuntime({
    storage: memoryStorage({}),
    ...productionAdapters(headStore, {looseGet: 0, looseKeys: 0, strictGet: 0, strictKeys: 0}),
    indexedDB,
    IDBKeyRange,
    dbName: headFailName
  });
  await assert.rejects(headFailed.replayBackups({limit: 50}), /head bridge down/);
  assert.equal(headFailed.status().cutover, false);
  assert.equal(headFailed.status().stage, 'repair-required');

  const happyName = 'recovery-replay-contiguous';
  const happyStore = memoryDurable();
  await happyStore.set('recordIncremental:v1:head', {seq: 2, operationId: 'op-2'});
  await happyStore.set('recordIncremental:v1:seq:00000001', {
    operationId: 'op-1', seq: 1, status: 'stored', kind: 'mergeRoot', sourceKey: 'monitor', payload: {kept: true}
  });
  await happyStore.set('recordIncremental:v1:seq:00000002', {
    operationId: 'op-2', seq: 2, status: 'stored', kind: 'mergeRoot', sourceKey: 'monitor', payload: {kept: true, later: true}
  });
  const happy = createRecordRuntime({
    storage: memoryStorage({}),
    ...productionAdapters(happyStore, {looseGet: 0, looseKeys: 0, strictGet: 0, strictKeys: 0}),
    indexedDB,
    IDBKeyRange,
    dbName: happyName
  });
  const replayed = await happy.replayBackups({limit: 50});
  assert.equal(replayed.applied, 2);
  assert.equal(replayed.nextCursor, null);
  assert.equal(happy.status().cutover, true);
  assert.equal(happy.status().stage, 'ready');
  const happyState = await readDashboardState(happyName);
  assert.equal(happyState.metadata.monitor.later, true);

  const migrateName = 'recovery-migrate-replay-gap';
  const migrateStore = memoryDurable();
  await migrateStore.set('recordIncremental:v1:head', {seq: 2, operationId: 'op-2'});
  await migrateStore.set('recordIncremental:v1:seq:00000002', {
    operationId: 'op-2', seq: 2, status: 'stored', kind: 'mergeRoot', sourceKey: 'monitor', payload: {later: true}
  });
  const migrating = createRecordRuntime({
    storage: memoryStorage({commentTracking: {users: sampleUsers(1, 'gap')}}),
    ...productionAdapters(migrateStore, {looseGet: 0, looseKeys: 0, strictGet: 0, strictKeys: 0}),
    indexedDB,
    IDBKeyRange,
    dbName: migrateName
  });
  await assert.rejects(migrating.migrate(), /增量序号 1 缺失/);
  assert.equal(migrating.status().cutover, false);
  assert.notEqual(migrating.status().stage, 'ready');
  const migrated = await readDashboardState(migrateName);
  assert.equal(migrated.cutover, false);
  assert.equal(migrated.metadata?.monitor?.later, undefined);
});
