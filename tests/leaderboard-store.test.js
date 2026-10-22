import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createLeaderboardStore} from '../src/features/leaderboard/leaderboard-store.js';

test('leaderboard records are owner-scoped and keep the earliest daily follower baseline',async()=>{
  const store=createLeaderboardStore({indexedDB:new IDBFactory()});
  await store.upsertMember({ownerId:'100',creatorId:'200',handle:'writer',active:true});
  await store.upsertMember({ownerId:'101',creatorId:'200',handle:'writer',active:true});
  assert.equal((await store.listMembers('100')).length,1);
  assert.equal((await store.listMembers('101')).length,1);
  const morning=Date.parse('2026-10-22T00:10:00+08:00');
  await store.appendSnapshot({ownerId:'100',creatorId:'200',at:morning+3600000,followers:110});
  await store.appendSnapshot({ownerId:'100',creatorId:'200',at:morning,followers:100});
  await store.appendSnapshot({ownerId:'100',creatorId:'200',at:morning+7200000,followers:120});
  await store.appendSnapshot({ownerId:'101',creatorId:'200',at:morning,followers:300});
  assert.deepEqual((await store.listSnapshots('100','200')).map(row=>row.followers),[100]);
  assert.deepEqual((await store.listSnapshots('101','200')).map(row=>row.followers),[300]);
});

test('post, job and report reads cannot cross account boundaries',async()=>{
  const store=createLeaderboardStore({indexedDB:new IDBFactory()});
  await store.putPost({ownerId:'100',creatorId:'200',postId:'300',createdAt:1000});
  await store.putJob({ownerId:'100',date:'2026-10-21',status:'running'});
  await store.putReport({ownerId:'100',date:'2026-10-21',status:'completed'});
  await store.putReport({ownerId:'100',date:'2026-10-21',status:'partial'});
  assert.equal((await store.listPosts('101','200')).length,0);
  assert.equal(await store.getJob('101','2026-10-21'),undefined);
  assert.equal((await store.listReports('101')).length,0);
  assert.equal((await store.listPosts('100','200',{from:1000,to:1001})).length,1);
  assert.equal((await store.getReport('100','2026-10-21')).status,'completed');
});
