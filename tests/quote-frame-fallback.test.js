import test from 'node:test';
import assert from 'node:assert/strict';
import {setQuoteFrameFallbackOnPage} from '../src/platform/x/page-reader.js';

test('hidden quote frames progress once, support cancellation and restore native functions', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  const callbacks = new Map();
  let nextId = 0;
  const request = cb => {callbacks.set(++nextId, cb); return nextId;};
  const cancel = id => callbacks.delete(id);
  globalThis.window = {requestAnimationFrame:request,cancelAnimationFrame:cancel};
  globalThis.document = {hidden:true};
  try {
    setQuoteFrameFallbackOnPage(true);
    let count = 0;
    window.requestAnimationFrame(() => count++);
    t.mock.timers.tick(100);
    assert.equal(count, 1);
    assert.equal(callbacks.size, 0);
    const id = window.requestAnimationFrame(() => count++);
    window.cancelAnimationFrame(id);
    t.mock.timers.tick(100);
    assert.equal(count, 1);
    const raced = window.requestAnimationFrame(() => count++);
    callbacks.get(raced)(123);
    t.mock.timers.tick(100);
    assert.equal(count, 2, 'native frame and timeout must not both invoke callback');
    document.hidden = false;
    const visible = window.requestAnimationFrame(() => count++);
    t.mock.timers.tick(100);
    assert.equal(count, 2, 'visible pages use normal animation frames');
    callbacks.get(visible)(456);
    assert.equal(count, 3);
    setQuoteFrameFallbackOnPage(false);
    assert.equal(window.requestAnimationFrame, request);
    assert.equal(window.cancelAnimationFrame, cancel);
    assert.equal(window.__xfollowerQuoteFrameFallback, undefined);
    setQuoteFrameFallbackOnPage(true);
    t.mock.timers.tick(120000);
    assert.equal(window.requestAnimationFrame, request, 'expiry restores even if caller disappears');
  } finally {
    setQuoteFrameFallbackOnPage(false);
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});
