import test from 'node:test';
import assert from 'node:assert/strict';
import {createFollowReviewBackground,fanInitialReviewKey,FOLLOW_REVIEW_COMMANDS} from '../src/features/relationships/follow-review-background.js';
import {reviewSettingsKey,removalTombstonesKey} from '../src/features/relationships/follow-review-engine.js';
import {canonicalValue} from '../src/features/records/record-repository.js';

const clone=value=>structuredClone(value);
const owner='123',otherOwner='456';
const candidate=(handle='first',id='100')=>({handle,targetUserId:id,sources:[{module:'fans',enabled:true}],profile:{bio:'caller data'}});
const user=(handle='first',id='100',extra={})=>({accountId:owner,module:'fans',sourceKey:'monitor',sourcePath:['monitor','users',handle],
  userKey:'monitor/users/'+handle,handle,payload:{handle,id,bio:'public description',relationship:{following:false,followedBy:true},...extra}});
function fixture({rows=[user()],settings={},jobs=[],generate,migrate,allowUnassigned,verifyRelationship,removeFollower,binding={activated:true,accountId:owner}}={}) {
  const values={[reviewSettingsKey(owner)]:clone({removalRules:{blockSuggestive:true,blockEmpty:true},...settings})},changes=[],calls=[],waits=[];
  let currentBinding=clone(binding),migrationCalls=0;
  const storage={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,clone(values[key])])),set:async patch=>Object.assign(values,clone(patch))};
  const records={ready:async()=>({cutover:true}),lookupAll:async({sourceKey,bucket,handle})=>clone(rows.filter(row=>row.sourceKey===sourceKey&&row.sourcePath[1]===bucket&&row.handle===handle)),
    batch:async({changes:incoming})=>{
      for(const change of incoming){
        canonicalValue(change.patch); // Same strict journal boundary as the real record service.
        const row=rows.find(row=>row.accountId===change.accountId&&row.userKey===change.userKey);
        if(!row)throw Error('source missing');
        if(change.expectedTargetUserId!==row.payload.id){const e=Error('identity conflict');e.name='RecordIdentityConflictError';throw e;}
        if(change.expectedFanReviewVersion!==(Number(row.payload.fanReview?.decisionVersion)||0)){const e=Error('review conflict');e.name='RecordReviewConflictError';throw e;}
        row.payload={...row.payload,...clone(change.patch)};changes.push(clone(change));
      }
      return {updated:incoming.length};
    }};
  const service={status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[{id:'fan-session'},{id:'replacement-session'}],
    generate:async(prompt,options)=>{calls.push({prompt,options});return generate?generate(prompt,options):{ok:true,text:JSON.stringify(rows.filter(row=>row.payload.fanReview?.state==='initial').map(row=>({handle:row.handle,targetUserId:row.payload.id,decision:'pass'})))};},
    resume:async id=>{calls.push({resume:id});return generate?generate('',{relayJobId:id}):{ok:true,text:JSON.stringify(rows.filter(row=>row.payload.fanReview?.state==='initial').map(row=>({handle:row.handle,targetUserId:row.payload.id,decision:'pass'})))};}};
  const store={lookup:async({accountId,handle,targetUserId})=>clone(jobs.find(job=>job.accountId===accountId&&job.handle===handle&&(!targetUserId||job.targetUserId===targetUserId)))};
  const create=()=>createFollowReviewBackground({storage,records,store,readBinding:async()=>clone(currentBinding),getService:()=>service,
    allowUnassigned,verifyRelationship,removeFollower,wait:async milliseconds=>waits.push(milliseconds),migrate:async active=>{migrationCalls++;await migrate?.(active);}});
  return {rows,values,storage,records,store,service,changes,calls,waits,create,binding:()=>clone(currentBinding),setBinding:value=>{currentBinding=clone(value);},migrationCalls:()=>migrationCalls};
}
const enabled={initialReviewEnabled:true,fanTagging:{provider:'codex',botId:'fan-session',batchSize:10,intervalSeconds:0}};

test('missing user ID remains a verification candidate and is resolved by read-only handle inspection',async()=>{
 const rows=[user('first','')],seen=[];
 const f=fixture({rows,settings:enabled,verifyRelationship:async item=>{seen.push(item);rows[0].payload.id='100';rows[0].payload.fanReview={state:'review'};}});
 f.records.fanInspectionTargets=async()=>['first'];
 const coordinator=f.create(),items=await coordinator.automaticCandidates(owner,'verify');
 assert.equal(items.length,1);assert.equal(items[0].needsIdentity,true);
 assert.equal((await coordinator.automaticVerify(owner,items[0])).ready,true);
 assert.equal(seen.length,1);assert.equal(seen[0].targetUserId,'');assert.equal(f.calls.length,0);
});

