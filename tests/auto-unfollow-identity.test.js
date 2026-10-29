import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundAutoUnfollow} from '../src/features/relationships/auto-unfollow-adapter.js';

const time=new Date(2026,9,26,12).getTime();
function setup(response, {pending=false,ownerId='999',page=null}={}) {
  const users=['missing','later'].map((handle,i)=>({handle,id:String(123+i),status:'overdue',followedAt:'2026-09-01T00:00:00Z',relationship:{following:true,followedBy:false}}));
  const state={account:'999',day:'2026-10-26',used:0,queue:['missing','later'],pending:pending?{user:users[0],at:time}:null};
  const data={unreciprocatedSettings:{autoUnfollow:true,autoUnfollowAccount:{id:'999',handle:'owner'},overdueDays:7,dailyLimit:100,autoUnfollowEvery:3,activeTimeStart:'00:00',activeTimeEnd:'00:00'},autoUnfollowState:{accounts:{999:state}}};
  const inspected=[],fetched=[],logs=[],patches=[],deleted=[];
  const api={runtime:{getURL:path=>'chrome-extension://fixture/'+path},storage:{local:{get:async k=>structuredClone({[k]:data[k]}),set:async v=>Object.assign(data,structuredClone(v))}},alarms:{create:async()=>{},clear:async()=>{}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:{handle:'owner'}}]}};
  const service={handle:async(request,senderUrl)=>{assert.equal(senderUrl,'chrome-extension://fixture/background.js');deleted.push(request.handle);return {ok:true,result:{deleted:2}};},summary:async()=>({}),sourcePage:async({sourceKey})=>({records:sourceKey==='unreciprocatedTracker'?users.map(payload=>({accountId:'unassigned',module:'unreciprocated',payload})):[],nextCursor:null}),lookupAll:async({handle})=>[{module:'unreciprocated',userKey:handle,payload:users.find(u=>u.handle===handle)}]};
  const runner=createBackgroundAutoUnfollow({api,service,records:{ready:async()=>{},patch:async p=>patches.push(p)},normalize:x=>x,now:()=>time,writeLog:async e=>logs.push(e),
    fetchProfile:async(tab,handle)=>{
      fetched.push(handle);
      if(handle==='missing'){if(response instanceof Error)throw response;return response;}
      return {status:200,json:{rest_id:handle==='owner'?ownerId:'124',legacy:{screen_name:handle,following:true,followed_by:handle==='later'}}};
    },
    checkMissingProfile:async()=>page,
    inspectProfile:async(api,target)=>{inspected.push(target.handle);return target;},
    sendUnfollow:async()=>{throw Error('must never unfollow in this fixture');}
  });
  return {runner,data,inspected,fetched,logs,patches,deleted,api};
}

for(const [name,response,code] of [
  ['empty HTTP 200 data (live failure)',{status:200,json:{data:{}}},'AUTO_UNFOLLOW_TARGET_MISSING'],
  ['null user',{status:200,json:{data:{user:{result:null}}}},'AUTO_UNFOLLOW_TARGET_MISSING'],
  ['different user ID',{status:200,json:{rest_id:'456',legacy:{screen_name:'missing'}}},'AUTO_UNFOLLOW_TARGET_MISMATCH'],
  ['known unavailable',Object.assign(Error('此账号不存在'),{code:'X_PROFILE_UNAVAILABLE'}),'X_PROFILE_UNAVAILABLE'],
  ['identity unresolved',Object.assign(Error('身份待核实'),{code:'X_PROFILE_IDENTITY_UNRESOLVED'}),'X_PROFILE_IDENTITY_UNRESOLVED']
])test(`${name}: defer target, inspect next, preserve relationship/history and quota`,async()=>{
  const f=setup(response),result=await f.runner.run();
  assert.equal(result.error,undefined);
  assert.equal(result.attempted,0);
  assert.deepEqual(f.inspected,['later']);
  const state=f.data.autoUnfollowState.accounts['999'];
  assert.deepEqual(state.queue,['missing']);
  assert.equal(state.used,0);
  assert.equal(state.pending,null);
  assert.ok(f.patches.every(p=>p.expectedHandle!=='missing'));
  const skipped=f.logs.find(e=>e.result==='skipped'&&e.handle==='missing');
  assert.equal(skipped.details['错误代码'],code);
  assert.equal(skipped.details['本地账号ID'],'123');
  assert.equal(skipped.details['实时账号ID'],code.endsWith('MISMATCH')?'456':'未取得');
  assert.equal(f.logs.some(e=>e.result==='failed'),false);
});

