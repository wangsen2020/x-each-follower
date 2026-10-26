import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {followerRatioDecision} from '../src/features/relationships/follower-ratio-policy.js';
import {removeRatioFollower} from '../src/platform/x/remove-follower.js';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
globalThis.IDBKeyRange=IDBKeyRange;

test('strict tenfold boundary uses full counts and handles zero without guessing missing data',()=>{
 for(const [following,followers,expected] of [['320','7',true],['100','10',false],['101','10',true],['1','0',true],['0','0',false],['6','320',false]])assert.equal(followerRatioDecision({followingText:following,followersText:followers}).remove,expected);
 for(const bad of ['',null,'1.2K','-1','NaN','9007199254740992'])assert.equal(followerRatioDecision({followingText:'320',followersText:bad}).known,false);
});
function removalFixture({change=false,unknown=false,lost=false,cancel=false}={}){
 const actions=[],intents=[];let submitted=false,reads=0;
 const api={scripting:{executeScript:async({func,args})=>{
  if(func.name==='profileRelationshipOnPage')return [{result:{ready:true,following:false,followedBy:!submitted}}];
  throw Error('unexpected DOM action');
 }}};
 const run=()=>removeRatioFollower({api,tabId:1,handle:'target',targetId:'2',owner:'owner',wait:async()=>{},
  canAct:async()=>!cancel||!intents.length,checkpoint:async intent=>intents.push(intent),refreshPage:async()=>{},sendRemoval:async()=>{actions.push('request');submitted=true;if(lost)throw Error('lost response');return {status:200,attempted:true};},
  readProfile:async()=>({id:'2',handle:'target',followingText:'320',followersText:change&&++reads>1?'100':'7',relationship:{following:unknown?null:false,followedBy:!submitted}})});
 return {run,actions,intents};
}
test('removal uses the network mutation, persists intent before one request and verifies the relationship',async()=>{
 const f=removalFixture(),r=await f.run();assert.equal(r.removed,true);assert.deepEqual(f.actions,['request']);assert.equal(f.intents.length,1);assert.equal(r.live.relationship.followedBy,false);
});
for(const [name,options] of [['changed counts',{change:true}],['unknown relation',{unknown:true}],['disabled before submit',{cancel:true}]])test(name+' never submits removal',async()=>{
 const f=removalFixture(options),r=await f.run();assert.equal(r.removed,false);assert.ok(!f.actions.includes('request'));
});
test('lost confirmation response stays uncertain and is never retried',async()=>{
 const f=removalFixture({lost:true}),r=await f.run();assert.equal(r.removed,false);assert.equal(r.attempted,true);assert.equal(f.actions.filter(x=>x==='request').length,1);
});

async function runtimeFixture({allowAll=true,followedBy=true,following=false,followers='7',removalResult={attempted:true,removed:true},priorIntent=false}={}){
 const store=createFollowQueueStore({indexedDB,dbName:'remove-ratio-'+crypto.randomUUID()});
 await store.saveSettings('1',{enabled:false,followBackAllowAll:allowAll,minFollowers:0,ratioThreshold:0,onlyRecommended:false,grokEnabled:false,batchSize:1,scrollRounds:0,dwellSeconds:2});
 const job=await store.enqueue({accountId:'1',handle:'target',targetUserId:'2',sources:[{module:'fans',enabled:true}]});
 if(priorIntent)await store.resolveJob({accountId:'1',id:job.id,state:'pending',followResult:{followerRemoval:{attemptedAt:1}}});
 const data={followQueueBinding:{accountId:'1',handle:'owner',activated:true,sources:{fans:true}},monitor:{users:[]}},calls=[];
 const api={storage:{local:{get:async key=>typeof key==='string'?{[key]:data[key]}:key?Object.fromEntries(key.map(k=>[k,data[k]])):data,set:async patch=>Object.assign(data,patch)}},
  alarms:{clear:async()=>{},create:async()=>{},getAll:async()=>[]},tabs:{query:async()=>[{id:1}],create:async()=>({id:2}),remove:async()=>{}},
  scripting:{executeScript:async({func})=>[{result:func.name==='readProfileBundle'?{name:'Target',handle:'target',status:'ok',followersText:followers,followingText:'320',posts:[],relationship:{following,followedBy}}:'owner'}]}};
 const runtime=createFollowQueueRuntime({api,store,wait:async()=>{},
  fetchProfile:async()=>({status:200,json:{data:{user:{result:{rest_id:'2',legacy:{screen_name:'target',name:'Target',followers_count:followers===''?null:Number(followers),friends_count:320,following,followed_by:followedBy}}}}}}),
  removeFollower:async options=>{calls.push('remove');await options.checkpoint({attemptedAt:Date.now(),targetUserId:'2'});return {...removalResult,live:{relationship:{following:false,followedBy:false}}};},
  performFollow:async()=>{calls.push('follow');return {status:200};}});
 return {runtime,store,job,calls};
}
test('actual queue executor removes a confirmed excessive follower before posts and never calls follow',async()=>{
 const f=await runtimeFixture();await f.runtime.run(true);assert.deepEqual(f.calls,['remove']);const job=await f.store.get(f.job.id);assert.equal(job.state,'excluded');assert.equal(job.followResult.followerRemoval.removed,true);
});
for(const options of [{allowAll:false},{followedBy:false}])test('ordinary candidates or disabled allowance never authorize follower removal '+JSON.stringify(options),async()=>{
 const f=await runtimeFixture(options);await f.runtime.run(true);assert.ok(!f.calls.includes('remove'));
});
test('missing counts and ambiguous removal are held without following',async()=>{
 for(const options of [{followers:''},{removalResult:{attempted:true,removed:false,reason:'结果待核实'}}]){const f=await runtimeFixture(options);await f.runtime.run(true);assert.ok(!f.calls.includes('follow'));assert.equal((await f.store.get(f.job.id)).state,'uncertain');}
});
test('persisted removal intent is never followed or removed again after restart',async()=>{
 const f=await runtimeFixture({priorIntent:true});await f.runtime.run(true);assert.deepEqual(f.calls,[]);assert.equal((await f.store.get(f.job.id)).state,'uncertain');
});