test('legacy removal holds remain available to the automatic removal queue, never AI or verification',async()=>{
 const receipt={attempted:true,attemptedAt:1,removed:false};
 const rows=[user('rejected','100',{fanReview:{state:'review',decision:'remove',reasonCode:'ai_rejected',removalReceipt:receipt},followerRemoval:receipt})];
 const f=fixture({rows,settings:enabled,jobs:[{accountId:owner,handle:'rejected',targetUserId:'100',state:'uncertain',followResult:{followerRemoval:receipt}}]});
 f.records.fanInspectionTargets=async()=>['rejected'];
 const result=await f.create().automaticCandidates(owner,'review');assert.equal(result.length,1);assert.equal(result[0].removalPending,true);assert.equal(f.calls.length,0);
 assert.deepEqual(await f.create().automaticCandidates(owner,'verify'),[]);
});

test('pending legacy receipts isolate frozen identities without starving unrelated automatic reviews',async()=>{
  const rows=[user('waiting','100',{fanReview:{state:'initial'}}),user('ready','200',{fanReview:{state:'review'}})];
  const f=fixture({rows,settings:enabled});
  f.records.fanInspectionTargets=async()=>rows.map(row=>row.handle);
  f.values[fanInitialReviewKey(owner)]={batches:{old:{id:'old',phase:'pending',items:[{handle:'waiting',targetUserId:'100'}]}}};
  const candidates=await f.create().automaticCandidates(owner,'review');
  assert.deepEqual(candidates.map(item=>item.targetUserId),['200']);
  assert.equal(f.calls.length,0);
  assert.equal(f.values[fanInitialReviewKey(owner)].batches.old.phase,'pending');
});

test('unbound settings/status are readonly defaults; all writes fail without identity navigation',async()=>{
  const f=fixture({binding:null}),adapter=f.create();
  assert.equal(FOLLOW_REVIEW_COMMANDS.length,6);
  assert.deepEqual(await adapter.handle({cmd:'followQueueFanReviewStatus'}),{ok:true,batch:null,requiresActivation:true});
  const settings=await adapter.handle({cmd:'followQueueReviewSettings'});
  assert.equal(settings.settings.initialReviewEnabled,false);assert.equal(settings.settings.followBackSkipRules,false);
  await assert.rejects(adapter.handle({cmd:'followQueueSaveReviewSettings',settings:{initialReviewEnabled:true}}),/确认/);
  assert.equal(f.migrationCalls(),0);assert.equal(f.changes.length,0);assert.equal(f.calls.length,0);
});

test('account scoped settings patches retain the other roles and reject mismatched account',async()=>{
  const f=fixture({settings:{commentEngine:{provider:'codex',botId:'comment-session',prompt:'writer'}}}),adapter=f.create();
  const saved=await adapter.handle({cmd:'followQueueSaveReviewSettings',settings:{fanTagging:{provider:'codex',botId:'fan-session'}}});
  assert.equal(saved.settings.commentEngine.botId,'comment-session');
  assert.equal(saved.settings.fanTagging.botId,'fan-session');
  await assert.rejects(adapter.handle({cmd:'followQueueSaveReviewSettings',accountId:otherOwner,settings:{}}),/归属/);
});

test('disabled initial review grants a trusted list identity without filtering or fabricating relationship facts',async()=>{
  const original=user('first','100',{bio:'political religious military',relationship:{},relationshipObservedAt:100});
  const f=fixture({rows:[original]}),adapter=f.create();
  const result=await adapter.gateCandidates(f.binding(),[candidate()]);
  assert.equal(result.length,1);assert.equal(result[0].fanGrant.source,'initial-review-disabled');
  assert.equal(result[0].fanGrant.ownerAccountId,owner);assert.equal(result[0].fanGrant.targetUserId,'100');
  assert.deepEqual(f.rows[0].payload.relationship,{});assert.equal(f.rows[0].payload.relationshipObservedAt,100);
  assert.equal(f.calls.length,0);assert.equal(f.migrationCalls(),1);
  await adapter.gateCandidates(f.binding(),[candidate()]);assert.equal(f.migrationCalls(),1);
});

test('disabling initial review never releases existing review holds through fans or ordinary sources',async()=>{
  const f=fixture({rows:[user('first','100',{fanReview:{state:'review',ownerAccountId:owner,targetUserId:'100',decisionVersion:2}})]});
  const spoof={...candidate(),fanGrant:{ownerAccountId:owner,targetUserId:'100',source:'initial-review-disabled'},fanReview:{state:'approved'}};
  for(const item of [spoof,{...spoof,sources:[{module:'comments',enabled:true}]}]) assert.deepEqual(await f.create().gateCandidates(f.binding(),[item]),[]);
  assert.equal(f.rows[0].payload.fanReview.state,'review');assert.equal(f.changes.length,0);
});

test('all sources respect exclusion tombstones and unresolved external action receipts',async()=>{
  const f=fixture();
  f.values[removalTombstonesKey(owner)]={byId:{'100':{state:'removed',targetUserId:'100',accountId:owner}},byHandle:{}};
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[{...candidate(),sources:[{module:'mutual'}]}]),[]);
  delete f.values[removalTombstonesKey(owner)];
  f.rows[0].payload.followerRemoval={attemptedAt:10,targetUserId:'100',removed:false};
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);
  assert.equal(f.calls.length,0);
});

