// Pure dashboard lookup and durable-recovery decisions.
// Indexes are per pass: callers must rebuild after in-place monitor edits.

export const STARTUP_DURABLE_KEYS = [
  'rows',
  'monitor',
  'analysisRows',
  'profileCache',
  'mutualNetwork',
  'commentTracking',
  'mutualAutoFollowSettings',
  'commentAutoFollowSettings',
  'unreciprocatedTracker'
];

export const LOG_DURABLE_KEYS = ['autoFollowLogs', 'monitorLogs', 'unreciprocatedLogs'];

export function localKeyPresent(record, key) {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return false;
  const value = record[key];
  return value !== undefined && value !== null;
}

export function keysMissingFromLocal(record, keys) {
  return keys.filter(key => !localKeyPresent(record, key));
}

// Undefined means "do not apply": local won the race, or the backup is missing.
export function recoveredValueIfStillMissing(latestRecord, key, recovered) {
  if (localKeyPresent(latestRecord, key)) return undefined;
  if (recovered == null) return undefined;
  return recovered;
}

export {
  buildRelationshipIndex,
  monitorUserStatus,
  commentRelationshipLabel,
  applyRelationshipSnapshot,
  snapshotMutualUsers,
  deriveNotMutualUsers,
  deriveTrackerUsers,
  inactiveFollowingHandles
} from '../../features/relationships/relationship-rules.js';

export function shouldPaintLogs(modalHidden) {
  return modalHidden === false;
}

// A startup restore is the only reason to scan mojibake a second time.
export function shouldRescanMojibake(restoredCount) {
  return restoredCount > 0;
}

export function tabRenderTargets(previousTab, nextTab) {
  if (previousTab === nextTab) return [];
  if (nextTab === 'followQueue') return ['followQueue'];
  if (nextTab === 'monitor') return ['monitor'];
  if (nextTab === 'candidates') return ['mutual'];
  if (nextTab === 'comments') return ['comments', 'commentSettings'];
  if (nextTab === 'unreciprocated') return ['unreciprocated'];
  return [];
}

// null fields mean the change does not touch that slot. Empty arrays stay present.
export function localStorageChangePlan(changes, area) {
  const idle = {commentRender: false, logs: null, commentStatus: undefined, commentTracking: null, commentAuto: undefined};
  if (area !== 'local' || !changes) return idle;
  return {
    commentRender: Boolean(changes.commentTracking || changes.commentAutoFollowSettings || changes.commentTrackingStatus || changes.monitor),
    logs: changes.autoFollowLogs ? (changes.autoFollowLogs.newValue || []) : null,
    commentStatus: changes.commentTrackingStatus ? (changes.commentTrackingStatus.newValue || null) : undefined,
    commentTracking: changes.commentTracking ? (changes.commentTracking.newValue || {users: [], posts: []}) : null,
    commentAuto: changes.commentAutoFollowSettings?.newValue
  };
}

// Writers must not append until this resolves. A thrown read is retryable.
export async function loadDurableLogBuffer(name, storage) {
  if (!LOG_DURABLE_KEYS.includes(name)) return {action: 'skip'};
  const readLocal = async () => {
    try {
      return await storage.localGet(name);
    } catch (error) {
      const failure = new Error('local log read failed');
      failure.cause = error;
      failure.retryable = true;
      throw failure;
    }
  };
  const saved = await readLocal();
  if (localKeyPresent(saved, name)) return {action: 'assign', value: saved[name], persist: false};
  let recovered;
  try {
    recovered = await storage.durableGet(name);
  } catch (error) {
    const failure = new Error('durable log read failed');
    failure.cause = error;
    failure.retryable = true;
    throw failure;
  }
  const latest = await readLocal();
  if (localKeyPresent(latest, name)) return {action: 'assign', value: latest[name], persist: false};
  const value = recoveredValueIfStillMissing(latest, name, recovered);
  if (!Array.isArray(value)) return {action: 'skip'};
  return {action: 'assign', value, persist: true};
}

export function takeLogBufferTask(tasks, name, loader) {
  if (!tasks[name]) {
    const task = Promise.resolve().then(loader).then(
      value => value,
      error => {
        if (tasks[name] === task) delete tasks[name];
        throw error;
      }
    );
    tasks[name] = task;
  }
  return tasks[name];
}
