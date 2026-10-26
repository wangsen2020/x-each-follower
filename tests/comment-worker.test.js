import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {readFile} from 'node:fs/promises';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {createFollowQueueScheduler} from '../src/features/follow-queue/follow-queue-scheduler.js';
import {createCommentWorker} from '../src/features/follow-queue/comment-worker.js';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
globalThis.IDBKeyRange = IDBKeyRange;

async function setup(execute, options = {}) {
  const store = createFollowQueueStore({indexedDB, dbName:'comments-'+crypto.randomUUID()});
  const accountId = '123';
  await store.saveSettings(accountId,{enabled:true,grokEnabled:true,quoteParticipationRate:100,batchLimit:5});
  const job = await store.enqueue({accountId,handle:'done',targetUserId:'456',sources:[{module:'fans',enabled:true}]});
  await store.resolveJob({accountId,id:job.id,state:'followed',followResult:{succeeded:true},evaluations:[{
    taskId:'123:789',originalPostId:'789',originalPostText:'An original post',
    candidatePosts:[{url:'https://x.com/done/status/789',text:'An original post',textComplete:true}],
    automaticComment:true,status:'pending'}]});
  const values = {};
  const storage = {get:async key=>({[key]:values[key]})};
  const args = {store,storage,readBinding:async()=>({accountId,activated:true}),execute,...options};
  return {store,job,accountId,values,args,worker:createCommentWorker(args),
    read:async()=> (await store.listByState({accountId,state:'followed'})).find(row=>row.id===job.id)};
}

for (const scenario of ['failure','timeout','quota']) test(`${scenario} affects only comment; subsequent follows complete`, async()=>{
  const env = await setup(async(_binding,{signal})=>{
    if (scenario==='timeout') return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('评论超时'))));
    if (scenario==='failure') throw new Error('评论发布失败');
    return {ok:false,quotaExhausted:true,retryAt:Date.now()+900000};
  },{timeoutMs:20});
  const comment = env.worker.run();
  for (const handle of ['next_one','next_two']) await env.store.enqueue({accountId:env.accountId,handle,sources:[{module:'fans',enabled:true}]});
  let follows=0;
  const scheduler = createFollowQueueScheduler({store:env.store,canRun:async()=>true,
    execute:async()=>{follows++;return {state:'followed',followResult:{succeeded:true}};}});
  await scheduler.run({accountId:env.accountId});
  await comment;
  assert.equal(follows,2);
  const saved=await env.read();
  assert.equal(saved.followResult.succeeded,true);
  assert.equal(saved.state,'followed');
  assert.equal(saved.followResult.retryCount,undefined);
  assert.equal(saved.evaluations[0].status,scenario==='quota'?'pending':'failed');
  assert.equal(saved.evaluations[0].automaticComment,true);
  assert.equal(saved.evaluations[0].originalPostText,'An original post');
  assert.equal(saved.evaluations[0].candidatePosts[0].url,'https://x.com/done/status/789');
});

test('persisted quota blocks only comments without opening a browser; restart retains intent',async()=>{
  const env=await setup(async()=>assert.fail('quota must skip execution'));
  env.values.xfGrokUsageLimit={channel:'x.com',retryAt:Date.now()+900000};
  assert.equal((await createCommentWorker(env.args).run()).quotaExhausted,true);
  assert.equal((await env.read()).evaluations[0].status,'pending');
});

test('hung comment does not block follow and cannot publish after its abort signal',async()=>{
  let release, signal, calls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const env=await setup(async(_binding,options)=>{
    signal=options.signal; calls++;
    await gate;
    assert.equal(signal.aborted,true);
    return {ok:false};
  },{timeoutMs:15});
  const run=env.worker.run();
  assert.equal((await env.worker.run()).busy,true);
  await run;
  assert.equal(signal.aborted,true);
  release();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls,1);
  assert.equal((await env.read()).evaluations[0].status,'failed');
});

test('restart never blindly repeats an interrupted publication',async()=>{
  const env=await setup(async()=>assert.fail('must verify manually'));
  const saved=await env.read();
  await env.store.resolveJob({accountId:env.accountId,id:env.job.id,evaluations:[{...saved.evaluations[0],status:'publishing',text:'draft'}]});
  await createCommentWorker(env.args).run();
  const after=await env.read();
  assert.equal(after.state,'followed');
  assert.equal(after.evaluations[0].status,'uncertain');
  assert.equal(after.evaluations[0].text,'draft');
});

test('deleted job and other account cannot be picked up by comment worker',async()=>{
  const env=await setup(async()=>assert.fail('deleted or foreign job'));
  await env.store.deleteJob({accountId:env.accountId,id:env.job.id});
  assert.equal((await env.worker.run()).idle,true);
});

test('probability zero pauses without opening tabs or spending Grok and keeps pending intent',async()=>{
  const env=await setup(async()=>assert.fail('zero must not execute'));
  await env.store.saveSettings(env.accountId,{quoteParticipationRate:0});
  assert.equal((await env.worker.run()).paused,true);
  assert.equal((await env.read()).evaluations[0].status,'pending');
});

test('legacy unselected tasks finish without Grok and restart never redraws',async()=>{
  const env=await setup(async()=>assert.fail('not selected'));
  await env.store.saveSettings(env.accountId,{quoteParticipationRate:60});
  let rolls=0;
  const args={...env.args,random:()=>{rolls++;return .6;}};
  assert.equal((await createCommentWorker(args).run()).reasonCode,'probability_skip');
  assert.equal((await env.read()).evaluations[0].grokCalls,0);
  assert.equal((await createCommentWorker(args).run()).idle,true);
  assert.equal(rolls,1);
});

test('follow execution has no Grok calls, comment execution or quota dependency',async()=>{
  const source=await readFile(new URL('../src/features/follow-queue/follow-queue-runtime.js',import.meta.url),'utf8');
  const execution=source.slice(source.indexOf('  async function execute('),source.indexOf('  const scheduler ='));
  assert.doesNotMatch(execution,/requestGrok|evaluateProfileGrokRisk|readXGrokUsageCooldown|postQuoteOnTab|retryEvaluation/);
  assert.match(execution,/automaticComment:true/);
});

test('runtime rejects a late generated comment after timeout before any publish call',async()=>{
  const env=await setup(async()=>{});
  await env.store.saveSettings(env.accountId,{skipRiskContent:false,autoPublish:true});
  const controller=new AbortController();
  const values={followQueueBinding:{accountId:env.accountId,handle:'viewer',activated:true},
    profileCache:{done:{bio:'Software development',posts:[{url:'https://x.com/done/status/789',text:'An original post',textComplete:true}]}}};
  const removed=[];
  const api={storage:{local:{get:async key=>({[key]:values[key]}),set:async patch=>Object.assign(values,patch)}},
    tabs:{create:async()=>({id:999}),remove:async id=>removed.push(id)},
    scripting:{executeScript:async({func})=>{
      assert.equal(func.name,'readQueueViewerOnPage','no publishing script may run');
      return [{result:'viewer'}];
    }}};
  const runtime=createFollowQueueRuntime({api,store:env.store,generateComment:async()=>{
    controller.abort();
    return {ok:true,reply:'late draft',post:{url:'https://x.com/done/status/789',text:'An original post'}};
  }});
  await assert.rejects(runtime.handle({cmd:'followQueueRetryEvaluation',jobId:env.job.id,
    taskId:'123:789',signal:controller.signal}),/评论任务超时/);
  assert.equal((await env.read()).state,'followed');
  assert.deepEqual(removed,[999]);
});
