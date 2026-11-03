import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {createFanGrant,reviewSettingsKey,readRemovalTombstones} from '../src/features/relationships/follow-review-engine.js';
globalThis.IDBKeyRange=IDBKeyRange;

async function fixture({users=[{}],skip=false,configured=true,tagDecision='pass',pending=false,onTag,onFetch}={}) {
  const owner='100',values={followQueueBinding:{accountId:owner,handle:'owner',activated:true,sources:{fans:true,mutual:true}},monitor:{users:[],queue:[],followingUsers:[]}};
  values[reviewSettingsKey(owner)]={initialReviewEnabled:false,followBackSkipRules:skip,ratioLimit:10,
    queueTagging:configured?{provider:'codex',botId:'tag-session',batchSize:10,intervalSeconds:0}:{},commentEngine:{provider:'codex',botId:'comment-session'}};
  const store=createFollowQueueStore({indexedDB,dbName:'review-runtime-'+crypto.randomUUID()});
  await store.saveSettings(owner,{enabled:false,minFollowers:0,ratioThreshold:.99,blueVerifiedOnly:false,grokEnabled:false,batchLimit:10,inspectLimit:20,scrollRounds:0,dwellSeconds:2});
  const profiles=new Map(),jobs=[],calls={tagging:[],follow:[],remove:[],opened:[]},tabs=new Map();let tabId=10;
  for(const [index,user] of users.entries()) {
    const id=String(index+200),handle='person_'+index;
    const profile={id,handle,name:'Person '+index,bio:'Software engineering and practical observations.',followersText:'100',followingText:'70',is_blue_verified:false,
      relationship:{following:false,followedBy:true},posts:[{url:`https://x.com/${handle}/status/${index+900}`,text:'A detailed example about reliable systems and practical testing.',textComplete:true,isPinned:false,
        replyCount:10,repostCount:10,likeCount:10,bookmarkCount:10}],...user};
    const fanGrant=user.grant===false ? null : createFanGrant({accountId:owner,targetUserId:id,handle,source:'initial-review-disabled'});
    values.profileCache||={};
    values.profileCache[handle]={...structuredClone(profile),profileObservedAt:Date.now(),
      profileEvidence:{ownerAccountId:owner,targetUserId:id,fields:{bio:Date.now()}},
      fanInspectionTimeline:{ownerAccountId:owner,targetUserId:id,fetchedAt:Date.now(),status:'ready',posts:profile.posts}};
    profiles.set(handle,profile);values.monitor.users.push({...profile,accountId:owner,fanGrant,fanReview:{state:'approved',ownerAccountId:owner,targetUserId:id,grant:fanGrant}});
    jobs.push(await store.enqueue({accountId:owner,targetUserId:id,handle,sources:[{module:'fans',enabled:true}],...(fanGrant?{fanGrant}:{})}));
  }
  const api={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(values)).map(key=>[key,structuredClone(values[key])])),
    set:async patch=>Object.assign(values,structuredClone(patch))}},alarms:{clear:async()=>{},getAll:async()=>[],create:async()=>{}},
    tabs:{query:async()=>[{id:1,url:'https://x.com/owner'}],create:async options=>{calls.opened.push(options.url);const tab={id:++tabId,...options,status:'complete'};tabs.set(tab.id,tab);return tab;},
      get:async id=>tabs.get(id) || {id,url:'https://x.com/owner',status:'complete'},remove:async id=>tabs.delete(id),update:async(id,options)=>Object.assign(tabs.get(id),options)},
    scripting:{executeScript:async({func,args,target})=>[{result:func.name==='readProfileBundle'?structuredClone(profiles.get(args[0])):
      func.name==='readQueueViewerOnPage'?'owner':func.name==='simulateProfileScrollStep'?null:structuredClone(profiles.get(tabs.get(target.tabId)?.url.split('/').pop()))}]}};
  const runtimeOptions={api,store,wait:async()=>{},
    fetchProfile:async(_tab,handle)=>{const override=await onFetch?.(handle);if(override)return override;const p=profiles.get(handle);return {status:200,json:{data:{user:{result:{rest_id:p.id,legacy:{screen_name:handle,name:p.name,description:p.bio,
      followers_count:Number(p.followersText),friends_count:Number(p.followingText),following:p.relationship.following,followed_by:p.relationship.followedBy},is_blue_verified:p.is_blue_verified}}}}};},
    tagging:async options=>{calls.tagging.push(structuredClone({...options,onRelayJobCreated:undefined,beforeSubmit:undefined}));
      const overridden=await onTag?.(options,{values,profiles,store,jobs});if(overridden)return overridden;
      if(pending){await options.onRelayJobCreated({id:'existing-ai-task'});return {ok:false,pending:true,relayJobId:'existing-ai-task',error:'waiting',results:[]};}
      return {ok:true,results:options.items.map(item=>({handle:item.handle,targetUserId:item.targetUserId,valid:true,decision:tagDecision,tags:tagDecision==='remove'?['政治主张']:[],reason:tagDecision,evidence:[]}))};},
    performFollow:async(_tab,target)=>{calls.follow.push(target.id);return {status:200};},
    removeFollower:async options=>{calls.remove.push(options.targetId);await options.checkpoint({attemptedAt:Date.now(),targetUserId:options.targetId});
      return {attempted:true,removed:true,live:{relationship:{following:false,followedBy:false}}};}};
  const runtime=createFollowQueueRuntime(runtimeOptions);
  return {runtime,store,jobs,calls,values,profiles,owner,api,reopen:()=>createFollowQueueRuntime(runtimeOptions)};
}

