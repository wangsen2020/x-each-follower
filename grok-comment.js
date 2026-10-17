// Grok 生成引用评价 + 发布引用帖的共用模块。面板与评论追踪后台任务都调用这里。
// 带 "in-page" 标记的函数会经 chrome.scripting.executeScript 序列化注入页面，必须自包含。
import { openQuoteComposerOnPage, inspectQuoteComposerOnPage, dismissQuoteComposerOnPage } from './page-reader.js';

export const START = '【引用评价开始】';
export const END = '【引用评价结束】';
const X_QUOTE_LIMIT = 280;

// Keep Grok windows visible so progress can be observed, while avoiding focus theft.
export function buildBackgroundGrokWindowOptions(url) {
  return {
    url,
    type: 'popup',
    state: 'normal',
    focused: false,
    width: 800,
    height: 600
  };
}

export function createBackgroundGrokWindow(url) {
  return chrome.windows.create(buildBackgroundGrokWindowOptions(url));
}

/** 在提交互粉分析前安装 DOM 监听；Grok 回答工具栏出现新的复制按钮即认为本轮完成。 */
export function submitGrokPromptAndWaitForCopyIconOnPage(prompt, timeoutMs = 75000, handles = [], sampleIntervalMs = 1500) {
  return new Promise(resolve => {
    const input = document.querySelector('textarea, [contenteditable="true"]');
    if (!input) return resolve({submitted:false, completed:false, reason:'找不到 Grok 输入框'});
    const copyButtons = () => [...document.querySelectorAll('button,[role="button"]')].filter(button => {
      const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.getAttribute('data-testid') || ''} ${button.innerText || ''}`;
      return /copy|复制|clipboard/i.test(label);
    });
    const hasStructuredResult = text => handles.some(rawHandle => {
      const handle = String(rawHandle || '').replace(/^@/, '').trim();
      if (!handle) return false;
      const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\[@${escaped}\\s*\\|\\s*互粉意向\\s*[:：]`, 'i').test(text);
    });
    const initialCopyCount = copyButtons().length;
    const nonce = String(prompt).match(/任务编号[\w-]+/)?.[0] || '';
    const suggestionButtons = () => [...document.querySelectorAll('button span.min-w-0.overflow-x-clip.text-ellipsis.whitespace-nowrap')]
      .map(span => span.closest('button')).filter(button => (button?.innerText || '').trim());
    const initialSuggestions = new Set(suggestionButtons());
    if (input.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, prompt);
    } else {
      input.textContent = prompt;
    }
    input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:prompt}));
    input.dispatchEvent(new Event('change', {bubbles:true}));
    const send = [...document.querySelectorAll('button')].find(button => {
      const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''} ${button.getAttribute('data-testid') || ''}`;
      return /send|提交|发送/i.test(label) && !button.disabled;
    });
    if (!send) return resolve({submitted:false, completed:false, reason:'找不到 Grok 发送按钮'});

    let settled = false;
    let observer;
    let timer;
    let interval;
    let previousText = '';
    let stableSamples = 0;
    const finish = result => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearTimeout(timer);
      clearInterval(interval);
      resolve(result);
    };
    const inspect = () => {
      const count = copyButtons().length;
      const text = document.body?.innerText || '';
      const labels = [...document.querySelectorAll('button,[role="button"]')].map(button =>
        `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.innerText || ''}`.trim());
      const stillGenerating = labels.some(label => /^stop(?: generating)?$|^停止(?:生成)?$/i.test(label));
      const nonceNode = nonce && [...document.querySelectorAll('*')].find(el =>
        el.children.length === 0 && String(el.textContent || '').includes(nonce));
      const hasNewSuggestion = nonceNode && suggestionButtons().some(button =>
        !initialSuggestions.has(button) &&
        (nonceNode.compareDocumentPosition(button) & 4) !== 0
      );
      if (count <= initialCopyCount || stillGenerating || !hasNewSuggestion || !hasStructuredResult(text)) {
        previousText = '';
        stableSamples = 0;
        return;
      }
      if (text === previousText) stableSamples++;
      else { previousText = text; stableSamples = 1; }
      if (stableSamples >= 4) finish({submitted:true, completed:true, copyButtonCount:count, text});
    };
    observer = new MutationObserver(inspect);
    observer.observe(document.body || document.documentElement, {
      subtree:true, childList:true, attributes:true,
      attributeFilter:['aria-label','title','data-testid']
    });
    timer = setTimeout(() => finish({
      submitted:true, completed:false, reason:'等待 Grok 回复的复制按钮出现超时',
      text:document.body?.innerText || ''
    }), Math.max(1000, Number(timeoutMs) || 75000));
    interval = setInterval(inspect, Math.max(1, Number(sampleIntervalMs) || 1500));
    send.click();
    inspect();
  });
}

/** X 的字数权重：CJK 等宽字符计 2，其余计 1。 */
export function tweetWeight(text) {
  let n = 0;
  for (const ch of String(text || '')) n += /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}

export function makeNonce() {
  return `任务编号${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Require an explicit completion signal and repeated identical answer samples. */
export function createStableAnswerGate(requiredSamples = 4) {
  let previous = '';
  let samples = 0;
  const needed = Math.max(2, Number(requiredSamples) || 4);
  return (answer, complete) => {
    const current = String(answer || '').trim();
    if (!complete || !current) {
      previous = '';
      samples = 0;
      return false;
    }
    if (current === previous) samples++;
    else { previous = current; samples = 1; }
    return samples >= needed;
  };
}

export function buildGrokCommentPrompt({ handle, name, postText, nonce }) {
  return [
    `你是推特（X）上真实、自然的用户。请针对博主 @${handle}（昵称：${name || handle}）的下面这条推文，写一段适合“引用原帖”发布的评价。它会作为一条独立帖子公开发布，并嵌入原帖卡片，不是发给作者的站内回复。`,
    '要求：',
    '1. 评价正文 25~80 个汉字（若推文是英文则用英文，40~140 个字符）；',
    '2. 紧扣原帖具体内容，表达一个清楚、有价值的观点或补充信息，适合公开传播；不要写成对作者发问的回复，不要只复述原帖；',
    '3. 不要出现“作为AI”“非常赞同”等套话，不要带话题标签和外部链接，不要额外 @ 任何人；',
    `4. 只输出一次，并且必须用 ${START} 和 ${END} 把评价正文包起来，标记之外不要写任何解释。`,
    '',
    '推文正文：',
    String(postText || '').slice(0, 500),
    '',
    nonce
  ].join('\n');
}

/** 从 Grok 的回答里取出引用评价正文；格式不对、占位符、超长都返回空串。 */
export function extractGrokComment(raw) {
  const text = String(raw || '');
  const s = text.lastIndexOf(START);
  if (s < 0) return '';
  const rest = text.slice(s + START.length);
  const e = rest.indexOf(END);
  if (e < 0) return '';
  const body = rest.slice(0, e).replace(/\s+/g, ' ').trim().replace(/^["'“‘「]+|["'”’」]+$/g, '').trim();
  if (body.length < 4) return '';
  if (/你的评论内容|评论正文|此处填写/.test(body)) return '';
  if (tweetWeight(body) > X_QUOTE_LIMIT) return '';
  return body;
}

// ---------------- in-page：x.com/i/grok ----------------

/** in-page */
export function driveGrokInput(prompt) {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const findInput = () => {
      const root = document.getElementById('react-root') || document.body;
      if (!root) return null;
      return Array.prototype.find.call(document.querySelectorAll('textarea,[contenteditable="true"]'), el => {
        const rect = el.getBoundingClientRect();
        return root.contains(el) && rect.width > 100 && rect.height > 0 && rect.bottom > 0 && rect.top < (window.innerHeight || 1000);
      }) || null;
    };
    const findBtn = () => Array.prototype.find.call(document.querySelectorAll('button,[role="button"]'), b =>
      /Grok something|send|submit|提交|发送/i.test(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-testid') || ''} ${b.innerText || ''}`));
    const ready = b => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    const readInput = el => el.tagName === 'TEXTAREA' ? el.value : (el.innerText || el.textContent || '');
    // Lexical may drop paragraph boundaries rather than turning them into spaces.
    // Ignore whitespace completely for the acceptance check, while requiring every
    // non-whitespace character of the prompt to be present.
    const normalizeInput = text => String(text || '').replace(/[\s\u00a0]+/g, '');

    let el = null;
    for (let i = 0; i < 40 && !el; i++) { el = findInput(); if (!el) await sleep(500); }
    if (!el) return { ok: false, err: 'Grok 输入框未挂载' };
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(el, prompt) : (el.value = prompt);
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    } else {
      el.focus();
      const inserted = document.execCommand('insertText', false, prompt);
      // Lexical/contenteditable 会由 execCommand 触发真实 input。再合成一次 input 会让
      // Lexical 把同一段文本插入两遍；只有浏览器未能插入时才用 DOM + 单次事件兜底。
      if (!inserted && !readInput(el).includes(prompt)) {
        el.textContent = prompt;
        el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:prompt}));
      }
    }
    let accepted = false;
    for (let i = 0; i < 12; i++) {
      // Lexical may replace the editable node while committing the input event.
      const currentInput = findInput() || el;
      // Lexical serializes line breaks as separate paragraphs and innerText may expose
      // them as spaces. Compare normalized visible text so an accepted prompt is not
      // mistaken for a failed insertion merely because whitespace was canonicalized.
      if (normalizeInput(readInput(currentInput)).includes(normalizeInput(prompt))) { el = currentInput; accepted = true; break; }
      await sleep(100);
    }
    if (!accepted) return { ok: false, err: '输入框未收下 prompt' };

    let btn = null;
    for (let i = 0; i < 24; i++) { btn = findBtn(); if (ready(btn)) break; await sleep(250); }
    if (ready(btn)) btn.click();
    else {
      el.focus();
      const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, key));
    }
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const input = findInput();
      if (!input || !readInput(input).trim()) return { ok: true };
    }
    return { ok: false, err: '提交后输入框仍未清空，Grok 可能没有收到问题' };
  })();
}

