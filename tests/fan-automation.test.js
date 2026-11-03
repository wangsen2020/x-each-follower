import test from 'node:test';import assert from 'node:assert/strict';
import {createFanAutomation,FAN_AUTOMATION_PREFIX} from '../src/features/relationships/fan-automation.js';
import {normalizeFanAutomation,validateFanAutomation} from '../src/features/relationships/fan-automation-settings.js';
import {normalizeReviewSettings,mergeReviewSettingsPatch} from '../src/features/relationships/follow-review-engine.js';
import {removalHistoryRows} from '../src/features/relationships/fan-removal-history.js';
function fixture(){let time=100000,owner={activated:true,accountId:'1'},batch=null,manual=false;
 const data={},config=normalizeReviewSettings({fanTagging:{provider:'codex',botId:'fan'}}),calls=[],items={review:[],verify:[]};
 const storage={get:async key=>({[key]:structuredClone(data[key])}),set:async value=>Object.assign(data,structuredClone(value))};
 const reviewBatch={status:async()=>batch,start:async(id,request)=>{calls.push(['review',request]);return batch={id:'b',stage:'running',automatic:true};},resume:async()=>{calls.push(['resume']);batch.stage='running';}};
 const api=createFanAutomation({storage,alarms:{get:async()=>null,create:async(...args)=>calls.push(['alarm',...args])},binding:async()=>owner,settings:async()=>config,
 list:async(id,kind)=>items[kind],reviewBatch,verify:async(id,item)=>{calls.push(['verify',item]);return {ready:true};},manualVerificationBusy:async()=>manual,now:()=>time});
 return {api,config,calls,items,data,setBatch:value=>batch=value,setOwner:value=>owner=value,setManual:value=>manual=value,advance:ms=>time+=ms};
}
test('two independent defaults and partial save preserve explicit disabled settings',()=>{
 assert.equal(normalizeFanAutomation().review.enabled,true);assert.equal(normalizeFanAutomation().verify.enabled,true);
 const base=normalizeReviewSettings({automation:{review:{enabled:false,limit:7},verify:{limit:3}}});
 const merged=mergeReviewSettingsPatch(base,{automation:{verify:{intervalMinutes:4}}});
 assert.equal(merged.automation.review.enabled,false);assert.equal(merged.automation.review.limit,7);assert.equal(merged.automation.verify.limit,3);
 for(const input of [{review:{intervalMinutes:0}},{verify:{retryMinutes:4}},{review:{limit:51}},{verify:{enabled:'false'}}])assert.throws(()=>validateFanAutomation(input));
});
test('review freezes bounded identities, serializes overlapping alarm events and respects interval',async()=>{
 const f=fixture();f.items.review=Array.from({length:30},(_,i)=>({handle:'fan'+i,targetUserId:String(i+100)}));
 await Promise.all([f.api.run(),f.api.run()]);assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].handles.length,20);assert.equal(f.calls[0][1].automatic,true);
 f.setBatch({stage:'completed'});await f.api.run();assert.equal(f.calls.length,1);
 f.config.automation.review.enabled=false;f.advance(60000);await f.api.run();assert.equal(f.calls.length,1);assert.equal(f.data[FAN_AUTOMATION_PREFIX+'1'].review.stage,'disabled');
});
test('manual pause is not resumed by automation; automatic pending job is resumed without new submission',async()=>{
 const f=fixture();f.setBatch({id:'manual',stage:'paused',automatic:false});await f.api.run();assert.equal(f.calls.length,0);
 f.setBatch({id:'auto',stage:'paused',automatic:true});f.advance(60000);await f.api.run();assert.equal(f.calls[0][0],'resume');
 f.setBatch({id:'auto',stage:'paused',automatic:true,userPaused:true});f.advance(120000);await f.api.run();assert.equal(f.calls.length,1);
});
test('verification cooldown persists, new worker does not immediately repeat the same profile',async()=>{
 const f=fixture();f.items.verify=[{handle:'a',targetUserId:'10'}];await f.api.run();assert.equal(f.calls.filter(c=>c[0]==='verify').length,1);
 f.advance(120000);await f.api.run();assert.equal(f.calls.filter(c=>c[0]==='verify').length,1);
 assert.ok(f.data[FAN_AUTOMATION_PREFIX+'1'].verify.attempts['10']>0);
 f.config.automation.verify.enabled=false;f.advance(3600000);await f.api.run();assert.equal(f.calls.filter(c=>c[0]==='verify').length,1);
});

