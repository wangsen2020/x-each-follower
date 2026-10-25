import test from 'node:test';import assert from 'node:assert/strict';
import {createGreetingLedger,greetingWasClaimed} from '../src/features/relationships/greeting-ledger.js';
import {createAutoGreeting,AUTO_GREETING_ALARM} from '../src/features/relationships/auto-greeting.js';
import {greetingDue} from '../src/features/relationships/greeting-chat.js';
const time=Date.parse('2026-10-24T12:00:00Z');
function fixture(){
 const data={unreciprocatedSettings:{autoGreeting:true,autoGreetingAccount:{id:'1',handle:'owner'},greetingAfterDays:1}},logs=[],alarms=new Map();
 const storage={get:async key=>structuredClone({[key]:data[key]}),set:async value=>Object.assign(data,structuredClone(value))};
 const ledger=createGreetingLedger({storage,now:()=>time});
 const user={id:'2',handle:'recipient',status:'pending',followedAt:new Date(time-6*86400000).toISOString(),relationship:{following:true,followedBy:false}};
 const calls=[];const deps={storage,alarms:{get:async k=>alarms.get(k),clear:async k=>alarms.delete(k),create:async(k,v)=>alarms.set(k,v)},ledger,now:()=>time,candidates:async()=>[user],refresh:async()=>user,owner:async x=>x,profile:async x=>x,send:async(u,t,a,c,before)=>{await before();calls.push(t.id);return {ok:true,messageId:'message1'};},log:async x=>logs.push(x)};
 return {data,storage,ledger,user,deps,calls,logs,alarms,run:()=>createAutoGreeting(deps).run()};
}
test('due means at least configured age, not the second-day window; overdue and legacy dates qualify',()=>{
 const f=fixture();assert.equal(greetingDue(f.user,1,time),true);assert.equal(greetingDue({...f.user,status:'overdue'},1,time),true);
 assert.equal(greetingDue({...f.user,followedAt:new Date(time-86399999).toISOString()},1,time),false);
 assert.equal(greetingDue({...f.user,status:'mutual'},1,time),false);
 for(const status of ['suspended','not_found'])assert.equal(greetingDue({...f.user,accountAvailability:{status}},1,time),false);
});
test('sent reminders are persistent and restart and renamed handles never resend',async()=>{
 const f=fixture();assert.equal((await f.run()).sent,1);f.user.handle='renamed';assert.equal((await f.run()).sent,0);assert.equal(f.calls.length,1);
 assert.ok(f.logs.some(l=>l.source==='greeting-auto'&&l.result==='sent'));
});
test('manual sends and ambiguous historical sends prevent automatic reminders',async()=>{
 for(const status of ['sent','uncertain']){const f=fixture();f.data['firstGreeting:1:2']={status};await f.run();assert.equal(f.calls.length,0);}
});
test('mutual, unfollowed, unavailable and fresh records are never sent',async()=>{
 for(const patch of [{status:'mutual'},{status:'unfollowed'},{accountAvailability:{status:'suspended'}},{accountAvailability:{status:'not_found'}},{followedAt:new Date(time).toISOString()}]){const f=fixture();Object.assign(f.user,patch);await f.run();assert.equal(f.calls.length,0);}
});
test('live followback before sending and disabling while chat opens both cancel sends',async()=>{
 const f=fixture();f.deps.profile=async u=>({...u,relationship:{following:true,followedBy:true}});await f.run();assert.equal(f.calls.length,0);
 const g=fixture();g.deps.send=async(u,t,a,c,before)=>{g.data.unreciprocatedSettings.autoGreeting=false;await before();g.calls.push('bad');};await g.run();assert.equal(g.calls.length,0);
});
test('ambiguous outcome locks the recipient across worker restart',async()=>{
 const f=fixture();f.deps.send=async(u,t,a,c,before)=>{await before();f.calls.push(t.id);return {ok:false,submitted:true,reason:'lost receipt'};};
 assert.equal((await f.run()).uncertain,1);await f.run();assert.equal(f.calls.length,1);assert.equal(greetingWasClaimed(await f.ledger.read('1','2')),true);
});
test('interrupted worker after claim cannot resend and cannot silently lose prior successful reminder',async()=>{
 const f=fixture();const claim=await f.ledger.claim({ownerId:'1',targetId:'2',handle:'recipient',once:true});assert.equal(claim.ok,true);await f.run();assert.equal(f.calls.length,0);
 const manual=await f.ledger.claim({ownerId:'1',targetId:'2',handle:'recipient'});await f.ledger.finish({ownerId:'1',targetId:'2',token:manual.token,status:'not_sent'});assert.equal(greetingWasClaimed(await f.ledger.read('1','2')),true);
});
test('concurrent claims allow only one winner and disk failure prevents submission',async()=>{
 const f=fixture();const results=await Promise.all([f.ledger.claim({ownerId:'1',targetId:'2',once:true}),f.ledger.claim({ownerId:'1',targetId:'2',once:true})]);assert.equal(results.filter(r=>r.ok).length,1);
 const g=fixture();g.deps.ledger=createGreetingLedger({storage:g.storage,write:async()=>{throw new Error('disk failure');}});await g.run();assert.equal(g.calls.length,0);
});
test('known unsent failures cool down without starving later eligible users',async()=>{
 const f=fixture();f.data['autoGreetingRetry:1:2']=time+3600000;const other={...f.user,id:'3',handle:'other'};f.deps.candidates=async()=>[f.user,other];f.deps.refresh=async u=>u;await f.run();assert.deepEqual(f.calls,['3']);
});
test('automatic reminder alarm is independent from local comparison and cancels on disable',async()=>{
 const f=fixture(),runner=createAutoGreeting(f.deps);await runner.schedule();assert.equal(f.alarms.get(AUTO_GREETING_ALARM).periodInMinutes,5);f.data.unreciprocatedSettings.autoGreeting=false;await runner.schedule();assert.equal(f.alarms.size,0);
});

