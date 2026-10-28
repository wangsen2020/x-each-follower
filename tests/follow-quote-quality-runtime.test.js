import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {createFollowQueueRuntime,waitForQueueViewer} from '../src/features/follow-queue/follow-queue-runtime.js';
import {quoteLengthPolicy} from '../src/features/grok/quote-quality.js';
globalThis.IDBKeyRange=IDBKeyRange;

async function setup(generator,settings={},postPublisher,hooks={}) {
  const store=createFollowQueueStore({indexedDB,dbName:'quote-runtime-'+crypto.randomUUID()});
  await store.saveSettings('123',{grokEnabled:true,quoteParticipationRate:100,autoPublish:false,...settings});
  const job=await store.enqueue({accountId:'123',handle:'author',targetUserId:'456',sources:[{module:'fans',enabled:true}]});
  const post={url:'https://x.com/author/status/789',text:'缓存命中后响应从800ms降到80ms，同一数据集。',textComplete:true};
  await store.resolveJob({accountId:'123',id:job.id,state:'followed',followResult:{succeeded:true},evaluations:[{
    taskId:'123:789',originalPostId:'789',originalPostUrl:post.url,originalPostText:post.text,
    automaticComment:true,candidatePosts:[post],status:'pending',publicationMode:settings.publicationMode || 'quote'}]});
  const data={followQueueBinding:{accountId:'123',handle:'viewer',activated:true},profileCache:{author:{bio:'software development',posts:[post]}}};
  let generated=0,removed=0;
  const api={storage:{local:{get:async key=>({[key]:data[key]}),set:async patch=>Object.assign(data,patch)}},
    tabs:{create:async()=>({id:900}),remove:async()=>{removed++;}},scripting:{executeScript:async({func})=>{
      assert.equal(func.name,'readQueueViewerOnPage','must not submit external action');return [{result:'viewer'}];
    }}};
  const generate=async(...args)=>{
    generated++;return generator({store,post,args});
  };
  const runtime=createFollowQueueRuntime({api,store,generateComment:generate,generatePost:generate,generateReply:generate,generateArticle:generate,postPublisher,...hooks});
  return {store,runtime,job,api,read:async()=> (await store.listByState({accountId:'123',state:'followed'})).find(j=>j.id===job.id),
    counts:()=>({generated,removed})};
}

test('an interrupted Bot generation preserves its ID and resumes the same result without a second dispatch',async()=>{
 let paidRequests=0,checkpoint;
 const env=await setup(async({args,store,post})=>{
   const options=args[3];
   if(!options.relayJobId){
     paidRequests++;
     await options.onRelayJobCreated({id:'reserved-relay-id',status:'unknown'});
     checkpoint=(await store.listByState({accountId:'123',state:'followed'}))[0].evaluations[0];
     assert.equal(checkpoint.relayJobId,'reserved-relay-id');
     throw Error('worker interrupted while waiting for callback');
   }
   assert.equal(options.relayJobId,'reserved-relay-id');
   return {ok:true,reply:'An existing Bot result.',post,language:'en',channel:'grok-bot',grokCalls:1};
 });
 await env.runtime.runComments();
 let ev=(await env.read()).evaluations[0];assert.equal(ev.status,'uncertain');assert.equal(ev.relayJobId,'reserved-relay-id');assert.equal(ev.reasonCode,'bot_pending');
 await env.runtime.runComments();
 ev=(await env.read()).evaluations[0];assert.equal(ev.status,'draft');assert.equal(ev.baseText,'An existing Bot result.');assert.equal(paidRequests,1);
});

for(const [mode,language,body,ending] of [
 ['quote','zh','这是一个值得检查的技术细节。','来关必回'],
 ['reply','en','The tradeoff deserves a closer test.','I follow back.']
]) test(`${mode} automatically appends its localized follow-back ending when enabled`,async()=>{
 const env=await setup(async({post})=>({ok:true,reply:body,post,language,quality:{passed:true,total:8},grokCalls:1}),{publicationMode:mode,followBackSuffixEnabled:true});
 await env.runtime.runComments();const saved=await env.read();
 assert.equal(saved.evaluations[0].status,'draft');assert.ok(saved.evaluations[0].text.endsWith(ending));
 assert.equal(saved.evaluations[0].baseText,body);
});

