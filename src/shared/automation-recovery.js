import {randomizedInteger} from './timing.js';

const settingsKeys = ['mutualAutoFollowSettings', 'commentAutoFollowSettings', 'unreciprocatedSettings'];

export async function restoreMissingLocalSetting(storage, key, fallback) {
  const local = await storage.get(key);
  if (local[key] != null) return local[key];
  if (fallback != null) await storage.set({[key]: fallback});
  return fallback;
}

// Sync is a fallback for a new installation, not an authority over this
// browser's explicitly saved switches (including enabled:false).
export async function restoreMissingSyncedSettings(storage = chrome.storage) {
  if (!storage.sync) return;
  const local = await storage.local.get(settingsKeys);
  const missing = settingsKeys.filter(key => local[key] == null);
  if (!missing.length) return;
  const remote = await storage.sync.get(missing);
  const restored = Object.fromEntries(missing.filter(key => remote[key] != null).map(key => [key, remote[key]]));
  if (Object.keys(restored).length) await storage.local.set(restored);
}

// A service worker may restart with alarms missing after an extension update.
// Reconcile without moving existing deadlines on every worker wake-up.
export async function recoverAutomationAlarms({storage = chrome.storage.local, alarms = chrome.alarms} = {}) {
  const data = await storage.get([...settingsKeys, 'mutualNetwork', 'commentTracking', 'unreciprocatedTracker', 'monitor', 'followQueueBinding']);
  const existing = new Set((await alarms.getAll()).map(alarm => alarm.name));
  const schedules = [
    ['x-mutual-auto-follow', data.mutualAutoFollowSettings ?? data.mutualNetwork?.autoFollow, 5, 5],
    ['x-comment-auto-follow', data.commentAutoFollowSettings ?? data.commentTracking?.autoFollow, 5, 5],
    ['x-unreciprocated-tracker', data.unreciprocatedSettings ?? data.unreciprocatedTracker?.config, 60, 5],
    ['x-followers-scan', data.monitor, 60, 10]
  ];
  const restored = [];
  for (const [name, config, fallback, minimum] of schedules) {
    if (data.followQueueBinding?.activated && ['x-mutual-auto-follow','x-comment-auto-follow'].includes(name)) { await alarms.clear(name); continue; }
    if (!config?.enabled || existing.has(name)) continue;
    const delayInMinutes = randomizedInteger(Number(config.every) || fallback, Math.max(1, Number(config.jitter) || 1), minimum, 1440);
    await alarms.create(name, {delayInMinutes});
    restored.push(name);
  }
  return restored;
}
