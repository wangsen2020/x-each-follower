// Lossless legacy snapshot drill. Does not read chrome.storage or live databases.

import {canonicalValue} from './record-repository.js';

export const UNASSIGNED_ACCOUNT = 'unassigned';
export const UNASSIGNED_MODULE = 'unassigned';
export const MIGRATION_CHUNK_SIZE = 100;

const OMIT = Symbol('omit');

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isRecordMap(value) {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(key => isPlainObject(value[key]));
}

function isNestedContainer(value) {
  return Array.isArray(value) || (isPlainObject(value) && isRecordMap(value));
}

function encodePath(path) {
  return path.map(part => encodeURIComponent(String(part))).join('/');
}

export function scopeKey(accountId, moduleName, userKey) {
  return JSON.stringify([accountId, moduleName, userKey]);
}

export async function hashCanonical(value) {
  const encoded = new TextEncoder().encode(canonicalValue(value));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function moduleForPath(path) {
  const [head, second] = path;
  const depth = path.length;
  if (head === 'monitor' && depth === 3 && (second === 'users' || second === 'followingUsers' || second === 'queue')) return 'fans';
  if (head === 'mutualNetwork' && second === 'users' && depth === 3) return 'mutual';
  if (head === 'commentTracking' && second === 'users' && depth === 3) return 'comments';
  if ((head === 'commentTracking' || head === 'comments') && second === 'posts' && depth === 3) return 'posts';
  if (head === 'comments' && second === 'users' && depth === 3) return 'comments';
  if (head === 'unreciprocatedTracker' && second === 'users' && depth === 3) return 'unreciprocated';
  if (head === 'profileCache' && depth === 2) return 'profiles';
  if ((head === 'autoFollowLogs' || head === 'monitorLogs' || head === 'unreciprocatedLogs') && depth === 2) return 'logs';
  if (head === 'analysisRows' && depth === 2) return 'analysis';
  if (head === 'rows' && depth === 2) return 'rows';
  return 'extra';
}

function logScope(path) {
  if (path[0] === 'autoFollowLogs') return 'autoFollow';
  if (path[0] === 'monitorLogs') return 'monitor';
  if (path[0] === 'unreciprocatedLogs') return 'unreciprocated';
  return '';
}

function ownedAccount(payload) {
  if (typeof payload.accountId === 'string' && payload.accountId.trim() !== '') return payload.accountId;
  return null;
}

export async function flattenLegacySnapshot(snapshot) {
  if (!isPlainObject(snapshot)) throw new Error('snapshot must be an object');
  const source = clone(snapshot);
  const records = [];

  function emitRecord(value, path) {
    const payload = {};
    const fields = [];
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (isNestedContainer(child)) {
        fields.push({key, kind: 'node', node: walk(child, path.concat(key))});
      } else {
        payload[key] = clone(child);
        fields.push({key, kind: 'field'});
      }
    }
    const account = ownedAccount(payload);
    const sourceModule = moduleForPath(path);
    const record = {
      accountId: account || UNASSIGNED_ACCOUNT,
      module: account ? sourceModule : UNASSIGNED_MODULE,
      sourceModule,
      userKey: encodePath(path),
      sortKey: encodePath(path),
      status: typeof payload.status === 'string' ? payload.status : '',
      scope: logScope(path),
      sourcePath: clone(path),
      payload,
      deleted: payload.deleted === true
    };
    records.push(record);
    return {
      kind: 'ref',
      userKey: record.userKey,
      accountId: record.accountId,
      module: record.module,
      sourceModule,
      fields
    };
  }

  function walk(value, path) {
    if (Array.isArray(value)) {
      return {kind: 'array', items: value.map((item, index) => (isPlainObject(item) ? emitRecord(item, path.concat(index)) : walk(item, path.concat(index))))};
    }
    if (!isPlainObject(value)) return {kind: 'literal', value};
    if (path.length > 0 && isRecordMap(value)) {
      return {kind: 'map', entries: Object.keys(value).map(key => ({key, value: emitRecord(value[key], path.concat(key))}))};
    }
    return {kind: 'object', entries: Object.keys(value).map(key => ({key, value: walk(value[key], path.concat(key))}))};
  }

  const skeleton = walk(source, []);
  return {skeleton, records, fingerprint: await hashCanonical(source)};
}

