import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {createRecordRuntime} from '../src/features/records/record-runtime.js';
import {createBackgroundRecords} from '../src/features/records/background-record-data.js';
import {createFanReviewBatch} from '../src/features/relationships/follow-review-engine.js';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';

globalThis.IDBKeyRange=IDBKeyRange;

const OWNER='123',OTHER='456';
const fan=(handle,id,extra={})=>({handle,id,accountId:OWNER,relationship:{following:false,followedBy:true},relationshipObservedAt:100,status:'pending',...extra});
function fixture(monitor) {
  const snapshot={monitor:structuredClone(monitor)},saved=new Map();
  let fail=false;
  const storage={local:{async get(keys){return Object.fromEntries(keys.filter(key=>Object.hasOwn(snapshot,key)).map(key=>[key,structuredClone(snapshot[key])]))},async set(patch){Object.assign(snapshot,structuredClone(patch))}}};
  const name=`fan-review-migration-${crypto.randomUUID()}`;
  const options={storage,indexedDB,IDBKeyRange,dbName:name,now:()=>1000,
    durableGet:async key=>structuredClone(saved.get(key)),durableKeys:async()=>[...saved.keys()],
    durableSet:async(key,value)=>{if(fail&&key.startsWith('recordIncremental:')){fail=false;throw Error('injected durable failure')}saved.set(key,structuredClone(value))}};
  return {snapshot,saved,storage,open:()=>createRecordRuntime(options),failNext(){fail=true}};
}
const source=(runtime,handle,accountId=OWNER)=>runtime.lookupAll({sourceKey:'monitor',bucket:'users',handle,accountId});
const directory=(runtime,handle,accountId=OWNER)=>runtime.fanDirectory({handles:[handle],accountId});

test('AI-result filtering paginates the complete review set and bulk approves only every matching identity',async()=>{
  const users=Array.from({length:63},(_,i)=>fan(`pass_${String(i).padStart(2,'0')}`,String(1000+i),{fanReview:{state:'review',source:'manual-ai-analyze',decision:'pass',decisionVersion:1}}));
  users.push(fan('needs_review','2000',{fanReview:{state:'review',decision:'review'}}),fan('uncertain','2001',{fanReview:{state:'review',decision:'uncertain'}}),fan('unlabeled','2002',{fanReview:{state:'review'}}),fan('already_following','2003',{relationship:{following:true,followedBy:false},fanReview:{state:'review',decision:'pass'}}));
  const f=fixture({users}),runtime=f.open();await runtime.migrate();
  const filter={tab:'fanReview',reviewResult:'pass'},found=[];let cursor=null;
  do{const page=await runtime.query({module:'fans',accountId:OWNER,filter,limit:20,cursor});assert.equal(page.matched,63);found.push(...page.records);cursor=page.nextCursor;}while(cursor);
  assert.equal(found.length,63);assert.equal(new Set(found.map(r=>r.handle)).size,63);
  const handles=await runtime.fanInspectionTargets({accountId:OWNER,filter});assert.deepEqual(handles,found.map(r=>r.handle));
  const searched=await runtime.query({module:'fans',accountId:OWNER,filter:{...filter,search:'pass_0'},limit:20});assert.equal(searched.matched,10);
  const noResult=await runtime.query({module:'fans',accountId:OWNER,filter:{tab:'fanReview',reviewResult:'unlabeled'}});assert.deepEqual(noResult.records.map(r=>r.handle),['unlabeled']);
  await assert.rejects(runtime.query({module:'fans',accountId:OWNER,filter:{tab:'fanReview',reviewResult:'invalid'}}),/无效的审核结果筛选/);
  const records=createBackgroundRecords({service:runtime});const store=createFollowQueueStore({indexedDB,IDBKeyRange,dbName:'bulk-review-'+crypto.randomUUID()});
  let checked=0;const batch=createFanReviewBatch({storage:f.storage.local,records,store,readBinding:async()=>({activated:true,accountId:OWNER}),verifyRelationship:async()=>{checked++}});
  await batch.start(OWNER,{action:'approve',allMatching:true,filter});await batch.waitForIdle(OWNER);
  const result=await batch.status(OWNER);assert.equal(result.total,63);assert.equal(result.completed,63);assert.ok(result.results.every(r=>r.status==='approved'));assert.equal(checked,63);
  assert.equal((await store.list({accountId:OWNER})).length,63);assert.equal((await runtime.query({module:'fans',accountId:OWNER,filter})).matched,0);
  assert.equal((await source(runtime,'needs_review'))[0].payload.fanReview.decision,'review');
});

