import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
globalThis.IDBKeyRange=IDBKeyRange;
async function fixture({targetId='42',originalAuthorId='42',following=true,relay=false,draft=false}={}){
  const store=createFollowQueueStore({indexedDB,dbName:'comment-identity-'+crypto.randomUUID()});
  await store.saveSettings('123',{grokEnabled:true,autoPublish:false,publicationMode:'reply',quoteParticipationRate:100});
  const job=await store.enqueue({accountId:'123',targetUserId:'42',handle:'author',sources:[{module:'comments',enabled:true}]});
  const post={url:'https://x.com/author/status/999',text:'A concrete source about tests and careful boundary checks.',textComplete:true,replyCount:1,repostCount:1,likeCount:1,bookmarkCount:1};
  await store.resolveJob({accountId:'123',id:job.id,state:'followed',followResult:{succeeded:true},evaluations:[{taskId:'task',publicationMode:'reply',automaticComment:true,originalAuthorId,
    originalPostId:'999',originalPostUrl:post.url,originalPostText:post.text,candidatePosts:[post],status:relay?'uncertain':draft?'draft':'pending',text:draft?'An existing complete draft.':'',
    ...(relay?{relayJobId:'paid-old-task',reasonCode:'bot_pending',generationAttemptedAt:1,commentEngine:{provider:'antigravity',botId:'old-paid-session'}}:{})}]} );
  const data={followQueueBinding:{accountId:'123',handle:'viewer',activated:true},'followQueueReviewSettings:123':{commentEngine:{provider:'codex',botId:'new-comment-session'}},profileCache:{author:{name:'Author',bio:'software',posts:[post]}}};
  const calls={generate:0,publish:0,readProfile:0};let currentId=targetId;
  const api={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(data)).map(key=>[key,structuredClone(data[key])])),set:async patch=>Object.assign(data,structuredClone(patch))}},
    tabs:{create:async()=>({id:1}),remove:async()=>{}},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const runtime=createFollowQueueRuntime({api,store,wait:async()=>{},fetchProfile:async()=>{calls.readProfile++;return {status:200,json:{rest_id:currentId,core:{screen_name:'author'},relationship_perspectives:{following,followed_by:true}}};},
    generateReply:async(_handle,_posts,_name,options)=>{calls.generate++;if(relay){assert.equal(options.relayJobId,'paid-old-task');assert.equal(options.commentEngine.botId,'old-paid-session');}
      return {ok:true,reply:'A useful, specific observation.',post,language:'en',grokCalls:1};},
    replyPublisher:{verify:async()=>null,publish:async options=>{await options.canPublish();calls.publish++;return {ok:true,status:'posted',publishedPostId:'1000'};}}});
  return {runtime,store,job,calls,setId:id=>{currentId=id},request:extra=>runtime.handle({cmd:'followQueueRetryEvaluation',jobId:job.id,taskId:'task',...extra})};
}
test('a recycled comment handle cannot spend tokens or publish against a different stable user',async()=>{
  const f=await fixture({targetId:'999'});await assert.rejects(f.request(),/账号/);assert.equal(f.calls.generate,0);assert.equal(f.calls.publish,0);
});
test('a mismatched stored original author cannot start a new comment request',async()=>{
  const f=await fixture({originalAuthorId:'999'});await assert.rejects(f.request(),/原帖作者/);assert.equal(f.calls.generate,0);assert.equal(f.calls.publish,0);
});
test('a relationship that no longer confirms the prior follow cannot generate a new comment',async()=>{
  const f=await fixture({following:false});await assert.rejects(f.request(),/关注关系/);assert.equal(f.calls.generate,0);assert.equal(f.calls.publish,0);
});
test('identity is checked again after saving generation intent and before calling the writer',async()=>{
  const f=await fixture(),resolve=f.store.resolveJob.bind(f.store);f.store.resolveJob=async patch=>{const result=await resolve(patch);if(patch.evaluations?.[0]?.reasonCode==='generation_started')f.setId('999');return result;};
  await assert.rejects(f.request(),/账号/);assert.equal(f.calls.generate,0);assert.equal(f.calls.publish,0);
});
test('an existing paid AI receipt can recover its original session into a draft without a new dispatch',async()=>{
  const f=await fixture({targetId:'999',relay:true});const result=await f.request();assert.equal(result.evaluation.status,'draft');assert.equal(f.calls.generate,1);assert.equal(f.calls.publish,0);
});
test('an existing draft cannot publish to a recycled target even though it does not need generation',async()=>{
  const f=await fixture({targetId:'999',draft:true});await assert.rejects(f.request({publish:true}),/账号/);assert.equal(f.calls.generate,0);assert.equal(f.calls.publish,0);
});
