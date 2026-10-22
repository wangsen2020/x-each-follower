import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptRollingPage, changedFollowBackRows} from '../src/features/relationships/rolling-scan.js';

test('rolling list defers an oversized next page without dropping any of its users', () => {
  const page = Array.from({length:47}, (_, index) => ({handle:`user${index}`}));
  assert.equal(acceptRollingPage(page, 0, 20).state, 'oversize');
  assert.equal(acceptRollingPage(page, 94, 100).state, 'defer');
  assert.deepEqual(acceptRollingPage(page, 47, 100), {state:'accept',users:page,consumed:94});
  assert.equal(acceptRollingPage([], 94, 100).state, 'empty');
});

test('incremental follower writes contain only changed follow-back rows', () => {
  const prior = [{handle:'alpha',status:'pending'}, {handle:'beta',status:'pending'}];
  const next = [{handle:'alpha',status:'pending'}, {handle:'beta',status:'followed'}, {handle:'gamma',status:'pending'}];
  assert.deepEqual(changedFollowBackRows(prior, next).map(user => user.handle), ['beta','gamma']);
});
