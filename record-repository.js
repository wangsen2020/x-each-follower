// Extension-origin record store. Not wired to panel, background, or migration runtime.

export const RECORD_DB_VERSION = 1;
export const RECORD_PAGE_MAX = 100;
export const RECORD_DB_NAME = 'x-each-follower-records';
export const RECORD_OPEN_BLOCKED_MS = 3000;

const STORES = ['meta', 'records', 'tombstones', 'summaries', 'outbox', 'migrations', 'migrationManifests'];

export class RecordCursorInvalidError extends Error {
  constructor(message) {
    super(message || 'record cursor is no longer valid');
    this.name = 'RecordCursorInvalidError';
    this.code = 'cursor-invalid';
  }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireId(value, label) {
  if (typeof value === 'number' || typeof value === 'bigint') throw new Error(`${label} must be a string`);
  return requireText(value, label);
}

function requireGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('generation must be a positive integer');
  return value;
}

function indexText(value, label) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function storageKey(accountId, moduleName, generation, userKey) {
  return [accountId, moduleName, generation, userKey];
}

function summaryKey(accountId, moduleName, generation) {
  return [accountId, moduleName, generation];
}

function generationMaps(meta) {
  if (!meta.generationRevisions || typeof meta.generationRevisions !== 'object') meta.generationRevisions = {};
  if (!meta.sealedGenerations || typeof meta.sealedGenerations !== 'object') meta.sealedGenerations = {};
  return meta;
}

export function canonicalValue(value) {
  if (value === undefined) throw new Error('canonical value cannot be undefined');
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('canonical value is not supported');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalValue(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

async function finish(tx, work) {
  const done = transactionDone(tx);
  try {
    const result = await work();
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted */ }
    await done.catch(() => {});
    throw error;
  }
}

function filterHash(filter) {
  if (filter == null) return JSON.stringify({status: null});
  if (typeof filter !== 'object' || Array.isArray(filter)) throw new Error('filter must be an object');
  const keys = Object.keys(filter);
  if (keys.some(key => key !== 'status')) throw new Error('unsupported filter');
  const status = filter.status == null || filter.status === '' ? null : indexText(filter.status, 'status');
  return JSON.stringify({status});
}

function encodeCursor(payload) {
  return JSON.stringify(payload);
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') throw new RecordCursorInvalidError('cursor must be a string');
  try {
    const parsed = JSON.parse(cursor);
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.last)) throw new RecordCursorInvalidError();
    return parsed;
  } catch (error) {
    if (error instanceof RecordCursorInvalidError) throw error;
    throw new RecordCursorInvalidError('cursor is not valid JSON');
  }
}

function validateCursorTuple(last, {account, module, generation, status}) {
  const expected = status == null ? 5 : 6;
  if (last.length !== expected) throw new RecordCursorInvalidError('cursor tuple length is invalid');
  if (typeof last[0] !== 'string' || typeof last[1] !== 'string') throw new RecordCursorInvalidError('cursor tuple scope is invalid');
  if (!Number.isSafeInteger(last[2])) throw new RecordCursorInvalidError('cursor tuple generation is invalid');
  if (last[0] !== account || last[1] !== module || last[2] !== generation) {
    throw new RecordCursorInvalidError('cursor tuple scope does not match');
  }
  if (status == null) {
    if (typeof last[3] !== 'string' || typeof last[4] !== 'string') throw new RecordCursorInvalidError('cursor tuple types are invalid');
    return;
  }
  if (typeof last[3] !== 'string' || last[3] !== status || typeof last[4] !== 'string' || typeof last[5] !== 'string') {
    throw new RecordCursorInvalidError('cursor tuple types are invalid');
  }
}

function bound(KeyRange, lower, upper, lowerOpen = false, upperOpen = true) {
  return KeyRange.bound(lower, upper, lowerOpen, upperOpen);
}

function blankMeta(accountId) {
  return {
    accountId,
    schemaVersion: RECORD_DB_VERSION,
    activeGeneration: 1,
    nextGeneration: 1,
    revision: 0
  };
}

