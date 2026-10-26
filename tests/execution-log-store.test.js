import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {appendExecutionLog} from '../src/shared/execution-log.js';
import {createExecutionLogStore, createLogPager, getDefaultExecutionLogStore, handleExecutionLogRequest, isExecutionLogSender, resetDefaultExecutionLogStore} from '../src/shared/execution-log-store.js';

function memoryDurable() {
  const saved = new Map();
  return {saved, durableGet: async key => saved.get(key), durableSet: async (key, value) => { saved.set(key, value); }};
}

function legacyStorage(initial = {}) {
  const data = structuredClone(initial);
  return {data, get: async keys => {
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.map(key => [key, data[key]]));
  }, set: async () => { throw new Error('legacy keys must stay intact'); }};
}

function storeFor(storage, durable, dbName) {
  return createExecutionLogStore({dbName, storage, ...durable});
}

test('queue scope isolates mixed writers, pagination totals and clear from followback logs', async () => {
  const durable = memoryDurable(), storage = legacyStorage();
  const store = storeFor(storage, durable, 'logs-queue-isolation');
  for (let i = 0; i < 5; i++) {
    await store.append({id:`q${i}`, scope:'queue', at:`2026-10-24T10:00:0${i}.000Z`});
    await store.append({id:`u${i}`, scope:'unreciprocated', origin:'autoUnfollow', summary:'自动取关', at:`2026-10-24T10:00:0${i}.000Z`});
  }
  await store.append({id:'private', scope:'unreciprocated', summary:'自动私信', at:'2026-10-24T10:01:00.000Z'});
  await store.append({id:'verify', scope:'verification', at:'2026-10-24T10:02:00.000Z'});
  const first = await store.query({scope:'queue', limit:3});
  assert.equal(first.total, 5);
  assert.deepEqual(first.entries.map(row=>row.id), ['q4','q3','q2']);
  const next = await store.query({scope:'queue', limit:3, cursor:first.nextCursor});
  assert.deepEqual(next.entries.map(row=>row.id), ['q1','q0']);
  const before = (await store.query({scope:'unreciprocated'})).entries.map(row=>row.id);
  assert.equal((await store.clear('queue')).removed, 5);
  assert.equal((await store.query({scope:'queue'})).total, 0);
  assert.deepEqual((await store.query({scope:'unreciprocated'})).entries.map(row=>row.id), before);
  const rebuilt = storeFor(storage, durable, 'logs-queue-isolation-rebuild');
  assert.equal((await rebuilt.query({scope:'queue'})).total, 0);
  assert.deepEqual((await rebuilt.query({scope:'unreciprocated'})).entries.map(row=>row.id), before);
});

test('fan queue log scope indexes historical and new rows before pagination', async () => {
  const durable = memoryDurable(), storage = legacyStorage();
  const name = 'logs-fan-queue-pages';
  const store = storeFor(storage, durable, name);
  await store.append({id:'old-fan', scope:'queue', sources:[{module:'fans'}], at:'2026-10-24T10:00:00.000Z'});
  const db = await new Promise((resolve,reject)=>{const req=indexedDB.open(name);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(['logs','scopeRows','meta'],'readwrite');
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    const req=tx.objectStore('logs').get('old-fan');
    req.onsuccess=()=>{
      const old=req.result;
      old.scopeSchemaVersion=2;
      old.membership=old.membership.filter(scope=>scope!=='queueFans');
      tx.objectStore('logs').put(old);
      tx.objectStore('scopeRows').delete(['queueFans',old.at,old.id]);
      tx.objectStore('meta').delete('queueFansScopeV1');
    };
  });
  db.close();
  const reopened=storeFor(storage,durable,name);
  for(let i=0;i<35;i++) await reopened.append({id:`normal-${i}`,scope:'queue',sources:[{module:'comments'}],at:`2026-10-25T10:00:${String(i).padStart(2,'0')}.000Z`});
  await reopened.append({id:'new-fan',scope:'queue',sources:[{module:'fans'}],at:'2026-10-25T11:00:00.000Z'});
  const first=await reopened.query({scope:'queueFans',limit:1});
  assert.equal(first.total,2);
  assert.deepEqual(first.entries.map(row=>row.id),['new-fan']);
  const second=await reopened.query({scope:'queueFans',limit:1,cursor:first.nextCursor});
  assert.deepEqual(second.entries.map(row=>row.id),['old-fan']);
  assert.equal(second.nextCursor,null);
  await reopened.clear('queue');
  assert.equal((await reopened.query({scope:'queueFans'})).total,0);
  const recovered=storeFor(storage,durable,'logs-fan-queue-recovered');
  assert.equal((await recovered.query({scope:'queueFans'})).total,0);
});

