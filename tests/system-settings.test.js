import test from 'node:test';
import assert from 'node:assert/strict';
import {SYSTEM_DEFAULTS,readSystemSettings,saveSystemSettings,validateSystemSettings} from '../src/shared/system-settings.js';
test('system preferences preserve defaults and isolate categories',async()=>{
  const data={};const storage={get:async key=>({[key]:data[key]}),set:async values=>Object.assign(data,values)};
  assert.deepEqual(await readSystemSettings('pagination',storage),SYSTEM_DEFAULTS.pagination);
  await saveSystemSettings('logs',{pageSize:10,days:7},storage);
  await saveSystemSettings('windows',{idleMinutes:2,checkMinutes:3,lifetimeMinutes:30},storage);
  assert.deepEqual(await readSystemSettings('logs',storage),{pageSize:10,days:7});
  assert.equal((await readSystemSettings('windows',storage)).checkMinutes,3);
  await assert.rejects(saveSystemSettings('windows',{idleMinutes:0},storage));
  assert.equal((await readSystemSettings('windows',storage)).idleMinutes,2);
  assert.throws(()=>validateSystemSettings('pagination',{fans:1000}));
  assert.throws(()=>validateSystemSettings('logs',{days:1}));
  assert.throws(()=>validateSystemSettings('windows',{lifetimeMinutes:2}));
  data['systemSettings:logs']={pageSize:'bad'};
  assert.deepEqual(await readSystemSettings('logs',storage),SYSTEM_DEFAULTS.logs);
});