test('fan tagging submits a real multi-user batch using descriptions and auto releases only a valid pass',async()=>{
  const rows=[user(),user('second','200'),user('third','300')];
  const f=fixture({rows,settings:enabled,generate:async(prompt,options)=>{
    assert.match(prompt,/public description/);assert.doesNotMatch(prompt,/caller data|recentPosts/);
    await options.onJobCreated?.({id:'local:three-people',createdAt:10});
    return {ok:true,jobId:'local:three-people',text:JSON.stringify([
      {handle:'first',targetUserId:'100',decision:'pass',tags:['normal']},
      {handle:'second',targetUserId:'200',decision:'review',tags:['religion'],reason:'description evidence'},
      {handle:'third',targetUserId:'300',decision:'uncertain',reason:'not enough data'}])};
  }});
  const result=await f.create().gateCandidates(f.binding(),[candidate(),candidate('second','200'),candidate('third','300')]);
  assert.equal(f.calls.length,1);assert.deepEqual(result.map(item=>item.handle),['first','third']);
  assert.equal(rows[0].payload.fanReview.state,'approved');assert.equal(rows[1].payload.fanReview.state,'failed');
  assert.equal(rows[2].payload.fanReview.state,'approved');assert.equal(rows[2].payload.fanReview.originalAiVerdict.decision,'uncertain');
  assert.equal(rows[0].payload.fanGrant.source,'initial-ai-pass');
});

test('missing dedicated initial engine is a failed initial review, not an AI pass or content violation',async()=>{
  const f=fixture({settings:{initialReviewEnabled:true}});
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);
  assert.equal(f.rows[0].payload.fanReview.state,'failed');assert.equal(f.rows[0].payload.fanGrant,null);assert.equal(f.calls.length,0);
});

test('initial tagging chunks the complete selection and waits only between chunks',async()=>{
  const rows=[user(),user('second','200'),user('third','300')];
  const f=fixture({rows,settings:{...enabled,fanTagging:{...enabled.fanTagging,batchSize:2,intervalSeconds:4,intervalMaxSeconds:4}}});
  const result=await f.create().gateCandidates(f.binding(),rows.map(row=>candidate(row.handle,row.payload.id)));
  assert.equal(result.length,3);assert.equal(f.calls.length,2);assert.deepEqual(f.waits,[4000]);
});

test('late AI cannot override a newer human decision or a same-handle replacement identity',async()=>{
  for(const change of ['manual','identity']){
    let f;
    f=fixture({settings:enabled,generate:async()=>{
      if(change==='manual') f.rows[0].payload.fanReview={state:'review',ownerAccountId:owner,targetUserId:'100',decisionVersion:99,reason:'human decision'};
      else f.rows[0].payload={handle:'first',id:'200',bio:'replacement'};
      return {ok:true,text:JSON.stringify([{handle:'first',targetUserId:'100',decision:'pass'}])};
    }});
    assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);
    if(change==='manual')assert.equal(f.rows[0].payload.fanReview.reason,'human decision');
    else {assert.equal(f.rows[0].payload.id,'200');assert.equal(f.rows[0].payload.fanReview,undefined);}
  }
});

test('late AI after owner switch cannot annotate source records belonging to the replacement owner',async()=>{
  let f;
  f=fixture({settings:enabled,generate:async()=>{
    f.setBinding({activated:true,accountId:otherOwner});f.rows[0].accountId=otherOwner;f.rows[0].payload={handle:'first',id:'200'};
    return {ok:true,text:JSON.stringify([{handle:'first',targetUserId:'100',decision:'pass'}])};
  }});
  await assert.rejects(f.create().gateCandidates(f.binding(),[candidate()]),/账号已变化/);
  assert.deepEqual(f.rows[0].payload,{handle:'first',id:'200'});
});

test('unknown submitted state without a receipt is held across worker recreation without generating again',async()=>{
  const f=fixture({settings:enabled,rows:[user('first','100',{fanReview:{state:'initial',ownerAccountId:owner,targetUserId:'100',decisionVersion:1,batchId:'unknown'}})]});
  f.values[fanInitialReviewKey(owner)]={version:1,batches:{unknown:{id:'unknown',accountId:owner,phase:'submitting',roleSnapshot:enabled.fanTagging,
    items:[{handle:'first',targetUserId:'100',decisionVersion:1}],relayJobId:''}}};
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);assert.equal(f.calls.length,0);
});

test('a pending receipt resumes its original batch and frozen session after configuration changes',async()=>{
  const f=fixture({settings:enabled});
  let submitted=0;
  f.service.generate=async(_prompt,options)=>{
    submitted++;await options.onJobCreated({id:'local:original'});return {ok:false,pending:true,jobId:'local:original',reason:'working'};
  };
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);assert.equal(submitted,1);
  f.values[reviewSettingsKey(owner)]={...enabled,fanTagging:{...enabled.fanTagging,botId:'replacement-session'}};
  const resumed=await f.create().gateCandidates(f.binding(),[candidate()]);
  assert.equal(submitted,1);assert.equal(resumed.length,1);assert.deepEqual(f.calls,[{resume:'local:original'}]);
});

