import test from 'node:test';
import assert from 'node:assert/strict';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
import {FOLLOW_QUEUE_DEFAULT_SETTINGS} from '../src/features/follow-queue/follow-queue-store.js';
import {createFanGrant,hasAuthorizedFanGrant,reviewSettingsKey} from '../src/features/relationships/follow-review-engine.js';
import {requestGrokComment} from '../src/features/grok/grok-comment.js';

const OWNER='123',TARGET='42',HANDLE='target_user';
const clone=value=>structuredClone(value);

function setup({bio='',postText='A practical observation about software testing and clear failure reports.',grantOwner=OWNER,reply='A specific test case makes the boundary much easier to verify.'}={}) {
  const binding={accountId:OWNER,handle:'viewer',activated:true,sources:{fans:true}};
  const grant=createFanGrant({accountId:grantOwner,targetUserId:TARGET,handle:HANDLE,source:'initial-ai-pass',at:1700000000000});
  const post={url:'https://x.com/'+HANDLE+'/status/999',text:postText,textComplete:true,isPinned:false,
    replyCount:10,repostCount:10,likeCount:10,bookmarkCount:10};
  const profile={handle:HANDLE,id:TARGET,name:'Target',bio,posts:[post],followersText:'1000',followingText:'1000',relationship:{following:true,followedBy:true}};
  const values={followQueueBinding:binding,profileCache:{[HANDLE]:profile},
    monitor:{users:[{...profile,fanGrant:grant,fanReview:{state:'approved',grant}}],queue:[],followingUsers:[]},
    [reviewSettingsKey(OWNER)]:{initialReviewEnabled:true,followBackSkipRules:true,ratioLimit:10,
      fanTagging:{provider:'codex',botId:'initial-session'},queueTagging:{provider:'codex',botId:'queue-session'},
      commentEngine:{provider:'codex',botId:'comment-session',prompt:'Write a focused, factual comment.'}}};
  let job={id:OWNER+':id:'+TARGET,accountId:OWNER,targetUserId:TARGET,handle:HANDLE,state:'followed',sources:[{module:'fans',enabled:true}],
    fanGrant:grant,profile:{name:profile.name,bio},followResult:{succeeded:true,fanGrant:grant,
      relationshipDecision:{code:'follow-back',following:false,followedBy:true,targetUserId:TARGET}},
    evaluations:[{taskId:'comment-task',automaticComment:true,status:'pending',publicationMode:'quote',
      originalPostId:'999',originalPostUrl:post.url,originalPostText:post.text,text:'',candidatePosts:[post]}]};
  const state={writerCalls:0,generationEntries:0,engine:null,publishes:0};
  const settings={...FOLLOW_QUEUE_DEFAULT_SETTINGS,grokEnabled:true,autoPublish:false,quoteParticipationRate:100,publicationMode:'quote',quoteTagsEnabled:false};
  const store={get:async id=>id===job.id?clone(job):null,list:async()=>[clone(job)],getSettings:async()=>clone(settings),
    resolveJob:async patch=>{job={...job,...clone(patch)};return {ok:true,job:clone(job)};}};
  const api={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(values)).map(key=>[key,clone(values[key])])),set:async patch=>Object.assign(values,clone(patch))}},
    tabs:{query:async()=>[{id:1,url:'https://x.com/viewer'}],create:async()=>({id:99,url:'https://x.com/viewer'}),update:async()=>{},get:async()=>({id:99,status:'complete',url:'https://x.com/viewer'}),remove:async()=>{}},
    scripting:{executeScript:async({func})=>[{result:func.name==='readQueueViewerOnPage'?'viewer':clone(profile)}]}};
  const runtime=createFollowQueueRuntime({api,store,wait:async()=>{},
    performFollow:async()=>assert.fail('comment retries must never follow again'),
    fetchProfile:async()=>({status:200,json:{rest_id:TARGET,core:{screen_name:HANDLE},relationship_counts:{followers:1000,following:1000},relationship_perspectives:{following:true,followed_by:true}}}),
    generateComment:async(handle,posts,name,options)=>{
      state.generationEntries++;state.engine=clone(options.commentEngine);
      return requestGrokComment(handle,posts,name,{...options,
        askers:[async()=>{state.writerCalls++;return {ok:true,reply,selectedIndex:1,language:'en',channel:'fixture'};}]
      });
    },
    replyPublisher:{verify:async()=>null,publish:async()=>{state.publishes++;assert.fail('this fixture is draft-only');}}
  });
  return {runtime,state,job,grant};
}

for(const sample of [
  {name:'religious profile',bio:'يا الله لك الحمد'},
  {name:'military source post',postText:'We discuss war in the region and the practical conditions of reconstruction.'},
  {name:'political source post',postText:'讨论中共相关政治主张的实际条件与公开资料。'}
])test(`authorized follow-back skip reaches its dedicated comment engine despite a ${sample.name}`,async()=>{
  const {runtime,state,job,grant}=setup(sample);
  assert.equal(hasAuthorizedFanGrant(grant,OWNER,TARGET,HANDLE,{requireTargetUserId:true}),true);
  const result=await runtime.handle({cmd:'followQueueRetryEvaluation',accountId:OWNER,jobId:job.id,taskId:'comment-task',publish:false});
  assert.equal(state.writerCalls,1,'a verified fan grant plus persisted skip setting must bypass account/source topic admission gates, including those inside the writer');
  assert.equal(state.generationEntries,1);assert.equal(state.engine.provider,'codex');assert.equal(state.engine.botId,'comment-session');
  assert.equal(result.evaluation.status,'draft');assert.equal(state.publishes,0);
});

test('a grant from another owner cannot use the persisted follow-back skip setting',async()=>{
  const {runtime,state,job,grant}=setup({bio:'يا الله لك الحمد',grantOwner:'another-owner'});
  assert.equal(hasAuthorizedFanGrant(grant,OWNER,TARGET,HANDLE,{requireTargetUserId:true}),false);
  try{await runtime.handle({cmd:'followQueueRetryEvaluation',accountId:OWNER,jobId:job.id,taskId:'comment-task',publish:false});}catch{}
  assert.equal(state.writerCalls,0);assert.equal(state.publishes,0);
});

test('bypassing source admission never turns an empty model response into a valid comment',async()=>{
  const {runtime,state,job}=setup({reply:''});
  const result=await runtime.handle({cmd:'followQueueRetryEvaluation',accountId:OWNER,jobId:job.id,taskId:'comment-task',publish:false});
  assert.equal(state.writerCalls,1);assert.notEqual(result.evaluation.status,'posted');assert.notEqual(result.evaluation.status,'published');
  assert.equal(result.evaluation.text,'');assert.equal(state.publishes,0);
});
