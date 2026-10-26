import test from 'node:test';
import assert from 'node:assert/strict';
import {createPanelPages, assertRecordWritesOpen, createSelectionMemory} from '../src/entries/panel/panel-pages.js';

function fakeRequest() {
  const ops = [];
  let migrateStarted = false;
  let polls = 0;
  return {
    ops,
    async request(message) {
      ops.push(message.op + (message.module ? ':' + message.module : ''));
      if (message.op === 'status') {
        polls += 1;
        const ready = migrateStarted && polls > 2;
        return {ok: true, status: ready ? {stage: 'ready', cutover: true, completed: 4, total: 4} : {stage: 'importing', cutover: false, completed: polls, total: 4}};
      }
      if (message.op === 'migrate') {
        migrateStarted = true;
        return {ok: true, status: {stage: 'importing', cutover: false, completed: 1, total: 4}};
      }
      if (message.op === 'summary') return {ok: true, summary: message.module === 'unreciprocated' ? {tabs: {all: 4, pending: 4}, total: 4} : {tabs: {all: 4, followBack: 1}, total: 4}};
      if (message.op === 'config') return {ok: true, value: {enabled: false}};
      if (message.op === 'query') {
        assert.ok(message.limit <= 100);
        return {ok: true, page: {records: [{userKey: 'a', handle: 'a', payload: {handle: 'a', bio: 'old', keep: true}}], nextCursor: message.cursor ? null : 'cursor-2', scanned: 2}};
      }
      if (message.op === 'cancel') return {ok: true};
      if (message.op === 'mergeRoot') return {ok: true, value: {}};
      if (message.op === 'patch') return {ok: true, result: {}};
      if (message.op === 'batch') {
        assert.ok(message.changes.length <= 100);
        assert.equal(message.changes.some(change => change.patch && Object.hasOwn(change.patch, '__sourceKey')), false);
        ops.sourceKeys = ops.sourceKeys || [];
        ops.sourceKeys.push(message.sourceKey);
        return {ok: true, result: {}};
      }
      if (message.op === 'lookup') return {ok: true, record: null};
      if (message.op === 'put') return {ok: true, result: {}};
      throw new Error('unexpected ' + message.op);
    }
  };
}