test('legacy backup memberships gain a queue index without copying unrelated events', async () => {
  const durable = memoryDurable();
  durable.saved.set('executionLogBackupHead', {n:2});
  for (const [index, scope] of ['queue','unreciprocated'].entries()) durable.saved.set(`executionLogBackupPage:${index+1}`, {op:'put', record:{id:scope, scope, at:'2026-10-24T10:00:00.000Z', origin:'autoFollowLogs', membership:['autoFollow', ...(scope === 'unreciprocated' ? ['unreciprocated'] : [])]}});
  const store = storeFor(legacyStorage(), durable, 'logs-old-membership-replay');
  assert.deepEqual((await store.query({scope:'queue'})).entries.map(row=>row.id), ['queue']);
  assert.deepEqual((await store.query({scope:'unreciprocated'})).entries.map(row=>row.id), ['unreciprocated']);
});

test('existing local database gains queue membership without losing followback rows', async () => {
  const name = 'logs-local-scope-upgrade', durable = memoryDurable(), storage = legacyStorage();
  const store = storeFor(storage, durable, name);
  const at = '2026-10-24T10:00:00.000Z';
  await store.append({id:'queue-local', scope:'queue', at});
  await store.append({id:'unfollow-local', scope:'unreciprocated', at});
  const db = await new Promise((resolve,reject)=>{const req=indexedDB.open(name);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  await new Promise((resolve,reject)=>{
    const tx = db.transaction(['logs','scopeRows','meta'], 'readwrite');
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    const request=tx.objectStore('logs').get('queue-local');
    request.onsuccess=()=>{
      const old=request.result;delete old.scopeSchemaVersion;old.membership=['autoFollow'];
      tx.objectStore('logs').put(old);
      tx.objectStore('scopeRows').delete(['queue',at,'queue-local']);
      tx.objectStore('meta').delete('queueScopeV2');
    };
  });
  db.close();
  const reopened=storeFor(storage,durable,name);
  assert.equal((await reopened.query({scope:'queue'})).total,1);
  assert.equal((await reopened.query({scope:'unreciprocated'})).total,1);
});

test('more than 300 entries stay queryable and identical timestamps page in id order', async () => {
  const durable = memoryDurable();
  const storage = legacyStorage();
  const store = storeFor(storage, durable, 'logs-volume');
  const at = '2026-10-19T00:00:00.000Z';
  for (let i = 0; i < 305; i += 1) {
    await store.append({id: `id-${String(i).padStart(4, '0')}`, scope: 'comment', at, detail: 'row', posts: [{text: 'post', url: 'https://x.com/a/status/1'}], evaluations: [{text: 'eval'}]});
  }
  const first = await store.query({scope: 'comment', limit: 30});
  assert.equal(first.total, 305);
  assert.equal(first.entries.length, 30);
  assert.equal(first.entries[0].id, 'id-0304');
  assert.equal(first.entries[0].posts.length, 1);
  assert.equal(first.entries[0].evaluations[0].text, 'eval');
  assert.ok(first.nextCursor);
  const second = await store.query({scope: 'comment', limit: 30, cursor: first.nextCursor});
  assert.equal(second.entries[0].id, 'id-0274');
  assert.equal(second.entries.at(-1).id, 'id-0245');
  const pager = createLogPager();
  pager.notePage(pager.begin(), first);
  assert.equal(pager.forward(), true);
  assert.deepEqual(pager.cursor(), first.nextCursor);
  pager.notePage(pager.begin(), {nextCursor: null});
  assert.equal(pager.forward(), false);
  assert.equal(pager.back(), true);
  assert.equal(pager.cursor(), null);
  assert.equal(pager.back(), false);
});

test('scopes keep monitor and tracker logs beside selectExecutionLogs rules', async () => {
  const store = storeFor(legacyStorage(), memoryDurable(), 'logs-scopes');
  await store.append({id: 'comment', scope: 'comment', at: '2026-10-19T01:00:00.000Z', origin: 'autoFollowLogs'});
  await store.append({id: 'queue', scope: 'queue', at: '2026-10-19T02:00:00.000Z', sources: [{module: 'comments'}], origin: 'autoFollowLogs'});
  await store.append({id: 'fan', scope: 'fans', at: '2026-10-19T03:00:00.000Z', origin: 'monitorLogs', summary: 'sync'});
  await store.append({id: 'track', scope: 'unreciprocated', at: '2026-10-19T04:00:00.000Z', origin: 'unreciprocatedLogs', summary: 'scan'});
  await store.append({id: 'verify', scope: 'verification', at: '2026-10-19T05:00:00.000Z', origin: 'autoFollowLogs'});
  assert.deepEqual((await store.query({scope: 'comment'})).entries.map(entry => entry.id), ['verify', 'queue', 'comment']);
  assert.deepEqual((await store.query({scope: 'mutual'})).entries.map(entry => entry.id), ['verify']);
  assert.deepEqual((await store.query({scope: 'fans'})).entries.map(entry => entry.id), ['verify', 'fan']);
  assert.deepEqual((await store.query({scope: 'monitor'})).entries.map(entry => entry.id), ['verify', 'fan']);
  assert.deepEqual((await store.query({scope: 'unreciprocated'})).entries.map(entry => entry.id), ['verify', 'track']);
  assert.deepEqual((await store.query({scope: 'autoFollow'})).entries.map(entry => entry.id), ['verify', 'queue', 'comment']);
});

test('concurrent appends and episode updates keep the original id and time', async () => {
  const store = storeFor(legacyStorage(), memoryDurable(), 'logs-concurrent');
  const at = '2026-10-01T00:00:00.000Z';
  await Promise.all(Array.from({length: 25}, (_, index) => store.append({scope: 'mutual', detail: String(index), at: `2026-10-18T00:00:${String(index).padStart(2, '0')}.000Z`})));
  assert.equal((await store.query({scope: 'mutual'})).total, 25);
  const first = await store.append({id: 'episode-1', scope: 'verification', episodeKey: '8:' + at, tabId: 8, at, detail: 'first', signals: ['A']});
  const second = await store.append({scope: 'verification', episodeKey: '8:' + at, tabId: 8, at: '2026-10-02T00:00:00.000Z', detail: 'second', signals: ['B']});
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(second.entry.at, at);
  assert.equal(second.entry.detail, 'second');
  assert.equal((await store.query({scope: 'autoFollow', limit: 50})).entries.filter(entry => entry.scope === 'verification').length, 1);
});

test('migration is idempotent, keeps legacy keys, and recovers from backup pages', async () => {
  const initial = {
    autoFollowLogs: [{id: 'kept', scope: 'comment', at: '2026-10-10T00:00:00.000Z', detail: 'full', posts: [{text: 'body'}]}],
    monitorLogs: [{id: 'mon', scope: 'fans', at: '2026-10-11T00:00:00.000Z', summary: 'fans'}],
    unreciprocatedLogs: [{at: '2026-10-12T00:00:00.000Z', summary: 'tracker', result: 'success'}]
  };
  const storage = legacyStorage(initial);
  const durable = memoryDurable();
  const store = storeFor(storage, durable, 'logs-migrate');
  await store.ready();
  await store.ready();
  const page = await store.query({scope: 'comment', limit: 10});
  assert.equal(page.entries[0].id, 'kept');
  assert.equal(page.entries[0].posts[0].text, 'body');
  assert.equal((await store.query({scope: 'fans'})).entries.some(entry => entry.id === 'mon'), true);
  assert.equal((await store.query({scope: 'unreciprocated'})).total, 1);
  assert.deepEqual(storage.data.autoFollowLogs, initial.autoFollowLogs);
  assert.deepEqual(storage.data.monitorLogs, initial.monitorLogs);
  const restarted = storeFor(storage, durable, 'logs-migrate');
  assert.equal((await restarted.query({scope: 'comment'})).total, 1);
  const backupKeys = [...durable.saved.keys()];
  await store.append({id: 'kept', scope: 'comment', at: '2026-10-10T00:00:00.000Z', detail: 'changed'});
  for (const key of backupKeys) assert.equal(durable.saved.has(key), true);
  const recovered = storeFor(legacyStorage({autoFollowLogs: [], monitorLogs: [], unreciprocatedLogs: []}), durable, 'logs-recover');
  const restored = await recovered.query({scope: 'comment', limit: 10});
  assert.equal(restored.entries.some(entry => entry.id === 'kept' && entry.detail === 'changed'), true);
});

test('clear archives one scope and does not resurrect legacy rows', async () => {
  const storage = legacyStorage({autoFollowLogs: [{id: 'c', scope: 'comment', at: '2026-10-01T00:00:00.000Z'}], monitorLogs: [{id: 'm', scope: 'fans', at: '2026-10-02T00:00:00.000Z'}]});
  const durable = memoryDurable();
  const store = storeFor(storage, durable, 'logs-clear');
  await store.ready();
  const cleared = await store.clear('comment');
  assert.equal(cleared.removed, 1);
  assert.equal((await store.query({scope: 'comment'})).total, 0);
  assert.equal((await store.query({scope: 'fans'})).total, 1);
  assert.equal(storage.data.autoFollowLogs.length, 1);
  assert.ok([...durable.saved.keys()].some(key => key.startsWith('executionLogClearArchive:')));
  const again = storeFor(storage, durable, 'logs-clear');
  assert.equal((await again.query({scope: 'comment'})).total, 0);
});

test('message handler validates the extension sender and reports failures', async () => {
  const runtime = {id: 'ext', getURL: path => `chrome-extension://ext/${path}`};
  assert.equal(isExecutionLogSender({id: 'other'}, runtime), false);
  assert.equal(isExecutionLogSender({id: 'ext', tab: {id: 1}, url: 'https://x.com/'}, runtime), false);
  const store = storeFor(legacyStorage(), memoryDurable(), 'logs-handler');
  const denied = await new Promise(resolve => {
    handleExecutionLogRequest({cmd: 'queryExecutionLogs', scope: 'comment'}, {id: 'no'}, resolve, store, runtime);
  });
  assert.equal(denied.ok, false);
  const failed = storeFor({get: async () => { throw new Error('storage failed'); }}, memoryDurable(), 'logs-fail');
  const broken = await new Promise(resolve => {
    handleExecutionLogRequest({cmd: 'appendExecutionLog', entry: {scope: 'comment'}}, {id: 'ext', url: 'chrome-extension://ext/panel.html'}, resolve, failed, runtime);
  });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /storage failed/);
  let writes = 0;
  const durable = memoryDurable();
  const failingSet = async () => { writes += 1; throw new Error('backup down'); };
  const live = createExecutionLogStore({dbName: 'logs-backup-down', storage: legacyStorage({autoFollowLogs: [], monitorLogs: [], unreciprocatedLogs: []}), durableGet: durable.durableGet, durableSet: failingSet});
  await assert.rejects(live.append({id: 'kept-local', scope: 'mutual', detail: 'still saved', posts: [{text: 'p'}]}), /backup down/);
  assert.equal((await live.query({scope: 'mutual'})).entries[0].detail, 'still saved');
  assert.equal(live.backupStatus().ok, false);
  await live.ready();
  await live.ready();
  await live.ready();
  const stopped = writes;
  await live.ready();
  assert.equal(writes, stopped);
  assert.equal(durable.saved.size, 0);
});

test('production append returns the stored entry instead of the legacy array', async () => {
  const storage = {get: async () => ({}), set: async () => { throw new Error('whole write'); }};
  const prior = globalThis.chrome;
  globalThis.chrome = {
    storage: {local: storage}, runtime: {id: 'ext', getURL: path => path},
    tabs: {query: async () => [{id: 1, status: 'complete'}], get: async () => ({id: 1, status: 'complete'})},
    scripting: {executeScript: async ({args}) => {
      if (args[0] !== 'get') throw new Error('backup write unavailable');
      return [{result: JSON.stringify({found: false})}];
    }}
  };
  resetDefaultExecutionLogStore();
  try {
    await assert.rejects(appendExecutionLog({id: 'indexed-1', scope: 'comment', detail: 'indexed', posts: [{text: 'kept'}]}));
    const page = await getDefaultExecutionLogStore().query({scope: 'comment'});
    assert.equal(page.entries[0].posts[0].text, 'kept');
    assert.equal(Array.isArray(page.entries[0]), false);
    assert.equal(getDefaultExecutionLogStore().backupStatus().ok, false);
  } finally {
    resetDefaultExecutionLogStore();
    globalThis.chrome = prior;
  }
});

test('a stale log page token does not replace the active page', () => {
  const pager = createLogPager();
  const first = pager.begin();
  const second = pager.reset();
  assert.equal(pager.notePage(first, {nextCursor: {at: 'old', id: 'old'}}), false);
  const current = pager.begin();
  assert.equal(pager.current(second), false);
  assert.equal(pager.notePage(current, {nextCursor: {at: 'new', id: 'new'}}), true);
  assert.equal(pager.canNext(), true);
});

test('recreated service keeps every backup page and continues the head', async () => {
  const old = {autoFollowLogs: [{id: 'old', at: '2026-01-01T00:00:00.000Z', scope: 'mutual', detail: 'old'}]};
  const backups = new Map();
  const opts = {
    dbName: 'xf-codex-logs-review-20261019-1',
    storage: {get: async () => structuredClone(old)},
    durableGet: async key => structuredClone(backups.get(key)),
    durableSet: async (key, value) => {
      if (key.startsWith('executionLogBackupPage:') && backups.has(key)) throw new Error('overwrite ' + key);
      backups.set(key, structuredClone(value));
    }
  };
  const first = createExecutionLogStore(opts);
  await first.append({id: 'one', at: '2026-01-02T00:00:00.000Z', scope: 'mutual'});
  const second = createExecutionLogStore(opts);
  await second.append({id: 'two', at: '2026-01-03T00:00:00.000Z', scope: 'mutual'});
  assert.deepEqual((await second.query({scope: 'mutual', limit: 5})).entries.map(entry => entry.id), ['two', 'one', 'old']);
  assert.equal(backups.get('executionLogBackupHead').n, 2);
  assert.equal(backups.get('executionLogBackupPage:1').record.id, 'one');
  assert.equal(backups.get('executionLogBackupPage:2').record.id, 'two');
});

test('rebuild imports legacy rows before journal so clears and episode updates win', async () => {
  const at = '2026-10-01T00:00:00.000Z';
  const initial = {autoFollowLogs: [{id: 'episode-1', scope: 'verification', episodeKey: '8:' + at, tabId: 8, at, detail: 'old'}], monitorLogs: [], unreciprocatedLogs: []};
  const storage = legacyStorage(initial);
  const durable = memoryDurable();
  const live = storeFor(storage, durable, 'logs-order-live');
  await live.append({scope: 'verification', episodeKey: '8:' + at, tabId: 8, at: '2026-10-02T00:00:00.000Z', detail: 'new'});
  await live.clear('autoFollow');
  const rebuilt = storeFor(storage, durable, 'logs-order-rebuilt');
  assert.equal((await rebuilt.query({scope: 'autoFollow'})).total, 0);
  assert.deepEqual(storage.data.autoFollowLogs, initial.autoFollowLogs);
  const restarted = storeFor(storage, durable, 'logs-order-live');
  assert.equal((await restarted.query({scope: 'autoFollow'})).total, 0);
});

test('missing backup page stays an error and absent legacy keys are an empty import', async () => {
  const gaps = memoryDurable();
  gaps.saved.set('executionLogBackupHead', {n: 2});
  gaps.saved.set('executionLogBackupPage:1', {op: 'put', record: {id: 'only', at: '2026-10-01T00:00:00.000Z', scope: 'mutual', origin: 'autoFollowLogs', membership: ['autoFollow', 'mutual']}});
  const broken = storeFor(legacyStorage({autoFollowLogs: [], monitorLogs: [], unreciprocatedLogs: []}), gaps, 'logs-gap');
  await assert.rejects(broken.ready(), /备份页缺失: 2/);
  await assert.rejects(broken.query({scope: 'mutual'}), /备份页缺失: 2/);
  let legacyReads = 0;
  const delayed = {autoFollowLogs: undefined};
  const waitingDurable = memoryDurable();
  const waiting = createExecutionLogStore({
    dbName: 'logs-wait',
    storage: {get: async keys => { legacyReads += 1; return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, delayed[key]])); }},
    durableGet: async key => waitingDurable.saved.get(key),
    durableSet: waitingDurable.durableSet
  });
  await waiting.ready();
  assert.equal((await waiting.query({scope: 'mutual'})).total, 0);
  const readsAfterImport = legacyReads;
  delayed.autoFollowLogs = [{id: 'later', scope: 'mutual', at: '2026-10-04T00:00:00.000Z'}];
  delayed.monitorLogs = [];
  delayed.unreciprocatedLogs = [];
  assert.equal((await waiting.query({scope: 'mutual'})).total, 0);
  assert.equal(legacyReads, readsAfterImport);
  const thrown = createExecutionLogStore({
    dbName: 'logs-throw',
    storage: {get: async () => { throw new Error('storage failed'); }},
    ...memoryDurable()
  });
  await assert.rejects(thrown.append({id: 'x', scope: 'mutual'}), /storage failed/);
  let reads = 0;
  const partial = createExecutionLogStore({
    dbName: 'logs-partial',
    storage: {get: async () => { reads += 1; if (reads === 1) throw new Error('import interrupted'); return {autoFollowLogs: [{id: 'once', scope: 'comment', at: '2026-10-05T00:00:00.000Z'}], monitorLogs: [], unreciprocatedLogs: []}; }},
    ...memoryDurable()
  });
  await assert.rejects(partial.ready(), /import interrupted/);
  assert.equal((await partial.query({scope: 'comment'})).entries.map(entry => entry.id).join(), 'once');
});

