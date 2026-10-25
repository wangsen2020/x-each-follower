import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundRecords, isWholeModuleRead, mergeCollectedReplies, selectCommentCandidates} from '../src/features/records/background-record-data.js';
import {mergeCommentTracking} from '../src/features/relationships/network-api.js';
import {loadCommentTracking} from '../src/platform/tracking-storage.js';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';

function readyService(handler) {
  return {async handle(message) {
    if (message.op === 'status') return {ok:true, status:{cutover:true, stage:'ready'}};
    return handler(message);
  }};
}

test('adapter rejects a service that is not cut over and never issues a module read', async () => {
  const ops = [];
  const records = createBackgroundRecords({service:{async handle(message) {
    ops.push(message.op);
    return {ok:true, status:{cutover:false}};
  }}, extensionUrl:'chrome-extension://ext/'});
  await assert.rejects(records.metadata('monitor'), /记录迁移尚未完成/);
  assert.deepEqual(ops, ['status']);
  assert.equal(isWholeModuleRead(null), true);
  assert.equal(isWholeModuleRead(['commentAutoFollowSettings']), false);
});

test('adapter pages and batches in groups of at most 100', async () => {
  const calls = [];
  const records = createBackgroundRecords({service:readyService(async message => {
    calls.push(message);
    if (message.op === 'sourcePage') return {ok:true, page:{records:[{handle:'a'}], nextCursor:null}};
    if (message.op === 'profiles') return {ok:true, profiles:message.handles.map(handle => ({handle, payload:{handle}}))};
    if (message.op === 'batch') return {ok:true, result:{updated:message.changes.length}};
    return {ok:false, error:'unexpected'};
  })});
  await records.sourcePage({sourceKey:'monitor', limit:100, cursor:null});
  await assert.rejects(records.sourcePage({sourceKey:'monitor', limit:101}), /1 to 100/);
  const handles = Array.from({length:120}, (_, index) => `u${index}`);
  const profiles = await records.profiles(handles);
  assert.equal(profiles.length, 120);
  assert.deepEqual(calls.filter(call => call.op === 'profiles').map(call => call.handles.length), [100, 20]);
  const changes = handles.map(handle => ({handle, sourceBucket:'users', patch:{handle}}));
  await records.batch({sourceKey:'monitor', changes});
  assert.deepEqual(calls.filter(call => call.op === 'batch').map(call => call.changes.length), [100, 20]);
});

function queueApi(gets) {
  return {
    storage:{local:{
      async get(keys) {
        gets.push(keys);
        if (keys == null || isWholeModuleRead(keys)) throw new Error(`whole module read ${JSON.stringify(keys)}`);
        return {followQueueBinding:{accountId:'123', handle:'viewer', activated:true, sources:{mutual:true, fans:true, comments:true}}};
      },
      async set() { throw new Error('legacy module write'); }
    }},
    tabs:{query:async () => [{id:1}]},
    scripting:{executeScript:async () => [{result:'viewer'}]}
  };
}

test('queue sync uses bounded source pages and per-page profiles without a snapshot read', async () => {
  const gets = [];
  const pages = {
    monitor:[
      {records:[{module:'fans', sourcePath:['monitor','users','ada'], payload:{handle:'Ada', name:'Ada', bio:'one'}}]},
      {records:[{module:'fans', sourcePath:['monitor','users','bea'], payload:{handle:'Bea', name:'Bea'}}]}
    ],
    mutualNetwork:[{records:[]}],
    commentTracking:[
      {records:[{module:'posts', sourcePath:['commentTracking','posts','t1'], payload:{tweetId:'t1', url:'https://x.com/a/status/1'}}]},
      {records:[{module:'comments', sourcePath:['commentTracking','users','cy'], payload:{handle:'Cy', sources:[{tweetId:'t1', url:'https://x.com/a/status/1'}]}}]}
    ]
  };
  const seen = [];
  const profileCalls = [];
  const records = {
    metadata:async () => ({}),
    profiles:async handles => { profileCalls.push([...handles]); return handles.map(handle => ({handle, payload:{handle, bio:`bio-${handle}`}})); },
    sourcePage:async ({sourceKey, limit, cursor}) => {
      assert.ok(limit <= 100);
      const index = cursor ? Number(cursor) : 0;
      seen.push([sourceKey, index, limit]);
      const list = pages[sourceKey] || [];
      const page = list[index] || {records:[]};
      return {records:page.records || [], nextCursor:index + 1 < list.length ? String(index + 1) : null};
    },
    batch:async () => { throw new Error('sync must not write source rows'); },
    lookup:async () => null,
    mergeRoot:async () => { throw new Error('sync must not merge roots'); }
  };
  const enqueued = [];
  const store = {lookup:async () => null, enqueue:async item => { enqueued.push(item); return item; }, importOutcome:async () => { throw new Error('no import'); }};
  await createFollowQueueRuntime({api:queueApi(gets), store, records}).syncCandidates();
  assert.equal(gets.some(keys => keys == null || isWholeModuleRead(keys)), false);
  assert.deepEqual(profileCalls, [['ada'], ['bea'], ['cy']]);
  assert.equal(enqueued.some(item => item.handle === 'Ada' && item.profile.bio === 'bio-ada'), true);
  assert.equal(enqueued.some(item => item.handle === 'Cy' && item.sources.some(source => source.url === 'https://x.com/a/status/1')), true);
  assert.equal(seen.every(([, , limit]) => limit === 100), true);
  assert.equal(seen.filter(([source]) => source === 'commentTracking').length, 2);
});

