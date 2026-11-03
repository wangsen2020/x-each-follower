import test from 'node:test';
import assert from 'node:assert/strict';
import {createFanProfileCollector,FAN_PROFILE_STATE,FAN_PROFILE_SPACING} from '../src/features/relationships/fan-profile-collector.js';
import {FAN_TIMELINE_TTL,inspectionProfilePatch,reviewProfileEvidence,cachedReviewPosts} from '../src/features/relationships/fan-profile-evidence.js';
const owner='123',id='42',handle='person';
const target={id,handle,name:'New name',bio:'Fresh biography',followersText:'0',followingText:'100'};
const post=(n,extra={})=>({url:`https://x.com/person/status/${1000+n}`,text:`Original ${n}`,handle,createdAt:n,textComplete:true,...extra});
function fixture(read=async()=>({status:200,posts:[post(1)],complete:true})){
  const values={},profiles=new Map(),calls=[],alarms=[];let time=1000000,account=owner;
  const options={storage:{get:async key=>({[key]:structuredClone(values[key])}),set:async patch=>Object.assign(values,structuredClone(patch))},
    alarms:{create:async(name,config)=>alarms.push({name,...config}),clear:async()=>{}},binding:async()=>({activated:true,accountId:account}),
    readProfile:async item=>structuredClone(profiles.get(item.handle)||{}),
    updateProfile:async(item,update)=>{const old=profiles.get(item.handle)||{};profiles.set(item.handle,{...old,...await update(structuredClone(old))})},
    readTimeline:async item=>{calls.push(item);return read(item)},now:()=>time};
  return {values,profiles,calls,alarms,options,collector:createFanProfileCollector(options),tick:ms=>time+=ms,switch:next=>account=next};
}
test('inspection stores fresh basic fields, preserves old data, and only schedules timeline IO',async()=>{
  const f=fixture();f.profiles.set(handle,{id,handle,bio:'old',posts:[post(0)],custom:'keep'});
  await f.collector.observe(target,owner);
  const profile=f.profiles.get(handle);assert.equal(profile.bio,target.bio);assert.equal(profile.followersText,'0');assert.equal(profile.custom,'keep');assert.equal(profile.posts.length,1);
  assert.equal(profile.fanInspectionTimeline.status,'pending');assert.equal(f.calls.length,0);assert.equal(Object.keys(f.values[FAN_PROFILE_STATE].pending).length,1);
  await f.collector.observe(target,owner);assert.equal(Object.keys(f.values[FAN_PROFILE_STATE].pending).length,1);
});
test('absent fields preserve values while an explicitly empty biography clears its old value',()=>{
  const absent=inspectionProfilePatch({...target,bio:'',followersText:'',profileFieldPresence:{bio:false,followersText:false}},owner);
  assert.equal(Object.hasOwn(absent,'bio'),false);assert.equal(Object.hasOwn(absent,'followersText'),false);
  assert.equal(inspectionProfilePatch({...target,bio:'',profileFieldPresence:{bio:true}},owner).bio,'');
});
test('one timeline read caches ten newest unique original posts and preserves history',async()=>{
  const posts=Array.from({length:15},(_,i)=>post(i));posts.push(post(14),post(90,{kind:'reply'}),post(91,{isPinned:true}),post(92,{kind:'quote'}),post(93,{handle:'other',url:'https://x.com/other/status/9'}));
  const f=fixture(async()=>({status:200,posts,complete:false}));f.profiles.set(handle,{id,handle,posts:[post(99)]});await f.collector.observe(target,owner);await f.collector.run();
  const p=f.profiles.get(handle);assert.equal(p.fanInspectionTimeline.status,'ready');assert.deepEqual(p.fanInspectionTimeline.posts.map(p=>p.text),Array.from({length:10},(_,i)=>`Original ${14-i}`));
  assert.ok(p.posts.some(p=>p.text==='Original 99'));assert.equal(f.calls.length,1);assert.equal(Object.keys(f.values[FAN_PROFILE_STATE].pending).length,0);
  const evidence=reviewProfileEvidence(p,{accountId:owner,targetUserId:id,handle},1000000);assert.equal(evidence.posts.length,10);
});
test('cached empty and partial timelines remain distinct, with six-hour TTL',async()=>{
  for(const [posts,complete,status]of [[[],true,'empty'],[[],false,'partial'],[[post(1)],false,'partial'],[[post(1)],true,'ready']]){
    const f=fixture(async()=>({status:200,posts,complete}));await f.collector.observe(target,owner);await f.collector.run();assert.equal(f.profiles.get(handle).fanInspectionTimeline.status,status);
    await f.collector.observe(target,owner);assert.equal(Object.keys(f.values[FAN_PROFILE_STATE].pending).length,0);
    f.tick(FAN_TIMELINE_TTL+1);await f.collector.observe(target,owner);assert.equal(Object.keys(f.values[FAN_PROFILE_STATE].pending).length,1);
  }
});
test('timeline fragments remain available to manual review with explicit incomplete evidence',async()=>{
  const f=fixture(async()=>({status:200,posts:[post(1,{textComplete:false})],complete:true}));
  await f.collector.observe(target,owner);await f.collector.run();
  const evidence=reviewProfileEvidence(f.profiles.get(handle),{accountId:owner,targetUserId:id,handle},1000000);
  assert.equal(evidence.posts.length,1);assert.equal(evidence.posts[0].textComplete,false);assert.equal(evidence.information.posts,'partial');
});
test('request spacing and checkpoints survive creating a replacement worker',async()=>{
  const f=fixture();await f.collector.observe(target,owner);await f.collector.observe({...target,id:'43',handle:'second'},owner);
  await f.collector.run();assert.equal(f.calls.length,1);await createFanProfileCollector(f.options).run();assert.equal(f.calls.length,1);
  f.tick(FAN_PROFILE_SPACING);await createFanProfileCollector(f.options).run();assert.equal(f.calls.length,2);
});
test('429 respects server cooldown globally and does not clear archived posts',async()=>{
  const f=fixture(async()=>({status:429,error:'rate limited',retryAfterSeconds:1200}));f.profiles.set(handle,{id,handle,posts:[post(99)]});
  await f.collector.observe(target,owner);await f.collector.observe({...target,id:'43',handle:'second'},owner);await f.collector.run();
  assert.equal(f.profiles.get(handle).fanInspectionTimeline.status,'rate-limited');assert.equal(f.profiles.get(handle).posts.length,1);
  assert.ok(f.values[FAN_PROFILE_STATE].nextRequestAt>=1000000+1200000);f.tick(1199000);await f.collector.run();assert.equal(f.calls.length,1);
  await f.collector.observe(target,owner);assert.equal(f.profiles.get(handle).fanInspectionTimeline.status,'rate-limited');
});
test('network failures are bounded and never misreported as an empty timeline',async()=>{
  const f=fixture(async()=>{throw Error('offline')});await f.collector.observe(target,owner);
  for(let i=0;i<3;i++){await f.collector.run();f.tick(3600000)}
  assert.equal(f.calls.length,3);assert.equal(Object.keys(f.values[FAN_PROFILE_STATE].pending).length,0);assert.equal(f.profiles.get(handle).fanInspectionTimeline.status,'failed');
});
test('identity conflicts and owner switches cannot publish evidence for another account',async()=>{
  const f=fixture(async()=>{f.switch('999');return {status:200,posts:[post(1)],complete:true}});
  f.profiles.set(handle,{id:'999',handle,bio:'must keep'});await assert.rejects(f.collector.observe(target,owner),/用户 ID 冲突/);assert.equal(f.profiles.get(handle).bio,'must keep');
  f.profiles.delete(handle);await f.collector.observe(target,owner);await assert.rejects(f.collector.run(),/绑定账号已变化/);assert.equal(f.profiles.get(handle).fanInspectionTimeline.status,'pending');
  assert.equal(reviewProfileEvidence(f.profiles.get(handle),{accountId:'999',targetUserId:id,handle}).posts.length,0);
});
test('parallel alarm delivery shares one in-flight read and metadata rejects future-dated caches',async()=>{
  let release;const f=fixture(()=>new Promise(r=>release=r));await f.collector.observe(target,owner);const pending=f.collector.run();
  while(!release)await new Promise(r=>setImmediate(r));assert.deepEqual(await f.collector.run(),{busy:true});release({status:200,posts:[post(1)],complete:true});await pending;
  const p=f.profiles.get(handle);assert.equal(reviewProfileEvidence(p,{accountId:owner,targetUserId:'99',handle}).posts.length,0);
  assert.equal(reviewProfileEvidence(p,{accountId:owner,targetUserId:id,handle},1).posts.length,0);
  assert.equal(cachedReviewPosts([post(1,{kind:'repost'})],handle).length,0);
});
test('a cache committed before worker interruption satisfies the saved checkpoint without another read',async()=>{
  const f=fixture();await f.collector.observe(target,owner);
  const p=f.profiles.get(handle);p.fanInspectionTimeline={ownerAccountId:owner,targetUserId:id,fetchedAt:1000000,status:'ready',posts:[post(1)]};
  await createFanProfileCollector(f.options).run();assert.equal(f.calls.length,0);assert.equal(Object.keys(f.values[FAN_PROFILE_STATE].pending).length,0);
});
test('rate-limit resetAt uses the transport millisecond value and does not shorten the server window',async()=>{
  const f=fixture(async()=>({status:429,rateLimit:{resetAt:4000000}}));await f.collector.observe(target,owner);await f.collector.run();
  assert.equal(f.values[FAN_PROFILE_STATE].nextRequestAt,4000000);
});
test('conflicting and numeric cached identities are never adopted',async()=>{
  for(const old of [{id:'42',targetUserId:'99'},{id:42}]){const f=fixture();f.profiles.set(handle,{...old,handle,posts:[post(1)]});await assert.rejects(f.collector.observe(target,owner),/用户 ID 冲突/);assert.equal(f.profiles.get(handle).posts.length,1);}
});