/** in-page：通用读取（x.com 与 grok.com 共用），返回 nonce 之后的页面文字。 */
export function readGrokPageAnswer(nonce) {
  const t = (document.getElementById('react-root') ? (document.querySelector('[data-testid=primaryColumn]') || document.body) : document.body).innerText || '';
  const i = t.lastIndexOf(nonce);
  if (i < 0) return { text: '', done: false };
  const labels = Array.prototype.map.call(document.querySelectorAll('button'), b => b.getAttribute('aria-label') || b.innerText || '');
  // X may show Copy message before completion. The follow-up prompt chips appear only
  // after the answer, and they must follow this request's nonce in document order.
  const nonceNode = Array.prototype.find.call(document.querySelectorAll('*'), el =>
    el.children.length === 0 && String(el.textContent || '').includes(nonce));
  const suggestionSelector = 'button span.min-w-0.overflow-x-clip.text-ellipsis.whitespace-nowrap';
  const hasFollowUpSuggestion = Boolean(nonceNode && Array.prototype.some.call(
    document.querySelectorAll(suggestionSelector), span => {
      const button = span.closest('button');
      return button && String(span.innerText || span.textContent || '').trim() &&
        (nonceNode.compareDocumentPosition(button) & 4) !== 0;
    }
  ));
  const isX = location.hostname === 'x.com';
  const completionSignal = isX ? hasFollowUpSuggestion : labels.some(l => /Regenerate|重新生成/i.test(l));
  const done = completionSignal && !labels.some(l => /^Stop( generating)?$|^停止/i.test(l.trim()));
  const failed = /Grok was unable to reply|Something went wrong, please refresh|操作过于频繁|无法回复/.test(t.slice(i));
  if (failed) {
    const leaf = Array.prototype.find.call(document.querySelectorAll('span,div,button'),
      e => e.children.length === 0 && /^(Retry|重试)$/i.test((e.innerText || '').trim()));
    if (leaf) (leaf.closest('button,[role=button]') || leaf).click();
    return { text: '', done: false, failed: true };
  }
  return { text: t.slice(i + nonce.length), done };
}

