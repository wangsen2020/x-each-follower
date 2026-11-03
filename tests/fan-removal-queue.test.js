import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createFanRemovalQueue} from '../src/features/relationships/fan-removal-queue.js';

function fixture(t){
 let time=100000,owner='1',calls=[],released;
 const values={},rows=new Map(),alarms=[];
 const local={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])),set:async patch=>Object.assign(values,structuredClone(patch))};
 const records={lookupAll:async({handle,bucket})=>bucket==='users'&&rows.has(handle)?[structuredClone(rows.get(handle))]:[],
  batch:async({changes})=>{for(const change of changes)Object.assign(rows.get(change.handle).payload,structuredClone(change.patch));return {updated:changes.length};}};
 const dependencies={api:{storage:{local},alarms:{create:async(...args)=>alarms.push(args),get:async()=>null}},readBinding:async()=>({activated:true,accountId:owner}),records,
  now:()=>time,dependencies:{indexedDB:new IDBFactory(),IDBKeyRange},name:'queue-test',removeFollower:async job=>{calls.push(job.targetUserId);return {accountId:'1',targetUserId:job.targetUserId,attempted:true,removed:true,verifiedAt:time};}};
 const create=()=>{const runtime=createFanRemovalQueue(dependencies);t.after(()=>runtime.db.close());return runtime;};
 const input=id=>{const handle='fan'+id;rows.set(handle,{accountId:'1',handle,userKey:handle,sourcePath:['monitor','users',handle],payload:{id,handle,fanReview:{ownerAccountId:'1',targetUserId:id,state:'review',decision:'remove',reason:'已有不通过依据',decisionVersion:1}}});return {accountId:'1',targetUserId:id,handle};};
 return {dependencies,create,input,rows,calls,alarms,advance:()=>time+=61000,switchOwner:()=>owner='2'};
}

test('disabled rule cancels a queued legacy rejection and returns it to review without removing',async t=>{
 const f=fixture(t),queue=f.create();await queue.enqueue(f.input('10'));
 f.rows.get('fan10').payload.fanReview.reason='已有色情低俗或擦边内容依据';
 await queue.run();assert.equal(f.calls.length,0);assert.equal((await queue.status('1'))[0].state,'cancelled');
 assert.equal(f.rows.get('fan10').payload.fanReview.decision,'review');
});
test('explicit manual removal remains effective when automatic content filtering is off',async t=>{
 const f=fixture(t),queue=f.create();await queue.enqueue(f.input('10'));
 Object.assign(f.rows.get('fan10').payload.fanReview,{reason:'色情低俗',source:'manual-remove'});
 await queue.run();assert.equal(f.calls.length,1);assert.equal((await queue.status('1'))[0].state,'done');
});

test('enqueue persists without waiting for a busy consumer; FIFO deduplication survives runtime recreation',async t=>{
 const f=fixture(t),queue=f.create();await queue.enqueue(f.input('10'));await queue.enqueue(f.input('11'));await queue.enqueue({accountId:'1',targetUserId:'10',handle:'fan10'});
 assert.equal(f.calls.length,0);assert.equal((await queue.status('1')).length,2);assert.equal(f.alarms.length,2);
 const recreated=f.create();await recreated.run();assert.deepEqual(f.calls,['10']);assert.equal(f.rows.get('fan10').payload.fanReview.state,'removed');
 await recreated.run();assert.deepEqual(f.calls,['10','11']);assert.ok((await recreated.status('1')).every(j=>j.state==='done'));
});

test('new work is accepted while a removal is running and concurrent alarms cannot submit twice',async t=>{
 const f=fixture(t);let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 f.dependencies.removeFollower=async job=>{f.calls.push(job.targetUserId);started();await gate;return {accountId:'1',targetUserId:job.targetUserId,attempted:true,removed:true,verifiedAt:100000};};
 const queue=f.create();await queue.enqueue(f.input('10'));const first=queue.run();await ready;
 await queue.enqueue(f.input('11'));assert.equal((await queue.status('1')).length,2);const overlap=queue.run();release();await Promise.all([first,overlap]);assert.deepEqual(f.calls,['10']);
});

test('cooldown persists and resumes automatically after restart without human confirmation',async t=>{
 const f=fixture(t);let count=0;f.dependencies.removeFollower=async job=>{count++;return count===1?{accountId:'1',targetUserId:job.targetUserId,attempted:false,removed:false,deferred:true,retryAt:161000,reason:'冷却'}:{accountId:'1',targetUserId:job.targetUserId,attempted:true,removed:true,verifiedAt:161000};};
 const q=f.create();await q.enqueue(f.input('10'));await q.run();await f.create().run();assert.equal(count,1);assert.equal(f.rows.get('fan10').payload.fanReview.decision,'remove');
 f.advance();await f.create().run();assert.equal(count,2);assert.equal(f.rows.get('fan10').payload.fanReview.state,'removed');
});

test('later approval cancels queued removal and an owner switch cannot execute another account work',async t=>{
 const f=fixture(t),q=f.create();await q.enqueue(f.input('10'));f.rows.get('fan10').payload.fanReview={state:'approved',decision:'pass',source:'manual-approve'};await q.run();assert.equal(f.calls.length,0);
 await q.enqueue(f.input('11'));f.switchOwner();await q.run();assert.equal(f.calls.length,0);
});