function materialize(ref, payload, resolveRef) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const nested = new Set();
  for (const field of ref.fields || []) {
    if (field.kind === 'node') nested.add(field.key);
  }
  // Stored payload is the repository merge result. Keys added or replaced after import stay.
  // Keys absent from that payload are gone. Preexisting nested refs are rebuilt from child records.
  const out = {};
  for (const key of Object.keys(source)) {
    if (!nested.has(key)) out[key] = clone(source[key]);
  }
  for (const field of ref.fields || []) {
    if (field.kind !== 'node') continue;
    const built = buildNode(field.node, resolveRef);
    if (built === OMIT) delete out[field.key];
    else out[field.key] = built;
  }
  return out;
}

function buildNode(node, resolveRef) {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'array') {
    const items = [];
    for (const item of node.items) {
      const built = buildNode(item, resolveRef);
      if (built !== OMIT) items.push(built);
    }
    return items;
  }
  if (node.kind === 'object' || node.kind === 'map') {
    const out = {};
    for (const entry of node.entries) {
      const built = buildNode(entry.value, resolveRef);
      if (built !== OMIT) out[entry.key] = built;
    }
    return out;
  }
  if (node.kind === 'ref') return resolveRef(node);
  throw new Error('unknown skeleton node');
}

function resolver(byKey, shouldOmit = () => false) {
  const resolve = node => {
    const record = byKey.get(scopeKey(node.accountId, node.module, node.userKey));
    if (!record) throw new Error(`missing record ${node.userKey}`);
    if (shouldOmit(node, record)) return OMIT;
    return materialize(node, record.payload, resolve);
  };
  return resolve;
}

export function reconstructLegacySnapshot(flat) {
  const byKey = new Map(flat.records.map(record => [scopeKey(record.accountId, record.module, record.userKey), record]));
  return buildNode(flat.skeleton, resolver(byKey));
}

function envelope(record) {
  return {
    envelope: true,
    userKey: record.userKey,
    sortKey: record.sortKey,
    status: record.status,
    scope: record.scope,
    sourcePath: record.sourcePath,
    payload: record.payload
  };
}

function placeAddition(snapshot, record, usedPaths) {
  const path = record.sourcePath;
  if (!Array.isArray(path) || path.length < 2) throw new Error('unrepresentable rollback addition');
  const identity = JSON.stringify(path);
  if (usedPaths.has(identity)) throw new Error('rollback collision');
  usedPaths.add(identity);
  let cursor = snapshot;
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index];
    if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      throw new Error('unrepresentable rollback addition');
    }
    cursor = cursor[part];
  }
  const leaf = clone(record.payload);
  const last = path[path.length - 1];
  if (Array.isArray(cursor)) {
    if (typeof last === 'number' && cursor[last] != null) throw new Error('rollback collision');
    cursor.push(leaf);
    return;
  }
  if (!isPlainObject(cursor) || Object.prototype.hasOwnProperty.call(cursor, last)) throw new Error('rollback collision');
  cursor[last] = leaf;
}

