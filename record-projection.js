// Dashboard projection. The lossless record archive stays in its own database.
// A normal page reads limit+1 index entries, then only those row payloads.

const DB_VERSION = 4;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('projection request failed'));
  });
}

function install(db) {
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

export function createRecordProjection({indexedDB: indexedDBImpl, IDBKeyRange: keyRangeImpl, dbName, now = () => Date.now()} = {}) {
  if (!indexedDBImpl || !keyRangeImpl) throw new Error('IndexedDB is required');
  if (!dbName) throw new Error('dbName is required');
  let opening = null;
  let database = null;

  function open() {
    if (database) return Promise.resolve(database);
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
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
        backfill.onerror = () => { opening = null; reject(backfill.error || new Error('externalId backfill failed')); };
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
        database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => {
        opening = null;
        reject(request.error || new Error('projection open failed'));
      };
    });
    return opening;
  }

  async function readState() {
    const db = await open();
    const state = await requestResult(db.transaction('state', 'readonly').objectStore('state').get('runtime'));
    return state || blankState();
  }

  async function writeState(patch) {
    const db = await open();
    const transaction = db.transaction('state', 'readwrite');
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
    const db = await open();
    const transaction = db.transaction(['rows', 'membership', 'summaries'], 'readwrite');
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
    const db = await open();
    const transaction = db.transaction(['relations', 'summaries'], 'readwrite');
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
    const db = await open();
    return await requestResult(db.transaction('summaries', 'readonly').objectStore('summaries').get([accountId, moduleName])) || null;
  }

  async function getRelations(handles) {
    const db = await open();
    const store = db.transaction('relations', 'readonly').objectStore('relations');
    const records = [];
    for (const handle of handles) {
      const found = await requestResult(store.get(String(handle || '').toLowerCase()));
      if (found) records.push(found);
    }
    return records;
  }

  async function queryPage({accountId, module, tab, limit, cursor, onStep} = {}) {
    const db = await open();
    const transaction = db.transaction(['membership', 'rows'], 'readonly');
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
    const db = await open();
    const transaction = db.transaction(['rows', 'membership'], 'readwrite');
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
    const db = await open();
    const transaction = db.transaction(['membership', 'rows'], 'readonly');
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
    const db = await open();
    return await requestResult(db.transaction('rows', 'readonly').objectStore('rows').get([accountId, module, userKey])) || null;
  }

  async function rowsByHandle(accountId, module, handles) {
    const found = await rowsByHandleAll(accountId, module, handles);
    return found.map(group => group[0]).filter(Boolean);
  }

  async function rowsByHandleAll(accountId, module, handles) {
    const db = await open();
    const index = db.transaction('rows', 'readonly').objectStore('rows').index('byHandle');
    const groups = [];
    for (const handle of handles) {
      const found = await requestResult(index.getAll([accountId, module, String(handle || '').toLowerCase()]));
      if (found?.length) groups.push(found);
    }
    return groups;
  }

  async function upsertRelation(record) {
    const db = await open();
    const transaction = db.transaction(['relations', 'summaries'], 'readwrite');
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
    const db = await open();
    const index = db.transaction('rows', 'readonly').objectStore('rows').index('byHandleKey');
    const key = String(handle || '').toLowerCase();
    const range = keyRangeImpl.bound([key], [key, []]);
    return await requestResult(index.getAll(range)) || [];
  }

  async function deleteRelation(handle) {
    const db = await open();
    const transaction = db.transaction(['relations', 'summaries'], 'readwrite');
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
    const db = await open();
    const index = db.transaction('rows', 'readonly').objectStore('rows').index('sourceOrder');
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
    const db = await open();
    return await requestResult(db.transaction('backups', 'readonly').objectStore('backups').get(operationId)) || null;
  }

  async function putBackup(entry) {
    const db = await open();
    const transaction = db.transaction('backups', 'readwrite');
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
    const db = await open();
    const index = db.transaction('backups', 'readonly').objectStore('backups').index('byStatus');
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
    const db = await open();
    const index = db.transaction('rows', 'readonly').objectStore('rows').index('byExternalId');
    return await requestResult(index.getAll([sourceKey, String(externalId)])) || [];
  }

  async function commitWithBackup(previousKey, next, backup) {
    const db = await open();
    const transaction = db.transaction(['rows', 'membership', 'summaries', 'backups'], 'readwrite');
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
    const db = await open();
    const transaction = db.transaction(['rows', 'membership', 'summaries'], 'readwrite');
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

  return {
    open, readState, writeState, replaceModuleRows, putRelations, upsertRelation, getSummary, getRelations,
    queryPage, scanBatches, scanBySource, getRow, rowsByHandle, rowsByHandleAll, rowsByHandleKey,
    mutateRow, commitWithBackup, clearSource, deleteRelation,
    getBackup, putBackup, pendingBackups, rowsByExternalId
  };
}