test('message results have distinct labels rather than being mistaken for failed comparison',async()=>{
 const {followbackLogPresentation:label}=await import('../src/features/relationships/followback-log.js');
 assert.deepEqual(label({source:'greeting-auto',result:'sent'}),{source:'自动私信',label:'发送成功 ✓',tone:'candidate'});
 assert.match(label({source:'greeting-auto',result:'uncertain'}).label,/不重发/);
 assert.equal(label({source:'alarm',result:'success'}).source,'定时检测');
});

test('summary groups skip reasons and links all events to one run',async()=>{
 const f=fixture();f.deps.candidates=async()=>[{...f.user,status:'mutual'}, {...f.user,id:'3',handle:'fresh',followedAt:new Date(time).toISOString()}, {...f.user,id:'4',handle:'gone',accountAvailability:{status:'not_found'}}, f.user];
 await f.run();const summary=f.logs.find(l=>l.source==='greeting-auto-summary');assert.equal(summary.details['跳过原因统计']['已经回关'],1);assert.equal(summary.details['跳过原因统计']['未到提醒时间'],1);assert.equal(summary.details['跳过原因统计']['账号不存在'],1);assert.ok(f.logs.every(l=>l.runId===summary.runId));assert.equal(f.calls.length,1);
});
test('failed delivery records stage, submission state, chat diagnostics and retry rule',async()=>{
 const f=fixture();f.deps.send=async()=>({ok:false,submitted:false,reason:'sender unavailable',diagnostics:{code:'CHAT_SENDER_NOT_FOUND',matchedMethods:0}});
 await f.run();const failure=f.logs.find(l=>l.result==='failed');assert.equal(failure.details['提交状态'],'未提交');assert.equal(failure.details['聊天诊断'].code,'CHAT_SENDER_NOT_FOUND');assert.match(failure.details['重试策略'],/一小时/);assert.equal(failure.details['阶段'],'打开聊天并准备发送');
});
