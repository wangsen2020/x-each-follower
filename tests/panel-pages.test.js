import test from 'node:test';
import assert from 'node:assert/strict';
import {createPanelPages, assertRecordWritesOpen, createSelectionMemory} from '../panel-pages.js';

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
  const memory = createSelectionMemory();
  memory.retain('fans', 'ada', {handle: 'ada', bio: 'page-1'});
  memory.retain('fans', 'bob', {handle: 'bob', bio: 'page-2'});
  memory.forget('fans', 'bob');
  assert.deepEqual(memory.selected('fans', ['ada', 'bob']).map(user => user.handle), ['ada']);
});