test('missing-ID verification uses independent handle cooldowns',async()=>{
 const f=fixture();f.items.verify=[{handle:'first',targetUserId:''},{handle:'second',targetUserId:''}];
 await f.api.run();assert.equal(f.calls.filter(c=>c[0]==='verify').length,2);
 const attempts=f.data[FAN_AUTOMATION_PREFIX+'1'].verify.attempts;
 assert.ok(attempts['handle:first']);assert.ok(attempts['handle:second']);assert.equal(attempts[''],undefined);
 f.advance(120000);await f.api.run();assert.equal(f.calls.filter(c=>c[0]==='verify').length,2);
});
test('manual verification and missing AI connection stay quiet and do not dispatch',async()=>{
 const f=fixture();f.config.fanTagging.botId='';f.items.review=[{handle:'a',targetUserId:'10'}];f.items.verify=f.items.review;f.setManual(true);
 await f.api.run();assert.deepEqual(f.calls,[]);assert.equal(f.data[FAN_AUTOMATION_PREFIX+'1'].review.stage,'configuration');assert.equal(f.data[FAN_AUTOMATION_PREFIX+'1'].verify.stage,'manual');
});
test('account departure during candidate read prevents launch',async()=>{
 let reads=0,started=0;const config=normalizeReviewSettings({fanTagging:{provider:'codex',botId:'fan'}});
 const api=createFanAutomation({storage:{get:async()=>({}),set:async()=>{}},binding:async()=>++reads>2?{activated:true,accountId:'2'}:{activated:true,accountId:'1'},settings:async()=>config,
 list:async()=>[{handle:'a',targetUserId:'10'}],reviewBatch:{status:async()=>null,start:async()=>started++},verify:async()=>assert.fail()});
 await api.run();assert.equal(started,0);
});
test('removed history accepts only confirmed owned receipts and deduplicates stable IDs',()=>{
 const valid={accountId:'1',targetUserId:'10',handle:'fan',removed:true,verifiedAt:1000};
 const rows=removalHistoryRows([valid,{...valid,verifiedAt:2000},{...valid,targetUserId:'11',removed:false},{...valid,targetUserId:'12',accountId:'2'},{...valid,targetUserId:'13',verifiedAt:null}], '1');
 assert.equal(rows.length,1);assert.equal(rows[0].payload.followerRemovedAt,2000);assert.equal(rows[0].payload.historyOnly,true);assert.equal(rows[0].payload.bio,undefined);
});

test('a failed automatic batch with retained AI or action receipts resumes its checkpoint instead of starting over',async()=>{
 const f=fixture();f.setBatch({id:'retained',stage:'failed',automatic:true,pendingRecovery:true});
 await f.api.run();assert.deepEqual(f.calls,[['resume']]);
});

test('rejected followers belong to the independent removal queue and never occupy an AI batch',async()=>{
 const f=fixture();f.config.fanTagging.botId='';f.items.review=[{handle:'review',targetUserId:'20'},{handle:'first',targetUserId:'10',removalPending:true},{handle:'later',targetUserId:'11',removalPending:true,retryAt:200000}];
 await f.api.run();assert.equal(f.calls.length,0);assert.equal(f.data[FAN_AUTOMATION_PREFIX+'1'].review.stage,'configuration');
});

test('completed recovery clears old failure backoff and returns to the configured cadence',async()=>{
 const f=fixture();f.config.automation.review.intervalMinutes=4;f.data[FAN_AUTOMATION_PREFIX+'1']={review:{stage:'running',batchId:'old',lastAt:100000,nextAt:1900000,failures:10,error:'old'}};
 f.setBatch({id:'old',stage:'completed',completed:20,total:20});await f.api.run();
 const progress=f.data[FAN_AUTOMATION_PREFIX+'1'].review;assert.equal(progress.stage,'completed');assert.equal(progress.failures,0);assert.equal(progress.error,'');assert.equal(progress.nextAt,340000);assert.deepEqual(f.calls,[]);
 f.advance(240000);f.items.review=[{handle:'next',targetUserId:'99'}];await f.api.run();assert.equal(f.calls[0][0],'review');
});

test('paused unknown AI receipt is shown as waiting before its due time and later resumes the same batch',async()=>{
 const f=fixture();const key=FAN_AUTOMATION_PREFIX+'1';
 f.data[key]={review:{stage:'running',batchId:'old',nextAt:340000,lastAt:100000}};
 f.setBatch({id:'old',stage:'paused',automatic:true,pendingRecovery:true,total:2,completed:0,error:'EnsureSandBox timeout'});
 await f.api.run();assert.equal(f.data[key].review.stage,'waiting');assert.equal(f.data[key].review.total,2);
 assert.equal(f.data[key].review.error,'EnsureSandBox timeout');assert.equal(f.calls.length,0);
 f.advance(240000);await f.api.run();assert.deepEqual(f.calls,[['resume']]);assert.equal(f.data[key].review.batchId,'old');
});

test('confirmed removal logs the terminal result and clears verification retry scheduling',async()=>{
 const data={},logs=[];let targets=[{handle:'empty',targetUserId:'10'}];
 const api=createFanAutomation({storage:{get:async key=>({[key]:data[key]}),set:async patch=>Object.assign(data,structuredClone(patch))},
  binding:async()=>({activated:true,accountId:'1'}),settings:async()=>normalizeReviewSettings({}),list:async()=>targets,
  verify:async()=>{targets=[];return {removed:true,reason:'补采已结束，仍无可审核资料'};},onLog:entry=>logs.push(entry)});
 await api.run({force:true,only:'verify'});await api.run({force:true,only:'verify'});
 const terminal=logs.filter(row=>row.scope==='fanVerify'&&row.result!=='running');
 assert.equal(terminal.length,1);assert.equal(terminal[0].result,'removed');assert.equal(terminal[0].nextAt,0);
 assert.deepEqual(data[FAN_AUTOMATION_PREFIX+'1'].verify.attempts,{});
});
