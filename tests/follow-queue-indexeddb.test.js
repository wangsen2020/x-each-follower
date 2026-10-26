import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {createFollowQueueScheduler} from '../src/features/follow-queue/follow-queue-scheduler.js';
import {collectFollowQueueCandidates} from '../src/features/follow-queue/follow-queue-sources.js';

function storeFor(name, clock = {t: 5_000}) {
  return createFollowQueueStore({
    indexedDB: globalThis.indexedDB,
    dbName: name,
    now: () => clock.t
  });
}

test('manual deletion removes rows, updates paging and suppresses stale sources after restart without blocking another account or reused handle', async () => {
  const name = `delete-queue-${crypto.randomUUID()}`;
  const store = storeFor(name);
  const candidate = {accountId:'owner', targetUserId:'123', handle:'GoneUser', sources:[{module:'fans', enabled:true}], profile:{bio:'old profile'}};
  const job = await store.enqueue(candidate);
  await store.enqueue({accountId:'owner', handle:'KeepUser', sources:[{module:'fans', enabled:true}]});
  assert.equal((await store.deleteJob({accountId:'other', id:job.id})).ok, false);
  assert.equal((await store.deleteJob({accountId:'owner', id:job.id})).deleted, 1);
  const restarted = storeFor(name);
  assert.equal((await restarted.enqueue(candidate)).deleted, true);
  assert.equal((await restarted.enqueue({...candidate, targetUserId:'', handle:'goneuser'})).deleted, true);
  assert.equal((await restarted.enqueue({...candidate, handle:'NewName'})).deleted, true);
  assert.equal((await restarted.list({accountId:'owner'})).length, 1);
  assert.ok((await restarted.enqueue({...candidate, accountId:'other'})).id);
  assert.ok((await restarted.enqueue({...candidate, targetUserId:'456'})).id);
  const page = await restarted.queryPage({accountId:'owner', limit:20});
  assert.equal(page.jobs.length, 2);
  assert.equal(page.jobs.some(row => row.id === job.id), false);
});

test('delete refuses executing jobs and leaves their lease intact', async () => {
  const store = storeFor(`delete-running-${crypto.randomUUID()}`);
  await store.enqueue({accountId:'owner', handle:'BusyUser', sources:[{module:'fans', enabled:true}]});
  const job = await store.claim({accountId:'owner', owner:'worker', leaseMs:60000});
  assert.ok(job);
  const result = await store.deleteJob({accountId:'owner', id:job.id});
  assert.equal(result.ok, false);
  assert.match(result.reason, /正在执行/);
  assert.equal((await store.list({accountId:'owner'}))[0].lease.owner, 'worker');
});

test('scheduler dispatches a fan arriving mid-run before remaining older ordinary candidates', async () => {
  const clock = {t: 1000};
  const store = storeFor(`priority-mid-run-${Date.now()}`, clock);
  const accountId = 'priority-mid-run';
  const add = async (handle, module) => {
    const bucket = module === 'fans' ? 'monitor' : module === 'comments' ? 'commentTracking' : 'mutualNetwork';
    const [candidate] = collectFollowQueueCandidates({accountId, sourceEnabled:{fans:true, comments:true, mutual:true},
      [bucket]:{users:[{handle, relationship:{following:false, followedBy:module === 'fans'}}]}});
    return store.enqueue(candidate);
  };
  await add('comment_first', 'comments');
  clock.t++;
  await add('mutual_second', 'mutual');
  const dispatched = [];
  const scheduler = createFollowQueueScheduler({store, now:()=>clock.t, execute:async job => {
    dispatched.push(job.handle);
    if (job.handle === 'comment_first') {
      clock.t++;
      await add('new_fan', 'fans');
    }
    return {state:'skipped', reason:'dispatch order test'};
  }});
  const result = await scheduler.run({accountId, manual:true});
  assert.equal(result.ok, true);
  assert.deepEqual(dispatched, ['comment_first', 'new_fan', 'mutual_second']);
});