/** in-page：grok.com 探测 + 提交。 */
export function driveGrokComInput(prompt) {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    if (/\/(login|sign-?in)/i.test(location.pathname)) return { ok: false, err: 'grok.com 未登录' };
    let el = null;
    for (let i = 0; i < 30 && !el; i++) {
      el = document.querySelector('textarea, div[contenteditable="true"]');
      if (!el) await sleep(500);
    }
    if (!el) return { ok: false, err: 'grok.com 未找到输入框（可能未登录或未开通）' };
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(el, prompt) : (el.value = prompt);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.focus();
      document.execCommand('insertText', false, prompt);
    }
    await sleep(500);
    const btn = document.querySelector('button[type="submit"], button[aria-label*="Submit"], button[aria-label*="Send"]');
    if (btn && !btn.disabled) btn.click();
    else {
      el.focus();
      const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, key));
    }
    return { ok: true };
  })();
}

// ---------------- 调度 ----------------

let streamResolver = null;
/** 后台/面板收到 bridge 转来的 grokStreamAnswer 时调用 */
export function deliverGrokStream(text) {
  if (!streamResolver) return;
  const r = streamResolver; streamResolver = null; r(String(text || ''));
}

async function openMinimized(url) {
  const win = await createBackgroundGrokWindow(url);
  const tabId = win.tabs?.[0]?.id || (await chrome.tabs.query({ windowId: win.id }))?.[0]?.id;
  return { winId: win.id, tabId };
}