test('a missing profile row keeps the profile already stored on the page user', async () => {
  const gets = [];
  const records = {
    metadata:async () => ({}),
    profiles:async () => [],
    lookupAll:async () => [],
    sourcePage:async ({sourceKey}) => sourceKey === 'mutualNetwork'
      ? {records:[{module:'mutual', sourcePath:['mutualNetwork','users','ada'], payload:{handle:'Ada', name:'Ada', bio:'from-page'}}], nextCursor:null}
      : {records:[], nextCursor:null}
  };
  const enqueued = [];
  await createFollowQueueRuntime({
    api:queueApi(gets),
    records,
    store:{lookup:async () => ({handle:'Ada', state:'pending', sources:[{module:'mutual', url:''}], profile:{bio:'from-job'}}), enqueue:async item => enqueued.push(item), importOutcome:async () => {}}
  }).syncCandidates();
  const ada = enqueued.find(item => item.handle === 'Ada');
  assert.equal(ada.profile.bio, 'from-page');
});

test('reflectFollowed patches each monitor bucket for the completed handle only', async () => {
  const batches = [];
  const records = {
    sourcePage:async () => { throw new Error('reflect must not scan a source'); },
    lookupAll:async ({sourceKey, bucket, handle}) => {
      if (sourceKey !== 'monitor' || handle !== 'ada') return [];
      if (bucket === 'followingUsers') return [{payload:{handle:'Ada', relationship:{following:true}}}];
      if (bucket === 'users' || bucket === 'queue') return [{payload:{handle:'Ada', relationship:{following:false}, bio:'keep-ada'}}];
      return [];
    },
    batch:async request => { batches.push(request); return {updated:request.changes.length}; }
  };
  const api = {storage:{local:{get:async () => { throw new Error('reflect must not read storage'); }, set:async () => { throw new Error('reflect must not write storage'); }}}};
  const store = {listByState:async () => { throw new Error('reflect must not list every followed job'); }};
  await createFollowQueueRuntime({api, store, records}).reflectFollowed('123', [{handle:'Ada', followResult:{at:1}}]);
  const monitor = batches.find(batch => batch.sourceKey === 'monitor');
  assert.deepEqual(monitor.changes.map(change => change.sourceBucket).sort(), ['queue', 'users']);
  assert.equal(JSON.stringify(monitor).includes('keep-bea'), false);
  assert.equal(JSON.stringify(batches).includes('followingUsers'), false);
});

test('backfill loads profiles only for the requested job page', async () => {
  const asked = [];
  const records = {
    profiles:async handles => { asked.push([...handles]); return [{handle:'ada', payload:{handle:'ada', bio:'cached'}}]; },
    lookupAll:async ({sourceKey, bucket, handle}) => sourceKey === 'monitor' && bucket === 'users' && handle === 'bea' ? [{sourcePath:['monitor','users','bea'], payload:{handle:'bea', bio:'from-fans'}}] : []
  };
  const api = {storage:{local:{get:async key => key === 'followQueueBinding' || (Array.isArray(key) && key[0] === 'followQueueBinding') ? {followQueueBinding:{accountId:'123', activated:true}} : (() => { throw new Error('no module read'); })()}}};
  let received;
  const store = {
    queryPage:async () => ({jobs:[{handle:'Ada'}, {handle:'Bea'}]}),
    backfillProfiles:async request => { received = request.profiles; return {updated:1}; }
  };
  await createFollowQueueRuntime({api, store, records}).backfillProfiles({limit:50});
  assert.deepEqual(asked, [['ada', 'bea']]);
  assert.equal(received.find(profile => profile.handle === 'ada').bio, 'cached');
  assert.equal(received.find(profile => profile.handle === 'bea').bio, 'from-fans');
});

