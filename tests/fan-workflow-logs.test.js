import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fanCheckpointLogEntries,fanScheduleLogEntry,createFanLogSink} from '../src/features/relationships/fan-workflow-logs.js';
import {createExecutionLogStore} from '../src/shared/execution-log-store.js';

test('review checkpoints audit changed results once and omit prompts/connection secrets',()=>{
 const old={id:'b',accountId:'1',automatic:true,stage:'running',results:[],items:[{handle:'a',bio:'private profile'}],roleSnapshot:{prompt:'secret'},connection:{token:'secret'}};
 const next={...old,stage:'completed',nextIndex:3,results:[{handle:'a',status:'pass',reason:'normal'},{handle:'b',status:'rejected',executionStatus:'removed'},{handle:'c',status:'uncertain',reason:'missing evidence'}]};
 const changes={'followQueueFanReviewBatch:1':{oldValue:old,newValue:next}};
 const entries=fanCheckpointLogEntries(changes);
 assert.deepEqual(entries.map(e=>e.result),['completed','pass','rejected','uncertain']);
 assert.ok(entries.every(e=>e.source==='scheduled'&&e.accountId==='1'));
 assert.doesNotMatch(JSON.stringify(entries),/secret|private profile/);
 assert.deepEqual(fanCheckpointLogEntries({'followQueueFanReviewBatch:1':{oldValue:next,newValue:{...next,checked:9}}}),[]);
 assert.deepEqual(fanCheckpointLogEntries({'followQueueFanReviewBatch:1':{oldValue:next}}),[]);
});
test('verification failures and identity mismatch are never emitted as verified',()=>{
 const entries=fanCheckpointLogEntries({'fanInspection:1:b':{newValue:{id:'b',accountId:'1',stage:'paused',handles:['a'],results:[{handle:'a',status:'failed',error:'429'}]}}});
 assert.equal(entries.at(-1).result,'failed');assert.equal(entries.at(-1).detail,'429');
});

test('paused AI checkpoint keeps transport reason instead of logging a live submission',()=>{
 const old={id:'b',accountId:'1',stage:'running',inFlightStage:'submitting'};
 const next={...old,stage:'paused',error:'EnsureSandBox timeout'};
 const entries=fanCheckpointLogEntries({'followQueueFanReviewBatch:1':{oldValue:old,newValue:next}});
 assert.equal(entries[0].result,'paused');assert.equal(entries[0].detail,'EnsureSandBox timeout');
});
test('unchanged idle schedules are quiet, changed wait reasons and next times remain visible',()=>{
 const prior={stage:'idle',lastAt:100000,nextAt:160000};
 assert.equal(fanScheduleLogEntry('1','review',prior,{...prior,lastAt:160000,nextAt:220000}),null);
 const next={stage:'waiting',error:'rate limited',lastAt:160000,nextAt:300000};
 const entry=fanScheduleLogEntry('1','verify',prior,next);
 assert.equal(entry.detail,'rate limited');assert.equal(entry.nextAt,300000);assert.equal(entry.kind,'verify');
});
test('log persistence failure does not change business execution outcome',async t=>{
 t.mock.method(console,'warn',()=>{});const sink=createFanLogSink(async()=>{throw Error('disk unavailable');});
 await assert.doesNotReject(sink({scope:'fanVerify'}));
 const slow=createFanLogSink(()=>new Promise(()=>{}));
 await slow({scope:'fanVerify'}); // A pending backup must not hold the caller.
});
test('three indexed categories page and clear independently, including repeated checkpoint IDs',async()=>{
 const saved=new Map(),store=createExecutionLogStore({dbName:'fan-log-test',storage:{get:async()=>({})},durableGet:async k=>saved.get(k),durableSet:async(k,v)=>saved.set(k,v)});
 for(const scope of ['fanReview','fanVerify','fanSchedule'])for(let n=0;n<4;n++)await store.append({id:`${scope}-${n}`,scope,at:new Date(100000+n).toISOString(),result:'completed'});
 await store.append({id:'fanReview-3',scope:'fanReview',at:new Date(100003).toISOString(),result:'completed'});
 const first=await store.query({scope:'fanReview',limit:2});assert.equal(first.total,4);assert.equal(first.entries.length,2);
 assert.equal((await store.query({scope:'fanReview',limit:2,cursor:first.nextCursor})).entries.length,2);
 await store.clear('fanReview');assert.equal((await store.query({scope:'fanReview'})).total,0);
 for(const scope of ['fanVerify','fanSchedule'])assert.equal((await store.query({scope})).total,4);
 assert.equal((await store.query({scope:'fans'})).total,0);
});

test('verification logs report the persisted review destination',()=>{
 const entries=fanCheckpointLogEntries({'fanInspection:1:b':{newValue:{id:'b',accountId:'1',stage:'completed',handles:['a'],results:[{handle:'a',status:'verified',reviewTransition:{state:'review',ready:true,reason:'资料已就绪'}}]}}});
 const item=entries.find(e=>e.handle==='a');assert.equal(item.result,'returned');assert.equal(item.detail,'资料已就绪');
});
