import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
globalThis.IDBKeyRange = IDBKeyRange;

async function fixture(overrides={}, generatedOverride) {
  const dbName='recovery-'+crypto.randomUUID();
  const store=createFollowQueueStore({indexedDB,dbName});
  const source={url:'https://x.com/target/status/999',text:'并发请求如何影响数据库的延迟和错误率，需要按工作负载逐项测量。',textComplete:true};
  const job=await store.enqueue({accountId:'123',targetUserId:'42',handle:'target',sources:[{module:'fans',enabled:true}]});
  const original={taskId:'task',publicationMode:'original',originalPostId:'999',originalPostUrl:source.url,
    originalPostText:source.text,status:'uncertain',text:'',generationAttemptedAt:1000,reasonCode:'generation_uncertain',
    reason:'Grok 提交后触发额度限制，结果待核实，未重复请求',grokCalls:2,attempts:11,automaticComment:true,...overrides};
  await store.resolveJob({accountId:'123',id:job.id,state:'followed',followResult:{succeeded:true},evaluations:[original]});
  const calls={generate:0,publish:0,verify:0,tabs:0};
  const data={followQueueBinding:{accountId:'123',handle:'viewer',activated:true},profileCache:{target:{posts:[source]}}};
  const api={storage:{local:{get:async()=>data,set:async v=>Object.assign(data,v)}},
    runtime:{sendMessage:async()=>{}},tabs:{query:async()=>[{id:1}],create:async()=>{calls.tabs++;return{id:99}},get:async()=>({id:99,status:'complete'}),remove:async()=>{}},
    scripting:{executeScript:async()=>[{result:'viewer'}]}};
  await store.saveSettings('123',{grokEnabled:true,autoPublish:true,publicationMode:'quote'});
  const runtime=createFollowQueueRuntime({api,store,wait:async()=>{},
    generatePost:async()=>{calls.generate++;return generatedOverride || {ok:true,reply:'限制并发能降低争用，但吞吐量是否上升仍应由延迟和错误率验证。',post:source,language:'zh',quality:{scores:[2,2,2,1]}}},
    postPublisher:{verify:async()=>{calls.verify++;return null},publish:async()=>{calls.publish++;return{ok:true,status:'posted',publishedPostId:'777',publishedPostUrl:'https://x.com/viewer/status/777'}}}});
  const request=options=>runtime.handle({cmd:'followQueueRetryEvaluation',accountId:'123',jobId:job.id,taskId:'task',...options});
  const read=async()=>(await store.get(job.id)).evaluations[0];
  return{store,job,original,calls,request,read,reopen:()=>createFollowQueueStore({indexedDB,dbName})};
}

test('manual check recovers generation-only uncertainty without X requests and retains complete evidence across reopen',async()=>{
  const f=await fixture();const result=await f.request({verifyOnly:true,publish:true});
  assert.equal(result.ok,true);const ev=await f.read();
  assert.equal(ev.status,'failed');assert.equal(ev.reasonCode,'generation_retry_ready');assert.equal(ev.recoveryDraftOnly,true);
  assert.equal(ev.generationAttemptedAt,1000);assert.equal(ev.attempts,11);assert.equal(ev.grokCalls,2);
  assert.equal(ev.recoveryHistory.length,1);assert.equal(ev.recoveryHistory[0].evaluation.reason,f.original.reason);
  assert.equal(ev.recoveryHistory[0].evaluation.publicationMode,'original');assert.deepEqual(f.calls,{generate:0,publish:0,verify:0,tabs:0});
  await f.request({verifyOnly:true});assert.equal((await f.read()).recoveryHistory.length,1);
  await f.store.resolveJob({accountId:'123',id:f.job.id,evaluations:[{taskId:'task',reason:'再次查看',recoveryHistory:[]}]});
  assert.equal((await f.read()).recoveryHistory.length,1);assert.equal((await f.read()).recoveryDraftOnly,true);
  assert.equal((await f.reopen().get(f.job.id)).evaluations[0].recoveryHistory[0].evaluation.attempts,11);
  assert.equal((await f.store.get(f.job.id)).state,'followed');
});