test('a warm query does not reread backups and a failed page blocks the next head', async () => {
  let backupReads = 0;
  const saved = new Map();
  const storage = legacyStorage();
  const store = createExecutionLogStore({
    dbName: 'logs-warm',
    storage,
    durableGet: async key => { if (String(key).startsWith('executionLogBackup')) backupReads += 1; return saved.get(key); },
    durableSet: async (key, value) => { saved.set(key, structuredClone(value)); }
  });
  await store.ready();
  await store.append({id: 'warm', scope: 'comment', at: '2026-10-07T00:00:00.000Z'});
  const before = backupReads;
  await store.query({scope: 'comment'});
  await store.query({scope: 'comment'});
  assert.equal(backupReads, before);
  let blockFirst = true;
  const ordered = new Map();
  const gapStore = createExecutionLogStore({
    dbName: 'logs-ordered-outbox',
    storage: legacyStorage(),
    durableGet: async key => ordered.get(key),
    durableSet: async (key, value) => {
      if (blockFirst && key === 'executionLogBackupPage:1') throw new Error('page1 down');
      ordered.set(key, structuredClone(value));
    }
  });
  await assert.rejects(gapStore.append({id: 'first', scope: 'mutual', at: '2026-10-08T00:00:00.000Z'}), /page1 down/);
  await assert.rejects(gapStore.append({id: 'second', scope: 'mutual', at: '2026-10-08T01:00:00.000Z'}), /page1 down/);
  assert.equal(ordered.has('executionLogBackupPage:2'), false);
  assert.equal(ordered.get('executionLogBackupHead'), undefined);
  assert.deepEqual((await gapStore.query({scope: 'mutual'})).entries.map(entry => entry.id), ['second', 'first']);
  blockFirst = false;
  await gapStore.ready();
  assert.equal(ordered.get('executionLogBackupPage:1').record.id, 'first');
  assert.equal(ordered.get('executionLogBackupPage:2').record.id, 'second');
  assert.equal(ordered.get('executionLogBackupHead').n, 2);
});

