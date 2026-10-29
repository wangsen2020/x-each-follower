import test from 'node:test';
import assert from 'node:assert/strict';
import {HEALTH_KEY,HEALTH_NOTICE_KEY,HEALTH_ALARM,HEALTH_REMINDER_MS,reportBackupHealth,reportUnfollowHealth,createAutomationHealthRuntime,retireApiStatusPause} from '../src/shared/automation-health.js';
function fixture(){const data={},shown=[],cleared=[],alarms=new Map(),listeners=[];let clock=1000000;
 const local={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(data[k])])),set:async value=>Object.assign(data,structuredClone(value))};
 const api={storage:{local,onChanged:{addListener:f=>listeners.push(f)}},runtime:{getURL:p=>'chrome-extension://ext/'+p},notifications:{getPermissionLevel:async()=>'granted',clear:async id=>cleared.push(id),create:async(id,options)=>shown.push({id,options})},alarms:{create:async(k,v)=>alarms.set(k,v),clear:async k=>alarms.delete(k),onAlarm:{addListener(){}}}};
 return {api,data,shown,cleared,alarms,now:()=>clock,advance:ms=>clock+=ms};}

test('retiring API-status pause preserves history, settings and unrelated alerts and restores missed plans',async()=>{
 const f=fixture();f.api.alarms.get=async name=>f.alarms.get(name);
 f.data[HEALTH_KEY]={alerts:{'x-rate-limit':{deferredAlarms:['queue']},logs:{reason:'keep'}}};
 f.data.unreciprocatedSettings={autoUnfollow:true};
 f.data.autoUnfollowState={accounts:{1:{used:5,pendingItems:[{user:{id:'12'}}],scheduler:{phase:'paused',reason:'X 请求受限（HTTP 429），自动调度已暂停'}}}};
 await retireApiStatusPause(f.api);
 assert.equal(f.data[HEALTH_KEY].alerts['x-rate-limit'],undefined);assert.equal(f.data[HEALTH_KEY].alerts.logs.reason,'keep');
 assert.equal(f.data.unreciprocatedSettings.autoUnfollow,true);assert.equal(f.data.autoUnfollowState.accounts[1].used,5);assert.equal(f.data.autoUnfollowState.accounts[1].pendingItems.length,1);assert.equal(f.data.autoUnfollowState.accounts[1].scheduler.phase,'waiting');assert.ok(f.alarms.has('queue'));
 await retireApiStatusPause(f.api);assert.equal(f.alarms.size,1);
});
test('unresolved health persists through acknowledgement, repeated failures, and worker restart',async()=>{
 const f=fixture();await reportBackupHealth({ok:false,error:'sequence conflict',pending:8},f.api.storage.local,f.now());
 const runtime=createAutomationHealthRuntime({api:f.api,now:f.now});await runtime.sync();assert.equal(f.shown.length,1);assert.equal(f.shown[0].options.requireInteraction,true);
 await f.api.notifications.clear('xf-health-logs');await reportBackupHealth({ok:false,error:'sequence conflict',pending:9},f.api.storage.local,f.now());
 await createAutomationHealthRuntime({api:f.api,now:f.now}).sync();assert.equal(f.shown.length,1);assert.ok(f.data[HEALTH_KEY].alerts.logs);
 f.advance(HEALTH_REMINDER_MS);await runtime.sync();assert.equal(f.shown.length,2);assert.ok(f.alarms.has(HEALTH_ALARM));
});
test('partial backup progress does not clear the alert; a completed drain does',async()=>{
 const f=fixture();await reportBackupHealth({ok:false,error:'offline',pending:8},f.api.storage.local,f.now());
 await reportBackupHealth({ok:true,pending:1},f.api.storage.local,f.now());assert.ok(f.data[HEALTH_KEY].alerts.logs);
 const runtime=createAutomationHealthRuntime({api:f.api,now:f.now});await runtime.sync();
 await reportBackupHealth({ok:true,pending:0},f.api.storage.local,f.now());await runtime.sync();assert.equal(f.data[HEALTH_KEY].alerts.logs,undefined);assert.equal(f.alarms.has(HEALTH_ALARM),false);
});
test('denied desktop permissions remain visible as a delivery error without discarding the alert',async()=>{
 const f=fixture();f.api.notifications.getPermissionLevel=async()=>'denied';await reportBackupHealth({ok:false,error:'failure',pending:3},f.api.storage.local,f.now());await createAutomationHealthRuntime({api:f.api,now:f.now}).sync();assert.equal(f.shown.length,0);assert.match(f.data[HEALTH_NOTICE_KEY].logs.error,/权限已关闭/);assert.ok(f.data[HEALTH_KEY].alerts.logs);
});
test('real blocked unfollow states alert, normal window and daily-limit waits do not',async()=>{
 const f=fixture(),cfg={autoUnfollow:true,autoUnfollowAccount:{id:'1'}};
 const ledger=reason=>({accounts:{1:{scheduler:{phase:'paused',reason}}}});
 await reportUnfollowHealth(cfg,ledger('平台限流'),f.api.storage.local,f.now());assert.ok(f.data[HEALTH_KEY].alerts.unfollow);
 await reportUnfollowHealth(cfg,{accounts:{1:{scheduler:{phase:'waiting'}}}},f.api.storage.local,f.now());assert.equal(f.data[HEALTH_KEY].alerts.unfollow,undefined);
 await reportUnfollowHealth(cfg,ledger('今日额度已用完'),f.api.storage.local,f.now());assert.equal(f.data[HEALTH_KEY].alerts.unfollow,undefined);
});