async function askOnX(prompt, nonce, sleep) {
  const stable = createStableAnswerGate(4);
  const { winId, tabId } = await openMinimized('https://x.com/i/grok');
  try {
    if (!tabId) return { ok: false, reason: '无法创建 Grok 窗口' };
    const probe = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
      const t = (document.body?.innerText || '').slice(0, 3000);
      return /Subscribe to Premium|Upgrade to Premium|not available in your region/i.test(t) ? 'paywall' : 'ok';
    } }).catch(() => []))?.[0]?.result;
    if (probe === 'paywall') return { ok: false, reason: 'x.com 账号未开通 Grok' };
    const drive = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: driveGrokInput, args: [prompt] })
      .catch(e => [{ result: { ok: false, err: String(e?.message || e) } }]))?.[0]?.result;
    if (!drive?.ok) return { ok: false, reason: `x.com Grok：${drive?.err || '提交失败'}` };
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const dom = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readGrokPageAnswer, args: [nonce] })
        .catch(() => []))?.[0]?.result;
      const fromDom = extractGrokComment(dom?.text);
      if (stable(fromDom, Boolean(dom?.done))) return { ok: true, reply: fromDom, channel: 'x.com' };
    }
    return { ok: false, reason: 'x.com Grok 60 秒内没有给出符合格式的引用评价' };
  } finally {
    if (winId) await chrome.windows.remove(winId).catch(() => {});
  }
}

async function askOnGrokCom(prompt, nonce, sleep) {
  const stable = createStableAnswerGate(4);
  const { winId, tabId } = await openMinimized('https://grok.com/');
  try {
    if (!tabId) return { ok: false, reason: '无法创建 grok.com 窗口' };
    await sleep(3000);
    const drive = (await chrome.scripting.executeScript({ target: { tabId }, func: driveGrokComInput, args: [prompt] })
      .catch(e => [{ result: { ok: false, err: String(e?.message || e) } }]))?.[0]?.result;
    if (!drive?.ok) return { ok: false, reason: drive?.err || 'grok.com 提交失败' };
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(2500);
      const dom = (await chrome.scripting.executeScript({ target: { tabId }, func: readGrokPageAnswer, args: [nonce] })
        .catch(() => []))?.[0]?.result;
      const reply = extractGrokComment(dom?.text);
      if (stable(reply, Boolean(dom?.done))) return { ok: true, reply, channel: 'grok.com' };
    }
    return { ok: false, reason: 'grok.com 60 秒内没有给出符合格式的评论' };
  } finally {
    if (winId) await chrome.windows.remove(winId).catch(() => {});
  }
}