test('query rejects an unknown scope or cursor and uses the injected key range', async () => {
  const calls = [];
  const range = {bound(...args) { calls.push(args); return globalThis.IDBKeyRange.bound(...args); }};
  const store = createExecutionLogStore({dbName: 'logs-range', storage: legacyStorage({autoFollowLogs: [], monitorLogs: [], unreciprocatedLogs: []}), ...memoryDurable(), IDBKeyRange: range});
  await store.append({id: 'r1', scope: 'comment', at: '2026-10-06T00:00:00.000Z'});
  await store.query({scope: 'comment', cursor: {at: '2026-10-06T00:00:00.000Z', id: 'r1'}});
  assert.ok(calls.length >= 1);
  await assert.rejects(store.query({scope: 'other'}), /未知日志范围/);
  await assert.rejects(store.query({scope: 'comment', cursor: {at: 1, id: 'r1'}}), /日志游标无效/);
});

test('numeric timestamps stay visible after query and restart; invalid timestamps are rejected', async () => {
  const durable = memoryDurable();
  const storage = legacyStorage({
    autoFollowLogs: [{id: 'legacy-num', scope: 'comment', at: Date.parse('2026-10-03T00:00:00.000Z'), detail: 'kept'}],
    monitorLogs: [],
    unreciprocatedLogs: []
  });
  const store = storeFor(storage, durable, 'logs-numeric-at');
  const millis = Date.parse('2026-10-19T08:30:00.000Z');
  const written = await store.append({id: 'numeric', scope: 'comment', at: millis, detail: 'now'});
  assert.equal(written.entry.at, '2026-10-19T08:30:00.000Z');
  assert.equal(typeof written.entry.at, 'string');
  const page = await store.query({scope: 'comment', limit: 10});
  assert.equal(page.total, 2);
  assert.deepEqual(page.entries.map(entry => entry.id), ['numeric', 'legacy-num']);
  assert.equal(page.entries[0].at, '2026-10-19T08:30:00.000Z');
  assert.equal(page.entries[1].at, '2026-10-03T00:00:00.000Z');
  const iso = await store.append({id: 'iso', scope: 'mutual', at: '2026-10-19T09:00:00.000Z'});
  assert.equal(iso.entry.at, '2026-10-19T09:00:00.000Z');
  await assert.rejects(store.append({id: 'bad-text', scope: 'comment', at: 'not-a-date'}), /日志时间无效/);
  await assert.rejects(store.append({id: 'bad-nan', scope: 'comment', at: Number.NaN}), /日志时间无效/);
  await assert.rejects(store.append({id: 'bad-inf', scope: 'comment', at: Number.POSITIVE_INFINITY}), /日志时间无效/);
  assert.equal((await store.query({scope: 'comment'})).total, 2);
  const restarted = storeFor(storage, durable, 'logs-numeric-at');
  const again = await restarted.query({scope: 'comment', limit: 10});
  assert.equal(again.total, 2);
  assert.equal(again.entries[0].id, 'numeric');
  assert.equal(again.entries[0].at, '2026-10-19T08:30:00.000Z');
  const replayDurable = memoryDurable();
  replayDurable.saved.set('executionLogBackupHead', {n: 1});
  replayDurable.saved.set('executionLogBackupPage:1', {op: 'put', record: {id: 'replayed-num', at: millis, scope: 'mutual', origin: 'autoFollowLogs', membership: ['autoFollow', 'mutual'], detail: 'raw'}});
  const replayed = storeFor(legacyStorage({autoFollowLogs: [], monitorLogs: [], unreciprocatedLogs: []}), replayDurable, 'logs-numeric-replay');
  const replayPage = await replayed.query({scope: 'mutual', limit: 5});
  assert.equal(replayPage.total, 1);
  assert.equal(replayPage.entries[0].id, 'replayed-num');
  assert.equal(replayPage.entries[0].at, '2026-10-19T08:30:00.000Z');
  assert.equal(replayDurable.saved.get('executionLogBackupPage:1').record.at, millis);
});

