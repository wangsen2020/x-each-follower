import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutoUnfollow,eligibleAutoUnfollow,inUnfollowWindow,AUTO_UNFOLLOW_STATE,AUTO_UNFOLLOW_ALARM} from '../src/features/relationships/auto-unfollow.js';
const time=new Date(2026,9,23,12).getTime();
const base={autoUnfollow:true,autoUnfollowAccount:{id:'1',handle:'owner'},overdueDays:14,activeTimeStart:'09:00',activeTimeEnd:'21:00',autoUnfollowEvery:30,autoUnfollowJitter:5,batchLimit:20,dailyLimit:400,unfollowDelay:15,unfollowDelayJitter:5};
const user=(i=1)=>({id:String(i+10),handle:`test${i}`,status:'overdue',followedAt:new Date(time-15*86400000).toISOString(),relationship:{following:true,followedBy:false}});
function setup(options={}){
 let offset=0;
 const data={unreciprocatedSettings:{...base,...options.config}},sent=[],logs=[],reconciled=[],alarms=new Map(),done=new Set();
 const storage={get:async key=>structuredClone({[key]:data[key]}),set:async value=>Object.assign(data,structuredClone(value))};
 const deps={storage,alarms:{get:async k=>alarms.get(k),clear:async k=>alarms.delete(k),create:async(k,v)=>alarms.set(k,v)},normalize:x=>x,now:()=>time+offset,random:()=>0.5,sleep:async()=>{},candidates:async()=>Array.from({length:5},(_,i)=>user(i)),profile:async u=>({...u,relationship:{following:!done.has(u.handle),followedBy:false}}),unfollow:async u=>{sent.push(u.handle);done.add(u.handle);return {status:200};},reconcile:async(u,v)=>reconciled.push([u,v]),log:async e=>logs.push(e),...options.deps};
 return {data,sent,logs,reconciled,alarms,deps,advance:ms=>{offset+=ms;},runner:createAutoUnfollow(deps)};
}

test('missing target yields to a verified unfollow without consuming its quota',async()=>{
 const f=setup(),original=f.deps.profile;
 f.deps.profile=async u=>{if(u.handle==='test0')throw Object.assign(Error('empty profile'),{code:'AUTO_UNFOLLOW_TARGET_MISSING'});return original(u);};
 const result=await createAutoUnfollow(f.deps).run();
 assert.equal(result.completed,1);assert.equal(result.attempted,1);
 assert.deepEqual(f.sent,['test1']);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,1);
 assert.deepEqual(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue,['test2','test3','test4','test0']);
});

test('unresolved candidates rotate across rounds and never starve the sixth candidate',async()=>{
 const checked=[];
 const f=setup({deps:{candidates:async()=>Array.from({length:6},(_,i)=>user(i)),profile:async u=>{checked.push(u.handle);throw Object.assign(Error('empty profile'),{code:'AUTO_UNFOLLOW_TARGET_MISSING'});}}});
 await f.runner.run();
 assert.deepEqual(checked,['test0','test1','test2','test3','test4']);
 assert.deepEqual(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue,['test5','test0','test1','test2','test3','test4']);
 await createAutoUnfollow(f.deps).run();
 assert.equal(checked[5],'test5');
 assert.deepEqual(f.sent,[]);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,0);
});

test('five confirmed nonexistent accounts are deleted and the sixth is unfollowed in the same round',async()=>{
 const deleted=[],checked=[];
 const f=setup({deps:{candidates:async()=>Array.from({length:6},(_,i)=>user(i)),removeMissing:async u=>{deleted.push(u.handle);return {deleted:2};}}});
 const original=f.deps.profile;
 f.deps.profile=async u=>{checked.push(u.handle);if(u.handle!=='test5')throw Object.assign(Error('此账号不存在'),{code:'X_PROFILE_UNAVAILABLE',availability:'not_found',confirmedMissing:true});return original(u);};
 const result=await createAutoUnfollow(f.deps).run();
 assert.equal(result.completed,1);assert.equal(result.attempted,1);assert.equal(result.removed,5);
 assert.deepEqual(deleted,['test0','test1','test2','test3','test4']);
 assert.deepEqual(f.sent,['test5']);
 assert.equal(checked[5],'test5');
 assert.deepEqual(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue,[]);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,1);
});