test('latest unrelated facts exclude old reviews from active lists and search without deleting sources',async()=>{
  const review={state:'review',source:'manual-ai-analyze',tags:['old'],decisionVersion:5};
  const user=fan('unrelated','42',{fanReview:review,relationshipObservedAt:100});
  const f=fixture({users:[user],queue:[{...user,relationship:{following:false,followedBy:false},relationshipVerifiedAt:300}]}),runtime=f.open();await runtime.migrate();
  const item=(await directory(runtime,'unrelated'))[0];assert.equal(item.payload.fanCategory,'none');
  for(const tab of ['fanAll','fanReview','fanPending'])assert.equal((await runtime.query({module:'fans',accountId:OWNER,filter:{tab,search:'unrelated'}})).records.length,0);
  assert.equal((await runtime.query({module:'fans',accountId:OWNER,filter:{tab:'fanNone'}})).records.length,1);
  const sources=await source(runtime,'unrelated');assert.equal(sources.length,1);assert.deepEqual(sources[0].payload,user);
});

test('current following relationship outranks historical review workflow',async()=>{
  const f=fixture({users:[fan('followingnow','42',{relationship:{following:true,followedBy:false},fanReview:{state:'review'}})]}),runtime=f.open();await runtime.migrate();
  assert.equal((await directory(runtime,'followingnow'))[0].payload.fanCategory,'following');
});

test('incomplete current relationship is pending verification even when an old AI review exists',async()=>{
  const f=fixture({users:[fan('unverifiedreview','42',{relationship:{following:null,followedBy:null},fanReview:{state:'review',source:'manual-ai-analyze'}})]}),runtime=f.open();await runtime.migrate();
  assert.equal((await directory(runtime,'unverifiedreview'))[0].payload.fanCategory,'unknown');
  assert.equal((await runtime.query({module:'fans',accountId:OWNER,filter:{tab:'fanReview'}})).records.length,0);
});

test('legacy native queue receipts with undefined optional fields migrate without changing the originals',async()=>{
  const f=fixture({users:[fan('legacyreceipt','42')]}),runtime=f.open();await runtime.migrate();
  const job={id:'legacy-job',accountId:OWNER,targetUserId:'42',handle:'legacyreceipt',state:'skipped',
    followResult:{succeeded:false,reason:'历史过滤',followerRemoval:{removed:false,attempted:false,live:undefined}}};
  const before=structuredClone(job);
  const result=await runtime.migrateFanReview({accountId:OWNER,jobs:[job]});
  assert.equal(result.review,1);
  const row=(await source(runtime,'legacyreceipt'))[0].payload;
  assert.equal(row.fanReview.state,'review');
  assert.deepEqual(row.fanReview.migration.queueHistory,[JSON.parse(JSON.stringify(job))]);
  assert.deepEqual(job,before);assert.ok(Object.hasOwn(job.followResult.followerRemoval,'live'));
  assert.deepEqual(row.relationship,{following:false,followedBy:true});
  assert.equal((await runtime.migrateFanReview({accountId:OWNER,jobs:[job]})).updated,0);
});

