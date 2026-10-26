import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
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
