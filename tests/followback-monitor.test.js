import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isAccountUnavailable,accountAvailabilityStatus, mergeFollowbackAvailability, matchesAccountAvailability, compareFollowback, needsFollowbackOverlay, sortFollowbackUsers} from '../src/features/relationships/followback-monitor.js';

const now = Date.parse('2026-10-23T00:00:00Z');
const follow = (id, days, followedBy = false) => ({
  id, handle: `user${id}`, followedAt: days == null ? null : new Date(now - days * 86400000).toISOString(),
  followedAtSource: days == null ? 'unknown' : 'confirmed', relationship: {following: true, followedBy}
});

test('local comparison separates our nonfollowers from people awaiting our follow', () => {
  const middle = follow('2', 3);
  delete middle.relationship.followedBy;
  const users = compareFollowback({followingUsers: [follow('1', 20), middle, follow('3', null)], followerUsers: [{id: '2', handle: 'user2'}, {id: '4', handle: 'user4'}], overdueDays: 14, now});
  assert.deepEqual(users.map(user => user.status), ['overdue', 'mutual', 'pending']);
  assert.equal(users.some(user => user.id === '4'), false);
  assert.equal(users[2].followedAt, new Date(now - 86400000).toISOString());
  assert.deepEqual(sortFollowbackUsers(users).map(user => user.id), ['1', '2', '3']);
});

test('new explicit negative evidence supersedes an old mutual status', () => {
  const users = compareFollowback({followingUsers: [follow('1', 20)], followerUsers: [{id: '1', handle: 'user1'}], previousUsers: [{id: '1', handle: 'user1', status: 'mutual', everMutual: true}], overdueDays: 14, now});
  assert.equal(users[0].status, 'overdue');
  assert.equal(users[0].everMutual, true);
  assert.equal(users[0].lostMutualDetectedAt, new Date(now).toISOString());
});

test('unknown relation and unknown follow date do not trigger overdue', () => {
  const users = compareFollowback({followingUsers: [{id: '1', handle: 'user1', relationship: {following: true}}], followerUsers: [], now});
  assert.equal(users[0].status, 'unknown');
  assert.equal(users[0].daysSinceFollowed, 1);
});

test('first comparison only saves relationships that differ from local derived records', () => {
  assert.equal(needsFollowbackOverlay({status: 'pending', relationship: {followedBy: false}}, null, {relationship: {followedBy: false}}), false);
  assert.equal(needsFollowbackOverlay({status: 'mutual', relationship: {followedBy: true}}, null, {relationship: {followedBy: true}}), false);
  assert.equal(needsFollowbackOverlay({status: 'unknown', relationship: {followedBy: null}}, null, {relationship: {followedBy: null}}), false);
  assert.equal(needsFollowbackOverlay({status: 'overdue', relationship: {followedBy: false}}, null, {relationship: {followedBy: false}}), true);
  assert.equal(needsFollowbackOverlay({status: 'mutual', relationship: {followedBy: true}}, null, {relationship: {followedBy: false}}), true);
  assert.equal(needsFollowbackOverlay({status: 'pending', followedAtSource: 'confirmed', relationship: {followedBy: false}}, null, {relationship: {followedBy: false}}), true);
  assert.equal(needsFollowbackOverlay({status: 'pending', relationship: {followedBy: false}}, {status: 'pending', relationship: {followedBy: false}}), false);
  assert.equal(needsFollowbackOverlay({status: 'pending', followedAt: null, lostMutualDetectedAt: null, relationship: {followedBy: false}}, {status: 'pending', followedAt: '', relationship: {followedBy: false}}), false);
  assert.equal(needsFollowbackOverlay({status: 'pending', followedAt: null, followedAtSource: 'unknown', relationship: {followedBy: false}}, {status: 'pending', followedAt: '2026-01-01T00:00:00Z', relationship: {followedBy: false}}), true);
});


test('legacy dates survive missing metadata', () => {
  const user = follow('1', 20); delete user.followedAtSource;
  const [result] = compareFollowback({followingUsers: [user], now});
  assert.equal(result.followedAt, user.followedAt);
  assert.equal(result.status, 'overdue');
});
test('yesterday fallback persists once without sliding on subsequent comparisons', () => {
  const user = follow('1', null);
  const [first] = compareFollowback({followingUsers: [user], now});
  assert.equal(first.followedAtSource, 'estimated');
  assert.equal(needsFollowbackOverlay(first, null, user), true);
  const [next] = compareFollowback({followingUsers: [user], previousUsers: [first], now: now + 86400000});
  assert.equal(next.followedAt, first.followedAt);
  assert.equal(next.daysSinceFollowed, 2);
  assert.equal(needsFollowbackOverlay(next, first, user), false);
});
test('real dates take precedence over estimates in either direction', () => {
  const real = follow('1', 20), estimate = {...follow('1', 1), followedAtSource: 'estimated'};
  for (const [current, previous] of [[real, estimate], [estimate, real]]) {
    const [result] = compareFollowback({followingUsers: [current], previousUsers: [previous], now});
    assert.equal(result.followedAt, real.followedAt);
    assert.equal(result.followedAtSource, 'confirmed');
  }
});

