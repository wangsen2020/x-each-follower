// Extension-origin record store. Uses Dexie for IndexedDB CRUD, compound index queries, and version upgrades.

import Dexie from 'dexie';

export const RECORD_NATIVE_LEGACY_VERSION = 1;
export const RECORD_DEXIE_LEGACY_VERSION = 0.1;
export const RECORD_DB_VERSION = 1;
export const RECORD_NATIVE_DB_VERSION = RECORD_DB_VERSION * 10;
export const RECORD_PAGE_MAX = 100;
export const RECORD_DB_NAME = 'x-each-follower-records';
export const RECORD_OPEN_BLOCKED_MS = 3000;

export const RECORD_DEXIE_STORES = Object.freeze({
  meta: 'accountId',
  records: 'storageKey, &[accountId+module+generation+sortKey+userKey], &[accountId+module+generation+status+sortKey+userKey], &[accountId+generation+module+userKey]',
  tombstones: 'storageKey, &[accountId+generation+module+userKey]',
  summaries: 'storageKey, &[accountId+module+generation]',
  outbox: 'operationId, [accountId+module+revision]',
  migrations: 'migrationId',
  migrationManifests: 'migrationId'
});

export const RECORD_TRANSACTION_SCOPES = Object.freeze({
  getMeta: Object.freeze(['meta']),
  getSummary: Object.freeze(['meta', 'summaries']),
  getRecord: Object.freeze(['meta', 'records']),
  getTombstone: Object.freeze(['meta', 'tombstones']),
  getOutbox: Object.freeze(['outbox']),
  getCheckpoint: Object.freeze(['migrations']),
  getManifest: Object.freeze(['migrationManifests']),
  getMigration: Object.freeze(['migrations', 'migrationManifests']),
  queryPage: Object.freeze(['meta', 'records']),
  scanRecords: Object.freeze(['records']),
  scanTombstones: Object.freeze(['tombstones']),
  putRecords: Object.freeze(['meta', 'records', 'tombstones', 'summaries', 'outbox']),
  deleteRecords: Object.freeze(['meta', 'records', 'tombstones', 'summaries', 'outbox']),
  putTombstones: Object.freeze(['meta', 'records', 'tombstones', 'summaries', 'outbox']),
  allocateGeneration: Object.freeze(['meta']),
  beginMigration: Object.freeze(['meta', 'migrations', 'migrationManifests']),
  saveCheckpoint: Object.freeze(['migrations']),
  markMigrationVerified: Object.freeze(['meta', 'migrations', 'migrationManifests']),
  markMigrationFailed: Object.freeze(['migrations']),
  activateMigration: Object.freeze(['meta', 'migrations', 'migrationManifests'])
});

const SCOPE_SORT_INDEX = ['accountId', 'module', 'generation', 'sortKey', 'userKey'];
const SCOPE_STATUS_SORT_INDEX = ['accountId', 'module', 'generation', 'status', 'sortKey', 'userKey'];
const ACCOUNT_GENERATION_INDEX = ['accountId', 'generation', 'module', 'userKey'];

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

function blankMeta(accountId) {
  return {
    accountId,
    schemaVersion: RECORD_DB_VERSION,
    activeGeneration: 1,
    nextGeneration: 1,
    revision: 0
  };
}

