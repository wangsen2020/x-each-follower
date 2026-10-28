import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileTab,updateProfileTab,readProfileOnTab,observeProfile,PROFILE_ACCESS_PREFIX,unavailableFromProfileResponse} from '../src/platform/x/profile-access.js';
import {createXNetworkClient} from '../src/platform/x/network-client.js';
import {readPostMetricsOnPage} from '../src/platform/x/page-reader.js';

test('profile reading enriches by exact post ID with loaded main-world metrics and preserves unknowns',async()=>{
 const {api}=fixture();
 let mainCalls=0;
 api.scripting.executeScript=async({func,world,args})=>{
  if(func===readPostMetricsOnPage){mainCalls++;assert.equal(world,'MAIN');assert.deepEqual(args,[['123','456']]);return [{result:{'123':{replyCount:10,repostCount:20,likeCount:30,bookmarkCount:40}}}];}
  return [{result:{pending:false,status:'ok',posts:[{url:'https://x.com/writer/status/123',replyCount:1,bookmarkCount:null},{url:'https://x.com/writer/status/456',bookmarkCount:null}]}}];
 };
 const bundle=await readProfileOnTab(api,12,'writer',20,'follow-queue');
 assert.equal(mainCalls,1);assert.equal(bundle.posts[0].replyCount,10);assert.equal(bundle.posts[0].bookmarkCount,40);
 assert.equal(bundle.posts[1].bookmarkCount,null);
});
function fixture(){const values={},calls=[];return {values,calls,api:{storage:{local:{get:async k=>({[k]:values[k]}),set:async p=>Object.assign(values,structuredClone(p))}},tabs:{create:async opts=>{calls.push(['create',opts]);return {id:12}},update:async(id,opts)=>{calls.push(['update',id,opts]);return {id}}},scripting:{executeScript:async()=>[{result:{pending:false,status:'not_found',reason:'此账号不存在'}}]}}};}
test('a real DOM terminal result blocks later opens and navigations across module entry points',async()=>{
 const {api,values,calls}=fixture();await createProfileTab(api,{url:'https://x.com/GaoShouKeJi'},'follow-queue');await readProfileOnTab(api,12,'GaoShouKeJi',5,'follow-queue');
 for(const source of ['profile-detail','mutual-refresh','mutual-auto-follow','comment-auto-follow','grok-profile-batch','network-template:Followers','leaderboard']){
  await assert.rejects(createProfileTab(api,{url:'https://x.com/GaoShouKeJi'},source),e=>e.code==='X_PROFILE_UNAVAILABLE');
  await assert.rejects(updateProfileTab(api,12,{url:'https://x.com/GaoShouKeJi/followers'},source),e=>e.code==='X_PROFILE_UNAVAILABLE');
 }
 assert.equal(calls.length,1);const row=values[PROFILE_ACCESS_PREFIX+'gaoshoukeji'];assert.equal(row.status,'not_found');assert.equal(row.events.length,12);assert.equal(row.events.at(-1).source,'leaderboard');
 const client=createXNetworkClient(api);await assert.rejects(client.profile(12,'GaoShouKeJi'),/不存在/);await assert.rejects(client.query(12,'UserByScreenName',{screen_name:'GaoShouKeJi'}),/不存在/);
});
test('temporary errors and unrelated routes are not classified as unavailable; expired or valid evidence allows a fresh visit',async()=>{
 const {api,values,calls}=fixture();await observeProfile(api,'writer',{pending:true},'detail');assert.deepEqual(values,{});
 await observeProfile(api,'writer',{status:'suspended',reason:'账号已停用'},'detail');values[PROFILE_ACCESS_PREFIX+'writer'].expiresAt=Date.now()-1;await createProfileTab(api,{url:'https://x.com/writer'},'detail');
 await observeProfile(api,'writer',{status:'not_found'},'detail');await createProfileTab(api,{url:'https://x.com/writer/status/123'},'post');await createProfileTab(api,{url:'https://x.com/home'},'identity');
 await observeProfile(api,'writer',{status:'ok'},'manual-verification');await createProfileTab(api,{url:'https://x.com/writer'},'detail');assert.equal(calls.length,4);
 for(const response of [{status:404,json:null},{status:429,json:{errors:[{code:50}]}},{status:200,json:{data:{user:{result:{__typename:'UserUnavailable',reason:'Protected'}}}}},{status:200,json:{data:{user:{result:null}}}}])assert.equal(unavailableFromProfileResponse(response),null);
 assert.equal(unavailableFromProfileResponse({status:200,json:{errors:[{code:50}]}}).status,'not_found');
 assert.equal(unavailableFromProfileResponse({status:200,json:{errors:[{code:63}]}}).status,'suspended');
});

