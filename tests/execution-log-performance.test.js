import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionLogStore} from '../src/shared/execution-log-store.js';

const storage = {get: async () => ({autoFollowLogs: [], monitorLogs: [], unreciprocatedLogs: []})};
function fixture() {
  const saved = new Map();
  const reads = [];
  const options = {
    dbName: crypto.randomUUID(), storage,
    durableGet: async key => { reads.push(key); return structuredClone(saved.get(key)); },
    durableSet: async (key, value) => { saved.set(key, structuredClone(value)); }
  };
  return {options, saved, reads};
}
const entry = (id, detail = id) => ({id, detail, scope: 'comment', at: '2026-10-22T00:00:00.000Z'});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
async function editMeta(dbName, action) {
  const db = await new Promise(resolve => { const r = indexedDB.open(dbName); r.onsuccess = () => resolve(r.result); });
  const tx = db.transaction('meta', 'readwrite');
  action(tx.objectStore('meta'));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  db.close();
}

test('cold reopen and upgrade preserve pages without any remote backup reads', async () => {
  const f = fixture();
  const first = createExecutionLogStore(f.options);
  for (let i = 0; i < 65; i++) await first.append(entry(String(i).padStart(3, '0')));
  // Simulate the previous version: backupHead is present, recoveryProgress is not.
  await editMeta(f.options.dbName, meta => meta.delete('recoveryProgress'));
  for (let restart = 0; restart < 2; restart++) {
    const reopened = createExecutionLogStore({...f.options, durableGet: async () => { throw Error('remote must not be needed'); }});
    const a = await reopened.query({scope: 'comment'});
    const b = await reopened.query({scope: 'comment', cursor: a.nextCursor});
    const c = await reopened.query({scope: 'comment', cursor: b.nextCursor});
    assert.equal(a.total, 65);
    assert.deepEqual([a.entries.length, b.entries.length, c.entries.length], [30, 30, 5]);
    assert.equal(new Set([...a.entries, ...b.entries, ...c.entries].map(e => e.id)).size, 65);
  }
});

test('first page and next page complete while a backup write remains blocked', {timeout: 3000}, async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  let blocked = false;
  const store = createExecutionLogStore({...f.options, durableSet: async (key, value) => {
    if (blocked) { entered.resolve(); await release.promise; }
    await f.options.durableSet(key, value);
  }});
  for (let i = 0; i < 35; i++) await store.append(entry(String(i).padStart(3, '0')));
  blocked = true;
  const write = store.append(entry('new'));
  await entered.promise;
  try {
    const first = await store.query({scope: 'comment'});
    const next = await store.query({scope: 'comment', cursor: first.nextCursor});
    assert.equal(first.total, 36);
    assert.equal(first.entries[0].id, 'new');
    assert.equal(next.entries.length, 6);
    assert.equal(store.backupStatus().pending, 1);
  } finally { release.resolve(); await write; }
  assert.equal(store.backupStatus().pending, 0);
});

test('restarting with an unbacked update never overwrites it with an old backup', async () => {
  const f = fixture();
  const first = createExecutionLogStore(f.options);
  await first.append(entry('same', 'old'));
  const failing = createExecutionLogStore({...f.options, durableSet: async () => { throw Error('offline'); }});
  assert.equal((await failing.append(entry('same', 'new'))).backup.ok,false);
  const restart = createExecutionLogStore(f.options);
  assert.equal((await restart.query({scope: 'comment'})).entries[0].detail, 'new');
  await restart.ready();
  assert.equal(f.saved.get('executionLogBackupPage:2').record.detail, 'new');
});

test('interrupted disaster recovery resumes after its atomic checkpoint', async () => {
  const f = fixture();
  const source = createExecutionLogStore(f.options);
  await source.append(entry('one'));
  await source.append(entry('two'));
  const dbName = crypto.randomUUID();
  const broken = createExecutionLogStore({...f.options, dbName, durableGet: async key => {
    if (key === 'executionLogBackupPage:2') throw Error('temporary failure');
    return f.options.durableGet(key);
  }});
  await assert.rejects(broken.query({scope: 'comment'}), /temporary failure/);
  f.reads.length = 0;
  const restored = createExecutionLogStore({...f.options, dbName});
  assert.equal((await restored.query({scope: 'comment'})).total, 2);
  assert.equal(f.reads.includes('executionLogBackupPage:1'), false);
  assert.equal(f.reads.includes('executionLogBackupPage:2'), true);
});

test('unavailable backup head cannot permanently mark an empty rebuild complete', async () => {
  const f = fixture();
  const failed = createExecutionLogStore({...f.options, durableGet: async () => { throw Error('offline'); }});
  await assert.rejects(failed.query({scope: 'comment'}), /offline/);
  f.saved.set('executionLogBackupHead', {n: 1});
  f.saved.set('executionLogBackupPage:1', {op: 'put', record: {...entry('saved'), membership: ['comment']}});
  assert.equal((await createExecutionLogStore(f.options).query({scope: 'comment'})).entries[0].id, 'saved');
});
