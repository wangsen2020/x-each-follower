import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnavailableCleanup,FAN_CLEANUP_STATUS} from '../src/features/relationships/unavailable-cleanup.js';
function fixture(status='not_found',scope='account'){
 const values={followQueueBinding:{accountId:'1'},'xefProfileAccess:target':{status,checkedAt:10},xefUnavailableCleanup:{'1:target':'v2:10'}},calls=[];
 const jobs=[{id:'j',handle:'target',targetUserId:'42',accountId:'1',state:'excluded',sources:[{module:'fans'}]}];let exists=true,fail=false;
 const records={handle:async req=>{
  if(req.op==='fanCleanupCandidates')return {ok:true,candidates:scope==='fans'?[{handle:'target',scope,targetIds:['42']}]:[]};
  if(fail)throw Error('backup busy');calls.push(['records',req.handle]);
  if(!['not_found','suspended'].includes(values['xefProfileAccess:target'].status)&&scope==='account')return {ok:true,result:{skipped:true}};
  const deleted=exists?2:0;exists=false;return {ok:true,result:{deleted,scope,targetIds:['42']}};
 }};
 const storage={get:async k=>k===null?structuredClone(values):Object.fromEntries((Array.isArray(k)?k:[k]).filter(x=>x in values).map(x=>[x,structuredClone(values[x])])),set:async p=>Object.assign(values,structuredClone(p)),remove:async k=>delete values[k]};
 const c=createUnavailableCleanup({storage,queue:{list:async()=>structuredClone(jobs),markDeletedHandle:async()=>{throw Error('must not block a different ID')},deleteJob:async req=>{calls.push(['job',req.id,req.fanOnly]);jobs.splice(0);return {ok:true,deleted:1}},stripFanSource:async req=>{calls.push(['strip',req.id]);jobs[0].sources=[{module:'comments'}];return {ok:true}}},records,now:()=>100});
 return {values,calls,jobs,records,c,fail(value){fail=value}};
}
test('old done flags do not hide residual records, repeated scans report actual changes',async()=>{
 const f=fixture();const first=await f.c.run();const second=await f.c.run();
 assert.equal(first.summary.accounts,1);assert.equal(first.summary.records,2);assert.equal(second.summary.accounts,0);
 assert.equal(f.values.xefUnavailableCleanup,undefined);assert.equal(f.calls.filter(c=>c[0]==='job').length,1);
});
test('unknown and newer normal availability are rechecked before deletion',async()=>{
 for(const status of ['identity_unresolved','unknown','ok']){const f=fixture(status);await f.c.run();assert.equal(f.calls.length,0);}
 const f=fixture();const original=f.records.handle;f.records.handle=async req=>{if(req.op==='cleanupFanRecord')f.values['xefProfileAccess:target']={status:'ok',checkedAt:20};return original(req)};
 await f.c.run();assert.equal(f.jobs.length,1);
});
test('active work defers; failed backup retries instead of being marked complete',async()=>{
 const f=fixture();f.jobs[0].state='running';await f.c.run();assert.equal(f.calls.length,0);assert.equal(f.values[FAN_CLEANUP_STATUS].deferred,1);
 f.jobs[0].state='excluded';f.fail(true);await f.c.run();assert.equal(f.jobs.length,1);assert.equal(f.values[FAN_CLEANUP_STATUS].failed,1);
 f.fail(false);await f.c.run();assert.equal(f.jobs.length,0);
});
test('no-relationship cleanup detaches mixed jobs and deletes only fan-only jobs',async()=>{
 const mixed=fixture('ok','fans');mixed.jobs[0].sources.push({module:'comments'});await mixed.c.run();assert.deepEqual(mixed.jobs[0].sources,[{module:'comments'}]);assert.equal(mixed.values[FAN_CLEANUP_STATUS].detached,1);
 const fan=fixture('ok','fans');await fan.c.run();assert.ok(fan.calls.some(c=>c[0]==='job'&&c[2]===true));
});
test('account binding changes defer safely',async()=>{
 const f=fixture();const original=f.records.handle;f.records.handle=async req=>{const r=await original(req);if(req.op==='fanCleanupCandidates')f.values.followQueueBinding.accountId='2';return r};await f.c.run();assert.equal(f.jobs.length,1);assert.equal(f.values[FAN_CLEANUP_STATUS].stage,'paused');
});


test('unrelated non-fan queue tasks are not touched or counted as detached',async()=>{
 const f=fixture('ok','fans');f.jobs[0].sources=[{module:'comments'}];await f.c.run();assert.equal(f.jobs.length,1);assert.equal(f.values[FAN_CLEANUP_STATUS].detached,0);assert.ok(!f.calls.some(c=>c[0]==='job'||c[0]==='strip'));
});