test('v3 migration preserves relationships, every source, historical queue results and exclusion evidence',async()=>{
  const user=fan('blocked','42',{name:'Original',custom:{keep:true}}),monitor={users:[user],queue:[{...user,status:'skipped'}],followingUsers:[],settings:{keep:true}};
  const f=fixture(monitor),runtime=f.open();await runtime.migrate();
  const job={id:'job-1',accountId:OWNER,targetUserId:'42',handle:'blocked',state:'excluded',reason:'legacy rule',sources:{fans:{at:2},comments:{at:3}},followResult:{attemptedAt:50,succeeded:false},custom:'keep'};
  const tombstones={byId:{'42':{accountId:OWNER,targetUserId:'42',state:'excluded',reason:'keep exclusion'}},byHandle:{}};
  const inputs=structuredClone({jobs:[job],tombstones});
  const result=await runtime.migrateFanReview({accountId:OWNER,...inputs});
  assert.equal(result.updated,2);assert.equal(result.review,1);
  const rows=await source(runtime,'blocked');assert.deepEqual(rows[0].payload.relationship,user.relationship);
  assert.deepEqual(rows[0].payload.custom,{keep:true});assert.equal(rows[0].payload.fanReview.state,'review');
  assert.deepEqual(rows[0].payload.fanReview.migration.queueHistory,[job]);
  assert.deepEqual(rows[0].payload.fanReview.migration.tombstone,tombstones.byId['42']);
  assert.equal((await directory(runtime,'blocked'))[0].payload.fanCategory,'review');
  assert.deepEqual(f.snapshot.monitor,monitor);assert.deepEqual(inputs,{jobs:[job],tombstones});
  assert.equal((await runtime.lookupAll({sourceKey:'monitor',bucket:'queue',handle:'blocked',accountId:OWNER}))[0].payload.status,'skipped');
});

test('migration is idempotent, persists after runtime recreation and does not duplicate journals',async()=>{
  const f=fixture({users:[fan('old','42',{relationshipObservedAt:0})]}),runtime=f.open();await runtime.migrate();
  await runtime.migrateFanReview({accountId:OWNER});const writes=f.saved.size;
  assert.equal((await runtime.migrateFanReview({accountId:OWNER})).updated,0);assert.equal(f.saved.size,writes);
  const reopened=f.open();assert.equal((await directory(reopened,'old'))[0].payload.fanCategory,'unknown');
  assert.equal((await reopened.migrateFanReview({accountId:OWNER})).updated,0);
});

test('owner and stable target identity isolate history; unassigned rows require explicit provenance opt-in',async()=>{
  const f=fixture({users:[fan('same','42'),fan('same','99',{accountId:OTHER}),fan('legacy','77',{accountId:'unassigned'})]}),runtime=f.open();await runtime.migrate();
  await runtime.migrateFanReview({accountId:OWNER,jobs:[{accountId:OTHER,handle:'same',targetUserId:'42',state:'excluded'},{accountId:OWNER,handle:'same',targetUserId:'99',state:'excluded'}]});
  assert.equal((await source(runtime,'same'))[0].payload.fanReview,undefined);
  assert.equal((await source(runtime,'same',OTHER))[0].payload.fanReview,undefined);
  assert.equal((await source(runtime,'legacy','unassigned'))[0].payload.fanReview,undefined);
  await runtime.migrateFanReview({accountId:OWNER,includeUnassigned:true,jobs:[{accountId:OWNER,handle:'legacy',targetUserId:'77',state:'skipped'}]});
  assert.equal((await source(runtime,'legacy','unassigned'))[0].payload.fanReview.migration.ownerAccountId,OWNER);
  assert.equal((await source(runtime,'legacy','unassigned'))[0].accountId,'unassigned');
});

