import test from 'node:test';
import assert from 'node:assert/strict';
import {detectXGrokUsageLimitOnPage, checkXGrokUsageLimit, readXGrokUsageCooldown, GROK_USAGE_LIMIT_KEY} from '../src/features/grok/grok-usage-limit.js';
import {evaluateProfileGrokRisk} from '../src/features/relationships/content-risk.js';
import {requestGrokText} from '../src/features/grok/grok-comment.js';

test('X quota status card is recognized only in the matching turn, with hidden and quoted cards ignored', () => {
  const previous = {document:globalThis.document, location:globalThis.location};
  const card = {textContent:'You have reached a Grok usage limit. Try again later.', getClientRects:()=>[{}], closest:()=>null};
  const turn = {querySelectorAll:s=>s.includes('group/user') ? [{textContent:'prompt nonce123'}] : [card]};
  try {
    globalThis.location = {hostname:'x.com', pathname:'/i/grok'};
    globalThis.document = {querySelectorAll:s=>s === '[data-turn-id]' ? [turn] : [card]};
    assert.equal(detectXGrokUsageLimitOnPage('nonce123').code, 'GROK_USAGE_LIMIT');
    assert.equal(detectXGrokUsageLimitOnPage('another-turn'), null);
    card.hidden = true;
    assert.equal(detectXGrokUsageLimitOnPage('nonce123'), null);
    card.hidden = false; card.closest = ()=>({});
    assert.equal(detectXGrokUsageLimitOnPage('nonce123'), null);
    card.closest = ()=>null;
    for (const text of ['您已达到使用上限，请稍后重试', 'Grok 额度已耗尽']) {
      card.textContent = text;
      assert.equal(detectXGrokUsageLimitOnPage().quotaExhausted, true);
    }
    card.textContent = 'Shared links could not be loaded';
    assert.equal(detectXGrokUsageLimitOnPage(), null);
    card.textContent = 'An explanation of usage limit reached errors';
    assert.equal(detectXGrokUsageLimitOnPage(), null);
    globalThis.location.pathname = '/home';
    assert.equal(detectXGrokUsageLimitOnPage(), null);
  } finally { Object.assign(globalThis, previous); }
});

test('quota cooldown persists, prevents another prompt window, and expires without claiming recovery', async () => {
  const data = {};
  const storage = {get:async key=>({[key]:data[key]}), set:async value=>Object.assign(data,value)};
  const api = {storage:{local:storage}, scripting:{executeScript:async()=>[{result:{quotaExhausted:true, code:'GROK_USAGE_LIMIT', channel:'x.com', reason:'额度耗尽'}}]}};
  const result = await checkXGrokUsageLimit(3, 'nonce', api, Date.now());
  assert.equal((await readXGrokUsageCooldown(storage)).cooldown, true);
  const previous = globalThis.chrome;
  try {
    globalThis.chrome = {storage:{local:storage}, windows:{create:()=>{throw Error('must not open')}}};
    assert.equal((await requestGrokText('test')).quotaExhausted, true);
  } finally { globalThis.chrome = previous; }
  assert.equal(await readXGrokUsageCooldown(storage, result.retryAt), null);
  assert.ok(data[GROK_USAGE_LIMIT_KEY]);
  api.storage.local.set = async()=>{throw Error('storage unavailable');};
  const failedSave = await checkXGrokUsageLimit(3, 'nonce', api);
  assert.equal(failedSave.quotaExhausted, true);
  assert.equal(failedSave.cooldownPersisted, false);
});

test('quota exhaustion does not become a safe risk assessment', async () => {
  const result = await evaluateProfileGrokRisk({handle:'test'}, {runner:async()=>({ok:false, quotaExhausted:true, retryAt:100, reason:'额度耗尽'})});
  assert.equal(result.safe, false);
  assert.equal(result.evaluated, false);
  assert.equal(result.quotaExhausted, true);
});