test('empty eligible queue is waiting with a reason, never a zero-success operation',async()=>{
 const f=setup({deps:{candidates:async()=>[]}});
 await f.runner.run();
 assert.equal(f.logs.length,0);
 await f.runner.run();assert.equal(f.logs.length,0);
 assert.equal(f.logs.some(e=>e.result==='success'),false);
 assert.equal(f.sent.length,0);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].scheduler.reason,'暂无符合条件的取关账号');
});

test('all confirmed nonexistent candidates terminate the round without requests or quota; cleanup failure preserves target',async()=>{
 const gone=()=>{throw Object.assign(Error('gone'),{code:'X_PROFILE_UNAVAILABLE',availability:'not_found',confirmedMissing:true});};
 const f=setup({deps:{profile:gone,removeMissing:async()=>({deleted:1})}});
 const result=await f.runner.run();
 assert.equal(result.removed,5);assert.equal(result.attempted,0);
 assert.equal(f.logs.at(-1).result,'cleaned');assert.match(f.logs.at(-1).summary,/已清理不存在账号 5 个/);
 assert.doesNotMatch(f.logs.at(-1).summary,/成功 0|尝试 0/);
 assert.deepEqual(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue,[]);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,0);
 const broken=setup({deps:{profile:gone,removeMissing:async()=>{throw Error('write failed');}}});
 assert.match((await broken.runner.run()).error,/write failed/);
 assert.ok(broken.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue.includes('test0'));
});
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
test('one queued unfollow per round, daily quota and account state survive restart',async()=>{
 const f=setup({config:{batchLimit:20,dailyLimit:3}});
 assert.equal((await f.runner.run()).completed,1);
 assert.deepEqual(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue,['test1','test2','test3','test4']);
 assert.equal((await createAutoUnfollow(f.deps).run()).skipped,'interval');
 f.advance(31*60000);
 assert.equal((await createAutoUnfollow(f.deps).run()).completed,1);
 f.advance(31*60000);
 assert.equal((await createAutoUnfollow(f.deps).run()).completed,1);
 assert.equal((await f.runner.run()).skipped,'daily_limit');
 f.data.unreciprocatedSettings.autoUnfollowAccount={id:'2',handle:'owner2'};await f.runner.run();
 f.data.unreciprocatedSettings.autoUnfollowAccount={id:'1',handle:'owner'};
 assert.equal((await createAutoUnfollow(f.deps).run()).skipped,'daily_limit');
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,3);
 assert.deepEqual(f.sent.slice(0,3),['test0','test1','test2']);
});
test('legacy high daily setting is not silently capped at twelve while each round still sends one',async()=>{
 const f=setup({config:{batchLimit:50,dailyLimit:400},deps:{candidates:async()=>Array.from({length:15},(_,i)=>user(i))}});
 for(let i=0;i<13;i++){assert.equal((await f.runner.run()).attempted,1);f.advance(31*60000);}
 assert.equal(f.sent.length,13);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,13);
});
test('persisted queue order wins over a reordered candidate scan and stale entries are removed',async()=>{
 const f=setup({deps:{candidates:async()=>[user(1),user(2),user(3)]}});
 await f.runner.run();
 assert.deepEqual(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue,['test2','test3']);
 f.deps.candidates=async()=>[{...user(3),followedAt:new Date(time-30*86400000).toISOString()},user(2)];
 f.advance(31*60000);
 await createAutoUnfollow(f.deps).run();
 assert.deepEqual(f.sent,['test1','test2']);
 f.deps.candidates=async()=>[user(4)];
 f.advance(31*60000);
 await createAutoUnfollow(f.deps).run();
 assert.deepEqual(f.sent,['test1','test2','test4']);
 assert.deepEqual(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue,[]);
});
test('live mutual relationship and unknown relationship never trigger unfollow',async()=>{
 for(const followedBy of [true,null]){
 const f=setup({deps:{profile:async u=>({...u,relationship:{following:true,followedBy}})}});await f.runner.run();assert.equal(f.sent.length,0);
 }
});
test('a round checks no more than five live relationships before deferring the queue',async()=>{
 let checks=0;
 const f=setup({deps:{candidates:async()=>Array.from({length:12},(_,i)=>user(i)),profile:async u=>{checks++;return {...u,relationship:{following:true,followedBy:null}};}}});
 const result=await f.runner.run();
 assert.equal(result.attempted,0);
 assert.equal(checks,5);
 assert.equal(f.sent.length,0);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue.length,7);
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
 const second=await createAutoUnfollow(f.deps).run();assert.equal(second.skipped,'interval');assert.equal(calls,1);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].pendingItems[0].user.handle,'test0');
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
 const g=setup({deps:{candidates:async()=>[{...user(),exempt:true},{...user(2),followedAt:new Date(time).toISOString()}]}});await g.runner.run();assert.equal(g.logs.length,0);assert.equal(g.sent.length,0);assert.equal(g.data[AUTO_UNFOLLOW_STATE].accounts['1'].scheduler.reason,'暂无符合条件的取关账号');
});
test('unfollow failure records target, HTTP status and failing stage',async()=>{
 const f=setup({deps:{unfollow:async()=>({status:429})}});await f.runner.run();const failure=f.logs.at(-1);assert.equal(failure.details['操作状态'],429);assert.equal(failure.details['阶段'],'核对页面操作结果');assert.ok(failure.details['目标账号']);
});

