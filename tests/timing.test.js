import test from 'node:test';
import assert from 'node:assert/strict';
import { randomizedSeconds } from '../timing.js';

test('randomizedSeconds preserves its anchor when jitter is zero', () => {
  assert.equal(randomizedSeconds(15, 0), 15);
});

test('randomizedSeconds varies around the anchor within the configured range', () => {
  assert.equal(randomizedSeconds(15, 5, 2, 60, () => 0), 10);
  assert.equal(randomizedSeconds(15, 5, 2, 60, () => 0.999999), 20);
});

test('randomizedSeconds clamps to the allowed duration bounds', () => {
  assert.equal(randomizedSeconds(2, 5, 2, 60, () => 0), 2);
  assert.equal(randomizedSeconds(60, 30, 2, 60, () => 0.999999), 60);
});
