import {waitForGrokVerification, grokTaskNow, assertPendingGrokVerificationClear, executeGrokScript} from './grok-verification.js';
import {createTemporaryWindow, closeTemporaryWindow, acquireGrokWindow, releaseGrokWindow} from './temporary-windows.js';
import {requestGrokComPersistentSession} from './grok-session-manager.js';
// Grok 生成引用评价 + 发布引用帖的共用模块。面板与评论追踪后台任务都调用这里。
// 带 "in-page" 标记的函数会经 chrome.scripting.executeScript 序列化注入页面，必须自包含。
import { openQuoteComposerOnPage, inspectQuoteComposerOnPage, dismissQuoteComposerOnPage, setQuoteFrameFallbackOnPage } from './page-reader.js';

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

export async function createBackgroundGrokWindow(url, lifetime) {
  if (url && url.includes('grok.com')) {
    throw new Error('grok.com 窗口禁止通过临时窗口池创建，必须统一由 Grok 会话协调器管理');
  }
  await assertPendingGrokVerificationClear();
  return acquireGrokWindow(url, lifetime);
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
    const locateNonce = targetNonce => {
      if (!targetNonce) return null;
      if (typeof document !== 'undefined' && typeof document.createTreeWalker === 'function' && document.body) {
        try {
          const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
          let tn;
          let found = null;
          while ((tn = walker.nextNode())) {
            if (tn.nodeValue && tn.nodeValue.includes(targetNonce)) {
              found = tn.parentElement || tn;
            }
          }
          if (found) return found;
        } catch (_) {}
      }
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        const all = Array.prototype.filter.call(document.querySelectorAll('*'), el =>
          String(el?.textContent || '').includes(targetNonce));
        if (!all.length) return null;
        const leaves = all.filter(el => el.children?.length === 0);
        if (leaves.length) return leaves[leaves.length - 1];
        all.sort((a, b) => (String(a?.textContent || '').length) - (String(b?.textContent || '').length));
        return all[0];
      }
      return null;
    };
    const inspect = () => {
      const count = copyButtons().length;
      const text = document.body?.innerText || '';
      const labels = [...document.querySelectorAll('button,[role="button"]')].map(button =>
        `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.innerText || ''}`.trim());
      const stillGenerating = labels.some(label => /^stop(?: generating)?$|^停止(?:生成)?$/i.test(label));
      const nonceNode = nonce && locateNonce(nonce);
      const isAfterNonce = el => Boolean(nonceNode && (nonceNode.compareDocumentPosition(el) & 4) !== 0);
      const hasNewSuggestion = nonceNode && suggestionButtons().some(button =>
        !initialSuggestions.has(button) && isAfterNonce(button)
      );
      const hasNewAction = nonceNode && [...document.querySelectorAll('button,[role="button"]')].some(button => {
        if (!isAfterNonce(button)) return false;
        const aria = String(button.getAttribute('aria-label') || '').trim();
        const text = String(button.innerText || button.textContent || '').trim();
        return /^Regenerate$|^重新生成$/i.test(aria || text) ||
               /^Good response$|^Bad response$/i.test(aria) ||
               /^Copy$|^复制$/i.test(aria || text);
      });
      if (count <= initialCopyCount || stillGenerating || (!hasNewSuggestion && !hasNewAction) || !hasStructuredResult(text)) {
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

export function createGrokAnswerGate(signalSamples = 4, contentSamples = 5) {
  const signaled = createStableAnswerGate(signalSamples);
  const unchanged = createStableAnswerGate(contentSamples);
  return (state, answer) => {
    const streamComplete = state?.network?.status === 'complete';
    const usable = Boolean(answer && !state?.failed && (!state?.stillGenerating || streamComplete));
    const content = state?.contentSignature || String(state?.text || '').trim();
    const stableContent = unchanged(content, usable);
    const endMarker = Boolean(extractGrokComment(state?.text || ''));
    const stableSignal = signaled(answer, usable && Boolean(endMarker || state?.done || streamComplete));
    if (stableSignal && endMarker) return 'end-marker';
    return stableSignal ? streamComplete ? state.network.transport === 'websocket' ? 'network-response.done' : 'network-eof' : 'completion-signal' : stableContent ? 'stable-content' : '';
  };
}

export function buildGrokCommentPrompt({ handle, name, postText, nonce }) {
  return [
    `你是推特（X）上真实、自然的用户。请针对博主 @${handle}（昵称：${name || handle}）的下面这条推文，写一段适合“引用原帖”发布的评价。它会作为一条独立帖子公开发布，并嵌入原帖卡片，不是发给作者的站内回复。`,
    '要求：',
    '1. 只写一句完整评价，正文 25~50 个汉字；其他语言原帖使用原帖语言，约 50~100 个字符，不附中文翻译。',
    '2. 抓原帖一个具体细节，从反常识、隐性代价或矛盾切入，开头就亮出鲜明判断，写得尖锐、有情绪张力，让人想赞同或反驳；无争议就别硬造。',
    '3. 可以用夸张比喻放大感受，但不能夸大事实、数字或编造动机；不奉承、不复述、不向作者提问，不加标签或链接。',
    `4. 只输出这一句，用 ${START} 和 ${END} 包住正文；随后单独输出【评价语言:xx】，xx 必须是评价正文的 ISO 639-1 语言代码（如 zh、en、es、pt），不能按作者所在地猜测。`,
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

/** Prefer explicit model metadata; legacy drafts only infer scripts with high confidence. */
export function resolveCommentLanguage(text, declared = '') {
  const code = String(declared).trim().toLowerCase().split('-')[0];
  const body = String(text || '').replace(/#[\p{L}\p{M}\p{N}_]+/gu, '').replace(/有关必回|关注必回|互关必回/g, '');
  const han = (body.match(/\p{Script=Han}/gu) || []).length;
  const latin = (body.match(/[a-z]/gi) || []).length;
  if (/^[a-z]{2}$/.test(code) && code !== 'un') {
    // Reject an obviously contradictory Chinese label on an English body.
    if (code === 'zh' && !han && latin > 3) return 'en';
    return code;
  }
  if (han > 0 && han * 2 >= latin) return 'zh';
  if (/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(body)) return 'und';
  if (latin > 3 && !/[^\x00-\x7f]/.test(body.replace(/[’‘“”—–…]/g, ''))) return 'en';
  return 'und';
}
export function extractGrokCommentLanguage(raw) {
  const text = String(raw || '');
  const tail = text.slice(text.lastIndexOf(START));
  const declared = tail.match(/【评价语言[:：]\s*([a-z]{2}(?:-[a-z]+)?)\s*】/i)?.[1];
  return resolveCommentLanguage(extractGrokComment(raw), declared);
}

/**
 * 在引用评价结尾追加吸引关注的文案（如“有关必回”）。
 * 若已有相关文案则不重复追加，并保证字数不超限。
 */
export function appendFollowBackSuffix(text, suffix, language) {
  let base = String(text || '').trim();
  if (!base) return '';
  const lang = resolveCommentLanguage(base, language);
  if (lang !== 'zh') base = base.replace(/[。.!?\s]*(有关必回|关注必回|互关必回)\s*$/u, '').trim();
  const defaults = {zh:'有关必回',en:'I follow back.',es:'Te sigo de vuelta.',pt:'Sigo de volta.'};
  const cleanSuffix = String(suffix ?? defaults[lang] ?? '').trim();
  if (cleanSuffix && base.toLowerCase().endsWith(cleanSuffix.toLowerCase())) return base;
  if (!cleanSuffix || /有关必回|关注必回|互关必回/i.test(base)) return base;
  const separator = lang === 'zh' ? (/[。！？!?…]$/.test(base) ? '' : '。') : (/[.!?…]$/.test(base) ? ' ' : '. ');
  let combined = `${base}${separator}${cleanSuffix}`;
  if (tweetWeight(combined) > X_QUOTE_LIMIT) {
    while (base.length > 0 && tweetWeight(combined) > X_QUOTE_LIMIT) {
      base = base.slice(0, -1).trim();
      combined = `${base}${separator}${cleanSuffix}`;
    }
  }
  return combined;
}

// ---------------- in-page：x.com/i/grok ----------------

/** in-page */
export function driveGrokInput(prompt) {
  // Lexical can drop isolated paragraphs during a multiline insertText (observed
  // with a standalone S). A single paragraph preserves every non-whitespace
  // character; keep the strict input acceptance check below.
  prompt = String(prompt || '').replace(/\r?\n/g, ' ');
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
      document.execCommand('insertText', false, prompt);
      // Lexical commits asynchronously; wait and check before falling back
      let inserted = false;
      for (let i = 0; i < 4; i++) {
        await sleep(100);
        const cur = findInput() || el;
        if (normalizeInput(readInput(cur)).includes(normalizeInput(prompt))) {
          inserted = true;
          break;
        }
      }
      // 若 execCommand 未能成功填入（如后台未激活窗口），使用标准的 ClipboardEvent paste 事件注入（现代 Lexical 最稳定标准机制）
      if (!inserted) {
        const cur = findInput() || el;
        cur.focus();
        try {
          if (typeof DataTransfer !== 'undefined' && typeof ClipboardEvent !== 'undefined') {
            const dt = new DataTransfer();
            dt.setData('text/plain', prompt);
            const pasteEvent = new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: dt
            });
            cur.dispatchEvent(pasteEvent);
          }
        } catch (_) {}
        for (let i = 0; i < 4; i++) {
          await sleep(100);
          const cur2 = findInput() || el;
          if (normalizeInput(readInput(cur2)).includes(normalizeInput(prompt))) {
            inserted = true;
            break;
          }
        }
      }
      // DOM + inputEvent 终极兜底
      if (!inserted) {
        const fallback = findInput() || el;
        fallback.textContent = prompt;
        if (typeof InputEvent !== 'undefined') {
          fallback.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:prompt}));
        } else if (typeof Event !== 'undefined') {
          fallback.dispatchEvent(new Event('input', {bubbles:true}));
        }
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

/** 在页面 DOM 中可靠定位包含 nonce 的最深叶子元素/容器 */
export function findNonceNode(nonce) {
  if (!nonce) return null;
  // 1. 优先通过 TreeWalker 搜索包含 nonce 的纯文本叶子节点并返回其宿主元素（兼容带标签、艾特、链接或换行的 prompt）
  if (typeof document !== 'undefined' && typeof document.createTreeWalker === 'function' && document.body) {
    try {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let tn;
      let found = null;
      while ((tn = walker.nextNode())) {
        if (tn.nodeValue && tn.nodeValue.includes(nonce)) {
          found = tn.parentElement || tn;
        }
      }
      if (found) return found;
    } catch (_) {}
  }
  // 2. 备用与测试桩兼容：在所有匹配节点中选取文本最短的最深节点，同时保留原先 children.length === 0 的优先兼容
  if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
    const all = Array.prototype.filter.call(document.querySelectorAll('*'), el =>
      String(el?.textContent || '').includes(nonce));
    if (!all.length) return null;
    const leaves = all.filter(el => el.children?.length === 0);
    if (leaves.length) return leaves[leaves.length - 1];
    all.sort((a, b) => (String(a?.textContent || '').length) - (String(b?.textContent || '').length));
    return all[0];
  }
  return null;
}

/** in-page：通用读取（x.com 与 grok.com 共用），返回 nonce 之后的页面文字。 */
export function readGrokPageAnswer(nonce) {
  const stream = typeof window !== 'undefined' ? window.__xefGrokStream : null;
  const network = stream?.nonce === nonce ? {
    requestId:stream.requestId, status:stream.status, chunks:stream.chunks,
    transport:stream.transport || 'http', responseId:stream.responseId || '', terminalEvent:stream.terminalEvent || '',
    quietForMs:Date.now() - (stream.lastChunkAt || stream.startedAt),
    endedAt:stream.endedAt, httpStatus:stream.httpStatus
  } : null;
  // Current X transcript exposes a turn ID and a separate quotable assistant
  // message. Never cut a whole page at the last nonce: the model can echo that
  // nonce, and rendered line breaks can split it even in the user bubble.
  const turns = Array.from(document.querySelectorAll('[data-turn-id]'));
  if (turns.length) {
    const normalize = value => String(value || '').replace(/\s+/g, '');
    const credential = normalize(nonce);
    const turn = credential && turns.find(candidate => Array.from(
      candidate.querySelectorAll('[class~="group/user"], [data-testid="user-message"]')
    ).some(message => normalize(message.textContent).includes(credential)));
    if (!turn) return {text:'', done:false, stage:'nonce_missing', source:'x-turn'};
    const turnId = turn.getAttribute('data-turn-id');
    const message = turn.querySelector('[data-quotable-message]');
    if (!message) return {text:'', done:false, stage:'waiting_answer', source:'x-turn', turnId};
    const blocks = Array.from(message.querySelectorAll('.grok-trace-soft-enter'));
    const text = blocks.map(block => String(block.innerText || block.textContent || '').trim()).filter(Boolean).join('\n\n');
    const contentDOM = blocks.map(block => block.innerHTML || block.textContent || '').join('\n');
    let contentHash = 2166136261;
    for (let i=0; i<contentDOM.length; i++) contentHash = Math.imul(contentHash ^ contentDOM.charCodeAt(i), 16777619);
    const label = button => String(button.getAttribute('aria-label') || button.getAttribute('title') || button.innerText || '').trim();
    const visible = button => {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      if (button.getClientRects && !button.getClientRects().length) return false;
      for (let node = button; node; node = node.parentElement) {
        if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      }
      return true;
    };
    const stops = Array.from(document.querySelectorAll('button, [role="button"]')).filter(button =>
      /^Stop(?: generating| response)?$|^停止(?:生成|响应|回答)?$/i.test(label(button)));
    const stillGenerating = stops.some(visible);
    const answerActions = Array.from((turn || message).querySelectorAll('button, [role="button"]')).some(button =>
      /^(?:Copy|复制|Regenerate|重新生成|Good response|Bad response|回答不错|回答不好)$/i.test(label(button)) ||
      Boolean(button.querySelector?.('svg[data-icon="icon-copy"], svg[data-icon="icon-regenerate"]')));
    const hasDelimiters = text.includes('【引用评价结束】') && !stillGenerating;
    const failed = !stillGenerating && /Grok was unable to reply|Something went wrong, please refresh|操作过于频繁|无法回复/.test(text);
    const done = Boolean(text && (answerActions || hasDelimiters) && !stillGenerating && !failed);
    return {text, done, failed, stillGenerating, source:'x-turn', turnId, network, contentSignature:String(contentHash >>> 0),
      answerActions, stopCount:stops.length, visibleStopCount:stops.filter(visible).length,
      stage:failed ? 'failed' : stillGenerating ? 'generating' : !text ? 'empty_answer' : done ? 'complete' : 'awaiting_completion'};
  }
  const locateNonce = targetNonce => {
    if (!targetNonce) return null;
    if (typeof document !== 'undefined' && typeof document.createTreeWalker === 'function' && document.body) {
      try {
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        let tn;
        let found = null;
        while ((tn = walker.nextNode())) {
          if (tn.nodeValue && tn.nodeValue.includes(targetNonce)) {
            found = tn.parentElement || tn;
          }
        }
        if (found) return found;
      } catch (_) {}
    }
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      const all = Array.prototype.filter.call(document.querySelectorAll('*'), el =>
        String(el?.textContent || '').includes(targetNonce));
      if (!all.length) return null;
      const leaves = all.filter(el => el.children?.length === 0);
      if (leaves.length) return leaves[leaves.length - 1];
      all.sort((a, b) => (String(a?.textContent || '').length) - (String(b?.textContent || '').length));
      return all[0];
    }
    return null;
  };

  const t = (document.getElementById('react-root') ? (document.querySelector('[data-testid=primaryColumn]') || document.body) : document.body).innerText || '';
  const i = t.lastIndexOf(nonce);
  if (i < 0) return { text: '', done: false };
  const labels = Array.prototype.map.call(document.querySelectorAll('button'), b => b.getAttribute('aria-label') || b.innerText || '');
  const stopGenerating = Array.prototype.some.call(document.querySelectorAll('button'), button => {
    const value = String(button.getAttribute('aria-label') || button.innerText || '').trim();
    if (!/^Stop(?: generating| response)?$|^停止/i.test(value)) return false;
    if (button.disabled || button.hidden || button.getAttribute('aria-hidden') === 'true' || button.getAttribute('aria-disabled') === 'true') return false;
    if (button.getClientRects && !button.getClientRects().length) return false;
    for (let node = button; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    }
    return true;
  });

  const nonceNode = locateNonce(nonce);
  const isAfterNonce = el => Boolean(nonceNode && (nonceNode.compareDocumentPosition(el) & 4) !== 0);

  // 1. 建议气泡按钮（后续追问建议）
  const suggestionSelector = 'button span.min-w-0.overflow-x-clip.text-ellipsis.whitespace-nowrap';
  const suggestionNodes = [...(document.querySelectorAll(suggestionSelector) || [])];
  if (!suggestionNodes.length) {
    suggestionNodes.push(...(document.querySelectorAll('button span.min-w-0, button[data-slot="xds-button"]') || []));
  }
  const hasFollowUpSuggestion = Boolean(nonceNode && suggestionNodes.some(span => {
    const button = span.closest ? span.closest('button') : span;
    if (!button || !isAfterNonce(button)) return false;
    const text = String(span.innerText || span.textContent || button.innerText || '').trim();
    return text && !/^Think Harder$|^Auto$|^历史$|^私密$/i.test(text);
  }));

  // 2. 回复卡片的操作按钮（Regenerate / Good response / Bad response / Copy 等）
  // 注意：在 Prompt 气泡上只有 "Copy message" 与 "Edit message"；在 Grok 回复卡片上是独立的 "Copy"、"Regenerate"、"Good response"、"Bad response"、"Share"
  const hasAnswerActions = Boolean(nonceNode && Array.prototype.some.call(
    document.querySelectorAll('button'), button => {
      if (!isAfterNonce(button)) return false;
      const aria = String(button.getAttribute('aria-label') || '').trim();
      const text = String(button.innerText || button.textContent || '').trim();
      return /^Regenerate$|^重新生成$/i.test(aria || text) ||
             /^Good response$|^Bad response$/i.test(aria) ||
             /^Copy$|^复制$/i.test(aria || text);
    }
  ));

  const isX = typeof location !== 'undefined' && (location.hostname === 'x.com' || location.hostname.endsWith('.x.com'));
  const hasCompletedDelimiters = t.slice(i).includes('【引用评价结束】') && !stopGenerating;
  const completionSignal = hasFollowUpSuggestion || hasAnswerActions || hasCompletedDelimiters || (!isX && labels.some(l => /Regenerate|重新生成/i.test(l)));
  const done = Boolean(completionSignal) && !stopGenerating;

  const failed = /Grok was unable to reply|Something went wrong, please refresh|操作过于频繁|无法回复/.test(t.slice(i));
  if (failed) {
    // 移除页面内部隐式点击 Retry：任何重试均交由上层协调器显式判定与管理，防止计数失真与死循环
    return { text: '', done: false, failed: true };
  }
  return { text: t.slice(i + nonce.length), done, stillGenerating: stopGenerating, network };
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

/** In-page, MAIN world, only in our short-lived Grok window. Occluded windows
 * can suspend rAF even when document.hidden is false. Race native frames with a
 * timer, preserving cancellation, timestamps and exactly-once delivery. */
export function setGrokFrameFallbackOnPage(enabled) {
  const key = '__xfollowerGrokFrames';
  if (!enabled) { window[key]?.restore(); return; }
  if (window[key]) return;
  const request = window.requestAnimationFrame;
  const cancel = window.cancelAnimationFrame;
  const pending = new Map();
  let expiry;
  const restore = () => {
    clearTimeout(expiry);
    window.requestAnimationFrame = request;
    window.cancelAnimationFrame = cancel;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      cancel.call(window, id);
      // Retain outstanding animation work when restoring before window close.
      request.call(window, entry.callback);
    }
    pending.clear();
    delete window[key];
  };
  window[key] = {restore};
  window.requestAnimationFrame = callback => {
    let done = false;
    const finish = time => {
      if (done) return;
      done = true;
      clearTimeout(pending.get(id)?.timer);
      pending.delete(id);
      cancel.call(window, id);
      callback(time);
    };
    const id = request.call(window, finish);
    pending.set(id, {callback, timer:setTimeout(() => finish(performance.now()), 80)});
    return id;
  };
  window.cancelAnimationFrame = id => {
    clearTimeout(pending.get(id)?.timer);
    pending.delete(id);
    cancel.call(window, id);
  };
  expiry = setTimeout(restore, 180000);
}