test('recovered generation keeps a draft despite autoPublish and explicit publish, then manual draft publication runs once',async()=>{
  const f=await fixture();await f.request({verifyOnly:true});
  const result=await f.request({publish:true});assert.equal(result.ok,true);
  assert.equal(f.calls.generate,1);assert.equal(f.calls.publish,0);assert.equal(result.evaluation.status,'draft');
  assert.equal(result.evaluation.publicationMode,'original');assert.equal((await f.read()).recoveryHistory.length,1);
  await f.request({verifyOnly:true,publish:true});assert.equal(f.calls.publish,0);
  const posted=await f.request({publish:true});assert.equal(posted.evaluation.status,'posted');assert.equal(f.calls.publish,1);
  await f.request({publish:true});assert.equal(f.calls.generate,1);assert.equal(f.calls.publish,1);
  assert.equal((await f.read()).recoveryHistory[0].evaluation.grokCalls,2);
});

test('publish attempts and unknown legacy stages never become permission to regenerate',async()=>{
  for(const extra of [{publishedAttemptedAt:2000},{publishedPostId:'777'},{publishedPostUrl:'https://x.com/viewer/status/777'},
    {articleDraftUrl:'https://x.com/i/articles/123'},{attempts:[{stage:'publish'}]},{reasonCode:'unknown_legacy'}]){
    const f=await fixture(extra);const r=await f.request({verifyOnly:true,publish:true});assert.equal(r.ok,false);
    assert.equal((await f.read()).status,'uncertain');assert.equal(f.calls.generate,0);assert.equal(f.calls.publish,0);
  }
});

test('failed recovery checkpoint cannot expose a retry or cause a new request',async()=>{
  const f=await fixture();f.store.resolveJob=async()=>({ok:false});
  await assert.rejects(f.request({verifyOnly:true}),/恢复状态未保存/);
  assert.equal((await f.read()).status,'uncertain');assert.equal(f.calls.generate,0);assert.equal(f.calls.publish,0);
});

test('existing uncertain text is verified without regenerating or republishing',async()=>{
  const f=await fixture({text:'已经生成但发布结果不明的正文',publishedAttemptedAt:2000});
  const r=await f.request({verifyOnly:true,publish:true});assert.equal(r.evaluation.status,'uncertain');
  assert.equal(f.calls.verify,1);assert.equal(f.calls.generate,0);assert.equal(f.calls.publish,0);
});

test('a zero default cannot erase an existing publication checkpoint',async()=>{
  const f=await fixture({publishedAttemptedAt:2000});
  await f.store.resolveJob({accountId:'123',id:f.job.id,evaluations:[{taskId:'task',publishedAttemptedAt:0}]});
  assert.equal((await f.read()).publishedAttemptedAt,2000);
  assert.equal((await f.request({verifyOnly:true})).ok,false);
});

test('a failed publication checkpoint stops an otherwise approved recovered draft',async()=>{
  const f=await fixture();await f.request({verifyOnly:true});await f.request({publish:true});
  const resolve=f.store.resolveJob;f.store.resolveJob=async p=>p.evaluations?.[0]?.status==='publishing'?{ok:false}:resolve(p);
  await assert.rejects(f.request({publish:true}),/发布检查点/);assert.equal(f.calls.publish,0);
});

test('pre-submit quota exhaustion leaves recovered work manually retryable instead of an unclaimed pending task',async()=>{
  const f=await fixture({}, {ok:false,quotaExhausted:true,generationAttempted:false,grokCalls:0});
  await f.request({verifyOnly:true});await f.request({publish:true});const ev=await f.read();
  assert.equal(ev.status,'failed');assert.equal(ev.reasonCode,'quota_not_sent');assert.equal(ev.recoveryDraftOnly,true);
  assert.equal(ev.recoveryHistory.length,1);assert.equal(f.calls.publish,0);
});

test('missing legacy source IDs cannot bypass publication verification',async()=>{
  const f=await fixture({originalPostId:'',text:'旧新帖正文仍存在',publishedAttemptedAt:2000});
  const r=await f.request({verifyOnly:true,publish:true});assert.equal(r.evaluation.status,'uncertain');
  assert.equal(f.calls.verify,1);assert.equal(f.calls.publish,0);
  const quote=await fixture({publicationMode:'quote',originalPostId:'',originalPostUrl:'',text:'历史引用正文',publishedAttemptedAt:2000});
  const blocked=await quote.request({verifyOnly:true,publish:true});assert.equal(blocked.ok,false);
  assert.match(blocked.error,/缺少原帖标识/);assert.equal((await quote.read()).status,'uncertain');assert.equal(quote.calls.publish,0);
});
