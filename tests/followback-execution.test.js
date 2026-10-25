import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {queueRelationshipDecision} from '../src/features/relationships/fan-followback-policy.js';
globalThis.IDBKeyRange=IDBKeyRange;

for(const relation of [{following:false,followedBy:true},{following:false,followedBy:false},{following:false,followedBy:null},{following:null,followedBy:true}]) {
 test(`executor gates before follow using real parsed relationship ${JSON.stringify(relation)}`,async()=>{
  const values={followQueueBinding:{accountId:'1',handle:'viewer',activated:true,sources:{fans:true}}};
  let follows=0,scrolls=0;
  const api={storage:{local:{get:async k=>typeof k==='string'?{[k]:values[k]}:{...values},set:async p=>Object.assign(values,p)}},
   tabs:{query:async()=>[{id:1}],create:async()=>({id:2}),get:async()=>({status:'complete',url:'https://x.com/candidate'}),remove:async()=>{}},
   alarms:{clear:async()=>{},create:async()=>{},getAll:async()=>[]},
   scripting:{executeScript:async({func})=>{if(func.name==='simulateProfileScrollStep')scrolls++;return[{result:func.name==='readQueueViewerOnPage'?'viewer':{pending:false,name:'Candidate',bio:'',followersText:'1000',followingText:'1',posts:[]}}];}}};
  const store=createFollowQueueStore({indexedDB,dbName:'relationship-executor-'+crypto.randomUUID()});
  await store.saveSettings('1',{enabled:true,batchLimit:1,inspectLimit:1,grokEnabled:false,followBackAllowAll:true});
  await store.enqueue({accountId:'1',handle:'candidate',targetUserId:'42',sources:[{module:'fans',enabled:true}]});
  const runtime=createFollowQueueRuntime({api,store,wait:async()=>{},fetchProfile:async()=>({status:200,json:{rest_id:'42',core:{screen_name:'candidate'},relationship_perspectives:{following:relation.following,followed_by:relation.followedBy}}}),performFollow:async()=>{follows++;return{status:200}},records:{metadata:async()=>({}),sourcePage:async()=>({records:[]}),lookup:async()=>null,lookupAll:async()=>[],profiles:async()=>[],batch:async()=>{}}});
  await runtime.run();
  const row=(await store.list({accountId:'1'}))[0];
  const unknown=relation.following===null||relation.followedBy===null;
  assert.equal(row.state,unknown?'uncertain':relation.followedBy?'followed':'skipped');
  assert.equal(follows,relation.following===false&&relation.followedBy===true?1:0);
  if(unknown)assert.equal(scrolls,0);
  const log=values.autoFollowLogs.find(l=>l.type==='job-complete');
  assert.ok(log.relationshipDecision);
  assert.match(log.detail,unknown?/关系待核实/:relation.followedBy?/确认待回关/:/对方当前未关注我/);
  assert.equal(row.followResult.relationshipDecision.code,queueRelationshipDecision({sources:[{module:'fans',enabled:true}]},relation).code);
 });
}

test('manual verification cannot reopen a fan whose relationship is still missing',async()=>{
 const binding={accountId:'1',handle:'viewer',activated:true,sources:{fans:true}};
 const job={id:'job',accountId:'1',handle:'candidate',targetUserId:'42',state:'uncertain',sources:[{module:'fans',enabled:true}]};
 let writes=0;
 const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
 const runtime=createFollowQueueRuntime({api,store:{list:async()=>[job],resolveJob:async()=>{writes++;}},fetchUser:async()=>({id:'42',handle:'candidate',relationship:{following:false,followedBy:null}})});
 await assert.rejects(runtime.handle({cmd:'followQueueVerify',jobId:'job'}),/关系待核实/);
 assert.equal(writes,0);
});