export async function openMinimized(url, lifetime) {
  const win = await createBackgroundGrokWindow(url, lifetime);
  try {
    const tabId = win.tabs?.[0]?.id || (await chrome.tabs.query({ windowId: win.id }))?.[0]?.id;
    if (!tabId) throw new Error('Grok 窗口没有可用标签页');
    const deadline = grokTaskNow() + 25000;
    while ((await chrome.tabs.get(tabId)).status !== 'complete') {
      if (grokTaskNow() > deadline) throw new Error('Grok 页面加载超时');
      await waitForGrokVerification(tabId);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await executeGrokScript({target:{tabId}, world:'MAIN', func:setGrokFrameFallbackOnPage, args:[true]});
    return { winId: win.id, tabId };
  } catch (error) {
    if (!error.userActionRequired) {
      // Preserve the failed page for inspection. A transient navigation/injection
      // error must not make a newly opened popup immediately disappear.
      await chrome.storage.local.set({xfGrokWindowPreparationError:{
        windowId:win.id, url, at:Date.now(), reason:String(error?.message || error)
      }}).catch(() => {});
      await releaseGrokWindow(win.id).catch(() => {});
    }
    throw error;
  }
}

async function askOnX(prompt, nonce, sleep) {
  const complete = createGrokAnswerGate(2, 3);
  const { winId, tabId } = await openMinimized('https://x.com/i/grok', 300000);
  try {
    if (!tabId) return { ok: false, reason: '无法创建 Grok 窗口' };
    const probe = (await executeGrokScript({ target: { tabId }, world: 'MAIN', func: () => {
      const t = (document.body?.innerText || '').slice(0, 3000);
      return /Subscribe to Premium|Upgrade to Premium|not available in your region/i.test(t) ? 'paywall' : 'ok';
    } }).catch(error => {if (error?.userActionRequired || error?.grokVerificationTimeout) throw error; return [];}))?.[0]?.result;
    if (probe === 'paywall') return { ok: false, reason: 'x.com 账号未开通 Grok' };
    const drive = (await executeGrokScript({ target: { tabId }, world: 'MAIN', func: driveGrokInput, args: [prompt] })
      .catch(e => {if (e?.userActionRequired || e?.grokVerificationTimeout) throw e; return [{ result: { ok: false, err: String(e?.message || e) } }];}))?.[0]?.result;
    if (!drive?.ok) return { ok: false, reason: `x.com Grok：${drive?.err || '提交失败'}` };
    const deadline = grokTaskNow() + 180000;
    let lastState;
    let lastReadError = '';
    let samples = 0;
    const recordRead = async (state, parsed, outcome) => {
      await chrome.storage.local.set({xfGrokLastRead:{
        at:Date.now(), version:chrome.runtime.getManifest().version, tabId, winId,
        nonce, outcome, samples, stage:state?.stage || (state?.done ? 'complete' : 'legacy_pending'),
        source:state?.source || 'legacy', turnId:state?.turnId || '',
        done:Boolean(state?.done), stillGenerating:Boolean(state?.stillGenerating),
        answerActions:Boolean(state?.answerActions), stopCount:state?.stopCount,
        visibleStopCount:state?.visibleStopCount,
        completionMethod:state?.completionMethod || '',
        network:state?.network || null,
        textLength:String(state?.text || '').length, parsedLength:parsed.length,
        lastReadError
      }}).catch(() => {});
    };
    while (grokTaskNow() < deadline) {
      await sleep(2000);
      const dom = (await executeGrokScript({ target: { tabId }, world: 'MAIN', func: readGrokPageAnswer, args: [nonce] })
        .catch(error => {
          if (error?.userActionRequired || error?.grokVerificationTimeout) throw error;
          lastReadError = String(error?.message || error);
          console.warn('[askOnX] readGrokPageAnswer error:', error);
          return [];
        }))?.[0]?.result;
      lastState = dom;
      samples++;
      if (dom?.failed) { await recordRead(dom, '', 'failed'); return { ok: false, reason: 'x.com Grok 页面报告生成失败' }; }
      const fromDom = extractGrokComment(dom?.text);
      const completionMethod = complete(dom, fromDom);
      if (completionMethod) {
        await recordRead({...dom, completionMethod}, fromDom, 'success');
        return { ok: true, reply: fromDom, language: extractGrokCommentLanguage(dom?.text), channel: 'x.com' };
      }
    }
    await recordRead(lastState, extractGrokComment(lastState?.text), 'timeout');
    return { ok: false, reason: `x.com Grok 等待 180 秒后${lastState?.stillGenerating ? '仍在生成' : lastState?.text ? '未得到已完成且格式有效的引用评价' : '未读取到本轮回答'}；读取状态：${lastState?.stage || 'legacy_pending'}${lastReadError ? `；读取异常：${lastReadError}` : ''}` };
  } finally {
    if (winId) await releaseGrokWindow(winId).catch(() => {});
  }
}

async function askOnGrokCom(prompt, nonce, sleep) {
  const res = await requestGrokComPersistentSession({
    prompt,
    nonce,
    taskType: 'comment',
    timeoutMs: 90000,
    sleep,
    extractFn: rawText => {
      const reply = extractGrokComment(rawText);
      const language = extractGrokCommentLanguage(rawText);
      return { reply, language };
    }
  });
  if (!res.ok) return { ok: false, reason: res.reason || 'grok.com 会话调用未成功' };
  if (!res.reply) return { ok: false, reason: 'grok.com 未能在有效时间内给出符合格式的引用评价' };
  return { ok: true, reply: res.reply, language: res.language, channel: 'grok.com' };
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
    } catch (e) { if(e.userActionRequired) return {ok:false,userActionRequired:true,reason:e.message}; reasons.push(String(e?.message || e)); }
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
    const { winId, tabId } = await openMinimized('https://x.com/i/grok', timeoutMs + 120000);
    try {
      if (!tabId) return { ok: false, reason: '无法创建 Grok 窗口' };
      const probe = (await executeGrokScript({ target: { tabId }, world: 'MAIN', func: () => {
        const t = (document.body?.innerText || '').slice(0, 3000);
        return /Subscribe to Premium|Upgrade to Premium|not available in your region/i.test(t) ? 'paywall' : 'ok';
      } }).catch(error => {if (error?.userActionRequired || error?.grokVerificationTimeout) throw error; return [];}))?.[0]?.result;
      if (probe === 'paywall') return { ok: false, reason: 'x.com 账号未开通 Grok' };
      const drive = (await executeGrokScript({ target: { tabId }, world: 'MAIN', func: driveGrokInput, args: [fullPrompt] })
        .catch(e => {if (e?.userActionRequired || e?.grokVerificationTimeout) throw e; return [{ result: { ok: false, err: String(e?.message || e) } }];}))?.[0]?.result;
      if (!drive?.ok) return { ok: false, reason: `x.com Grok 提交失败: ${drive?.err || ''}` };

      const deadline = grokTaskNow() + timeoutMs;
      const complete = createGrokAnswerGate();
      while (grokTaskNow() < deadline) {
        await sleep(2000);
        const dom = (await executeGrokScript({ target: { tabId }, world: 'MAIN', func: readGrokPageAnswer, args: [nonce] })
          .catch(error => {
            if (error?.userActionRequired || error?.grokVerificationTimeout) throw error;
            console.warn('[askTextOnX] readGrokPageAnswer error:', error);
            return [];
          }))?.[0]?.result;
        if (dom?.failed) return { ok: false, reason: 'Grok 回复异常或触发风控' };
        const text = String(dom?.text || '').trim();
        if (complete(dom, text)) return { ok: true, text, channel: 'x.com' };
      }
      return { ok: false, reason: 'x.com Grok 生成超时' };
    } finally {
      if (winId) await releaseGrokWindow(winId).catch(() => {});
    }
  }

  async function askTextOnGrokCom() {
    const res = await requestGrokComPersistentSession({
      prompt: fullPrompt,
      nonce,
      taskType: 'text',
      timeoutMs,
      sleep
    });
    if (!res.ok) return { ok: false, reason: res.reason || 'grok.com 协调会话生成失败' };
    return { ok: true, text: res.text, channel: 'grok.com' };
  }

  for (const ask of [askTextOnX, askTextOnGrokCom]) {
    try {
      const res = await ask();
      if (res.ok) return res;
      reasons.push(res.reason);
    } catch (e) {
      if(e.userActionRequired) return {ok:false,userActionRequired:true,reason:e.message};
      reasons.push(String(e?.message || e));
    }
  }
  return { ok: false, reason: reasons.join('；') };
}