test('same-handle different IDs are quarantined without merging bios or grants',async()=>{
  const f=fixture({users:[fan('reused','42',{bio:'first identity',relationshipObservedAt:200})],queue:[fan('reused','99',{bio:'second identity',fanGrant:{targetUserId:'99',ownerAccountId:OWNER}})]}),runtime=f.open();await runtime.migrate();
  await runtime.migrateFanReview({accountId:OWNER,jobs:[{accountId:OWNER,targetUserId:'99',handle:'reused',state:'followed',followResult:{succeeded:true}}]});
  const row=(await directory(runtime,'reused'))[0];
  assert.equal(row.payload.fanCategory,'unknown');assert.equal(row.payload.id,'42');assert.equal(row.payload.bio,'first identity');assert.equal(row.payload.fanGrant,undefined);
  assert.equal(row.payload.legacyHandleIdentityConflict,true);assert.deepEqual(row.payload.relationship,{following:null,followedBy:null});
  assert.deepEqual((await source(runtime,'reused'))[0].payload.fanReview.migration.queueHistory,[]);
});

test('old removal labels and tombstones cannot manufacture a confirmed removal receipt',async()=>{
  const original={state:'removed',source:'manual-remove',reason:'original evidence',tags:['original']};
  const f=fixture({users:[fan('marked','42',{status:'removed',state:'removed_follower',relationship:{following:false,followedBy:false},fanReview:original})]}),runtime=f.open();await runtime.migrate();
  assert.equal((await directory(runtime,'marked'))[0].payload.fanCategory,'none');
  await runtime.migrateFanReview({accountId:OWNER,tombstones:{byId:{42:{targetUserId:'42',state:'removed',accountId:OWNER}},byHandle:{}}});
  const row=(await source(runtime,'marked'))[0].payload;
  assert.equal(row.fanReview.state,'review');assert.deepEqual(row.fanReview.legacyReview,original);
  assert.equal(row.status,'removed');assert.equal(row.state,'removed_follower');
  assert.equal((await directory(runtime,'marked'))[0].payload.fanCategory,'none');
});

test('only an owner/ID-matched verified receipt projects removed while preserving raw relationship facts',async()=>{
  const base={relationship:{following:false,followedBy:false},status:'removed'};
  const f=fixture({users:[fan('confirmed','42',{...base,fanReview:{state:'removed',source:'manual-remove',reason:'old confirmed intent'}}),fan('wrong','43',base)]}),runtime=f.open();await runtime.migrate();
  await runtime.migrateFanReview({accountId:OWNER,jobs:[
    {accountId:OWNER,handle:'confirmed',targetUserId:'42',state:'skipped',followResult:{followerRemoval:{removed:true,verifiedAt:300,targetUserId:'42',accountId:OWNER}}},
    {accountId:OWNER,handle:'wrong',targetUserId:'43',state:'skipped',followResult:{followerRemoval:{removed:true,verifiedAt:300,targetUserId:'99',accountId:OWNER}}}
  ]});
  assert.equal((await directory(runtime,'confirmed'))[0].payload.fanCategory,'removed');
  assert.equal((await directory(runtime,'wrong'))[0].payload.fanCategory,'none');
  assert.deepEqual((await source(runtime,'confirmed'))[0].payload.relationship,base.relationship);
});

test('an approval cannot override an existing tombstone or an unresolved external removal submission',async()=>{
  const fanReview={state:'approved',source:'manual-approve',decisionVersion:5};
  const f=fixture({users:[fan('excluded','42',{fanReview}),fan('unknownremove','43',{fanReview})]}),runtime=f.open();await runtime.migrate();
  await runtime.migrateFanReview({accountId:OWNER,tombstones:{byId:{42:{accountId:OWNER,targetUserId:'42',state:'excluded'}},byHandle:{}},jobs:[
    {accountId:OWNER,handle:'unknownremove',targetUserId:'43',state:'retry',followResult:{followerRemoval:{attemptedAt:300,removed:false}}}
  ]});
  for(const handle of ['excluded','unknownremove']) {
    assert.equal((await directory(runtime,handle))[0].payload.fanCategory,'review');
    assert.deepEqual((await source(runtime,handle))[0].payload.fanReview.legacyReview,fanReview);
  }
});