test('failure summary and structured target contain the account and original reason',async()=>{
 const f=setup({deps:{unfollow:async()=>({status:409,attempted:false,error:'取关确认未通过'})}});
 await f.runner.run();const failure=f.logs.at(-1);
 assert.equal(failure.handle,'test0');assert.equal(failure.target.id,'10');
 assert.match(failure.summary,/@test0/);assert.match(failure.summary,/取关确认未通过/);
 assert.match(failure.details['错误原因'],/取关确认未通过/);
 assert.equal(failure.details['核验关系'],'我关注对方：是；对方关注我：否');
 assert.equal(failure.details['请求是否发出'],'未操作');
});

test('definite no-action releases only current quota and rotates blocked target for next round',async()=>{
 const f=setup();
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:7,queue:['test0','test1','test2','test3','test4']}}};
 const original=f.deps.unfollow;
 f.deps.unfollow=async u=>u.handle==='test0'?{status:409,attempted:false,error:'页面入口待确认'}:original(u);
 const runner=createAutoUnfollow(f.deps),first=await runner.run();
 assert.equal(first.attempted,0);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,7);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].pending,null);
 assert.deepEqual(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].queue,['test1','test2','test3','test4','test0']);
 assert.match(f.logs.at(-1).details['提交状态'],/释放本轮/);
 f.advance(31*60000);
 const second=await runner.run();
 assert.equal(second.completed,1);assert.deepEqual(f.sent,['test1']);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].used,8);
});

test('successful automatic unfollow writes account lists to the detail and round summary',async()=>{
 const f=setup();await f.runner.run();
 const success=f.logs.filter(l=>l.result==='success');
 assert.deepEqual(success.at(-1).unfollowedHandles,f.sent);
 assert.deepEqual(success.find(l=>l.handle===f.sent[0]).unfollowedHandles,f.sent);
});

test('rejected unfollow is never reported in a successful account list',async()=>{
 const f=setup({deps:{unfollow:async()=>({status:429})}});await f.runner.run();
 assert.equal(f.logs.some(l=>l.unfollowedHandles?.length),false);
});

test('scheduler never wakes before the hard request gap and moves outside-window alarms to opening',async()=>{
 const f=setup({config:{autoUnfollowEvery:30,autoUnfollowJitter:10},deps:{random:()=>0}});
 await f.runner.schedule();assert.equal(f.alarms.get(AUTO_UNFOLLOW_ALARM).when,time+20*60000);
 const night=new Date(2026,9,25,22,50).getTime();
 const n=setup({config:{activeTimeStart:'01:00',activeTimeEnd:'23:00'},deps:{now:()=>night,random:()=>0.5}});
 await n.runner.schedule();assert.equal(n.alarms.get(AUTO_UNFOLLOW_ALARM).when,new Date(2026,9,26,1).getTime());
});

