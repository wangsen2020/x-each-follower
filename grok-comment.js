// Grok 取评 + 发评的共用模块。面板（互关追踪）与后台（评论追踪定时任务）都调用这里。
// 带 "in-page" 标记的函数会经 chrome.scripting.executeScript 序列化注入页面，必须自包含。

export const START = '【回评开始】';
export const END = '【回评结束】';
const X_REPLY_LIMIT = 280;

/** X 的字数权重：CJK 等宽字符计 2，其余计 1。 */
export function tweetWeight(text) {
  let n = 0;
  for (const ch of String(text || '')) n += /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}

export function makeNonce() {
  return `任务编号${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function buildGrokCommentPrompt({ handle, name, postText, nonce }) {
  return [
    `你是推特（X）上很会互动的真实用户。请针对博主 @${handle}（昵称：${name || handle}）的下面这条推文，写一条自然、有共鸣、能引发对方回复的评论。`,
    '要求：',
    '1. 评论正文 25~80 个汉字（若推文是英文则用英文，40~140 个字符）；',
    '2. 紧扣推文具体内容，给出真诚的观点、共鸣或一个具体的问题，不要空泛客套；',
    '3. 不要出现“作为AI”“非常赞同”等套话，不要带话题标签和链接，不要 @ 任何人；',
    `4. 只输出一次，并且必须用 ${START} 和 ${END} 把评论正文包起来，标记之外不要写任何解释。`,
    '',
    '推文正文：',
    String(postText || '').slice(0, 500),
    '',
    nonce
  ].join('\n');
}

/** 从 Grok 的回答里取出评论正文；格式不对、占位符、超长都返回空串。 */
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
  if (tweetWeight(body) > X_REPLY_LIMIT) return '';
  return body;
}

// ---------------- in-page：x.com/i/grok ----------------

/** in-page */
export function driveGrokInput(prompt) {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const findTa = () => {
      const root = document.getElementById('react-root');
      if (!root) return null;
      return Array.prototype.find.call(document.querySelectorAll('textarea'),
        t => root.contains(t) && t.offsetParent !== null && t.getBoundingClientRect().width > 100) || null;
    };
    const findBtn = () => Array.prototype.find.call(document.querySelectorAll('button'), b =>
      /Grok something|send|提交|发送/i.test(`${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`));
    const ready = b => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

    let el = null;
    for (let i = 0; i < 40 && !el; i++) { el = findTa(); if (!el) await sleep(500); }
    if (!el) return { ok: false, err: 'Grok 输入框未挂载' };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter ? setter.call(el, prompt) : (el.value = prompt);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (el.value !== prompt) return { ok: false, err: '输入框未收下 prompt' };

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
      const ta = findTa();
      if (!ta || ta.value === '') return { ok: true };
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
  const done = labels.some(l => /Regenerate|Copy text|重新生成|复制文本/i.test(l)) &&
    !labels.some(l => /^Stop( generating)?$|^停止/i.test(l.trim()));
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
  const win = await chrome.windows.create({ url, type: 'popup', state: 'minimized', focused: false });
  const tabId = win.tabs?.[0]?.id || (await chrome.tabs.query({ windowId: win.id }))?.[0]?.id;
  return { winId: win.id, tabId };
}

async function askOnX(prompt, nonce, sleep) {
  let streamText = '';
  streamResolver = t => { streamText = t; };
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
      const fromStream = extractGrokComment(streamText);
      if (fromStream) return { ok: true, reply: fromStream, channel: 'x.com' };
      await sleep(2000);
      const dom = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readGrokPageAnswer, args: [nonce] })
        .catch(() => []))?.[0]?.result;
      const fromDom = extractGrokComment(dom?.text);
      if (fromDom) return { ok: true, reply: fromDom, channel: 'x.com' };
    }
    return { ok: false, reason: 'x.com Grok 60 秒内没有给出符合格式的评论' };
  } finally {
    streamResolver = null;
    if (winId) await chrome.windows.remove(winId).catch(() => {});
  }
}

async function askOnGrokCom(prompt, nonce, sleep) {
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
      if (reply) return { ok: true, reply, channel: 'grok.com' };
    }
    return { ok: false, reason: 'grok.com 60 秒内没有给出符合格式的评论' };
  } finally {
    if (winId) await chrome.windows.remove(winId).catch(() => {});
  }
}

/**
 * 让 Grok 针对一条推文写评论。先 x.com，失败再 grok.com，两者都不行才算不可用。
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
 * 把评论发到指定帖子下：在 tabId 里打开该帖详情页 → 回复 → 校验发出。
 * 返回 {ok} 或 {ok:false, reason}。
 */
export async function postReplyOnTab(tabId, post, text, publishFn, sleep) {
  const url = String(post?.url || '');
  if (!/\/status\/\d+/.test(url)) return { ok: false, reason: '该帖没有可用的帖子链接' };
  await chrome.tabs.update(tabId, { url });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return { ok: false, reason: '帖子标签页已关闭' };
    if (t.status === 'complete') break;
    await sleep(500);
  }
  await sleep(1500);
  const res = (await chrome.scripting.executeScript({ target: { tabId }, func: publishFn, args: [url, text] })
    .catch(e => [{ result: { ok: false, reason: String(e?.message || e) } }]))?.[0]?.result;
  return res || { ok: false, reason: '发表脚本无返回' };
}