test('manual decisions survive generic history; successful follow conflicting with current facts is held for review',async()=>{
  const review={state:'approved',source:'manual-approve',decisionVersion:9,reason:'human choice'};
  const f=fixture({users:[fan('approved','42',{fanReview:review}),fan('historical','43'),fan('unknown','44',{relationship:{}}),{...fan('missing','45'),id:undefined}]}),runtime=f.open();
  delete f.snapshot.monitor.users[3].id;
  await runtime.migrate();await runtime.migrateFanReview({accountId:OWNER,jobs:[{accountId:OWNER,handle:'approved',targetUserId:'42',state:'skipped'},{accountId:OWNER,handle:'historical',targetUserId:'43',state:'followed',followResult:{succeeded:true,at:10}}]});
  assert.deepEqual((await source(runtime,'approved'))[0].payload.fanReview,review);
  for(const handle of ['historical','missing'])assert.equal((await directory(runtime,handle))[0].payload.fanCategory,'review');
  assert.equal((await directory(runtime,'unknown'))[0].payload.fanCategory,'unknown');
  assert.equal((await source(runtime,'historical'))[0].payload.relationship.following,false);
});

test('interrupted durable migration resumes its journal before continuing and recordData exposes the same contract',async()=>{
  const f=fixture({users:[fan('recover','42',{status:'skipped'})]}),runtime=f.open();await runtime.migrate();f.failNext();
  await assert.rejects(runtime.migrateFanReview({accountId:OWNER}),/injected durable failure/);
  const reopened=f.open();const response=await reopened.handle({op:'migrateFanReview',accountId:OWNER});
  assert.equal(response.ok,true);assert.equal((await directory(reopened,'recover'))[0].payload.fanCategory,'review');
  assert.equal((await reopened.handle({op:'fanInspectionTargets',accountId:OWNER,filter:{tab:'fanReview'}})).handles[0],'recover');
  assert.equal(typeof reopened.batch,'function');assert.equal(typeof reopened.fanInspectionTargets,'function');
});

test('batch stable-ID and owner guards reject a late write to a replaced identity',async()=>{
  const f=fixture({users:[fan('swapped','42')]}),runtime=f.open();await runtime.migrate();
  const row=(await source(runtime,'swapped'))[0];
  await runtime.batch({sourceKey:'monitor',changes:[{accountId:OWNER,userKey:row.userKey,sourceBucket:'users',handle:'swapped',patch:{id:'99'}}]});
  await assert.rejects(runtime.batch({sourceKey:'monitor',changes:[{accountId:OWNER,userKey:row.userKey,sourceBucket:'users',handle:'swapped',expectedTargetUserId:'42',expectedOwnerAccountId:OWNER,patch:{fanReview:{state:'approved'}}}]}),error=>error.name==='RecordIdentityConflictError');
  await assert.rejects(runtime.batch({sourceKey:'monitor',changes:[{accountId:OWNER,userKey:row.userKey,sourceBucket:'users',handle:'swapped',expectedTargetUserId:'99',expectedOwnerAccountId:OTHER,patch:{fanReview:{state:'approved'}}}]}),error=>error.name==='RecordIdentityConflictError');
  assert.equal((await source(runtime,'swapped'))[0].payload.fanReview,undefined);
});

test('batch review-version guard preserves a newer human decision against delayed AI',async()=>{
  const fanReview={state:'approved',source:'manual-approve',decisionVersion:3};
  const f=fixture({users:[fan('human','42',{fanReview})]}),runtime=f.open();await runtime.migrate();
  const row=(await source(runtime,'human'))[0];
  const change={accountId:OWNER,userKey:row.userKey,sourceBucket:'users',handle:'human',expectedTargetUserId:'42',expectedOwnerAccountId:OWNER,expectedFanReviewVersion:2,patch:{fanReview:{state:'review',decisionVersion:3}}};
  await assert.rejects(runtime.batch({sourceKey:'monitor',changes:[change]}),error=>error.name==='RecordReviewConflictError');
  assert.deepEqual((await source(runtime,'human'))[0].payload.fanReview,fanReview);
  await runtime.batch({sourceKey:'monitor',changes:[{...change,expectedFanReviewVersion:3,patch:{fanReview:{state:'review',source:'manual-return',decisionVersion:4}}}]});
  assert.equal((await source(runtime,'human'))[0].payload.fanReview.decisionVersion,4);
});