test('unrelated settings saves preserve the due unfollow alarm',async()=>{
 const {autoUnfollowScheduleChanged}=await import('../src/features/relationships/auto-unfollow.js');
 const f=setup();await f.runner.schedule();const due=f.alarms.get(AUTO_UNFOLLOW_ALARM).when;
 for(let i=0;i<6;i++){
  f.advance(5*60000);const before={...f.data.unreciprocatedSettings};
  Object.assign(f.data.unreciprocatedSettings,{lastSummary:'comparison '+i,greetingText:'message '+i});
  await f.runner.schedule(!autoUnfollowScheduleChanged(before,f.data.unreciprocatedSettings));
  assert.equal(f.alarms.get(AUTO_UNFOLLOW_ALARM).when,due);
 }
 assert.equal(autoUnfollowScheduleChanged(base,{...base,autoUnfollowEvery:60}),true);
});

test('outside-window round makes no request and logs its next actionable time',async()=>{
 const t=new Date(2026,9,26,0,10).getTime();
 const f=setup({config:{activeTimeStart:'01:00',activeTimeEnd:'23:00'},deps:{now:()=>t}});
 const r=await f.runner.run();assert.equal(r.skipped,'disabled_or_outside_window');assert.equal(f.sent.length,0);
 assert.equal(f.alarms.get(AUTO_UNFOLLOW_ALARM).when,new Date(2026,9,26,1).getTime());
 assert.equal(f.logs.at(-1).details['下次计划时间'],new Date(2026,9,26,1).toISOString());
});

test('one-minute cadence executes one queued user per round and rejects earlier retries',async()=>{
 const f=setup({config:{autoUnfollowEvery:1,autoUnfollowJitter:0}});
 await f.runner.schedule();assert.equal(f.alarms.get(AUTO_UNFOLLOW_ALARM).when,time+60000);
 assert.equal((await f.runner.run()).completed,1);
 f.advance(59000);assert.equal((await f.runner.run()).skipped,'interval');
 f.advance(1000);assert.equal((await f.runner.run()).completed,1);
 assert.deepEqual(f.sent,['test0','test1']);
});

test('negative jitter cannot schedule a one-minute cadence earlier than its minimum',async()=>{
 const f=setup({config:{autoUnfollowEvery:1,autoUnfollowJitter:3},deps:{random:()=>0}});
 await f.runner.schedule();assert.equal(f.alarms.get(AUTO_UNFOLLOW_ALARM).when,time+60000);
});

test('one successful action produces exactly one success card for its round',async()=>{const f=setup();await f.runner.run();assert.equal(f.sent.length,1);const success=f.logs.filter(e=>e.result==='success');assert.equal(success.length,1);assert.equal(success[0].handle,f.sent[0]);assert.equal(success[0].details['排队人数'],4);});

test('live follower is never unfollowed and mutual relation is reconciled',async()=>{const f=setup({deps:{profile:async u=>({...u,relationship:{following:true,followedBy:true}})}});await f.runner.run();assert.equal(f.sent.length,0);assert.equal(f.reconciled.length,5);assert.ok(f.reconciled.every(([,v])=>v.relationship.followedBy===true));});
test('live followback is performed once, confirmed, and reconciled instead of unfollow',async()=>{let followed=false,count=0;const f=setup({deps:{profile:async u=>({...u,relationship:{following:followed,followedBy:true}}),followback:async()=>{count++;followed=true;return {status:200,attempted:true};}}});await f.runner.run();assert.equal(f.sent.length,0);assert.equal(count,1);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].pending,null);assert.equal(f.reconciled.at(-1)[1].relationship.following,true);});
test('ambiguous followback protects its target while later targets can proceed',async()=>{const handles=[];const f=setup({deps:{profile:async u=>({...u,relationship:{following:false,followedBy:true}}),followback:async u=>{handles.push(u.handle);return {status:0,attempted:true};}}});await f.runner.run();f.advance(60000);await f.runner.run();assert.deepEqual(handles,['test0','test1']);assert.equal(f.sent.length,0);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].pendingItems[0].kind,'followback');});

