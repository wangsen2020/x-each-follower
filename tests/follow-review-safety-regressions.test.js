import test from 'node:test';
import assert from 'node:assert/strict';
import {createFanReviewBatch,reviewSettingsKey,fanReviewBatchKey,recordRemovalTombstone,readRemovalTombstones,runTaggingBatch} from '../src/features/relationships/follow-review-engine.js';

const OWNER='owner';
const TARGET='100';
const HANDLE='selected_user';
const SUBMITTED_AT=1700000000100;
const clone=value=>structuredClone(value);

function fixture({payload={handle:HANDLE,id:TARGET,bio:'Available biography',relationship:{following:false,followedBy:true}},job=null,removeFollower,getService,
  readBinding=async()=>({activated:true,accountId:OWNER})}={}) {
  const values={};
  const rows=[{accountId:OWNER,module:'fans',userKey:'monitor/users/'+HANDLE,handle:HANDLE,
    sourceKey:'monitor',sourcePath:['monitor','users',HANDLE],payload:clone(payload)}];
  const storage={
    get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,clone(values[key])])),
    set:async patch=>Object.assign(values,clone(patch))
  };
  const records={
    lookupAll:async ({sourceKey,bucket,handle})=>clone(rows.filter(row=>row.sourceKey===sourceKey&&row.sourcePath[1]===bucket&&row.handle===handle)),
    batch:async ({sourceKey,changes})=>{
      for(const change of changes){
        const row=rows.find(row=>row.sourceKey===sourceKey&&row.sourcePath[1]===change.sourceBucket&&row.handle===change.handle);
        if(row)row.payload={...row.payload,...clone(change.patch)};
        else if(change.create)rows.push({accountId:change.accountId||OWNER,module:'fans',userKey:sourceKey+'/'+change.sourceBucket+'/'+change.handle,
          handle:change.handle,sourceKey,sourcePath:[sourceKey,change.sourceBucket,change.handle],payload:clone(change.patch)});
      }
      return {ok:true};
    }
  };
  let savedJob=clone(job);
  const resolutions=[];
  const store={
    lookup:async()=>clone(savedJob),
    resolveJob:async change=>{resolutions.push(clone(change));if(savedJob)savedJob={...savedJob,...clone(change)};return {ok:true,job:clone(savedJob)};},
    enqueue:async input=>{
      if(!savedJob)savedJob={id:'new-job',state:'pending',targetUserId:input.targetUserId,followResult:{}};
      return clone(savedJob);
    }
  };
  const create=()=>createFanReviewBatch({storage,records,store,readBinding,removeFollower,...(getService?{getService}:{})});
  return {rows,values,storage,records,store,resolutions,create,getJob:()=>clone(savedJob)};
}

async function run(batch,action) {
  await batch.start(OWNER,{action,handles:[HANDLE],targets:[{handle:HANDLE,targetUserId:TARGET}]});
  await batch.waitForIdle(OWNER);
}

test('review removal preserves the identity frozen by the UI when the same handle now belongs to another ID',async()=>{
  const calls=[];
  const context=fixture({payload:{handle:HANDLE,id:'200',relationship:{following:false,followedBy:true}},
    removeFollower:async target=>{calls.push(clone(target));return {attempted:false,removed:false,reason:'identity fixture'};}});
  const batch=context.create();
  try{await run(batch,'remove');}catch(error){assert.match(error.message,/身份|ID|账号|目标/);}
  assert.ok(calls.every(call=>call.targetUserId===TARGET),
    'a later handle lookup must not replace the selected stable user ID in a removal request');
  assert.equal(context.rows[0].payload.id,'200','identity conflict must not rewrite the current record to the selected ID');
});

test('manual approval changes review disposition without inventing relationship facts or observation times',async()=>{
  const original={handle:HANDLE,id:TARGET,relationship:{},relationshipObservedAt:1700000000000};
  const context=fixture({payload:original});
  await run(context.create(),'approve');
  const after=context.rows[0].payload;
  assert.deepEqual(after.relationship,original.relationship,'approval is not evidence of following or followedBy');
  assert.equal(after.relationshipObservedAt,original.relationshipObservedAt);
  assert.equal(after.followingObservedAt,undefined,'approval must not manufacture an X relationship observation');
  assert.equal(after.followedByObservedAt,undefined,'approval must not manufacture an X relationship observation');
});