test('a requested ending that does not fit keeps the draft and prevents auto-publishing',async()=>{
 let sent=0;const body='a'.repeat(280);
 const env=await setup(async({post})=>({ok:true,reply:body,post,language:'en',quality:{passed:true,total:8},grokCalls:1}),
  {publicationMode:'quote',followBackSuffixEnabled:true,autoPublish:true},{publish:async()=>{sent++;}});
 await env.runtime.runComments();const saved=await env.read();
 assert.equal(sent,0);assert.equal(saved.evaluations[0].status,'draft');assert.equal(saved.evaluations[0].text,body);
 assert.match(saved.evaluations[0].reason,/无法追加/);
});

test('viewer guard waits for missing identity but immediately blocks a different logged-in account',async()=>{
  const values=['','','Viewer'];let waits=0;
  assert.equal(await waitForQueueViewer({read:async()=>values.shift(),expected:'viewer',wait:async()=>waits++}),'viewer');
  assert.equal(waits,2);
  await assert.rejects(waitForQueueViewer({read:async()=>'other',expected:'viewer',wait:async()=>assert.fail('must not wait on mismatch')}),/@other.*@viewer/);
  await assert.rejects(waitForQueueViewer({read:async()=>'',expected:'viewer',attempts:2,wait:async()=>{}}),/暂未读到登录账号/);
  await assert.rejects(waitForQueueViewer({read:async()=>'',expected:'viewer',check:async()=>{throw Error('cancelled');},wait:async()=>{}}),/cancelled/);
});

test('retrying an incomplete source survives empty viewer during navigation and generates only once',async()=>{
  const env=await setup(async({post})=>({ok:true,reply:'A useful independent observation.',post,quality:{passed:true,total:8},grokCalls:1}),{},undefined,{wait:async()=>{}});
  const job=await env.read();
  await env.store.resolveJob({accountId:'123',id:job.id,evaluations:[{...job.evaluations[0],candidatePosts:[{url:'https://x.com/author/status/789',text:'short incomplete',textComplete:false}]}]});
  let loading=0,navigations=0;
  env.api.tabs.update=async()=>{loading=2;navigations++;return {id:900};};
  env.api.scripting.executeScript=async({func})=>{
    if(func.name==='readQueueViewerOnPage')return [{result:loading-->0?'':'viewer'}];
    if(func.name==='readQuoteSourceOnPage')return [{result:{url:'https://x.com/author/status/789',text:'Complete source about measured cache latency with stated conditions.',textComplete:true}}];
    assert.fail('Unexpected external action: '+func.name);
  };
  const result=await env.runtime.handle({cmd:'followQueueRetryEvaluation',jobId:job.id,taskId:'123:789'});
  assert.equal(result.ok,true);assert.equal(navigations,1);assert.equal(env.counts().generated,1);
  const saved=await env.read();assert.equal(saved.state,'followed');assert.equal(saved.evaluations[0].status,'draft');
});
test('selected task generates one quality-first long draft, persists diagnostics and keeps follow success',async()=>{
  const text='分析缓存命中条件和冷启动差异。'.repeat(40);
  const env=await setup(async({post,args})=>{
    assert.equal(args[3].qualityFirst,true);assert.equal(args[3].lengthMode,'adaptive');
    return {ok:true,reply:text,post,language:'zh',quality:{passed:true,total:7,reason:'具体机制与边界'},lengthPolicy:quoteLengthPolicy(),grokCalls:1};
  },{autoPublish:true});
  const result=await env.runtime.runComments();
  assert.equal(result.ok,true);
  const saved=await env.read();
  assert.equal(saved.state,'followed');assert.equal(saved.followResult.succeeded,true);
  assert.equal(saved.evaluations[0].text,text);assert.equal(saved.evaluations[0].status,'draft');
  assert.equal(saved.evaluations[0].grokCalls,1);assert.equal(saved.evaluations[0].quality.total,7);
  assert.match(saved.evaluations[0].reason,/长引用能力/);
  assert.equal((await env.runtime.runComments()).idle,true);assert.deepEqual(env.counts(),{generated:1,removed:1});
});