test('startup queries only the visible module and reports real progress', async () => {
  const fake = fakeRequest();
  const progress = [];
  const pages = createPanelPages({request: fake.request, onProgress: status => progress.push(status.completed), delay: () => Promise.resolve(), debounceMs: 20});
  const booted = await pages.boot('fans', {tab: 'following', pageSize: 20});
  assert.equal(booted.page.records.length, 1);
  assert.ok(progress.includes(1));
  assert.equal(fake.ops.filter(op => op.startsWith('query:')).join(','), 'query:fans');
  assert.equal(fake.ops.some(op => op === 'query:mutual'), false);
  const again = await pages.open('fans', {tab: 'all', pageSize: 20});
  assert.equal(again.records[0].handle, 'a');
  assert.ok(pages.cacheSize() <= 3);
  let staleSearch = 'pending';
  const first = pages.search('fans', {search: 'one'});
  const second = pages.search('fans', {search: 'two'});
  await new Promise(resolve => setTimeout(resolve, 50));
  await first.then(page => { staleSearch = page; });
  const applied = await second;
  assert.equal(staleSearch, null);
  assert.equal(applied.filter.search, 'two');
  const bridged = pages.bridgeWrite('monitor', {every: 30, enabled: true, users: [{handle: 'a', bio: 'next', __userKey: 'secret'}], queue: []}, {baseline: {every: 10, enabled: true}});
  await bridged;
  assert.equal(fake.ops.includes('mergeRoot'), true);
  assert.equal(fake.ops.some(op => op.startsWith('batch')), true);
  const before = fake.ops.filter(op => op === 'mergeRoot').length;
  await pages.bridgeWrite('monitor', {every: 30, enabled: false, users: []});
  assert.equal(fake.ops.filter(op => op === 'mergeRoot').length, before);
  const overdue = await pages.open('unreciprocated', {tab: 'overdue', pageSize: 200});
  assert.equal(overdue.total, 0);
  assert.equal(fake.ops.filter(op => op.startsWith('query:')).at(-1), 'query:unreciprocated');
  const limited = fake.ops.length;
  await pages.open('fans', {tab: 'following', pageSize: 200});
  assert.ok(limited < fake.ops.length);
  let chosen = 'fans';
  const lateFake = fakeRequest();
  const latePages = createPanelPages({request: lateFake.request, delay: () => { chosen = 'mutual'; return Promise.resolve(); }, debounceMs: 20});
  const bootedLate = await latePages.boot(() => ({module: chosen, filter: {tab: 'all', pageSize: 20}}));
  assert.equal(bootedLate.module, 'mutual');
  assert.equal(lateFake.ops.includes('query:mutual'), true);
  assert.equal(lateFake.ops.includes('query:fans'), false);
  pages.markComplete('monitor');
  const batchesBefore = fake.ops.filter(op => op.startsWith('batch')).length;
  await pages.bridgeWrite('monitor', {users: [{handle: 'a', bio: 'kept'}], queue: [{handle: 'a', status: 'pending', __sourceBucket: 'queue'}]}, {baseline: {every: 30}});
  assert.equal(pages.isComplete('monitor'), false);
  assert.ok(fake.ops.filter(op => op.startsWith('batch')).length > batchesBefore);
  assert.throws(() => assertRecordWritesOpen(true), /档案未写入/);
  const sent = [];
  const origin = createPanelPages({request: message => {
    sent.push(message.op + ':' + (message.sourceKey || ''));
    if (message.op === 'batch') return Promise.resolve({ok: true, result: {}});
    if (message.op === 'summary') return Promise.resolve({ok: true, summary: {tabs: {all: 1}, total: 1}});
    if (message.op === 'query') return Promise.resolve({ok: true, page: {records: [{userKey: 'mutualNetwork/users/0', handle: 'ada', sourcePath: ['mutualNetwork', 'users', 0], payload: {handle: 'ada', note: 'keep'}}], nextCursor: null, scanned: 1}});
    return Promise.resolve({ok: true, status: {stage: 'ready', cutover: true, completed: 1, total: 1}, value: {}});
  }, delay: () => Promise.resolve(), debounceMs: 1});
  await origin.boot('fans', {tab: 'notMutual', pageSize: 20});
  await origin.bridgeWrite('monitor', {users: [{handle: 'ada', note: 'edited', __userKey: 'mutualNetwork/users/0', __sourceKey: 'mutualNetwork', __sourceBucket: 'users'}]});
  assert.equal(sent.includes('batch:mutualNetwork'), true);
  assert.equal(sent.includes('batch:monitor'), false);
  const trackerSent = [];
  const tracker = createPanelPages({request: message => {
    trackerSent.push(message);
    if (message.op === 'batch') return Promise.resolve({ok: true, result: {}});
    if (message.op === 'summary') return Promise.resolve({ok: true, summary: {tabs: {all: 1, pending: 1}, total: 1}});
    if (message.op === 'query') return Promise.resolve({ok: true, page: {records: [{userKey: 'derived:tracker/ada', handle: 'ada', sourcePath: ['unreciprocatedTracker', 'synthetic', 'ada'], payload: {handle: 'ada', note: 'from-mutual', status: 'pending'}}], nextCursor: null, scanned: 1}});
    return Promise.resolve({ok: true, status: {stage: 'ready', cutover: true, completed: 1, total: 1}, value: {}});
  }, delay: () => Promise.resolve(), debounceMs: 1});
  await tracker.boot('unreciprocated', {tab: 'pending', pageSize: 20});
  await tracker.bridgeWrite('unreciprocatedTracker', {users: [{handle: 'ada', note: 'from-mutual', status: 'followed', __userKey: 'derived:tracker/ada', __sourceKey: 'unreciprocatedTracker', __sourceBucket: 'synthetic'}]});
  const trackerBatch = trackerSent.find(message => message.op === 'batch');
  assert.equal(trackerBatch.sourceKey, 'unreciprocatedTracker');
  assert.equal(trackerBatch.changes[0].create, true);
  assert.equal(trackerBatch.changes[0].sourceBucket, 'synthetic');
  assert.equal(trackerBatch.changes[0].patch.note, 'from-mutual');
  assert.equal(trackerBatch.changes[0].patch.status, 'followed');
  assert.equal(Object.hasOwn(trackerBatch.changes[0].patch, '__userKey'), false);
  await tracker.bridgeWrite('unreciprocatedTracker', {users: [{handle: 'ada', status: 'unfollowed', unfollowedAt: '2026-10-25T10:00:00Z', __userKey: 'derived:tracker/ada', __sourceBucket: 'synthetic'}]});
  const historyBatch = trackerSent.filter(message => message.op === 'batch').at(-1);
  assert.equal(historyBatch.changes[0].sourceBucket, 'users');
  assert.equal(historyBatch.changes[0].create, true);
  assert.equal(historyBatch.changes[0].patch.unfollowedAt, '2026-10-25T10:00:00Z');
  assert.equal(historyBatch.changes[0].userKey, undefined);
  const memory = createSelectionMemory();
  memory.retain('fans', 'ada', {handle: 'ada', bio: 'page-1'});
  memory.retain('fans', 'bob', {handle: 'bob', bio: 'page-2'});
  memory.forget('fans', 'bob');
  assert.deepEqual(memory.selected('fans', ['ada', 'bob']).map(user => user.handle), ['ada']);
});