test('manual approval never reopens an uncertain externally submitted follow or follower removal',async()=>{
  const pendingCounts=[],states=[];
  for(const receipt of [
    {attemptedAt:SUBMITTED_AT,targetUserId:TARGET,reason:'follow result unknown'},
    {targetUserId:TARGET,followerRemoval:{attemptedAt:SUBMITTED_AT,targetUserId:TARGET,removed:false},reason:'removal result unknown'}
  ]){
    const job={id:'existing-job',accountId:OWNER,handle:HANDLE,targetUserId:TARGET,state:'uncertain',stage:'verify',followResult:receipt};
    const context=fixture({job});
    try{await run(context.create(),'approve');}catch(error){assert.match(error.message,/确认|未知|核实|操作|审核|移除/);}
    pendingCounts.push(context.resolutions.filter(change=>change.state==='pending'||change.state==='retry').length);
    states.push(context.getJob().state);
    if(receipt.attemptedAt)assert.equal(context.getJob().followResult.attemptedAt,SUBMITTED_AT);
    if(receipt.followerRemoval)assert.deepEqual(context.getJob().followResult.followerRemoval,receipt.followerRemoval);
  }
  assert.deepEqual(pendingCounts,[0,0],'approval must not make an unknown follow or removal eligible for replay');
  assert.deepEqual(states,['uncertain','uncertain']);
});

test('a submitted but unconfirmed follower removal is not submitted again after a new start or runtime recreation',async()=>{
  let submissions=0;
  const context=fixture({removeFollower:async()=>{
    submissions++;
    return {attempted:true,removed:false,targetUserId:TARGET,attemptedAt:SUBMITTED_AT,reason:'移除已提交，结果未知，需核实'};
  }});
  const firstRuntime=context.create();
  await run(firstRuntime,'remove');
  assert.equal(submissions,1);
  const submissionCounts=[];
  for(const runtime of [firstRuntime,context.create()]){
    try{await run(runtime,'remove');}catch(error){assert.match(error.message,/确认|未知|核实|移除|未决/);}
    submissionCounts.push(submissions);
  }
  assert.deepEqual(submissionCounts,[1,1],'the durable unresolved receipt must block resubmission across start and runtime recreation');
});

function deferred() {let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}

test('stopping while the current AI chunk is being saved prevents submitting the next chunk',async()=>{
  const saving=deferred(),release=deferred();let generations=0,blocked=false;
  const service={
    status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[{id:'tag-session'}],
    generate:async (_prompt,options)=>{
      generations++;
      await options.onJobCreated?.({id:'local:chunk-'+generations});
      return {ok:true,text:JSON.stringify([{handle:generations===1?HANDLE:'second_user',targetUserId:generations===1?TARGET:'200',decision:'pass'}])};
    }
  };
  const context=fixture({getService:()=>service});
  context.values[reviewSettingsKey(OWNER)]={fanTagging:{provider:'codex',botId:'tag-session',batchSize:1,intervalSeconds:0}};
  context.rows.push({...clone(context.rows[0]),handle:'second_user',userKey:'monitor/users/second_user',sourcePath:['monitor','users','second_user'],
    payload:{handle:'second_user',id:'200',bio:'Available second biography',relationship:{following:false,followedBy:true}}});
  const saveRecords=context.records.batch;
  context.records.batch=async change=>{if(!blocked){blocked=true;saving.resolve();await release.promise;}return saveRecords(change);};
  const batch=context.create();
  await batch.start(OWNER,{action:'analyze',handles:[HANDLE,'second_user'],targets:[{handle:HANDLE,targetUserId:TARGET},{handle:'second_user',targetUserId:'200'}]});
  await saving.promise;
  const stopped=await batch.stop(OWNER);assert.equal(stopped.stopping,true);
  release.resolve();await batch.waitForIdle(OWNER);
  const result=await batch.status(OWNER);
  assert.equal(generations,1,'a stop received during result persistence must not be overwritten by a stale batch snapshot');
  assert.equal(result.stage,'paused');assert.equal(result.nextIndex,1);assert.equal(result.completed,1);
});