test('legacy multi-post tasks choose the most commented source locally and persist it across a quality retry',async()=>{
  const winner={url:'https://x.com/author/status/799',text:'A specific independent source about software releases.',textComplete:true,repostCount:0,likeCount:0,bookmarkCount:0,replyCount:30};
  const env=await setup(async({args})=>{
    assert.deepEqual(args[1],[winner]);
    return {ok:false,skipped:true,reasonCode:'quality_skip',reason:'材料不足',grokCalls:1};
  });
  const job=await env.read();
  const candidates=Array.from({length:10},(_,i)=>({...winner,url:`https://x.com/author/status/${789+i}`,repostCount:0,likeCount:0,bookmarkCount:0,replyCount:i===9?30:1}));
  candidates[9]=winner;
  await env.store.resolveJob({accountId:'123',id:job.id,evaluations:[{...job.evaluations[0],candidatePosts:candidates}]});
  await env.runtime.runComments();
  let saved=await env.read();assert.equal(saved.evaluations[0].originalPostUrl,winner.url);
  assert.deepEqual(saved.evaluations[0].candidatePosts,[winner]);
  await env.runtime.handle({cmd:'followQueueRetryEvaluation',jobId:job.id,taskId:'123:789'});
  assert.equal(env.counts().generated,2);
});

test('the highest scoring source still respects participation sampling and a zero rate never calls Grok',async()=>{
  const env=await setup(async()=>assert.fail('must not call Grok'),{quoteParticipationRate:0});
  const job=await env.read();
  const winner={url:'https://x.com/author/status/799',text:'A concrete source with a very high interaction score.',textComplete:true,replyCount:10,repostCount:1000,likeCount:1000,bookmarkCount:1000};
  await env.store.resolveJob({accountId:'123',id:job.id,evaluations:[{...job.evaluations[0],candidatePosts:[winner]}]});
  const result=await env.runtime.runComments();
  assert.equal(result.paused,true);assert.equal(env.counts().generated,0);
});
test('quality skip is terminal and does not regenerate or affect following',async()=>{
  const env=await setup(async()=>({ok:false,skipped:true,reasonCode:'quality_skip',reason:'缺乏新增分析价值',grokCalls:1}));
  await env.runtime.runComments();await env.runtime.runComments();
  const saved=await env.read();assert.equal(saved.evaluations[0].status,'skipped');
  assert.equal(saved.evaluations[0].reasonCode,'quality_skip');assert.equal(saved.state,'followed');
  assert.equal(env.counts().generated,1);
  await env.runtime.handle({cmd:'followQueueRetryEvaluation',jobId:env.job.id,taskId:'123:789'});
  assert.equal(env.counts().generated,2,'an explicit retry may reassess a confirmed quality skip');
  assert.equal((await env.read()).evaluations[0].status,'skipped');
});
test('automatic pause during generation prevents submission and retains the generated draft',async()=>{
  const env=await setup(async({store,post})=>{
    await store.saveSettings('123',{quoteParticipationRate:0});
    return {ok:true,reply:'A concrete new insight.',post,quality:{passed:true}};
  },{autoPublish:true});
  await env.runtime.runComments();
  assert.equal(env.counts().generated,1);
  const saved=await env.read();assert.equal(saved.state,'followed');
  assert.equal(saved.evaluations[0].text,'A concrete new insight.');
  assert.equal(saved.evaluations[0].status,'draft');
  assert.equal((await env.runtime.runComments()).paused,true);
});
for (const attempted of [false,true]) test(`quota ${attempted ? 'after' : 'before'} submission retains the correct retry boundary`,async()=>{
  let count=0;
  const env=await setup(async({post})=>{
    count++;
    if(count===1)return {ok:false,quotaExhausted:true,generationAttempted:attempted,grokCalls:attempted?1:0,retryAt:Date.now()+900000};
    return {ok:true,reply:'A useful draft.',post,grokCalls:1,quality:{passed:true}};
  });
  await env.runtime.runComments();
  let saved=await env.read();
  assert.equal(saved.evaluations[0].status,attempted?'uncertain':'pending');
  await env.runtime.handle({cmd:'followQueueRetryEvaluation',jobId:env.job.id,taskId:'123:789'});
  saved=await env.read();
  assert.equal(count,attempted?1:2);
  assert.equal(saved.evaluations[0].status,attempted?'failed':'draft');
  if(attempted){
    assert.equal(saved.evaluations[0].reasonCode,'generation_retry_ready');
    assert.equal(saved.evaluations[0].recoveryHistory[0].evaluation.status,'uncertain');
  }
});

