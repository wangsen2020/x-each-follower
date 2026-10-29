import test from 'node:test';
import assert from 'node:assert/strict';
import {createFanInspectionBatch} from '../src/features/relationships/fan-inspection-batch.js';

function setup(inspect,wait=async()=>{}) {
  const data={};const storage={get:async key=>({[key]:structuredClone(data[key])}),set:async values=>Object.assign(data,structuredClone(values))};
  const options={storage,binding:async()=>({accountId:'owner'}),targets:async()=>['a','b','a','c'],inspect,wait};
  return {data,options,batch:createFanInspectionBatch(options)};
}

test('batch snapshots unique targets, contains per-item errors and retains results across reopening',async()=>{
  const seen=[];const {batch,options}=setup(async handle=>{seen.push(handle);if(handle==='b')throw Error('资料不完整');return {ok:true,relationship:{following:false,followedBy:false}}});
  await batch.start('owner',{scope:'待回关'});await batch.settled();
  const state=await createFanInspectionBatch(options).status('owner');
  assert.deepEqual(seen,['a','b','c']);assert.equal(state.stage,'completed');assert.equal(state.nextIndex,3);
  assert.equal(state.results[1].status,'failed');assert.equal(state.results[2].status,'verified');
});

test('batch waits a random 2 to 5 seconds between reads, including after an item failure',async()=>{
  const delays=[];let index=0;
  const {options}=setup(async handle=>{if(handle==='b')throw Error('资料不完整');return {ok:true}},async ms=>delays.push(ms));
  const batch=createFanInspectionBatch({...options,random:()=>[0,0.999999][index++]});
  await batch.start('owner',{});await batch.settled();
  assert.deepEqual(delays,[2000,5000]);
});

test('rate limit pauses without advancing the unfinished item and explicit resume skips completed reads',async()=>{
  const seen=[];let limited=true;
  const {batch}=setup(async handle=>{seen.push(handle);if(handle==='b'&&limited){const e=Error('HTTP 429');e.status=429;throw e}return {ok:true}});
  await batch.start('owner',{});await batch.settled();
  assert.equal((await batch.status('owner')).nextIndex,1);assert.equal((await batch.status('owner')).stage,'paused');
  limited=false;await batch.resume('owner');await batch.settled();
  assert.deepEqual(seen,['a','b','b','c']);assert.equal((await batch.status('owner')).stage,'completed');
});

test('stop finishes the current read and a restarted worker offers explicit continuation',async()=>{
  let release,started;const began=new Promise(r=>started=r);const read=new Promise(r=>release=r);const seen=[];
  const {batch,options,data}=setup(async handle=>{seen.push(handle);if(handle==='a'){started();await read}return {ok:true}});
  const first=await batch.start('owner',{});await began;await batch.stop('owner');release();await batch.settled();
  assert.deepEqual(seen,['a']);assert.equal((await batch.status('owner')).nextIndex,1);
  const key=`fanInspection:owner:${first.id}`;data[key].stage='running';
  const restarted=createFanInspectionBatch(options);assert.equal((await restarted.status('owner')).stage,'paused');
  await restarted.resume('owner');await restarted.settled();assert.deepEqual(seen,['a','b','c']);
});

test('concurrent starts are rejected and previous batch histories remain saved',async()=>{
  let release;const {batch,data}=setup(async()=>new Promise(r=>release=()=>r({ok:true})));
  const first=await batch.start('owner',{});await assert.rejects(batch.start('owner',{}),/已有/);
  await batch.stop('owner');while(!release)await new Promise(r=>setTimeout(r,0));release();await batch.settled();
  const previousKey=`fanInspection:owner:${first.id}`;assert.ok(data[previousKey]);
});

test('context cancellation releases the batch immediately and ignores a late completed read',async()=>{
  let release,began;const entered=new Promise(r=>began=r);let signal;
  const seen=[];
  const {options,batch}=setup(async(handle,options)=>{seen.push(handle);signal=options.signal;began();return new Promise(r=>release=()=>r({ok:true}));});
  await batch.start('owner',{});await entered;
  const cancelled=await batch.cancel('owner');
  assert.equal(cancelled.stage,'cancelled');assert.equal(cancelled.nextIndex,0);assert.equal(signal.aborted,true);
  await assert.rejects(batch.resume('owner'),/重新选择/);
  release();await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(seen,['a']);assert.equal((await batch.status('owner')).results.length,0);
  const next=createFanInspectionBatch({...options,targets:async()=>['next'],inspect:async()=>({ok:true})});
  await next.start('owner',{});await next.settled();assert.deepEqual((await next.status('owner')).handles,['next']);
});

test('changing context during target preparation prevents the old batch from launching',async()=>{
  let release,entered;const began=new Promise(r=>entered=r);let reads=0;
  const {options}=setup(async()=>{reads++;return {ok:true}});
  const batch=createFanInspectionBatch({...options,targets:async()=>{entered();return new Promise(r=>release=r)}});
  const start=batch.start('owner',{});await began;
  const cancelled=batch.cancel('owner');release(['old-page']);
  await assert.rejects(start,/范围已切换/);await cancelled;
  assert.equal(reads,0);assert.equal(await batch.status('owner'),null);
});
