import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {createRecordRuntime} from '../src/features/records/record-runtime.js';
import {createBackgroundRecords} from '../src/features/records/background-record-data.js';
import {createFanGrant,reviewSettingsKey,removalTombstonesKey} from '../src/features/relationships/follow-review-engine.js';

globalThis.IDBKeyRange=IDBKeyRange;
const OWNER='100';
async function fixture({count=2,skip=false,configured=true,onTag}={}) {
  const values={followQueueBinding:{accountId:OWNER,handle:'owner',activated:true,sources:{fans:true,mutual:true}},monitor:{users:[],queue:[],followingUsers:[]}};
  values[reviewSettingsKey(OWNER)]={initialReviewEnabled:false,followBackSkipRules:skip,ratioLimit:10,
    queueTagging:configured?{provider:'codex',botId:'tag-session',batchSize:10,intervalSeconds:0}:{},commentEngine:{provider:'codex',botId:'comment-session'}};
  const store=createFollowQueueStore({indexedDB,dbName:`live-admission-queue-${crypto.randomUUID()}`});
  await store.saveSettings(OWNER,{enabled:false,minFollowers:0,ratioThreshold:0,blueVerifiedOnly:false,grokEnabled:false,batchLimit:10,inspectLimit:20,scrollRounds:0,dwellSeconds:2});
  const profiles=new Map(),jobs=[],calls={tagging:[],follow:[],remove:[]},tabs=new Map();let tabId=10;
  for(let i=0;i<count;i++) {
    const id=String(i+200),handle=`person_${i}`,fanGrant=createFanGrant({accountId:OWNER,targetUserId:id,handle,source:'manual-approve',decisionVersion:1,at:10});
    const profile={id,handle,name:`Person ${i}`,bio:'Practical software observations.',followersText:'100',followingText:'70',is_blue_verified:false,
      relationship:{following:false,followedBy:true},posts:[{url:`https://x.com/${handle}/status/${900+i}`,text:'A detailed example about reliable systems and practical testing.',textComplete:true,isPinned:false,replyCount:10,repostCount:10,likeCount:10,bookmarkCount:10}]};
    profiles.set(handle,profile);values.monitor.users.push({...structuredClone(profile),accountId:OWNER,relationshipObservedAt:100,fanGrant,
      fanReview:{state:'approved',ownerAccountId:OWNER,targetUserId:id,source:'manual-approve',decisionVersion:1,grant:fanGrant}});
    jobs.push(await store.enqueue({accountId:OWNER,targetUserId:id,handle,sources:[{module:'fans',enabled:true}],fanGrant}));
  }
  const api={storage:{local:{async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(values)).filter(key=>Object.hasOwn(values,key)).map(key=>[key,structuredClone(values[key])]))},async set(patch){Object.assign(values,structuredClone(patch));}}},
    alarms:{clear:async()=>{},getAll:async()=>[],create:async()=>{}},tabs:{query:async()=>[{id:1,url:'https://x.com/owner'}],create:async options=>{const tab={id:++tabId,...options,status:'complete'};tabs.set(tab.id,tab);return tab;},
      get:async id=>tabs.get(id)||{id,url:'https://x.com/owner',status:'complete'},remove:async id=>tabs.delete(id),update:async(id,options)=>Object.assign(tabs.get(id),options)},
    scripting:{executeScript:async({func,args,target})=>[{result:func.name==='readProfileBundle'?structuredClone(profiles.get(args[0])):
      func.name==='readQueueViewerOnPage'?'owner':func.name==='simulateProfileScrollStep'?null:structuredClone(profiles.get(tabs.get(target.tabId)?.url.split('/').pop()))}]}};
  const backups=new Map(),service=createRecordRuntime({storage:api.storage,indexedDB,IDBKeyRange,dbName:`live-admission-records-${crypto.randomUUID()}`,
    durableGet:async key=>structuredClone(backups.get(key)),durableSet:async(key,value)=>backups.set(key,structuredClone(value))});
  values.profileCache=Object.fromEntries([...profiles].map(([handle,p])=>[handle,{...structuredClone(p),profileObservedAt:Date.now(),
    profileEvidence:{ownerAccountId:OWNER,targetUserId:p.id,fields:{bio:Date.now()}},
    fanInspectionTimeline:{ownerAccountId:OWNER,targetUserId:p.id,fetchedAt:Date.now(),status:'ready',posts:p.posts}}]));
  await service.migrate();
  const records=createBackgroundRecords({service});
  const patchSource=async(index,patch)=>{
    const handle=`person_${index}`;
    const row=(await records.lookupAll({sourceKey:'monitor',bucket:'users',accountId:OWNER,handle}))[0];
    await records.batch({sourceKey:'monitor',changes:[{accountId:OWNER,userKey:row.userKey,sourceBucket:'users',handle,patch}]});
  };
  const runtime=createFollowQueueRuntime({api,store,records,wait:async()=>{},
    fetchProfile:async(_tab,handle)=>{const p=profiles.get(handle);return {status:200,json:{data:{user:{result:{rest_id:p.id,legacy:{screen_name:handle,name:p.name,description:p.bio,
      followers_count:Number(p.followersText),friends_count:Number(p.followingText),following:p.relationship.following,followed_by:p.relationship.followedBy},is_blue_verified:p.is_blue_verified}}}}};},
    tagging:async options=>{const {onRelayJobCreated,beforeSubmit,...snapshot}=options;calls.tagging.push(structuredClone(snapshot));
      await onTag?.({options,patchSource,values,profiles,store,jobs});await beforeSubmit?.();
      return {ok:true,results:options.items.map(item=>({handle:item.handle,targetUserId:item.targetUserId,valid:true,decision:'pass',tags:[],reason:'pass',evidence:[]}))};},
    performFollow:async(_tab,target)=>{calls.follow.push(target.id);return {status:200};},
    removeFollower:async options=>{calls.remove.push(options.targetId);throw Error('unexpected removal');}});
  return {api,values,profiles,jobs,store,service,records,runtime,calls,patchSource};
}