test('a restarted worker exposes persisted running work as resumable without losing its original AI receipt',async()=>{
  const context=fixture();
  const key=fanReviewBatchKey(OWNER);
  context.values[key]={id:'persisted-batch',accountId:OWNER,action:'analyze',stage:'running',stopping:false,total:1,completed:0,nextIndex:0,
    inFlightRelayJobId:'local:original-unknown',roleSnapshot:{provider:'codex',botId:'tag-session',batchSize:1,intervalSeconds:0},
    items:[{handle:HANDLE,targetUserId:TARGET,decisionVersion:0}],results:[],startedAt:1700000000000};
  const restarted=context.create();
  const status=await restarted.status(OWNER);
  assert.equal(status.stage,'paused','a batch with no live worker must offer continuation rather than remain indefinitely running');
  assert.equal(status.nextIndex,0);assert.equal(status.completed,0);
  assert.equal(context.values[key].inFlightRelayJobId,'local:original-unknown','recovery must preserve the original submitted job for querying');
});

test('an AI result arriving after owner and same-handle identity changes cannot annotate the replacement record',async()=>{
  const submitted=deferred(),release=deferred();let boundOwner=OWNER;
  const service={
    status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[{id:'tag-session'}],
    generate:async (_prompt,options)=>{
      await options.onJobCreated?.({id:'local:old-owner-result'});submitted.resolve();await release.promise;
      return {ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass',tags:['old-account-only'],reason:'original identity review'}])};
    }
  };
  const context=fixture({getService:()=>service,readBinding:async()=>({activated:true,accountId:boundOwner})});
  context.values[reviewSettingsKey(OWNER)]={fanTagging:{provider:'codex',botId:'tag-session',batchSize:1,intervalSeconds:0}};
  const batch=context.create();
  await batch.start(OWNER,{action:'analyze',handles:[HANDLE],targets:[{handle:HANDLE,targetUserId:TARGET}]});
  await submitted.promise;
  boundOwner='another-owner';
  const replacement={handle:HANDLE,id:'200',relationship:{},name:'Replacement account'};
  context.rows[0]={...context.rows[0],accountId:boundOwner,payload:clone(replacement)};
  release.resolve();await batch.waitForIdle(OWNER);
  assert.deepEqual(context.rows[0].payload,replacement,'late AI output must recheck both bound owner and frozen target ID before persistence');
});

test('concurrent follower-removal tombstones retain every removed stable ID and handle',async()=>{
  const context=fixture();
  await Promise.all([
    recordRemovalTombstone(context.storage,OWNER,{targetUserId:'100',handle:'first_removed',reason:'first rule'}),
    recordRemovalTombstone(context.storage,OWNER,{targetUserId:'200',handle:'second_removed',reason:'second rule'})
  ]);
  const saved=await readRemovalTombstones(context.storage,OWNER);
  assert.deepEqual(Object.keys(saved.byId).sort(),['100','200'],'one removal must not overwrite another removal marker');
  assert.deepEqual(Object.keys(saved.byHandle).sort(),['first_removed','second_removed']);
  assert.equal(saved.byId['100'].reason,'first rule');assert.equal(saved.byId['200'].reason,'second rule');
});

test('an original AI receipt is queried even when current connection or session configuration is unavailable',async()=>{
  const resumed=[],generated=[];
  const result=await runTaggingBatch({role:'fanTagging',roleConfig:{provider:'codex',botId:'original-session'},
    items:[{handle:HANDLE,targetUserId:TARGET}],relayJobId:'local:original-unknown',
    getService:()=>({
      status:async()=>({enabled:false}),configuration:async()=>({bot:'different-session'}),
      list:async()=>{throw Error('current session service unavailable');},
      generate:async (...args)=>{generated.push(args);throw Error('must not submit another generation');},
      resume:async id=>{resumed.push(id);return {ok:true,jobId:id,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass',reason:'restored original receipt'}])};}
    })});
  assert.deepEqual(resumed,['local:original-unknown'],'saved job.connection should recover the submitted task without validating a new connection');
  assert.deepEqual(generated,[]);assert.equal(result.ok,true);assert.equal(result.results[0].valid,true);
  assert.equal(result.results[0].targetUserId,TARGET);
});

// Additional inspected defects are reported separately: functional createIfMissing
// patches are spread without being invoked, and requestKey omits owner/input version.