test('search rejects a failed query and a later search succeeds', async () => {
  const rejections = [];
  const onUnhandled = reason => rejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let fail = true;
    const pages = createPanelPages({
      request: async message => {
        if (message.op === 'query') {
          if (fail) throw new Error('query failed');
          return {ok: true, page: {records: [{userKey: 'a', handle: 'ada', payload: {handle: 'ada'}}], nextCursor: null, scanned: 1}};
        }
        if (message.op === 'summary') return {ok: true, summary: {tabs: {all: 1}, total: 1}};
        if (message.op === 'cancel') return {ok: true};
        return {ok: true, status: {stage: 'ready', cutover: true, completed: 1, total: 1}, value: {}};
      },
      delay: () => Promise.resolve(),
      debounceMs: 15
    });
    await assert.rejects(pages.search('fans', {search: 'bad'}), /query failed/);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(rejections.length, 0);
    fail = false;
    const page = await pages.search('fans', {search: 'ok'});
    assert.equal(page.filter.search, 'ok');
    assert.equal(page.records[0].handle, 'ada');
    const pending = pages.search('fans', {search: 'gone'});
    await pages.invalidate();
    assert.equal(await pending, null);
    assert.equal(rejections.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a late previous page-size request cannot overwrite the newer preference',async()=>{
 const pending=[];
 const pages=createPanelPages({request:message=>new Promise(resolve=>pending.push({message,resolve}))});
 const old=pages.open('fans',{pageSize:20});const newer=pages.open('fans',{pageSize:10});
 pending[1].resolve({ok:true,page:{records:[{userKey:'new',payload:{handle:'new'}}],nextCursor:null}});
 await newer;
 pending[0].resolve({ok:true,page:{records:[{userKey:'old',payload:{handle:'old'}}],nextCursor:null}});
 assert.equal(await old,null);assert.equal(pages.window('fans').filter.pageSize,10);assert.equal(pages.window('fans').records[0].userKey,'new');
});

test('complete tracker comparison loads every history page as well as active following', async () => {
  const {compareFollowback}=await import('../src/features/relationships/followback-monitor.js');
  const calls=[];
  const pages=createPanelPages({request:async message=>{
    calls.push([message.filter.tab,message.cursor]);
    const active={userKey:'active',payload:{handle:'active',relationship:{following:true,followedBy:false}}};
    const past=n=>({userKey:'past'+n,payload:{handle:'past'+n,status:'unfollowed',unfollowedAt:'2026-10-25T14:40:41Z',relationship:{following:false}}});
    if(message.filter.tab==='all')return {ok:true,page:{records:[active],nextCursor:null}};
    return {ok:true,page:{records:message.cursor?[past(2)]:[past(1)],nextCursor:message.cursor?null:'history-2'}};
  }});
  const loaded=await pages.loadComplete('unreciprocated','unreciprocatedTracker');
  assert.deepEqual(calls,[['all',null],['unfollowed',null],['unfollowed','history-2']]);
  assert.equal(pages.isComplete('unreciprocatedTracker'),true);
  const compared=compareFollowback({followingUsers:[loaded[0].payload],previousUsers:loaded.map(r=>r.payload)});
  assert.deepEqual(compared.filter(u=>u.status==='unfollowed').map(u=>u.handle),['past1','past2']);
});

test('failed history loading must not mark a partial tracker complete',async()=>{
  const pages=createPanelPages({request:async m=>{
    if(m.filter.tab==='unfollowed')throw Error('history unavailable');
    return {ok:true,page:{records:[],nextCursor:null}};
  }});
  await assert.rejects(pages.loadComplete('unreciprocated','unreciprocatedTracker'),/history unavailable/);
  assert.equal(pages.isComplete('unreciprocatedTracker'),false);
});