test('control: production record adapter and a real multi-person AI batch admit unchanged source decisions',async()=>{
  const f=await fixture();await f.runtime.run(true);
  assert.equal(f.calls.tagging.length,1);assert.equal(f.calls.tagging[0].items.length,2);assert.equal(f.calls.follow.length,2);
});

test('owner-scoped manual return to review during batch AI blocks that user before follow',async()=>{
  const f=await fixture({onTag:async({patchSource})=>{await patchSource(0,{fanGrant:null,fanReview:{state:'review',ownerAccountId:OWNER,targetUserId:'200',decisionVersion:2,source:'manual-return',reason:'human hold'}});}});
  await f.runtime.run(true);assert.ok(!f.calls.follow.includes('200'),'a newer owner-scoped manual hold must override the batch snapshot');
  assert.ok(f.calls.follow.includes('201'),'another unchanged batch member remains eligible');
});

test('a confirmed owner-scoped human removal during AI is not treated as a still-approved queued fan',async()=>{
  const f=await fixture({onTag:async({patchSource})=>{await patchSource(0,{fanGrant:null,fanReview:{state:'removed',ownerAccountId:OWNER,targetUserId:'200',decisionVersion:2,source:'manual-remove',
    removalReceipt:{accountId:OWNER,targetUserId:'200',removed:true,verifiedAt:1700000000000}}});}});
  await f.runtime.run(true);assert.ok(!f.calls.follow.includes('200'),'confirmed removal in current source records must block an old queue snapshot');
});

test('a persisted job grant cannot authorize bypass after current source grant revocation',async()=>{
  const f=await fixture({count:1,skip:true,configured:false});
  await f.patchSource(0,{fanGrant:null,fanReview:{state:'approved',ownerAccountId:OWNER,targetUserId:'200',decisionVersion:2,source:'manual-approve',grant:null}});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,0,'old job grant must not override current source grant/version');
});

test('an older duplicate source grant cannot restore a grant cleared by a newer review decision',async()=>{
  const f=await fixture({count:1,skip:true,configured:false});
  await f.records.batch({sourceKey:'monitor',changes:[{accountId:OWNER,handle:'person_0',sourceBucket:'queue',create:true,patch:structuredClone(f.values.monitor.users[0])}]});
  await f.patchSource(0,{fanGrant:null,fanReview:{state:'approved',ownerAccountId:OWNER,targetUserId:'200',decisionVersion:2,source:'manual-approve',grant:null}});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,0,'the latest review version must revoke an older duplicate source grant');
});

test('control: unchanged owner/ID/version grant still authorizes the explicit bypass setting',async()=>{
  const f=await fixture({count:1,skip:true,configured:false});await f.runtime.run(true);assert.equal(f.calls.follow.length,1);assert.equal(f.calls.tagging.length,0);
});

test('a new tombstone while a batch is awaiting AI prevents follow even with a pass result',async()=>{
  const f=await fixture({onTag:async({values})=>{values[removalTombstonesKey(OWNER)]={byId:{200:{accountId:OWNER,targetUserId:'200',handle:'person_0',state:'excluded',reason:'human exclusion'}},byHandle:{}};}});
  await f.runtime.run(true);assert.ok(!f.calls.follow.includes('200'));assert.ok(f.calls.follow.includes('201'));
});

