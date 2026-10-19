import test from 'node:test';
import assert from 'node:assert/strict';
import {readAutoFollowAttempts, wasAutoFollowAttempted, recordAutoFollowAttempt, mergeAutoFollowProgress} from '../auto-follow-history.js';
import {selectValuableMutualTargets} from '../scoring.js';

test('a skipped account is excluded in both queues after reloading storage; new accounts remain eligible', async () => {
  const data = {};
  const storage = {set:async update=>Object.assign(data,update), get:async keys=>Object.fromEntries(keys.filter(k=>k in data).map(k=>[k,data[k]]))};
  await recordAutoFollowAttempt('@KimmyKimOL','processing','',storage);
  const users=[{handle:'KimmyKimOL'},{handle:'new_user'}];
  assert.equal(wasAutoFollowAttempted('kimmykimol',await readAutoFollowAttempts(users,storage)),true);
  await recordAutoFollowAttempt('KimmyKimOL','skipped','未达到推荐条件',storage);
  const reloaded = await readAutoFollowAttempts(users,storage);
  assert.deepEqual(users.filter(u=>!wasAutoFollowAttempted(u.handle,reloaded)),[{handle:'new_user'}]);
  assert.equal(wasAutoFollowAttempted('@KIMMYKIMOL',reloaded,Date.now()+86400000),true);
});

test('an interrupted task has a bounded lease instead of permanently blocking its account', () => {
  const data={'autoFollowAttempt:alice':{state:'processing',at:1000}};
  assert.equal(wasAutoFollowAttempted('alice',data,1001),true);
  assert.equal(wasAutoFollowAttempted('alice',data,1000+30*60000),false);
});

test('old independent settings cannot erase completed handles or override explicit switches', () => {
  const cfg=mergeAutoFollowProgress({enabled:false,processedHandles:[]},{enabled:true,processedHandles:['KimmyKimOL'],visitedHandles:['@Alice']});
  assert.equal(cfg.enabled,false);
  assert.deepEqual(cfg.processedHandles,['kimmykimol','alice']);
});

test('an empty legacy visited list does not mask the processed list', () => {
  const user={handle:'KimmyKimOL',bio:'互关 互粉',followersText:'1000',followingText:'1000'};
  assert.deepEqual(selectValuableMutualTargets([user],{onlyIntent:false,visitedHandles:[],processedHandles:['kimmykimol']}),[]);
});