test('queue submits several locally eligible people in one dedicated tagging request before following',async()=>{
  const f=await fixture({users:[{},{},{}]});await f.runtime.run(true);
  assert.equal(f.calls.tagging.length,1);assert.equal(f.calls.tagging[0].role,'queueTagging');assert.equal(f.calls.tagging[0].roleConfig.botId,'tag-session');
  assert.equal(f.calls.tagging[0].items.length,3);assert.equal(f.calls.opened.length,3,'only execution opens profiles; batch assembly is local');assert.equal(f.calls.follow.length,3);assert.equal(f.calls.remove.length,0);
  for(const job of f.jobs)assert.equal((await f.store.get(job.id)).state,'followed');
});

test('local hard content and excessive following counts remove before spending AI tokens',async()=>{
  const f=await fixture({users:[{bio:'يا الله لك الحمد'},{followersText:'7',followingText:'320'}]});await f.runtime.run(true);
  assert.equal(f.calls.tagging.length,0);assert.equal(f.calls.follow.length,0);assert.equal(f.calls.remove.length,2);
  for(const job of f.jobs){assert.equal((await f.store.get(job.id)).state,'skipped');assert.equal((await f.store.get(job.id)).followResult.followerRemoval.removed,true);}
  assert.equal(Object.keys(await readRemovalTombstones(f.api.storage.local,f.owner)).length>0,true);
  assert.equal(f.values.monitor.users.every(user=>user.fanReview?.state==='removed'),true);
});

test('AI hard exclusion removes and records the follower without returning to manual review',async()=>{
  const f=await fixture({tagDecision:'remove'});await f.runtime.run(true);
  assert.equal(f.calls.tagging.length,1);assert.equal(f.calls.remove.length,1);assert.equal(f.calls.follow.length,0);
  assert.equal(f.values.monitor.users[0].fanReview.state,'removed');
});

test('verified fan bypass ignores hard topics, ratio, blue V and minimum counts without tagging',async()=>{
  const f=await fixture({skip:true,configured:false,users:[{bio:'يا الله لك الحمد',followersText:'1',followingText:'500',is_blue_verified:false}]});
  await f.store.saveSettings(f.owner,{blueVerifiedOnly:true,minFollowers:10000});await f.runtime.run(true);
  assert.equal(f.calls.tagging.length,0);assert.equal(f.calls.remove.length,0);assert.equal(f.calls.follow.length,1);
});