function installSchema(db) {
  if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'accountId'});
  if (!db.objectStoreNames.contains('records')) {
    const records = db.createObjectStore('records', {keyPath: 'storageKey'});
    records.createIndex('scopeSort', ['accountId', 'module', 'generation', 'sortKey', 'userKey'], {unique: true});
    records.createIndex('scopeStatusSort', ['accountId', 'module', 'generation', 'status', 'sortKey', 'userKey'], {unique: true});
    records.createIndex('accountGeneration', ['accountId', 'generation', 'module', 'userKey'], {unique: true});
  }
  if (!db.objectStoreNames.contains('tombstones')) {
    const tombstones = db.createObjectStore('tombstones', {keyPath: 'storageKey'});
    tombstones.createIndex('accountGeneration', ['accountId', 'generation', 'module', 'userKey'], {unique: true});
  }
  if (!db.objectStoreNames.contains('summaries')) {
    const summaries = db.createObjectStore('summaries', {keyPath: 'storageKey'});
    summaries.createIndex('accountModule', ['accountId', 'module', 'generation'], {unique: true});
  }
  if (!db.objectStoreNames.contains('outbox')) {
    const outbox = db.createObjectStore('outbox', {keyPath: 'operationId'});
    outbox.createIndex('accountModuleRevision', ['accountId', 'module', 'revision'], {unique: false});
  }
  if (!db.objectStoreNames.contains('migrations')) db.createObjectStore('migrations', {keyPath: 'migrationId'});
  if (!db.objectStoreNames.contains('migrationManifests')) db.createObjectStore('migrationManifests', {keyPath: 'migrationId'});
}

