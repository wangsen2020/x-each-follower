// Indexed execution logs. Writes are serialized on one promise chain.
// Scope rows support newest-first [at, id] cursors. Legacy chrome.storage arrays are imported once and left in place.
import {durableGetStrict as persistentDurableGet, durableSet as persistentDurableSet} from '../platform/persistent-db.js';
import {selectExecutionLogs} from './execution-log-select.js';

export const EXECUTION_LOG_DB = 'x-each-follower-execution-logs';
export const LOG_PAGE_SIZE = 30;
export const BACKUP_ATTEMPT_LIMIT = 3;
const UI_SCOPES = ['autoFollow', 'queue', 'queueFans', 'comment', 'mutual', 'fans', 'monitor', 'unreciprocated'];
const LEGACY_KEYS = ['autoFollowLogs', 'monitorLogs', 'unreciprocatedLogs'];

export function executionLogMembership(log, origin = 'autoFollowLogs') {
  const scopes = new Set();
  const verification = log?.scope === 'verification';
  if (origin === 'monitorLogs') {
    scopes.add('fans');
    scopes.add('monitor');
    if (verification) UI_SCOPES.filter(scope => scope !== 'queue' && scope !== 'queueFans').forEach(scope => scopes.add(scope));
    return [...scopes];
  }
  if (origin === 'unreciprocatedLogs') {
    scopes.add('unreciprocated');
    if (verification) UI_SCOPES.filter(scope => scope !== 'queue' && scope !== 'queueFans').forEach(scope => scopes.add(scope));
    return [...scopes];
  }
  for (const scope of UI_SCOPES) {
    const probe = scope === 'monitor' ? 'fans' : scope;
    if (selectExecutionLogs([log], probe).length) scopes.add(scope);
  }
  return [...scopes];
}

export function clearScopesFor(scope) {
  return scope === 'fans' || scope === 'monitor' ? ['fans', 'monitor'] : scope === 'queue' ? ['queue', 'queueFans'] : [scope];
}

// Preserve prior per-view clears. Only legacy records still in the aggregate
// gain the new queue view; versioned dropScopes backups must never re-add it.
function upgradeQueueMembership(record) {
  const version = Number(record.scopeSchemaVersion) || 0;
  if (version >= 3) return record;
  const membership = new Set(record.membership || []);
  if (version < 2) {
    if (record.scope === 'queue' && membership.has('autoFollow')) membership.add('queue');
    else membership.delete('queue');
  }
  if (record.scope === 'queue' && membership.has('queue') && record.sources?.some(source => source.module === 'fans')) membership.add('queueFans');
  else membership.delete('queueFans');
  return {...record, membership:[...membership], scopeSchemaVersion:3};
}

export function assertLogScope(scope) {
  if (!UI_SCOPES.includes(scope)) throw new Error('未知日志范围');
  return scope;
}

export function assertLogCursor(cursor) {
  if (cursor == null) return null;
  if (typeof cursor.at !== 'string' || typeof cursor.id !== 'string' || !cursor.at || !cursor.id) throw new Error('日志游标无效');
  return {at: cursor.at, id: cursor.id};
}

const LOG_EPOCH = '1970-01-01T00:00:00.000Z';

// Scope-row keys are strings. Numeric and offset timestamps become UTC ISO so they fall inside those bounds.
// A legacy value that cannot be parsed keeps its original at and sorts at the epoch instead of aborting import.
function parsedLogTimestamp(value) {
  let date = null;
  if (typeof value === 'number' && Number.isFinite(value)) date = new Date(value);
  else if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) date = new Date(parsed);
  }
  if (!date || !Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function assignLogTime(record, value, mode) {
  const missing = value == null || value === '';
  if (missing) {
    record.at = mode === 'append' ? new Date().toISOString() : LOG_EPOCH;
    delete record.sortAt;
    delete record.atRaw;
    return;
  }
  const iso = parsedLogTimestamp(value);
  if (iso == null) {
    if (mode === 'append') throw new Error('日志时间无效');
    record.at = value;
    record.sortAt = LOG_EPOCH;
    delete record.atRaw;
    return;
  }
  record.at = iso;
  delete record.sortAt;
  if (value !== iso) record.atRaw = value;
  else delete record.atRaw;
}

function scopeSortAt(record) {
  return record.sortAt || record.at;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('日志事务已中止'));
  });
}

