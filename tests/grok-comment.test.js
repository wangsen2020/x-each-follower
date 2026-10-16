import test from 'node:test';
import assert from 'node:assert/strict';
import {extractGrokComment, buildGrokCommentPrompt, tweetWeight, makeNonce, START, END} from '../grok-comment.js';
import {publishQuotePostOnPage} from '../page-reader.js';

test('extractGrokComment takes the body between markers', () => {
  assert.equal(extractGrokComment(`好的\n${START}恭喜达成 8k，一步一个脚印真扎实！你下一个目标是多少？${END}\n希望有帮助`), '恭喜达成 8k，一步一个脚印真扎实！你下一个目标是多少？');
});

test('extractGrokComment uses the last marked block and strips wrapping quotes', () => {
  assert.equal(extractGrokComment(`${START}旧的草稿内容很长很长${END} 修改后：${START}“新的评论内容在这里”${END}`), '新的评论内容在这里');
});

test('extractGrokComment rejects missing markers, unterminated output, placeholders and empty bodies', () => {
  assert.equal(extractGrokComment('只是一段话，没有标记'), '');
  assert.equal(extractGrokComment(`${START}还没写完就被截断`), '');
  assert.equal(extractGrokComment(`${START}你的评论内容${END}`), '');
  assert.equal(extractGrokComment(`${START}  ${END}`), '');
  assert.equal(extractGrokComment(''), '');
  assert.equal(extractGrokComment(null), '');
});

test('the prompt echo (which contains the markers) is never mistaken for an answer', () => {
  const nonce = makeNonce();
  const prompt = buildGrokCommentPrompt({handle: 'alice', name: 'Alice', postText: '今天发布了新版本', nonce});
  // 页面里提示词原样出现时：说明里的标记之间没有评论正文，必须取不到
  assert.equal(extractGrokComment(prompt), '');
  assert.ok(prompt.includes(nonce));
});

test('extractGrokComment rejects comments over the 280-weight X limit', () => {
  assert.equal(extractGrokComment(`${START}${'好'.repeat(150)}${END}`), '');
  assert.ok(extractGrokComment(`${START}${'好'.repeat(100)}${END}`));
});

test('tweetWeight counts CJK as 2 and latin as 1', () => {
  assert.equal(tweetWeight('abc'), 3);
  assert.equal(tweetWeight('你好'), 4);
  assert.equal(tweetWeight('a你'), 3);
});

test('makeNonce is unique per call', () => {
  assert.notEqual(makeNonce(), makeNonce());
});

test('publishQuotePostOnPage refuses when the page is not the target status page', async () => {
  globalThis.location = {pathname: '/someone'};
  globalThis.document = {querySelectorAll: () => [], querySelector: () => null};
  const res = await publishQuotePostOnPage('https://x.com/alice/status/123', '评价');
  assert.equal(res.ok, false);
  assert.match(res.reason, /目标帖子详情页/);
  const empty = await publishQuotePostOnPage('https://x.com/alice/status/123', '  ');
  assert.equal(empty.ok, false);
});

function makeQuotePage({embeddedOriginal = true} = {}) {
  globalThis.location = {pathname: '/alice/status/123'};
  const events = [];
  let closed = false;
  const box = {offsetParent: {}, innerText: '', focus() { events.push('focus'); }};
  const send = {
    disabled: false,
    getAttribute: () => null,
    click() { events.push('publish'); closed = true; }
  };
  const quoteItem = {offsetParent: {}, innerText: 'Quote', click() { events.push('quote'); }};
  const retweet = {click() { events.push('retweet'); }};
  const originalLink = {};
  const article = {querySelector(selector) {
    if (selector === '[data-testid="retweet"]') return retweet;
    if (selector.includes('/status/123')) return originalLink;
    return null;
  }};
  const dialog = {querySelector(selector) {
    if (selector.includes('/status/123')) return embeddedOriginal ? originalLink : null;
    if (selector === '[data-testid="tweetTextarea_0"]') return closed ? null : box;
    if (selector === '[data-testid="tweetButton"]') return closed ? null : send;
    return null;
  }};
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === 'article') return [article];
      if (selector === '[role="menuitem"]') return events.includes('retweet') ? [quoteItem] : [];
      return [];
    },
    querySelector(selector) {
      if (selector === '[data-testid="toast"]') return null;
      if (selector === '[role="dialog"]') return events.includes('quote') && !closed ? dialog : null;
      return null;
    },
    execCommand(command, _ui, text) {
      assert.equal(command, 'insertText');
      box.innerText = text;
      events.push('type');
      return true;
    }
  };
  return {events};
}

test('publishQuotePostOnPage embeds the exact original and publishes through Quote', async () => {
  const {events} = makeQuotePage();
  const result = await publishQuotePostOnPage('https://x.com/alice/status/123', '有价值的引用评价内容');
  assert.deepEqual(result, {ok: true, mode: 'quote'});
  assert.deepEqual(events, ['retweet', 'quote', 'focus', 'type', 'publish']);
});

test('publishQuotePostOnPage refuses to publish if the composer does not contain the target original', async () => {
  const {events} = makeQuotePage({embeddedOriginal: false});
  const result = await publishQuotePostOnPage('https://x.com/alice/status/123', '有价值的引用评价内容');
  assert.equal(result.ok, false);
  assert.match(result.reason, /未嵌入目标原帖/);
  assert.equal(events.includes('publish'), false);
});
