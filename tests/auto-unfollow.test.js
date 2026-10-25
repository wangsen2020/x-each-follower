import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutoUnfollow,eligibleAutoUnfollow,inUnfollowWindow,AUTO_UNFOLLOW_STATE,AUTO_UNFOLLOW_ALARM} from '../src/features/relationships/auto-unfollow.js';
const time=new Date(2026,9,23,12).getTime();
const base={autoUnfollow:true,autoUnfollowAccount:{id:'1',handle:'owner'},overdueDays:14,activeTimeStart:'09:00',activeTimeEnd:'21:00',autoUnfollowEvery:30,autoUnfollowJitter:5,batchLimit:20,dailyLimit:400,unfollowDelay:15,unfollowDelayJitter:5};
const user=(i=1)=>({id:String(i+10),handle:`test${i}`,status:'overdue',followedAt:new Date(time-15*86400000).toISOString(),relationship:{following:true,followedBy:false}});
function setup(options={}){
 const data={unreciprocatedSettings:{...base,...options.config}},sent=[],logs=[],reconciled=[],alarms=new Map(),done=new Set();
 const storage={get:async key=>structuredClone({[key]:data[key]}),set:async value=>Object.assign(data,structuredClone(value))};
 const deps={storage,alarms:{get:async k=>alarms.get(k),clear:async k=>alarms.delete(k),create:async(k,v)=>alarms.set(k,v)},normalize:x=>x,now:()=>time,random:()=>0.5,sleep:async()=>{},candidates:async()=>Array.from({length:5},(_,i)=>user(i)),profile:async u=>({...u,relationship:{following:!done.has(u.handle),followedBy:false}}),unfollow:async u=>{sent.push(u.handle);done.add(u.handle);return {status:200};},reconcile:async(u,v)=>reconciled.push([u,v]),log:async e=>logs.push(e),...options.deps};
 return {data,sent,logs,reconciled,alarms,deps,runner:createAutoUnfollow(deps)};
}
test('only expired known one-way following qualifies, with exemption and whitelist protection',()=>{
 assert.equal(eligibleAutoUnfollow(user(),base,time),true);
 for(const patch of [{exempt:true},{status:'mutual'},{status:'unknown'},{status:'unfollowed'},{followedAt:null},{followedAt:new Date(time).toISOString()},{relationship:{following:true,followedBy:null}},{relationship:{following:false,followedBy:false}},{accountAvailability:{status:'suspended'}},{accountAvailability:{status:'not_found'}}])assert.equal(eligibleAutoUnfollow({...user(),...patch},base,time),false,JSON.stringify(patch));
 assert.equal(eligibleAutoUnfollow(user(),{...base,whitelist:'other，@Test1'},time),false);
});
test('time window handles overnight and invalid clock values',()=>{
 assert.equal(inUnfollowWindow(base,time),true);
 assert.equal(inUnfollowWindow({...base,activeTimeStart:'22:00',activeTimeEnd:'08:00'},new Date(2026,9,23,23).getTime()),true);
 assert.equal(inUnfollowWindow({...base,activeTimeStart:'09:99'},time),false);
});
test('alarm can be enabled, preserved and cancelled',async()=>{
 const f=setup();await f.runner.schedule();assert.equal(f.alarms.get(AUTO_UNFOLLOW_ALARM).when,time+30*60000);
 f.data.unreciprocatedSettings.autoUnfollowEvery=10;await f.runner.schedule(true);assert.equal(f.alarms.get(AUTO_UNFOLLOW_ALARM).when,time+30*60000);
 f.data.unreciprocatedSettings.autoUnfollow=false;await f.runner.schedule();assert.equal(f.alarms.size,0);
});
test('batch and daily quotas survive restart and switching away and back',async()=>{
 const f=setup({config:{batchLimit:2,dailyLimit:3}});
 assert.equal((await f.runner.run()).completed,2);
 assert.equal((await createAutoUnfollow(f.deps).run()).completed,1);
 assert.equal((await f.runner.run()).skipped,'daily_limit');
 f.data.unreciprocatedSettings.autoUnfollowAccount={id:'2',handle:'owner2'};await f.runner.run();
 f.data.unreciprocatedSettings.autoUnfollowAccount={id:'1',handle:'owner'};
 assert.equal((await createAutoUnfollow(f.deps).run()).skipped,'daily_limit');
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,3);
});
test('live mutual relationship and unknown relationship never trigger unfollow',async()=>{
 for(const followedBy of [true,null]){
 const f=setup({deps:{profile:async u=>({...u,relationship:{following:true,followedBy}})}});await f.runner.run();assert.equal(f.sent.length,0);
 }
});
test('disabling during live lookup takes effect before mutation',async()=>{
 const f=setup();f.deps.profile=async u=>{f.data.unreciprocatedSettings.autoUnfollow=false;return u;};
 await createAutoUnfollow(f.deps).run();assert.equal(f.sent.length,0);
});
test('adding exemption during profile lookup takes effect before mutation',async()=>{
 const f=setup();let exempt=false;f.deps.refreshCandidate=async u=>({...u,exempt});f.deps.profile=async u=>{exempt=true;return u;};
 await createAutoUnfollow(f.deps).run();assert.equal(f.sent.length,0);
});
test('ambiguous request reserves quota and does not repeat on worker restart',async()=>{
 const f=setup();let calls=0;f.deps.unfollow=async()=>{calls++;throw new Error('network timeout');};
 const first=await createAutoUnfollow(f.deps).run();assert.match(first.error,/timeout/);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,1);
 const second=await createAutoUnfollow(f.deps).run();assert.match(second.error,/尚未确认/);assert.equal(calls,1);
});
test('pending success is reconciled after restart without resending',async()=>{
 const f=setup({config:{dailyLimit:1}});f.data[AUTO_UNFOLLOW_STATE]={accounts:{'1':{account:'1',day:'2026-10-23',used:1,pending:{user:user()}}}};
 f.deps.profile=async u=>({...u,relationship:{following:false,followedBy:false}});
 await createAutoUnfollow(f.deps).run();assert.equal(f.sent.length,0);assert.equal(f.reconciled.length,1);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].pending,null);
});
test('failed quota persistence or wrong account stops before network action',async()=>{
 for(const overrides of [{storage:{get:async key=>({[key]:key==='unreciprocatedSettings'?base:{}}),set:async()=>{throw new Error('disk');}}},{verifyAccount:async()=>{throw new Error('wrong account');}}]){
 const f=setup({deps:overrides});assert.ok((await f.runner.run()).error);assert.equal(f.sent.length,0);
 }
});