for(const status of [0,401,429,503])test(`HTTP ${status} defers to the independently verified profile page`,async()=>{
  const f=setup({status,json:null});await f.runner.run();
  assert.equal(f.inspected.includes('missing'),true);
  assert.equal(f.logs.some(e=>/平台限流|自动调度已暂停/.test(e.summary||'')),false);
});

test('a known pending target with unavailable live identity is isolated while later targets continue',async()=>{
  const f=setup({status:200,json:{data:{}}},{pending:true});
  assert.equal((await f.runner.run()).error,undefined);
  assert.equal(f.data.autoUnfollowState.accounts['999'].pendingItems[0].user.handle,'missing');
  assert.deepEqual(f.inspected,['later']);
  assert.deepEqual(f.fetched,['missing','later']);
});

test('owner profile is never fetched; absent sidebar does not prevent target verification',async()=>{
 const f=setup({status:200,json:{data:{}}},{ownerId:'998'});
 f.api.scripting.executeScript=async()=>{throw Error('sidebar not mounted');};
 assert.equal((await f.runner.run()).error,undefined);
 assert.deepEqual(f.fetched,['missing','later']);assert.deepEqual(f.inspected,['later']);
});
test('no usable request tab reports the page problem without claiming owner mismatch',async()=>{
 const f=setup({status:200,json:{data:{}}});f.api.tabs.query=async()=>[{id:1,discarded:true}];
 assert.match((await f.runner.run()).error,/没有可用的 X 页面/);assert.deepEqual(f.fetched,[]);
});

for(const pending of [false,true])test(`explicit not-found removes local data and continues without quota use; pending=${pending}`,async()=>{
  const f=setup({status:200,json:{errors:[{code:50}]}},{pending,page:{status:'not_found',reason:'此账号不存在'}});
  const result=await f.runner.run();
  assert.equal(result.error,undefined);
  assert.deepEqual(f.deleted,['missing']);
  assert.deepEqual(f.inspected,['later']);
  const state=f.data.autoUnfollowState.accounts['999'];
  assert.deepEqual(state.pendingItems,[]);
  assert.ok(!state.queue.includes('missing'));
  assert.equal(state.used,0);
  assert.ok(f.logs.some(e=>e.handle==='missing' && /已清理本地记录/.test(e.summary) && e.result==='skipped'));
});

for(const page of [null,{pending:true},{status:'ok'},{status:'suspended'}])test(`API not-found alone cannot delete: ${JSON.stringify(page)}`,async()=>{
 const f=setup({status:200,json:{errors:[{code:50}]}},{page});
 await f.runner.run();assert.deepEqual(f.deleted,[]);
 assert.ok(f.data.autoUnfollowState.accounts['999'].queue.includes('missing'));
});

test('empty API response plus explicit page not-found is sufficient, but API failure plus page not-found is not',async()=>{
 const page={status:'not_found',reason:'This account doesn’t exist'};
 const gone=setup({status:200,json:{data:{}}},{page});
 await gone.runner.run();assert.deepEqual(gone.deleted,['missing']);
 for(const response of [{status:503,json:{}},{status:200,json:{errors:[{code:88}]}}]){
  const failed=setup(response,{page});await failed.runner.run();assert.deepEqual(failed.deleted,[]);
 }
});
