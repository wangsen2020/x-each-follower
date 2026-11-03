import test from 'node:test';
import assert from 'node:assert/strict';
import {createFanReviewBatch,runTaggingBatch,buildTaggingPrompt,selectQueueScreeningPosts,parseTaggingResponse,
  readMonitorFanRows,updateMonitorFanRows,reviewSettingsKey,fanReviewBatchKey,removalTombstonesKey,clearRemovalTombstoneForManualApprove,detectLocalHardRule} from '../src/features/relationships/follow-review-engine.js';

const clone=value=>structuredClone(value);
const OWNER='owner',TARGET='100',HANDLE='person';
test('direct follower removal scope does not absorb other configurable content filters',()=>{
  assert.equal(detectLocalHardRule({handle:HANDLE,bio:'OnlyFans 成人内容'},[]).blocked,false);
  assert.equal(detectLocalHardRule({handle:HANDLE,bio:'政治宣传 竞选动员'},[]).blocked,true);
  assert.equal(detectLocalHardRule({handle:HANDLE,bio:'宗教宣传'},[]).blocked,true);
});
test('a confirmed projection owner can read legacy rows without rewriting each source, while other owners cannot inherit them',async()=>{
  const context=fixture();context.rows[0].accountId='unassigned';
  context.records.fanReviewOwner=async()=>OWNER;
  assert.equal((await readMonitorFanRows({records:context.records,storage:context.storage,accountId:OWNER,handle:HANDLE})).length,1);
  assert.equal((await readMonitorFanRows({records:context.records,storage:context.storage,accountId:'other',handle:HANDLE})).length,0);
  context.rows[0].payload.ownerAccountId='another-owner';
  assert.equal((await readMonitorFanRows({records:context.records,storage:context.storage,accountId:OWNER,handle:HANDLE})).length,0);
});
function fixture({removeFollower,generate,verifyRelationship}={}) {
  const values={[reviewSettingsKey(OWNER)]:{removalRules:{blockSuggestive:true,blockEmpty:true},fanTagging:{provider:'codex',botId:'tag-session',batchSize:10,intervalSeconds:0}}};
  const rows=[{accountId:OWNER,sourceKey:'monitor',sourcePath:['monitor','users',HANDLE],bucket:'users',userKey:'monitor/users/'+HANDLE,
    handle:HANDLE,payload:{handle:HANDLE,id:TARGET,bio:'description',relationship:{following:false,followedBy:true}}}];
  const storage={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,clone(values[key])])),set:async patch=>Object.assign(values,clone(patch))};
  const records={lookupAll:async ({sourceKey,bucket,handle})=>clone(rows.filter(row=>row.sourceKey===sourceKey&&row.sourcePath[1]===bucket&&row.handle===handle)),
    batch:async({sourceKey,changes})=>{
      for(const change of changes){
        let row=rows.find(row=>row.handle===change.handle&&row.sourcePath[1]===change.sourceBucket&&(!change.accountId||row.accountId===change.accountId));
        if(row){
          if(change.expectedTargetUserId&&row.payload.id!==change.expectedTargetUserId)throw Object.assign(Error('target changed'),{name:'RecordIdentityConflictError'});
          if(change.expectedFanReviewVersion!==undefined&&(Number(row.payload.fanReview?.decisionVersion)||0)!==change.expectedFanReviewVersion)throw Object.assign(Error('review changed'),{name:'RecordReviewConflictError'});
          row.payload={...row.payload,...clone(change.patch)};
        } else if(change.create){row={accountId:change.accountId,sourceKey,sourcePath:[sourceKey,change.sourceBucket,change.handle],handle:change.handle,payload:clone(change.patch)};rows.push(row);}
      }
      return {updated:changes.length};
    }};
  const enqueued=[];
  const store={lookup:async()=>null,enqueue:async input=>{enqueued.push(clone(input));return {id:'new-job',state:'pending'};}};
  const service={status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[{id:'tag-session'}],
    generate:generate||(async()=>({ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass',tags:['normal']}])}))};
  const create=(options={})=>createFanReviewBatch({storage,records,store,readBinding:async()=>({accountId:OWNER,activated:true}),removeFollower,verifyRelationship,getService:()=>service,...options});
  return {values,rows,storage,records,store,enqueued,service,create};
}
async function run(batch,action) {await batch.start(OWNER,{action,handles:[HANDLE],targets:[{handle:HANDLE,targetUserId:TARGET}]});await batch.waitForIdle(OWNER);return batch.status(OWNER);}

test('automatic keyword rejection removes through confirmed executor without sending AI',async()=>{
 let removed=0;const f=fixture({generate:()=>assert.fail('keyword rejection must precede AI'),removeFollower:async()=>{removed++;return {attempted:true,removed:true,accountId:OWNER,targetUserId:TARGET,verifiedAt:1700000000000};}});
 f.rows[0].payload.bio='宗教宣传';const batch=f.create();
 await batch.start(OWNER,{action:'analyze',automatic:true,handles:[HANDLE]});await batch.waitForIdle(OWNER);
 assert.equal(removed,1);assert.equal(f.rows[0].payload.fanReview.state,'removed');assert.equal((await batch.status(OWNER)).automatic,true);
});

test('disabled automatic review pauses before submitting while manual review remains available',async()=>{
 let sent=0;const f=fixture({generate:async()=>{sent++;return {ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass'}])};}});
 f.values[reviewSettingsKey(OWNER)].automation={review:{enabled:false}};
 const batch=f.create();await batch.start(OWNER,{action:'analyze',automatic:true,handles:[HANDLE]});await batch.waitForIdle(OWNER);
 assert.equal(sent,0);assert.equal((await batch.status(OWNER)).stage,'paused');
 await run(batch,'analyze');assert.equal(sent,1);
});

test('restored review status exposes only the frozen handles needed for read-only row selection',async()=>{
  const f=fixture();f.values[fanReviewBatchKey(OWNER)]={id:'restored',accountId:OWNER,action:'analyze',stage:'paused',total:2,completed:0,
    items:[{handle:'one',targetUserId:'100',bio:'private profile detail'},{handle:'two',targetUserId:'200'}],results:[]};
  const status=await f.create().status(OWNER);
  assert.deepEqual(status.handles,['one','two']);assert.equal(status.items,undefined);
});

test('a filtered recommendation changing during relationship inspection is skipped without a grant',async()=>{
  let f;f=fixture({verifyRelationship:async()=>{f.rows[0].payload.fanReview={state:'review',decision:'review',decisionVersion:2}}});
  f.rows[0].payload.fanReview={state:'review',decision:'pass',decisionVersion:1};const batch=f.create();
  await batch.start(OWNER,{action:'approve',handles:[HANDLE],targets:[{handle:HANDLE,targetUserId:TARGET}],filter:{tab:'fanReview',reviewResult:'pass'}});await batch.waitForIdle(OWNER);
  assert.equal((await batch.status(OWNER)).results[0].status,'skipped');assert.match((await batch.status(OWNER)).results[0].reason,/审核结果已变化/);
  assert.deepEqual(f.enqueued,[]);assert.equal(f.rows[0].payload.fanGrant,undefined);
});

test('an already approved account leaves the filtered review batch even if its pass decision remains',async()=>{
  let f;f=fixture({verifyRelationship:async()=>{f.rows[0].payload.fanReview={state:'approved',decision:'pass',decisionVersion:2}}});
  f.rows[0].payload.fanReview={state:'review',decision:'pass',decisionVersion:1};const batch=f.create();
  await batch.start(OWNER,{action:'approve',handles:[HANDLE],targets:[{handle:HANDLE,targetUserId:TARGET}],filter:{tab:'fanReview',reviewResult:'pass'}});await batch.waitForIdle(OWNER);
  assert.equal((await batch.status(OWNER)).results[0].status,'skipped');assert.deepEqual(f.enqueued,[]);assert.equal(f.rows[0].payload.fanReview.decisionVersion,2);
});

for(const action of ['approve'])test(`${action} checks live relationships for grants, skipping unrelated accounts`,async()=>{
  let reads=0,generations=0;let f;
  f=fixture({generate:async()=>{generations++;throw Error('Unrelated accounts must not reach AI');},verifyRelationship:async item=>{
    reads++;assert.equal(item.targetUserId,TARGET);f.rows[0].payload.relationship={following:false,followedBy:false};
  }});
  if(action==='analyze')f.rows[0].payload.relationship={following:false,followedBy:false};
  const result=await run(f.create(),action);
  assert.equal(reads,action==='analyze'?0:1);assert.equal(generations,0);assert.deepEqual(f.enqueued,[]);
  assert.equal(result.results[0].status,'skipped');assert.match(result.results[0].reason,/双方均未关注/);
  assert.equal(f.rows[0].payload.fanGrant,undefined);assert.equal(f.rows[0].payload.fanReview,undefined);
});

test('failed live relationship inspection retains evidence and does not spend AI tokens or approve',async()=>{
  let generations=0;const f=fixture({generate:async()=>{generations++;},verifyRelationship:async()=>{throw Error('network unavailable')}});
  const original=clone(f.rows);const result=await run(f.create(),'approve');
  assert.equal(result.results[0].status,'uncertain');assert.equal(generations,0);assert.deepEqual(f.rows,original);assert.deepEqual(f.enqueued,[]);
});

test('unknown or already-following relationships are never approval candidates',async()=>{
  for(const relationship of [{following:null,followedBy:null},{following:true,followedBy:false},{following:true,followedBy:true}]){
    let generations=0;const f=fixture({generate:async()=>{generations++;}});f.rows[0].payload.relationship=relationship;
    for(const action of ['approve']){const result=await run(f.create(),action);assert.ok(['skipped','uncertain'].includes(result.results[0].status));}
    assert.equal(generations,0);assert.deepEqual(f.enqueued,[]);
  }
});

test('AI suggestions never manufacture relationship facts or grants when the relationship ends',async()=>{
  let f;f=fixture({generate:async()=>{f.rows[0].payload.relationship={following:false,followedBy:false};return {ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass',tags:['normal']}])}}});
  const result=await run(f.create(),'analyze');assert.equal(result.results[0].status,'pass');
  assert.deepEqual(f.rows[0].payload.relationship,{following:false,followedBy:false});
  assert.equal(f.rows[0].payload.fanGrant,null);assert.deepEqual(f.enqueued,[]);
});

test('manual AI pass automatically grants admission and enqueues the fan',async()=>{
  const f=fixture(),result=await run(f.create(),'analyze');
  assert.equal(result.stage,'completed');assert.equal(result.results[0].status,'pass');
  assert.equal(f.rows[0].payload.fanReview.state,'approved');assert.equal(f.rows[0].payload.fanReview.decision,'pass');
  assert.equal(f.rows[0].payload.fanGrant.source,'initial-ai-pass');assert.equal(f.enqueued.length,1);
});

test('mixed AI selection completes a missing-ID item locally and sends only the valid stable identity',async()=>{
  let generations=0;
  const f=fixture({generate:async(prompt)=>{
    generations++;assert.match(prompt,/'?person'?/);assert.doesNotMatch(prompt,/missing_identity/);
    return {ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass',tags:['normal'],reason:'valid identity only'}])};
  }});
  const missing={...clone(f.rows[0]),handle:'missing_identity',userKey:'monitor/users/missing_identity',sourcePath:['monitor','users','missing_identity'],
    payload:{handle:'missing_identity',bio:'identity has not been resolved',fanReview:{state:'review',ownerAccountId:OWNER,decisionVersion:2}}};
  f.rows.push(missing);const originalMissing=clone(missing.payload);
  const batch=f.create();
  await batch.start(OWNER,{action:'analyze',handles:['missing_identity',HANDLE],targets:[{handle:'missing_identity',targetUserId:''},{handle:HANDLE,targetUserId:TARGET}]});
  await batch.waitForIdle(OWNER);const result=await batch.status(OWNER);
  assert.equal(result.stage,'completed');assert.equal(result.total,2);assert.equal(result.completed,2);assert.equal(generations,1);
  const local=result.results.find(item=>item.handle==='missing_identity');
  assert.equal(local.status,'uncertain');assert.equal(local.local,true);assert.deepEqual(local.tags,['无法判断']);assert.match(local.reason,/本地身份检查|核实/);
  assert.deepEqual(missing.payload,originalMissing,'missing identity must receive no source mutation');
  assert.equal(f.rows[0].payload.fanReview.state,'approved');assert.equal(f.rows[0].payload.fanReview.decision,'pass');
  assert.equal(result.results.find(item=>item.handle===HANDLE).reason,'valid identity only');assert.equal(f.enqueued.length,1);
});

test('mixed manual approval enqueues only valid stable identities and retains the missing-ID record unchanged',async()=>{
  const f=fixture(),missing={...clone(f.rows[0]),handle:'missing_identity',userKey:'monitor/users/missing_identity',sourcePath:['monitor','users','missing_identity'],
    payload:{handle:'missing_identity',fanReview:{state:'review',decisionVersion:4,reason:'identity missing'}}};
  f.rows.push(missing);const originalMissing=clone(missing.payload);const batch=f.create();
  await batch.start(OWNER,{action:'approve',handles:['missing_identity',HANDLE],targets:[{handle:'missing_identity',targetUserId:''},{handle:HANDLE,targetUserId:TARGET}]});
  await batch.waitForIdle(OWNER);const result=await batch.status(OWNER);
  assert.equal(result.stage,'completed');assert.equal(result.completed,2);
  assert.deepEqual(f.enqueued.map(item=>({handle:item.handle,targetUserId:item.targetUserId})),[{handle:HANDLE,targetUserId:TARGET}]);
  assert.equal(result.results.find(item=>item.handle==='missing_identity').status,'uncertain');assert.deepEqual(missing.payload,originalMissing);
  assert.equal(f.rows[0].payload.fanReview.state,'approved');
});

test('all-invalid AI chunks advance without invoking any AI service or changing source records',async()=>{
  const f=fixture();delete f.rows[0].payload.id;f.values[reviewSettingsKey(OWNER)]={};
  f.service.status=async()=>{throw Error('must not inspect an AI service without a valid input');};
  const original=clone(f.rows[0].payload),batch=f.create();
  await batch.start(OWNER,{action:'analyze',handles:[HANDLE],targets:[{handle:HANDLE,targetUserId:''}]});
  await batch.waitForIdle(OWNER);const result=await batch.status(OWNER);
  assert.equal(result.stage,'completed');assert.equal(result.completed,1);assert.deepEqual(result.results[0].tags,['无法判断']);assert.deepEqual(f.rows[0].payload,original);
});

test('mixed destructive removal retains all-or-nothing stable identity validation',async()=>{
  let removals=0;
  const f=fixture({removeFollower:async()=>{removals++;throw Error('must not reach removal');}}),original=clone(f.rows[0].payload);
  for(const targets of [
    [{handle:HANDLE,targetUserId:TARGET},{handle:'missing_identity',targetUserId:''}],
    [{handle:HANDLE,targetUserId:TARGET,conflict:true}],
    [{handle:HANDLE,targetUserId:'200'}]
  ]){
    await assert.rejects(f.create().start(OWNER,{action:'remove',handles:targets.map(item=>item.handle),targets}),/身份|目标|冲突/);
  }
  assert.equal(removals,0);assert.deepEqual(f.rows[0].payload,original);assert.deepEqual(f.enqueued,[]);
});

test('confirmed manual removal stores one complete receipt in source, workflow and exclusion marker',async()=>{
  let submissions=0;
  const f=fixture({removeFollower:async()=>{submissions++;return {attempted:true,removed:true,accountId:OWNER,targetUserId:TARGET,verifiedAt:1700000000000,reason:'confirmed fixture'};}});
  const result=await run(f.create(),'remove'),payload=f.rows[0].payload;
  assert.equal(result.stage,'completed');assert.equal(result.results[0].status,'removed');assert.equal(submissions,1);
  for(const receipt of [payload.followerRemoval,payload.fanReview.removalReceipt]){
    assert.equal(receipt.accountId,OWNER);assert.equal(receipt.targetUserId,TARGET);assert.equal(receipt.removed,true);assert.equal(receipt.verifiedAt,1700000000000);
  }
  assert.equal(f.values[removalTombstonesKey(OWNER)].byId[TARGET].state,'removed');
  assert.equal(payload.relationship.followedBy,false);
});

test('an action receipt permits local repair after a write failure without resubmitting the real removal',async()=>{
  let submissions=0,writes=0,fail=true;
  const f=fixture({removeFollower:async()=>{submissions++;return {attempted:true,removed:true,accountId:OWNER,targetUserId:TARGET,verifiedAt:1700000000000};}});
  const original=f.records.batch;
  f.records.batch=async request=>{writes++;if(writes===2&&fail){fail=false;throw Error('simulated disk failure');}return original(request);};
  const first=await run(f.create(),'remove');
  assert.equal(first.stage,'paused');assert.equal(first.nextIndex,0);assert.equal(submissions,1);
  const restarted=f.create();await restarted.resume(OWNER);await restarted.waitForIdle(OWNER);
  assert.equal((await restarted.status(OWNER)).stage,'completed');assert.equal(submissions,1);
  assert.equal(f.rows[0].payload.fanReview.state,'removed');
  assert.equal(f.values[removalTombstonesKey(OWNER)].byId[TARGET].state,'removed');
});

test('a definitely unsubmitted removal does not claim success or block an explicit later retry',async()=>{
  let submissions=0;
  const f=fixture({removeFollower:async()=>{submissions++;return {attempted:false,removed:false,reason:'not submitted'};}});
  const original=clone(f.rows[0].payload.relationship);
  await run(f.create(),'remove');await run(f.create(),'remove');
  assert.equal(submissions,2);assert.equal(f.rows[0].payload.fanReview.state,'review');
  assert.deepEqual(f.rows[0].payload.relationship,original);assert.equal(f.values[removalTombstonesKey(OWNER)],undefined);
});

test('a mismatched removal response identity remains uncertain and never becomes a false removed record',async()=>{
  const f=fixture({removeFollower:async()=>({attempted:true,removed:true,targetUserId:'200',accountId:OWNER})});
  const result=await run(f.create(),'remove');
  assert.equal(result.results[0].status,'failed');assert.equal(f.rows[0].payload.fanReview.state,'review');
  assert.equal(f.rows[0].payload.followerRemoval.removed,false);assert.equal(f.values[removalTombstonesKey(OWNER)],undefined);
});

test('functional createIfMissing applies the callback and freezes its explicit owner and target',async()=>{
  const f=fixture();f.rows.length=0;
  await updateMonitorFanRows({records:f.records,storage:f.storage,handle:HANDLE,accountId:OWNER,targetUserId:TARGET,createIfMissing:true,
    patch:payload=>({fanReview:{state:'review',ownerAccountId:OWNER,targetUserId:TARGET},name:'new '+payload.handle})});
  assert.equal(f.rows[0].payload.name,'new person');assert.equal(f.rows[0].payload.id,TARGET);
  assert.equal(f.rows[0].payload.fanReview.state,'review');assert.equal(f.rows[0].accountId,OWNER);
});

test('monitor mutation does not touch another owner or a conflicting target sharing the handle',async()=>{
  const f=fixture();f.rows.push({...clone(f.rows[0]),accountId:'another-owner',payload:{handle:HANDLE,id:'200',name:'other person'}});
  const read=await readMonitorFanRows({records:f.records,handle:HANDLE,accountId:OWNER,targetUserId:TARGET});
  assert.equal(read.length,1);
  await updateMonitorFanRows({records:f.records,handle:HANDLE,accountId:OWNER,targetUserId:TARGET,patch:{name:'selected'}});
  assert.equal(f.rows[0].payload.name,'selected');assert.equal(f.rows[1].payload.name,'other person');
});

test('tagging request keys isolate owner, input, rules and persistent batch identity while retaining full evidence',async()=>{
  const requests=[],service={status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[{id:'tag-session'}],
    generate:async(prompt,options)=>{requests.push({prompt,options});return {ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass'}])};}};
  const base={role:'queueTagging',roleConfig:{provider:'codex',botId:'tag-session',prompt:'rule1'},items:[{handle:HANDLE,targetUserId:TARGET,ownerAccountId:OWNER,bio:'bio',posts:[{text:'A'.repeat(500)+'tail keyword'}]}],
    requestContext:{accountId:OWNER,batchId:'batch1'},getService:()=>service};
  for(const input of [base,{...base,requestContext:{accountId:'other',batchId:'batch1'}},{...base,requestContext:{accountId:OWNER,batchId:'batch2'}},
    {...base,roleConfig:{...base.roleConfig,prompt:'rule2'}},{...base,items:[{...base.items[0],bio:'changed'}]}]) await runTaggingBatch(input);
  assert.equal(new Set(requests.map(row=>row.options.requestKey)).size,5);
  assert.match(requests[0].prompt,/tail keyword/);assert.equal(requests[0].options.maxPromptChars,120000);
});

test('oversized tagging input fails before generation and never truncates source evidence into an apparent pass',async()=>{
  let generated=0;
  const result=await runTaggingBatch({roleConfig:{provider:'codex',botId:'tag-session'},items:[{handle:HANDLE,targetUserId:TARGET,bio:'x'.repeat(120001)}],
    getService:()=>({status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[{id:'tag-session'}],generate:async()=>{generated++;return {ok:true};}})});
  assert.equal(result.ok,false);assert.equal(result.submitted,false);assert.equal(generated,0);assert.equal(result.results[0].valid,false);
});

test('the final AI submit guard is rechecked after asynchronous connection verification',async()=>{
  let verified=false,generated=0;
  const result=await runTaggingBatch({roleConfig:{provider:'codex',botId:'tag-session'},items:[{handle:HANDLE,targetUserId:TARGET}],
    beforeSubmit:async()=>{assert.equal(verified,true);throw Error('owner changed before submission');},
    getService:()=>({status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>{verified=true;return [{id:'tag-session'}];},
      generate:async()=>{generated++;return {ok:true};}})});
  assert.equal(generated,0);assert.equal(result.ok,false);assert.equal(result.submitted,false);assert.match(result.error,/owner changed/);
});

test('screening accepts at most ten distinct authored nonpinned original posts with real X status URLs',()=>{
  const post=(id,extra={})=>({url:`https://x.com/${HANDLE}/status/${id}`,text:'own content',...extra});
  const input=[post(1,{isPinned:true}),post(2,{isRetweet:true}),post(3,{isQuote:true}),{text:'unknown author'},
    post(4,{url:'https://elsewhere.test/status/4'}),post(5,{handle:'other_author'}),post(6,{url:'https://x.com/other_author/status/6'}),
    ...Array.from({length:12},(_,index)=>post(index+100)),post(100)];
  const output=selectQueueScreeningPosts(input,HANDLE);
  assert.equal(output.length,10);assert.deepEqual(output.map(item=>item.url.split('/').at(-1)),Array.from({length:10},(_,index)=>String(index+100)));
});

test('number-valued or duplicate AI stable identities cannot be repaired into authorization',()=>{
  const expected=[{handle:HANDLE,targetUserId:TARGET}];
  assert.equal(parseTaggingResponse(JSON.stringify([{handle:HANDLE,targetUserId:100,decision:'pass'}]),expected)[0].valid,false);
  assert.equal(parseTaggingResponse(JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass'},{handle:HANDLE,targetUserId:TARGET,decision:'pass'}]),expected)[0].valid,false);
});

test('manual approval for one stable identity cannot clear an exclusion belonging to a different same-handle identity',async()=>{
  const f=fixture();
  f.values[removalTombstonesKey(OWNER)]={byId:{'200':{targetUserId:'200',handle:HANDLE,state:'excluded'}},byHandle:{[HANDLE]:{targetUserId:'200',state:'excluded'}}};
  await clearRemovalTombstoneForManualApprove(f.storage,OWNER,{targetUserId:TARGET,handle:HANDLE});
  assert.equal(f.values[removalTombstonesKey(OWNER)].byHandle[HANDLE].targetUserId,'200');
  assert.equal(f.values[removalTombstonesKey(OWNER)].byId['200'].state,'excluded');
});

test('default local screening reads the full first-ten authored post text beyond legacy truncation',()=>{
  const post={url:`https://x.com/${HANDLE}/status/123`,text:'ordinary '.repeat(100)+'vote for political campaign'};
  assert.equal(detectLocalHardRule({handle:HANDLE,bio:'',posts:[post]}).blocked,true);
  assert.match(buildTaggingPrompt({role:'queueTagging',items:[{handle:HANDLE,targetUserId:TARGET,posts:[post]}]}),/vote for political campaign/);
});

test('a persisted running manual batch is recoverable while an unknown AI submission cannot be resubmitted',async()=>{
  const f=fixture();f.values[fanReviewBatchKey(OWNER)]={id:'unknown',accountId:OWNER,action:'analyze',stage:'running',total:1,completed:0,nextIndex:0,
    roleSnapshot:{provider:'codex',botId:'tag-session'},items:[{handle:HANDLE,targetUserId:TARGET,decisionVersion:0}],results:[],inFlightStage:'submitting',inFlightRelayJobId:''};
  const batch=f.create();assert.equal((await batch.status(OWNER)).stage,'paused');
  await assert.rejects(batch.resume(OWNER),/未知|重新提交/);
});

function multiReviewFixture(count,bio='description') {
  const f=fixture();const first=clone(f.rows[0]);f.rows.length=0;
  for(let index=0;index<count;index++){
    const handle='person'+index,id=String(100+index);
    f.rows.push({...clone(first),handle,userKey:'monitor/users/'+handle,sourcePath:['monitor','users',handle],payload:{...clone(first.payload),handle,id,bio:typeof bio==='function'?bio(index):bio}});
  }
  f.inputs=[];
  f.service.generate=async prompt=>{
    const items=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')));
    f.inputs.push(items);
    return {ok:true,text:JSON.stringify(items.map(item=>({handle:item.handle,targetUserId:item.targetUserId,decision:'pass'})))};
  };
  f.start=async batch=>{await batch.start(OWNER,{action:'analyze',handles:f.rows.map(row=>row.handle),targets:f.rows.map(row=>({handle:row.handle,targetUserId:row.payload.id}))});await batch.waitForIdle(OWNER);return batch.status(OWNER);};
  return f;
}

test('manual AI uses configured upper limit rather than tiny hardcoded chunks and randomizes only between requests',async()=>{
  const f=multiReviewFixture(25);f.values[reviewSettingsKey(OWNER)].fanTagging={provider:'codex',botId:'tag-session',batchSize:10,intervalSeconds:3,intervalMaxSeconds:8};
  let clock=10000,draw=0;const started=[];
  const generate=f.service.generate;f.service.generate=async prompt=>{started.push(clock);return generate(prompt);};
  const batch=f.create({now:()=>clock,random:()=>[0,1,0.5][draw++],wait:async ms=>{clock+=ms;}});
  const result=await f.start(batch);
  assert.equal(result.stage,'completed');assert.equal(result.completed,25);
  assert.deepEqual(f.inputs.map(items=>items.length),[10,10,5]);
  assert.deepEqual(started,[10000,13000,21000]);assert.equal(clock,21000);
});

test('complete long evidence splits by prompt budget and one oversized account does not block the rest',async()=>{
  const f=multiReviewFixture(5,index=>'x'.repeat(index===2?130000:48000));
  const result=await f.start(f.create());
  assert.equal(result.stage,'completed');assert.equal(result.completed,5);
  assert.deepEqual(f.inputs.map(items=>items.length),[2,2]);
  assert.ok(f.inputs.flat().every(item=>item.bio.length===48000));
  assert.equal(result.results.find(item=>item.handle==='person2').status,'uncertain');
  assert.equal(f.rows[2].payload.bio.length,130000);assert.equal(f.rows[2].payload.fanGrant,undefined);
});

test('stopping a cooldown pauses within one short wait and resume honors the persisted due time',async()=>{
  const f=multiReviewFixture(3);Object.assign(f.values[reviewSettingsKey(OWNER)].fanTagging,{batchSize:1,intervalSeconds:3,intervalMaxSeconds:8});
  let clock=10000,batch,stopped=false;
  batch=f.create({now:()=>clock,random:()=>1,wait:async ms=>{clock+=ms;if(!stopped){stopped=true;await batch.stop(OWNER);}}});
  let result=await f.start(batch);
  assert.equal(result.stage,'paused');assert.equal(result.completed,1);assert.equal(clock,10250);assert.equal(result.nextRequestAt,18000);
  const resumed=f.create({now:()=>clock,random:()=>0,wait:async ms=>{clock+=ms;}});
  await resumed.resume(OWNER);await resumed.waitForIdle(OWNER);result=await resumed.status(OWNER);
  assert.equal(result.completed,3);assert.equal(clock,21000);assert.equal(f.inputs.length,3);
});

test('worker restarts retain an unknown AI batch, recover its original job and finish both targets once',async()=>{
 const f=multiReviewFixture(2);let submitted=0,queries=0,ready=false;
 f.service.generate=async(prompt,options)=>{submitted++;await options.onJobCreated({id:'sandbox-timeout-job'});return {ok:false,pending:true,generationUnknown:true,jobId:'sandbox-timeout-job',reason:'gbot_failed: EnsureSandBox timeout'};};
 f.service.resume=async id=>{queries++;assert.equal(id,'sandbox-timeout-job');return ready?{ok:true,jobId:id,text:JSON.stringify(f.rows.map(r=>({handle:r.handle,targetUserId:r.payload.id,decision:'pass'})))}:
  {ok:false,pending:true,jobId:id,reason:'gbot_failed: EnsureSandBox timeout'};};
 let batch=f.create();let state=await f.start(batch);assert.equal(state.stage,'paused');assert.match(state.error,/EnsureSandBox/);
 batch=f.create();await batch.resume(OWNER);await batch.waitForIdle(OWNER);state=await batch.status(OWNER);
 assert.equal(state.stage,'paused');assert.equal(state.completed,0);assert.equal(state.pendingRecovery,true);
 ready=true;batch=f.create();await batch.resume(OWNER);await batch.waitForIdle(OWNER);state=await batch.status(OWNER);
 assert.equal(state.stage,'completed');assert.equal(state.completed,2);assert.equal(submitted,1);assert.equal(queries,2);
 await batch.resume(OWNER);assert.equal(queries,2);assert.equal(submitted,1);
});

test('resuming a length-limited AI request preserves its original members and only resumes the saved job',async()=>{
  const f=multiReviewFixture(5,'x'.repeat(48000));const generate=f.service.generate;let first=true,resumes=0;
  f.service.generate=async(prompt,options)=>{
    if(first){first=false;await options.onJobCreated({id:'saved-job'});return {ok:false,pending:true,jobId:'saved-job',reason:'waiting'};}
    return generate(prompt);
  };
  const batch=f.create();let result=await f.start(batch);assert.equal(result.stage,'paused');assert.equal(result.requestSize,2);
  f.service.resume=async id=>{assert.equal(id,'saved-job');resumes++;return {ok:true,text:JSON.stringify(f.rows.slice(0,2).map(row=>({handle:row.handle,targetUserId:row.payload.id,decision:'pass'})))};};
  const resumed=f.create();await resumed.resume(OWNER);await resumed.waitForIdle(OWNER);result=await resumed.status(OWNER);
  assert.equal(result.stage,'completed');assert.equal(result.completed,5);assert.equal(resumes,1);
  assert.deepEqual(f.inputs.map(items=>items.map(item=>item.handle)),[['person2','person3'],['person4']]);
});


test('stop during the final connection check prevents a new AI submission and keeps the selection resumable',async()=>{
  const f=multiReviewFixture(2);let checks=0,batch;
  f.service.status=async()=>{checks++;if(checks===1)await batch.stop(OWNER);return {enabled:true};};
  batch=f.create();const paused=await f.start(batch);
  assert.equal(paused.stage,'paused');assert.equal(paused.completed,0);assert.equal(f.inputs.length,0);
  await batch.resume(OWNER);await batch.waitForIdle(OWNER);
  assert.equal((await batch.status(OWNER)).completed,2);assert.equal(f.inputs.length,1);
});


test('a stored POST-413 batch can be repacked only when its original receipt is absent',async()=>{
 for(const absent of [true,false]){
  const f=multiReviewFixture(3);const batch=f.create();
  f.values[fanReviewBatchKey(OWNER)]={id:'old-413',accountId:OWNER,action:'analyze',stage:'paused',total:3,completed:0,nextIndex:0,
   items:f.rows.map(row=>({handle:row.handle,targetUserId:row.payload.id,decisionVersion:0})),results:[],roleSnapshot:f.values[reviewSettingsKey(OWNER)].fanTagging,
   inFlightRelayJobId:'local:rejected-old',inFlightStage:'pending',inFlightItems:f.rows.map(row=>({handle:row.handle,targetUserId:row.payload.id})),error:'AI服务错误（413）；原任务已保留，不会自动重发'};
  f.service.resume=async()=>absent?{ok:false,pending:false,errorCode:'JOB_NOT_FOUND'}:{ok:false,pending:true,reason:'still running'};
  await batch.resume(OWNER);await batch.waitForIdle(OWNER);
  if(absent){assert.equal((await batch.status(OWNER)).completed,3);assert.equal(f.inputs.length,1);assert.equal(f.values[fanReviewBatchKey(OWNER)].rejectedRequests.length,1);}
  else {assert.equal(f.inputs.length,0);assert.equal((await batch.status(OWNER)).stage,'paused');}
 }
});


test('AI review never waits on X navigation and still checks locally observed relationships',async()=>{
 const f=multiReviewFixture(3);let reads=0;
 const batch=f.create({verifyRelationship:async()=>{reads++;throw Error('X is busy with another task');}});
 const result=await f.start(batch);assert.equal(result.stage,'completed');assert.equal(result.completed,3);assert.equal(reads,0);assert.equal(f.inputs.length,1);assert.equal(f.enqueued.length,3);
});

test('stopping AI preparation pauses before generation instead of checking the entire batch',async()=>{
 const f=multiReviewFixture(3),set=f.storage.set;let batch,stopped=false;
 f.storage.set=async patch=>{await set(patch);if(!stopped&&Object.values(patch).some(v=>v?.phase==='checking')){stopped=true;void batch.stop(OWNER);}};
 batch=f.create();const result=await f.start(batch);
 assert.equal(result.stage,'paused');assert.equal(f.inputs.length,0);assert.equal(result.completed,0);
});


test('biography alone is sufficient for AI review even when relationships and optional data are unknown',async()=>{
 const f=multiReviewFixture(2);for(const row of f.rows)row.payload.relationship={};let reads=0;
 const batch=f.create({verifyRelationship:async()=>{reads++;throw Error('must not navigate X');}});
 const result=await f.start(batch);assert.equal(result.completed,2);assert.equal(f.inputs.length,1);assert.equal(reads,0);assert.equal(f.inputs[0][0].bio,'description');
 assert.equal('recentPosts' in f.inputs[0][0],false);assert.equal('followersText' in f.inputs[0][0],false);assert.deepEqual(f.enqueued,[]);
});

test('missing biography is locally unable to review even with counts, and needs no AI connection',async()=>{
 const f=multiReviewFixture(1,'');f.rows[0].payload.followersText='999';f.rows[0].payload.relationship={};f.rows[0].payload.posts=[];
 f.values[reviewSettingsKey(OWNER)].fanTagging={};let checks=0;f.service.status=async()=>{checks++;throw Error('offline');};
 const result=await f.start(f.create());assert.equal(result.stage,'completed');assert.equal(f.inputs.length,0);assert.equal(checks,0);
 assert.equal(result.results[0].reasonCode,'missing_biography');assert.equal(f.rows[0].payload.fanReview.reasonCode,'missing_biography');assert.equal(f.rows[0].payload.fanReview.decision,'uncertain');
});

test('missing-biography accounts do not prevent valid biographies from sharing one AI request',async()=>{
 const f=multiReviewFixture(3,index=>index===1?'':'description');const result=await f.start(f.create());
 assert.equal(result.completed,3);assert.deepEqual(f.inputs[0].map(item=>item.handle),['person0','person2']);assert.equal(result.results[1].reasonCode,'missing_biography');
});


test('a later biography allows retrying an unavailable manual review and clears its missing-profile label',async()=>{
 const f=multiReviewFixture(1,'');await f.start(f.create());assert.equal(f.rows[0].payload.fanReview.reasonCode,'missing_biography');
 f.rows[0].payload.bio='Biography collected later';await f.start(f.create());assert.equal(f.inputs.length,1);assert.equal(f.rows[0].payload.fanReview.decision,'pass');assert.equal(f.rows[0].payload.fanReview.reasonCode,'');
});


test('resuming a legacy partial task reclassifies missing biographies and preserves original AI suggestions',async()=>{
 const f=multiReviewFixture(3,index=>index===0?'':'description'),key=fanReviewBatchKey(OWNER);
 for(const row of f.rows.slice(0,2))row.payload.fanReview={state:'review',source:'manual-ai-analyze',decision:'pass',reason:'Original AI suggestion',decisionVersion:1};
 f.values[key]={id:'legacy-partial',accountId:OWNER,action:'analyze',stage:'paused',total:3,completed:2,nextIndex:2,
  items:f.rows.map(row=>({handle:row.handle,targetUserId:row.payload.id,decisionVersion:0})),results:f.rows.slice(0,2).map(row=>({handle:row.handle,status:'pass',reason:'Original AI suggestion'})),
  roleSnapshot:f.values[reviewSettingsKey(OWNER)].fanTagging,inFlightStage:'',inFlightRelayJobId:''};
 const batch=f.create();await batch.resume(OWNER);await batch.waitForIdle(OWNER);const result=await batch.status(OWNER);
 assert.equal(result.completed,3);assert.equal(result.results[0].reasonCode,'missing_biography');assert.equal(result.results[0].previousAiResult.reason,'Original AI suggestion');
 assert.equal(f.rows[0].payload.fanReview.previousAiReview.decision,'pass');assert.equal(f.rows[1].payload.fanReview.decision,'pass');
 assert.deepEqual(f.inputs.flat().map(item=>item.handle),['person2']);
});

test('fresh three-way AI rejection removes once and records the actual removal outcome',async()=>{
 let calls=0;
 const f=fixture({generate:async()=>({ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'remove',reason:'explicit rule',tags:['risk']}])}),
  removeFollower:async request=>{calls++;assert.equal(request.reason,'explicit rule');return {accountId:OWNER,targetUserId:TARGET,removed:true,attempted:true,verifiedAt:Date.now()}}});
 const result=await run(f.create(),'analyze');assert.equal(f.values[fanReviewBatchKey(OWNER)].fanDecisionPolicy,3);
 assert.equal(result.results[0].status,'rejected');assert.equal(result.results[0].executionStatus,'removed');assert.equal(calls,1);
 assert.equal(f.rows[0].payload.fanReview.state,'removed');assert.equal(f.rows[0].payload.fanReview.source,'ai-remove');assert.equal(f.enqueued.length,0);
});

test('live queue integration persists rejection and returns immediately without waiting for removal',async()=>{
 let queued=0;const f=fixture({generate:async()=>({ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'remove',reason:'explicit rejection'}])}),removeFollower:()=>assert.fail('review must not execute removal')});
 const batch=f.create({enqueueRemoval:async item=>{queued++;assert.equal(item.targetUserId,TARGET);return {accountId:OWNER,targetUserId:TARGET,attempted:false,removed:false,state:'queued'};}});
 const result=await run(batch,'analyze');assert.equal(result.stage,'completed');assert.equal(result.results[0].executionStatus,'deferred');assert.equal(queued,1);assert.equal(f.rows[0].payload.fanReview.decision,'remove');assert.equal(f.rows[0].payload.fanReview.removalReceipt.attempted,false);
});

test('existing evidence cannot loop into verification; malformed or legacy review is an error without removal',async()=>{
 for(const decision of ['uncertain','review']){
  const f=fixture({generate:async()=>({ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision,reason:'insufficient evidence'}])}),removeFollower:()=>{throw Error('must not remove')}});
  f.rows[0].payload.fanReview={state:'review',decisionVersion:1,enrichmentCompletedAt:Date.now()};
  const result=await run(f.create(),'analyze');assert.equal(result.results[0].status,decision==='uncertain'?'pass':'error');
  assert.equal(f.rows[0].payload.fanReview.state,decision==='uncertain'?'approved':'review');assert.equal(f.enqueued.length,decision==='uncertain'?1:0);
 }
});

test('AI rejection with an unknown removal receipt never repeats the external action',async()=>{
 let calls=0;const f=fixture({generate:async()=>({ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'remove',reason:'rule'}])}),
  removeFollower:async()=>{calls++;return {accountId:OWNER,targetUserId:TARGET,attempted:true,removed:false,reason:'result unknown'}}});
 const first=await run(f.create(),'analyze');assert.equal(first.results[0].status,'rejected');assert.equal(first.results[0].technicalError,true);assert.equal(calls,1);
 await run(f.create(),'analyze');assert.equal(calls,1);assert.notEqual(f.rows[0].payload.fanReview.state,'removed');
});

test('AI removal receipt resumes local persistence after interruption without deleting twice',async()=>{
 let calls=0,writes=0,fail=true;
 const f=fixture({generate:async()=>({ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'remove',reason:'rule'}])}),
  removeFollower:async()=>{calls++;return {accountId:OWNER,targetUserId:TARGET,removed:true,attempted:true,verifiedAt:Date.now()}}});
 const original=f.records.batch;f.records.batch=async request=>{writes++;if(writes===3&&fail){fail=false;throw Error('disk error')}return original(request)};
 const first=await run(f.create(),'analyze');assert.equal(first.stage,'paused');assert.equal(calls,1);
 const restarted=f.create();await restarted.resume(OWNER);await restarted.waitForIdle(OWNER);
 const last=await restarted.status(OWNER);assert.equal(last.stage,'completed');assert.equal(last.results[0].status,'rejected');assert.equal(last.results[0].executionStatus,'removed');assert.equal(calls,1);
});

for(const phase of ['checking','saving'])test('a row removed during '+phase+' does not stop other AI review items',async()=>{
 const f=fixture({generate:async()=>({ok:true,text:JSON.stringify([{handle:'second',targetUserId:'200',decision:'pass',tags:['normal']}])})});
 const second=clone(f.rows[0]);second.handle='second';second.userKey='monitor/users/second';second.sourcePath=['monitor','users','second'];second.payload={...second.payload,handle:'second',id:'200'};f.rows.push(second);
 if(phase==='saving')f.rows[0].payload.bio='';
 const write=f.storage.set;let deleted=false;f.storage.set=async patch=>{await write(patch);const batch=patch[fanReviewBatchKey(OWNER)];
 if(!deleted&&batch?.phase===phase&&(phase==='saving'||batch.checked===1)){f.rows.splice(0,1);deleted=true;}
 };
 const batch=f.create();await batch.start(OWNER,{action:'analyze',handles:[HANDLE,'second']});await batch.waitForIdle(OWNER);
 const status=await batch.status(OWNER);assert.equal(deleted,true);assert.equal(status.stage,'completed');assert.equal(status.completed,2);
 assert.equal(status.results.find(r=>r.handle===HANDLE).status,'skipped');assert.equal(status.results.find(r=>r.handle==='second').status,'pass');assert.equal(f.enqueued.length,1);
});

test('confirmed removal survives concurrent source cleanup and keeps its removal history',async()=>{
 let f,removed=0;f=fixture({removeFollower:async()=>{removed++;f.rows.splice(0,1);return {attempted:true,removed:true,accountId:OWNER,targetUserId:TARGET,verifiedAt:1700000000000};}});
 const status=await run(f.create(),'remove');assert.equal(status.stage,'completed');assert.equal(status.results[0].status,'removed');assert.equal(removed,1);assert.equal(f.rows.length,0);
 assert.equal(f.values[removalTombstonesKey(OWNER)].byId[TARGET].state,'removed');
});

test('legacy failed AI batch recovers confirmed removal after cleanup without new AI or external removal',async()=>{
 const f=fixture({generate:()=>assert.fail('must reuse received result'),removeFollower:()=>assert.fail('must reuse confirmed receipt')});
 f.rows.length=0;const receipt={removed:true,attempted:true,accountId:OWNER,targetUserId:TARGET,verifiedAt:1700000000000};
 f.values[fanReviewBatchKey(OWNER)]={id:'old-failed',accountId:OWNER,action:'analyze',automatic:true,stage:'failed',total:1,completed:0,nextIndex:0,results:[],
 items:[{handle:HANDLE,targetUserId:TARGET,decisionVersion:0}],inFlightItems:[{handle:HANDLE,targetUserId:TARGET}],inFlightCount:1,inFlightStage:'received',inFlightRelayJobId:'original-job',
 receivedTagging:{ok:true,results:[{handle:HANDLE,targetUserId:TARGET,decision:'remove',valid:true}]},actionReceipts:{[HANDLE]:receipt},roleSnapshot:{provider:'codex',botId:'tag-session',intervalSeconds:0}};
 const batch=f.create();assert.equal((await batch.status(OWNER)).pendingRecovery,true);await batch.resume(OWNER);await batch.waitForIdle(OWNER);
 const status=await batch.status(OWNER);assert.equal(status.stage,'completed');assert.equal(status.completed,1);assert.equal(status.results[0].executionStatus,'removed');assert.equal(f.rows.length,0);assert.equal(f.values[removalTombstonesKey(OWNER)].byId[TARGET].state,'removed');
});

test('AI review consumes the central account snapshot and pauses only when its owner no longer matches',async()=>{
 const f=fixture();let current={id:OWNER,handle:'owner'};const batch=f.create({readAccount:async()=>current});
 assert.equal((await run(batch,'analyze')).stage,'completed');current={id:'other',handle:'other'};
 await assert.rejects(batch.start(OWNER,{action:'analyze',handles:[HANDLE]}),error=>error.name==='ReviewOwnerChangedError');
});


test('content-based AI rejection overrides contradictory uncertainty and removes exactly once',async()=>{
 let calls=0;const f=fixture({generate:async()=>({ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'uncertain',tags:['低俗擦边'],reason:'已有低俗内容',evidence:['post: 这是具体的性暗示招揽文案']}])}),removeFollower:async()=>{calls++;return {attempted:true,removed:true,accountId:OWNER,targetUserId:TARGET,verifiedAt:1700000000000};}});
 f.rows[0].payload.bio='';f.rows[0].payload.posts=[{handle:HANDLE,url:'https://x.com/person/status/123',text:'这是具体的性暗示招揽文案'}];
 const batch=f.create(),result=await run(batch,'analyze');assert.equal(result.results[0].status,'rejected');assert.equal(f.rows[0].payload.fanReview.state,'removed');assert.equal(calls,1);assert.equal(f.enqueued.length,0);
});