test('standalone tasks keep their snapshotted form and delegate publication to the post module',async()=>{
  const published=[];
  const publisher={verify:async()=>null,publish:async options=>{
    published.push(options);assert.equal(await options.canPublish(),true);
    return {ok:true,status:'posted',publishedPostId:'9001',publishedPostUrl:'https://x.com/viewer/status/9001'};
  }};
  const env=await setup(async({post})=>({ok:true,reply:'应区分冷启动成本与热命中性能，再观察尾延迟分布。',post,
    quality:{passed:true,scores:[2,2,2,1],total:7},grokCalls:1}),{publicationMode:'original',autoPublish:true},publisher);
  await env.store.saveSettings('123',{publicationMode:'quote'});
  const result=await env.runtime.runComments();assert.equal(result.ok,true);assert.equal(published.length,1);
  const saved=await env.read();assert.equal(saved.evaluations[0].publicationMode,'original');
  assert.equal(saved.evaluations[0].publishedPostId,'9001');assert.equal(saved.state,'followed');
  await env.runtime.runComments();assert.equal(published.length,1);
});

test('a quote-grade draft cannot pass the stricter original publishing gate',async()=>{
  const env=await setup(async({post})=>({ok:true,reply:'数据需要结合缓存状态比较。',post,
    quality:{passed:true,scores:[1,2,2,2],total:7}}),{publicationMode:'original',autoPublish:true},
    {publish:async()=>assert.fail('must not publish weak original'),verify:async()=>null});
  await env.runtime.runComments();const saved=await env.read();
  assert.equal(saved.evaluations[0].status,'draft');assert.match(saved.evaluations[0].reason,/独立分析/);
});

