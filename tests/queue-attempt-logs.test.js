import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeQueueExecutionLog} from '../src/shared/execution-log.js';
import {createQueueDiagnostics} from '../src/features/follow-queue/queue-diagnostics.js';
import {pageFailureMessage,capturePageFailure} from '../src/platform/page-failure.js';

test('successful logs never fall back to a previous failure, including stored historical detail',()=>{
  const previous='用户资料接口限流，未发送关注请求；稍后重试。';
  const historic={type:'job-complete',scope:'queue',result:'followed',reason:'',detail:previous,
    followResult:{succeeded:true,reason:previous}};
  const view=normalizeQueueExecutionLog(historic,{},historic);
  assert.equal(view.detail,'关注成功。');
  assert.equal(historic.detail,previous,'raw historical evidence is preserved');
  assert.equal(normalizeQueueExecutionLog({type:'job-complete',state:'followed',reason:'评论未完成'},
    {followResult:{succeeded:true,reason:previous}}).detail,'评论未完成');
  assert.equal(normalizeQueueExecutionLog({...historic,result:'retry'}).detail,previous);
});

test('historical X follow limit logs render a clear message and preserve the stored evidence',()=>{
  const raw="You are unable to follow more people at this time. Learn more <a href='http://support.twitter.com/articles/66885-i-can-t-follow-people-follow-limits'>here</a>.";
  const old={type:'job-complete',scope:'queue',state:'uncertain',reason:raw,detail:`${raw} 普通来源，按普通候选筛选`,
    followResult:{relationshipDecision:{reason:'普通来源，按普通候选筛选',following:false,followedBy:false}}};
  const displayed=normalizeQueueExecutionLog(old,{},old);
  assert.match(displayed.detail,/X 拒绝继续关注/);
  assert.match(displayed.detail,/普通来源/);
  assert.doesNotMatch(displayed.detail,/<a|Learn more|You are unable/i);
  assert.doesNotMatch(displayed.reason,/<a|Learn more|You are unable/i);
  assert.equal(old.reason,raw);
});

test('new attempt logs cannot inherit previous errors, diagnostics or scan timing',()=>{
  const old={diagnostic:{id:'old',runId:'same-run'},posts:[{text:'old'}],finishedAt:'old',scrollRounds:5};
  const result=normalizeQueueExecutionLog({type:'job-start',runId:'same-run',jobId:'job'},
    {handle:'target',followResult:{reason:'previous timeout'},evaluations:[{status:'failed'}]},old);
  assert.equal(result.detail,'开始访问主页并读取账号资料');
  assert.equal(result.diagnostic,undefined);
  assert.equal(result.posts,undefined);
  assert.equal(result.finishedAt,undefined);
  assert.deepEqual(result.followResult,{});
  assert.deepEqual(result.evaluations,[]);
});

test('completion keeps current attempt diagnosis and excludes another run diagnosis',()=>{
  const event={type:'job-complete',runId:'current',reason:'Rate limit exceeded',state:'uncertain'};
  assert.equal(normalizeQueueExecutionLog(event,{}, {diagnostic:{runId:'old'}}).diagnostic,undefined);
  const row=normalizeQueueExecutionLog(event,{}, {diagnostic:{runId:'current',id:'new'}});
  assert.equal(row.diagnostic.id,'new');
  assert.equal(row.detail,'Rate limit exceeded');
});

test('failure count is isolated by target and actual error, not all targets in one stage',async()=>{
  const values={};
  const api={storage:{local:{get:async key=>({[key]:values[key]}),set:async patch=>Object.assign(values,patch)}}};
  const recorder=createQueueDiagnostics({api,writeLog:async()=>{}});
  const context={accountId:'viewer',stage:'open-profile',handle:'one'};
  const error=new Error('timeout');
  assert.equal((await recorder.record(error,context)).diagnostic.repeatCount,1);
  assert.equal((await recorder.record(error,{...context,handle:'two'})).diagnostic.repeatCount,1);
  assert.equal((await recorder.record(new Error('different failure'),context)).diagnostic.repeatCount,1);
  const repeat=await recorder.record(error,context);
  assert.equal(repeat.diagnostic.repeatCount,2);
  assert.equal(repeat.diagnostic.repeatScope,'target-error');
});

test('profile read timeout explains no follow was sent and uses its own diagnostic code',async()=>{
  const error=Object.assign(new Error('主页资料读取超时'),{code:'X_PROFILE_READ_TIMEOUT'});
  assert.match(pageFailureMessage(error),/未发送关注请求/);
  const diagnostic=await capturePageFailure({},error,{stage:'open-profile'});
  assert.equal(diagnostic.code,'X_PROFILE_READ_TIMEOUT');
});

test('job diagnostics can persist without adding a duplicate failure log before settlement',async()=>{
  const values={},logs=[];
  const api={storage:{local:{get:async key=>({[key]:values[key]}),set:async patch=>Object.assign(values,patch)}}};
  const recorder=createQueueDiagnostics({api,writeLog:async entry=>logs.push(entry)});
  const result=await recorder.record(new Error('read failed'),{accountId:'viewer',handle:'target',stage:'open-profile',deferLog:true});
  assert.equal(logs.length,0);
  assert.equal(values.followQueueDiagnostics.recent[0].id,result.diagnostic.id);
});

test('follow-back decision and explicit booleans remain visible in successful and skipped logs',()=>{
  const decision={code:'follow-back',reason:'确认待回关，跳过比例和互粉意向筛选',followedBy:true,following:false,screeningReason:'待回关放行'};
  const result=normalizeQueueExecutionLog({type:'job-complete',state:'followed'},{},{relationshipDecision:decision});
  assert.match(result.detail,/关注成功/);assert.match(result.detail,/对方关注我：是/);assert.match(result.detail,/跳过比例/);
  assert.equal(normalizeQueueExecutionLog({...result}, {}, result).detail,result.detail);
  assert.doesNotMatch(normalizeQueueExecutionLog({type:'job-start'},{followResult:{relationshipDecision:decision}}).detail,/待回关/);
});