/**
 * 把 Grok 评价作为引用帖发布：打开原帖详情页 → Quote/引用 → 发布并校验。
 * 返回 {ok} 或 {ok:false, reason}。
 */
async function postQuoteInWindow(tabId, post, text, publishFn, sleep, options = {}) {
  const url = String(post?.url || '');
  if (!/\/status\/\d+/.test(url)) return { ok: false, reason: '该帖没有可用的帖子链接' };
  const expectedPostText = String(post?.text || post?.postText || '').trim();
  const expectedHandle = String(post?.handle || post?.username || new URL(url).pathname.split('/')[1] || '').replace(/^@/, '');
  const dismissDraft = () => chrome.scripting.executeScript({target:{tabId}, func:dismissQuoteComposerOnPage, args:[url, expectedPostText, expectedHandle]}).catch(error => {if (error?.userActionRequired || error?.grokVerificationTimeout) throw error; return [];});
  await chrome.tabs.update(tabId, {url});
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return { ok: false, reason: '帖子标签页已关闭' };
    if (t.status === 'complete') break;
    await sleep(500);
  }
  // X reports the document as complete before its React post view has hydrated.
  // Opening Quote during that interval can navigate to an empty /compose/post shell.
  await sleep(5500 + Math.floor(Math.random() * 2000));
  await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:setQuoteFrameFallbackOnPage, args:[true]});
  const opened = (await chrome.scripting.executeScript({ target: { tabId }, func: openQuoteComposerOnPage, args: [url] })
    .catch(e => [{ result: { ok: false, reason: String(e?.message || e) } }]))?.[0]?.result;

  // X 选择 Quote 会从帖子页切换到 /compose/post；原页面注入可能因路由导航被销毁。
  // 不把这类导航错误当作发布失败，等新路由上的引用编辑框确实就绪后重新注入发布阶段。
  const composerDeadline = Date.now() + 20000;
  let composerReady = false;
  let lastComposerState = null;
  while (Date.now() < composerDeadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, reason: '引用帖标签页已关闭' };
    if (tab.status !== 'complete') { await sleep(300); continue; }
    const state = (await chrome.scripting.executeScript({ target: { tabId }, func: inspectQuoteComposerOnPage, args: [url, expectedPostText, expectedHandle] })
      .catch(error => {if (error?.userActionRequired || error?.grokVerificationTimeout) throw error; return [];}))?.[0]?.result;
    if (state) lastComposerState = state;
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
    return { ok: false, stage:'composer', reason: opened?.reason || 'X 未显示嵌入目标原帖的引用编辑框；已关闭未完成的引用草稿', diagnostics: {opened, lastComposerState} };
  }

  if (options.beforePublish) await options.beforePublish();
  const res = (await chrome.scripting.executeScript({ target: { tabId }, func: publishFn, args: [url, text, expectedPostText, expectedHandle] })
    .catch(e => [{ result: { ok: false, reason: String(e?.message || e) } }]))?.[0]?.result;
  if (!res?.ok) await dismissDraft();
  return res || { ok: false, reason: '引用帖发布脚本无返回' };
}