for(const mode of ['reply','article'])test(mode+' uses its publisher, preserves metadata and shared probability pause',async()=>{
 const article={title:'Fixed incentives',body:'The base rate and reward rules must be distinguished.',description:'A closer look at reward rules.',coverPrompt:'abstract 5:2 network'};
 let images=0,published=0;
 const publisher={verify:async()=>null,publish:async options=>{published++;assert.equal(await options.canPublish(),true);if(mode==='article'){assert.equal(options.article.description,article.description);assert.equal(options.article.cover.width,1200);}else assert.equal(options.sourcePostUrl,'https://x.com/author/status/789');return {ok:true,status:'posted',publishedPostId:'9010',publishedPostUrl:'https://x.com/viewer/status/9010'};}};
 const env=await setup(async({post})=>({ok:true,reply:article.body,article:mode==='article'?article:undefined,post,quality:{passed:true,scores:[2,2,2,1],total:7},grokCalls:1}),{publicationMode:mode,autoPublish:true},undefined,{replyPublisher:publisher,articlePublisher:publisher,generateCover:async()=>{images++;return {ok:true,cover:{dataUrl:'data:image/png;base64,AAAA',width:1200,height:480}};}});
 await env.store.saveSettings('123',{quoteParticipationRate:0});await env.runtime.runComments();assert.equal(env.counts().generated,0);
 await env.store.saveSettings('123',{quoteParticipationRate:100});await env.runtime.runComments();const ev=(await env.read()).evaluations[0];assert.equal(ev.publicationMode,mode);assert.equal(ev.status,'posted');assert.equal(published,1);assert.equal(images,mode==='article'?1:0);if(mode==='article')assert.equal(ev.article.cover.width,1200);await env.runtime.runComments();assert.equal(published,1);assert.equal(env.counts().generated,1);
});
test('article image failure retains generated body and does not auto-regenerate or submit',async()=>{
 const article={title:'Reward rules',body:'A standalone explanation of fixed reward rates.',description:'Read the rules.',coverPrompt:'5:2 abstract network'};let images=0;
 const env=await setup(async({post})=>({ok:true,reply:article.body,article,post,quality:{passed:true,scores:[2,2,2,1],total:7}}),{publicationMode:'article',autoPublish:true},undefined,{articlePublisher:{verify:async()=>null,publish:async()=>assert.fail('no image: no publication')},generateCover:async()=>{images++;return {ok:false,reason:'额度不足'};}});
 await env.runtime.runComments();await env.runtime.runComments();const ev=(await env.read()).evaluations[0];assert.equal(ev.status,'draft');assert.equal(ev.article.body,article.body);assert.match(ev.reason,/额度不足/);assert.equal(images,1);assert.equal(env.counts().generated,1);
});

test('manual reply waits for a populated profile timeline rather than failing on initial empty render',async()=>{
 const store=createFollowQueueStore({indexedDB,dbName:'timeline-hydration-'+crypto.randomUUID()});await store.saveSettings('123',{publicationMode:'reply',grokEnabled:true,autoPublish:false});
 const job=await store.enqueue({accountId:'123',handle:'author',sources:[{module:'fans',enabled:true}]});await store.resolveJob({accountId:'123',id:job.id,state:'followed',followResult:{succeeded:true}});
 const post={url:'https://x.com/author/status/789',text:'A specific original post about building a tool.',textComplete:true,replyCount:1,repostCount:0,likeCount:1,bookmarkCount:0};
 const data={followQueueBinding:{accountId:'123',handle:'viewer',activated:true},profileCache:{}};let reads=0;
 const api={storage:{local:{get:async key=>({[key]:data[key]}),set:async patch=>Object.assign(data,patch)}},tabs:{create:async()=>({id:900}),update:async()=>({id:900}),remove:async()=>{}},scripting:{executeScript:async({func})=>{if(func.name==='readQueueViewerOnPage')return [{result:'viewer'}];if(func.name==='readProfileBundle')return [{result:{pending:false,status:'ok',name:'author',bio:'software',posts:++reads===1?[]:[post]}}];if(func.name==='readPostMetricsOnPage')return [{result:{}}];throw Error('unexpected '+func.name)}}};
 const runtime=createFollowQueueRuntime({api,store,generateReply:async()=>({ok:true,reply:'A useful observation.',post,language:'en',grokCalls:1})});
 const result=await runtime.handle({cmd:'followQueueRetryEvaluation',jobId:job.id});assert.equal(reads,2);assert.equal(result.ok,true);assert.equal(result.evaluation.status,'draft');assert.equal(result.evaluation.originalPostId,'789');
});

for(const enabled of [false,true])test('queue passes explicit knowledge enhancement '+enabled+' to comment generation',async()=>{
 const used=[{id:'experience-1',revision:2,statement:'补充具体信息'}];
 const env=await setup(async({post,args})=>{assert.equal(args[3].knowledgeEnabled,enabled);return {ok:true,reply:'补充测试结论。',post,...(enabled?{knowledgeUsed:used}:{})};},{publicationMode:'reply',knowledgeEnabled:enabled});
 await env.runtime.runComments();const ev=(await env.read()).evaluations[0];assert.equal(ev.status,'draft');if(enabled)assert.deepEqual(ev.knowledgeUsed,used);else assert.equal(ev.knowledgeUsed,undefined);
});