test('legacy unresolved target survives restart without blocking unrelated unfollows or refunding quota',async()=>{
 const f=setup();f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:5,pending:{user:user(0),at:time-120000},queue:['test0','test1','test2']}}};
 assert.equal((await f.runner.run()).completed,1);assert.deepEqual(f.sent,['test1']);
 f.advance(60000);assert.equal((await createAutoUnfollow(f.deps).run()).completed,1);assert.deepEqual(f.sent,['test1','test2']);
 const state=f.data[AUTO_UNFOLLOW_STATE].accounts['1'];assert.equal(state.used,7);assert.equal(state.pendingItems.length,1);assert.equal(state.pendingItems[0].user.handle,'test0');
});
test('pending identity is protected by both ID and handle across renames',async()=>{
 const f=setup({deps:{candidates:async()=>[{...user(0),handle:'renamed'},{...user(0),id:'999'},user(1)]}});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:1,pending:{user:user(0)}}}};
 await f.runner.run();assert.deepEqual(f.sent,['test1']);
});
test('automatic pending rechecks stop at three and ordinary manual review never submits',async()=>{
 let checks=0,confirmed=false;
 const f=setup({deps:{candidates:async()=>[],profile:async u=>{checks++;return {...u,relationship:{following:!confirmed,followedBy:false}};}}});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:1,pending:{user:user(0)}}}};
 for(let i=0;i<5;i++){await createAutoUnfollow(f.deps).run();f.advance(10*60000);}
 assert.equal(checks,3);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].pendingItems[0].checks,3);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].reviewItems[0].status,'review');
 confirmed=true;await createAutoUnfollow(f.deps).run({reviewHandle:'test0'});
 assert.equal(checks,4);assert.deepEqual(f.sent,[]);assert.equal(f.reconciled.length,1);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].pendingItems.length,0);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].reviewItems.length,0);
});
test('manual review with an unknown target cannot execute ordinary queued actions',async()=>{
 const f=setup();await f.runner.run({reviewHandle:'missing'});assert.deepEqual(f.sent,[]);
});
test('global failures during pending verification preserve the record and pause the round',async()=>{
 for(const status of [401,429,503]){
 const f=setup({deps:{profile:async()=>{throw Object.assign(Error('HTTP failure'),{status});}}});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:1,pending:{user:user(0)}}}};
 assert.ok((await f.runner.run()).error);assert.deepEqual(f.sent,[]);
 const state=f.data[AUTO_UNFOLLOW_STATE].accounts['1'];assert.equal(state.pendingItems.length,1);assert.equal(state.scheduler.phase,'paused');
 }
});
test('unidentifiable historical pending record fails closed instead of losing protection',async()=>{
 const f=setup();f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:1,pending:{user:{}}}}};
 assert.match((await f.runner.run()).error,/缺少目标账号/);assert.deepEqual(f.sent,[]);
});
test('multiple unresolved accounts survive new ambiguous operations and restart',async()=>{
 const attempts=[];const f=setup({deps:{unfollow:async u=>{attempts.push(u.handle);return {status:0,attempted:true};}}});
 for(let i=0;i<3;i++){await createAutoUnfollow(f.deps).run();f.advance(60000);}
 assert.deepEqual(attempts,['test0','test1','test2']);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts['1'].pendingItems.length,3);
});
test('pending isolation cannot bypass daily limits or a disabled setting',async()=>{
 const f=setup({config:{dailyLimit:1}});f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:1,pending:{user:user(0)}}}};
 assert.equal((await f.runner.run()).skipped,'daily_limit');assert.deepEqual(f.sent,[]);
 f.data.unreciprocatedSettings.autoUnfollow=false;assert.equal((await f.runner.run()).skipped,'disabled_or_outside_window');assert.deepEqual(f.sent,[]);
});
test('an alarm arriving during an active round preserves the next alarm without starting a second action',async()=>{
 const f=setup(),original=f.deps.profile;let release,firstRead=true;
 f.deps.profile=async u=>{if(firstRead){firstRead=false;await new Promise(resolve=>{release=resolve;});}return original(u);};
 const runner=createAutoUnfollow(f.deps),first=runner.run();await new Promise(resolve=>setImmediate(resolve));
 f.alarms.clear();assert.equal((await runner.run()).skipped,'running');assert.ok(f.alarms.has(AUTO_UNFOLLOW_ALARM));assert.deepEqual(f.sent,[]);
 release();await first;assert.deepEqual(f.sent,['test0']);
});

