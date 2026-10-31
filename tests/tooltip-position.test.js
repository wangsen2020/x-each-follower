import test from 'node:test';
import assert from 'node:assert/strict';
import { positionInfoTip, positionDialogInfoTip } from '../src/entries/panel/tooltip-position.js';

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

test('native dialog translation is applied once and its borders bound the tooltip', () => {
  const dialog={left:293,top:160,clientLeft:1,clientTop:1,clientWidth:778,clientHeight:578};
  const result=positionDialogInfoTip({left:534,width:14,top:233,bottom:247},{width:280,height:100},dialog,{width:1366,height:900});
  assert.equal(294+result.left,401);
  assert.equal(161+result.top,255);
  const edge=positionDialogInfoTip({left:1050,width:14,top:690,bottom:704},{width:280,height:100},dialog,{width:1366,height:900});
  assert.equal(edge.left+edge.width,770);
  assert.ok(edge.top+100<=570);
});

test('dialog positioning reads non-enumerable DOMRect dimensions', () => {
  const anchor=Object.create({left:534,width:14,top:233,bottom:247});
  const result=positionDialogInfoTip(anchor,{width:280,height:100},{left:293,top:160,clientLeft:1,clientTop:1,clientWidth:778,clientHeight:578},{width:1366,height:900});
  assert.equal(result.left,107);assert.ok(Number.isFinite(result.left));
});

test('narrow or partially clipped dialogs constrain long tips and account for scrolling', () => {
  const result=positionDialogInfoTip({left:24,width:14,top:70,bottom:84},{width:280,height:900},{left:10,top:10,clientLeft:1,clientTop:1,clientWidth:248,clientHeight:378,scrollTop:20},{width:270,height:400});
  assert.equal(result.width,232);assert.equal(result.left,8);assert.equal(result.maxHeight,362);assert.equal(result.top,28);
});