test('confirmed empty fan is released without AI when empty removal is disabled',async()=>{
 const f=fixture({generate:()=>assert.fail('empty input must not submit AI'),removeFollower:()=>assert.fail('empty removal is disabled')});
 delete f.values[reviewSettingsKey(OWNER)].removalRules;
 f.rows[0].payload.bio='';f.records.lookup=async()=>({payload:{id:TARGET,handle:HANDLE,bio:'',profileEvidence:{ownerAccountId:OWNER,targetUserId:TARGET,fields:{bio:Date.now()}},fanInspectionTimeline:{ownerAccountId:OWNER,targetUserId:TARGET,status:'empty',fetchedAt:Date.now(),posts:[]}}});
 const result=await run(f.create(),'analyze');assert.equal(result.stage,'completed');assert.equal(result.results[0].status,'pass');
 assert.equal(f.rows[0].payload.fanReview.state,'approved');assert.equal(f.enqueued.length,1);assert.equal(f.enqueued[0].sources[0].module,'fans');
});

test('successful empty verification is removed without AI and unavailable collection is never treated as empty',async()=>{
 for(const status of ['empty','unavailable','failed']){
  let calls=0;const f=fixture({generate:()=>assert.fail('empty input must not submit AI'),removeFollower:async()=>{calls++;return {attempted:true,removed:true,accountId:OWNER,targetUserId:TARGET,verifiedAt:1700000000000};}});
  f.rows[0].payload.bio='';f.records.lookup=async()=>({payload:{id:TARGET,handle:HANDLE,bio:'',profileEvidence:{ownerAccountId:OWNER,targetUserId:TARGET,fields:{bio:Date.now()}},fanInspectionTimeline:{ownerAccountId:OWNER,targetUserId:TARGET,status,fetchedAt:Date.now(),posts:[]}}});
  const result=await run(f.create(),'analyze');assert.equal(calls,status==='empty'?1:0);assert.equal(f.rows[0].payload.fanReview.state,status==='empty'?'removed':'verify');
 }
});