test('comparison retains tracker write identity instead of copying fan source metadata', () => {
  const current = {...follow('1', null), __sourceKey: 'monitor', __sourceBucket: 'followingUsers', __userKey: 'fan-1'};
  const [result] = compareFollowback({followingUsers: [current], now});
  assert.equal(result.__sourceKey, 'unreciprocatedTracker');
  assert.equal(result.__sourceBucket, 'synthetic');
  assert.equal(result.__userKey, undefined);
  const [existing] = compareFollowback({followingUsers: [current], previousUsers: [{...current, __sourceKey: 'unreciprocatedTracker', __sourceBucket: 'users', __userKey: 'tracker-1'}], now});
  assert.equal(existing.__userKey, 'tracker-1');
  assert.equal(existing.__sourceBucket, 'users');
});


test('later arrival of user ID preserves the original estimated timestamp', () => {
  const user = follow('1', null);
  const [old] = compareFollowback({followingUsers: [{...user, id: ''}], now});
  const [next] = compareFollowback({followingUsers: [user], previousUsers: [old], now: now + 86400000});
  assert.equal(next.followedAt, old.followedAt);
  assert.equal(next.daysSinceFollowed, 2);
});

test('two estimated copies retain the earliest persisted fallback', () => {
  const old = {...follow('1', 2), followedAtSource: 'estimated'};
  const current = {...follow('1', 1), followedAtSource: 'estimated'};
  assert.equal(compareFollowback({followingUsers: [current], previousUsers: [old], now})[0].followedAt, old.followedAt);
});

test('legacy reused IDs cannot merge different handles or discard users', () => {
  const first = {...follow('1', 2), handle: 'first', followedAtSource: 'estimated'};
  const second = {...follow('1', 8), handle: 'second'};
  const users = compareFollowback({followingUsers: [{...first, followedAt: null}, second], previousUsers: [first, second], now});
  assert.equal(users.length, 2);
  assert.equal(users[0].followedAt, first.followedAt);
  assert.equal(users[1].followedAt, second.followedAt);
});

test('conflicting real timestamps converge to the earliest recorded follow regardless of merge order', () => {
  const early = follow('1', 8), late = follow('1', 2);
  for (const [current, previous] of [[early, late], [late, early]]) {
    assert.equal(compareFollowback({followingUsers: [current], previousUsers: [previous], now})[0].followedAt, early.followedAt);
  }
});

test('full tracker reload includes saved synthetic records and their write identity', async () => {
  const source = readFileSync(new URL('../src/entries/panel/panel.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function ensureCompleteModule('), source.indexOf("$('grokAnalyzeMutual')", source.indexOf('async function ensureCompleteModule(')));
  const saved = {userKey: 'derived-tracker/ada', handle: 'ada', sourcePath: ['unreciprocatedTracker', 'synthetic', 'ada'], payload: {handle: 'ada', followedAt: '2026-10-22T12:00:00Z', followedAtSource: 'estimated'}};
  const pages = {isComplete: () => false, loadComplete: async (module, key) => {assert.equal(module, 'unreciprocated'); assert.equal(key, 'unreciprocatedTracker'); return [saved];}};
  const ensure = new Function('recordPaging', 'recordPages', 'chrome', body + '; return ensureCompleteModule;')(true, pages, {});
  let records;
  await ensure('unreciprocated', 'unreciprocatedTracker', rows => {records = rows;});
  assert.equal(records.length, 1);
  assert.equal(records[0].payload.followedAt, saved.payload.followedAt);
  assert.equal(records[0].payload.__sourceBucket, 'synthetic');
  assert.equal(records[0].payload.__userKey, saved.userKey);
});


test('account availability only accepts explicit evidence and recovers on newer success', () => {
  const user = follow('1', 2);
  for (const status of ['error','timeout','rate_limited','pending','unknown']) assert.equal(mergeFollowbackAvailability(user,{status,checkedAt:100}),user);
  const missing = mergeFollowbackAvailability(user,{status:'not_found',checkedAt:100});
  assert.equal(accountAvailabilityStatus(missing),'not_found');
  assert.equal(matchesAccountAvailability(missing,'unavailable'),true);
  assert.equal(matchesAccountAvailability(missing,'suspended'),false);
  assert.equal(mergeFollowbackAvailability(missing,{status:'ok',checkedAt:99}),missing);
  assert.equal(mergeFollowbackAvailability(missing,{status:'not_found',checkedAt:110}),missing);
  const recovered = mergeFollowbackAvailability(missing,{status:'ok',checkedAt:120});
  assert.equal(accountAvailabilityStatus(recovered),'ok');
  assert.equal(needsFollowbackOverlay(recovered,missing),true);
  assert.equal(compareFollowback({followingUsers:[user],previousUsers:[missing],now})[0].accountAvailability.status,'not_found');
});

test('unresolved identity is a visible hold, never evidence of suspension or permission to delete',()=>{
 const user=mergeFollowbackAvailability({handle:'target'},{status:'identity_unresolved',checkedAt:123});
 assert.equal(accountAvailabilityStatus(user),'identity_unresolved');
 assert.equal(isAccountUnavailable(user),false);
});


test('comparison retains unfollow history without duplicating newly followed accounts', () => {
  const past={handle:'past',status:'unfollowed',unfollowedAt:'2026-10-25T10:00:00Z',relationship:{following:false}};
  const result=compareFollowback({followingUsers:[],previousUsers:[past]});
  assert.deepEqual(result,[past]);
  assert.notEqual(result[0],past);
  const followed=compareFollowback({followingUsers:[{handle:'past',relationship:{following:true,followedBy:false}}],previousUsers:[past]});
  assert.equal(followed.length,1);
  assert.equal(followed[0].status,'pending');
});