export function createRecordRepository({
  indexedDB: indexedDBImpl,
  IDBKeyRange: keyRangeImpl,
  dbName = RECORD_DB_NAME,
  now = () => Date.now(),
  blockedTimeoutMs = RECORD_OPEN_BLOCKED_MS
} = {}) {
  const factory = indexedDBImpl || globalThis.indexedDB;
  const KeyRange = keyRangeImpl || globalThis.IDBKeyRange;
  if (!factory || !KeyRange) throw new Error('IndexedDB is unavailable');
  let connection = null;
  let opening = null;

  function bind(db) {
    db.onversionchange = () => {
      try { db.close(); } catch { /* already closing */ }
      if (connection === db) connection = null;
    };
    db.onclose = () => {
      if (connection === db) connection = null;
    };
  }

  function openOnce() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = factory.open(dbName, RECORD_DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      let finished = false;
      let blockedTimer = null;
      const fail = error => {
        if (finished) return;
        finished = true;
        if (blockedTimer) clearTimeout(blockedTimer);
        reject(error instanceof Error ? error : new Error('IndexedDB open failed'));
      };
      request.onupgradeneeded = () => installSchema(request.result);
      request.onsuccess = () => {
        if (finished) {
          try { request.result?.close(); } catch { /* late success after blocked timeout */ }
          return;
        }
        finished = true;
        if (blockedTimer) clearTimeout(blockedTimer);
        const db = request.result;
        bind(db);
        resolve(db);
      };
      request.onerror = event => {
        event?.preventDefault?.();
        fail(request.error || new Error('IndexedDB open failed'));
      };
      request.onblocked = () => {
        if (finished || blockedTimer) return;
        blockedTimer = setTimeout(() => fail(new Error('IndexedDB open blocked')), blockedTimeoutMs);
      };
    });
  }

  function open() {
    if (connection) return Promise.resolve(connection);
    if (!opening) {
      opening = openOnce().then(db => {
        connection = db;
        opening = null;
        return db;
      }).catch(error => {
        opening = null;
        throw error;
      });
    }
    return opening;
  }

  async function close() {
    const pending = opening;
    const current = connection;
    connection = null;
    opening = null;
    if (current) {
      try { current.close(); } catch { /* already closed */ }
    }
    if (pending) {
      try {
        const db = await pending;
        try { db.close(); } catch { /* already closed */ }
      } catch { /* open failed */ }
    }
  }

  async function read(storeNames, fn) {
    const db = await open();
    const tx = db.transaction(storeNames, 'readonly');
    return finish(tx, () => fn(tx));
  }

  function write(work) {
    return open().then(db => {
      const tx = db.transaction(STORES, 'readwrite');
      return finish(tx, () => work(tx));
    });
  }

  async function resolveGeneration(tx, account, requested) {
    const metaStore = tx.objectStore('meta');
    const meta = await requestResult(metaStore.get(account)) || blankMeta(account);
    const generation = requested == null ? meta.activeGeneration : requireGeneration(requested);
    if (generation > meta.nextGeneration) throw new Error('generation is not allocated');
    return {metaStore, meta, generation};
  }

  async function getMeta(accountId) {
    const account = requireId(accountId, 'accountId');
    const meta = await read('meta', tx => requestResult(tx.objectStore('meta').get(account)));
    return meta ? publicMeta(meta) : null;
  }

  async function getSummary(accountId, moduleName, options = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    const summary = await read(['meta', 'summaries'], async tx => {
      const meta = await requestResult(tx.objectStore('meta').get(account));
      const generation = options.generation == null ? (meta?.activeGeneration || 1) : requireGeneration(options.generation);
      return requestResult(tx.objectStore('summaries').get(summaryKey(account, module, generation)));
    });
    return summary ? publicSummary(summary) : null;
  }

  async function getRecord(accountId, moduleName, userKey, options = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    const id = requireId(userKey, 'userKey');
    const record = await read(['meta', 'records'], async tx => {
      const meta = await requestResult(tx.objectStore('meta').get(account));
      const generation = options.generation == null ? (meta?.activeGeneration || 1) : requireGeneration(options.generation);
      return requestResult(tx.objectStore('records').get(storageKey(account, module, generation, id)));
    });
    return record ? publicRecord(record) : null;
  }

  async function getTombstone(accountId, moduleName, userKey, options = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    const id = requireId(userKey, 'userKey');
    const record = await read(['meta', 'tombstones'], async tx => {
      const meta = await requestResult(tx.objectStore('meta').get(account));
      const generation = options.generation == null ? (meta?.activeGeneration || 1) : requireGeneration(options.generation);
      return requestResult(tx.objectStore('tombstones').get(storageKey(account, module, generation, id)));
    });
    return record ? publicRecord(record) : null;
  }

  async function getOutbox(operationId) {
    const id = requireText(operationId, 'operationId');
    const entry = await read('outbox', tx => requestResult(tx.objectStore('outbox').get(id)));
    return entry ? publicOutbox(entry) : null;
  }

  async function getCheckpoint(migrationId) {
    const id = requireText(migrationId, 'migrationId');
    const checkpoint = await read('migrations', tx => requestResult(tx.objectStore('migrations').get(id)));
    return checkpoint ? clone(checkpoint) : null;
  }

  async function getManifest(migrationId) {
    const id = requireText(migrationId, 'migrationId');
    const manifest = await read('migrationManifests', tx => requestResult(tx.objectStore('migrationManifests').get(id)));
    return manifest ? clone(manifest) : null;
  }

  async function getMigration(migrationId) {
    const id = requireText(migrationId, 'migrationId');
    return read(['migrations', 'migrationManifests'], async tx => {
      const checkpoint = await requestResult(tx.objectStore('migrations').get(id));
      if (!checkpoint) return null;
      const manifest = await requestResult(tx.objectStore('migrationManifests').get(id));
      return {...clone(manifest), ...clone(checkpoint)};
    });
  }

  async function applyOperation(tx, {accountId, moduleName, generation, operationId, type, content, mutate}) {
    const outbox = tx.objectStore('outbox');
    const prior = await requestResult(outbox.get(operationId));
    if (prior) {
      if (prior.accountId !== accountId) throw new Error('operationId belongs to another account');
      if (prior.module !== moduleName) throw new Error('operationId belongs to another module');
      if (prior.type !== type) throw new Error('operationId type does not match');
      if (prior.content !== content) throw new Error('operationId content does not match');
      return clone(prior.result);
    }
    const resolved = await resolveGeneration(tx, accountId, generation);
    const {metaStore, meta} = resolved;
    const targetGeneration = resolved.generation;
    generationMaps(meta);
    const generationKey = String(targetGeneration);
    if (Object.prototype.hasOwnProperty.call(meta.sealedGenerations, generationKey)) throw new Error('generation is sealed');
    const active = targetGeneration === meta.activeGeneration;
    if (active) meta.revision += 1;
    meta.generationRevisions[generationKey] = (meta.generationRevisions[generationKey] || 0) + 1;
    const revision = active ? meta.revision : (meta.revision || 0);
    const summaries = tx.objectStore('summaries');
    const key = summaryKey(accountId, moduleName, targetGeneration);
    const summary = await requestResult(summaries.get(key)) || {
      storageKey: key,
      accountId,
      module: moduleName,
      generation: targetGeneration,
      count: 0
    };
    const records = await mutate({meta, summary, revision, generation: targetGeneration});
    summary.revision = revision;
    summary.generation = targetGeneration;
    summary.updatedAt = now();
    await requestResult(metaStore.put(meta));
    await requestResult(summaries.put(summary));
    const result = {
      operationId,
      accountId,
      module: moduleName,
      revision,
      generation: targetGeneration,
      summary: publicSummary(summary),
      records
    };
    await requestResult(outbox.put({
      operationId,
      type,
      content,
      accountId,
      module: moduleName,
      revision,
      generation: targetGeneration,
      at: now(),
      recordIds: records.map(record => record.userKey),
      result
    }));
    return result;
  }

  function recordParts(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('record must be an object');
    if (input.envelope === true) {
      if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('payload must be an object');
      return {payload: clone(input.payload), userKey: requireId(input.userKey, 'userKey'), sortKey: input.sortKey, status: input.status, scope: input.scope, sourcePath: clone(input.sourcePath)};
    }
    return {
      payload: clone(input),
      userKey: requireId(input.userKey ?? input.id, 'userKey'),
      sortKey: input.sortKey,
      status: input.status,
      scope: input.scope,
      sourcePath: clone(input.sourcePath)
    };
  }

  async function putRecords({accountId, module: moduleName, records, operationId, summaryPatch, generation} = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    const op = requireText(operationId, 'operationId');
    if (!Array.isArray(records) || records.length === 0) throw new Error('records must be a non-empty array');
    const patch = summaryPatch == null ? null : clone(summaryPatch);
    if (patch && (typeof patch !== 'object' || Array.isArray(patch))) throw new Error('summaryPatch must be an object');
    const content = canonicalValue({type: 'put', accountId: account, module, generation: generation ?? null, summaryPatch: patch, records});
    return write(tx => applyOperation(tx, {
      accountId: account,
      moduleName: module,
      generation,
      operationId: op,
      type: 'put',
      content,
      mutate: async ({summary, generation: targetGeneration}) => {
        const recordStore = tx.objectStore('records');
        const tombstones = tx.objectStore('tombstones');
        const saved = [];
        for (const input of records) {
          const parts = recordParts(input);
          if (input.accountId != null && input.accountId !== account) throw new Error('record accountId does not match');
          if (input.module != null && input.module !== module) throw new Error('record module does not match');
          const key = storageKey(account, module, targetGeneration, parts.userKey);
          const previous = await requestResult(recordStore.get(key));
          const tombstone = await requestResult(tombstones.get(key));
          const payload = {...(previous?.payload || tombstone?.payload || {}), ...parts.payload};
          const stored = {
            storageKey: key,
            accountId: account,
            module,
            generation: targetGeneration,
            userKey: parts.userKey,
            sortKey: indexText(parts.sortKey ?? previous?.sortKey, 'sortKey'),
            status: indexText(parts.status ?? previous?.status, 'status'),
            scope: typeof parts.scope === 'string' ? parts.scope : (previous?.scope || tombstone?.scope || ''),
            sourcePath: Array.isArray(parts.sourcePath) ? parts.sourcePath : (previous?.sourcePath || tombstone?.sourcePath || null),
            payload
          };
          await requestResult(recordStore.put(stored));
          if (tombstone) await requestResult(tombstones.delete(key));
          if (!previous) summary.count += 1;
          saved.push(publicRecord(stored));
        }
        if (patch) {
          const reserved = new Set(['storageKey', 'accountId', 'module', 'count', 'revision', 'generation', 'updatedAt']);
          for (const [field, value] of Object.entries(patch)) {
            if (!reserved.has(field)) summary[field] = value;
          }
        }
        return saved;
      }
    }));
  }

  async function deleteRecords({accountId, module: moduleName, userKeys, operationId, generation} = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    const op = requireText(operationId, 'operationId');
    if (!Array.isArray(userKeys) || userKeys.length === 0) throw new Error('userKeys must be a non-empty array');
    const ids = userKeys.map(userKey => requireId(userKey, 'userKey'));
    const content = canonicalValue({type: 'delete', accountId: account, module, generation: generation ?? null, userKeys: ids});
    return write(tx => applyOperation(tx, {
      accountId: account,
      moduleName: module,
      generation,
      operationId: op,
      type: 'delete',
      content,
      mutate: async ({summary, revision, generation: targetGeneration}) => writeTombstones(tx, {
        account, module, ids, summary, revision, generation: targetGeneration, payloads: new Map()
      })
    }));
  }

  async function putTombstones({accountId, module: moduleName, records, operationId, generation} = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    const op = requireText(operationId, 'operationId');
    if (!Array.isArray(records) || records.length === 0) throw new Error('records must be a non-empty array');
    const parts = records.map(recordParts);
    const content = canonicalValue({type: 'tombstone', accountId: account, module, generation: generation ?? null, records});
    return write(tx => applyOperation(tx, {
      accountId: account,
      moduleName: module,
      generation,
      operationId: op,
      type: 'tombstone',
      content,
      mutate: async ({summary, revision, generation: targetGeneration}) => writeTombstones(tx, {
        account,
        module,
        ids: parts.map(part => part.userKey),
        summary,
        revision,
        generation: targetGeneration,
        payloads: new Map(parts.map(part => [part.userKey, part]))
      })
    }));
  }

  async function writeTombstones(tx, {account, module, ids, summary, revision, generation, payloads}) {
    const recordStore = tx.objectStore('records');
    const tombstones = tx.objectStore('tombstones');
    const saved = [];
    for (const userKey of ids) {
      const key = storageKey(account, module, generation, userKey);
      const previous = await requestResult(recordStore.get(key));
      const priorTomb = await requestResult(tombstones.get(key));
      const supplied = payloads.get(userKey);
      const payload = clone(supplied?.payload || previous?.payload || priorTomb?.payload || {userKey});
      const tombstone = {
        storageKey: key,
        accountId: account,
        module,
        generation,
        userKey,
        sortKey: indexText(supplied?.sortKey ?? previous?.sortKey ?? priorTomb?.sortKey, 'sortKey'),
        status: indexText(supplied?.status ?? previous?.status ?? priorTomb?.status, 'status'),
        scope: supplied?.scope || previous?.scope || priorTomb?.scope || '',
        sourcePath: Array.isArray(supplied?.sourcePath) ? supplied.sourcePath : (previous?.sourcePath || priorTomb?.sourcePath || null),
        payload,
        deleted: true,
        deletedRevision: revision,
        deletedAt: now()
      };
      if (previous) {
        await requestResult(recordStore.delete(key));
        summary.count = Math.max(0, summary.count - 1);
      }
      await requestResult(tombstones.put(tombstone));
      saved.push(publicRecord(tombstone));
    }
    return saved;
  }

  async function queryPage({accountId, module: moduleName, filter, sort = 'asc', cursor, limit = 50, generation} = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    if (sort !== 'asc' && sort !== 'desc') throw new Error('sort must be asc or desc');
    if (!Number.isInteger(limit) || limit < 1 || limit > RECORD_PAGE_MAX) throw new Error(`limit must be an integer from 1 to ${RECORD_PAGE_MAX}`);
    const hash = filterHash(filter);
    const status = filter?.status ? indexText(filter.status, 'status') : null;
    const db = await open();
    const tx = db.transaction(['meta', 'records'], 'readonly');
    return finish(tx, async () => {
      const meta = await requestResult(tx.objectStore('meta').get(account));
      const revision = meta?.revision || 0;
      const activeGeneration = meta?.activeGeneration || 1;
      const targetGeneration = generation == null ? activeGeneration : requireGeneration(generation);
      let lowerOpen = false;
      let upperOpen = true;
      let lower;
      let upper;
      if (status == null) {
        lower = [account, module, targetGeneration];
        upper = [account, module, targetGeneration, []];
      } else {
        lower = [account, module, targetGeneration, status];
        upper = [account, module, targetGeneration, status, []];
      }
      if (cursor != null) {
        const parsed = decodeCursor(cursor);
        if (parsed.accountId !== account || parsed.module !== module || parsed.filterHash !== hash || parsed.sort !== sort || parsed.generation !== targetGeneration || parsed.revision !== revision) {
          throw new RecordCursorInvalidError();
        }
        validateCursorTuple(parsed.last, {account, module, generation: targetGeneration, status});
        if (sort === 'asc') {
          lower = parsed.last;
          lowerOpen = true;
        } else {
          upper = parsed.last;
          upperOpen = true;
        }
      }
      const indexName = status == null ? 'scopeSort' : 'scopeStatusSort';
      const index = tx.objectStore('records').index(indexName);
      const range = bound(KeyRange, lower, upper, lowerOpen, upperOpen);
      const direction = sort === 'desc' ? 'prev' : 'next';
      const request = index.openCursor(range, direction);
      const rows = await new Promise((resolve, reject) => {
        const collected = [];
        request.onsuccess = () => {
          const current = request.result;
          if (!current || collected.length > limit) {
            resolve(collected);
            return;
          }
          collected.push(current.value);
          current.continue();
        };
        request.onerror = () => reject(request.error || new Error('cursor failed'));
      });
      const page = rows.slice(0, limit).map(publicRecord);
      const hasMore = rows.length > limit;
      const last = page[page.length - 1];
      const nextCursor = hasMore ? encodeCursor({
        v: 1,
        accountId: account,
        module,
        filterHash: hash,
        sort,
        generation: targetGeneration,
        revision,
        last: status == null
          ? [account, module, targetGeneration, last.sortKey, last.userKey]
          : [account, module, targetGeneration, status, last.sortKey, last.userKey]
      }) : null;
      return {records: page, nextCursor, revision, generation: targetGeneration, countAvailable: false};
    });
  }

  function scanIndex(storeName, accountId, generation) {
    const account = requireId(accountId, 'accountId');
    const target = requireGeneration(generation);
    return read(storeName, tx => {
      const index = tx.objectStore(storeName).index('accountGeneration');
      const range = bound(KeyRange, [account, target], [account, target, []], false, true);
      const request = index.openCursor(range);
      return new Promise((resolve, reject) => {
        const collected = [];
        request.onsuccess = () => {
          const current = request.result;
          if (!current) {
            resolve(collected.map(publicRecord));
            return;
          }
          collected.push(current.value);
          current.continue();
        };
        request.onerror = () => reject(request.error || new Error('scan failed'));
      });
    });
  }

  function scanRecords(accountId, generation) {
    return scanIndex('records', accountId, generation);
  }

  function scanTombstones(accountId, generation) {
    return scanIndex('tombstones', accountId, generation);
  }

  async function allocateGeneration(accountId) {
    const account = requireId(accountId, 'accountId');
    return write(async tx => {
      const metaStore = tx.objectStore('meta');
      const meta = await requestResult(metaStore.get(account)) || blankMeta(account);
      meta.nextGeneration += 1;
      await requestResult(metaStore.put(meta));
      return meta.nextGeneration;
    });
  }

  async function beginMigration({migrationId, accounts, skeleton, fingerprint, total, chunkSize, originals} = {}) {
    const id = requireText(migrationId, 'migrationId');
    if (!Array.isArray(accounts)) throw new Error('accounts must be an array');
    return write(async tx => {
      const checkpoints = tx.objectStore('migrations');
      const manifests = tx.objectStore('migrationManifests');
      const existing = await requestResult(checkpoints.get(id));
      const existingManifest = await requestResult(manifests.get(id));
      if (existing) {
        if (!existingManifest || existingManifest.fingerprint !== fingerprint) throw new Error('migration snapshot does not match the checkpoint');
        return {...clone(existingManifest), ...clone(existing)};
      }
      const metaStore = tx.objectStore('meta');
      const generationByAccount = {};
      const baseByAccount = {};
      for (const accountId of accounts) {
        const account = requireId(accountId, 'accountId');
        const meta = await requestResult(metaStore.get(account)) || blankMeta(account);
        baseByAccount[account] = {activeGeneration: meta.activeGeneration, revision: meta.revision || 0};
        meta.nextGeneration += 1;
        generationByAccount[account] = meta.nextGeneration;
        await requestResult(metaStore.put(meta));
      }
      const manifest = {
        migrationId: id,
        generationByAccount,
        baseByAccount,
        skeleton: clone(skeleton),
        fingerprint,
        total,
        chunkSize,
        originals: clone(originals)
      };
      const checkpoint = {migrationId: id, status: 'importing', nextIndex: 0, error: null, sealedRevisions: null};
      await requestResult(manifests.put(manifest));
      await requestResult(checkpoints.put(checkpoint));
      return {...clone(manifest), ...clone(checkpoint)};
    });
  }

  async function saveCheckpoint({migrationId, nextIndex, status} = {}) {
    const id = requireText(migrationId, 'migrationId');
    if (!Number.isInteger(nextIndex) || nextIndex < 0) throw new Error('nextIndex must be a non-negative integer');
    return write(async tx => {
      const checkpoints = tx.objectStore('migrations');
      const checkpoint = await requestResult(checkpoints.get(id));
      if (!checkpoint) throw new Error('migration was not found');
      if (checkpoint.status === 'active' || checkpoint.status === 'verified') return clone(checkpoint);
      checkpoint.nextIndex = nextIndex;
      if (status) checkpoint.status = status;
      await requestResult(checkpoints.put(checkpoint));
      return clone(checkpoint);
    });
  }

  async function markMigrationVerified(migrationId, expectedRevisions) {
    const id = requireText(migrationId, 'migrationId');
    return write(async tx => {
      const checkpoints = tx.objectStore('migrations');
      const manifests = tx.objectStore('migrationManifests');
      const checkpoint = await requestResult(checkpoints.get(id));
      const manifest = await requestResult(manifests.get(id));
      if (!checkpoint || !manifest) throw new Error('migration was not found');
      if (checkpoint.status === 'active' || checkpoint.status === 'verified') return {...clone(manifest), ...clone(checkpoint)};
      if (!expectedRevisions || typeof expectedRevisions !== 'object') throw new Error('expected generation revisions are required');
      if (checkpoint.nextIndex !== manifest.total) throw new Error('migration import is incomplete');
      const metaStore = tx.objectStore('meta');
      const sealedRevisions = {};
      for (const [accountId, generation] of Object.entries(manifest.generationByAccount)) {
        const meta = await requestResult(metaStore.get(accountId));
        if (!meta) throw new Error('migration account is missing');
        generationMaps(meta);
        const key = String(generation);
        const revision = meta.generationRevisions[key] || 0;
        if (revision !== expectedRevisions[accountId]) throw new Error('staging generation changed during verification');
        meta.sealedGenerations[key] = revision;
        sealedRevisions[accountId] = revision;
        await requestResult(metaStore.put(meta));
      }
      checkpoint.status = 'verified';
      checkpoint.error = null;
      checkpoint.sealedRevisions = sealedRevisions;
      await requestResult(checkpoints.put(checkpoint));
      return {...clone(manifest), ...clone(checkpoint)};
    });
  }

  async function markMigrationFailed(migrationId, error) {
    const id = requireText(migrationId, 'migrationId');
    return write(async tx => {
      const checkpoints = tx.objectStore('migrations');
      const checkpoint = await requestResult(checkpoints.get(id));
      if (!checkpoint) return null;
      if (checkpoint.status === 'active') return clone(checkpoint);
      checkpoint.status = 'failed';
      checkpoint.error = error instanceof Error ? error.message : String(error || 'migration failed');
      await requestResult(checkpoints.put(checkpoint));
      return clone(checkpoint);
    });
  }

  async function activateMigration(migrationId) {
    const id = requireText(migrationId, 'migrationId');
    return write(async tx => {
      const checkpoints = tx.objectStore('migrations');
      const manifests = tx.objectStore('migrationManifests');
      const checkpoint = await requestResult(checkpoints.get(id));
      const manifest = await requestResult(manifests.get(id));
      if (!checkpoint || !manifest) throw new Error('migration was not found');
      if (checkpoint.status === 'active') return {...clone(manifest), ...clone(checkpoint)};
      if (checkpoint.status !== 'verified') throw new Error('generation is not verified');
      const metaStore = tx.objectStore('meta');
      for (const [accountId, generation] of Object.entries(manifest.generationByAccount)) {
        const meta = await requestResult(metaStore.get(accountId));
        if (!meta) throw new Error('migration account is missing');
        generationMaps(meta);
        const key = String(generation);
        const base = manifest.baseByAccount?.[accountId];
        if (!base || meta.activeGeneration !== base.activeGeneration || (meta.revision || 0) !== base.revision) {
          throw new Error('live data changed since import');
        }
        const sealed = checkpoint.sealedRevisions?.[accountId];
        const current = meta.generationRevisions[key] || 0;
        if (sealed == null || current !== sealed || meta.sealedGenerations[key] !== sealed) {
          throw new Error('staging generation changed after verification');
        }
        if (meta.nextGeneration < generation) throw new Error('generation is not allocated');
        meta.activeGeneration = generation;
        delete meta.sealedGenerations[key];
        await requestResult(metaStore.put(meta));
      }
      checkpoint.status = 'active';
      checkpoint.activatedAt = now();
      await requestResult(checkpoints.put(checkpoint));
      return {...clone(manifest), ...clone(checkpoint)};
    });
  }

  return {
    open, close, getMeta, getSummary, getRecord, getTombstone, getOutbox, getMigration,
    putRecords, deleteRecords, putTombstones, queryPage, scanRecords, scanTombstones,
    allocateGeneration, beginMigration, saveCheckpoint, getCheckpoint, getManifest, markMigrationVerified, markMigrationFailed, activateMigration
  };
}

function publicRecord(record) {
  const payload = clone(record.payload || {});
  const view = {...payload};
  view.accountId = record.accountId;
  view.module = record.module;
  view.generation = record.generation;
  view.userKey = record.userKey;
  view.sortKey = record.sortKey;
  view.status = record.status;
  if (record.scope) view.scope = record.scope;
  if (record.sourcePath) view.sourcePath = clone(record.sourcePath);
  if (!Object.prototype.hasOwnProperty.call(payload, 'id')) view.id = record.userKey;
  view.payload = payload;
  if (record.deleted) {
    view.deleted = true;
    view.deletedAt = record.deletedAt;
    view.deletedRevision = record.deletedRevision;
  }
  return view;
}

function publicSummary(summary) {
  const copy = clone(summary);
  delete copy.storageKey;
  return copy;
}

function publicMeta(meta) {
  return clone(meta);
}

function publicOutbox(entry) {
  return clone(entry);
}
