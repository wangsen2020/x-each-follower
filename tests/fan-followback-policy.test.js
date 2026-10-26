import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {isPendingFanFollowBack,shouldEnqueueFan} from '../src/features/relationships/fan-followback-policy.js';
import {assessQueueProfile,createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {followerCountPriority,followQueuePriority} from '../src/features/follow-queue/follow-queue-priority.js';
globalThis.IDBKeyRange=IDBKeyRange;

test('collection ignores executor allow-all flag and preserves risk and enqueue filters',()=>{
  const fan={handle:'fan',state:'follow_back',status:'danger',risk:{level:'danger'},relationship:{followedBy:true,following:false}};
  assert.equal(shouldEnqueueFan(fan,{}),false);
  assert.equal(shouldEnqueueFan(fan,{followBackAllowAll:true,autoEnqueue:false,filterDanger:true}),false);
  assert.equal(isPendingFanFollowBack({...fan,relationship:{following:true,followedBy:true}}),false);
  assert.equal(isPendingFanFollowBack({...fan,relationship:{following:false,followedBy:false}}),false);
});

test('local follow-back evidence maps follower bands to bounded queue weights',()=>{
  assert.equal(followerCountPriority(''),10);
  assert.equal(followerCountPriority('499'),20);
  assert.equal(followerCountPriority('999'),35);
  assert.equal(followerCountPriority('1,999 Followers'),50);
  assert.equal(followerCountPriority('2,999 Followers'),60);
  assert.equal(followerCountPriority('3.9K'),50);
  assert.equal(followerCountPriority('4.9K'),45);
  assert.equal(followerCountPriority('5.9K'),40);
  assert.equal(followerCountPriority('6.9K'),35);
  assert.equal(followerCountPriority('7.9K'),30);
  assert.equal(followerCountPriority('8.9K'),25);
  assert.equal(followerCountPriority('9.9K'),25);
  assert.equal(followerCountPriority('19,999'),15);
  assert.equal(followerCountPriority('29,999'),8);
  assert.equal(followerCountPriority('3万'),3);
  assert.equal(followQueuePriority({profile:{followersText:'2,200'},sources:[{module:'mutual',enabled:true}]}),60);
  assert.equal(followQueuePriority({profile:{followersText:'80,000'},sources:[{module:'fans',enabled:true}]}),100);
});

test('only a freshly confirmed follower bypasses all queue screening, never normal candidates',()=>{
  const profile={handle:'houthi_updates',bio:'',followersText:'1',followingText:'0'};
  const settings={minFollowers:100,ratioThreshold:1,onlyRecommended:true,skipRiskContent:true};
  assert.notEqual(assessQueueProfile(profile,settings,true),'');
  assert.equal(assessQueueProfile(profile,{...settings,followBackAllowAll:true},true),'');
  assert.notEqual(assessQueueProfile(profile,{...settings,followBackAllowAll:true},false),'');
  assert.equal(followQueuePriority({sources:[{module:'fans',enabled:true}]}),100);
});

for (const useRecords of [false,true]) for (const allowAll of [false,true]) test(`source sync restores only strategy-skipped pending fans: records=${useRecords}, allowAll=${allowAll}`,async()=>{
  const accountId='123';
  const store=createFollowQueueStore({indexedDB,dbName:'fan-policy-'+crypto.randomUUID()});
  await store.saveSettings(accountId,{followBackAllowAll:allowAll});
  assert.equal((await store.getSettings('other-account')).followBackAllowAll,false);
  const users=[];
  for(const [handle,state] of [['skippedfan','skipped'],['excludedfan','excluded'],['uncertainfan','uncertain'],['donefan','followed']]){
    const job=await store.enqueue({accountId,handle,sources:[{module:'fans',enabled:true}]});
    await store.resolveJob({accountId,id:job.id,state,followResult:state==='followed'?{succeeded:true}:{reason:'old result'}});
    users.push({handle,state:'follow_back',status:'danger',autoFollowState:'skipped',relationship:{followedBy:true,following:false}});
  }
  const values={followQueueBinding:{accountId,handle:'viewer',activated:true,sources:{fans:true}},
    monitor:{followBackAllowAll:!allowAll,queue:users}};
  const api={storage:{local:{get:async key=>key==null?values:{[key]:values[key]}}},
    tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const records=useRecords ? {
    metadata:async()=>({followBackAllowAll:!allowAll}), profiles:async()=>[],
    sourcePage:async({sourceKey})=>({records:sourceKey==='monitor'?users.map(payload=>({
      sourceKey:'monitor',sourcePath:['monitor','queue'],payload})):[],nextCursor:null})
  } : null;
  const runtime=createFollowQueueRuntime({api,store,records});
  await runtime.syncCandidates();
  await runtime.syncCandidates(); // Legacy skipped data must not re-exclude the restored task.
  const rows=await store.list({accountId});
  assert.equal(rows.find(r=>r.handle==='skippedfan').state,allowAll?'pending':'skipped');
  assert.equal(rows.find(r=>r.handle==='excludedfan').state,'excluded');
  assert.equal(rows.find(r=>r.handle==='uncertainfan').state,'uncertain');
  assert.equal(rows.find(r=>r.handle==='donefan').state,'followed');
});

test('legacy pending labels never authorize follow-back priority',()=>{
  for(const user of [{status:'pending'},{state:'follow_back'},{relationship:{followedBy:true}},{relationship:{following:false}}])assert.equal(isPendingFanFollowBack(user),false);
  assert.equal(isPendingFanFollowBack({relationship:{followedBy:true,following:false}}),true);
});

test('confirmed followers overtake older fan jobs and lose priority on newer contrary evidence',async()=>{
  const store=createFollowQueueStore({indexedDB,dbName:'confirmed-priority-'+crypto.randomUUID()});
  const source=[{module:'fans',enabled:true}];
  const old=await store.enqueue({accountId:'1',handle:'old',sources:source});
  const confirmed=await store.enqueue({accountId:'1',handle:'confirmed',sources:source,followBackCandidate:true});
  assert.equal(confirmed.priority,200);
  assert.equal((await store.claim({accountId:'1',owner:'test',leaseMs:10000})).id,confirmed.id);
  assert.equal(followQueuePriority({...confirmed,followResult:{relationshipDecision:{code:'ordinary'}}}),100);
  assert.equal(old.priority,100);
});
