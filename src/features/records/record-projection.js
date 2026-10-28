// Dashboard projection. The lossless record archive stays in its own database.
// A normal page reads limit+1 index entries, then only those row payloads.

const DB_VERSION = 5;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('projection request failed'));
  });
}

function install(db) {
  if (!db.objectStoreNames.contains('backupReceipts')) db.createObjectStore('backupReceipts', {keyPath: 'operationId'});
  if (!db.objectStoreNames.contains('rows')) {
    const rows = db.createObjectStore('rows', {keyPath: ['accountId', 'module', 'userKey']});
    rows.createIndex('moduleSort', ['accountId', 'module', 'sortKey', 'userKey'], {unique: true});
    rows.createIndex('byHandle', ['accountId', 'module', 'handle'], {unique: false});
    rows.createIndex('bySource', ['accountId', 'module', 'sourceKey', 'userKey'], {unique: true});
    rows.createIndex('sourceOrder', ['sourceKey', 'accountId', 'module', 'userKey'], {unique: true});
    rows.createIndex('byHandleKey', ['handle', 'module', 'accountId', 'userKey'], {unique: true});
    rows.createIndex('byExternalId', ['sourceKey', 'externalId'], {unique: false});
  }
  if (!db.objectStoreNames.contains('membership')) {
    const membership = db.createObjectStore('membership', {keyPath: ['accountId', 'module', 'tab', 'userKey']});
    membership.createIndex('tabSort', ['accountId', 'module', 'tab', 'sortKey', 'userKey'], {unique: true});
  }
  if (!db.objectStoreNames.contains('relations')) db.createObjectStore('relations', {keyPath: 'handle'});
  if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', {keyPath: ['accountId', 'module']});
  if (!db.objectStoreNames.contains('state')) db.createObjectStore('state', {keyPath: 'id'});
  if (!db.objectStoreNames.contains('backups')) {
    const backups = db.createObjectStore('backups', {keyPath: 'operationId'});
    backups.createIndex('byStatus', 'status', {unique: false});
  }
}

function blankState() {
  return {
    id: 'runtime',
    stage: 'idle',
    completed: 0,
    total: 0,
    migrationId: null,
    fingerprint: null,
    cutover: false,
    dirtyKeys: [],
    echoHashes: {},
    error: null
  };
}

function finish(transaction, work) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('projection transaction aborted'));
    transaction.onerror = () => reject(transaction.error || new Error('projection transaction failed'));
    work(transaction, value => resolve(value), reject);
  });
}

function isClosingError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  return name === 'InvalidStateError' || /closing/i.test(message);
}