test('completed AI results survive a crash before source application without spending tokens again',async()=>{
  const f=fixture({settings:enabled,rows:[user('first','100',{fanReview:{state:'initial',ownerAccountId:owner,targetUserId:'100',decisionVersion:1,batchId:'received'}})]});
  f.values[fanInitialReviewKey(owner)]={version:1,batches:{received:{id:'received',accountId:owner,phase:'applying',roleSnapshot:enabled.fanTagging,
    items:[{handle:'first',targetUserId:'100',decisionVersion:1}],relayJobId:'local:received',
    result:{ok:true,results:[{handle:'first',targetUserId:'100',decision:'pass',valid:true,tags:[],evidence:[]}]}}}};
  assert.equal((await f.create().gateCandidates(f.binding(),[candidate()])).length,1);assert.equal(f.calls.length,0);
});

test('source identity is required and unassigned legacy rows require an explicit owner allowance',async()=>{
  const f=fixture({rows:[user('first','200')]});
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);assert.equal(f.changes.length,0);
  const legacy=fixture({rows:[{...user(),accountId:'unassigned'}]});
  assert.deepEqual(await legacy.create().gateCandidates(legacy.binding(),[candidate()]),[]);
  const allowed=fixture({rows:[{...user(),accountId:'unassigned'}],allowUnassigned:async()=>true});
  assert.equal((await allowed.create().gateCandidates(allowed.binding(),[candidate()])).length,1);
  allowed.rows[0].payload.fanReview.ownerAccountId=otherOwner;
  assert.deepEqual(await allowed.create().gateCandidates(allowed.binding(),[candidate()]),[]);
});

test('a failed migration is retryable and no candidate escapes before successful readiness',async()=>{
  let failures=1;
  const f=fixture({migrate:async()=>{if(failures--)throw Error('migration failed');}}),adapter=f.create();
  await assert.rejects(adapter.gateCandidates(f.binding(),[candidate()]),/migration failed/);assert.equal(f.changes.length,0);
  assert.equal((await adapter.gateCandidates(f.binding(),[candidate()])).length,1);assert.equal(f.migrationCalls(),2);
});

test('completed initial review stores only a lightweight receipt without original descriptions or role prompts',async()=>{
  const f=fixture({rows:[user('first','100',{bio:'private original description sentinel'})],
    settings:{...enabled,fanTagging:{...enabled.fanTagging,prompt:'private role prompt sentinel'}},generate:async(_prompt,options)=>{
      await options.onJobCreated({id:'local:completed-receipt'});
      return {ok:true,jobId:'local:completed-receipt',text:JSON.stringify([{handle:'first',targetUserId:'100',decision:'pass',reason:'completed explanation sentinel'}])};
    }});
  assert.equal((await f.create().gateCandidates(f.binding(),[candidate()])).length,1);
  const state=f.values[fanInitialReviewKey(owner)];
  assert.deepEqual(state.batches,{});assert.equal(state.completedReceipts.length,1);
  assert.equal(state.completedReceipts[0].relayJobId,'local:completed-receipt');
  assert.doesNotMatch(JSON.stringify(state),/private original description|private role prompt|completed explanation/);
  assert.equal(f.rows[0].payload.fanReview.reason,'completed explanation sentinel','the full applied evidence remains in its source record');
});

test('pending initial review retains its frozen receipt, role and input without compaction',async()=>{
  const f=fixture({rows:[user('first','100',{bio:'pending original description sentinel'})],
    settings:{...enabled,fanTagging:{...enabled.fanTagging,prompt:'pending role prompt sentinel'}},generate:async(_prompt,options)=>{
      await options.onJobCreated({id:'local:pending-original',createdAt:10});
      return {ok:false,pending:true,jobId:'local:pending-original',reason:'still running'};
    }});
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);
  const state=f.values[fanInitialReviewKey(owner)],batch=Object.values(state.batches)[0];
  assert.equal(batch.phase,'pending');assert.equal(batch.relayJobId,'local:pending-original');assert.equal(batch.receipt.id,'local:pending-original');
  assert.equal(batch.roleSnapshot.botId,'fan-session');assert.equal(batch.roleSnapshot.prompt,'pending role prompt sentinel');
  assert.equal(batch.items[0].bio,'pending original description sentinel');assert.equal(batch.items[0].targetUserId,'100');
  assert.deepEqual(state.completedReceipts,[]);
});

test('completed initial review receipts are bounded to the most recent twenty tasks',async()=>{
  const f=fixture({settings:enabled}),adapter=f.create();
  for(let index=0;index<25;index++){
    const handle='new_fan_'+index,id=String(1000+index);f.rows.push(user(handle,id,{bio:'original batch description '+index}));
    assert.equal((await adapter.gateCandidates(f.binding(),[candidate(handle,id)])).length,1);
  }
  const state=f.values[fanInitialReviewKey(owner)];
  assert.deepEqual(state.batches,{});assert.equal(state.completedReceipts.length,20);
  assert.doesNotMatch(JSON.stringify(state),/original batch description/);
  assert.equal(new Set(state.completedReceipts.map(receipt=>receipt.id)).size,20);
});

