import test from 'node:test';import assert from 'node:assert/strict';
import {saveFollowbackSettings,withFollowbackProgress} from '../src/features/relationships/followback-settings.js';
test('settings save completes after only local persistence even if sync and scheduling never finish',async()=>{
 const writes=[],messages=[];const never=new Promise(()=>{});
 const config={every:60,overdueDays:14};
 const api={storage:{local:{set:async value=>writes.push(value)},sync:{set:()=>never}},runtime:{sendMessage:message=>{messages.push(message);return never;}}};
 assert.equal(await saveFollowbackSettings(config,api),config);
 assert.deepEqual(writes,[{unreciprocatedSettings:config}]);assert.equal(messages[0].cmd,'configureUnreciprocatedTracker');
});
test('a failed local write fails saving and never schedules or syncs',async()=>{
 let extra=0;const api={storage:{local:{set:async()=>{throw new Error('disk failure');}},sync:{set:()=>extra++}},runtime:{sendMessage:()=>extra++}};
 await assert.rejects(saveFollowbackSettings({},api),/disk failure/);assert.equal(extra,0);
});

test('completed comparison updates progress without overwriting newly saved preferences',()=>{
 const result=withFollowbackProgress({overdueDays:15,lastRunAt:'2026-10-23T10:00:00Z'},{overdueDays:14,lastRunAt:'2026-10-23T11:00:00Z',lastSummary:'done'});
 assert.equal(result.overdueDays,15);assert.equal(result.lastSummary,'done');
 assert.equal(withFollowbackProgress(result,{lastRunAt:'2026-10-23T09:00:00Z',lastSummary:'old'}),result);
});

test('enabling automatic unfollow binds the verified account and refuses missing identity',async()=>{
 const writes=[];const api={storage:{local:{set:async x=>writes.push(x)}},runtime:{sendMessage:async m=>m.cmd==='sidebarIdentity'?{account:{id:'123',handle:'owner'}}:{ok:true}}};
 const config=await saveFollowbackSettings({autoUnfollow:true},api);assert.deepEqual(config.autoUnfollowAccount,{id:'123',handle:'owner'});assert.equal(writes.length,1);
 api.runtime.sendMessage=async()=>({account:null});await assert.rejects(saveFollowbackSettings({autoUnfollow:true},api),/登录 X/);assert.equal(writes.length,1);
});