export async function postQuoteOnTab(_tabId, post, text, publishFn, sleep, options = {}) {
  const url = String(post?.url || '');
  if (!/\/status\/\d+/.test(url)) return {ok:false, reason:'该帖没有可用的帖子链接'};
  // X sometimes navigates to an empty /compose/post shell. Retry only before
  // publishing; a send-stage failure must never risk posting a duplicate.
  for (let attempt = 0; attempt < 2; attempt++) {
    let quoteWindow;
    try {
      quoteWindow = await createTemporaryWindow({url, type:'popup', focused:false, width:800, height:600}, 'quote');
      const quoteTabId = quoteWindow.tabs?.[0]?.id;
      if (!quoteTabId) return {ok:false, reason:'引用帖小窗口没有可用的标签页'};
      await sleep(2500);
      const result = await postQuoteInWindow(quoteTabId, post, text, publishFn, sleep, options);
      if (result.ok || result.stage !== 'composer' || attempt === 1) return result;
    } catch (error) {
      return {ok:false, reason:String(error?.message || error)};
    } finally {
      const quoteTabId = quoteWindow?.tabs?.[0]?.id;
      if (quoteTabId != null) await chrome.scripting.executeScript({target:{tabId:quoteTabId}, world:'MAIN', func:setQuoteFrameFallbackOnPage, args:[false]}).catch(() => {});
      if (quoteWindow?.id != null) await closeTemporaryWindow(quoteWindow.id).catch(() => {});
    }
    await sleep(1000 + Math.floor(Math.random() * 1000));
  }
}
