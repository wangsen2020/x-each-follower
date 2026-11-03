import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
globalThis.IDBKeyRange=IDBKeyRange;
async function fixture(){
  const store=createFollowQueueStore({indexedDB,dbName:'screening-cas-'+crypto.randomUUID()});
  const fanGrant={ownerAccountId:'100',targetUserId:'200',handle:'person',decisionVersion:1,grantedAt:1,source:'manual-approve'};
  const job=await store.enqueue({accountId:'100',targetUserId:'200',handle:'person',sources:[{module:'fans',enabled:true}],fanGrant});
  await store.resolveJob({accountId:'100',id:job.id,followResult:{reason:'prior audit',verifiedAt:123}});
  const screening={batchId:'batch-one',targetUserId:'200',phase:'submitted',inputDigest:'input-one'};
  const patch=(extra={})=>store.patchQueueScreening({accountId:'100',id:job.id,targetUserId:'200',handle:'person',screening,expectedFanGrant:fanGrant,...extra});
  return {store,job,fanGrant,screening,patch};
}
test('atomic screening writes preserve independent action metadata and accept callbacks only for that batch',async()=>{
  const f=await fixture();assert.equal((await f.patch()).ok,true);
  assert.equal((await f.patch({screening:{...f.screening,phase:'complete',decision:'pass'}})).ok,true);
  const saved=await f.store.get(f.job.id);assert.equal(saved.followResult.reason,'prior audit');assert.equal(saved.followResult.verifiedAt,123);
  assert.equal(saved.followResult.queueScreening.decision,'pass');assert.deepEqual(saved.fanGrant,f.fanGrant);
});
for(const extra of [{accountId:'other'},{handle:'recycled'}])test('screening write is fenced by owner, stable ID and handle '+JSON.stringify(extra),async()=>{
  const f=await fixture();assert.equal((await f.patch(extra)).ok,false);assert.equal((await f.store.get(f.job.id)).followResult.queueScreening,undefined);
});
test('mismatched screening payload identities are rejected before any write',async()=>{
  const f=await fixture();await assert.rejects(f.patch({targetUserId:'999'}),/stable target/);assert.equal((await f.store.get(f.job.id)).followResult.queueScreening,undefined);
  assert.equal((await f.patch({targetUserId:'999',screening:{...f.screening,targetUserId:'999'}})).reason,'identity-changed');
});
for(const state of ['followed','skipped','excluded','uncertain'])test('screening cannot revive or overwrite a held/terminal job '+state,async()=>{
  const f=await fixture();await f.store.resolveJob({accountId:'100',id:f.job.id,state,followResult:{reason:'human decision',...(state==='followed'?{succeeded:true}:{})}});
  assert.equal((await f.patch()).ok,false);const saved=await f.store.get(f.job.id);assert.equal(saved.state,state);assert.equal(saved.followResult.reason,'human decision');
});
for(const receipt of [{attemptedAt:123},{followerRemoval:{attemptedAt:456,removed:false}}])test('unknown action receipts cannot be overwritten by late AI metadata '+JSON.stringify(receipt),async()=>{
  const f=await fixture();await f.store.resolveJob({accountId:'100',id:f.job.id,followResult:receipt});
  assert.equal((await f.patch()).ok,false);assert.deepEqual((await f.store.get(f.job.id)).followResult,receipt);
});
test('a new manual grant version fences out the previous batch snapshot',async()=>{
  const f=await fixture();const grant={...f.fanGrant,decisionVersion:2,grantedAt:2};
  await f.store.resolveJob({accountId:'100',id:f.job.id,fanGrant:grant});assert.equal((await f.patch()).reason,'grant-changed');assert.deepEqual((await f.store.get(f.job.id)).fanGrant,grant);
});
test('a late old-batch callback cannot replace a newer batch after compare-and-set',async()=>{
  const f=await fixture();await f.patch({screening:{...f.screening,phase:'complete'}});
  const next={...f.screening,batchId:'batch-two',phase:'submitted'};
  assert.equal((await f.patch({screening:next,expectedScreeningBatchId:'batch-one'})).ok,true);
  assert.equal((await f.patch({screening:{...f.screening,phase:'complete'}})).ok,false);
  assert.equal((await f.store.get(f.job.id)).followResult.queueScreening.batchId,'batch-two');
});
