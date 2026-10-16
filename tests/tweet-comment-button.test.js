import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tweet-comment-button.js', import.meta.url), 'utf8');

function createHarness({sendMessage, retryCount = 0} = {}) {
  const values = new Map();
  if (retryCount) values.set('__xef_comment_track_context_retry', String(retryCount));
  const timeouts = [];
  let reloads = 0;
  let buttonClick;
  const tweet = {querySelector:() => null, querySelectorAll:() => []};
  const anchor = {
    href:'https://x.com/author/status/12345',
    closest:() => tweet
  };
  const group = {querySelector:() => ({}), append(){}};
  tweet.querySelectorAll = selector => {
    if (selector === 'a[href*="/status/"]') return [anchor];
    if (selector === '[role="group"]') return [group];
    return [];
  };
  const toastNode = {dataset:{}, setAttribute(){}, remove(){}};
  const button = {
    dataset:{},
    setAttribute(){},
    addEventListener(type, callback) { if (type === 'click') buttonClick = callback; }
  };
  const document = {
    readyState:'complete',
    body:{append(){}, innerText:''},
    querySelector(selector) { return selector === '[data-xef-comment-toast]' ? toastNode : null; },
    querySelectorAll(selector) { return selector === '[data-testid="tweet"]' ? [tweet] : []; },
    createElement() { return button; }
  };
  class MutationObserver { observe() {} }
  class Element {}
  const context = {
    window:{addEventListener(){}, location:{reload(){reloads++;}}},
    document,
    location:{origin:'https://x.com'},
    sessionStorage:{
      getItem:key => values.get(key) ?? null,
      setItem:(key, value) => values.set(key, String(value)),
      removeItem:key => values.delete(key)
    },
    chrome:{runtime:{id:'extension-id', sendMessage}},
    MutationObserver,
    Element,
    URL,
    setTimeout(callback, delay) { timeouts.push({callback, delay}); return timeouts.length; },
    clearTimeout(){}
  };
  vm.runInNewContext(source, context);
  return {
    click() { buttonClick({preventDefault(){}, stopPropagation(){}}); },
    values,
    timeouts,
    get reloads() { return reloads; },
    toastNode,
    button
  };
}

test('invalidated runtime silently reloads once and retries the same comment extraction', () => {
  const harness = createHarness({sendMessage() {
    throw new TypeError("Cannot read properties of undefined (reading 'sendMessage')");
  }});

  harness.click();

  assert.equal(harness.reloads, 0);
  assert.ok(harness.timeouts.some(item => item.delay === 600));
  assert.deepEqual(JSON.parse(harness.values.get('__xef_pending_comment_track_post')), {
    authorHandle:'author', tweetId:'12345', url:'https://x.com/author/status/12345'
  });
  assert.equal(harness.values.get('__xef_comment_track_context_retry'), '1');
  assert.match(harness.toastNode.textContent, /自动刷新页面/);
});

test('a second context failure does not cause an automatic reload loop', () => {
  const harness = createHarness({retryCount:1, sendMessage() {
    throw new TypeError("Cannot read properties of undefined (reading 'sendMessage')");
  }});

  harness.click();

  assert.equal(harness.timeouts.some(item => item.delay === 600), false);
  assert.equal(harness.values.has('__xef_pending_comment_track_post'), false);
  assert.equal(harness.values.has('__xef_comment_track_context_retry'), false);
  assert.match(harness.toastNode.textContent, /仍未恢复/);
});

test('successful retry clears the retry marker and reports that tracking was queued', async () => {
  const harness = createHarness({retryCount:1, sendMessage:() => Promise.resolve({ok:true})});

  harness.click();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.values.has('__xef_comment_track_context_retry'), false);
  assert.match(harness.toastNode.textContent, /已加入后台读取队列/);
});
