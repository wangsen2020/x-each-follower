import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createRecordRuntime} from '../src/features/records/record-runtime.js';
import {createBackgroundRecords} from '../src/features/records/background-record-data.js';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
import {createFanReviewBatch,defaultReviewSettings,reviewSettingsKey,buildTaggingPrompt,fanReviewBatchKey} from '../src/features/relationships/follow-review-engine.js';
globalThis.IDBKeyRange=IDBKeyRange;
test('manual review prompt names the richer scope and labels truncated post fragments',()=>{
  const prompt=buildTaggingPrompt({role:'fanReview',items:[{handle:'person',posts:[{text:'Partial',textComplete:false}],information:{posts:'partial'}}]});
  assert.match(prompt,/人工复审/);assert.match(prompt,/不能当作全文/);assert.match(prompt,/"textComplete":false/);assert.match(prompt,/"posts":"partial"/);
});
test('queue status is available before activation and never initiates relationship or timeline reads',async()=>{
  const f=await fixture();f.values.followQueueBinding.activated=false;
  const empty=await f.runtime.handle({cmd:'followQueueFanProfileStatus'});
  assert.equal(empty.ok,true);assert.equal(empty.requiresActivation,true);
  f.values.followQueueBinding.activated=true;await f.inspect();
  const before=structuredClone(f.values),counts=f.counts();
  const status=await f.runtime.handle({cmd:'followQueueFanProfileStatus'});
  assert.equal(status.ok,true);assert.equal(status.accountId,OWNER);assert.equal(status.items[0].handle,HANDLE);
  assert.equal(status.summary.pending,1);assert.deepEqual(f.counts(),counts);assert.deepEqual(f.values,before);
});
const OWNER='123',TARGET='42',HANDLE='person';
const post={handle:HANDLE,url:'https://x.com/person/status/900',text:'Fresh cached original post',textComplete:true,createdAt:Date.now()};
async function fixture({timeline=async()=>({status:200,posts:[post],complete:true}),fetchUser,initial={}}={}){
  const config={...defaultReviewSettings(),fanTagging:{provider:'codex',botId:'dedicated-review',prompt:'',batchSize:10,intervalSeconds:0}};
  const values={followQueueBinding:{activated:true,accountId:OWNER,handle:'viewer',sources:{fans:true}},[reviewSettingsKey(OWNER)]:config,
    monitor:{enabled:false,users:[{id:TARGET,handle:HANDLE,accountId:OWNER,bio:'Old biography',followersText:'3',followingText:'5',relationship:{following:false,followedBy:true},fanReview:{state:'review',decisionVersion:1},...initial}]}};
  const storage={get:async keys=>{if(keys==null)return structuredClone(values);return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(values[k])]))},set:async patch=>Object.assign(values,structuredClone(patch))};
  const durable=new Map();const service=createRecordRuntime({indexedDB,IDBKeyRange,storage:{local:storage},dbName:'fan-profile-real-'+crypto.randomUUID(),
    durableGet:async k=>structuredClone(durable.get(k)),durableKeys:async()=>[...durable.keys()],durableSet:async(k,v)=>durable.set(k,structuredClone(v))});
  await service.migrate();const records=createBackgroundRecords({service});let latest='New biography',timelineReads=0,relationshipReads=0;
  const api={storage:{local:storage},alarms:{create:async()=>{},clear:async()=>{}},tabs:{query:async()=>[{id:1}],remove:async()=>{}},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const store={lookup:async()=>null};
  const runtime=createFollowQueueRuntime({api,records,store,wait:async()=>{},fetchUser:async()=>{relationshipReads++;return fetchUser?fetchUser(relationshipReads):{id:TARGET,handle:HANDLE,name:'Verified name',bio:latest,followersText:'0',followingText:'9',relationshipKnown:true,relationship:{following:false,followedBy:true}}},
    fetchFanTimeline:async item=>{timelineReads++;return timeline(item)}});
  const inspect=()=>runtime.handle({cmd:'followQueueInspectFan',handle:HANDLE,expectedTargetUserId:TARGET});
  return {values,storage,service,records,store,runtime,inspect,config,setBio:value=>latest=value,counts:()=>({relationshipReads,timelineReads})};
}
test('real record service saves the same inspection response, preserves decisions, and collects posts outside relationship checking',async()=>{
  const f=await fixture();const before=structuredClone(f.values[reviewSettingsKey(OWNER)]);const inspected=await f.inspect();
  assert.equal(inspected.ok,true);assert.deepEqual(inspected.relationship,{following:false,followedBy:true});assert.equal(inspected.profileCollection.profile,'saved');
  assert.deepEqual(f.counts(),{relationshipReads:1,timelineReads:0});
  const source=(await f.records.lookupAll({sourceKey:'monitor',bucket:'users',handle:HANDLE}))[0].payload;
  assert.equal(source.bio,'New biography');assert.equal(source.followersText,'0');assert.equal(source.followingText,'9');assert.equal(source.fanReview.decisionVersion,1);
  await f.runtime.fanProfiles.run();const cache=(await f.records.lookup({module:'profiles',handle:HANDLE})).payload;
  assert.equal(cache.fanInspectionTimeline.posts[0].text,post.text);assert.deepEqual(f.values[reviewSettingsKey(OWNER)],before);
  await assert.rejects(f.records.batch({sourceKey:'profileCache',changes:[{handle:HANDLE,sourceBucket:'map',patch:{id:'999',targetUserId:'999'},expectedTargetUserId:'999'}]}),/stable user ID/);
  assert.equal((await f.records.lookup({module:'profiles',handle:HANDLE})).payload.id,TARGET);
});
test('manual AI review reuses latest collected biography and cached posts without X navigation; auto initial also accepts existing optional evidence',async()=>{
  const f=await fixture();await f.inspect();await f.runtime.fanProfiles.run();f.setBio('Latest collected biography');await f.inspect();let input,relationshipReads=0;
  const ai={status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[{id:'dedicated-review'}],generate:async prompt=>{
    input=prompt;return {ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass',tags:['normal']}])};}};
  const batch=createFanReviewBatch({storage:f.storage,records:f.records,store:f.store,readBinding:async()=>f.values.followQueueBinding,
    verifyRelationship:()=>{relationshipReads++;throw Error('AI review must use saved evidence');},getService:()=>ai});
  await batch.start(OWNER,{action:'analyze',handles:[HANDLE],targets:[{handle:HANDLE,targetUserId:TARGET}]});await batch.waitForIdle(OWNER);
  assert.equal(relationshipReads,0);assert.match(input,/Latest collected biography/);assert.match(input,/Fresh cached original post/);assert.match(input,/"followersText":"0"/);assert.match(input,/"posts":"ready"/);
  assert.equal(f.counts().timelineReads,1);assert.equal((await batch.status(OWNER)).results[0].status,'pass');
  const initial=buildTaggingPrompt({role:'fanTagging',items:[{...post,handle:HANDLE,bio:'Only biography',posts:[post],followersText:'999'}]});
  assert.ok(initial.includes(post.text));assert.ok(initial.includes('"followersText":"999"'));assert.match(initial,/Only biography/);
});
test('timeline 429, malformed data, and cache persistence failures never undo a verified relationship',async()=>{
  for(const timeline of [async()=>({status:429,error:'rate limited'}),async()=>({status:200}),async()=>{throw Error('offline')}]){
    const f=await fixture({timeline});const result=await f.inspect();assert.equal(result.ok,true);assert.equal(result.relationship.followedBy,true);
    await f.runtime.fanProfiles.run();assert.equal((await f.records.lookupAll({sourceKey:'monitor',bucket:'users',handle:HANDLE}))[0].payload.relationship.followedBy,true);
    assert.ok(['rate-limited','failed'].includes((await f.records.lookup({module:'profiles',handle:HANDLE})).payload.fanInspectionTimeline.status));
  }
  const f=await fixture(),original=f.records.batch;f.records.batch=options=>options.sourceKey==='profileCache'?Promise.reject(Error('cache unavailable')):original(options);
  const result=await f.inspect();assert.equal(result.ok,true);assert.equal(result.profileCollection.profile,'failed');
  assert.equal((await f.records.lookupAll({sourceKey:'monitor',bucket:'users',handle:HANDLE}))[0].payload.bio,'New biography');
});

test('resuming an already submitted AI task keeps its frozen evidence and original receipt',async()=>{
  const f=await fixture();await f.inspect();await f.runtime.fanProfiles.run();let generations=0,resumptions=0;
  const service={status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[{id:'dedicated-review'}],
    generate:async(prompt,options)=>{generations++;await options.onJobCreated({id:'existing-job'});return {pending:true,jobId:'existing-job',reason:'waiting'}},
    resume:async receipt=>{resumptions++;assert.equal(receipt,'existing-job');return {ok:true,text:JSON.stringify([{handle:HANDLE,targetUserId:TARGET,decision:'pass'}])}}};
  const options={storage:f.storage,records:f.records,store:f.store,readBinding:async()=>f.values.followQueueBinding,verifyRelationship:()=>f.inspect(),getService:()=>service};
  const first=createFanReviewBatch(options);await first.start(OWNER,{action:'analyze',handles:[HANDLE],targets:[{handle:HANDLE,targetUserId:TARGET}]});await first.waitForIdle(OWNER);
  const batchKey=fanReviewBatchKey(OWNER);
  const old=structuredClone(f.values[batchKey].inFlightItems);assert.equal(old[0].posts[0].text,post.text);
  await f.records.batch({sourceKey:'profileCache',changes:[{handle:HANDLE,sourceBucket:'map',patch:{bio:'Newer biography while waiting',fanInspectionTimeline:{status:'failed'}}}]});
  const second=createFanReviewBatch(options);await second.resume(OWNER);await second.waitForIdle(OWNER);
  assert.equal(generations,1);assert.equal(resumptions,1);assert.equal((await second.status(OWNER)).results[0].status,'pass');
});
test('successive AI chunks freeze their own account rather than reusing the previous chunk evidence',async()=>{
  const f=await fixture();f.values[reviewSettingsKey(OWNER)].fanTagging.batchSize=1;
  await f.records.batch({sourceKey:'monitor',changes:[{handle:'second',sourceBucket:'users',create:true,accountId:OWNER,patch:{accountId:OWNER,id:'43',handle:'second',bio:'Second description',relationship:{following:false,followedBy:true}}}]});
  const seen=[],service={status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[{id:'dedicated-review'}],generate:async prompt=>{
    const items=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')));seen.push(items.map(item=>item.handle));
    return {ok:true,text:JSON.stringify(items.map(item=>({handle:item.handle,targetUserId:item.targetUserId,decision:'pass'})))};
  }};
  const batch=createFanReviewBatch({storage:f.storage,records:f.records,store:f.store,readBinding:async()=>f.values.followQueueBinding,getService:()=>service,wait:async()=>{}});
  await batch.start(OWNER,{action:'analyze',handles:[HANDLE,'second'],targets:[{handle:HANDLE,targetUserId:TARGET},{handle:'second',targetUserId:'43'}]});await batch.waitForIdle(OWNER);
  assert.deepEqual(seen,[[HANDLE],['second']]);assert.equal((await batch.status(OWNER)).completed,2);
});

test('verified identity clears a stale conflict but keeps handle reuse history across reloads',async()=>{
 const f=await fixture({initial:{legacyHandleIdentityConflict:true,fanReview:{state:'review',source:'legacy-migration',reason:'历史账号身份冲突',decisionVersion:1}},
  fetchUser:()=>({id:TARGET,handle:HANDLE,relationshipKnown:true,relationship:{following:true,followedBy:true}})});
 let reconciled=0;f.store.lookup=async()=>({id:'legacy',state:'followed',handle:HANDLE,targetUserId:''});f.store.enqueue=()=>{reconciled++;throw Error('do not merge old owner history')};
 await f.runtime.handle({cmd:'followQueueInspectFan',handle:HANDLE});
 let row=(await f.records.lookupAll({sourceKey:'monitor',bucket:'users',handle:HANDLE}))[0];
 assert.equal(row.payload.legacyHandleIdentityConflict,false);assert.equal(row.payload.legacyHandleIdentityHistory,true);
 assert.equal((await f.records.fanDirectory([HANDLE],{accountId:OWNER}))[0].payload.fanCategory,'mutual');
 await f.runtime.handle({cmd:'followQueueInspectFan',handle:HANDLE});assert.equal(reconciled,0);
 assert.equal((await f.records.fanDirectory([HANDLE],{accountId:OWNER}))[0].payload.relationshipKnown,true);
});

test('incomplete inspection retries once and saves an actionable reason without AI or follow writes',async()=>{
 const f=await fixture({fetchUser:()=>null});
 await assert.rejects(f.inspect(),/X 未返回该账号资料，已重试一次/);
 assert.equal(f.counts().relationshipReads,2);
 const row=(await f.records.lookupAll({sourceKey:'monitor',bucket:'users',handle:HANDLE}))[0].payload;
 assert.equal(row.relationshipKnown,false);assert.equal(row.fanInspectionFailure.code,'profile_missing');
 assert.equal((await f.records.fanDirectory([HANDLE],{accountId:OWNER}))[0].payload.fanCategory,'unknown');
 assert.match((await f.records.fanDirectory([HANDLE],{accountId:OWNER}))[0].payload.fanRelationshipReason,/已重试一次/);
});

test('a complete second read recovers a transient omission and clears the old failure',async()=>{
 const f=await fixture({initial:{fanInspectionFailure:{code:'profile_missing',reason:'old failure'}},fetchUser:n=>n===1?null:{id:TARGET,handle:HANDLE,relationshipKnown:true,relationship:{following:false,followedBy:true}}});
 assert.equal((await f.inspect()).ok,true);assert.equal(f.counts().relationshipReads,2);
 assert.equal((await f.records.lookupAll({sourceKey:'monitor',bucket:'users',handle:HANDLE}))[0].payload.fanInspectionFailure,null);
});


test('explicit reinspection restarts an exhausted evidence round without an automatic infinite loop',async()=>{
 const f=await fixture({initial:{fanReview:{state:'verify',decision:'uncertain',source:'manual-ai-analyze',enrichmentCompletedAt:123,decisionVersion:2}}});
 await f.runtime.handle({cmd:'followQueueInspectFan',handle:HANDLE});
 const review=(await f.records.lookupAll({sourceKey:'monitor',bucket:'users',handle:HANDLE}))[0].payload.fanReview;
 assert.equal(review.state,'verify');assert.equal(review.enrichmentCompletedAt,0);assert.ok(review.enrichmentStartedAt>0);assert.equal(review.decisionVersion,3);
});