test('explicit recovery requires aged dual proof and only requeues, preserving historic quota',async()=>{
 const f=setup({deps:{profile:async u=>({...u,evidence:{page:{ready:true,following:true},api:{following:true}}})}});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:5,pending:{user:user(0),at:time-3600000},queue:[]}}};
 await f.runner.run({reviewHandle:'test0'});assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].pendingItems.length,1);
 await f.runner.run({reviewHandle:'test0',retryConfirmed:true});
 const state=f.data[AUTO_UNFOLLOW_STATE].accounts[1];assert.equal(state.pendingItems.length,0);assert.deepEqual(state.queue,['test0']);assert.equal(state.used,5);assert.deepEqual(f.sent,[]);
});
for(const scenario of ['young','noProof','disagreement','protected'])test(`recovery refuses ${scenario}`,async()=>{
 const f=setup({deps:{profile:async u=>({...u,evidence:scenario==='noProof'?null:{page:{ready:true,following:true},api:{following:scenario!=='disagreement'}}}),refreshCandidate:async u=>({...u,exempt:scenario==='protected'})}});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:5,pending:{user:user(0),at:time-(scenario==='young'?1000:3600000)},queue:[]}}};
 await f.runner.run({reviewHandle:'test0',retryConfirmed:true});assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].pendingItems.length,1);assert.deepEqual(f.sent,[]);
});
test('submission checkpoints are durable before external action and retain rejection diagnostics',async()=>{
 const f=setup();f.deps.unfollow=async(u,cfg,{beforeSubmit})=>{assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].pending.phase,'reserved');await beforeSubmit();assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].pending.phase,'submitting');return {status:0,attempted:true,error:'connection lost'};};
 await createAutoUnfollow(f.deps).run();const p=f.data[AUTO_UNFOLLOW_STATE].accounts[1].pendingItems[0];assert.equal(p.phase,'responded');assert.equal(p.response.error,'connection lost');
});

test('a proven pre-submit interruption can recover without permission to retry an unknown submission',async()=>{
 for(const phase of ['reserved','submitting']){
 const f=setup({deps:{profile:async u=>({...u,evidence:{page:{ready:true,following:true},api:{following:true}}})}});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:1,pending:{user:user(0),phase,at:time-3600000},queue:[]}}};
 await f.runner.run({reviewHandle:'test0'});
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].pendingItems.length,phase==='reserved'?0:1);assert.deepEqual(f.sent,[]);
 }
});

for(const phase of [undefined,'reserved','submitting','responded'])test(`automatic dual verification restores ${phase||'legacy'} pending and completes one unfollow`,async()=>{
 const f=setup();const original=f.deps.profile;
 f.deps.profile=async u=>{const live=await original(u);return {...live,evidence:{page:{ready:true,following:live.relationship.following},api:{following:live.relationship.following}}};};
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:5,pending:{user:user(0),phase,at:time-3600000,checks:1},queue:[]}}};
 const result=await createAutoUnfollow(f.deps).run();assert.equal(result.completed,1);assert.deepEqual(f.sent,['test0']);
 const state=f.data[AUTO_UNFOLLOW_STATE].accounts[1];assert.equal(state.pendingItems.length,0);assert.equal(state.used,6);
});
for(const scenario of ['young','noProof','disagreement','protected'])test(`automatic recovery refuses ${scenario} and proceeds with other accounts`,async()=>{
 const f=setup();const original=f.deps.profile;
 f.deps.profile=async u=>{const live=await original(u);return {...live,evidence:scenario==='noProof'?null:{page:{ready:true,following:live.relationship.following},api:{following:scenario==='disagreement'?false:live.relationship.following}}};};
 f.deps.refreshCandidate=async u=>({...u,exempt:u.handle==='test0'&&scenario==='protected'});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:5,pending:{user:user(0),at:time-(scenario==='young'?1000:3600000),checks:8},queue:[]}}};
 await createAutoUnfollow(f.deps).run();assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].pendingItems.length,1);assert.deepEqual(f.sent,['test1']);
});
test('pending checks select oldest due target so repeated failures do not starve later targets',async()=>{
 const seen=[];const f=setup({deps:{candidates:async()=>[],profile:async u=>{seen.push(u.handle);return u;}}});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:1,pendingItems:[{user:user(0),checks:1,nextCheckAt:time-100},{user:user(1),checks:2,nextCheckAt:time-200}]}}};
 await f.runner.run();await f.runner.run();assert.deepEqual(seen,['test1','test0']);
});