test('reply collection merges one handle and keeps nested replies', async () => {
  const batches = [];
  let patched = null;
  const records = {
    lookupAll:async ({sourceKey, bucket, handle, tweetId}) => {
      assert.equal(sourceKey, 'commentTracking');
      if (bucket === 'users' && handle === 'ada') return [{bucket:'users', sourcePath:['commentTracking','users','ada'], payload:{handle:'ada', sources:[{tweetId:'t1', url:'https://x.com/a/status/1', replies:[{replyId:'old'}]}]}}];
      if (bucket === 'posts' && tweetId === 't9') return [{userKey:'post-t9', bucket:'posts', payload:{tweetId:'t9', url:'https://x.com/a/status/9', authorHandle:'ann'}}];
      return [];
    },
    batch:async request => { batches.push(request); return {updated:request.changes.length}; },
    patch:async request => { patched = request; return request; }
  };
  await mergeCollectedReplies(records, {
    post:{tweetId:'t9', url:'https://x.com/a/status/9', authorHandle:'ann'},
    replies:[{handle:'ada', sources:[{replies:[{replyId:'new'}]}]}],
    mergeCommentTracking
  });
  const users = batches.find(batch => batch.changes[0].sourceBucket === 'users');
  assert.deepEqual(users.changes.map(change => change.handle), ['ada']);
  const sources = users.changes[0].patch.sources;
  assert.deepEqual(sources.find(source => source.tweetId === 't1').replies.map(reply => reply.replyId), ['old']);
  assert.deepEqual(sources.find(source => source.tweetId === 't9').replies.map(reply => reply.replyId), ['new']);
  assert.equal(patched.userKey, 'post-t9');
  assert.equal(JSON.stringify(batches).includes('bea'), false);
});

test('comment settings load does not read the commentTracking blob', async () => {
  const keys = [];
  const tracking = await loadCommentTracking({
    records:{
      metadata:async () => ({updatedAt:'2026-10-01', autoFollow:{followedCount:4, lastSummary:'kept progress'}}),
      sourcePage:async () => { throw new Error('settings load must not page users'); }
    },
    storage:{get:async key => { keys.push(key); return {commentAutoFollowSettings:{enabled:true, followedCount:1, processedHandles:[]}}; }}
  });
  assert.deepEqual(keys, ['commentAutoFollowSettings']);
  assert.deepEqual(tracking.users, []);
  assert.equal(tracking.autoFollow.enabled, true);
  assert.equal(tracking.autoFollow.followedCount, 4);
  assert.equal(tracking.autoFollow.lastSummary, 'kept progress');
});

test('comment candidates stop at the batch limit without accumulating later pages', async () => {
  const pages = [];
  const relations = [];
  const attemptKeys = [];
  const records = {
    sourcePage:async ({cursor, limit}) => {
      assert.equal(limit, 100);
      pages.push(cursor || null);
      const recordsOnPage = Array.from({length: 25}, (_, index) => ({bucket:'users', sourcePath:['commentTracking','users',`u${index}`], payload:{handle:`u${index}`}}));
      return {records:recordsOnPage, nextCursor:'more'};
    },
    relations:async handles => { relations.push([...handles]); return []; }
  };
  const storage = {get:async keys => { attemptKeys.push(keys); return {}; }};
  const chosen = await selectCommentCandidates(records, {batchLimit:50, minFollowers:0}, storage);
  assert.equal(chosen.length, 20);
  assert.deepEqual(pages, [null]);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].length, 25);
  assert.equal(attemptKeys.length, 1);
  assert.equal(attemptKeys[0].includes('commentTracking'), false);
});

test('a missing records service keeps the legacy snapshot path', async () => {
  const gets = [];
  const api = {
    storage:{local:{get:async keys => { gets.push(keys); return {followQueueBinding:{accountId:'123', handle:'viewer', activated:true, sources:{mutual:true}}, mutualNetwork:{users:[]}}; }}},
    tabs:{query:async () => [{id:1}]},
    scripting:{executeScript:async () => [{result:'viewer'}]}
  };
  await createFollowQueueRuntime({api, store:{lookup:async () => null, enqueue:async () => {}, importOutcome:async () => {}}}).syncCandidates();
  assert.equal(gets.includes(null), true);
});


test('adapter preserves a zero update count when unchanged records are skipped', async () => {
  const records=createBackgroundRecords({service:readyService(async () => ({ok:true,result:{updated:0,skipped:1}}))});
  assert.deepEqual(await records.batch({sourceKey:'monitor',changes:[{handle:'ada',patch:{bio:'same'}}]}),{updated:0});
});