test('legacy ownership opt-in cannot inherit another owners row or reassign a recorded legacy owner',async()=>{
  const f=fixture({users:[fan('foreign','42',{accountId:'unassigned',fanReview:{state:'review',ownerAccountId:OTHER}}),fan('local','43',{accountId:'unassigned',status:'skipped'})]}),runtime=f.open();await runtime.migrate();
  await runtime.migrateFanReview({accountId:OWNER,includeUnassigned:true});
  assert.equal((await source(runtime,'foreign','unassigned'))[0].payload.fanReview.migration,undefined);
  assert.equal((await source(runtime,'local','unassigned'))[0].payload.fanReview.migration.ownerAccountId,OWNER);
  await assert.rejects(runtime.migrateFanReview({accountId:OTHER,includeUnassigned:true}),/already belong to another owner/);
  const row=(await source(runtime,'local','unassigned'))[0];
  await assert.rejects(runtime.batch({sourceKey:'monitor',changes:[{accountId:'unassigned',userKey:row.userKey,sourceBucket:'users',handle:'local',expectedTargetUserId:'43',expectedOwnerAccountId:OTHER,patch:{status:'pending'}}]}),error=>error.name==='RecordIdentityConflictError');
  await runtime.batch({sourceKey:'monitor',changes:[{accountId:'unassigned',userKey:row.userKey,sourceBucket:'users',handle:'local',expectedTargetUserId:'43',expectedOwnerAccountId:OWNER,patch:{custom:'safe'}}]});
  assert.equal((await source(runtime,'local','unassigned'))[0].payload.custom,'safe');
});

test('confirmed legacy ownership makes both pending and migrated-review rows usable by production manual approval without changing relationship facts',async()=>{
  const pending=fan('legacy_pending','42',{accountId:'unassigned'}),held=fan('legacy_review','43',{accountId:'unassigned',status:'skipped'});
  const f=fixture({users:[pending,held],queue:[],followingUsers:[],autoEnqueue:false}),runtime=f.open();await runtime.migrate();
  const migration=await runtime.migrateFanReview({accountId:OWNER,includeUnassigned:true});assert.equal(migration.updated,1);
  const records=createBackgroundRecords({service:runtime});
  const pendingRow=(await records.lookupAll({sourceKey:'monitor',bucket:'users',handle:pending.handle,accountId:'unassigned'}))[0];
  const reviewRow=(await records.lookupAll({sourceKey:'monitor',bucket:'users',handle:held.handle,accountId:'unassigned'}))[0];
  for(const [row,original] of [[pendingRow,pending],[reviewRow,held]]){
    assert.equal(row.accountId,'unassigned');assert.equal(row.payload.accountId,'unassigned');
    assert.deepEqual(row.payload.relationship,original.relationship);assert.equal(row.payload.relationshipObservedAt,original.relationshipObservedAt);
  }
  assert.equal(pendingRow.payload.fanReview,undefined,'ordinary pending history must not receive a fabricated review decision');
  assert.equal(pendingRow.payload.ownerAccountId,undefined,'ordinary pending history uses the exclusive projection owner without a source rewrite');
  assert.equal(await records.fanReviewOwner(),OWNER);
  assert.equal(reviewRow.payload.ownerAccountId,OWNER);
  assert.equal(reviewRow.payload.fanReview.state,'review');assert.equal(reviewRow.payload.fanReview.ownerAccountId,OWNER);assert.equal(reviewRow.payload.fanReview.targetUserId,'43');
  assert.equal((await runtime.migrateFanReview({accountId:OWNER,includeUnassigned:true})).updated,0);
  const store=createFollowQueueStore({indexedDB,IDBKeyRange,dbName:`legacy-approval-${crypto.randomUUID()}`});
  const batch=createFanReviewBatch({storage:f.storage.local,readBinding:async()=>({accountId:OWNER,handle:'owner',activated:true}),records,store,wait:async()=>{}});
  await batch.start(OWNER,{action:'approve',handles:[pending.handle,held.handle],targets:[{handle:pending.handle,targetUserId:'42'},{handle:held.handle,targetUserId:'43'}]});
  let status;
  for(let i=0;i<200;i++){status=await batch.status(OWNER);if(status?.stage!=='running')break;await new Promise(resolve=>setTimeout(resolve,1));}
  assert.equal(status.stage,'completed');assert.deepEqual(status.results.map(result=>result.status),['approved','approved']);
  for(const original of [pending,held]){
    const row=(await records.lookupAll({sourceKey:'monitor',bucket:'users',handle:original.handle,accountId:'unassigned'}))[0];
    assert.equal(row.payload.fanReview.state,'approved');assert.equal(row.payload.fanGrant.ownerAccountId,OWNER);assert.equal(row.payload.fanGrant.targetUserId,original.id);
    assert.deepEqual(row.payload.relationship,original.relationship);assert.equal(row.payload.relationshipObservedAt,original.relationshipObservedAt);
    const job=await store.lookup({accountId:OWNER,handle:original.handle});assert.equal(job.state,'pending');assert.equal(job.targetUserId,original.id);
  }
});

