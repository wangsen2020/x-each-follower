import test from 'node:test';
import assert from 'node:assert/strict';
import {createStorageWriteQueue} from '../storage-write-queue.js';
import {createStorageWriteAdapter} from '../storage-write-adapter.js';

test('a failed storage task rejects its caller and the next task still runs', async () => {
  const errors = [];
  const queue = createStorageWriteQueue({onError: error => errors.push(error.message)});
  const seen = [];
  const failed = queue.enqueue(async () => { throw new Error('disk full'); });
  const next = queue.enqueue(async () => { seen.push('second'); return 'ok'; });
  await assert.rejects(failed, /disk full/);
  assert.equal(await next, 'ok');
  assert.deepEqual(seen, ['second']);
  assert.deepEqual(errors, ['disk full']);
});

test('the adapter writes plain local data in order and refuses functions', async () => {
  const writes = [];
  const chromeApi = {storage: {local: {set: async value => { writes.push(value); }, remove: async () => {}}, sync: {set: async () => {}}}};
  const adapter = createStorageWriteAdapter({chromeApi, queue: createStorageWriteQueue()});
  const first = adapter.perform({op: 'localSet', payload: {monitor: {users: [1]}}});
  const second = adapter.perform({op: 'localSet', payload: {rows: []}});
  assert.deepEqual(await first, {ok: true});
  assert.deepEqual(await second, {ok: true});
  assert.deepEqual(writes, [{monitor: {users: [1]}}, {rows: []}]);
  await assert.rejects(adapter.perform({op: 'eval', payload: {a: 1}}), /unsupported/);
  await assert.rejects(adapter.perform({op: 'localSet', payload: 'nope'}), /payload/);
});
