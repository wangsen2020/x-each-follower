import test from 'node:test';
import assert from 'node:assert/strict';
import {loadCommentTracking} from '../tracking-storage.js';
import {createStorageTab, closeStorageTab} from '../persistent-db.js';

test('X storage fallback creates an inactive tab in the existing browser window', async () => {
  const calls = [];
  const chromeApi = {
    tabs:{
      query:async () => [],
      create:async options => { calls.push(['tab.create', options]); return {id:42}; }
    },
    windows:{
      getLastFocused:async () => ({id:7, type:'normal'}),
      getAll:async () => { throw new Error('fallback should not be needed'); },
      create:async () => { throw new Error('must not create a browser window'); }
    }
  };

  assert.deepEqual(await createStorageTab(chromeApi), {id:42, owned:true});
  assert.deepEqual(calls, [['tab.create', {windowId:7, url:'https://x.com/home', active:false}]]);
});

test('X storage reuses an existing X tab and does not claim ownership', async () => {
  const chromeApi = {
    tabs:{query:async () => [{id:15, status:'complete', url:'https://x.com/home'}]},
    windows:{create:async () => { throw new Error('must reuse the existing X tab'); }}
  };

  assert.deepEqual(await createStorageTab(chromeApi), {id:15, owned:false});
});

test('only a task-owned temporary X tab is closed after use', async () => {
  const removed = [];
  await closeStorageTab({tabs:{remove:async id => removed.push(id)}}, 42);
  assert.deepEqual(removed, [42]);
});

test('startup can load comment tracking without opening the X IndexedDB page', async () => {
  const stored = {users:[{handle:'alice'}], posts:[]};
  let durableRead = false;
  const result = await loadCommentTracking({
    includeDurable:false,
    storage:{get:async key => key === 'commentTracking' ? {commentTracking:stored} : {}},
    readDurable:async () => { durableRead = true; return {users:[], posts:[]}; }
  });

  assert.equal(result, stored);
  assert.equal(durableRead, false);
});

test('normal comment tracking reads still prefer newer durable data', async () => {
  const stored = {updatedAt:'2026-10-16T10:00:00.000Z', users:[], posts:[]};
  const durable = {updatedAt:'2026-10-17T10:00:00.000Z', users:[{handle:'alice'}], posts:[]};
  const result = await loadCommentTracking({
    storage:{get:async key => key === 'commentTracking' ? {commentTracking:stored} : {}},
    readDurable:async () => durable
  });

  assert.equal(result, durable);
});

test('comment execution uses explicitly saved Grok switches even with newer durable tracking data', async () => {
  const settings = {enabled:true,grokAutoComment:true};
  const result = await loadCommentTracking({
    storage:{get:async key => key === 'commentTracking'
      ? {commentTracking:{updatedAt:'2026-10-16',autoFollow:{enabled:false}}}
      : {commentAutoFollowSettings:settings}},
    readDurable:async()=>({updatedAt:'2026-10-17',users:[{handle:'alice'}],autoFollow:{enabled:false,grokAutoComment:false}})
  });
  assert.equal(result.autoFollow.enabled,true);
  assert.equal(result.autoFollow.grokAutoComment,true);
  assert.equal(result.users[0].handle,'alice');
});

test('comment loading preserves handled users when separate settings contain an old empty list', async () => {
  const result=await loadCommentTracking({includeDurable:false,storage:{get:async key=>key==='commentTracking'
    ? {commentTracking:{autoFollow:{processedHandles:['KimmyKimOL']}}}
    : {commentAutoFollowSettings:{enabled:true,processedHandles:[]}}}});
  assert.deepEqual(result.autoFollow.processedHandles,['kimmykimol']);
});
