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
  const runtime=createFollowQueueRuntime({api,store,wait:async()=>{},fetchProfile:async()=>({status:200,json:{rest_id:'42',core:{screen_name:'candidate'},relationship_counts:{followers:1000,following:1},relationship_perspectives:{following:relation.following,followed_by:relation.followedBy}}}),performFollow:async()=>{follows++;return{status:200}},records:{metadata:async()=>({}),sourcePage:async()=>({records:[]}),lookup:async()=>null,lookupAll:async()=>[],profiles:async()=>[],batch:async()=>{}}});
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

test('X error 161 stops this batch after one follow attempt without a global cooldown',async()=>{
 const values={followQueueBinding:{accountId:'1',handle:'viewer',activated:true,sources:{fans:true}}};
 const api={storage:{local:{get:async k=>typeof k==='string'?{[k]:values[k]}:{...values},set:async p=>Object.assign(values,p)}},
  tabs:{query:async()=>[{id:1}],create:async()=>({id:2}),get:async()=>({status:'complete',url:'https://x.com/first'}),remove:async()=>{}},
  alarms:{clear:async()=>{},create:async()=>{},getAll:async()=>[]},
  scripting:{executeScript:async({func})=>[{result:func.name==='readQueueViewerOnPage'?'viewer':{pending:false,name:'Candidate',bio:'',followersText:'1000',followingText:'1',posts:[]}}]}};
 const store=createFollowQueueStore({indexedDB,dbName:'account-follow-limit-'+crypto.randomUUID()});
 await store.saveSettings('1',{enabled:true,batchLimit:2,inspectLimit:2,grokEnabled:false,followBackAllowAll:true});
 for(const handle of ['first','second'])await store.enqueue({accountId:'1',handle,targetUserId:handle==='first'?'42':'43',sources:[{module:'fans',enabled:true}]});
 let attempts=0;
 const runtime=createFollowQueueRuntime({api,store,wait:async()=>{},fetchProfile:async(_,handle)=>({status:200,json:{rest_id:handle==='first'?'42':'43',core:{screen_name:handle},relationship_counts:{followers:1000,following:1},relationship_perspectives:{following:false,followed_by:true}}}),performFollow:async()=>{attempts++;return{status:403,json:{errors:[{code:161}]},error:'You are unable to follow more people at this time.'}},records:{metadata:async()=>({}),sourcePage:async()=>({records:[]}),lookup:async()=>null,lookupAll:async()=>[],profiles:async()=>[],batch:async()=>{}}});
 const result=await runtime.run();
 assert.equal(attempts,1);
 assert.match(result.summary,/错误 161/);
 const jobs=await store.list({accountId:'1'});
 assert.equal(jobs.filter(job=>job.state==='uncertain').length,1);
 assert.equal(jobs.filter(job=>job.state==='pending').length,1);
 assert.equal(jobs.find(job=>job.state==='uncertain').followResult.errorCode,161);
 assert.equal(values.monitor?.pausedUntil,undefined);
});

test('profile read HTTP 429 stops this batch before any follow request',async()=>{
 const values={followQueueBinding:{accountId:'1',handle:'viewer',activated:true,sources:{fans:true}}};
 const api={storage:{local:{get:async k=>typeof k==='string'?{[k]:values[k]}:{...values},set:async p=>Object.assign(values,p)}},
  tabs:{query:async()=>[{id:1}],create:async()=>({id:2}),get:async()=>({status:'complete',url:'https://x.com/first'}),remove:async()=>{}},
  alarms:{clear:async()=>{},create:async()=>{},getAll:async()=>[]},
  scripting:{executeScript:async({func})=>[{result:func.name==='readQueueViewerOnPage'?'viewer':{pending:false,name:'Candidate',bio:'',followersText:'1000',followingText:'1',posts:[]}}]}};
 const store=createFollowQueueStore({indexedDB,dbName:'profile-limit-'+crypto.randomUUID()});
 await store.saveSettings('1',{enabled:true,batchLimit:2,inspectLimit:2,grokEnabled:false,followBackAllowAll:true});
 for(const handle of ['first','second'])await store.enqueue({accountId:'1',handle,targetUserId:handle==='first'?'42':'43',sources:[{module:'fans',enabled:true}]});
 let attempts=0;
 const runtime=createFollowQueueRuntime({api,store,wait:async()=>{},fetchProfile:async()=>({status:429,error:'Too Many Requests'}),performFollow:async()=>{attempts++;return{status:200}},records:{metadata:async()=>({}),sourcePage:async()=>({records:[]}),lookup:async()=>null,lookupAll:async()=>[],profiles:async()=>[],batch:async()=>{}}});
 const result=await runtime.run();
 assert.equal(attempts,0);
 assert.equal(result.counters.inspected,1);
 assert.match(result.summary,/用户资料接口限流，本轮停止；未发送关注请求/);
 const jobs=await store.list({accountId:'1'});
 assert.equal(jobs.filter(job=>job.state==='retry').length,1);
 assert.equal(jobs.filter(job=>job.state==='pending').length,1);
});