test('an unconfigured queue tagging role fails closed while legacy allowance cannot bypass it',async()=>{
  const f=await fixture({configured:false});await f.store.saveSettings(f.owner,{followBackAllowAll:true});await f.runtime.run(true);
  assert.equal(f.calls.follow.length,0);assert.equal(f.calls.remove.length,0);assert.equal(f.calls.tagging.length,0);
  assert.equal((await f.store.get(f.jobs[0].id)).state,'retry');
});

test('a pending AI batch persists one receipt for every member and resumes the original task',async()=>{
  const f=await fixture({users:[{},{}],pending:true});await f.runtime.run(true);
  assert.equal(f.calls.follow.length,0);
  assert.equal(f.calls.tagging.length,1,'one pending batch must not be polled again for each queued member');
  for(const job of f.jobs)assert.equal((await f.store.get(job.id)).followResult.queueScreening.relayJobId,'existing-ai-task');
  assert.equal(f.calls.tagging.every(call=>!call.relayJobId || call.relayJobId==='existing-ai-task'),true);
});

test('turning off or replacing an AI role cannot redirect recovery of its already submitted batch',async()=>{
  let pending=true;
  const f=await fixture({onTag:async options=>{
    if(pending){await options.onRelayJobCreated({id:'frozen-task'});return {ok:false,pending:true,relayJobId:'frozen-task',results:[]};}
    assert.equal(options.relayJobId,'frozen-task');assert.equal(options.roleConfig.botId,'tag-session');
  }});
  await f.runtime.run(true);const first=await f.store.get(f.jobs[0].id);
  f.values[reviewSettingsKey(f.owner)].queueTagging={};pending=false;
  f.values['followQueueScreeningBatch:'+f.owner+':'+first.followResult.queueScreening.batchId].nextPollAt=0;
  await f.store.resolveJob({accountId:f.owner,id:first.id,state:'pending',nextEligibleAt:0});
  await f.reopen().run(true);assert.equal(f.calls.follow.length,1);
  assert.equal(f.calls.tagging.length,2);assert.equal(f.calls.tagging[1].relayJobId,'frozen-task');
});

test('a manual return to review during AI generation prevents the later follow',async()=>{
  const f=await fixture({onTag:async(_options,{values})=>{values.monitor.users[0].fanReview={state:'review',ownerAccountId:'100',targetUserId:'200',reason:'manual hold'};}});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,0);assert.equal(f.calls.remove.length,0);
});

test('an owner change during tagging cannot write results or act for the new owner',async()=>{
  const f=await fixture({onTag:async(_options,{values})=>{values.followQueueBinding={accountId:'different-owner',handle:'other',activated:true};}});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,0);assert.equal(f.calls.remove.length,0);
  assert.equal((await f.store.list({accountId:'different-owner'})).length,0);
});

test('a recycled handle discovered after AI completion never causes a follow',async()=>{
  const f=await fixture({onTag:async(_options,{profiles})=>{profiles.get('person_0').id='99999';}});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,0);assert.equal(f.calls.remove.length,0);
  assert.equal((await f.store.get(f.jobs[0].id)).state,'uncertain');
});

test('queue evidence is limited to the first ten authored nonpinned posts',async()=>{
  const posts=Array.from({length:11},(_,i)=>({url:`https://x.com/person_0/status/${1000+i}`,text:i===10?'يا الله لك الحمد':'A practical software observation '+i,textComplete:true,isPinned:false}));
  const f=await fixture({users:[{posts}]});await f.runtime.run(true);
  assert.equal(f.calls.remove.length,0);assert.equal(f.calls.follow.length,1);assert.equal(f.calls.tagging[0].items[0].posts.length,10);
});

const retainedBatches=values=>Object.entries(values).filter(([key,value])=>key.startsWith('followQueueScreeningBatch:') && value?.items?.length);

for(const nativeRemove of [false,true])test(`fully persisted tagging batches release full profile snapshots: native remove=${nativeRemove}`,async()=>{
  const f=await fixture({users:[{},{}]});let removals=0;
  if(nativeRemove)f.api.storage.local.remove=async key=>{removals++;delete f.values[key];};
  await f.runtime.run(true);
  assert.equal(f.calls.tagging.length,1);assert.equal(f.calls.follow.length,2);assert.equal(retainedBatches(f.values).length,0);
  if(nativeRemove)assert.equal(removals,1);
  for(const job of f.jobs)assert.equal((await f.store.get(job.id)).followResult.queueScreening.phase,'complete');
});