export function createRecordMigration({repository, chunkSize = MIGRATION_CHUNK_SIZE} = {}) {
  if (!repository) throw new Error('repository is required');
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) throw new Error('chunkSize must be an integer from 1 to 500');

  async function stage(snapshot, migrationId) {
    const flat = await flattenLegacySnapshot(snapshot);
    const accounts = [...new Set(flat.records.map(record => record.accountId))].sort();
    const originals = {};
    const usedPaths = new Set();
    for (const record of flat.records) {
      const key = scopeKey(record.accountId, record.module, record.userKey);
      if (originals[key]) throw new Error('rollback collision');
      const pathId = JSON.stringify(record.sourcePath);
      if (usedPaths.has(pathId)) throw new Error('rollback collision');
      usedPaths.add(pathId);
      originals[key] = {
        accountId: record.accountId,
        module: record.module,
        userKey: record.userKey,
        sourceModule: record.sourceModule,
        scope: record.scope,
        sourcePath: record.sourcePath,
        deleted: record.deleted,
        hash: await hashCanonical(record.payload)
      };
    }
    let job = await repository.beginMigration({
      migrationId,
      accounts,
      skeleton: flat.skeleton,
      fingerprint: flat.fingerprint,
      total: flat.records.length,
      chunkSize,
      originals
    });
    if (job.fingerprint !== flat.fingerprint) throw new Error('migration snapshot does not match the checkpoint');
    const size = job.chunkSize;
    while (job.nextIndex < flat.records.length) {
      const start = job.nextIndex;
      const chunk = flat.records.slice(start, start + size);
      const groups = new Map();
      for (const record of chunk) {
        const key = JSON.stringify([record.accountId, record.module, record.deleted ? 'tombstone' : 'put']);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
      }
      let groupIndex = 0;
      for (const group of groups.values()) {
        const generation = job.generationByAccount[group[0].accountId];
        const request = {
          accountId: group[0].accountId,
          module: group[0].module,
          generation,
          operationId: `${migrationId}:${start}:${groupIndex}`,
          records: group.map(envelope)
        };
        groupIndex += 1;
        if (group[0].deleted) await repository.putTombstones(request);
        else await repository.putRecords(request);
      }
      const checkpoint = await repository.saveCheckpoint({migrationId, nextIndex: start + chunk.length, status: 'importing'});
      job = {...job, ...checkpoint};
    }
    return job;
  }

  async function loadGeneration(accountId, generation) {
    const records = await repository.scanRecords(accountId, generation);
    const tombstones = await repository.scanTombstones(accountId, generation);
    const byKey = new Map();
    for (const record of records) byKey.set(scopeKey(record.accountId, record.module, record.userKey), record);
    for (const tomb of tombstones) {
      const key = scopeKey(tomb.accountId, tomb.module, tomb.userKey);
      if (!byKey.has(key)) byKey.set(key, {...tomb, deleted: true});
    }
    return byKey;
  }

  async function verify(snapshot, migrationId) {
    const flat = await flattenLegacySnapshot(snapshot);
    const manifest = await repository.getManifest(migrationId);
    const checkpoint = await repository.getCheckpoint(migrationId);
    if (!manifest || !checkpoint) throw new Error('migration was not found');
    if (manifest.fingerprint !== flat.fingerprint || manifest.fingerprint !== await hashCanonical(snapshot)) {
      throw new Error('migration snapshot does not match the checkpoint');
    }
    if (checkpoint.status === 'verified' || checkpoint.status === 'active') return repository.getMigration(migrationId);
    const mismatches = [];
    const expectedRevisions = {};
    const staged = new Map();
    for (const [accountId, generation] of Object.entries(manifest.generationByAccount)) {
      const meta = await repository.getMeta(accountId);
      if (meta?.activeGeneration === generation) mismatches.push({accountId, reason: 'staging generation is already active'});
      expectedRevisions[accountId] = meta?.generationRevisions?.[String(generation)] || 0;
    }
    for (const [accountId, generation] of Object.entries(manifest.generationByAccount)) {
      for (const [key, record] of await loadGeneration(accountId, generation)) staged.set(key, record);
    }
    const originalKeys = Object.keys(manifest.originals);
    if (staged.size !== originalKeys.length) mismatches.push({reason: 'record count mismatch'});
    for (const key of staged.keys()) {
      if (!Object.prototype.hasOwnProperty.call(manifest.originals, key)) mismatches.push({userKey: key, reason: 'unexpected record'});
    }
    for (const [key, original] of Object.entries(manifest.originals)) {
      const found = staged.get(key);
      if (original.deleted) {
        if (!found?.deleted || await hashCanonical(found.payload) !== original.hash) mismatches.push({userKey: original.userKey, reason: 'tombstone payload mismatch'});
      } else if (!found || found.deleted || await hashCanonical(found.payload) !== original.hash) {
        mismatches.push({userKey: original.userKey, reason: 'payload mismatch'});
      }
    }
    if (mismatches.length === 0) {
      const rebuilt = buildNode(manifest.skeleton, resolver(staged));
      if (await hashCanonical(rebuilt) !== manifest.fingerprint) mismatches.push({reason: 'reconstructed snapshot mismatch'});
    }
    if (mismatches.length > 0) {
      await repository.markMigrationFailed(migrationId, `verification failed: ${mismatches.length}`);
      const error = new Error(`verification failed: ${mismatches.length}`);
      error.mismatches = mismatches;
      throw error;
    }
    try {
      return await repository.markMigrationVerified(migrationId, expectedRevisions);
    } catch (error) {
      await repository.markMigrationFailed(migrationId, error);
      throw error;
    }
  }

  async function activate(migrationId) {
    return repository.activateMigration(migrationId);
  }

  async function importSnapshot({snapshot, migrationId, activate: shouldActivate = false} = {}) {
    if (typeof migrationId !== 'string' || migrationId.trim() === '') throw new Error('migrationId must be a non-empty string');
    const before = await hashCanonical(snapshot);
    try {
      await stage(snapshot, migrationId);
      await verify(snapshot, migrationId);
      const job = shouldActivate ? await activate(migrationId) : await repository.getMigration(migrationId);
      if (await hashCanonical(snapshot) !== before) throw new Error('source snapshot was modified');
      return job;
    } catch (error) {
      if (await hashCanonical(snapshot) !== before) throw new Error('source snapshot was modified', {cause: error});
      throw error;
    }
  }

  async function exportRollback(migrationId) {
    const manifest = await repository.getManifest(migrationId);
    const checkpoint = await repository.getCheckpoint(migrationId);
    if (!manifest || !checkpoint || checkpoint.status !== 'active') throw new Error('rollback export requires an active migration');
    const originals = manifest.originals || {};
    const writes = [];
    const deletions = [];
    const current = new Map();
    for (const accountId of Object.keys(manifest.generationByAccount)) {
      const meta = await repository.getMeta(accountId);
      for (const [key, record] of await loadGeneration(accountId, meta.activeGeneration)) current.set(key, record);
    }
    const payloadHashes = new Map();
    for (const [key, record] of current) payloadHashes.set(key, await hashCanonical(record.payload));
    const usedPaths = new Set(Object.values(originals).map(record => JSON.stringify(record.sourcePath)));
    const snapshot = buildNode(manifest.skeleton, resolver(current, (node, record) => {
      const key = scopeKey(node.accountId, node.module, node.userKey);
      const original = originals[key];
      const removedAfterImport = record.deleted && (!original || !original.deleted);
      if (removedAfterImport) {
        if (original) deletions.push({userKey: record.userKey, accountId: record.accountId, module: record.module, payload: clone(record.payload)});
        return true;
      }
      if (!original || payloadHashes.get(key) !== original.hash) {
        writes.push({userKey: record.userKey, accountId: record.accountId, module: record.module, payload: clone(record.payload)});
      }
      return false;
    }));
    for (const [key, record] of current) {
      if (record.deleted && !originals[key]) {
        deletions.push({userKey: record.userKey, accountId: record.accountId, module: record.module, payload: clone(record.payload)});
        continue;
      }
      if (originals[key] || record.deleted) continue;
      placeAddition(snapshot, record, usedPaths);
      writes.push({userKey: record.userKey, accountId: record.accountId, module: record.module, payload: clone(record.payload), added: true});
    }
    return {snapshot, writes, deletions};
  }

  return {stage, verify, activate, importSnapshot, exportRollback, flattenLegacySnapshot};
}