/**
 * 让 Grok 针对一条推文写引用评价。先 x.com，失败再 grok.com，两者都不行才算不可用。
 * 永远返回对象：成功 {ok:true, reply, channel, postText, postUrl}；失败 {ok:false, reason}。
 */
export async function requestGrokComment(handle, post, authorName, { sleep, fix = s => s }) {
  const postText = String(post?.text || '').trim();
  if (!postText) return { ok: false, reason: '帖子没有正文' };
  const cleanHandle = String(handle || '').replace(/^@/, '');
  const nonce = makeNonce();
  const prompt = buildGrokCommentPrompt({ handle: cleanHandle, name: fix(authorName || cleanHandle), postText, nonce });
  const reasons = [];
  for (const ask of [askOnX, askOnGrokCom]) {
    try {
      const res = await ask(prompt, nonce, sleep);
      if (res.ok) return { ...res, postText: postText.slice(0, 140), postUrl: post.url || '' };
      reasons.push(res.reason);
    } catch (e) { reasons.push(String(e?.message || e)); }
  }
  return { ok: false, reason: reasons.join('；') };
}

/**
 * 通用向 Grok 提问函数（用于辅助编程、生成算法、多维标签分析等）。
 * 自动适配 x.com/i/grok 与 grok.com，等待回答全部生成后返回完整 Markdown 文本。
 */
export async function requestGrokText(userPrompt, { sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 90000 } = {}) {
  const nonce = makeNonce();
  const fullPrompt = `${userPrompt}\n\n[任务凭证：${nonce}]`;
  const reasons = [];

  async function askTextOnX() {
    const { winId, tabId } = await openMinimized('https://x.com/i/grok');
    try {
      if (!tabId) return { ok: false, reason: '无法创建 Grok 窗口' };
      const probe = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
        const t = (document.body?.innerText || '').slice(0, 3000);
        return /Subscribe to Premium|Upgrade to Premium|not available in your region/i.test(t) ? 'paywall' : 'ok';
      } }).catch(() => []))?.[0]?.result;
      if (probe === 'paywall') return { ok: false, reason: 'x.com 账号未开通 Grok' };
      const drive = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: driveGrokInput, args: [fullPrompt] })
        .catch(e => [{ result: { ok: false, err: String(e?.message || e) } }]))?.[0]?.result;
      if (!drive?.ok) return { ok: false, reason: `x.com Grok 提交失败: ${drive?.err || ''}` };

      const deadline = Date.now() + timeoutMs;
      const stable = createStableAnswerGate(4);
      while (Date.now() < deadline) {
        await sleep(2000);
        const dom = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readGrokPageAnswer, args: [nonce] })
          .catch(() => []))?.[0]?.result;
        if (dom?.failed) return { ok: false, reason: 'Grok 回复异常或触发风控' };
        const text = String(dom?.text || '').trim();
        if (stable(text, Boolean(dom?.done))) return { ok: true, text, channel: 'x.com' };
      }
      return { ok: false, reason: 'x.com Grok 生成超时' };
    } finally {
      if (winId) await chrome.windows.remove(winId).catch(() => {});
    }
  }

  async function askTextOnGrokCom() {
    const { winId, tabId } = await openMinimized('https://grok.com/');
    try {
      if (!tabId) return { ok: false, reason: '无法创建 grok.com 窗口' };
      await sleep(3000);
      const drive = (await chrome.scripting.executeScript({ target: { tabId }, func: driveGrokComInput, args: [fullPrompt] })
        .catch(e => [{ result: { ok: false, err: String(e?.message || e) } }]))?.[0]?.result;
      if (!drive?.ok) return { ok: false, reason: `grok.com 提交失败: ${drive?.err || ''}` };

      const deadline = Date.now() + timeoutMs;
      const stable = createStableAnswerGate(4);
      while (Date.now() < deadline) {
        await sleep(2500);
        const dom = (await chrome.scripting.executeScript({ target: { tabId }, func: readGrokPageAnswer, args: [nonce] })
          .catch(() => []))?.[0]?.result;
        if (dom?.failed) return { ok: false, reason: 'grok.com 回复异常' };
        const text = String(dom?.text || '').trim();
        if (stable(text, Boolean(dom?.done))) return { ok: true, text, channel: 'grok.com' };
      }
      return { ok: false, reason: 'grok.com 生成超时' };
    } finally {
      if (winId) await chrome.windows.remove(winId).catch(() => {});
    }
  }

  for (const ask of [askTextOnX, askTextOnGrokCom]) {
    try {
      const res = await ask();
      if (res.ok) return res;
      reasons.push(res.reason);
    } catch (e) {
      reasons.push(String(e?.message || e));
    }
  }
  return { ok: false, reason: reasons.join('；') };
}

