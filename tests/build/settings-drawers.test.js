import test from 'node:test';
import assert from 'node:assert/strict';
import { useSettingsDrawer } from '../../src/entries/panel/composables/useSettingsDrawer.js';
import { useUnreciprocatedSettings, normalizeUnreciprocatedConfig } from '../../src/entries/panel/composables/useUnreciprocatedSettings.js';

test('useSettingsDrawer initializes with clean default state and computed checkpoints', () => {
  const drawer = useSettingsDrawer();
  assert.equal(drawer.isOpen.value, false);
  assert.equal(drawer.enabled.value, false);
  assert.equal(drawer.every.value, 10);
  assert.equal(drawer.jitter.value, 0);
  assert.equal(drawer.followerBatch.value, 1000);
  assert.equal(drawer.followingBatch.value, 1000);
  assert.equal(drawer.autoEnqueue.value, true);
  assert.equal(drawer.filterDanger.value, true);
  assert.equal(drawer.checkpointDisplayText.value, '未记录位点（首次将建立增量基准）');
  assert.equal(drawer.checkpointTimeText.value, '');
});


test('useSettingsDrawer validates intervals strictly', () => {
  const drawer = useSettingsDrawer();
  drawer.open({ every: 5, jitter: 15 }); // every < 10
  assert.throws(() => drawer.validate(), /基准检索间隔至少 10 分钟/);

  drawer.open({ every: 60, jitter: -1 });
  assert.throws(() => drawer.validate(), /随机浮动/);

  drawer.open({ every: 60, jitter: 60 }); // jitter >= every
  assert.throws(() => drawer.validate(), /周期以下/);

  drawer.open({every:10, jitter:0, followerBatch:1001, followingBatch:1000});
  assert.throws(() => drawer.validate(), /100–1000/);

  drawer.open({ every: 60, jitter: 15, enabled: true });
  const valid = drawer.validate();
  assert.equal(valid.every, 60);
  assert.equal(valid.jitter, 15);
  assert.equal(valid.enabled, true);
});

test('useSettingsDrawer save() invokes handler and sets success state', async () => {
  const drawer = useSettingsDrawer();
  let savedData = null;
  drawer.setSaveHandler(async (cfg) => {
    savedData = cfg;
  });

  drawer.open({ every: 45, jitter: 10, enabled: true });
  const ok = await drawer.save();
  assert.equal(ok, true);
  assert.deepEqual(savedData, {
    enabled: true,
    every: 45,
    jitter: 10,
    followerBatch: 1000,
    followingBatch: 1000,
    autoEnqueue: true,
    filterDanger: true
  });
  assert.equal(drawer.successMessage.value, '配置已保存');
  drawer.close();
  assert.equal(drawer.isOpen.value, false);
});

test('normalizeUnreciprocatedConfig applies robust safe bounds', () => {
  const empty = normalizeUnreciprocatedConfig({});
  assert.equal(empty.enabled, false);
  assert.equal(empty.every, 60);
  assert.equal(empty.jitter, 10);
  assert.equal(empty.overdueDays, 14);
  assert.equal(empty.autoUnfollowEvery, 45);
  assert.equal(empty.autoUnfollowJitter, 15);
  assert.equal(empty.batchLimit, 1);
  assert.equal(empty.dailyLimit, 100);
  assert.equal(normalizeUnreciprocatedConfig({settingsSchemaVersion: 4, dailyLimit: 24}).dailyLimit, 100);
  assert.equal(normalizeUnreciprocatedConfig({settingsSchemaVersion: 5, dailyLimit: 24}).dailyLimit, 24);
  assert.deepEqual([normalizeUnreciprocatedConfig({settingsSchemaVersion: 2, autoUnfollowEvery: 30, autoUnfollowJitter: 5, batchLimit: 20, dailyLimit: 400}).autoUnfollowEvery, normalizeUnreciprocatedConfig({settingsSchemaVersion: 2, autoUnfollowEvery: 30, autoUnfollowJitter: 5, batchLimit: 20, dailyLimit: 400}).dailyLimit], [45, 100]);
  assert.equal(normalizeUnreciprocatedConfig({settingsSchemaVersion: 3, dailyLimit: 12}).dailyLimit, 100);
  assert.equal(normalizeUnreciprocatedConfig({settingsSchemaVersion: 4, dailyLimit: 12}).dailyLimit, 12);
  assert.equal(normalizeUnreciprocatedConfig({settingsSchemaVersion: 2, autoUnfollowEvery: 90, dailyLimit: 6}).autoUnfollowEvery, 90);
  assert.equal(normalizeUnreciprocatedConfig({settingsSchemaVersion: 2, autoUnfollowEvery: 90, dailyLimit: 6}).dailyLimit, 6);
  assert.equal(normalizeUnreciprocatedConfig({settingsSchemaVersion: 2, dailyLimit: 100}).dailyLimit, 100);
  assert.equal(empty.unfollowDelay, 15);
  assert.equal(empty.whitelist, '');

  const bounded = normalizeUnreciprocatedConfig({
    every: 2, // below min 5
    jitter: 100, // above max 60
    overdueDays: 120, // above max 90
    batchLimit: 999,
    dailyLimit: 999,
    whitelist: '  elonmusk, OpenAI  '
  });
  assert.equal(bounded.every, 5);
  assert.equal(bounded.jitter, 60);
  assert.equal(bounded.overdueDays, 90);
  assert.equal(bounded.batchLimit, 1);
  assert.equal(bounded.dailyLimit, 400);
  assert.equal(bounded.whitelist, 'elonmusk, OpenAI');
});

test('useUnreciprocatedSettings handles open, save and close reactively', async () => {
  const drawer = useUnreciprocatedSettings();
  let savedConfig = null;
  drawer.setSaveHandler(async (cfg) => {
    savedConfig = cfg;
  });

  drawer.open({
    every: 30,
    jitter: 5,
    overdueDays: 7,
    autoUnfollow: true,
    batchLimit: 15,
    whitelist: 'vitalik'
  });

  assert.equal(drawer.isOpen.value, true);
  assert.equal(drawer.every.value, 30);
  assert.equal(drawer.jitter.value, 5);
  assert.equal(drawer.overdueDays.value, 7);
  assert.equal(drawer.autoUnfollow.value, true);
  assert.equal(drawer.batchLimit.value, 1);
  assert.equal(drawer.whitelist.value, 'vitalik');

  const ok = await drawer.save();
  assert.equal(ok, true);
  assert.ok(savedConfig);
  assert.equal(savedConfig.overdueDays, 7);
  assert.equal(savedConfig.autoUnfollow, true);
  assert.equal(drawer.successMessage.value, '配置已保存');

  drawer.close();
  assert.equal(drawer.isOpen.value, false);
});

test('automatic reminder configuration can wait longer than the unfollow deadline',async()=>{
 const drawer=useUnreciprocatedSettings();let saved;drawer.setSaveHandler(async cfg=>{saved=cfg;});
 drawer.open({autoGreeting:true,greetingAfterDays:20,overdueDays:14});assert.equal(await drawer.save(),true);assert.equal(saved.autoGreeting,true);assert.equal(saved.greetingAfterDays,20);
});