test('follow-back priority promotes existing candidates and due retries ahead of older ordinary jobs', async () => {
  const clock = {t: 1000};
  const store = storeFor(`priority-${Date.now()}`, clock);
  const enqueue = (handle, module) => store.enqueue({accountId:'priority', handle, sources:[{module, enabled:true}]});
  await enqueue('ordinary', 'comments');
  clock.t++;
  const fan = await enqueue('newfan', 'mutual');
  await enqueue('newfan', 'fans');
  const first = await store.claim({accountId:'priority', owner:'test', leaseMs:1000});
  assert.equal(first.id, fan.id);
  assert.equal(first.priority, 100);
  assert.equal(await store.claim({accountId:'priority', owner:'other', leaseMs:1000}), null);
  await store.settle({id:first.id, owner:'test', version:first.lease.version, state:'retry', patch:{nextEligibleAt:clock.t + 100}});
  const ordinary = await store.claim({accountId:'priority', owner:'test', leaseMs:1000});
  assert.equal(ordinary.handle, 'ordinary');
  await store.settle({id:ordinary.id, owner:'test', version:ordinary.lease.version, state:'skipped'});
  await enqueue('another', 'mutual');
  clock.t += 100;
  const retry = await store.claim({accountId:'priority', owner:'test', leaseMs:1000});
  assert.equal(retry.id, fan.id);
  await store.settle({id:retry.id, owner:'test', version:retry.lease.version, state:'followed'});
  const last = await store.claim({accountId:'priority', owner:'test', leaseMs:1000});
  assert.equal(last.handle, 'another');
});

test('disabled fan source cannot boost an ordinary candidate; equal weights remain FIFO', async () => {
  const clock = {t: 5000};
  const store = storeFor(`priority-disabled-${Date.now()}`, clock);
  await store.enqueue({accountId:'priority', handle:'first', sources:[{module:'comments',enabled:true}]});
  clock.t++;
  await store.enqueue({accountId:'priority', handle:'second', sources:[{module:'mutual',enabled:true},{module:'fans',enabled:false}]});
  const job = await store.claim({accountId:'priority',owner:'test',leaseMs:1000});
  assert.equal(job.handle, 'first');
  assert.equal(job.priority, 10);
});

test('claim uses follower-count priority bands while keeping confirmed fans first', async () => {
  const clock = {t: 7000};
  const store = storeFor(`priority-followers-${crypto.randomUUID()}`, clock);
  const add = async (handle, followersText, module = 'mutual') => {
    const row = await store.enqueue({accountId:'weighted',handle,profile:{followersText},sources:[{module,enabled:true}]});
    clock.t++;
    return row;
  };
  await add('huge', '80K');
  await add('small', '300');
  await add('best_band', '2,500');
  await add('unknown', '');
  await add('confirmed_fan', '900K', 'fans');
  const expected = [
    ['confirmed_fan',100],
    ['best_band',60],
    ['small',20],
    ['unknown',10],
    ['huge',3]
  ];
  for (const [handle,priority] of expected) {
    const job = await store.claim({accountId:'weighted',owner:'worker',leaseMs:1000});
    assert.equal(job.handle,handle);
    assert.equal(job.priority,priority);
    await store.settle({id:job.id,owner:'worker',version:job.lease.version,state:'skipped'});
  }
});