function openDatabase(indexedDB, name) {
  const request = indexedDB.open(name, 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('logs')) {
      const logs = db.createObjectStore('logs', {keyPath: 'id'});
      logs.createIndex('byEpisode', 'episodeKey');
    }
    if (!db.objectStoreNames.contains('scopeRows')) {
      const scopeRows = db.createObjectStore('scopeRows', {keyPath: ['scope', 'at', 'id']});
      scopeRows.createIndex('byLog', 'logId');
    }
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'key'});
    if (!db.objectStoreNames.contains('backupOutbox')) db.createObjectStore('backupOutbox', {keyPath: 'seq'});
  };
  return requestToPromise(request);
}

function samePayload(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createExecutionLogStore(options = {}) {
  const idb = options.indexedDB || globalThis.indexedDB;
  const keyRange = options.IDBKeyRange || globalThis.IDBKeyRange;
  const dbName = options.dbName || EXECUTION_LOG_DB;
  const storage = options.storage || globalThis.chrome?.storage?.local;
  const durableGet = options.durableGet || persistentDurableGet;
  const durableSet = options.durableSet || persistentDurableSet;
  let dbPromise;
  let chain = Promise.resolve();
  let journalHead = 0;
  let durableCommitted = 0;
  let replayedThrough = 0;
  let pendingCount = 0;
  let legacyDone = false;
  let recovered = false;
  let recoveryPromise;
  let recoveryState = {phase: 'idle', current: 0, total: 0};
  let backupState = {ok: true, pending: 0, head: 0, error: ''};

  function enqueue(task) {
    const run = chain.then(task);
    chain = run.then(() => {}, () => {});
    return run;
  }

  function database() {
    if (!dbPromise) dbPromise = openDatabase(idb, dbName);
    return dbPromise;
  }

  function scopeBound(scope, cursor, since = null) {
    const lower = [scope, since || '', ''];
    const upper = cursor ? [scope, cursor.at, cursor.id] : [scope, '\uffff', '\uffff'];
    return keyRange.bound(lower, upper, false, Boolean(cursor));
  }

  async function readMeta(db, key) {
    const tx = db.transaction('meta', 'readonly');
    const value = await requestToPromise(tx.objectStore('meta').get(key));
    await transactionDone(tx);
    return value;
  }

  async function writeMeta(db, value) {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value);
    await transactionDone(tx);
  }

  async function replaceScopeRows(tx, record) {
    const index = tx.objectStore('scopeRows').index('byLog');
    const existing = await requestToPromise(index.getAll(record.id));
    for (const row of existing) tx.objectStore('scopeRows').delete([row.scope, row.at, row.id]);
    for (const scope of record.membership || []) {
      tx.objectStore('scopeRows').put({scope, at: scopeSortAt(record), id: record.id, logId: record.id});
    }
  }

  function noteBackup(patch) {
    backupState = {...backupState, ...patch, head: durableCommitted, pending: pendingCount};
  }

  async function readCursor(store, range, direction) {
    return new Promise((resolve, reject) => {
      const request = range === undefined ? store.openCursor(null, direction) : store.openCursor(range, direction);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async function firstOutboxItem() {
    const db = await database();
    const tx = db.transaction('backupOutbox', 'readonly');
    const cursor = await readCursor(tx.objectStore('backupOutbox'));
    const item = cursor?.value || null;
    await transactionDone(tx);
    return item;
  }

  async function maxOutboxSeq() {
    const db = await database();
    const tx = db.transaction('backupOutbox', 'readonly');
    const cursor = await readCursor(tx.objectStore('backupOutbox'), undefined, 'prev');
    const seq = Number(cursor?.value?.seq) || 0;
    await transactionDone(tx);
    return seq;
  }

  async function countOutbox() {
    const db = await database();
    const tx = db.transaction('backupOutbox', 'readonly');
    const count = await requestToPromise(tx.objectStore('backupOutbox').count());
    await transactionDone(tx);
    return count;
  }

  async function initHead() {
    const db = await database();
    const localHead = await readMeta(db, 'backupHead');
    const local = Number(localHead?.n) || 0;
    const recovery = await readMeta(db, 'recoveryProgress');
    // A committed local head was written only after the corresponding log
    // transactions. Existing installations can adopt it without replaying.
    // An incomplete rebuild must still check the remote head and resume.
    const localReady = recovery?.done === true || (!recovery && localHead != null);
    let remote = 0;
    if (localReady) remote = local;
    else try {
      remote = Number((await durableGet('executionLogBackupHead'))?.n) || 0;
    } catch (error) {
      throw new Error(error?.message || '执行日志备份头读取失败');
    }
    const outboxMax = await maxOutboxSeq();
    pendingCount = await countOutbox();
    durableCommitted = remote;
    replayedThrough = localReady ? local : Number(recovery?.n) || 0;
    journalHead = Math.max(journalHead, local, remote, outboxMax);
    noteBackup({ok: backupState.ok, error: backupState.error});
  }

  async function publish(item) {
    const key = `executionLogBackupPage:${item.seq}`;
    const existing = await durableGet(key);
    if (existing !== undefined && !samePayload(existing, item.op)) {
      throw new Error(`执行日志备份页 ${item.seq} 已存在且内容不同`);
    }
    const current = Number((await durableGet('executionLogBackupHead'))?.n) || 0;
    if (item.seq > current + 1) throw new Error(`执行日志备份页缺失: ${current + 1}`);
    if (existing === undefined) {
      if (item.seq <= current) throw new Error(`执行日志备份页缺失: ${item.seq}`);
      await durableSet(key, item.op);
    }
    if (item.seq === current + 1) await durableSet('executionLogBackupHead', {n: item.seq});
    const committed = Math.max(current, item.seq === current + 1 ? item.seq : current);
    const db = await database();
    const tx = db.transaction(['backupOutbox', 'meta'], 'readwrite');
    tx.objectStore('backupOutbox').delete(item.seq);
    tx.objectStore('meta').put({key: 'backupHead', n: committed});
    await transactionDone(tx);
    durableCommitted = Math.max(durableCommitted, committed);
    journalHead = Math.max(journalHead, durableCommitted);
    pendingCount = Math.max(0, pendingCount - 1);
    noteBackup({ok: true, error: ''});
  }

  async function rememberFailure(item, error) {
    const db = await database();
    const tx = db.transaction('backupOutbox', 'readwrite');
    tx.objectStore('backupOutbox').put({...item, attempts: item.attempts + 1, error: error?.message || '执行日志备份失败'});
    await transactionDone(tx);
    noteBackup({ok: false, error: error?.message || '执行日志备份失败'});
  }

  async function flushOutbox() {
    let guard = 0;
    while (guard < 10000) {
      guard += 1;
      const item = await firstOutboxItem();
      if (globalThis.__LOG_OUTBOX) console.log('outbox', item);
      if (!item) {
        if (backupState.ok) noteBackup({ok: true, error: ''});
        return;
      }
      if (item.seq > durableCommitted + 1) {
        const error = new Error(`执行日志备份页缺失: ${durableCommitted + 1}`);
        noteBackup({ok: false, error: error.message});
        throw error;
      }
      if (item.seq <= durableCommitted) {
        const db = await database();
        const tx = db.transaction('backupOutbox', 'readwrite');
        tx.objectStore('backupOutbox').delete(item.seq);
        await transactionDone(tx);
        pendingCount = Math.max(0, pendingCount - 1);
        continue;
      }
      if ((item.attempts || 0) >= BACKUP_ATTEMPT_LIMIT) {
        const error = new Error(item.error || '执行日志备份重试已达上限');
        noteBackup({ok: false, error: error.message});
        throw error;
      }
      try {
        await publish(item);
      } catch (error) {
        await rememberFailure(item, error);
        throw error;
      }
    }
  }

  function queueOp(tx, op) {
    const seq = journalHead + 1;
    journalHead = seq;
    pendingCount += 1;
    tx.objectStore('backupOutbox').put({seq, op, attempts: 0});
    noteBackup({});
    return seq;
  }

  async function applyOp(op, sequence) {
    const db = await database();
    const tx = db.transaction(['logs', 'scopeRows', 'meta'], 'readwrite');
    if ((op.op === 'put' || op.op === 'dropScopes') && op.record) {
      const record = upgradeQueueMembership({...op.record});
      assignLogTime(record, op.record.atRaw !== undefined ? op.record.atRaw : op.record.at, 'replay');
      tx.objectStore('logs').put(record);
      await replaceScopeRows(tx, record);
    } else if (op.op === 'delete' && op.id) {
      tx.objectStore('logs').delete(op.id);
      const rows = await requestToPromise(tx.objectStore('scopeRows').index('byLog').getAll(op.id));
      for (const row of rows) tx.objectStore('scopeRows').delete([row.scope, row.at, row.id]);
    }
    // Commit the replay position together with the data it represents.
    tx.objectStore('meta').put({key: 'recoveryProgress', n: sequence, done: false});
    await transactionDone(tx);
  }

  async function replayJournal() {
    const head = durableCommitted;
    if (!head || head <= replayedThrough) return;
    recoveryState = {phase: 'recovering', current: replayedThrough, total: head};
    for (let n = replayedThrough + 1; n <= head; n += 1) {
      const op = await durableGet(`executionLogBackupPage:${n}`);
      if (op == null) throw new Error(`执行日志备份页缺失: ${n}`);
      await applyOp(op, n);
      replayedThrough = n;
      recoveryState = {...recoveryState, current: n};
    }
    replayedThrough = head;
    journalHead = Math.max(journalHead, head);
    const db = await database();
    await writeMeta(db, {key: 'backupHead', n: head});
  }

  function legacyId(origin, index, log) {
    if (log?.id) return String(log.id);
    return `legacy_${origin}_${index}_${log?.at || 'na'}`;
  }

  async function importOrigin(origin, logs) {
    if (!Array.isArray(logs) || !logs.length) return;
    const db = await database();
    const tx = db.transaction(['logs', 'scopeRows'], 'readwrite');
    logs.forEach((log, index) => {
      const record = {
        ...log,
        id: legacyId(origin, index, log),
        origin,
        membership: executionLogMembership({...log, id: legacyId(origin, index, log)}, origin)
      };
      record.scopeSchemaVersion = 3;
      assignLogTime(record, log?.at, 'legacy');
      if (record.scope === 'verification') record.episodeKey = record.episodeKey || (record.tabId != null && record.at ? `${record.tabId}:${record.at}` : '');
      if (!record.episodeKey) delete record.episodeKey;
      tx.objectStore('logs').put(record);
      for (const scope of record.membership) tx.objectStore('scopeRows').put({scope, at: scopeSortAt(record), id: record.id, logId: record.id});
    });
    await transactionDone(tx);
  }

  async function legacyArrays() {
    let saved = null;
    let storageError = null;
    if (storage?.get) {
      try { saved = await storage.get(LEGACY_KEYS); } catch (error) { storageError = error; }
    } else saved = {};
    if (storageError) return {arrays: {}, unavailable: true, storageError};
    const arrays = {};
    let unavailable = false;
    for (const key of LEGACY_KEYS) {
      if (Array.isArray(saved?.[key])) {
        arrays[key] = saved[key];
        continue;
      }
      const present = saved != null && Object.prototype.hasOwnProperty.call(saved, key);
      if (present && saved[key] != null) {
        unavailable = true;
        continue;
      }
      let durableValue;
      try { durableValue = await durableGet(key); } catch { unavailable = true; continue; }
      if (Array.isArray(durableValue)) arrays[key] = durableValue;
      else if (durableValue == null) arrays[key] = [];
      else unavailable = true;
    }
    return {arrays, unavailable, storageError: null};
  }

  async function ensureLegacy() {
    if (legacyDone) return;
    const db = await database();
    const marker = await readMeta(db, 'legacyImport');
    if (marker?.done) {
      legacyDone = true;
      return;
    }
    const imported = new Set(marker?.imported || []);
    const {arrays, unavailable, storageError} = await legacyArrays();
    if (storageError) throw storageError;
    if (unavailable) throw new Error('执行日志旧数据不可用');
    for (const key of LEGACY_KEYS) {
      if (imported.has(key)) continue;
      if (!Array.isArray(arrays[key])) throw new Error('执行日志旧数据导入未完成');
      await importOrigin(key, arrays[key]);
      imported.add(key);
    }
    if (imported.size < LEGACY_KEYS.length) throw new Error('执行日志旧数据导入未完成');
    await writeMeta(db, {key: 'legacyImport', done: true, imported: [...imported], at: new Date().toISOString()});
    legacyDone = true;
  }

  async function cleanupQueueFromFansScopes() {
    const db = await database();
    const marker = await readMeta(db, 'fansQueueDisentangled');
    if (marker?.done) return;
    const read = db.transaction(['logs', 'scopeRows'], 'readonly');
    const scopeRowsStore = read.objectStore('scopeRows');
    const logsStore = read.objectStore('logs');
    const rowsToDelete = [];
    const logsToUpdate = [];
    for (const scope of ['fans', 'monitor']) {
      const rows = await requestToPromise(scopeRowsStore.getAll(scopeBound(scope, null)));
      for (const row of rows) {
        const record = await requestToPromise(logsStore.get(row.logId));
        if (record && record.scope === 'queue') {
          rowsToDelete.push(row);
          if (!logsToUpdate.some(l => l.id === record.id)) {
            const membership = (record.membership || []).filter(m => m !== 'fans' && m !== 'monitor');
            logsToUpdate.push({...record, membership});
          }
        }
      }
    }
    await transactionDone(read);
    if (rowsToDelete.length || logsToUpdate.length) {
      const tx = db.transaction(['logs', 'scopeRows'], 'readwrite');
      const sStore = tx.objectStore('scopeRows');
      const lStore = tx.objectStore('logs');
      for (const r of rowsToDelete) {
        sStore.delete([r.scope, r.at, r.id]);
      }
      for (const l of logsToUpdate) {
        lStore.put(l);
      }
      await transactionDone(tx);
    }
    await writeMeta(db, {key: 'fansQueueDisentangled', done: true, at: new Date().toISOString()});
  }

  async function migrateQueueScope() {
    const db = await database();
    if ((await readMeta(db, 'queueScopeV2'))?.done) return;
    const tx = db.transaction(['logs', 'scopeRows', 'meta'], 'readwrite');
    await new Promise((resolve, reject) => {
      const request = tx.objectStore('logs').openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        const record = upgradeQueueMembership(cursor.value);
        cursor.update(record);
        if (record.membership.includes('queue')) tx.objectStore('scopeRows').put({scope:'queue', at:scopeSortAt(record), id:record.id, logId:record.id});
        cursor.continue();
      };
    });
    tx.objectStore('meta').put({key:'queueScopeV2', done:true});
    await transactionDone(tx);
  }

  async function migrateQueueFansScope() {
    const db = await database();
    if ((await readMeta(db, 'queueFansScopeV1'))?.done) return;
    const tx = db.transaction(['logs', 'scopeRows', 'meta'], 'readwrite');
    await new Promise((resolve, reject) => {
      const request = tx.objectStore('logs').openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        const record = upgradeQueueMembership(cursor.value);
        cursor.update(record);
        if (record.membership.includes('queueFans')) tx.objectStore('scopeRows').put({scope:'queueFans', at:scopeSortAt(record), id:record.id, logId:record.id});
        cursor.continue();
      };
    });
    tx.objectStore('meta').put({key:'queueFansScopeV1', done:true});
    await transactionDone(tx);
  }

  async function ensureRecovered() {
    if (recovered) return;
    if (!recoveryPromise) {
      recoveryPromise = (async () => {
        recoveryState = {phase: 'initializing', current: 0, total: 0};
        await ensureLegacy();
        await initHead();
        await replayJournal();
        await cleanupQueueFromFansScopes();
        await migrateQueueScope();
        await migrateQueueFansScope();
        const db = await database();
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({key: 'backupHead', n: durableCommitted});
        tx.objectStore('meta').put({key: 'recoveryProgress', n: replayedThrough, done: true});
        await transactionDone(tx);
        recovered = true;
        recoveryState = {phase: 'ready', current: replayedThrough, total: replayedThrough};
      })().catch(error => {
        recoveryState = {...recoveryState, phase: 'error'};
        throw error;
      }).finally(() => { recoveryPromise = undefined; });
    }
    await recoveryPromise;
  }

  async function findByEpisode(tx, episodeKey) {
    if (!episodeKey) return null;
    const found = await requestToPromise(tx.objectStore('logs').index('byEpisode').getAll(episodeKey));
    return found?.[0] || null;
  }

  return {
    backupStatus: () => ({...backupState}),
    recoveryStatus: () => ({...recoveryState}),
    ready() {
      return enqueue(async () => {
        await ensureRecovered();
        try { await flushOutbox(); } catch { /* status stays visible; ready does not claim the backup succeeded */ }
      });
    },
    append(entry) {
      return enqueue(async () => {
        await ensureRecovered();
        const db = await database();
        const origin = entry?.origin === 'monitorLogs' || entry?.origin === 'unreciprocatedLogs' ? entry.origin : 'autoFollowLogs';
        const item = {...entry, id: entry?.id || `log_${crypto.randomUUID()}`, origin};
        assignLogTime(item, entry?.at, 'append');
        const episodeKey = item.scope === 'verification' ? (item.episodeKey || (item.tabId != null && item.at ? `${item.tabId}:${item.at}` : '')) : '';
        const tx = db.transaction(['logs', 'scopeRows', 'backupOutbox'], 'readwrite');
        const prior = episodeKey ? await findByEpisode(tx, episodeKey) : null;
        let record;
        if (prior) {
          record = {...prior, ...item, id: prior.id, at: prior.at, episodeKey, origin: prior.origin || origin};
          if (Object.prototype.hasOwnProperty.call(prior, 'atRaw')) record.atRaw = prior.atRaw;
          else delete record.atRaw;
          if (prior.sortAt) record.sortAt = prior.sortAt;
          else delete record.sortAt;
        }
        else {
          record = {...item};
          if (episodeKey) record.episodeKey = episodeKey;
          else delete record.episodeKey;
        }
        record.membership = executionLogMembership(record, record.origin);
        record.scopeSchemaVersion = 3;
        tx.objectStore('logs').put(record);
        await replaceScopeRows(tx, record);
        queueOp(tx, {op: 'put', record});
        await transactionDone(tx);
        try {
          await flushOutbox();
        } catch (error) {
          throw error;
        }
        return {entry: record, backup: {...backupState}};
      });
    },
    query({scope = 'autoFollow', limit = LOG_PAGE_SIZE, cursor = null, since = null} = {}) {
      // Reads share initialization, but never wait for the mutation/backup
      // chain. IndexedDB gives this page a committed, consistent snapshot.
      return (async () => {
        assertLogScope(scope);
        const bound = assertLogCursor(cursor);
        if(since!==null && (typeof since!=='string' || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString()!==since))throw new Error('无效日志时间范围');
        if(bound && since && bound.at<since)throw new Error('日志游标不在查询范围内');
        await ensureRecovered();
        const db = await database();
        const size = Math.max(1, Math.min(50, Number(limit) || LOG_PAGE_SIZE));
        const tx = db.transaction(['scopeRows', 'logs'], 'readonly');
        const rows = [];
        await new Promise((resolve, reject) => {
          const request = tx.objectStore('scopeRows').openCursor(scopeBound(scope, bound, since), 'prev');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const current = request.result;
            if (!current || rows.length > size) { resolve(); return; }
            rows.push(current.value);
            current.continue();
          };
        });
        const count = await requestToPromise(tx.objectStore('scopeRows').count(scopeBound(scope, null, since)));
        const page = rows.slice(0, size);
        const hasMore = rows.length > size;
        const entries = [];
        for (const row of page) {
          const record = await requestToPromise(tx.objectStore('logs').get(row.logId));
          if (record) {
            if ((scope === 'fans' || scope === 'monitor') && record.scope === 'queue') continue;
            entries.push(record);
          }
        }
        await transactionDone(tx);
        const last = page[page.length - 1];
        return {entries, nextCursor: hasMore && last ? {at: last.at, id: last.id} : null, total: count};
      })();
    },
    clear(scope) {
      return enqueue(async () => {
        assertLogScope(scope);
        await ensureRecovered();
        await flushOutbox();
        const scopes = new Set(clearScopesFor(scope));
        const db = await database();
        const removed = [];
        const read = db.transaction(['logs', 'scopeRows'], 'readonly');
        const matching = [];
        for (const name of scopes) matching.push(...await requestToPromise(read.objectStore('scopeRows').getAll(scopeBound(name, null))));
        const ids = [...new Set(matching.map(row => row.logId))];
        for (const id of ids) {
          const record = await requestToPromise(read.objectStore('logs').get(id));
          if (record) removed.push(record);
        }
        await transactionDone(read);
        const archiveKey = `executionLogClearArchive:${new Date().toISOString()}:${crypto.randomUUID()}`;
        const archived = {scope, records: removed};
        const previousArchive = await durableGet(archiveKey);
        if (previousArchive !== undefined) throw new Error('清空归档键已存在');
        await durableSet(archiveKey, archived);
        const tx = db.transaction(['logs', 'scopeRows', 'backupOutbox'], 'readwrite');
        for (const record of removed) {
          const membership = (record.membership || []).filter(name => !scopes.has(name));
          if (!membership.length) {
            tx.objectStore('logs').delete(record.id);
            const rows = await requestToPromise(tx.objectStore('scopeRows').index('byLog').getAll(record.id));
            for (const row of rows) tx.objectStore('scopeRows').delete([row.scope, row.at, row.id]);
          } else {
            const next = {...record, membership};
            tx.objectStore('logs').put(next);
            await replaceScopeRows(tx, next);
          }
        }
        queueOp(tx, {op: 'clearArchive', scope, archiveKey, ids: removed.map(record => record.id)});
        for (const record of removed) {
          const membership = (record.membership || []).filter(name => !scopes.has(name));
          if (!membership.length) queueOp(tx, {op: 'delete', id: record.id});
          else queueOp(tx, {op: 'dropScopes', record: {...record, membership}});
        }
        await transactionDone(tx);
        await flushOutbox();
        return {removed: removed.length, archiveKey, backup: {...backupState}};
      });
    }
  };
}

