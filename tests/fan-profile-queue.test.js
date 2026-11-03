import test from 'node:test';
import assert from 'node:assert/strict';
import {createFanProfileCollector,FAN_PROFILE_STATE,FAN_PROFILE_HISTORY_LIMIT} from '../src/features/relationships/fan-profile-collector.js';
import {readFanProfileQueue,createFanProfileCacheReader} from '../src/features/relationships/fan-profile-queue-view.js';

function fixture(read=async()=>({status:200,posts:[],complete:true})){
  const values={},profiles=new Map();let at=1000000,owner={activated:true,accountId:'1',handle:'viewer'},alarm=null,writes=0,reads=0;
  const deps={storage:{get:async key=>({[key]:structuredClone(values[key])}),set:async patch=>{writes++;Object.assign(values,structuredClone(patch));}},
    alarms:{get:async()=>alarm,create:async(name,config)=>{alarm={name,scheduledTime:config.when};},clear:async()=>{alarm=null;}},binding:async()=>owner,now:()=>at,
    readProfile:async item=>profiles.get(item.handle)||{},updateProfile:async(item,update)=>profiles.set(item.handle,{...profiles.get(item.handle),...await update(profiles.get(item.handle)||{})}),
    readTimeline:async item=>{reads++;return read(item);}};
  return {values,profiles,deps,collector:createFanProfileCollector(deps),view:request=>readFanProfileQueue(deps,request),tick:ms=>at+=ms,switch:next=>owner=next,counts:()=>({writes,reads})};
}
const target=i=>({id:String(100+i),handle:'person_'+i,bio:'Profile'});
test('view is read-only, paginated, owner-isolated, and handles legacy pending checkpoints',async()=>{
  const f=fixture();f.values[FAN_PROFILE_STATE]={pending:Object.fromEntries(Array.from({length:65},(_,i)=>[i,{accountId:i===64?'2':'1',targetUserId:String(i),handle:'legacy_'+i,token:String(i),retryAt:1000000}]))};
  const before=structuredClone(f.values),counts=f.counts(),result=await f.view({page:2});
  assert.equal(result.summary.pending,64);assert.equal(result.total,64);assert.equal(result.items.length,30);assert.equal(result.pages,3);assert.equal(result.page,2);
  assert.equal(result.summary.scheduled,false);assert.ok(result.items.every(i=>i.status==='pending'));assert.ok(result.items.every(i=>!Object.hasOwn(i,'token')));
  assert.deepEqual(f.values,before);assert.deepEqual(f.counts(),counts);
  assert.equal((await f.view({page:999})).page,3);
  f.switch({activated:false});assert.equal((await f.view()).requiresActivation,true);
});
test('in-flight account survives collector recreation and completion remains visible',async()=>{
  let release;const f=fixture(()=>new Promise(resolve=>release=resolve));await f.collector.observe(target(0),'1');
  const run=f.collector.run();while(!release)await new Promise(resolve=>setImmediate(resolve));
  const view=await f.view();assert.equal(view.summary.running,'person_0');assert.equal(view.items[0].status,'running');assert.equal(view.items[0].attempts,1);
  assert.deepEqual(await createFanProfileCollector(f.deps).run(),{deferred:true});assert.equal(f.counts().reads,1);
  release({status:200,posts:[],complete:true});await run;
  const finished=await f.view();assert.equal(finished.summary.pending,0);assert.equal(finished.summary.finished,1);assert.equal(finished.summary.succeeded,1);
  assert.equal(finished.items[0].status,'empty');assert.equal(finished.items[0].finished,true);
  assert.equal((await f.view({filter:'pending'})).total,0);assert.equal((await f.view({filter:'finished'})).total,1);
});
test('retry and limit states expose their real deadlines; exhausted tasks remain inspectable',async()=>{
  const f=fixture(async()=>({status:429,error:'Rate limit',retryAfterSeconds:1200}));await f.collector.observe(target(1),'1');await f.collector.run();
  const retry=await f.view();assert.equal(retry.items[0].status,'rate-limited');assert.equal(retry.items[0].attempts,1);assert.equal(retry.items[0].retryAt,2200000);assert.equal(retry.summary.nextRunAt,2200000);
  for(let i=0;i<2;i++){f.tick(1200000);await f.collector.run();}
  const ended=await f.view({filter:'failed'});assert.equal(ended.summary.pending,0);assert.equal(ended.summary.failed,1);assert.equal(ended.items[0].attempts,3);assert.equal(ended.items[0].reason,'Rate limit');
});
test('terminal responses and bounded recent history persist through restarts without exposing another account',async()=>{
  const f=fixture(async()=>({status:403,error:'Protected account'}));
  f.values[FAN_PROFILE_STATE]={pending:{},history:[{accountId:'2',handle:'private_other',finishedAt:1},...Array.from({length:200},(_,i)=>({accountId:'1',handle:'old_'+i,status:'ready',finishedAt:200-i}))]};
  await f.collector.observe(target(2),'1');await f.collector.run();
  assert.equal(f.values[FAN_PROFILE_STATE].history.filter(i=>i.accountId==='1').length,FAN_PROFILE_HISTORY_LIMIT);
  const result=await readFanProfileQueue(f.deps,{filter:'failed'});assert.equal(result.items[0].status,'unavailable');assert.equal(result.summary.failed,1);assert.equal(result.total,1);
  assert.ok(!JSON.stringify(result).includes('private_other'));assert.ok(f.values[FAN_PROFILE_STATE].history.some(i=>i.accountId==='2'));
});
test('binding changes during status reads cannot return the old owner data',async()=>{
  const f=fixture();await f.collector.observe(target(3),'1');let checks=0;
  await assert.rejects(readFanProfileQueue({...f.deps,binding:async()=>({activated:true,accountId:++checks===1?'1':'2'})}),/绑定账号已变化/);
});
test('recovery after profile commit keeps a visible finished result without reading X again',async()=>{
  const f=fixture();await f.collector.observe(target(4),'1');
  f.profiles.get('person_4').fanInspectionTimeline={ownerAccountId:'1',targetUserId:'104',status:'ready',count:10,fetchedAt:1000000,posts:[]};
  await createFanProfileCollector(f.deps).run();const result=await f.view();
  assert.equal(result.summary.pending,0);assert.equal(result.summary.finished,1);assert.equal(result.items[0].count,10);assert.equal(f.counts().reads,0);
});
test('existing saved timelines remain visible when an older collector has emptied its queue without history',async()=>{
  const f=fixture();
  const profile=(id,handle,owner='1',extra={})=>({payload:{id,handle,fanInspectionTimeline:{ownerAccountId:owner,targetUserId:id,status:'partial',count:10,checkedAt:900000,...extra}}});
  const rows=[profile('42','saved_user'),profile('43','other_owner','2'),profile('44','identity_conflict','1',{targetUserId:'99'}),profile('45','future','1',{checkedAt:999999999})];
  let scans=0;
  const reader=createFanProfileCacheReader({records:{sourcePage:async request=>{scans++;assert.equal(request.sourceKey,'profileCache');return {records:request.cursor?rows.slice(2):rows.slice(0,2),nextCursor:request.cursor?null:'next'};}},storage:f.deps.storage,now:f.deps.now});
  const deps={...f.deps,readCachedResults:reader};const first=await readFanProfileQueue(deps);
  assert.equal(first.summary.pending,0);assert.equal(first.summary.succeeded,1);assert.equal(first.total,1);
  assert.equal(first.items[0].source,'profile-cache');assert.equal(first.items[0].attempts,null);assert.equal(first.items[0].count,10);assert.equal(first.items[0].finishedAt,900000);
  assert.equal(first.items[0].handle,'saved_user');assert.deepEqual(f.counts(),{writes:0,reads:0});
  await readFanProfileQueue(deps);assert.equal(scans,2);
  await readFanProfileQueue(deps,{refreshCache:true});assert.equal(scans,4);
  f.tick(30001);await readFanProfileQueue(deps);assert.equal(scans,6);
});
test('current queue and recorded results take precedence over old profile snapshots without duplicate counts',async()=>{
  const f=fixture();await f.collector.observe({id:'42',handle:'person'},'1');
  const deps={...f.deps,readCachedResults:async()=>[{targetUserId:'42',handle:'person',status:'ready',count:10,finishedAt:900000,source:'profile-cache'}]};
  assert.equal((await readFanProfileQueue(deps)).total,1);assert.equal((await readFanProfileQueue(deps)).items[0].status,'pending');
  await f.collector.run();const done=await readFanProfileQueue(deps);assert.equal(done.total,1);assert.equal(done.items[0].source,'queue');assert.equal(done.items[0].status,'empty');
});
test('cache reader retains the latest 200 verified account records, deduplicates stable IDs and shares concurrent scans',async()=>{
  let scans=0,release;const storage={get:async()=>({})};
  const rows=Array.from({length:205},(_,i)=>({payload:{id:String(i),handle:'user_'+i,fanInspectionTimeline:{ownerAccountId:'1',targetUserId:String(i),status:'ready',fetchedAt:1000+i,count:10}}}));
  rows.push({payload:{...rows[204].payload,fanInspectionTimeline:{...rows[204].payload.fanInspectionTimeline,fetchedAt:1500}}});
  const reader=createFanProfileCacheReader({records:{sourcePage:async()=>{scans++;await new Promise(r=>release=r);return {records:rows};}},storage,now:()=>2000});
  const first=reader('1'),second=reader('1');release();const [a,b]=await Promise.all([first,second]);
  assert.equal(scans,1);assert.deepEqual(a,b);assert.equal(a.length,200);assert.equal(a[0].targetUserId,'204');assert.equal(a[0].finishedAt,1500);assert.equal(a.filter(i=>i.targetUserId==='204').length,1);
});

