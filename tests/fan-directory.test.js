import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFanDirectory, normalizeFanSearch} from '../src/features/relationships/fan-directory.js';

function row(handle, bucket, relationship, extra = {}, accountId = 'unassigned') {
  return {accountId,module:'fans',handle:handle.toLowerCase(),sourceKey:'monitor',sourcePath:['monitor',bucket,handle],userKey:`monitor/${bucket}/${handle}`,
    payload:{handle,relationship,...extra}};
}

test('fan directory deduplicates archive, queue and following into exclusive categories', () => {
  const input=[row('mutual','users',{following:true,followedBy:true}),row('mutual','followingUsers',{following:true,followedBy:true}),
    row('single','followingUsers',{following:true,followedBy:false}),row('pending','queue',{following:false,followedBy:true},{relationshipObservedAt:100}),
    row('unknown','users',{}),row('none','users',{following:false,followedBy:false},{relationshipObservedAt:100})];
  const rows=buildFanDirectory(input);
  assert.equal(rows.length,5);
  assert.deepEqual(Object.fromEntries(rows.map(r=>[r.handle,r.payload.fanCategory])),{mutual:'mutual',single:'following',pending:'review',unknown:'unknown',none:'none'});
  assert.equal(rows.flatMap(r=>r.tabs.filter(t=>!['all','outstanding'].includes(t))).length,rows.length);
  assert.deepEqual(input[0].payload.relationship,{following:true,followedBy:true});
});

test('conflicting history is unknown until a newer explicit observation resolves each direction', () => {
  const old=row('Ada','queue',{following:false,followedBy:true});
  const positive=row('Ada','followingUsers',{following:true,followedBy:true});
  assert.equal(buildFanDirectory([old,positive])[0].payload.fanCategory,'unknown');
  const fresh=row('Ada','users',{following:true,followedBy:true},{relationshipObservedAt:200});
  const resolved=buildFanDirectory([old,positive,fresh])[0];
  assert.equal(resolved.payload.fanCategory,'mutual');
  assert.equal(resolved.sourceUserKey,fresh.userKey);
  const later=row('Ada','queue',{following:false,followedBy:true},{relationshipVerifiedAt:new Date(300).toISOString()});
  assert.equal(buildFanDirectory([old,positive,fresh,later])[0].payload.fanCategory,'review');
});

test('a successful follow only timestamps following and cannot overwrite newer follower evidence', () => {
  const follow=row('Ada','queue',{following:true,followedBy:false},{followingObservedAt:300});
  const fan=row('Ada','users',{following:false,followedBy:true},{relationshipObservedAt:200});
  assert.equal(buildFanDirectory([follow,fan])[0].payload.fanCategory,'mutual');
});

test('identity and ownership conflicts never become actionable relationships', () => {
  const rows=[row('Ada','users',{following:true,followedBy:true},{id:'1'}),row('Ada','queue',{following:false,followedBy:true},{id:'2'})];
  assert.equal(buildFanDirectory(rows)[0].payload.fanCategory,'unknown');
  assert.equal(buildFanDirectory([...rows,row('Ada','users',{following:false,followedBy:true},{id:'1'},'another')]).length,2);
});

test('global fan search accepts handles and profile links', () => {
  assert.equal(normalizeFanSearch(' @Ada '),'ada');
  assert.equal(normalizeFanSearch('https://x.com/Ada?lang=en'),'ada');
  assert.equal(normalizeFanSearch('https://twitter.com/Ada/'),'ada');
  assert.equal(normalizeFanSearch('a name'),'a name');
});

test('confirmed unrelated accounts have no active all-list membership despite old review labels',()=>{
  const original=row('gone','users',{following:false,followedBy:false},{relationshipVerifiedAt:300,fanReview:{state:'review',reason:'historical'}});
  const entry=buildFanDirectory([original])[0];
  assert.equal(entry.payload.fanCategory,'none');assert.deepEqual(entry.tabs,['none']);
  assert.deepEqual(entry.payload.fanReview,original.payload.fanReview);
});

test('undated false defaults cannot hide an account as confirmed unrelated',()=>{
  const entry=buildFanDirectory([row('unverified','users',{following:false,followedBy:false})])[0];
  assert.equal(entry.payload.fanCategory,'unknown');assert.equal(entry.payload.relationshipKnown,false);assert.ok(entry.tabs.includes('all'));
});

test('undated legacy pending relationship remains unverified',()=>{
  const row={accountId:'unassigned',handle:'old',userKey:'old',sourceKey:'monitor',sourcePath:['monitor','queue','old'],payload:{handle:'old',relationship:{following:false,followedBy:true},state:'follow_back'}};
  assert.equal(buildFanDirectory([row])[0].payload.fanCategory,'unknown');
});

test('verification distinguishes missing evidence from incomplete relationship fields',()=>{
 const record=row('person','users',{following:false,followedBy:true},{id:'42',relationshipObservedAt:100,fanReview:{state:'verify',decision:'uncertain'}});
 assert.equal(buildFanDirectory([record])[0].payload.fanRelationshipReason,'资料待补充，完成后重新审核');
 record.payload.relationship={following:null,followedBy:null};record.payload.fanInspectionFailure={reason:'X 未返回完整关注关系'};
 assert.equal(buildFanDirectory([record])[0].payload.fanRelationshipReason,'X 未返回完整关注关系');
});
