import {hashCanonical} from './record-migration.js';
import {createRecordProjection} from './record-projection.js';

export const SNAPSHOT_CATALOG = 'recordSnapshots:v1:catalog';
export const SNAPSHOT_PREFIX = 'recordSnapshots:v1:image:';
export const SNAPSHOT_LOG_PREFIX = 'recordLogArchives:v1:';
export const SNAPSHOT_POLICY = {retain: 3, incrementalLimit: 1000, maxAgeMs: 86400000};
export const BACKUP_SETTINGS_KEY = 'recordBackupSettings';
export const BACKUP_DEFAULTS = {enabled: true, retain: 3, incrementalLimit: 1000, maxAgeHours: 24, checkMinutes: 60};
export function validateBackupSettings(value) {
  const settings = {...BACKUP_DEFAULTS, ...value};
  if (typeof settings.enabled !== 'boolean') throw new Error('自动快照设置无效');
  for (const [key, min, max, label] of [
    ['retain', 1, 10, '历史快照数'], ['incrementalLimit', 100, 10000, '增量触发数'],
    ['maxAgeHours', 1, 168, '快照间隔'], ['checkMinutes', 5, 1440, '检查间隔']
  ]) {
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`${label}须为 ${min}–${max} 的整数`);
  }
  return Object.fromEntries(Object.keys(BACKUP_DEFAULTS).map(key => [key, settings[key]]));
}

// Execution logs have their own store/recovery cursor. Legacy dashboard log rows
// are preserved in a separate companion archive, never mixed into account rows.
export function splitSnapshot(image) {
  const business = structuredClone(image), logs = {};
  for (const name of ['rows', 'membership', 'summaries']) {
    logs[name] = business[name].filter(row => row.module === 'logs');
    business[name] = business[name].filter(row => row.module !== 'logs');
  }
  return {business, logs};
}

export function joinSnapshot(business, logs) {
  const image = structuredClone(business);
  for (const name of ['rows', 'membership', 'summaries']) {
    image[name] = [...image[name], ...(logs[name] || [])];
  }
  return image;
}

export async function readSnapshot(read, descriptor) {
  const snapshot = await read(SNAPSHOT_PREFIX + descriptor.id);
  const archive = await read(SNAPSHOT_LOG_PREFIX + descriptor.id);
  if (!snapshot || snapshot.version !== 1 || snapshot.seq !== descriptor.seq ||
      snapshot.fingerprint !== descriptor.fingerprint || await hashCanonical(snapshot.business) !== descriptor.fingerprint ||
      !archive || await hashCanonical(archive.logs) !== snapshot.logFingerprint) {
    throw new Error('完整备份校验失败，已停止恢复或清理');
  }
  return {snapshot, image: joinSnapshot(snapshot.business, archive.logs)};
}

// Use a real isolated IndexedDB with the production restore implementation.
// The source database is never cleared as part of a restore drill.
export async function verifySnapshotRestore({image, indexedDB, IDBKeyRange, dbName}) {
  const restored = createRecordProjection({indexedDB, IDBKeyRange, dbName});
  try {
    await restored.importSnapshot(image);
    const actual = await restored.exportSnapshot();
    // IndexedDB primary-key ordering is canonical; normalize the source through
    // the same ordering because business/log archives were split for storage.
    const normalize = value => Object.fromEntries(Object.entries(value).map(([name, rows]) =>
      [name, [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
    if (await hashCanonical(normalize(image)) !== await hashCanonical(normalize(actual))) {
      throw new Error('恢复演练数据不一致，禁止清理旧增量');
    }
    return {verified: true, rows: actual.rows.length, fingerprint: await hashCanonical(normalize(actual))};
  } finally {
    await restored.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('恢复演练数据库清理被阻塞'));
    });
  }
}