test('ownership repair preserves an existing human review while exposing explicit owner and target metadata',async()=>{
  const fanReview={state:'review',source:'manual-return',decisionVersion:7,reason:'preserved human evidence'};
  const user=fan('old_human_review','42',{accountId:'unassigned',fanReview});
  const f=fixture({users:[user]}),runtime=f.open();await runtime.migrate();
  await runtime.migrateFanReview({accountId:OWNER,includeUnassigned:true});
  const row=(await source(runtime,user.handle,'unassigned'))[0];
  assert.deepEqual(row.payload.fanReview,{...fanReview,ownerAccountId:OWNER,targetUserId:'42'});
  assert.equal(row.payload.ownerAccountId,OWNER);assert.deepEqual(row.payload.relationship,user.relationship);
  assert.equal((await runtime.migrateFanReview({accountId:OWNER,includeUnassigned:true})).updated,0);
});

test('one hundred ordinary legacy rows require no per-source journal; only necessary reviews are written and ownership stays exclusive',async()=>{
  const ordinary=Array.from({length:100},(_,index)=>fan(`ordinary_${index}`,String(index+1000),{accountId:'unassigned'}));
  const held=fan('held_history','42',{accountId:'unassigned',status:'skipped'});
  const f=fixture({users:[...ordinary,held]}),runtime=f.open();await runtime.migrate();
  const before=[...f.saved.keys()].filter(key=>key.includes('recordIncremental:v1:seq:')).length;
  const result=await runtime.migrateFanReview({accountId:OWNER,includeUnassigned:true});
  const after=[...f.saved.keys()].filter(key=>key.includes('recordIncremental:v1:seq:')).length;
  assert.equal(result.updated,1);assert.equal(result.review,1);assert.equal(after-before,1,'only the actual review row may create a durable source journal');
  for(const original of ordinary){
    const row=(await source(runtime,original.handle,'unassigned'))[0];assert.deepEqual(row.payload,original);
  }
  assert.deepEqual(await runtime.handle({op:'fanReviewOwner'}),{ok:true,ownerAccountId:OWNER});
  const reopened=f.open();assert.equal(await reopened.fanReviewOwner(),OWNER);
  assert.equal((await reopened.migrateFanReview({accountId:OWNER,includeUnassigned:true})).updated,0);
  assert.equal([...f.saved.keys()].filter(key=>key.includes('recordIncremental:v1:seq:')).length,after);
  await assert.rejects(reopened.migrateFanReview({accountId:OTHER,includeUnassigned:true}),/already belong to another owner/);
  assert.equal(await reopened.fanReviewOwner(),OWNER);
});