test('concurrent initial checkpoint saves preserve both unresolved batches across adapter instances',async()=>{
  const f=fixture({rows:[user(),user('second','200')],settings:enabled});
  const originalGet=f.storage.get,originalSet=f.storage.set;
  f.storage.get=async keys=>{const value=await originalGet(keys);await new Promise(resolve=>setTimeout(resolve,1));return value;};
  f.storage.set=async patch=>{await new Promise(resolve=>setTimeout(resolve,1));return originalSet(patch);};
  f.service.generate=async(_prompt,options)=>{
    const input=JSON.parse(options.requestKey).items[0];await options.onJobCreated({id:'local:pending-'+input.handle});
    return {ok:false,pending:true,jobId:'local:pending-'+input.handle,reason:'running'};
  };
  await Promise.all([f.create().gateCandidates(f.binding(),[candidate()]),f.create().gateCandidates(f.binding(),[candidate('second','200')])]);
  const state=f.values[fanInitialReviewKey(owner)],batches=Object.values(state.batches);
  assert.equal(batches.length,2);assert.deepEqual(batches.map(batch=>batch.relayJobId).sort(),['local:pending-first','local:pending-second']);
  assert.ok(batches.every(batch=>batch.phase==='pending'&&batch.roleSnapshot.botId==='fan-session'&&batch.items[0].bio==='public description'));
});

test('a completed AI response blocked from source application retains its recovery payload until the source is settled',async()=>{
  const jobs=[];
  const f=fixture({settings:enabled,jobs,generate:async(_prompt,options)=>{
    await options.onJobCreated({id:'local:received-before-external-hold'});
    jobs.push({accountId:owner,handle:'first',targetUserId:'100',state:'uncertain',followResult:{attemptedAt:10}});
    return {ok:true,jobId:'local:received-before-external-hold',text:JSON.stringify([{handle:'first',targetUserId:'100',decision:'pass'}])};
  }});
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);
  let state=f.values[fanInitialReviewKey(owner)],batch=Object.values(state.batches)[0];
  assert.equal(batch.phase,'applying');assert.equal(batch.result.ok,true);assert.equal(batch.relayJobId,'local:received-before-external-hold');
  assert.equal(batch.items[0].bio,'public description');assert.deepEqual(state.completedReceipts,[]);
  jobs.length=0;
  assert.equal((await f.create().gateCandidates(f.binding(),[candidate()])).length,1);
  state=f.values[fanInitialReviewKey(owner)];assert.deepEqual(state.batches,{});assert.equal(state.completedReceipts.length,1);
  assert.equal(f.calls.length,1,'only the saved result is applied after the hold clears');
});


test('initial review treats biography as required and existing posts/counts as optional enrichment',async()=>{
 const rows=[user('first','100',{relationship:{}}),user('second','200',{followersText:'0',followingText:'10',relationship:{}}),user('empty','300',{bio:'',followersText:'500'})];
 const f=fixture({rows,settings:enabled});
 const at=Date.now();const cached={id:'200',handle:'second',profileEvidence:{ownerAccountId:owner,targetUserId:'200',fields:{}},fanInspectionTimeline:{ownerAccountId:owner,targetUserId:'200',fetchedAt:at,status:'ready',posts:[{handle:'second',url:'https://x.com/second/status/900',text:'Existing related original post',createdAt:at,textComplete:true}]}};
 f.records.lookup=async({handle})=>handle==='second'?{payload:cached}:null;
 await f.create().gateCandidates(f.binding(),rows.map(row=>candidate(row.handle,row.payload.id)));
 assert.equal(f.calls.length,1);const items=JSON.parse(f.calls[0].prompt.split('\n').find(line=>line.startsWith('[{"index":')));
 assert.equal(items.length,2);assert.equal('recentPosts' in items[0],false);assert.equal('followersText' in items[0],false);
 assert.equal(items[1].followersText,'0');assert.equal(items[1].recentPosts[0].text,'Existing related original post');
 assert.equal(rows[2].payload.fanReview.reasonCode,'missing_biography');assert.equal(rows[2].payload.fanGrant,null);
});

test('initial review with no biographies records unable-to-review without calling any AI',async()=>{
 const f=fixture({rows:[user('first','100',{bio:'',relationship:{}})],settings:{initialReviewEnabled:true}});
 await f.create().gateCandidates(f.binding(),[candidate()]);assert.equal(f.calls.length,0);assert.equal(f.rows[0].payload.fanReview.decision,'uncertain');assert.equal(f.rows[0].payload.fanReview.reasonCode,'missing_biography');
});