function guardOpenRequest(req, isCancelled, onCancelled) {
  if (!req || typeof req !== 'object') return req;
  return new Proxy(req, {
    set(target, prop, handler) {
      if (prop === 'onupgradeneeded' && typeof handler === 'function') {
        target.onupgradeneeded = event => {
          if (isCancelled()) {
            try { target.transaction?.abort(); } catch { /* ignore */ }
            try { target.result?.close(); } catch { /* ignore */ }
            onCancelled?.();
            return;
          }
          return handler.call(target, event);
        };
        return true;
      }
      if (prop === 'onsuccess' && typeof handler === 'function') {
        target.onsuccess = event => {
          if (isCancelled()) {
            try { target.result?.close(); } catch { /* ignore */ }
            onCancelled?.();
            return;
          }
          return handler.call(target, event);
        };
        return true;
      }
      target[prop] = handler;
      return true;
    },
    get(target, prop) {
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function createRecordDexie(dbName, factory, KeyRange, isCancelled, onCancelled) {
  let lastRequestedVersion = null;
  const indexedDB = {
    open(name, version) {
      // Prevent Dexie from falling back to versionless open when the on-disk DB is newer than supported.
      const effectiveVersion = version === undefined && lastRequestedVersion !== null ? lastRequestedVersion : version;
      if (version !== undefined) lastRequestedVersion = version;
      const request = effectiveVersion === undefined ? factory.open(name) : factory.open(name, effectiveVersion);
      return guardOpenRequest(request, isCancelled, onCancelled);
    },
    deleteDatabase: typeof factory.deleteDatabase === 'function' ? factory.deleteDatabase.bind(factory) : undefined,
    cmp: typeof factory.cmp === 'function' ? factory.cmp.bind(factory) : undefined
  };
  const db = new Dexie(dbName, {indexedDB, IDBKeyRange: KeyRange, autoOpen: false});
  // Native version 1 maps to Dexie version 0.1 (0.1 * 10 = 1).
  // Declaring 0.1 and 1 (native version 10) upgrades legacy native v1 databases without data or index loss.
  db.version(RECORD_DEXIE_LEGACY_VERSION).stores(RECORD_DEXIE_STORES);
  db.version(RECORD_DB_VERSION).stores(RECORD_DEXIE_STORES);
  return db;
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
  let cancelOpening = null;
  let openEpoch = 0;

  function bind(db, epoch) {
    const idbdb = db.backendDB();
    if (!idbdb) return;
    idbdb.onversionchange = () => {
      if (connection === db && openEpoch === epoch) connection = null;
      try { idbdb.close(); } catch { /* already closing */ }
      try { db.close(); } catch { /* already closing */ }
    };
    idbdb.onclose = () => {
      if (connection === db && openEpoch === epoch) connection = null;
      try { db.close(); } catch { /* already closed */ }
    };
  }

  function openOnce(epoch) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let blockedTimer = null;
      let db = null;
      const isCancelled = () => finished || openEpoch !== epoch;

      const fail = error => {
        if (finished) return;
        finished = true;
        if (cancelOpening === cancelAttempt) cancelOpening = null;
        if (blockedTimer) clearTimeout(blockedTimer);
        if (db) {
          try { db.backendDB()?.close(); } catch { /* ignore */ }
          try { db.close(); } catch { /* ignore */ }
        }
        const unwrapped = error?.inner || error;
        reject(unwrapped instanceof Error ? unwrapped : new Error(String(unwrapped || 'IndexedDB open failed')));
      };
      const cancelAttempt = () => fail(new Error('IndexedDB open cancelled'));
      cancelOpening = cancelAttempt;

      try {
        db = createRecordDexie(dbName, factory, KeyRange, isCancelled, cancelAttempt);
        db.on('blocked', () => {
          if (isCancelled() || blockedTimer) return;
          blockedTimer = setTimeout(() => fail(new Error('IndexedDB open blocked')), blockedTimeoutMs);
        });

        db.open().then(() => {
          if (isCancelled()) {
            finished = true;
            if (cancelOpening === cancelAttempt) cancelOpening = null;
            if (blockedTimer) clearTimeout(blockedTimer);
            try { db.backendDB()?.close(); } catch { /* ignore */ }
            try { db.close(); } catch { /* late open after close or blocked timeout */ }
            reject(new Error('IndexedDB open cancelled'));
            return;
          }
          const idbdb = db.backendDB();
          if (idbdb && idbdb.version > RECORD_NATIVE_DB_VERSION) {
            const versionErr = new Error(`Database version ${idbdb.version} is newer than supported version ${RECORD_NATIVE_DB_VERSION}`);
            versionErr.name = 'VersionError';
            fail(versionErr);
            return;
          }
          finished = true;
          if (cancelOpening === cancelAttempt) cancelOpening = null;
          if (blockedTimer) clearTimeout(blockedTimer);
          bind(db, epoch);
          resolve(db);
        }).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  function open() {
    if (connection && connection.isOpen()) return Promise.resolve(connection);
    connection = null;
    if (!opening) {
      const epoch = ++openEpoch;
      const attempt = openOnce(epoch).then(db => {
        if (openEpoch !== epoch) {
          try { db.backendDB()?.close(); } catch { /* ignore */ }
          try { db.close(); } catch { /* ignore */ }
          throw new Error('IndexedDB open superseded');
        }
        connection = db;
        if (opening === attempt) opening = null;
        return db;
      }).catch(error => {
        if (opening === attempt) opening = null;
        throw error;
      });
      opening = attempt;
    }
    return opening;
  }

  async function close() {
    openEpoch += 1;
    const cancel = cancelOpening;
    const pending = opening;
    const current = connection;
    cancelOpening = null;
    connection = null;
    opening = null;
    cancel?.();
    if (current) {
      try { current.backendDB()?.close(); } catch { /* already closed */ }
      try { current.close(); } catch { /* already closed */ }
    }
    if (pending) {
      try {
        const db = await pending;
        try { db.backendDB()?.close(); } catch { /* already closed */ }
        try { db.close(); } catch { /* already closed */ }
      } catch { /* open failed or cancelled */ }
    }
  }

  async function read(storeNames, fn) {
    const db = await open();
    const tables = (Array.isArray(storeNames) ? storeNames : [storeNames]).map(name => db.table(name));
    try {
      return await db.transaction('r', tables, tx => fn(tx));
    } catch (error) {
      throw error?.inner || error;
    }
  }

  async function write(storeNames, work) {
    const db = await open();
    const tables = (Array.isArray(storeNames) ? storeNames : [storeNames]).map(name => db.table(name));
    try {
      return await db.transaction('rw', tables, tx => work(tx));
    } catch (error) {
      throw error?.inner || error;
    }
  }

  async function resolveGeneration(tx, account, requested) {
    const metaStore = tx.table('meta');
    const meta = (await metaStore.get(account)) || blankMeta(account);
    const generation = requested == null ? meta.activeGeneration : requireGeneration(requested);
    if (generation > meta.nextGeneration) throw new Error('generation is not allocated');
    return {metaStore, meta, generation};
  }

  async function getMeta(accountId) {
    const account = requireId(accountId, 'accountId');
    const meta = await read(RECORD_TRANSACTION_SCOPES.getMeta, tx => tx.table('meta').get(account));
    return meta ? publicMeta(meta) : null;
  }

  async function getSummary(accountId, moduleName, options = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    const summary = await read(RECORD_TRANSACTION_SCOPES.getSummary, async tx => {
      const meta = await tx.table('meta').get(account);
      const generation = options.generation == null ? (meta?.activeGeneration || 1) : requireGeneration(options.generation);
      return tx.table('summaries').get(summaryKey(account, module, generation));
    });
    return summary ? publicSummary(summary) : null;
  }

  async function getRecord(accountId, moduleName, userKey, options = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    const id = requireId(userKey, 'userKey');
    const record = await read(RECORD_TRANSACTION_SCOPES.getRecord, async tx => {
      const meta = await tx.table('meta').get(account);
      const generation = options.generation == null ? (meta?.activeGeneration || 1) : requireGeneration(options.generation);
      return tx.table('records').get(storageKey(account, module, generation, id));
    });
    return record ? publicRecord(record) : null;
  }

  async function getTombstone(accountId, moduleName, userKey, options = {}) {
    const account = requireId(accountId, 'accountId');
    const module = requireText(moduleName, 'module');
    const id = requireId(userKey, 'userKey');
    const record = await read(RECORD_TRANSACTION_SCOPES.getTombstone, async tx => {
      const meta = await tx.table('meta').get(account);
      const generation = options.generation == null ? (meta?.activeGeneration || 1) : requireGeneration(options.generation);
      return tx.table('tombstones').get(storageKey(account, module, generation, id));
    });
    return record ? publicRecord(record) : null;
  }

  async function getOutbox(operationId) {
    const id = requireText(operationId, 'operationId');
    const entry = await read(RECORD_TRANSACTION_SCOPES.getOutbox, tx => tx.table('outbox').get(id));
    return entry ? publicOutbox(entry) : null;
  }

  async function getCheckpoint(migrationId) {
    const id = requireText(migrationId, 'migrationId');
    const checkpoint = await read(RECORD_TRANSACTION_SCOPES.getCheckpoint, tx => tx.table('migrations').get(id));
    return checkpoint ? clone(checkpoint) : null;
  }

  async function getManifest(migrationId) {
    const id = requireText(migrationId, 'migrationId');
    const manifest = await read(RECORD_TRANSACTION_SCOPES.getManifest, tx => tx.table('migrationManifests').get(id));
    return manifest ? clone(manifest) : null;
  }

  async function getMigration(migrationId) {
    const id = requireText(migrationId, 'migrationId');
    return read(RECORD_TRANSACTION_SCOPES.getMigration, async tx => {
      const checkpoint = await tx.table('migrations').get(id);
      if (!checkpoint) return null;
      const manifest = await tx.table('migrationManifests').get(id);
      return {...clone(manifest), ...clone(checkpoint)};
    });
  }

  async function applyOperation(tx, {accountId, moduleName, generation, operationId, type, content, mutate}) {
    const outbox = tx.table('outbox');
    const prior = await outbox.get(operationId);
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
    const summaries = tx.table('summaries');
    const key = summaryKey(accountId, moduleName, targetGeneration);
    const summary = (await summaries.get(key)) || {
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
    await metaStore.put(meta);
    await summaries.put(summary);
    const result = {
      operationId,
      accountId,
      module: moduleName,
      revision,
      generation: targetGeneration,
      summary: publicSummary(summary),
      records
    };
    await outbox.put({
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
    });
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
    return write(RECORD_TRANSACTION_SCOPES.putRecords, tx => applyOperation(tx, {
      accountId: account,
      moduleName: module,
      generation,
      operationId: op,
      type: 'put',
      content,
      mutate: async ({summary, generation: targetGeneration}) => {
        const recordStore = tx.table('records');
        const tombstones = tx.table('tombstones');
        const saved = [];
        for (const input of records) {
          const parts = recordParts(input);
          if (input.accountId != null && input.accountId !== account) throw new Error('record accountId does not match');
          if (input.module != null && input.module !== module) throw new Error('record module does not match');
          const key = storageKey(account, module, targetGeneration, parts.userKey);
          const previous = await recordStore.get(key);
          const tombstone = await tombstones.get(key);
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
          await recordStore.put(stored);
          if (tombstone) await tombstones.delete(key);
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
    return write(RECORD_TRANSACTION_SCOPES.deleteRecords, tx => applyOperation(tx, {
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
    return write(RECORD_TRANSACTION_SCOPES.putTombstones, tx => applyOperation(tx, {
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
    const recordStore = tx.table('records');
    const tombstones = tx.table('tombstones');
    const saved = [];
    for (const userKey of ids) {
      const key = storageKey(account, module, generation, userKey);
      const previous = await recordStore.get(key);
      const priorTomb = await tombstones.get(key);
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
        await recordStore.delete(key);
        summary.count = Math.max(0, summary.count - 1);
      }
      await tombstones.put(tombstone);
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
    return read(RECORD_TRANSACTION_SCOPES.queryPage, async tx => {
      const meta = await tx.table('meta').get(account);
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
      const indexFields = status == null ? SCOPE_SORT_INDEX : SCOPE_STATUS_SORT_INDEX;
      let collection = tx.table('records')
        .where(indexFields)
        .between(lower, upper, !lowerOpen, !upperOpen);
      if (sort === 'desc') collection = collection.reverse();
      const rows = await collection.limit(limit + 1).toArray();
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

  function scanIndex(storeName, scopes, accountId, generation) {
    const account = requireId(accountId, 'accountId');
    const target = requireGeneration(generation);
    return read(scopes, async tx => {
      const rows = await tx.table(storeName)
        .where(ACCOUNT_GENERATION_INDEX)
        .between([account, target], [account, target, []], true, false)
        .toArray();
      return rows.map(publicRecord);
    });
  }

  function scanRecords(accountId, generation) {
    return scanIndex('records', RECORD_TRANSACTION_SCOPES.scanRecords, accountId, generation);
  }

  function scanTombstones(accountId, generation) {
    return scanIndex('tombstones', RECORD_TRANSACTION_SCOPES.scanTombstones, accountId, generation);
  }

  async function allocateGeneration(accountId) {
    const account = requireId(accountId, 'accountId');
    return write(RECORD_TRANSACTION_SCOPES.allocateGeneration, async tx => {
      const metaStore = tx.table('meta');
      const meta = (await metaStore.get(account)) || blankMeta(account);
      meta.nextGeneration += 1;
      await metaStore.put(meta);
      return meta.nextGeneration;
    });
  }

  async function beginMigration({migrationId, accounts, skeleton, fingerprint, total, chunkSize, originals} = {}) {
    const id = requireText(migrationId, 'migrationId');
    if (!Array.isArray(accounts)) throw new Error('accounts must be an array');
    return write(RECORD_TRANSACTION_SCOPES.beginMigration, async tx => {
      const checkpoints = tx.table('migrations');
      const manifests = tx.table('migrationManifests');
      const existing = await checkpoints.get(id);
      const existingManifest = await manifests.get(id);
      if (existing) {
        if (!existingManifest || existingManifest.fingerprint !== fingerprint) throw new Error('migration snapshot does not match the checkpoint');
        return {...clone(existingManifest), ...clone(existing)};
      }
      const metaStore = tx.table('meta');
      const generationByAccount = {};
      const baseByAccount = {};
      for (const accountId of accounts) {
        const account = requireId(accountId, 'accountId');
        const meta = (await metaStore.get(account)) || blankMeta(account);
        baseByAccount[account] = {activeGeneration: meta.activeGeneration, revision: meta.revision || 0};
        meta.nextGeneration += 1;
        generationByAccount[account] = meta.nextGeneration;
        await metaStore.put(meta);
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
      await manifests.put(manifest);
      await checkpoints.put(checkpoint);
      return {...clone(manifest), ...clone(checkpoint)};
    });
  }

  async function saveCheckpoint({migrationId, nextIndex, status} = {}) {
    const id = requireText(migrationId, 'migrationId');
    if (!Number.isInteger(nextIndex) || nextIndex < 0) throw new Error('nextIndex must be a non-negative integer');
    return write(RECORD_TRANSACTION_SCOPES.saveCheckpoint, async tx => {
      const checkpoints = tx.table('migrations');
      const checkpoint = await checkpoints.get(id);
      if (!checkpoint) throw new Error('migration was not found');
      if (checkpoint.status === 'active' || checkpoint.status === 'verified') return clone(checkpoint);
      checkpoint.nextIndex = nextIndex;
      if (status) checkpoint.status = status;
      await checkpoints.put(checkpoint);
      return clone(checkpoint);
    });
  }

  async function markMigrationVerified(migrationId, expectedRevisions) {
    const id = requireText(migrationId, 'migrationId');
    return write(RECORD_TRANSACTION_SCOPES.markMigrationVerified, async tx => {
      const checkpoints = tx.table('migrations');
      const manifests = tx.table('migrationManifests');
      const checkpoint = await checkpoints.get(id);
      const manifest = await manifests.get(id);
      if (!checkpoint || !manifest) throw new Error('migration was not found');
      if (checkpoint.status === 'active' || checkpoint.status === 'verified') return {...clone(manifest), ...clone(checkpoint)};
      if (!expectedRevisions || typeof expectedRevisions !== 'object') throw new Error('expected generation revisions are required');
      if (checkpoint.nextIndex !== manifest.total) throw new Error('migration import is incomplete');
      const metaStore = tx.table('meta');
      const sealedRevisions = {};
      for (const [accountId, generation] of Object.entries(manifest.generationByAccount)) {
        const meta = await metaStore.get(accountId);
        if (!meta) throw new Error('migration account is missing');
        generationMaps(meta);
        const key = String(generation);
        const revision = meta.generationRevisions[key] || 0;
        if (revision !== expectedRevisions[accountId]) throw new Error('staging generation changed during verification');
        meta.sealedGenerations[key] = revision;
        sealedRevisions[accountId] = revision;
        await metaStore.put(meta);
      }
      checkpoint.status = 'verified';
      checkpoint.error = null;
      checkpoint.sealedRevisions = sealedRevisions;
      await checkpoints.put(checkpoint);
      return {...clone(manifest), ...clone(checkpoint)};
    });
  }

  async function markMigrationFailed(migrationId, error) {
    const id = requireText(migrationId, 'migrationId');
    return write(RECORD_TRANSACTION_SCOPES.markMigrationFailed, async tx => {
      const checkpoints = tx.table('migrations');
      const checkpoint = await checkpoints.get(id);
      if (!checkpoint) return null;
      if (checkpoint.status === 'active') return clone(checkpoint);
      checkpoint.status = 'failed';
      checkpoint.error = error instanceof Error ? error.message : String(error || 'migration failed');
      await checkpoints.put(checkpoint);
      return clone(checkpoint);
    });
  }

  async function activateMigration(migrationId) {
    const id = requireText(migrationId, 'migrationId');
    return write(RECORD_TRANSACTION_SCOPES.activateMigration, async tx => {
      const checkpoints = tx.table('migrations');
      const manifests = tx.table('migrationManifests');
      const checkpoint = await checkpoints.get(id);
      const manifest = await manifests.get(id);
      if (!checkpoint || !manifest) throw new Error('migration was not found');
      if (checkpoint.status === 'active') return {...clone(manifest), ...clone(checkpoint)};
      if (checkpoint.status !== 'verified') throw new Error('generation is not verified');
      const metaStore = tx.table('meta');
      for (const [accountId, generation] of Object.entries(manifest.generationByAccount)) {
        const meta = await metaStore.get(accountId);
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
        await metaStore.put(meta);
      }
      checkpoint.status = 'active';
      checkpoint.activatedAt = now();
      await checkpoints.put(checkpoint);
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
