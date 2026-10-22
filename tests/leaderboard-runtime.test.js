import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createLeaderboardStore} from '../src/features/leaderboard/leaderboard-store.js';
import {createLeaderboardRuntime} from '../src/features/leaderboard/leaderboard-runtime.js';

const auth={queryId:'abc',headers:{authorization:'Bearer redacted','x-csrf-token':'redacted'}};
function api(){
  let scheduledTime=null;
  return {
    storage:{local:{get:async key=>key==='networkTemplates'?{networkTemplates:{UserByScreenName:auth,UserOriginalsTimeline:auth}}:{},set:async()=>{}}},
    tabs:{query:async()=>[{id:1,url:'https://x.com/home',status:'complete'}],get:async()=>({id:1,status:'complete'}),create:async()=>({id:2,status:'complete'}),remove:async()=>{}},
    alarms:{create:async(_name,info)=>{scheduledTime=info.when;},get:async()=>scheduledTime?{scheduledTime}:null,clear:async()=>{scheduledTime=null;}}
  };
}
const profile={data:{user:{result:{__typename:'User',rest_id:'200',core:{screen_name:'writer',name:'Writer'},relationship_counts:{followers:123}}}}};

test('adding a tweet author creates an owner-scoped member and real initial baseline',async()=>{
  const store=createLeaderboardStore({indexedDB:new IDBFactory()});
  let ownerId='100';
  const runtime=createLeaderboardRuntime({api:api(),store,owner:async()=>({accountId:ownerId}),client:{profile:async()=>({status:200,json:profile})},now:()=>Date.parse('2026-10-22T08:00:00+08:00')});
  const input={action:'add',handle:'writer',tweetId:'300',url:'https://x.com/writer/status/300'};
  assert.equal((await runtime.handle(input)).member,true);
  assert.equal((await runtime.handle({action:'membership',handle:'writer'})).member,true);
  assert.equal((await store.listSnapshots('100','200'))[0].followers,123);
  assert.equal((await runtime.handle({action:'state'})).members[0].deltaStatus,'baseline_missing');
  ownerId='101';
  assert.equal((await runtime.handle({action:'membership',handle:'writer'})).member,false);
  assert.equal((await runtime.handle({action:'state'})).members.length,0);
});

test('account switch during profile lookup prevents a leaderboard write',async()=>{
  const store=createLeaderboardStore({indexedDB:new IDBFactory()});
  let ownerId='100';
  const runtime=createLeaderboardRuntime({api:api(),store,owner:async()=>({accountId:ownerId}),client:{profile:async()=>{ownerId='101';return {status:200,json:profile};}}});
  await assert.rejects(runtime.handle({action:'add',handle:'writer',tweetId:'300',url:'https://x.com/writer/status/300'}),/账号已切换/);
  assert.deepEqual(await store.listMembers('100'),[]);
  assert.deepEqual(await store.listMembers('101'),[]);
});

test('membership uses stable user ID across handle rename and reuse',async()=>{
  const store=createLeaderboardStore({indexedDB:new IDBFactory()});
  await store.upsertMember({ownerId:'100',creatorId:'200',handle:'writer',active:true});
  const runtime=createLeaderboardRuntime({api:api(),store,owner:async()=>({accountId:'100'}),client:{profile:async(_tab,handle)=>({status:200,json:{data:{user:{result:{__typename:'User',rest_id:handle==='newwriter'?'200':'201',core:{screen_name:handle},relationship_counts:{followers:10}}}}}})}});
  assert.equal((await runtime.handle({action:'membership',handle:'newwriter'})).member,true);
  assert.equal((await store.getMember('100','200')).handle,'newwriter');
  assert.equal((await runtime.handle({action:'membership',handle:'writer'})).member,false);
});

test('yesterday growth uses yesterday and today snapshots, not the preceding day',async()=>{
  const store=createLeaderboardStore({indexedDB:new IDBFactory()});
  await store.upsertMember({ownerId:'100',creatorId:'200',handle:'writer',active:true});
  for(const [day,followers] of [['20',10],['21',100],['22',105]])await store.appendSnapshot({ownerId:'100',creatorId:'200',at:Date.parse(`2026-10-${day}T00:05:00+08:00`),followers});
  const runtime=createLeaderboardRuntime({api:api(),store,owner:async()=>({accountId:'100'}),now:()=>Date.parse('2026-10-22T08:00:00+08:00')});
  const row=(await runtime.state()).members[0];
  assert.equal(row.delta,5);
  assert.equal(row.deltaEvidence.after.followers,105);
  assert.equal((await runtime.handle({action:'report',date:'2026-10-21'})).report,null);
});
