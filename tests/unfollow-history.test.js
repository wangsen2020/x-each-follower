import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {unfollowLogReceipts,mergeUnfollowHistory,unfollowHistoryRows} from '../src/features/relationships/unfollow-history.js';
const source=readFileSync(new URL('../src/entries/panel/panel.js',import.meta.url),'utf8');
function functionSource(name){const start=source.indexOf(`function ${name}(`);const end=source.indexOf('\nfunction ',start+1);return source.slice(start,end);}
const users=[{handle:'past',status:'unfollowed',unfollowedAt:'2026-10-25T10:00:00Z'},{handle:'old',status:'unfollowed',followedAt:'2026-09-01'},{handle:'active',status:'pending'}];
function context(tab,deadline='all',search='') {return {activeUnreciprocatedTab:tab,unreciprocatedOverdueFilter:deadline,unreciprocatedAvailabilityFilter:'all',unreciprocatedSearch:search,unreciprocatedPageSize:50,unreciprocatedTracker:{users},capPageSize:x=>x,matchesAccountAvailability:()=>true,sortFollowbackUsers:x=>x};}
test('history query ignores stale deadline filters, preserves search and paging',()=>{
 for(const deadline of ['unknown','within','overdue']) {
  const result=vm.runInNewContext(`${functionSource('currentRecordFilter')};currentRecordFilter('unreciprocated')`,context('unfollowed',deadline,'past'));
  assert.equal(result.tab,'unfollowed');assert.equal(result.search,'past');assert.equal(result.pageSize,50);
  assert.equal(result.dateKnown,undefined);assert.equal(result.dateUnknown,undefined);assert.equal(result.statuses,undefined);
 }
});
test('local comparison view keeps historical rows separate and searchable',()=>{
 const run=(tab,search='')=>vm.runInNewContext(`${functionSource('getFilteredUnreciprocatedUsers')};getFilteredUnreciprocatedUsers()`,context(tab,'unknown',search));
 assert.deepEqual(Array.from(run('unfollowed'),x=>x.handle),['past','old']);
 assert.deepEqual(Array.from(run('unfollowed','past'),x=>x.handle),['past']);
 assert.deepEqual(Array.from(run('all'),x=>x.handle),['active']);
});
const log={id:'receipt',result:'success',at:'2026-11-01T00:00:00Z',unfollowedHandles:['Person','person'],details:{'绑定账号':'owner'}};
test('only explicit successful unfollow lists restore history, not generic success or failed actions',()=>{
 const owner={accountId:'1',handle:'owner'};
 assert.equal(unfollowLogReceipts(log,owner).length,1);
 assert.deepEqual(unfollowLogReceipts({...log,result:'failed'},owner),[]);
 assert.deepEqual(unfollowLogReceipts({...log,unfollowedHandles:undefined,handle:'person'},owner),[]);
 assert.equal(unfollowLogReceipts(log,{accountId:'2',handle:'other'})[0].accountId,'unassigned');
});
test('history deduplicates by owner and handle, keeps latest outcome and does not mix accounts',()=>{
 const r=unfollowLogReceipts(log,{accountId:'1',handle:'owner'})[0];
 const h=mergeUnfollowHistory({},[r,{...r,at:r.at+100},{...r,accountId:'2'}]);
 assert.equal(Object.keys(h).length,2);
 assert.equal(unfollowHistoryRows(h,'1')[0].payload.unfollowReceipt.at,r.at+100);
 assert.equal(unfollowHistoryRows(h,'unassigned','1').length,1);
 assert.equal(unfollowHistoryRows(h,'3').length,0);
});