/**
 * 把 Grok 评价作为引用帖发布：打开原帖详情页 → Quote/引用 → 发布并校验。
 * 返回 {ok} 或 {ok:false, reason}。
 */
export async function postQuoteOnTab(tabId, post, text, publishFn, sleep) {
  const url = String(post?.url || '');
  if (!/\/status\/\d+/.test(url)) return { ok: false, reason: '该帖没有可用的帖子链接' };
  const expectedPostText = String(post?.text || post?.postText || '').trim();
  const expectedHandle = String(post?.handle || post?.username || new URL(url).pathname.split('/')[1] || '').replace(/^@/, '');
  const dismissDraft = () => chrome.scripting.executeScript({target:{tabId}, func:dismissQuoteComposerOnPage, args:[url, expectedPostText, expectedHandle]}).catch(() => []);
  await chrome.tabs.update(tabId, { url });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return { ok: false, reason: '帖子标签页已关闭' };
    if (t.status === 'complete') break;
    await sleep(500);
  }
  await sleep(1500);
  const opened = (await chrome.scripting.executeScript({ target: { tabId }, func: openQuoteComposerOnPage, args: [url] })
    .catch(e => [{ result: { ok: false, reason: String(e?.message || e) } }]))?.[0]?.result;

  // X 选择 Quote 会从帖子页切换到 /compose/post；原页面注入可能因路由导航被销毁。
  // 不把这类导航错误当作发布失败，等新路由上的引用编辑框确实就绪后重新注入发布阶段。
  const composerDeadline = Date.now() + 20000;
  let composerReady = false;
  while (Date.now() < composerDeadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, reason: '引用帖标签页已关闭' };
    if (tab.status !== 'complete') { await sleep(300); continue; }
    const state = (await chrome.scripting.executeScript({ target: { tabId }, func: inspectQuoteComposerOnPage, args: [url, expectedPostText, expectedHandle] })
      .catch(() => []))?.[0]?.result;
    if (state?.reason?.includes('不是 Quote')) {
      await dismissDraft();
      return { ok:false, reason:state.reason };
    }
    if (state?.ok && state.ready && String(state.originalUrl || '').includes(new URL(url).pathname)) {
      composerReady = true;
      break;
    }
    await sleep(300);
  }
  if (!composerReady) {
    await dismissDraft();
    return { ok: false, reason: opened?.reason || 'X 未显示嵌入目标原帖的引用编辑框；已关闭未完成的引用草稿' };
  }

  const res = (await chrome.scripting.executeScript({ target: { tabId }, func: publishFn, args: [url, text, expectedPostText, expectedHandle] })
    .catch(e => [{ result: { ok: false, reason: String(e?.message || e) } }]))?.[0]?.result;
  if (!res?.ok) await dismissDraft();
  return res || { ok: false, reason: '引用帖发布脚本无返回' };
}