test('profile fallback reuses its supplied background tab instead of opening the same account twice',async()=>{
 const {acquireProfileTab}=await import('../src/platform/x/profile-access.js');const {api,calls}=fixture();api.tabs.get=async id=>({id,url:'https://x.com/home'});
 const lease=await acquireProfileTab(api,'writer','profile-fallback',12);assert.equal(lease.owned,false);assert.equal(lease.tab.id,12);assert.equal(calls.length,1);assert.equal(calls[0][0],'update');
 await observeProfile(api,'writer',{status:'not_found'},'profile-fallback');await assert.rejects(acquireProfileTab(api,'writer','profile-fallback',12),/不可用/);assert.equal(calls.length,1);
});

test('availability trace write failures preserve DOM results and cached terminal decisions',async()=>{
 const {api,values}=fixture();
 api.storage.local.set=async()=>{throw Error('trace storage quota exceeded');};
 const result=await readProfileOnTab(api,12,'writer',5,'profile-detail');
 assert.equal(result.status,'not_found');
 values[PROFILE_ACCESS_PREFIX+'writer']={status:'suspended',reason:'账号已停用',expiresAt:Date.now()+60000};
 await assert.rejects(createProfileTab(api,{url:'https://x.com/writer'},'detail'),e=>e.code==='X_PROFILE_UNAVAILABLE'&&e.availability==='suspended');
});

for(const response of [
 {status:200,json:{data:{user:{result:{__typename:'User',rest_id:'123'}}}}},
 {status:200,json:{errors:[{code:63}]}}
])test(`trace failure preserves profile network outcome ${response.json.errors?'suspended':'ok'}`,async()=>{
 const {api,values}=fixture();
 values.networkTemplates={UserByScreenName:{origin:'https://x.com',queryId:'fixture',headers:{authorization:'Bearer fixture','x-csrf-token':'fixture'},variables:{}}};
 api.storage.local.set=async()=>{throw Error('trace storage quota exceeded');};
 api.scripting.executeScript=async options=>[{result:options.args?response:true}];
 const request=createXNetworkClient(api).profile(12,'writer');
 if(response.json.errors)await assert.rejects(request,e=>e.code==='X_PROFILE_UNAVAILABLE'&&e.availability==='suspended');
 else assert.deepEqual(await request,response);
});

test('unresolved identity persists across clients and blocks requests until a verified ID is observed',async()=>{
 const {api,values,calls}=fixture();
 await observeProfile(api,'target',{status:'identity_unresolved',reason:'无法确认用户 ID'},'greeting-identity');
 const client=createXNetworkClient(api);
 await assert.rejects(client.profile(12,'target'),{code:'X_PROFILE_IDENTITY_UNRESOLVED'});
 await assert.rejects(createProfileTab(api,{url:'https://x.com/target'},'follow-queue'),{code:'X_PROFILE_IDENTITY_UNRESOLVED'});
 assert.equal(calls.length,0);
 await observeProfile(api,'target',{status:'ok'},'incomplete-dom');
 assert.equal(values[PROFILE_ACCESS_PREFIX+'target'].status,'identity_unresolved');
 await observeProfile(api,'target',{status:'ok',id:'123'},'manual-check');
 await createProfileTab(api,{url:'https://x.com/target'},'follow-queue');assert.equal(calls.length,1);
});

test('explicit read-only availability recheck fetches fresh API evidence despite a cached terminal state',async()=>{
 const {api,values}=fixture();
 await observeProfile(api,'writer',{status:'not_found'},'prior');
 values.networkTemplates={UserByScreenName:{origin:'https://x.com',queryId:'fixture',headers:{authorization:'Bearer fixture','x-csrf-token':'fixture'},variables:{}}};
 const response={status:200,json:{errors:[{code:50}]}};
 let dispatched=0;
 api.scripting.executeScript=async options=>{if(options.args)dispatched++;return [{result:options.args?response:true}];};
 const client=createXNetworkClient(api);
 await assert.rejects(client.profile(12,'writer'),e=>e.code==='X_PROFILE_UNAVAILABLE');
 assert.equal(dispatched,0);
 assert.deepEqual(await client.profile(12,'writer',{refreshAvailability:true,returnUnavailable:true}),response);
 assert.equal(dispatched,1);
 await assert.rejects(client.profile(12,'writer'),e=>e.code==='X_PROFILE_UNAVAILABLE');
});
