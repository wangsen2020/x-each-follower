import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {durableGet, durableSet} from '../persistent-db.js';

function dropNullFields(value) {
  if (Array.isArray(value)) return value.map(dropNullFields);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null) out[key] = dropNullFields(item);
    }
    return out;
  }
  return value;
}

test('durable transport keeps nulls that object scripting args would drop', async () => {
  globalThis.indexedDB = indexedDB;
  globalThis.chrome = {
    tabs: {
      query: async () => [{id: 7}],
      get: async () => ({id: 7, status: 'complete'})
    },
    scripting: {
      executeScript: async ({func, args}) => {
        const transported = args.map(arg => typeof arg === 'string' ? arg : dropNullFields(arg));
        const result = await func(...transported);
        return [{result: typeof result === 'string' ? result : dropNullFields(result)}];
      }
    }
  };
  const value = {
    nextEligibleAt: null,
    followBackAt: null,
    config: {lastRunAt: null, keep: 1},
    nested: [null, {id: 2, gone: null}]
  };
  await durableSet('sample', value);
  const direct = dropNullFields(value);
  assert.equal(Object.hasOwn(direct, 'nextEligibleAt'), false);
  const loaded = await durableGet('sample');
  assert.equal(loaded.nextEligibleAt, null);
  assert.equal(loaded.followBackAt, null);
  assert.equal(loaded.config.lastRunAt, null);
  assert.equal(loaded.config.keep, 1);
  assert.equal(loaded.nested[0], null);
  assert.equal(loaded.nested[1].id, 2);
  assert.equal(loaded.nested[1].gone, null);
  assert.equal(Object.hasOwn(loaded, 'missing'), false);
  assert.equal(await durableGet('absent'), undefined);
  const opened = indexedDB.open('x-each-follower', 1);
  const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore('records').put({note: null, items: [1, null]}, 'legacy-raw');
  });
  const legacy = await durableGet('legacy-raw');
  assert.equal(legacy.note, null);
  assert.equal(legacy.items[1], null);
});