test('slow archive paging returns discovered results within a budget and continues one shared read-only scan',async()=>{
  let release,calls=0;
  const row=id=>({payload:{id,handle:'user_'+id,fanInspectionTimeline:{ownerAccountId:'1',targetUserId:id,status:'ready',checkedAt:100,count:10}}});
  const reader=createFanProfileCacheReader({records:{sourcePage:async({cursor})=>{
    calls++;if(cursor)await new Promise(r=>release=r);
    return {records:[row(cursor?'2':'1')],nextCursor:cursor?null:'next'};
  }},storage:{},now:()=>200});
  const first=await reader('1',{maxWaitMs:0});assert.deepEqual(first.map(i=>i.handle),['user_1']);assert.equal(reader.loading('1'),true);
  const view=await readFanProfileQueue({storage:{get:async()=>({})},binding:async()=>({activated:true,accountId:'1'}),readCachedResults:reader,now:()=>200});
  assert.equal(view.total,1);assert.equal(view.summary.loadingCache,true);assert.equal(calls,2);
  release();const complete=await reader('1');assert.equal(complete.length,2);assert.equal(reader.loading('1'),false);
});

test('a background scan failure after a budget response remains observable and can be explicitly retried',async()=>{
  let reject;let failing=true;
  const reader=createFanProfileCacheReader({records:{sourcePage:async()=>failing?new Promise((_,no)=>reject=no):{records:[]}},storage:{},now:()=>200});
  assert.deepEqual(await reader('1',{maxWaitMs:0}),[]);reject(Error('archive unavailable'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reader.loading('1'),false);
  await assert.rejects(reader('1'),/archive unavailable/);failing=false;
  assert.deepEqual(await reader('1',{refresh:true}),[]);
});