test('retention discards pending profile work without touching another owner or target ID',async()=>{
 const f=fixture();await f.collector.observe(target,owner);await f.collector.observe({...target,id:'43',handle:'other'},owner);
 const result=await f.collector.discard({ownerId:owner,handle,targetIds:[id]});assert.equal(result.removed,1);
 assert.deepEqual(Object.values(f.values[FAN_PROFILE_STATE].pending).map(p=>p.handle),['other']);
});


test('retention preflight does not discard work and an active profile task defers cleanup',async()=>{
 const f=fixture();await f.collector.observe(target,owner);
 await f.collector.discard({ownerId:owner,handle,targetIds:[id],checkOnly:true});assert.equal(Object.keys(f.values[FAN_PROFILE_STATE].pending).length,1);
 f.values[FAN_PROFILE_STATE].active={accountId:owner,handle,targetUserId:id};f.values[FAN_PROFILE_STATE].activeUntil=2000000;
 assert.equal((await f.collector.discard({ownerId:owner,handle,targetIds:[id]})).deferred,true);assert.equal(Object.keys(f.values[FAN_PROFILE_STATE].pending).length,1);
});

test('shared access cooling preserves collection work without consuming attempts or publishing missing-data verdicts',async()=>{
 const retryAt=1000000+900000;const f=fixture(async()=>{throw Object.assign(Error('cooldown'),{code:'X_ACCESS_DEFERRED',retryAt})});
 await f.collector.observe(target,owner);const result=await f.collector.run();
 assert.equal(result.deferred,true);const item=Object.values(f.values[FAN_PROFILE_STATE].pending)[0];
 assert.equal(item.attempts||0,0);assert.equal(item.retryAt,retryAt);assert.equal(f.values[FAN_PROFILE_STATE].active,null);
 assert.equal(f.profiles.get(handle).fanInspectionTimeline.status,'pending');
 await f.collector.run();assert.equal(f.calls.length,1);
});