test('version 7 upgrade recalculates stored priorities from existing profiles', async () => {
  const name = `priority-upgrade-${crypto.randomUUID()}`;
  const request = globalThis.indexedDB.open(name, 4);
  const db = await new Promise((resolve,reject) => {
    request.onupgradeneeded = () => {
      const jobs = request.result.createObjectStore('jobs',{keyPath:'id'});
      jobs.createIndex('accountId','accountId',{unique:false});
      request.result.createObjectStore('outcomes',{keyPath:'key'});
      request.result.createObjectStore('settings',{keyPath:'accountId'});
      request.result.createObjectStore('meta',{keyPath:'key'});
      jobs.put({id:'legacy',accountId:'owner',targetKey:'handle:legacy',targetUserId:'',handle:'legacy',handleCanonical:'legacy',aliases:[],sources:[{module:'mutual',enabled:true}],state:'pending',stage:'queued',createdAt:1,updatedAt:1,nextEligibleAt:1,lease:{owner:'',version:0,expiresAt:0},followResult:null,evaluations:[],profile:{followersText:'4,500'},priority:10,priorityDescending:-10});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  db.close();
  const store = storeFor(name,{t:10});
  const [job] = await store.list({accountId:'owner'});
  assert.equal(job.priority,45);
  assert.equal(job.priorityDescending,-45);
});

async function seedVersion1(name) {
  const request = globalThis.indexedDB.open(name, 1);
  const db = await new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      const database = request.result;
      const jobs = database.createObjectStore('jobs', {keyPath: 'id'});
      jobs.createIndex('accountId', 'accountId', {unique: false});
      jobs.createIndex('accountTarget', ['accountId', 'targetKey'], {unique: true});
      database.createObjectStore('outcomes', {keyPath: 'key'});
      database.createObjectStore('settings', {keyPath: 'accountId'});
      const tx = request.transaction;
      tx.objectStore('jobs').put({
        id: 'keep-me',
        accountId: 'acc-1',
        targetUserId: '42',
        targetKey: 'id:42',
        handle: 'Ada',
        handleCanonical: 'ada',
        aliases: [{canonical: 'ada', handle: 'Ada', seenAt: 1}],
        sources: [{module: 'fans', url: 'https://x.com/a', enabled: true, discoveredAt: 1}],
        state: 'pending',
        stage: 'queued',
        createdAt: 10,
        updatedAt: 10,
        nextEligibleAt: 10,
        lease: {owner: '', version: 0, expiresAt: 0},
        followResult: null,
        evaluations: [],
        customNote: 'preserve-me'
      });
      tx.objectStore('outcomes').put({
        key: 'acc-1\0id:77',
        accountId: 'acc-1',
        targetKey: 'id:77',
        targetUserId: '77',
        handleCanonical: 'bee',
        state: 'followed',
        followResult: {following: true},
        evaluations: [],
        updatedAt: 4
      });
      tx.objectStore('settings').put({accountId: 'acc-1', enabled: true, every: 9, jitter: 1});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
}

test('version 1 upgrade keeps jobs, outcomes, and settings', async () => {
  const name = `upgrade-${Date.now()}`;
  await seedVersion1(name);
  const store = storeFor(name);
  const jobs = await store.list({accountId: 'acc-1'});
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'keep-me');
  assert.equal(jobs[0].customNote, 'preserve-me');
  assert.equal(jobs[0].targetUserId, '42');
  assert.equal(jobs[0].priority, 100);
  assert.equal(jobs[0].priorityDescending, -100);
  const sorted = await store.queryPage({accountId: 'acc-1', order: 'desc', limit: 20});
  assert.deepEqual(sorted.jobs.map(job => job.id), ['keep-me']);
  const settings = await store.getSettings('acc-1');
  assert.equal(settings.enabled, true);
  assert.equal(settings.every, 9);
  const again = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '77',
    handle: 'bee',
    sources: [{module: 'fans', url: 'https://x.com/b', enabled: false}]
  });
  assert.equal(again.state, 'followed');
  assert.equal(again.followResult.following, true);
});

test('queryPage is account scoped, keyset stable, and rejects a stale cursor', async () => {
  const name = `page-${Date.now()}`;
  const clock = {t: 100};
  const store = storeFor(name, clock);
  for (let i = 0; i < 5; i += 1) {
    clock.t = 100 + i;
    await store.enqueue({
      accountId: 'acc-1',
      targetUserId: String(1000 + i),
      handle: `user${i}`,
      profile: {name: i === 2 ? '查找昵称' : `Name${i}`, bio: i === 2 ? '简介甲' : 'other'},
      sources: [{module: i % 2 ? 'mutual' : 'fans', url: `https://x.com/${i}`, enabled: true}]
    });
  }
  await store.enqueue({
    accountId: 'acc-2',
    targetUserId: '9',
    handle: 'other',
    profile: {name: '查找昵称', bio: '简介甲'},
    sources: [{module: 'fans', url: 'https://x.com/o', enabled: true}]
  });
  const first = await store.queryPage({accountId: 'acc-1', limit: 2});
  assert.equal(first.jobs.length, 2);
  assert.equal(first.total, 5);
  assert.equal(first.stats.pending, 5);
  assert.ok(first.nextCursor);
  const second = await store.queryPage({accountId: 'acc-1', limit: 2, cursor: first.nextCursor});
  assert.equal(second.jobs.length, 2);
  assert.equal(second.jobs.some(job => first.jobs.some(prev => prev.id === job.id)), false);
  assert.equal(second.jobs.some(job => job.accountId !== 'acc-1'), false);
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '1009',
    handle: 'late',
    sources: [{module: 'fans', url: 'late', enabled: true}]
  });
  await assert.rejects(
    () => store.queryPage({accountId: 'acc-1', limit: 2, cursor: first.nextCursor}),
    /cursor/
  );
  await assert.rejects(
    () => store.queryPage({accountId: 'acc-1', limit: 2, cursor: JSON.stringify({...JSON.parse(first.nextCursor), accountId: 'acc-2'})}),
    /cursor/
  );
  const named = await store.queryPage({accountId: 'acc-1', q: '查找昵称', limit: 20});
  assert.equal(named.jobs.length, 1);
  assert.equal(named.jobs[0].handle, 'user2');
  assert.equal(named.jobs[0].profile.name, '查找昵称');
  const sourced = await store.queryPage({accountId: 'acc-1', source: 'mutual', limit: 20});
  assert.ok(sourced.jobs.every(job => job.sources.some(source => source.module === 'mutual')));
  await assert.rejects(() => store.queryPage({accountId: 'acc-1', limit: 101}), /limit/);
});