test('explicit rate limit stops the round but does not leave an ambiguous pending operation',async()=>{
 const f=setup();let count=0;f.deps.unfollow=async()=>{count++;return {status:429};};
 const result=await createAutoUnfollow(f.deps).run();assert.match(result.error,/429/);assert.equal(count,1);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].pending,null);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,1);
});

test('unfollow logs explain disabled window and skip categories',async()=>{
 const f=setup({config:{activeTimeStart:'01:00',activeTimeEnd:'02:00'}});await f.runner.run();assert.match(f.logs[0].summary,/执行时段/);assert.equal(f.logs[0].details['执行时段'],'01:00—02:00');
 const g=setup({deps:{candidates:async()=>[{...user(),exempt:true},{...user(2),followedAt:new Date(time).toISOString()}]}});await g.runner.run();const summary=g.logs.at(-1);assert.equal(summary.details['跳过原因统计']['已豁免'],1);assert.equal(summary.details['跳过原因统计']['尚未超过取关期限'],1);
});
test('unfollow failure records target, HTTP status and failing stage',async()=>{
 const f=setup({deps:{unfollow:async()=>({status:429})}});await f.runner.run();const failure=f.logs.at(-1);assert.equal(failure.details['HTTP状态'],429);assert.equal(failure.details['阶段'],'核对取关接口响应');assert.ok(failure.details['目标账号']);
});