test('malformed legacy timestamps stay imported and offset timestamps order as UTC instants', async () => {
  const storage = legacyStorage({
    autoFollowLogs: [
      {id: 'bad', scope: 'comment', at: 'not-a-date', detail: 'kept'},
      {id: 'after-bad', scope: 'comment', at: '2026-10-04T00:00:00.000Z', detail: 'later'}
    ],
    monitorLogs: [{id: 'fan-ok', scope: 'fans', at: '2026-10-05T00:00:00.000Z', summary: 'fans'}],
    unreciprocatedLogs: []
  });
  const store = storeFor(storage, memoryDurable(), 'logs-malformed-legacy');
  const imported = await store.query({scope: 'comment', limit: 10});
  assert.equal(imported.total, 2);
  assert.deepEqual(imported.entries.map(entry => entry.id), ['after-bad', 'bad']);
  assert.equal(imported.entries[1].at, 'not-a-date');
  assert.equal(imported.entries[1].detail, 'kept');
  assert.equal((await store.query({scope: 'fans'})).entries[0].id, 'fan-ok');
  const plus = await store.append({id: 'plus', scope: 'mutual', at: '2026-10-19T12:00:00+08:00'});
  const zone = await store.append({id: 'zone', scope: 'mutual', at: '2026-10-19T03:00:00.000Z'});
  const minus = await store.append({id: 'minus', scope: 'mutual', at: '2026-10-19T08:00:00-05:00'});
  assert.equal(plus.entry.at, '2026-10-19T04:00:00.000Z');
  assert.equal(plus.entry.atRaw, '2026-10-19T12:00:00+08:00');
  assert.equal(zone.entry.at, '2026-10-19T03:00:00.000Z');
  assert.equal(zone.entry.atRaw, undefined);
  assert.equal(minus.entry.at, '2026-10-19T13:00:00.000Z');
  assert.equal(minus.entry.atRaw, '2026-10-19T08:00:00-05:00');
  assert.deepEqual((await store.query({scope: 'mutual', limit: 10})).entries.map(entry => entry.id), ['minus', 'plus', 'zone']);
  await assert.rejects(store.append({id: 'still-bad', scope: 'mutual', at: 'not-a-date'}), /日志时间无效/);
  assert.equal((await store.query({scope: 'mutual'})).total, 3);
  const huge = legacyStorage({
    autoFollowLogs: [
      {id: 'huge', scope: 'comment', at: 1e20, detail: 'overflow'},
      {id: 'after-huge', scope: 'comment', at: '2026-10-06T00:00:00.000Z'}
    ],
    monitorLogs: [],
    unreciprocatedLogs: []
  });
  const hugeStore = storeFor(huge, memoryDurable(), 'logs-numeric-overflow');
  const hugePage = await hugeStore.query({scope: 'comment', limit: 10});
  assert.equal(hugePage.total, 2);
  assert.deepEqual(hugePage.entries.map(entry => entry.id), ['after-huge', 'huge']);
  assert.equal(hugePage.entries[1].at, 1e20);
  assert.equal(hugePage.entries[1].detail, 'overflow');
  await assert.rejects(hugeStore.append({id: 'huge-new', scope: 'comment', at: 1e20}), /日志时间无效/);
  assert.equal((await hugeStore.query({scope: 'comment'})).total, 2);
});