export function createRecordProjection({indexedDB: indexedDBImpl, IDBKeyRange: keyRangeImpl, dbName, now = () => Date.now(), blockedTimeoutMs = 5000} = {}) {
  if (!indexedDBImpl || !keyRangeImpl) throw new Error('IndexedDB is required');
  if (!dbName) throw new Error('dbName is required');
  let opening = null;
  let database = null;
  let connectionEpoch = 0;

  function dropConnection(db) {
    if (database && db && database !== db) return;
    database = null;
    opening = null;
    connectionEpoch += 1;
  }

  function bind(db) {
    db.onversionchange = () => {
      try { db.close(); } catch { /* already closing */ }
      dropConnection(db);
    };
    db.onclose = () => {
      dropConnection(db);
    };
  }

  function openOnce() {
    return new Promise((resolve, reject) => {
      let request;
      let finished = false, blockedTimer;
      const fail = error => {
        if (finished) return;
        finished = true; clearTimeout(blockedTimer);
        reject(error || new Error('projection open failed'));
      };
      try {
        request = indexedDBImpl.open(dbName, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (finished) { request.transaction.abort(); return; }
        clearTimeout(blockedTimer); blockedTimer = undefined;
        install(request.result);
        const rows = request.transaction.objectStore('rows');
        if (rows.indexNames.contains('sourceOrder')) rows.deleteIndex('sourceOrder');
        rows.createIndex('sourceOrder', ['sourceKey', 'accountId', 'module', 'userKey'], {unique: true});
        if (!rows.indexNames.contains('byHandleKey')) {
          rows.createIndex('byHandleKey', ['handle', 'module', 'accountId', 'userKey'], {unique: true});
        }
        if (!rows.indexNames.contains('byExternalId')) {
          rows.createIndex('byExternalId', ['sourceKey', 'externalId'], {unique: false});
        }
        const backfill = rows.openCursor();
        backfill.onerror = () => fail(backfill.error || new Error('externalId backfill failed'));
        backfill.onsuccess = () => {
          const cursor = backfill.result;
          if (!cursor) return;
          const value = cursor.value;
          const id = value?.payload?.tweetId ?? value?.payload?.id;
          const posts = value?.module === 'posts' || value?.sourcePath?.[1] === 'posts';
          if (posts && id != null && id !== '' && value.externalId !== String(id)) cursor.update({...value, externalId: String(id)});
          cursor.continue();
        };
      };
      request.onsuccess = () => {
        const db = request.result;
        if (finished) { db.close(); return; }
        finished = true; clearTimeout(blockedTimer);
        bind(db);
        resolve(db);
      };
      request.onerror = () => {
        fail(request.error || new Error('projection open failed'));
      };
      request.onblocked = () => {
        if (!finished && !blockedTimer) blockedTimer = setTimeout(() => fail(new Error('看板数据库升级被旧连接阻塞，请关闭旧看板后重试')), blockedTimeoutMs);
      };
    });
  }

  function open() {
    if (database) return Promise.resolve(database);
    if (!opening) {
      const ticket = connectionEpoch;
      opening = openOnce().then(db => {
        if (ticket !== connectionEpoch) {
          try { db.close(); } catch { /* superseded connection */ }
          throw new Error('projection connection closed');
        }
        database = db;
        opening = null;
        return db;
      }).catch(error => {
        if (ticket === connectionEpoch) opening = null;
        throw error;
      });
    }
    return opening;
  }

  async function begin(storeNames, mode) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const db = await open();
      try {
        return db.transaction(storeNames, mode);
      } catch (error) {
        lastError = error;
        if (attempt === 0 && isClosingError(error)) {
          dropConnection(db);
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error('projection connection closed');
  }

  async function readState() {
    const state = await requestResult((await begin('state', 'readonly')).objectStore('state').get('runtime'));
    return state || blankState();
  }

  async function writeState(patch) {
    const transaction = await begin('state', 'readwrite');
    const store = transaction.objectStore('state');
    const next = await new Promise((resolve, reject) => {
      const getRequest = store.get('runtime');
      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => {
        const saved = {...(getRequest.result || blankState()), ...patch, id: 'runtime', updatedAt: now()};
        store.put(saved);
        resolve(saved);
      };
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return next;
  }

  async function replaceModuleRows(accountId, moduleName, sourceKey, built) {
    const transaction = await begin(['rows', 'membership', 'summaries'], 'readwrite');
    const rows = transaction.objectStore('rows');
    const membership = transaction.objectStore('membership');
    const summaries = transaction.objectStore('summaries');
    await new Promise((resolve, reject) => {
      const range = keyRangeImpl.bound([accountId, moduleName, sourceKey], [accountId, moduleName, sourceKey, []]);
      const request = rows.index('bySource').openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          for (const tab of cursor.value.tabs || []) membership.delete([accountId, moduleName, tab, cursor.value.userKey]);
          cursor.delete();
          cursor.continue();
          return;
        }
        for (const row of built.rows) rows.put(row);
        for (const item of built.membership) membership.put(item);
        const tabs = {};
        const seen = new Set();
        const count = membership.index('tabSort').openCursor(keyRangeImpl.bound([accountId, moduleName], [accountId, moduleName, []]));
        count.onerror = () => reject(count.error);
        count.onsuccess = () => {
          const current = count.result;
          if (current) {
            tabs[current.value.tab] = (tabs[current.value.tab] || 0) + 1;
            seen.add(current.value.userKey);
            current.continue();
            return;
          }
          summaries.put({accountId, module: moduleName, tabs, total: seen.size});
          resolve();
        };
      };
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function putRelations(records, summary) {
    const transaction = await begin(['relations', 'summaries'], 'readwrite');
    const store = transaction.objectStore('relations');
    await new Promise((resolve, reject) => {
      const request = store.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
          return;
        }
        for (const record of records) store.put(record);
        transaction.objectStore('summaries').put(summary);
        resolve();
      };
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function getSummary(accountId, moduleName) {
    return await requestResult((await begin('summaries', 'readonly')).objectStore('summaries').get([accountId, moduleName])) || null;
  }

  async function getRelations(handles) {
    const store = (await begin('relations', 'readonly')).objectStore('relations');
    const records = [];
    for (const handle of handles) {
      const found = await requestResult(store.get(String(handle || '').toLowerCase()));
      if (found) records.push(found);
    }
    return records;
  }

  async function queryPage({accountId, module, tab, limit, cursor, onStep} = {}) {
    const transaction = await begin(['membership', 'rows'], 'readonly');
    const index = transaction.objectStore('membership').index('tabSort');
    const lower = cursor
      ? [accountId, module, tab, cursor.sortKey, cursor.userKey]
      : [accountId, module, tab];
    const range = keyRangeImpl.bound(lower, [accountId, module, tab, []], Boolean(cursor), true);
    const records = [];
    let scanned = 0;
    let resume = null;
    await new Promise((resolve, reject) => {
      const request = index.openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || records.length > limit) {
          resolve();
          return;
        }
        scanned += 1;
        if (onStep) onStep(current.value);
        const item = current.value;
        const getRequest = transaction.objectStore('rows').get([accountId, module, item.userKey]);
        getRequest.onerror = () => reject(getRequest.error);
        getRequest.onsuccess = () => {
          if (getRequest.result && records.length <= limit) records.push(getRequest.result);
          resume = {sortKey: item.sortKey, userKey: item.userKey, tab};
          current.continue();
        };
      };
    });
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    return {
      records: page,
      scanned,
      nextCursor: records.length > limit && last ? {sortKey: last.sortKey, userKey: last.userKey, tab} : null,
      resume
    };
  }

  async function clearSource(sourceKey) {
    const transaction = await begin(['rows', 'membership'], 'readwrite');
    const rows = transaction.objectStore('rows');
    const membership = transaction.objectStore('membership');
    await new Promise((resolve, reject) => {
      const request = rows.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        if (cursor.value.sourceKey === sourceKey) {
          for (const tab of cursor.value.tabs || []) membership.delete([cursor.value.accountId, cursor.value.module, tab, cursor.value.userKey]);
          cursor.delete();
        }
        cursor.continue();
      };
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function scanBatches({accountId, module, tab, limit, cursor, match, shouldStop, onStep, maxScan = 200} = {}) {
    const transaction = await begin(['membership', 'rows'], 'readonly');
    const index = transaction.objectStore('membership').index('tabSort');
    const lower = cursor
      ? [accountId, module, tab, cursor.sortKey, cursor.userKey]
      : [accountId, module, tab];
    const range = keyRangeImpl.bound(lower, [accountId, module, tab, []], Boolean(cursor), true);
    const records = [];
    let scanned = 0;
    let resume = null;
    let done = true;
    await new Promise((resolve, reject) => {
      const request = index.openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || shouldStop?.() || scanned >= maxScan) {
          done = !current;
          resolve();
          return;
        }
        scanned += 1;
        if (onStep) onStep(current.value);
        const item = current.value;
        const getRequest = transaction.objectStore('rows').get([accountId, module, item.userKey]);
        getRequest.onerror = () => reject(getRequest.error);
        getRequest.onsuccess = () => {
          const row = getRequest.result;
          resume = {sortKey: item.sortKey, userKey: item.userKey, tab};
          if (row && match(row) && records.length < limit) records.push(row);
          if (records.length >= limit) {
            done = false;
            resolve();
            return;
          }
          current.continue();
        };
      };
    });
    return {records, scanned, nextCursor: done ? null : resume, done};
  }

  async function getRow(accountId, module, userKey) {
    return await requestResult((await begin('rows', 'readonly')).objectStore('rows').get([accountId, module, userKey])) || null;
  }

  async function rowsByHandle(accountId, module, handles) {
    const found = await rowsByHandleAll(accountId, module, handles);
    return found.map(group => group[0]).filter(Boolean);
  }

  async function rowsByHandleAll(accountId, module, handles) {
    const index = (await begin('rows', 'readonly')).objectStore('rows').index('byHandle');
    const groups = [];
    for (const handle of handles) {
      const found = await requestResult(index.getAll([accountId, module, String(handle || '').toLowerCase()]));
      if (found?.length) groups.push(found);
    }
    return groups;
  }

  async function upsertRelation(record) {
    const transaction = await begin(['relations', 'summaries'], 'readwrite');
    const store = transaction.objectStore('relations');
    const previous = await requestResult(store.get(record.handle));
    store.put(record);
    const summaries = transaction.objectStore('summaries');
    const summary = await requestResult(summaries.get(['unassigned', 'relations'])) || {
      accountId: 'unassigned', module: 'relations', tabs: {}, total: 0
    };
    const bump = (name, before, after) => {
      if (Boolean(before) === Boolean(after)) return;
      summary.tabs[name] = Math.max(0, (summary.tabs[name] || 0) + (after ? 1 : -1));
    };
    bump('followers', previous?.follower, record.follower);
    bump('following', previous?.following, record.following);
    bump('notMutual', previous?.notMutual, record.notMutual);
    if (!previous) summary.total += 1;
    summaries.put(summary);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function rowsByHandleKey(handle) {
    const index = (await begin('rows', 'readonly')).objectStore('rows').index('byHandleKey');
    const key = String(handle || '').toLowerCase();
    const range = keyRangeImpl.bound([key], [key, []]);
    return await requestResult(index.getAll(range)) || [];
  }

  async function deleteRelation(handle) {
    const transaction = await begin(['relations', 'summaries'], 'readwrite');
    const store = transaction.objectStore('relations');
    const previous = await requestResult(store.get(handle));
    if (previous) store.delete(handle);
    const summaries = transaction.objectStore('summaries');
    const summary = await requestResult(summaries.get(['unassigned', 'relations']));
    if (previous && summary) {
      const drop = (name, before) => {
        if (!before) return;
        summary.tabs[name] = Math.max(0, (summary.tabs[name] || 0) - 1);
      };
      drop('followers', previous.follower);
      drop('following', previous.following);
      drop('notMutual', previous.notMutual);
      summary.total = Math.max(0, (summary.total || 0) - 1);
      summaries.put(summary);
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function scanBySource({sourceKey, limit, cursor} = {}) {
    const index = (await begin('rows', 'readonly')).objectStore('rows').index('sourceOrder');
    const lower = cursor
      ? [sourceKey, cursor.accountId, cursor.module, cursor.userKey]
      : [sourceKey];
    const range = keyRangeImpl.bound(lower, [sourceKey, []], Boolean(cursor), true);
    const records = [];
    await new Promise((resolve, reject) => {
      const request = index.openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || records.length > limit) { resolve(); return; }
        records.push(current.value);
        current.continue();
      };
    });
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    return {
      records: page,
      nextCursor: records.length > limit && last
        ? {accountId: last.accountId, module: last.module, userKey: last.userKey}
        : null
    };
  }

  async function getBackup(operationId) {
    const entry = await requestResult((await begin('backups', 'readonly')).objectStore('backups').get(operationId));
    if (entry) return entry;
    const receipt = await requestResult((await begin('backupReceipts', 'readonly')).objectStore('backupReceipts').get(operationId));
    if (!receipt) return null;
    const result = receipt.result;
    if (result?.userKey && result?.module) {
      const row = await getRow(result.accountId || 'unassigned', result.module, result.userKey);
      if (row) return {...receipt, result: {...result, payload: row.payload}};
    }
    return receipt;
  }

  async function compactBackups(through) {
    const tx = await begin(['backups', 'backupReceipts'], 'readwrite');
    let deleted = 0;
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('local backup compaction failed'));
      const request = tx.objectStore('backups').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const entry = cursor.value;
        if (entry.status === 'stored' && entry.seq <= through) {
          const {payload, ...result} = entry.result || {};
          tx.objectStore('backupReceipts').put({operationId: entry.operationId, status: 'stored', seq: entry.seq, result, compacted: true});
          cursor.delete(); deleted++;
        }
        cursor.continue();
      };
    });
    return deleted;
  }

  async function putBackup(entry) {
    const transaction = await begin('backups', 'readwrite');
    transaction.objectStore('backups').put(entry);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return entry;
  }

  async function pendingBackups(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('pending backup limit must be an integer from 1 to 100');
    const index = (await begin('backups', 'readonly')).objectStore('backups').index('byStatus');
    const records = [];
    await new Promise((resolve, reject) => {
      const request = index.openCursor(keyRangeImpl.only('pending'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length >= limit) { resolve(); return; }
        records.push(cursor.value);
        cursor.continue();
      };
    });
    return records;
  }

  async function rowsByExternalId(sourceKey, externalId) {
    const index = (await begin('rows', 'readonly')).objectStore('rows').index('byExternalId');
    return await requestResult(index.getAll([sourceKey, String(externalId)])) || [];
  }

  async function commitWithBackup(previousKey, next, backup) {
    const transaction = await begin(['rows', 'membership', 'summaries', 'backups', 'state'], 'readwrite');
    if (backup?.sourceKey === 'monitor' && backup.handle) {
      const stateStore = transaction.objectStore('state');
      const stateRequest = stateStore.get('runtime');
      stateRequest.onsuccess = () => {
        const state = stateRequest.result || blankState();
        state.fanDirectoryDirtyHandles = [...new Set([...(state.fanDirectoryDirtyHandles || []), String(backup.handle).toLowerCase(), ...(backup.previousHandle ? [String(backup.previousHandle).toLowerCase()] : [])])];
        stateStore.put(state);
      };
    }
    const rowStore = transaction.objectStore('rows');
    const membership = transaction.objectStore('membership');
    const summaries = transaction.objectStore('summaries');
    await new Promise((resolve, reject) => {
      const load = previousKey ? rowStore.get(previousKey) : null;
      const apply = previous => {
        if (previous) {
          for (const tab of previous.tabs || []) membership.delete([previous.accountId, previous.module, tab, previous.userKey]);
          if (!next) rowStore.delete(previousKey);
        }
        if (next) {
          rowStore.put(next.row);
          for (const item of next.membership) membership.put(item);
        }
        if (!previous && !next) {
          if (backup) transaction.objectStore('backups').put(backup);
          resolve();
          return;
        }
        const accountId = (next?.row || previous).accountId;
        const moduleName = (next?.row || previous).module;
        const summaryRequest = summaries.get([accountId, moduleName]);
        summaryRequest.onerror = () => reject(summaryRequest.error);
        summaryRequest.onsuccess = () => {
          const summary = summaryRequest.result || {accountId, module: moduleName, tabs: {}, total: 0};
          for (const tab of previous?.tabs || []) summary.tabs[tab] = Math.max(0, (summary.tabs[tab] || 0) - 1);
          if (previous) summary.total = Math.max(0, summary.total - 1);
          for (const tab of next?.row.tabs || []) summary.tabs[tab] = (summary.tabs[tab] || 0) + 1;
          if (next) summary.total += 1;
          summaries.put(summary);
          if (backup) transaction.objectStore('backups').put(backup);
          resolve();
        };
      };
      if (!load) {
        apply(null);
        return;
      }
      load.onerror = () => reject(load.error);
      load.onsuccess = () => apply(load.result || null);
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function mutateRow(next, previousKey) {
    const transaction = await begin(['rows', 'membership', 'summaries'], 'readwrite');
    const rowStore = transaction.objectStore('rows');
    const membership = transaction.objectStore('membership');
    const summaries = transaction.objectStore('summaries');
    await new Promise((resolve, reject) => {
      const load = previousKey ? rowStore.get(previousKey) : null;
      const apply = previous => {
        if (previous) {
          for (const tab of previous.tabs || []) membership.delete([previous.accountId, previous.module, tab, previous.userKey]);
          if (!next) rowStore.delete(previousKey);
        }
        if (next) {
          rowStore.put(next.row);
          for (const item of next.membership) membership.put(item);
        }
        const accountId = (next?.row || previous).accountId;
        const moduleName = (next?.row || previous).module;
        const summaryRequest = summaries.get([accountId, moduleName]);
        summaryRequest.onerror = () => reject(summaryRequest.error);
        summaryRequest.onsuccess = () => {
          const summary = summaryRequest.result || {accountId, module: moduleName, tabs: {}, total: 0};
          for (const tab of previous?.tabs || []) summary.tabs[tab] = Math.max(0, (summary.tabs[tab] || 0) - 1);
          if (previous) summary.total = Math.max(0, summary.total - 1);
          for (const tab of next?.row.tabs || []) summary.tabs[tab] = (summary.tabs[tab] || 0) + 1;
          if (next) summary.total += 1;
          summaries.put(summary);
          resolve();
        };
      };
      if (!load) {
        apply(null);
        return;
      }
      load.onerror = () => reject(load.error);
      load.onsuccess = () => apply(load.result || null);
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  const snapshotStores = ['rows', 'membership', 'relations', 'summaries', 'state'];
  async function exportSnapshot() {
    const tx = await begin(snapshotStores, 'readonly');
    const result = {};
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('snapshot read failed'));
      for (const name of snapshotStores) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { result[name] = request.result; };
      }
    });
    return result;
  }

  async function importSnapshot(image) {
    if (snapshotStores.some(name => !Array.isArray(image?.[name]))) throw new Error('incomplete snapshot');
    const tx = await begin(snapshotStores, 'readwrite');
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('snapshot restore failed'));
      for (const name of snapshotStores) {
        const store = tx.objectStore(name);
        store.clear();
        for (const row of image[name]) store.put(row);
      }
    });
  }

  async function close() { const db = await open(); db.close(); dropConnection(db); }

  return {
    open, close, exportSnapshot, importSnapshot, readState, writeState, replaceModuleRows, putRelations, upsertRelation, getSummary, getRelations,
    queryPage, scanBatches, scanBySource, getRow, rowsByHandle, rowsByHandleAll, rowsByHandleKey,
    mutateRow, commitWithBackup, clearSource, deleteRelation,
    getBackup, putBackup, pendingBackups, rowsByExternalId, compactBackups
  };
}
