import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnavailableCleanup} from '../src/features/relationships/unavailable-cleanup.js';
import {followerEmptyView} from '../src/entries/panel/follower-empty-view.js';
function fixture(status='not_found'){
 const values={followQueueBinding:{accountId:'1'},'xefProfileAccess:target':{status,checkedAt:10}},calls=[];
 const jobs=[{id:'j',handle:'target',accountId:'1',state:'excluded'}];
 const records={handle:async req=>{calls.push(['records',req.handle]);return {ok:true,result:{deleted:2}}}};
 const c=createUnavailableCleanup({storage:{get:async k=>k?{[k]:values[k]}:{...values},set:async p=>Object.assign(values,p)},queue:{markDeletedHandle:async()=>({ok:true}),list:async()=>jobs,deleteJob:async req=>{calls.push(['job',req.id]);jobs.splice(0);return {ok:true,deleted:1}}},records,now:()=>100});
 return {values,calls,jobs,records,c};
}
test('confirmed evidence removes records and queue once with restart-safe progress',async()=>{
 const f=fixture();await f.c.run();await f.c.run();assert.deepEqual(f.calls,[['records','target'],['job','j']]);assert.equal(f.values.xefUnavailableCleanup['1:target'],'v2:10');
});
test('unknown, identity hold and newer normal states are never cleaned',async()=>{
 for(const status of ['identity_unresolved','unknown','ok']){const f=fixture(status);await f.c.run();assert.equal(f.calls.length,0);}
 const f=fixture();f.records.handle=async()=>({ok:true,result:{skipped:true}});await f.c.run();assert.equal(f.jobs.length,1);assert.equal(f.values.xefUnavailableCleanup,undefined);
});
test('active jobs defer cleanup and failed persistence is retried',async()=>{
 const f=fixture();f.jobs[0].state='running';await f.c.run();assert.equal(f.calls.length,0);
 f.jobs[0].state='excluded';const original=f.records.handle;f.records.handle=async()=>{throw Error('backup busy')};await f.c.run();assert.equal(f.jobs.length,1);assert.equal(f.values.xefUnavailableCleanup,undefined);
 f.records.handle=original;await f.c.run();assert.equal(f.jobs.length,0);
});
test('source changes during validation prevent queue deletion',async()=>{
 const f=fixture();f.records.handle=async()=>{f.values['xefProfileAccess:target']={status:'identity_unresolved',checkedAt:20};return {ok:true,result:{deleted:0}}};await f.c.run();assert.equal(f.jobs.length,1);
});
test('search with zero matches keeps result surface and distinguishes unfinished scan',()=>{
 assert.deepEqual(followerEmptyView({keyword:'situ',count:0,hasMore:true}),{showEmpty:false,showList:true,message:'当前扫描范围暂无匹配，可点击下一页继续查找。'});
 assert.equal(followerEmptyView({keyword:'situ',count:0,hasMore:false}).message,'没有匹配的账号。');
 assert.equal(followerEmptyView({keyword:'',count:0}).showEmpty,true);
});