test('worker log modules do not use dynamic import', () => {
  for (const name of ['src/shared/execution-log.js', 'src/shared/execution-log-store.js', 'src/shared/execution-log-select.js', 'src/platform/persistent-db.js']) {
    const text = fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
    assert.equal(/import\s*\(/.test(text), false, name);
  }
});

test('log date range covers counts and cursor pages without removing history',async()=>{
 const store=storeFor(legacyStorage(),memoryDurable(),'logs-date-range');
 for(let i=1;i<=4;i++)await store.append({id:`range-${i}`,scope:'comment',at:`2026-10-0${i}T00:00:00.000Z`});
 const since='2026-10-02T00:00:00.000Z';
 const first=await store.query({scope:'comment',limit:2,since});
 assert.equal(first.total,3);assert.deepEqual(first.entries.map(e=>e.id),['range-4','range-3']);
 const last=await store.query({scope:'comment',limit:2,since,cursor:first.nextCursor});
 assert.equal(last.total,3);assert.deepEqual(last.entries.map(e=>e.id),['range-2']);assert.equal(last.nextCursor,null);
 assert.equal((await store.query({scope:'comment'})).total,4);
 await assert.rejects(store.query({scope:'comment',since:'invalid'}));
 await assert.rejects(store.query({scope:'comment',since,cursor:{at:'2026-10-01T00:00:00.000Z',id:'range-1'}}));
});

test('unfollow log filtering scans beyond unrelated newest pages and counts only matches',async()=>{
 const store=storeFor(legacyStorage(),memoryDurable(),'unfollow-filter');
 for(let i=0;i<65;i++)await store.append({id:'noise'+i,scope:'unreciprocated',source:'greeting-auto',at:`2026-10-25T15:00:${String(i%60).padStart(2,'0')}.000Z`});
 for(let i=0;i<3;i++)await store.append({id:'u'+i,scope:'unreciprocated',source:'unfollow-auto',at:`2026-10-25T14:00:0${i}.000Z`,unfollowedHandles:['person'+i]});
 const first=await store.query({scope:'unreciprocated',kind:'unfollow',limit:2});
 assert.equal(first.total,3);assert.deepEqual(first.entries.map(e=>e.id),['u2','u1']);assert.ok(first.nextCursor);
 const second=await store.query({scope:'unreciprocated',kind:'unfollow',limit:2,cursor:first.nextCursor});
 assert.equal(second.total,3);assert.deepEqual(second.entries.map(e=>e.id),['u0']);assert.equal(second.nextCursor,null);
});

test('legacy confirmed unfollow detail exposes its recorded handle without inferring failed attempts',async()=>{
 const {unfollowLogHandles}=await import('../src/shared/execution-log-select.js');
 const log={source:'unfollow-auto',result:'success',handle:'old',details:{'提交状态':'已确认取关并回写本地'}};
 assert.deepEqual(unfollowLogHandles(log),['old']);
 assert.deepEqual(unfollowLogHandles({...log,result:'failed'}),[]);
 assert.deepEqual(unfollowLogHandles({...log,details:{'提交状态':'已预留额度，请求结果待确认'}}),[]);
});

test('unfollow query supports an older running worker without filtering only its first page',async()=>{
 const {queryUnfollowLogs}=await import('../src/shared/execution-log-select.js');
 const send=async q=>q.cursor?{ok:true,entries:[{id:'u',at:'2026-10-25',source:'unfollow-auto'}],nextCursor:null,total:2}:{ok:true,entries:[{id:'g',source:'greeting-auto'}],nextCursor:{at:'2026-10-26',id:'g'},total:2};
 const result=await queryUnfollowLogs(send,{kind:'unfollow',scope:'unreciprocated',limit:10,cursor:null});
 assert.equal(result.total,1);assert.equal(result.entries[0].id,'u');assert.equal(result.nextCursor,null);
});

test('timeout categories partition legacy monitoring and handling before pagination',async()=>{
 const store=storeFor(legacyStorage(),memoryDurable(),'timeout-types');
 const sources=['open','account-update','greeting-auto-start','greeting-auto-summary','greeting-auto','unfollow-auto','unfollow-manual','unfollow-batch'];
 for(let i=0;i<sources.length;i++)await store.append({id:'type'+i,scope:'unreciprocated',source:sources[i],result:'skipped',at:new Date(1792900000000+i*1000).toISOString()});
 const monitoring=await store.query({scope:'unreciprocated',kind:'timeout-monitoring',limit:2});
 assert.equal(monitoring.total,2);assert.deepEqual(monitoring.entries.map(e=>e.source),['account-update','open']);
 const first=await store.query({scope:'unreciprocated',kind:'timeout-handling',limit:2});assert.equal(first.total,6);assert.ok(first.nextCursor);
 const second=await store.query({scope:'unreciprocated',kind:'timeout-handling',limit:2,cursor:first.nextCursor});assert.equal(second.total,6);assert.equal(second.entries.length,2);
 assert.equal(new Set([...first.entries,...second.entries].map(e=>e.id)).size,4);
});
test('old workers classify both timeout categories across every page',async()=>{
 const {queryUnfollowLogs}=await import('../src/shared/execution-log-select.js');
 const send=async q=>q.cursor?{ok:true,entries:[{id:'g',at:'2026-10-24',source:'greeting-auto',result:'failed'}],nextCursor:null}:{ok:true,entries:[{id:'m',at:'2026-10-25',source:'open'}],nextCursor:{at:'2026-10-25',id:'m'}};
 for(const [kind,id] of [['timeout-monitoring','m'],['timeout-handling','g']]){
 const r=await queryUnfollowLogs(send,{kind,scope:'unreciprocated',limit:1});assert.equal(r.total,1);assert.equal(r.entries[0].id,id);assert.equal(r.nextCursor,null);
 }
});

test('greeting and unfollow categories are mutually exclusive including failed and skipped logs',async()=>{
 const store=storeFor(legacyStorage(),memoryDurable(),'three-log-types');
 for(const [id,source,result] of [['g','greeting-auto','failed'],['m','greeting-manual','success'],['u','unfollow-auto','skipped'],['b','unfollow-batch','success'],['c','open','success']])await store.append({id,scope:'unreciprocated',source,result,at:'2026-10-26T00:00:00.000Z'});
 for(const [kind,ids] of [['greeting',['g','m']],['unfollow',['b','u']],['timeout-monitoring',['c']]]){const r=await store.query({scope:'unreciprocated',kind});assert.equal(r.total,ids.length);assert.deepEqual(r.entries.map(e=>e.id).sort(),ids);}
});

test('duplicate round summaries collapse across pages but orphan summaries and failures survive',async()=>{
 const store=storeFor(legacyStorage(),memoryDurable(),'dedupe-rounds');
 const entries=[{id:'detail',at:'2026-10-26T00:00:01.000Z',handle:'target',runId:'r',details:{'阶段':'复查实际关注关系'}},{id:'summary',at:'2026-10-26T00:00:02.000Z',runId:'r',details:{'阶段':'本轮结束'}},{id:'orphan',at:'2026-10-26T00:00:03.000Z',runId:'other',details:{'阶段':'本轮结束'}}];
 for(const e of entries)await store.append({scope:'unreciprocated',source:'unfollow-auto',result:'success',...e});
 const r=await store.query({scope:'unreciprocated',kind:'unfollow',limit:1});assert.equal(r.total,2);assert.equal(r.entries[0].id,'orphan');
 const next=await store.query({scope:'unreciprocated',kind:'unfollow',limit:1,cursor:r.nextCursor});assert.equal(next.entries[0].id,'detail');assert.equal(next.nextCursor,null);
});