test('a pending tagging task keeps its frozen inputs and receipt for recovery',async()=>{
  const f=await fixture({users:[{},{}],pending:true});await f.runtime.run(true);
  const retained=retainedBatches(f.values);assert.equal(retained.length,1);
  assert.equal(retained[0][1].items.length,2);assert.equal(retained[0][1].relayJobId,'existing-ai-task');
  assert.equal(retained[0][1].receivedTagging,undefined);assert.equal(f.calls.follow.length,0);
});

test('a result received before a failed checkpoint is recovered locally after restart without another AI request',async()=>{
  const f=await fixture(),settle=f.store.settle.bind(f.store);let failures=0;
  f.store.settle=async options=>{
    if(!failures && options.patch?.followResult?.queueScreening?.phase==='complete'){failures++;throw Error('simulated checkpoint failure after paid AI result');}
    return settle(options);
  };
  await f.runtime.run(true);assert.equal(failures,1);assert.equal(f.calls.follow.length,0);assert.equal(f.calls.tagging.length,1);
  const retained=retainedBatches(f.values);assert.equal(retained.length,1);assert.equal(retained[0][1].receivedTagging.ok,true);
  assert.equal(retained[0][1].receivedTagging.results[0].targetUserId,'200');
  f.store.settle=settle;
  await f.store.resolveJob({accountId:f.owner,id:f.jobs[0].id,state:'pending',nextEligibleAt:0});
  await f.reopen().run(true);
  assert.equal(f.calls.tagging.length,1,'the saved parsed result must not generate or poll again');
  assert.equal(f.calls.follow.length,1);assert.equal(retainedBatches(f.values).length,0);
});

test('a failed lookahead checkpoint retains the received batch until every member is saved',async()=>{
  const f=await fixture({users:[{},{}]}),patch=f.store.patchQueueScreening.bind(f.store);let rejected=0;
  await f.store.saveSettings(f.owner,{inspectLimit:1});
  f.store.patchQueueScreening=async options=>options.screening.phase==='complete' && !rejected++ ? {ok:false,reason:'simulated interrupted write'} : patch(options);
  await f.runtime.run(true);assert.equal(f.calls.tagging.length,1);assert.equal(f.calls.follow.length,1);
  const retained=retainedBatches(f.values);assert.equal(retained.length,1);assert.equal(retained[0][1].receivedTagging.ok,true);
  f.store.patchQueueScreening=patch;await f.store.saveSettings(f.owner,{inspectLimit:10});
  await f.reopen().run(true);assert.equal(f.calls.tagging.length,1);assert.equal(f.calls.follow.length,2);assert.equal(retainedBatches(f.values).length,0);
});

for(const invalid of ['missing','stale','owner','identity'])test('batch lookahead does not open a profile for '+invalid+' cached evidence',async()=>{
  const f=await fixture({users:[{},{},{}],pending:true});
  for(const handle of ['person_0','person_1','person_2']){
    const cached=f.values.profileCache[handle];
    if(invalid==='missing')delete f.values.profileCache[handle];
    if(invalid==='stale')cached.profileObservedAt=Date.now()-7*60*60*1000;
    if(invalid==='owner')cached.profileEvidence.ownerAccountId='999';
    if(invalid==='identity')cached.id='999';
  }
  await f.store.saveSettings(f.owner,{inspectLimit:1});await f.runtime.run(true);
  assert.equal(f.calls.opened.length,1);assert.equal(f.calls.tagging[0].items.length,1);
});
test('access cooling preserves retry allowance and ends the round before opening another profile',async()=>{
  const f=await fixture({users:[{},{}]});const retryAt=Date.now()+900000;
  f.api.accessBudget={reserve:async()=>({allowed:false,retryAt})};
  await f.runtime.run(true);
  const states=await Promise.all(f.jobs.map(j=>f.store.get(j.id)));const job=states.find(j=>j.state==='retry');
  assert.ok(job);assert.equal(job.followResult?.retryCount||0,0);assert.equal(job.nextEligibleAt,retryAt);
  assert.equal(f.calls.opened.length,0);assert.equal(f.calls.follow.length,0);
  assert.equal(states.filter(j=>j.state==='pending').length,1);
});


