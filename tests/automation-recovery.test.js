import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverAutomationAlarms, followerScanDue, restoreMissingSyncedSettings, restoreMissingLocalSetting} from '../src/shared/automation-recovery.js';

test('an enabled follower monitor catches up when an open panel finds a missed scan', () => {
  const now=Date.parse('2026-10-22T06:00:00Z');
  assert.equal(followerScanDue({enabled:true,every:60,lastScan:'2026-10-22T05:30:00Z'},now),false);
  assert.equal(followerScanDue({enabled:true,every:60,lastScan:'2026-10-22T04:00:00Z'},now),true);
  assert.equal(followerScanDue({enabled:true,every:60,lastScan:null},now),true);
  assert.equal(followerScanDue({enabled:false,every:60,lastScan:null},now),false);
});

test('unified queue takeover prevents stale local or synced schedules from returning',async()=>{
  const cleared=[], created=[];
  const saved={followQueueBinding:{activated:true},mutualAutoFollowSettings:{enabled:true},commentAutoFollowSettings:{enabled:true},monitor:{enabled:true}};
  await recoverAutomationAlarms({storage:{get:async()=>saved},alarms:{getAll:async()=>[],clear:async n=>cleared.push(n),create:async n=>created.push(n)}});
  assert.deepEqual(cleared,['x-mutual-auto-follow','x-comment-auto-follow']);
  assert.deepEqual(created,['x-followers-scan']);
});

test('durable panel hydration preserves explicit local settings', async () => {
  const local={enabled:true,grokAutoComment:true};
  const selected=await restoreMissingLocalSetting({get:async key=>({[key]:local}),set:async()=>assert.fail('must preserve local')},'mutualAutoFollowSettings',{enabled:false,grokAutoComment:false});
  assert.equal(selected,local);
});

test('recover enabled mutual alarm after restart without changing existing deadlines', async () => {
  const saved = {mutualAutoFollowSettings:{enabled:true,every:8,jitter:3},commentAutoFollowSettings:{enabled:true}};
  const created = [];
  const alarms = {getAll:async()=>[{name:'x-comment-auto-follow',scheduledTime:123}],create:async(name,options)=>created.push({name,...options})};
  assert.deepEqual(await recoverAutomationAlarms({storage:{get:async()=>saved},alarms}), ['x-mutual-auto-follow']);
  assert.equal(created.length,1);
  assert.ok(created[0].delayInMinutes>=5 && created[0].delayInMinutes<=11);
});

test('explicit disabled settings take priority over stale enabled tracking data', async () => {
  const saved = {mutualAutoFollowSettings:{enabled:false},mutualNetwork:{autoFollow:{enabled:true}}};
  await recoverAutomationAlarms({storage:{get:async()=>saved},alarms:{getAll:async()=>[],create:async()=>assert.fail('disabled task must not be scheduled')}});
});

test('legacy tracking settings restore all enabled missing alarms with no page access', async () => {
  const saved = {mutualNetwork:{autoFollow:{enabled:true}},commentTracking:{autoFollow:{enabled:true}},unreciprocatedTracker:{config:{enabled:true}},monitor:{enabled:true}};
  const created=[];
  await recoverAutomationAlarms({storage:{get:async()=>saved},alarms:{getAll:async()=>[],create:async name=>created.push(name)}});
  assert.deepEqual(created,['x-mutual-auto-follow','x-comment-auto-follow','x-unreciprocated-tracker','x-followers-scan']);
});

test('follower alarm recovers from record metadata after local monitor migration', async () => {
  const created=[];
  const storage={get:async()=>({monitor:{enabled:false}})};
  const alarms={getAll:async()=>[],create:async(name)=>created.push(name)};
  await recoverAutomationAlarms({storage,alarms,monitorMetadata:async()=>({enabled:true,every:30,jitter:5})});
  assert.deepEqual(created,['x-followers-scan']);
  created.length=0;
  await recoverAutomationAlarms({storage:{get:async()=>({monitor:{enabled:true}})},alarms,monitorMetadata:async()=>({enabled:false})});
  assert.deepEqual(created,[]);
});

test('stale sync cannot disable locally enabled Grok or re-enable a disabled task', async () => {
  const saved = {mutualAutoFollowSettings:{enabled:false,grokAutoComment:true},commentAutoFollowSettings:{enabled:true},unreciprocatedSettings:{enabled:false}};
  await restoreMissingSyncedSettings({local:{get:async()=>saved,set:async()=>assert.fail('must not overwrite local settings')},sync:{get:async()=>assert.fail('local settings already exist')}});
});

test('sync fills only genuinely missing settings on first installation', async () => {
  const saved={mutualAutoFollowSettings:{enabled:true,grokAutoComment:true}};
  let written;
  await restoreMissingSyncedSettings({local:{get:async()=>saved,set:async value=>{written=value;}},sync:{get:async keys=>{
    assert.ok(!keys.includes('mutualAutoFollowSettings'));
    return {commentAutoFollowSettings:{enabled:false}};
  }}});
  assert.deepEqual(written,{commentAutoFollowSettings:{enabled:false}});
});