test('preflight failure budget survives 20 rounds and worker restarts, then manual retry grants one new budget',async()=>{
 let calls=0;
 const f=setup({deps:{candidates:async()=>[user(0)],profile:async()=>{calls++;throw Object.assign(Error('主页入口待核实'),{code:'X_PROFILE_ACTION_UNAVAILABLE'});}}});
 for(let i=0;i<20;i++){await createAutoUnfollow(f.deps).run();f.advance(600000);}
 assert.equal(calls,3);let s=f.data[AUTO_UNFOLLOW_STATE].accounts[1];
 assert.equal(s.reviewItems[0].status,'review');assert.equal(s.reviewItems[0].attempts,3);assert.deepEqual(s.queue,[]);assert.equal(s.used,0);
 const entry=s.reviewItems[0];
 await createAutoUnfollow(f.deps).review({action:'retry',accountId:'1',handle:entry.user.handle,targetId:entry.user.id,updatedAt:entry.updatedAt});
 assert.equal(calls,3); // A button never performs an X write or even a profile request.
 await createAutoUnfollow(f.deps).run();assert.equal(calls,4);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems[0].attempts,1);
});

test('blocked targets enter review immediately while a later valid target completes in the same round',async()=>{
 const f=setup(),original=f.deps.profile;
 f.deps.profile=async u=>{if(u.handle==='test0')throw Object.assign(Error('当前账号已屏蔽该用户'),{code:'X_PROFILE_BLOCKED'});return original(u);};
 const r=await createAutoUnfollow(f.deps).run();assert.equal(r.completed,1);assert.deepEqual(f.sent,['test1']);
 const s=f.data[AUTO_UNFOLLOW_STATE].accounts[1];assert.equal(s.reviewItems[0].attempts,1);assert.equal(s.reviewItems[0].status,'review');
 assert.equal(s.queue.includes('test0'),false);assert.match(s.reviewItems[0].reason,/屏蔽/);
});

test('skip persists through fresh scans, renamed handles and restarts, and remains isolated by owner and stable target ID',async()=>{
 const f=setup({deps:{candidates:async()=>[user(0)]}});let calls=0;
 f.deps.profile=async()=>{calls++;throw Object.assign(Error('屏蔽'),{code:'X_PROFILE_BLOCKED'});};
 await createAutoUnfollow(f.deps).run();const entry=f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems[0];
 await createAutoUnfollow(f.deps).review({action:'skip',accountId:'1',handle:entry.user.handle,targetId:entry.user.id,updatedAt:entry.updatedAt});
 f.deps.candidates=async()=>[{...user(0),handle:'renamed'}];
 for(let i=0;i<5;i++)await createAutoUnfollow(f.deps).run();assert.equal(calls,1);
 f.data.unreciprocatedSettings.autoUnfollowAccount={id:'2',handle:'other'};await createAutoUnfollow(f.deps).run();assert.equal(calls,2);
 f.data.unreciprocatedSettings.autoUnfollowAccount={id:'1',handle:'owner'};
 f.deps.candidates=async()=>[{...user(0),id:'999'}];await createAutoUnfollow(f.deps).run();assert.equal(calls,3);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems.find(x=>x.user.id===user(0).id).status,'skipped');
});

test('local deletion must complete before clearing review; failure preserves it and success permits later re-entry',async()=>{
 let fail=true,deleted=0,calls=0;
 const f=setup({deps:{candidates:async()=>[user(0)],profile:async()=>{calls++;throw Object.assign(Error('屏蔽'),{code:'X_PROFILE_BLOCKED'});},removeLocal:async()=>{if(fail)throw Error('disk error');deleted++;}}});
 await f.runner.run();const entry=f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems[0];
 const request={action:'delete',accountId:'1',handle:entry.user.handle,targetId:entry.user.id,updatedAt:entry.updatedAt};
 await assert.rejects(createAutoUnfollow(f.deps).review(request),/disk error/);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems.length,1);
 fail=false;await createAutoUnfollow(f.deps).review(request);assert.equal(deleted,1);assert.deepEqual(f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems,[]);
 await createAutoUnfollow(f.deps).run();assert.equal(calls,2);assert.deepEqual(f.sent,[]);
});

