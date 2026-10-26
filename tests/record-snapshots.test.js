import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb';
import {createRecordRuntime} from '../src/features/records/record-runtime.js';
import {durableGetStrict, durableSet, durableKeysStrict, durableAppendIncremental, durableCompactSnapshots} from '../src/platform/persistent-db.js';
import {SNAPSHOT_CATALOG, SNAPSHOT_PREFIX, BACKUP_DEFAULTS, validateBackupSettings} from '../src/features/records/record-snapshots.js';

test('backup policy accepts bounded settings and rejects invalid values instead of silently clamping', () => {
  assert.deepEqual(validateBackupSettings(), BACKUP_DEFAULTS);
  for (const value of [{retain:0},{retain:11},{maxAgeHours:0},{checkMinutes:4},{incrementalLimit:99},{retain:1.5},{enabled:'yes'}]) assert.throws(()=>validateBackupSettings(value));
  assert.equal(validateBackupSettings({retain:1}).retain,1);
});

test('complete snapshot restores into a fresh runtime, replays later changes and falls back to retained history', async () => {
  const indexedDB = new IDBFactory();
  globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
  globalThis.chrome = {
    tabs: {query: async () => [{id: 7, status: 'complete'}], get: async () => ({id: 7, status: 'complete'})},
    scripting: {executeScript: async ({func, args}) => [{result: await (0, eval)(`(${func.toString()})`)(...args)}]}
  };
  const makeStorage = data => ({local: {get: async keys => Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])])), set: async patch => Object.assign(data, structuredClone(patch))}});
  let clock = 10000;
  const make = (name, data = {}) => createRecordRuntime({dbName: name, indexedDB, IDBKeyRange, storage: makeStorage(data),
    durableGet: durableGetStrict, durableGetStrict, durableSet, durableKeys: durableKeysStrict, durableKeysStrict,
    durableAppendIncremental, durableCompactSnapshots, now: () => ++clock});
  const live = make('snapshot-live', {unreciprocatedTracker: {users: [{id: '1', handle: 'tester', followedAt: '2026-10-20T10:00:00Z', followedAtSource: 'estimated', exempt: true, greeting: {status: 'sent'}, status: 'pending'}]}});
  await live.migrate();
  const page = await live.query({module: 'unreciprocated', tab: 'all', limit: 10});
  const record = page.records[0];
  const patch = (operationId, data) => live.patchRecord({module: 'unreciprocated', userKey: record.userKey, operationId, patch: data});
  await patch('first', {bio: 'before snapshot'});
  const first = await live.maintainBackups({force: true});
  assert.equal(first.verification.verified, true);
  assert.equal(first.deleted, 1);
  const backupStatus = (await live.handle({op: 'backupStatus'})).result;
  assert.equal(backupStatus.snapshotCount, 1);
  assert.equal(backupStatus.incrementalCount, 0);
  assert.equal(backupStatus.verification.verified, true);
  await live.handle({op: 'backupSettings', value: {...BACKUP_DEFAULTS, enabled: false, checkMinutes: 15}});
  assert.equal((await live.maintainBackups()).reason, 'disabled');
  assert.equal((await live.handle({op: 'backupSettings'})).settings.checkMinutes, 15);
  await assert.rejects(live.handle({op: 'backupSettings', value: {retain: 0}}), /历史快照/);
  assert.equal((await live.handle({op: 'backupSettings'})).settings.retain, 3);
  await live.handle({op: 'backupSettings', value: BACKUP_DEFAULTS});
  assert.equal((await live.maintainBackups()).skipped, true);
  await patch('second', {bio: 'after snapshot'});
  await live.handle({op: 'mergeRoot', key: 'unreciprocatedTracker', fields: {lastCheck: 'after-snapshot'}});
  const restored = make('snapshot-restored');
  await restored.migrate();
  const result = (await restored.query({module: 'unreciprocated', tab: 'all', limit: 10})).records[0];
  assert.equal(result.payload.bio, 'after snapshot');
  assert.equal(result.payload.followedAt, '2026-10-20T10:00:00Z');
  assert.equal(result.payload.exempt, true);
  assert.deepEqual(result.payload.greeting, {status: 'sent'});
  assert.equal((await restored.handle({op: 'metadata', key: 'unreciprocatedTracker'})).metadata.lastCheck, 'after-snapshot');
  await live.maintainBackups({force: true});
  const catalog = await durableGetStrict(SNAPSHOT_CATALOG);
  const newestKey = SNAPSHOT_PREFIX + catalog.snapshots[0].id;
  const newest = await durableGetStrict(newestKey);
  await durableSet(newestKey, {...newest, business: {...newest.business, rows: []}});
  const fallback = make('snapshot-fallback');
  await fallback.migrate();
  assert.equal((await fallback.query({module: 'unreciprocated', tab: 'all', limit: 10})).records[0].payload.bio, 'after snapshot');
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async request => {
    if (request.args[0] === 'set' && request.args[1].startsWith(SNAPSHOT_PREFIX)) {
      const body = JSON.parse(request.args[2]);
      body.v.business.rows = [];
      request.args[2] = JSON.stringify(body);
    }
    return execute(request);
  };
  await assert.rejects(live.maintainBackups({force: true}), /校验失败/);
  chrome.scripting.executeScript = execute;
  assert.deepEqual(await durableGetStrict(SNAPSHOT_CATALOG), catalog);
  assert.equal((await durableGetStrict('recordIncremental:v1:seq:00000002')).seq, 2);
  for (const item of catalog.snapshots) await durableSet(SNAPSHOT_PREFIX + item.id, {corrupt: true});
  const broken = make('snapshot-broken');
  await assert.rejects(broken.migrate(), /校验失败/);
  assert.equal(broken.status().cutover, false);
  await durableSet(SNAPSHOT_CATALOG, null);
  await assert.rejects(make('snapshot-missing-catalog').migrate(), /目录缺失/);
});

