import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundAutoUnfollow} from '../src/features/relationships/auto-unfollow-adapter.js';

const time=new Date(2026,9,26,12).getTime();
function setup(response, {pending=false,ownerId='999'}={}) {
  const users=['missing','later'].map((handle,i)=>({handle,id:String(123+i),status:'overdue',followedAt:'2026-09-01T00:00:00Z',relationship:{following:true,followedBy:false}}));
  const state={account:'999',day:'2026-10-26',used:0,queue:['missing','later'],pending:pending?{user:users[0],at:time}:null};
  const data={unreciprocatedSettings:{autoUnfollow:true,autoUnfollowAccount:{id:'999',handle:'owner'},overdueDays:7,dailyLimit:100,autoUnfollowEvery:3,activeTimeStart:'00:00',activeTimeEnd:'00:00'},autoUnfollowState:{accounts:{999:state}}};
  const inspected=[],fetched=[],logs=[],patches=[];
  const api={storage:{local:{get:async k=>structuredClone({[k]:data[k]}),set:async v=>Object.assign(data,structuredClone(v))}},alarms:{create:async()=>{},clear:async()=>{}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:{handle:'owner'}}]}};
  const service={summary:async()=>({}),sourcePage:async({sourceKey})=>({records:sourceKey==='unreciprocatedTracker'?users.map(payload=>({accountId:'unassigned',module:'unreciprocated',payload})):[],nextCursor:null}),lookupAll:async({handle})=>[{module:'unreciprocated',userKey:handle,payload:users.find(u=>u.handle===handle)}]};
  const runner=createBackgroundAutoUnfollow({api,service,records:{ready:async()=>{},patch:async p=>patches.push(p)},normalize:x=>x,now:()=>time,writeLog:async e=>logs.push(e),
    fetchProfile:async(tab,handle)=>{
      fetched.push(handle);
      if(handle==='missing'){if(response instanceof Error)throw response;return response;}
      return {status:200,json:{rest_id:handle==='owner'?ownerId:'124',legacy:{screen_name:handle,following:true,followed_by:handle==='later'}}};
    },
    inspectProfile:async(api,target)=>{inspected.push(target.handle);return target;},
    sendUnfollow:async()=>{throw Error('must never unfollow in this fixture');}
  });
  return {runner,data,inspected,fetched,logs,patches};
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

for(const status of [0,401,429,503])test(`HTTP ${status} still stops round`,async()=>{
  const f=setup({status,json:null});const result=await f.runner.run();
  assert.match(result.error,/账号核验失败/);
  assert.deepEqual(f.fetched,['owner','missing']);
  assert.deepEqual(f.data.autoUnfollowState.accounts['999'].queue,['missing','later']);
});

test('a pending action with missing identity still blocks all further actions',async()=>{
  const f=setup({status:200,json:{data:{}}},{pending:true});
  assert.match((await f.runner.run()).error,/身份待核实/);
  assert.ok(f.data.autoUnfollowState.accounts['999'].pending);
  assert.deepEqual(f.inspected,[]);
  assert.deepEqual(f.fetched,['owner','missing']);
});

test('owner mismatch stops before candidate checks',async()=>{
  const f=setup({status:200,json:{data:{}}},{ownerId:'998'});
  assert.match((await f.runner.run()).error,/绑定账号身份不一致/);
  assert.deepEqual(f.fetched,['owner']);
});
