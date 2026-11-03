import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createAccessBudget,admitXAccess,accessDeferred,X_ACCESS_POLICY,readXChallengeOnPage} from '../src/platform/x/access-budget.js';
import {createProfileTab,updateProfileTab} from '../src/platform/x/profile-access.js';
import {createXNetworkClient} from '../src/platform/x/network-client.js';

function fixture(policy){let time=10000000;const options={name:'access-'+crypto.randomUUID(),dependencies:{indexedDB,IDBKeyRange},now:()=>time,random:()=>0,policy};
 return {budget:createAccessBudget(options),another:()=>createAccessBudget(options),tick:n=>time+=n,now:()=>time};}
test('separate contexts atomically share navigation spacing and persist it after reopening',async()=>{
 const f=fixture(),other=f.another();
 const results=await Promise.all([f.budget.reserve({key:'one'}),other.reserve({key:'two'})]);
 assert.equal(results.filter(r=>r.allowed).length,1);f.budget.close();other.close();
 const fresh=f.another();assert.equal((await fresh.reserve({key:'three'})).allowed,false);
 f.tick(30000);assert.equal((await fresh.reserve({key:'three'})).allowed,true);fresh.close();
});
test('repeat navigation blocks another module, while query and navigation have separate pacing',async()=>{
 const f=fixture();await f.budget.reserve({key:'same',source:'follow-queue'});f.tick(30000);
 assert.equal((await f.budget.reserve({key:'same',source:'fan-review-removal'})).retryAt,f.now()+570000);
 assert.equal((await f.budget.reserve({kind:'query',key:'same'})).allowed,true);
 f.tick(570000);assert.equal((await f.budget.reserve({key:'same'})).allowed,true);f.budget.close();
});
test('sliding limits cannot burst at time boundaries',async()=>{
 const policy={navigation:{...X_ACCESS_POLICY.navigation,minGap:0,jitter:0,repeatGap:0,quarterLimit:2,hourLimit:3}};
 const f=fixture(policy);await f.budget.reserve({key:'a'});f.tick(1);await f.budget.reserve({key:'b'});
 assert.equal((await f.budget.reserve({key:'c'})).allowed,false);f.tick(899999);
 assert.equal((await f.budget.reserve({key:'c'})).allowed,true);f.tick(1);
 const blocked=await f.budget.reserve({key:'d'});assert.equal(blocked.allowed,false);assert.equal(blocked.retryAt,13600000);f.budget.close();
});
test('429 cooldown uses the largest server deadline and survives restart across both access types',async()=>{
 const f=fixture();const reset=f.now()+1800000;await f.budget.observe({status:429,retryAfterSeconds:1200,rateLimit:{resetAt:reset}});f.budget.close();
 const b=f.another();for(const kind of ['navigation','query'])assert.equal((await b.reserve({kind,key:'new'})).retryAt,reset);
 f.tick(1800000);assert.equal((await b.reserve({key:'new'})).allowed,true);b.close();
});
for(const response of [{status:401},{status:403},{challenge:true},{status:200,rateLimit:{remaining:0}}])test('shared cooldown for '+JSON.stringify(response),async()=>{
 const f=fixture();await f.budget.observe(response);assert.equal((await f.budget.reserve({key:'a'})).allowed,false);f.budget.close();
});
test('cancelled, long-deferred, and broken budget never open a tab or dispatch a request',async()=>{
 let opens=0;const api={accessBudget:{reserve:async()=>({allowed:false,retryAt:Date.now()+900000})},tabs:{create:async()=>{opens++},update:async()=>{opens++}}};
 await assert.rejects(createProfileTab(api,{url:'https://x.com/test'},'queue'),{code:'X_ACCESS_DEFERRED'});
 await assert.rejects(updateProfileTab(api,1,{url:'https://x.com/test'},'legacy'),{code:'X_ACCESS_DEFERRED'});assert.equal(opens,0);
 const abort=new AbortController();abort.abort();await assert.rejects(admitXAccess(api,{key:'a'},{signal:abort.signal}));
 api.accessBudget.reserve=async()=>{throw Error('disk unavailable')};await assert.rejects(admitXAccess(api,{key:'b'}),{code:'X_ACCESS_DEFERRED'});
});
test('transport preserves a deferred read instead of returning a generic error for fallback',async()=>{
 let dispatch=0;const api={accessBudget:{reserve:async()=>({allowed:false,retryAt:Date.now()+900000})},
 storage:{local:{get:async()=>({networkTemplates:{UserByScreenName:{origin:'https://x.com',queryId:'test',headers:{authorization:'fixture','x-csrf-token':'fixture'}}}})}},
 scripting:{executeScript:async()=>{dispatch++;return [{result:true}]}}};
 await assert.rejects(createXNetworkClient(api).profile(1,'sample'),{code:'X_ACCESS_DEFERRED'});assert.equal(dispatch,0);
});
test('native loaded profile evidence needs no additional network budget',async()=>{
 const response={status:200,json:{data:{}},source:'native-page'};
 const api={accessBudget:{reserve:async()=>{throw Error('should not reserve')}},scripting:{executeScript:async()=>[{result:response}]}};
 assert.deepEqual(await createXNetworkClient(api).profile(1,'sample',{preferPageResponse:true}),response);
});
test('challenge detection does not scan user biography or posts',()=>{
 const oldLocation=globalThis.location,oldDocument=globalThis.document;
 try{globalThis.location={pathname:'/sample'};globalThis.document={querySelector:()=>null,body:{innerText:'captcha rate limited verify your identity'}};
 assert.equal(readXChallengeOnPage(),false);globalThis.location.pathname='/account/access';assert.equal(readXChallengeOnPage(),true);
 }finally{globalThis.location=oldLocation;globalThis.document=oldDocument;}
});

test('create and navigate share the same normalized profile key',async()=>{
 const keys=[],api={accessBudget:{reserve:async request=>{keys.push(request.key);return {allowed:true}}},tabs:{create:async()=>({id:1}),update:async()=>({id:1})}};
 await createProfileTab(api,{url:'https://x.com/Sample/'},'queue');await updateProfileTab(api,1,{url:'https://x.com/sample'},'collector');
 assert.deepEqual(keys,['/sample','/sample']);
});
test('write responses remain attempted when they establish shared cooling',async()=>{
 const response={status:429,json:null,error:'rate limited',attempted:true};let observed=0;
 const api={accessBudget:{reserve:async()=>{throw Error('not a query')},observe:async()=>{observed++;return Date.now()+900000}},
  storage:{local:{get:async()=>({networkTemplates:{UserByScreenName:{origin:'https://x.com',queryId:'test',headers:{authorization:'fixture','x-csrf-token':'fixture'}}}})}},
  scripting:{executeScript:async options=>[{result:options.args?response:true}]}};
 assert.deepEqual(await createXNetworkClient(api).follow(1,{id:'123',handle:'sample'}),response);assert.equal(observed,1);
});