test('missing evidence enters verification and failed inspection waits before retrying',async()=>{
 let inspections=0;
 const f=fixture({rows:[user('first','100',{bio:''})],settings:enabled,verifyRelationship:async()=>{inspections++;throw Error('offline');}}),adapter=f.create();
 await adapter.gateCandidates(f.binding(),[candidate()]);assert.equal(f.rows[0].payload.fanReview.state,'verify');
 await adapter.gateCandidates(f.binding(),[candidate()]);const version=f.rows[0].payload.fanReview.decisionVersion;
 await adapter.gateCandidates(f.binding(),[candidate()]);assert.equal(f.rows[0].payload.fanReview.decisionVersion,version);assert.equal(f.calls.length,0);assert.equal(inspections,1);
});

test('enriched automatic initial requests split by complete input budget rather than overflowing',async()=>{
 const rows=Array.from({length:5},(_,i)=>user('person'+i,String(100+i),{bio:'x'.repeat(48000)})),f=fixture({rows,settings:enabled});
 await f.create().gateCandidates(f.binding(),rows.map(row=>candidate(row.handle,row.payload.id)));
 assert.deepEqual(f.calls.map(call=>JSON.parse(call.prompt.split('\n').find(line=>line.startsWith('[{"index":'))).length),[2,2,1]);
 assert.ok(f.calls.every(call=>call.prompt.length<100000));
});

test('one enrichment round resumes from cached posts without biography and releases only a valid pass',async()=>{
 for(const decision of ['pass','uncertain']){
  let inspections=0,cached={};
  const f=fixture({rows:[user('first','100',{bio:''})],settings:enabled,verifyRelationship:async()=>{inspections++;},
   generate:async()=>({ok:true,text:JSON.stringify([{handle:'first',targetUserId:'100',decision,tags:['developer']}])})});
  f.records.lookup=async()=>({payload:cached});
  const adapter=f.create();
  await adapter.gateCandidates(f.binding(),[candidate()]);
  assert.equal(f.rows[0].payload.fanReview.state,'verify');
  await adapter.gateCandidates(f.binding(),[candidate()]);assert.equal(inspections,1);assert.equal(f.calls.length,0);
  const at=Date.now();cached={id:'100',handle:'first',bio:'',profileEvidence:{ownerAccountId:owner,targetUserId:'100',fields:{}},
   fanInspectionTimeline:{ownerAccountId:owner,targetUserId:'100',status:'partial',fetchedAt:at,posts:[{handle:'first',url:'https://x.com/first/status/123',text:'I build useful tools'}]}};
  const result=await adapter.gateCandidates(f.binding(),[candidate()]);
  assert.equal(f.calls.length,1);assert.equal(result.length,1);assert.ok(f.rows[0].payload.fanReview.enrichmentCompletedAt);
  assert.equal(f.rows[0].payload.fanReview.state,'approved');
  await adapter.gateCandidates(f.binding(),[candidate()]);assert.equal(f.calls.length,1);assert.equal(inspections,1);
 }
});

test('keyword rejection uses protected removal and never submits AI or grants admission',async()=>{
 let removals=0;
 const f=fixture({rows:[user('first','100',{bio:'vote for our party propaganda campaign'})],settings:enabled,
  removeFollower:async item=>{removals++;return {...item,attempted:true,removed:true,verifiedAt:Date.now()};}});
 const adapter=f.create();assert.deepEqual(await adapter.gateCandidates(f.binding(),[candidate()]),[]);
 assert.equal(removals,1);assert.equal(f.calls.length,0);assert.equal(f.rows[0].payload.fanReview.state,'removed');
 assert.equal(f.rows[0].payload.relationship.followedBy,false);
 await adapter.gateCandidates(f.binding(),[candidate()]);assert.equal(removals,1);
});

test('uncertain removal receipt blocks retries and keeps the actual relationship',async()=>{
 let removals=0;
 const f=fixture({rows:[user('first','100',{bio:'vote for our party propaganda'})],settings:enabled,
  removeFollower:async item=>{removals++;return {...item,attempted:true,attemptedAt:Date.now(),removed:false,reason:'unknown'};}});
 const adapter=f.create();await adapter.gateCandidates(f.binding(),[candidate()]);await adapter.gateCandidates(f.binding(),[candidate()]);
 assert.equal(removals,1);assert.equal(f.rows[0].payload.relationship.followedBy,true);assert.equal(f.calls.length,0);
});

test('unclaimed reserved batches are compacted on recovery and fresh admission remains canonical',async()=>{
 const f=fixture({settings:enabled});f.values[fanInitialReviewKey(owner)]={version:1,batches:{orphan:{id:'orphan',accountId:owner,phase:'reserved',items:[{handle:'first',targetUserId:'100',decisionVersion:1}],roleSnapshot:enabled.fanTagging}}};
 const result=await f.create().gateCandidates(f.binding(),[candidate()]);assert.equal(result.length,1);assert.equal(f.calls.length,1);
 assert.equal(f.values[fanInitialReviewKey(owner)].batches.orphan,undefined);assert.equal(f.rows[0].payload.fanReview.enrichmentCompletedAt,0);
 assert.doesNotThrow(()=>canonicalValue(f.rows[0].payload.fanReview));
});