test('approved fans bypass duplicate review even when they no longer follow, including merged sources',async()=>{
 for(const mixed of [false,true]){
  const f=await fixture({skip:true,configured:false,users:[{relationship:{following:false,followedBy:false}}]});
  if(mixed)await f.store.enqueue({accountId:f.owner,handle:'person_0',targetUserId:'200',sources:[{module:'mutual',enabled:true}]});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,1);assert.equal(f.calls.tagging.length,0);assert.equal(f.calls.remove.length,0);
  assert.equal((await f.store.get(f.jobs[0].id)).followResult.relationshipDecision.code,'approved-fan');
 }
});

test('approved fan follows before optional post scrolling and keeps success if post collection fails',async()=>{
 const f=await fixture({skip:true,configured:false});await f.store.saveSettings(f.owner,{grokEnabled:true,scrollRounds:2});
 const original=f.api.scripting.executeScript;let reads=0;
 f.api.scripting.executeScript=async request=>{
  if(request.func.name==='readProfileBundle'&&!f.calls.follow.length){assert.equal(request.args[1],0);reads++;}
  if(request.func.name==='simulateProfileScrollStep'){assert.equal(f.calls.follow.length,1);throw Error('optional post collection failed');}
  return original(request);
 };
 await f.runtime.run(true);assert.ok(reads>0);assert.equal(f.calls.follow.length,1);assert.equal((await f.store.get(f.jobs[0].id)).state,'followed');assert.equal(f.calls.tagging.length,0);
});

for(const state of ['following','pending','not_found','suspended'])test('fresh submit-time profile state prevents duplicate or unavailable follow: '+state,async()=>{
  const f=await fixture({skip:true});const execute=f.api.scripting.executeScript;let reads=0;
  f.api.scripting.executeScript=async args=>{
    const output=await execute(args);
    if(args.func.name==='readProfileBundle' && ++reads===2){
      if(state==='following')output[0].result.relationship.following=true;
      else if(state==='pending')output[0].result.pendingRequestUserId='200';
      else output[0].result={pending:false,status:state,reason:state,posts:[]};
    }
    return output;
  };
  await f.runtime.run(true);
  assert.equal(f.calls.follow.length,0);
  const job=await f.store.get(f.jobs[0].id);
  assert.equal(job.state,state==='following'?'followed':state==='pending'?'uncertain':'excluded');
  if(state==='pending')assert.equal(job.followResult.followRequestPending,true);
});

for(const code of [50,63])for(const phase of ['initial','submit'])test(`unavailable API account terminates at ${phase}, code ${code}`,async()=>{
  let reads=0;
  const f=await fixture({skip:true,onFetch:async()=>++reads===(phase==='initial'?1:2)?{status:200,json:{errors:[{code}]}}:null});
  await f.runtime.run(true);
  assert.equal(f.calls.follow.length,0);
  const job=await f.store.get(f.jobs[0].id);
  assert.equal(job.state,'excluded');assert.equal(job.followResult.availability,code===50?'not_found':'suspended');
});

test('missing API relationship uses target follow button without requiring reverse follow evidence',async()=>{
  const f=await fixture({skip:true,users:[{relationship:{following:false,followedBy:null}}],onFetch:async()=>({status:200,json:{rest_id:'200',legacy:{screen_name:'person_0',name:'Person',followers_count:100,friends_count:70}}})});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,1);assert.equal(f.calls.tagging.length,0);
});

test('reverse-follow changes during queue review do not invalidate admission or repeat AI',async()=>{
  const f=await fixture({onTag:async(_options,{profiles})=>{profiles.get('person_0').relationship.followedBy=false;}});
  await f.runtime.run(true);
  assert.equal(f.calls.tagging.length,1);assert.equal(f.calls.follow.length,1);
  assert.equal((await f.store.get(f.jobs[0].id)).state,'followed');
});
