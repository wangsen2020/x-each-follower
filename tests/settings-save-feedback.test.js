import test from 'node:test';
import assert from 'node:assert/strict';
import {useSettingsDrawer} from '../src/entries/panel/composables/useSettingsDrawer.js';
import {awaitSettingsResponse} from '../src/entries/panel/settings-response.js';
import {followReviewBindingStatus,normalizeFollowReviewSettings,saveFollowReviewSettings} from '../src/entries/panel/follow-review-settings.js';

test('a missing save acknowledgement releases controls and preserves the draft without claiming success',async()=>{
  const drawer=useSettingsDrawer({timeoutMs:10});drawer.open({every:37,jitter:2,autoEnqueue:false});
  let submitted=0;drawer.setSaveHandler(()=>{submitted++;return new Promise(()=>{});});
  assert.equal(await drawer.save(),false);assert.equal(submitted,1);assert.equal(drawer.saving.value,false);
  assert.match(drawer.errorMessage.value,/超时.*待确认/);assert.equal(drawer.successMessage.value,'');
  assert.equal(drawer.every.value,37);assert.equal(drawer.autoEnqueue.value,false);
});
test('a repeated click cannot submit a second save while the first is pending',async()=>{
  const drawer=useSettingsDrawer();drawer.open();let resolve,submitted=0;
  drawer.setSaveHandler(()=>{submitted++;return new Promise(done=>resolve=done);});
  const first=drawer.save();await Promise.resolve();assert.equal(await drawer.save(),false);
  assert.equal(submitted,1);resolve();assert.equal(await first,true);assert.equal(drawer.successMessage.value,'配置已保存');
});
test('editing after saving clears the saved badge, and edits during saving are never claimed as saved',async()=>{
  const drawer=useSettingsDrawer();drawer.open();drawer.setSaveHandler(async()=>{});await drawer.save();
  drawer.every.value=20;assert.equal(drawer.successMessage.value,'');
  let resolve;drawer.setSaveHandler(()=>new Promise(done=>resolve=done));const saving=drawer.save();await Promise.resolve();
  drawer.every.value=30;resolve();await saving;assert.equal(drawer.successMessage.value,'配置已保存，当前修改尚未保存');assert.equal(drawer.every.value,30);
});
test('an old timed-out acknowledgement cannot replace feedback for a later save',async()=>{
  const drawer=useSettingsDrawer({timeoutMs:10});drawer.open();let old;
  drawer.setSaveHandler(()=>new Promise(resolve=>old=resolve));await drawer.save();
  drawer.setSaveHandler(async()=>{throw Error('new save rejected');});await drawer.save();old();await Promise.resolve();
  assert.equal(drawer.errorMessage.value,'new save rejected');assert.equal(drawer.successMessage.value,'');
});
test('checking an unknown save reloads persisted settings without submitting another write',async()=>{
  const drawer=useSettingsDrawer({timeoutMs:5});drawer.open({every:37});let writes=0,reads=0;
  drawer.setSaveHandler(()=>{writes++;return new Promise(()=>{});});await drawer.save();
  drawer.setReloadHandler(async()=>{reads++;return {every:42,jitter:3,enabled:false};});
  assert.equal(await drawer.reload(),true);assert.equal(drawer.every.value,42);assert.equal(drawer.errorMessage.value,'');
  assert.equal(drawer.successMessage.value,'已重新读取当前设置');assert.equal(drawer.reloading.value,false);assert.equal(writes,1);assert.equal(reads,1);
});
test('a deadline never repeats its operation and a late response cannot change its result',async()=>{
  let resolve,calls=0;await assert.rejects(awaitSettingsResponse(()=>{calls++;return new Promise(done=>resolve=done);},{timeoutMs:5}),{name:'SettingsResponseTimeoutError'});
  resolve('late');assert.equal(calls,1);
});
test('AI status distinguishes saved settings, actual session availability and unsaved edits',()=>{
  const config={provider:'codex',botId:'chosen'};
  assert.equal(followReviewBindingStatus({}).state,'unconfigured');
  assert.equal(followReviewBindingStatus(config).state,'saved');
  assert.equal(followReviewBindingStatus(config,{loading:true}).state,'checking');
  assert.equal(followReviewBindingStatus(config,{connected:true,sessions:[{id:'chosen'}]}).state,'ready');
  assert.equal(followReviewBindingStatus(config,{connected:true,sessions:[{id:'other'}]}).state,'error');
  assert.equal(followReviewBindingStatus(config,{error:'timeout'}).state,'error');
  assert.equal(followReviewBindingStatus(config,{connected:true,sessions:[{id:'chosen'}]},true).state,'unsaved');
});
test('AI configuration saving times out once while preserving the role configuration',async()=>{
  const draft=normalizeFollowReviewSettings({fanTagging:{provider:'codex',botId:'tagger',prompt:'my input'}}),original=structuredClone(draft);let calls=0;
  await assert.rejects(saveFollowReviewSettings(draft,'fans',()=>{calls++;return new Promise(()=>{});},{timeoutMs:5}),/状态待确认/);
  assert.equal(calls,1);assert.deepEqual(draft,original);
});