let defaultStore;
export function getDefaultExecutionLogStore() {
  if (!defaultStore) {
    defaultStore = createExecutionLogStore({
      storage: globalThis.chrome?.storage?.local,
      durableGet: persistentDurableGet,
      durableSet: persistentDurableSet
    });
  }
  return defaultStore;
}

export function resetDefaultExecutionLogStore() {
  defaultStore = undefined;
}

const LOG_COMMANDS = new Set(['appendExecutionLog', 'queryExecutionLogs', 'clearExecutionLogs', 'executionLogStatus']);

export function isExecutionLogSender(sender, runtime = globalThis.chrome?.runtime) {
  if (!sender || !runtime || sender.id !== runtime.id) return false;
  if (sender.tab && !String(sender.url || '').startsWith(runtime.getURL(''))) return false;
  return true;
}

// Background installs this on chrome.runtime.onMessage. The panel already sends these commands.
export function handleExecutionLogRequest(message, sender, sendResponse, store = getDefaultExecutionLogStore(), runtime = globalThis.chrome?.runtime) {
  if (!LOG_COMMANDS.has(message?.cmd)) return false;
  if (!isExecutionLogSender(sender, runtime)) {
    sendResponse({ok: false, error: '仅扩展内部可读写执行日志'});
    return true;
  }
  if (message.cmd === 'executionLogStatus') {
    sendResponse({ok: true, recovery: store.recoveryStatus()});
    return true;
  }
  const run = message.cmd === 'appendExecutionLog' ? store.append(message.entry)
    : message.cmd === 'queryExecutionLogs' ? store.query({scope: message.scope, limit: message.limit, cursor: message.cursor, since: message.since})
    : store.clear(message.scope);
  Promise.resolve(run).then(result => sendResponse({ok: true, ...result}), error => sendResponse({ok: false, error: error?.message || '执行日志读写失败'}));
  return true;
}

export function createLogPager() {
  let generation = 0;
  let stack = [];
  let cursor = null;
  let nextCursor = null;
  return {
    generation: () => generation,
    reset() {
      generation += 1;
      stack = [];
      cursor = null;
      nextCursor = null;
      return generation;
    },
    begin() {
      generation += 1;
      return generation;
    },
    current: token => token === generation,
    cursor: () => cursor,
    notePage(token, page) {
      if (token !== generation) return false;
      nextCursor = page?.nextCursor || null;
      return true;
    },
    canPrev: () => stack.length > 0,
    canNext: () => Boolean(nextCursor),
    forward() {
      if (!nextCursor) return false;
      stack.push(cursor);
      cursor = nextCursor;
      nextCursor = null;
      return true;
    },
    back() {
      if (!stack.length) return false;
      cursor = stack.pop();
      nextCursor = null;
      return true;
    }
  };
}