test('owner switch during AI never executes either old batch member',async()=>{
  const f=await fixture({onTag:async({values})=>{values.followQueueBinding={accountId:'999',handle:'other',activated:true,sources:{fans:true}};}});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,0);assert.equal(f.calls.remove.length,0);
});

test('late lookahead unknown removal receipt remains intact and is never followed after AI completion',async()=>{
  const attemptedAt=1700000000100;let held;
  const f=await fixture({onTag:async({options,store,jobs})=>{
    assert.equal(options.items.length,2);held=jobs.find(job=>job.targetUserId===options.items[1].targetUserId);assert.ok(held);
    assert.equal((await store.get(held.id)).state,'pending','inject into the unclaimed lookahead, not the leased current member');
    const changed=await store.resolveJob({accountId:OWNER,id:held.id,state:'uncertain',followResult:{targetUserId:held.targetUserId,followerRemoval:{accountId:OWNER,targetUserId:held.targetUserId,attemptedAt,removed:false,reason:'unknown real submission'}}});
    assert.equal(changed.ok,true,'the external receipt must actually be persisted for this race test');
  }});
  await f.runtime.run(true);assert.ok(held);assert.ok(!f.calls.follow.includes(held.targetUserId));assert.equal(f.calls.remove.length,0);
  const after=await f.store.get(held.id);assert.equal(after.followResult.followerRemoval.attemptedAt,attemptedAt);assert.equal(after.state,'uncertain');
});

test('an existing unknown follow submission is never revived by source approval or batch lookahead',async()=>{
  const f=await fixture({count:1});
  await f.store.resolveJob({accountId:OWNER,id:f.jobs[0].id,state:'pending',followResult:{targetUserId:'200',attemptedAt:1700000000100,succeeded:false}});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,0);assert.equal(f.calls.tagging.length,0);assert.equal((await f.store.get(f.jobs[0].id)).state,'uncertain');
});

test('a manual hold arriving while the final following intent is persisted is rechecked before the network action',async()=>{
  const f=await fixture({count:1}),settle=f.store.settle.bind(f.store);let held=false;
  f.store.settle=async options=>{
    const result=await settle(options);
    if(!held&&options.patch?.stage==='following'){
      held=true;await f.patchSource(0,{fanGrant:null,fanReview:{state:'review',ownerAccountId:OWNER,targetUserId:'200',decisionVersion:2,source:'manual-return',reason:'hold during final checkpoint'}});
    }
    return result;
  };
  await f.runtime.run(true);assert.equal(held,true);assert.equal(f.calls.follow.length,0,'a persisted intent is not permission to ignore a newer source hold');
});

test('a bypass grant revoked during the final following checkpoint cannot authorize an unfiltered follow',async()=>{
  const f=await fixture({count:1,skip:true,configured:false}),settle=f.store.settle.bind(f.store);let revoked=false;
  f.store.settle=async options=>{
    const result=await settle(options);
    if(!revoked&&options.patch?.stage==='following'){
      revoked=true;await f.patchSource(0,{fanGrant:null,fanReview:{state:'approved',ownerAccountId:OWNER,targetUserId:'200',decisionVersion:2,source:'manual-approve',grant:null}});
    }
    return result;
  };
  await f.runtime.run(true);assert.equal(revoked,true);assert.equal(f.calls.follow.length,0,'post-checkpoint guard must revalidate bypass permission, including its decision version');
});

test('an admitted ordinary fan still follows when reverse relationship changes during AI',async()=>{
  const f=await fixture({count:1,onTag:async({profiles})=>{profiles.get('person_0').relationship.followedBy=false;}});
  await f.runtime.run(true);assert.equal(f.calls.follow.length,1,'reverse relationship does not revoke an admitted follow task');
});


test('ready approved fans execute while a full source scan is still waiting, and sync callers coalesce',async()=>{
 const f=await fixture({count:1,skip:true,configured:false});let unblock,scans=0;
 const pending=new Promise(resolve=>unblock=resolve);const original=f.records.sourcePage;
 f.records.sourcePage=async request=>{scans++;await pending;return original(request)};
 let timeout;try{
  await Promise.race([f.runtime.run(true),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('ready follow blocked by source scan')),2500)})]);
  assert.equal(f.calls.follow.length,1);assert.equal(f.calls.tagging.length,0);assert.equal(scans,1);
  const a=f.runtime.syncCandidates(),b=f.runtime.syncCandidates();assert.equal(scans,1);unblock();await Promise.all([a,b]);
 }finally{clearTimeout(timeout);unblock();}
});