test('historical machine skip permits cached-post re-review and reopens only after a fresh pass',async()=>{
 for(const decision of ['pass','uncertain']){
  const job={id:'job',accountId:owner,handle:'first',targetUserId:'100',state:'skipped',followResult:{reason:'machine rule',relationshipDecision:{screening:'blocked',screeningReason:'machine rule'}}};
  const f=fixture({jobs:[job],rows:[user('first','100',{bio:'',fanReview:{state:'review',decision:'uncertain',source:'manual-ai-no-profile',reasonCode:'missing_biography',decisionVersion:1}})],settings:enabled,
   verifyRelationship:async()=>{},generate:async()=>({ok:true,text:JSON.stringify([{handle:'first',targetUserId:'100',decision}])})});
  f.records.lookup=async()=>({payload:{id:'100',handle:'first',bio:'',profileEvidence:{ownerAccountId:owner,targetUserId:'100',fields:{}},
   fanInspectionTimeline:{ownerAccountId:owner,targetUserId:'100',status:'partial',fetchedAt:Date.now(),posts:[{handle:'first',url:'https://x.com/first/status/123',text:'I build software'}]}}});
  let reopened=0;f.store.resolveJob=async p=>{assert.equal(p.expectedState,'skipped');assert.deepEqual(p.expectedFollowResult,job.followResult);Object.assign(job,{state:p.state,followResult:p.followResult});reopened++;return {ok:true,job}};
  const adapter=f.create(),result=await adapter.gateCandidates(f.binding(),[{...candidate(),state:'skipped'}]);
  assert.equal(f.calls.length,1);assert.equal(reopened,1);assert.equal(result.length,1);
  assert.ok(f.rows[0].payload.fanReview.enrichmentCompletedAt);assert.equal(f.rows[0].payload.fanReview.state,'approved');
  if(result.length)assert.equal(result[0].state,'pending');
 }
});

test('manual skip can be reviewed but is never released or removed by automatic review',async()=>{
 for(const bio of ['I build software','vote for our party propaganda campaign']){
  const job={id:'job',accountId:owner,handle:'first',targetUserId:'100',state:'skipped',followResult:{reason:'manual hold'}};
  const f=fixture({jobs:[job],rows:[user('first','100',{bio})],settings:enabled,removeFollower:()=>{throw Error('must retain action hold')}});
  f.store.resolveJob=()=>{throw Error('must not reopen manual hold')};
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);assert.equal(job.state,'skipped');assert.notEqual(f.rows[0].payload.fanReview.state,'approved');
 }
});

test('AI pass cannot overwrite a changed execution hold',async()=>{
 const job={id:'job',accountId:owner,handle:'first',targetUserId:'100',state:'skipped',followResult:{reason:'machine rule',relationshipDecision:{screening:'blocked',screeningReason:'machine rule'}}};
 const f=fixture({jobs:[job],settings:enabled});f.store.resolveJob=async()=>({ok:false,reason:'changed'});
 assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);
});


test('manual decision or confirmed follow cannot be recovered from stale screening metadata',async()=>{
 for(const [state,followResult] of [
  ['skipped',{reason:'manual hold',relationshipDecision:{screening:'blocked',screeningReason:'machine rule'}}],
  ['excluded',{reason:'人工排除',relationshipDecision:{code:'not-a-follower'}}],
  ['skipped',{reason:'machine rule',succeeded:true,relationshipDecision:{screening:'blocked',screeningReason:'machine rule'}}]
 ]){
  const f=fixture({jobs:[{id:'job',accountId:owner,handle:'first',targetUserId:'100',state,followResult}],settings:enabled});
  f.store.resolveJob=()=>{throw Error('must not reopen')};
  assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);
 }
});

test('automatic AI rejection uses the same protected remover and is not an approval',async()=>{
 let removals=0;const f=fixture({settings:enabled,generate:async()=>({ok:true,text:JSON.stringify([{handle:'first',targetUserId:'100',decision:'remove',reason:'rule',tags:['risk']}])}),
  removeFollower:async item=>{removals++;return {...item,attempted:true,removed:true,verifiedAt:Date.now()}}});
 assert.deepEqual(await f.create().gateCandidates(f.binding(),[candidate()]),[]);assert.equal(removals,1);assert.equal(f.rows[0].payload.fanReview.state,'removed');assert.equal(f.rows[0].payload.fanGrant,null);
});