test('indexed claim does not use getAll and keeps due order', async () => {
  const name = `claim-${Date.now()}`;
  const calls = [];
  const original = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function getAllSpy(...args) {
    calls.push(args);
    return original.apply(this, args);
  };
  const indexGetAll = IDBIndex.prototype.getAll;
  IDBIndex.prototype.getAll = function indexGetAllSpy(...args) {
    calls.push(['index', ...args]);
    return indexGetAll.apply(this, args);
  };
  try {
    const clock = {t: 50};
    const store = storeFor(name, clock);
    clock.t = 10;
    await store.enqueue({accountId: 'acc-1', targetUserId: '1', handle: 'late', sources: [{module: 'fans', url: 'a', enabled: true}]});
    clock.t = 20;
    const earlier = await store.enqueue({accountId: 'acc-1', targetUserId: '2', handle: 'soon', sources: [{module: 'fans', url: 'b', enabled: false}]});
    await store.resolveJob({accountId: 'acc-1', id: earlier.id, state: 'retry', nextEligibleAt: 20});
    clock.t = 30;
    await store.enqueue({accountId: 'acc-1', targetUserId: '3', handle: 'ready', sources: [{module: 'comments', url: 'c', enabled: true}]});
    clock.t = 40;
    const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 30});
    assert.equal(claimed.handle, 'late');
    assert.equal(claimed.state, 'running');
    assert.equal(calls.length, 0);
    const blocked = await store.claim({accountId: 'acc-2', owner: 'other', leaseMs: 30});
    assert.equal(blocked, null);
  } finally {
    IDBObjectStore.prototype.getAll = original;
    IDBIndex.prototype.getAll = indexGetAll;
  }
});

test('source pages keep one total and search pages do not shrink a counted total', async () => {
  const name = `totals-${Date.now()}`;
  const clock = {t: 1};
  const store = storeFor(name, clock);
  for (let i = 0; i < 4; i += 1) {
    clock.t = i + 1;
    await store.enqueue({
      accountId: 'acc-1',
      targetUserId: String(i + 1),
      handle: `fan${i}`,
      profile: {name: `Fan ${i}`, bio: i < 4 ? '共享简介' : 'other'},
      sources: [{module: 'fans', url: `https://x.com/f/${i}`, enabled: true}]
    });
  }
  for (let i = 0; i < 4; i += 1) {
    clock.t = i + 10;
    await store.enqueue({
      accountId: 'acc-1',
      targetUserId: String(i + 20),
      handle: `mutual${i}`,
      profile: {name: `Mutual ${i}`, bio: '其他'},
      sources: [{module: 'mutual', url: `https://x.com/m/${i}`, enabled: true}]
    });
  }
  const sourcePage = await store.queryPage({accountId: 'acc-1', source: 'mutual', limit: 2});
  const sourceNext = await store.queryPage({accountId: 'acc-1', source: 'mutual', limit: 2, cursor: sourcePage.nextCursor});
  assert.equal(sourcePage.totalKnown, true);
  assert.equal(sourcePage.total, 4);
  assert.equal(sourceNext.total, 4);
  assert.equal(sourceNext.jobs.length, 2);
  assert.equal(sourceNext.jobs.some(job => sourcePage.jobs.some(prev => prev.id === job.id)), false);
  const searchPage = await store.queryPage({accountId: 'acc-1', q: '共享简介', limit: 2});
  const searchNext = await store.queryPage({accountId: 'acc-1', q: '共享简介', limit: 2, cursor: searchPage.nextCursor});
  assert.equal(searchPage.totalKnown, false);
  assert.equal(searchPage.total, null);
  assert.equal(searchPage.hasMore, true);
  assert.equal(searchNext.total, null);
  assert.equal(searchNext.totalKnown, false);
  assert.equal(searchNext.jobs.length, 2);
  await assert.rejects(() => store.queryPage({accountId: 'acc-1', page: 3, limit: 2}), /cursor/);
});

