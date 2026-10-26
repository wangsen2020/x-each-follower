import test from 'node:test';
import assert from 'node:assert/strict';
import { positionInfoTip } from '../src/entries/panel/tooltip-position.js';

test('info tips stay inside both edges of a narrow viewport', () => {
  const viewport = { width: 375, height: 600 };
  const tooltip = { width: 280, height: 90 };
  const left = positionInfoTip({ left: 4, width: 14, top: 100, bottom: 114 }, tooltip, viewport);
  const right = positionInfoTip({ left: 357, width: 14, top: 100, bottom: 114 }, tooltip, viewport);
  assert.equal(left.left, 8);
  assert.equal(right.left + right.width, 367);
});

test('info tips choose the available side and remain vertically visible', () => {
  const viewport = { width: 800, height: 400 };
  const tooltip = { width: 280, height: 110 };
  const bottom = positionInfoTip({ left: 500, width: 14, top: 350, bottom: 364 }, tooltip, viewport);
  const top = positionInfoTip({ left: 500, width: 14, top: 12, bottom: 26 }, tooltip, viewport);
  assert.equal(bottom.placement, 'top');
  assert.equal(bottom.top, 232);
  assert.equal(top.placement, 'bottom');
  assert.equal(top.top, 34);
});