test('stale or wrong-owner review commands cannot affect another record',async()=>{
 const f=setup({deps:{profile:async()=>{throw Object.assign(Error('屏蔽'),{code:'X_PROFILE_BLOCKED'});}}});await f.runner.run();
 const entry=f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems[0];
 const request={action:'skip',accountId:'1',handle:entry.user.handle,targetId:entry.user.id,updatedAt:entry.updatedAt};
 for(const patch of [{accountId:'other'},{targetId:'999'},{updatedAt:entry.updatedAt-1},{action:'bogus'}])await assert.rejects(createAutoUnfollow(f.deps).review({...request,...patch}));
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems[0].status,'review');
});

test('legacy pending checks beyond the cap go directly to review; retry only resets read-only verification',async()=>{
 let calls=0;const f=setup({deps:{candidates:async()=>[],profile:async u=>{calls++;return u;}}});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',day:'2026-10-23',used:5,pending:{user:user(0),checks:385,phase:'submitting'}}}};
 await createAutoUnfollow(f.deps).run();assert.equal(calls,0);
 let state=f.data[AUTO_UNFOLLOW_STATE].accounts[1],entry=state.reviewItems[0];assert.equal(entry.pending,true);assert.equal(state.used,5);
 await createAutoUnfollow(f.deps).review({action:'retry',accountId:'1',handle:entry.user.handle,targetId:entry.user.id,updatedAt:entry.updatedAt});
 state=f.data[AUTO_UNFOLLOW_STATE].accounts[1];assert.equal(state.pendingItems[0].phase,'submitting');assert.equal(state.pendingItems[0].checks,0);assert.equal(state.used,5);
 await createAutoUnfollow(f.deps).run();assert.equal(calls,1);assert.deepEqual(f.sent,[]);
});

test('worker interruption after reserving the last check cannot reopen a fourth page',async()=>{
 let calls=0;const f=setup({deps:{candidates:async()=>[user(0)],profile:async()=>{calls++;throw Error('should not open');}}});
 f.data[AUTO_UNFOLLOW_STATE]={accounts:{1:{account:'1',queue:['test0'],reviewItems:[{user:user(0),status:'retry',attempts:3,updatedAt:time}]}}};
 await f.runner.run();assert.equal(calls,0);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems[0].status,'review');
});

test('configured cap applies to unknown live relationships and can be saved without altering the default',async()=>{
 let calls=0;const f=setup({config:{autoUnfollowMaxAttempts:2},deps:{candidates:async()=>[user(0)],profile:async u=>{calls++;return {...u,relationship:{following:true,followedBy:null}};}}});
 for(let i=0;i<6;i++)await createAutoUnfollow(f.deps).run();assert.equal(calls,2);
 assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems[0].status,'review');assert.deepEqual(f.sent,[]);
});

test('a definite no-action failure cannot reset its budget merely because the preliminary profile lookup succeeded',async()=>{
 let calls=0;const f=setup({deps:{candidates:async()=>[user(0)],unfollow:async()=>{calls++;return {status:409,attempted:false,error:'入口无法确认'};}}});
 for(let i=0;i<7;i++){await createAutoUnfollow(f.deps).run();f.advance(600000);}
 assert.equal(calls,3);assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].reviewItems[0].status,'review');assert.equal(f.data[AUTO_UNFOLLOW_STATE].accounts[1].used,0);
});

test('global collection cooling keeps the candidate queued without consuming its profile retries',async()=>{
 const f=setup({deps:{profile:async()=>{throw Object.assign(Error('cooldown'),{code:'X_ACCESS_DEFERRED',retryAt:Date.now()+900000})}}});
 const result=await f.runner.run();assert.equal(result.deferred,true);assert.equal(f.sent.length,0);
 const state=f.data[AUTO_UNFOLLOW_STATE].accounts['1'];assert.equal(state.scheduler.phase,'waiting');
 assert.ok(state.queue.includes('test0'));assert.equal(state.reviewItems.find(r=>r.user?.handle==='test0')?.attempts||0,0);
});