test('claim stops at the first eligible created job', async () => {
  const name = `claim-bound-${Date.now()}`;
  const clock = {t: 1};
  const store = storeFor(name, clock);
  const future = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '1',
    handle: 'future',
    sources: [{module: 'fans', url: 'future', enabled: true}]
  });
  await store.resolveJob({accountId: 'acc-1', id: future.id, state: 'pending', nextEligibleAt: 10_000});
  clock.t = 2;
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '2',
    handle: 'chosen',
    sources: [{module: 'fans', url: 'chosen', enabled: true}]
  });
  for (let i = 0; i < 10; i += 1) {
    clock.t = 3 + i;
    await store.enqueue({
      accountId: 'acc-1',
      targetUserId: String(30 + i),
      handle: `later${i}`,
      sources: [{module: 'fans', url: `later${i}`, enabled: true}]
    });
  }
  clock.t = 50;
  let continues = 0;
  const original = IDBCursor.prototype.continue;
  IDBCursor.prototype.continue = function boundedContinue(...args) {
    continues += 1;
    return original.apply(this, args);
  };
  try {
    const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 20});
    assert.equal(claimed.handle, 'chosen');
    assert.equal(continues, 1);
  } finally {
    IDBCursor.prototype.continue = original;
  }
});

test('profile backfill resumes and keeps fields the snapshot does not replace', async () => {
  const name = `profiles-${Date.now()}`;
  const clock = {t: 1};
  const store = storeFor(name, clock);
  const first = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '1',
    handle: 'ada',
    profile: {name: 'Old', bio: '保留简介', followersText: '10'},
    sources: [{module: 'fans', url: 'ada', enabled: true}]
  });
  clock.t = 2;
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '2',
    handle: 'bee',
    sources: [{module: 'fans', url: 'bee', enabled: true}]
  });
  const opened = await store.backfillProfiles({
    accountId: 'acc-1',
    profiles: [{handle: 'ada', name: 'Ada'}, {handle: 'bee', name: 'Bee', bio: '新简介'}],
    limit: 1
  });
  assert.equal(opened.scanned, 1);
  assert.equal(opened.done, false);
  const kept = await store.get(first.id);
  assert.equal(kept.profile.name, 'Ada');
  assert.equal(kept.profile.bio, '保留简介');
  assert.equal(kept.profile.followersText, '10');
  const finished = await store.backfillProfiles({
    accountId: 'acc-1',
    profiles: [{handle: 'bee', name: 'Bee', bio: '新简介'}],
    cursor: opened.nextCursor,
    limit: 1
  });
  assert.equal(finished.done, true);
  const bee = (await store.list({accountId: 'acc-1'})).find(job => job.handle === 'bee');
  assert.equal(bee.profile.name, 'Bee');
  assert.equal(bee.profile.bio, '新简介');
});