for(const status of ['partial','ready','empty','pending','stale'])test('cached verification settles '+status+' evidence without network or AI',async()=>{
 const f=fixture({rows:[user('first','100',{fanReview:{state:'verify',decision:'uncertain',source:'manual-verification',decisionVersion:2,enrichmentStartedAt:1,enrichmentCompletedAt:0,retryAt:Date.now()+3600000}})],settings:enabled,verifyRelationship:()=>assert.fail('no network verification')});
 const at=Date.now();f.records.lookup=async()=>({payload:{id:'100',handle:'first',profileEvidence:{ownerAccountId:owner,targetUserId:'100',fields:{}},fanInspectionTimeline:{ownerAccountId:owner,targetUserId:'100',status:status==='stale'?'partial':status,fetchedAt:status==='stale'?at-7*3600000:status==='pending'?null:at,posts:[{handle:'first',url:'https://x.com/first/status/123',text:'I build tools'}]}}});
 const api=f.create(),result=await api.completeCachedVerification(owner,candidate());const ready=true;
 assert.equal(result.ready,ready);assert.equal(f.rows[0].payload.fanReview.state,ready?'review':'verify');assert.equal(f.calls.length,0);
 if(ready){assert.equal(f.rows[0].payload.fanReview.retryAt,0);assert.ok(f.rows[0].payload.fanReview.enrichmentCompletedAt);const count=f.changes.length;await api.completeCachedVerification(owner,candidate());assert.equal(f.changes.length,count);}
});
test('verification scheduler promotes completed cached evidence before network retry cooldown',async()=>{
 const f=fixture({rows:[user('first','100',{fanReview:{state:'verify',decisionVersion:1,enrichmentStartedAt:1,enrichmentCompletedAt:0,retryAt:Date.now()+3600000}})],settings:enabled});
 f.records.fanInspectionTargets=async()=>['first'];f.records.lookup=async()=>({payload:{id:'100',handle:'first',profileEvidence:{ownerAccountId:owner,targetUserId:'100',fields:{}},fanInspectionTimeline:{ownerAccountId:owner,targetUserId:'100',status:'partial',fetchedAt:Date.now(),posts:[]}}});
 assert.deepEqual(await f.create().automaticCandidates(owner,'verify'),[]);assert.equal(f.rows[0].payload.fanReview.state,'review');assert.equal(f.calls.length,0);
});


test('legacy verification with existing biography returns for review without another profile visit',async()=>{
 const f=fixture({rows:[user('first','100',{fanReview:{state:'verify',decision:'uncertain',enrichmentCompletedAt:1,decisionVersion:2}})],verifyRelationship:()=>assert.fail('no visit')});f.records.fanInspectionTargets=async()=>['first'];
 assert.deepEqual(await f.create().automaticCandidates(owner,'verify'),[]);assert.equal(f.rows[0].payload.fanReview.state,'review');assert.equal(f.rows[0].payload.fanReview.decision,'review');assert.equal(f.calls.length,0);
});

for(const blockEmpty of [true,false])test('cached empty verification follows blockEmpty='+blockEmpty+' without external actions',async()=>{
 const f=fixture({settings:{removalRules:{blockEmpty}},rows:[user('first','100',{bio:'',fanReview:{state:'verify',decision:'uncertain',decisionVersion:1}})],removeFollower:()=>assert.fail('cache settlement must not make external actions')});
 f.records.lookup=async()=>({payload:{id:'100',handle:'first',bio:'',profileEvidence:{ownerAccountId:owner,targetUserId:'100',fields:{bio:Date.now()}},fanInspectionTimeline:{ownerAccountId:owner,targetUserId:'100',status:'empty',fetchedAt:Date.now(),posts:[]}}});
 const service=f.create();const result=await service.completeCachedVerification(owner,candidate());assert.equal(!!result.removalPending,blockEmpty);assert.equal(f.rows[0].payload.fanReview.reasonCode,blockEmpty?'ai_rejected':'');assert.equal(f.rows[0].payload.fanReview.decision,blockEmpty?'remove':'review');
 assert.equal((await service.completeCachedVerification(owner,candidate())).ready,true);
});

for(const status of ['partial','empty','ready'])test('automatic verification removes finished zero-evidence collection once: '+status,async()=>{
 let removals=0;
 const f=fixture({rows:[user('first','100',{bio:'',fanReview:{state:'verify',decision:'uncertain',decisionVersion:1,enrichmentStartedAt:1}})],settings:enabled,
  verifyRelationship:()=>assert.fail('finished collection must not revisit profile'),removeFollower:async item=>{removals++;return {...item,removed:true,verifiedAt:Date.now()};}});
 f.records.fanInspectionTargets=async()=>['first'];
 f.records.lookup=async()=>({payload:{id:'100',handle:'first',bio:'',profileEvidence:{ownerAccountId:owner,targetUserId:'100',fields:{bio:Date.now()}},
  fanInspectionTimeline:{ownerAccountId:owner,targetUserId:'100',status,fetchedAt:Date.now(),complete:false,posts:[],retryAt:null}}});
 const service=f.create();
 const items=await service.automaticCandidates(owner,'verify');assert.equal(items.length,1);
 const result=await service.automaticVerify(owner,items[0]);assert.equal(result.removed,true);assert.notEqual(result.waiting,true);
 assert.equal(f.rows[0].payload.fanReview.state,'removed');assert.equal(f.calls.length,0);assert.equal(removals,1);
 assert.deepEqual(await service.automaticCandidates(owner,'verify'),[]);
 await service.automaticVerify(owner,items[0]);assert.equal(removals,1,'do not resend removal on another tick');
});