test('search and source-state scans stop at the batch and still reach a later match', async () => {
  const name = `late-match-${Date.now()}`;
  const clock = {t: 1};
  const store = storeFor(name, clock);
  for (let i = 0; i < 200; i += 1) {
    clock.t = i + 1;
    await store.enqueue({
      accountId: 'acc-1',
      targetUserId: String(i + 1),
      handle: `skip${i}`,
      profile: {bio: '无关'},
      sources: [{module: 'fans', url: `https://x.com/s/${i}`, enabled: true}]
    });
  }
  clock.t = 250;
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '999',
    handle: 'found',
    profile: {bio: '目标词'},
    sources: [{module: 'fans', url: 'https://x.com/found', enabled: true}]
  });
  await store.resolveJob({
    accountId: 'acc-1',
    id: (await store.lookup({accountId: 'acc-1', handle: 'found'})).id,
    state: 'followed'
  });
  const first = await store.queryPage({accountId: 'acc-1', q: '目标词', limit: 5});
  assert.equal(first.jobs.length, 0);
  assert.equal(first.scanned, 200);
  assert.equal(first.scanLimited, true);
  assert.equal(first.scanExhausted, false);
  assert.equal(first.hasMore, true);
  assert.equal(first.total, null);
  const second = await store.queryPage({accountId: 'acc-1', q: '目标词', limit: 5, cursor: first.nextCursor});
  assert.equal(second.jobs.length, 1);
  assert.equal(second.jobs[0].handle, 'found');
  assert.equal(second.scanExhausted, true);
  const stateFirst = await store.queryPage({accountId: 'acc-1', source: 'fans', state: 'followed', limit: 5});
  assert.equal(stateFirst.jobs.length, 0);
  assert.equal(stateFirst.scanned, 200);
  assert.equal(stateFirst.scanLimited, true);
  const stateNext = await store.queryPage({
    accountId: 'acc-1',
    source: 'fans',
    state: 'followed',
    limit: 5,
    cursor: stateFirst.nextCursor
  });
  assert.equal(stateNext.jobs.length, 1);
  assert.equal(stateNext.jobs[0].handle, 'found');
});

test('a blocked open closes the connection delivered by a late success', async () => {
  let closed = false;
  const fake = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.onblocked?.();
        request.result = {close() { closed = true; }};
        request.onsuccess?.();
      });
      return request;
    }
  };
  const store = createFollowQueueStore({indexedDB: fake, dbName: 'blocked-db'});
  await assert.rejects(store.getSettings('acc-1'), /blocked/);
  assert.equal(closed, true);
});

test('priority order spans pages, preserves FIFO ties and binds cursor to sort and filters', async () => {
  const clock={t:1000}, store=storeFor(`priority-pages-${Date.now()}`,clock);
  for (const [handle,module] of [['ordinary1','mutual'],['fan1','fans'],['ordinary2','comments'],['fan2','fans']]) {
    await store.enqueue({accountId:'sort',handle,sources:[{module,enabled:true}]}); clock.t++;
  }
  const read=async order=>{
    let cursor=null, handles=[];
    do {const page=await store.queryPage({accountId:'sort',order,cursor,limit:1}); handles.push(...page.jobs.map(j=>j.handle));cursor=page.nextCursor;} while(cursor);
    return handles;
  };
  assert.deepEqual(await read('desc'),['fan1','fan2','ordinary1','ordinary2']);
  assert.deepEqual(await read('asc'),['ordinary1','ordinary2','fan1','fan2']);
  const first=await store.queryPage({accountId:'sort',order:'desc',limit:1});
  await assert.rejects(store.queryPage({accountId:'sort',order:'asc',cursor:first.nextCursor,limit:1}),/cursor/);
  const filtered=await store.queryPage({accountId:'sort',order:'desc',source:'comments',limit:2});
  assert.deepEqual(filtered.jobs.map(j=>j.handle),['ordinary2']);
  assert.equal(filtered.total,1);
  const search=await store.queryPage({accountId:'sort',order:'desc',q:'fan',limit:10});
  assert.deepEqual(search.jobs.map(j=>j.handle),['fan1','fan2']);
});

test('unavailable handles without an existing job cannot enter later from old sources',async()=>{
 const store=storeFor('terminal-empty-'+crypto.randomUUID());
 await store.markDeletedHandle({accountId:'owner',handle:'GoneUser'});
 assert.equal((await store.enqueue({accountId:'owner',handle:'GoneUser',targetUserId:'123',sources:[{module:'fans',enabled:true}]})).deleted,true);
 assert.equal((await store.enqueue({accountId:'other',handle:'GoneUser',sources:[{module:'fans',enabled:true}]})).deleted,undefined);
});
