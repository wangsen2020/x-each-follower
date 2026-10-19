import {showVerificationAlert, closeVerificationAlert} from './verification-alert-window.js';
import {holdTemporaryWindowForVerification, resumeTemporaryWindowAfterVerification} from './temporary-windows.js';
import {appendExecutionLog} from './execution-log.js';
// Runs in the page's main world via chrome.scripting; keep this function self-contained.
export function detectGrokVerificationOnPage() {
  const host = location.hostname;
  if (!['x.com','twitter.com','grok.com'].includes(host)) return null;
  const signals = [];
  const pageHost = host.toLowerCase();
  function parsed(raw) {
    try { return new URL(String(raw || ''), location.href); } catch { return null; }
  }
  function styledHidden(node) {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
    return !!style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0);
  }
  function visible(node) {
    if (!node || node.hidden) return false;
    if (typeof node.getBoundingClientRect !== 'function') return false;
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 20 && rect.height > 20)) return false;
    for (let current = node; current; current = current.parentElement || current.parentNode) {
      if (current.hidden || styledHidden(current)) return false;
      if (current === document.body || current === document.documentElement) break;
    }
    return true;
  }
  function composerUsable() {
    const nodes = [];
    const editables = document.querySelectorAll?.('[contenteditable="true"]');
    if (editables && editables.length) nodes.push(...editables);
    const areas = document.querySelectorAll?.('textarea');
    if (areas && areas.length) nodes.push(...areas);
    if (!nodes.length && typeof document.querySelector === 'function') {
      const one = document.querySelector('textarea, [contenteditable="true"]');
      if (one) nodes.push(one);
    }
    return nodes.some(node => {
      if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true') return false;
      if (typeof node.getBoundingClientRect !== 'function') return true;
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 20 && rect.height > 10)) return false;
      for (let current = node; current; current = current.parentElement || current.parentNode) {
        if (current.hidden || styledHidden(current)) return false;
        if (current === document.body || current === document.documentElement) break;
      }
      return true;
    });
  }
  function httpsUrl(url) {
    return !!url && url.protocol === 'https:';
  }
  function pathAt(pathname, prefix) {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }
  function cloudflareFrame(url) {
    if (!httpsUrl(url) || url.hostname.toLowerCase() !== 'challenges.cloudflare.com') return false;
    return pathAt(url.pathname, '/cdn-cgi/challenge-platform') || pathAt(url.pathname, '/turnstile');
  }
  function arkoseFrame(url) {
    if (!httpsUrl(url)) return false;
    const name = url.hostname.toLowerCase();
    if (name !== 'client-api.arkoselabs.com' && !name.endsWith('.arkoselabs.com')) return false;
    return pathAt(url.pathname, '/fc') || pathAt(url.pathname, '/v2');
  }
  for (const node of document.querySelectorAll?.('iframe') || []) {
    const url = parsed(node.getAttribute?.('src') || node.src);
    if (!visible(node) || !url) continue;
    if (cloudflareFrame(url)) signals.push('cf-challenge-iframe');
    else if (arkoseFrame(url)) signals.push('arkose-iframe');
  }
  for (const node of document.querySelectorAll?.('#arkoseFrame,[data-testid="arkoseFrame"]') || []) {
    if (!visible(node)) continue;
    const tag = String(node.tagName || node.tag || '').toLowerCase();
    if (tag !== 'iframe') continue;
    const url = parsed(node.getAttribute?.('src') || node.src);
    if (arkoseFrame(url)) signals.push('arkose-widget');
  }
  const composer = composerUsable();
  const title = document.title || '';
  const text = (document.body?.innerText || '').slice(0, 4000);
  const titleHit = /just a moment|attention required|checking your browser|security verification|请稍候|安全检查|正在验证/i.test(title);
  const bodyHit = /verify (?:that )?you are human|verifying you are human|checking your browser|performing security verification|确认您是真人|验证您是人类|请完成安全验证|人机验证|正在进行安全验证|安全服务防护恶意自动程序|在验证您不是自动程序期间/i.test(text);
  const cfAttribution = /cloudflare|由\s*cloudflare\s*提供/i.test(text);
  const challengeDom = [...(document.querySelectorAll?.('#challenge-running,#challenge-stage,#cf-challenge-running,.cf-browser-verification') || [])].some(visible);
  // Challenge copy alone is not enough. Need a visible challenge node, or a matching title plus Cloudflare attribution.
  if (!composer && bodyHit && (challengeDom || (titleHit && cfAttribution))) {
    if (challengeDom) signals.push('cf-page-dom');
    if (titleHit) signals.push('cf-page-title');
  }
  const unique = [...new Set(signals)];
  if (!unique.length) return null;
  const provider = unique.every(code => code.startsWith('arkose-')) ? 'arkose' : 'cloudflare';
  const reason = provider === 'arkose' ? '检测到可见的 Arkose 人机验证，任务已暂停' : (unique.includes('cf-challenge-iframe') ? '检测到可见的 Cloudflare 验证框，任务已暂停' : '当前页是 Cloudflare 安全验证页且聊天输入框不可用，已按超时失败处理');
  const safeUrl = parsed(location.href);
  return {provider, signals: unique, reason, host: pageHost, url: safeUrl ? `${safeUrl.origin}${safeUrl.pathname}` : pageHost};
}

const SIGNAL_LABELS = {
  'cf-challenge-iframe':'Cloudflare 验证框',
  'cf-page-title':'页面标题与正文',
  'cf-page-dom':'验证页标记',
  'arkose-iframe':'Arkose 验证框',
  'arkose-widget':'Arkose 组件'
};
function verificationDetail(notice) {
  const evidence = (notice.signals || []).map(code => `${code} ${SIGNAL_LABELS[code] || code}`).join('；');
  return evidence ? `${notice.reason}（证据：${evidence}）` : notice.reason;
}
function runsInExtensionPage() {
  const protocol = globalThis.location?.protocol;
  const extensionProtocol = protocol === 'chrome-extension:' || protocol === 'moz-extension:';
  const workerScript = /\/(?:background|service-worker)\.js$/.test(globalThis.location?.pathname || '');
  return extensionProtocol && typeof document !== 'undefined' && !workerScript;
}
async function recordVerificationLog(entry) {
  if (runsInExtensionPage()) {
    const saved = await chrome.runtime.sendMessage({cmd:'appendExecutionLog', entry});
    if (!saved?.ok) throw new Error(saved?.error || '日志后台未响应');
    return saved.entry;
  }
  return appendExecutionLog(entry);
}
let noticeQueue = Promise.resolve();
function withNoticeLock(task) {
  const run = noticeQueue.then(task, task);
  noticeQueue = run.then(() => {}, () => {});
  return run;
}
function terminalCloudflare(challenge) {
  return challenge?.provider === 'cloudflare' && challenge.signals?.some(code => code === 'cf-page-title' || code === 'cf-page-dom');
}

export async function assertPendingGrokVerificationClear() {
  const {grokVerification:notice} = await chrome.storage?.local?.get?.('grokVerification') || {};
  if (!notice) return;
  const tab = await chrome.tabs.get(notice.tabId).catch(()=>null);
  if (!tab) {
    await chrome.storage.local.remove('grokVerification');
    return;
  }
  await waitForGrokVerification(notice.tabId);
}

export async function assertGrokVerificationClear(tabId, preserveNotice = false) {
  const result = await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:detectGrokVerificationOnPage});
  const challenge = result?.[0]?.result;
  if (!challenge) {
    const {grokVerification} = await chrome.storage?.local?.get?.('grokVerification') || {};
    if ((!preserveNotice || terminalCloudflare(grokVerification)) && grokVerification?.tabId === tabId) await chrome.storage.local.remove('grokVerification');
    return;
  }
  if (terminalCloudflare(challenge)) {
    await withNoticeLock(async () => {
      const saved = await chrome.storage.local.get(['grokVerification','grokVerificationFailure']);
      const previous = saved.grokVerificationFailure;
      const signature = `${tabId}:${challenge.provider}:${(challenge.signals || []).join(',')}`;
      const at = previous?.evidenceSignature === signature ? previous.at : new Date().toISOString();
      const failure = {...challenge,tabId,at,evidenceSignature:signature,
        reason:'Cloudflare 安全验证页且聊天输入框不可用，已按超时失败处理'};
      if (previous?.evidenceSignature !== signature) {
        await chrome.storage.local.set({grokVerificationFailure:failure});
        await recordVerificationLog({scope:'verification',id:`verification-failed:${tabId}:${at}`,
          tabId,at,source:'system',result:'failed',detail:verificationDetail(failure),provider:failure.provider,signals:failure.signals});
      }
      if (saved.grokVerification?.tabId === tabId) {
        await chrome.storage.local.remove('grokVerification');
        await closeVerificationAlert(saved.grokVerification.at).catch(() => {});
        await chrome.notifications?.clear?.('xf-grok-verification');
      }
    });
    throw Object.assign(new Error('Cloudflare 安全验证阻断，Grok 任务已按超时失败处理'), {grokVerificationTimeout:true,code:'GROK_VERIFICATION_TIMEOUT'});
  }
  const tab = await chrome.tabs.get(tabId);
  // Hand the window to the user: pool reuse and idle cleanup must not navigate or close it.
  await holdTemporaryWindowForVerification(tab.windowId,tabId);
  await withNoticeLock(async () => {
    const {grokVerification:prior} = await chrome.storage.local.get('grokVerification');
    const sameTab = prior?.tabId === tabId;
    const signature = `${tabId}:${challenge.provider}:${(challenge.signals || []).join(',')}`;
    const notice = {...challenge,tabId,windowId:tab.windowId,at:sameTab && prior.at ? prior.at : new Date().toISOString(),evidenceSignature:signature};
    const evidenceChanged = !sameTab || prior.evidenceSignature !== signature || JSON.stringify(prior.signals || []) !== JSON.stringify(notice.signals);
    if (!sameTab || evidenceChanged) await chrome.storage.local.set({grokVerification:notice});
    if (!sameTab || prior.evidenceSignature !== signature) {
      const episodeKey = `${tabId}:${notice.at}`;
      await recordVerificationLog({scope:'verification',id:`verification:${episodeKey}`,episodeKey,tabId,at:notice.at,source:'system',result:'paused',detail:verificationDetail(notice),provider:notice.provider,signals:notice.signals,evidenceSignature:signature});
    }
    if (sameTab) return;
    // The worker owns reminder delivery; the task waits separately for verification.
    chrome.runtime.sendMessage?.({cmd:'notifyGrokVerificationSelf',at:notice.at})?.catch(()=>{});
    await chrome.notifications.create('xf-grok-verification', {type:'basic',iconUrl:chrome.runtime.getURL('icon128.png'),title:'Grok 需要手动验证',message:'任务已暂停。请完成安全校验，聊天输入框恢复后将自动继续。',priority:2,requireInteraction:true}).catch(()=>{});
    await chrome.windows.update(tab.windowId,{focused:true,state:'normal'}).catch(()=>{});
    await chrome.tabs.update(tabId,{active:true}).catch(()=>{});
    // Direct module call also works in a service worker, where sendMessage cannot target itself.
    try { await showVerificationAlert(); }
    catch (error) { await chrome.storage.local.set({grokVerificationAlertError:{at:notice.at,message:String(error.message || error)}}); }
  });
  const error = new Error('Grok 需要手动完成安全验证；任务暂停等待验证。');
  error.userActionRequired = true;
  throw error;
}


const waiters = new Map();
let pausedMs = 0;
export const grokTaskNow = () => Date.now() - pausedMs;
export function isGrokInputReadyOnPage() {
  const editable = document.querySelector('[contenteditable="true"].tiptap.ProseMirror, [contenteditable="true"]');
  if (editable && !editable.disabled && editable.getAttribute('aria-disabled') !== 'true' && editable.getClientRects().length > 0) {
    return true;
  }
  const textareas = Array.from(document.querySelectorAll('textarea'));
  for (const input of textareas) {
    if (input.disabled || input.getAttribute('aria-disabled') === 'true') continue;
    if (input.offsetParent === null) continue;
    const style = window.getComputedStyle ? window.getComputedStyle(input) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
    const rect = input.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 10) return true;
  }
  return false;
}
export function waitForGrokVerification(tabId, {timeoutMs = 10 * 60 * 1000, intervalMs = 1000} = {}) {
  if (waiters.has(tabId)) return waiters.get(tabId);
  const promise = (async () => {
    const started = Date.now();
    const saved = (await chrome.storage.local.get('grokVerification')).grokVerification;
    let waiting = saved?.tabId === tabId && !terminalCloudflare(saved);
    try {
      while (true) {
        try {
          await assertGrokVerificationClear(tabId, true);
          if (!waiting) return;
          const result = await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:isGrokInputReadyOnPage});
          if (result?.[0]?.result) {
            const current = (await chrome.storage.local.get('grokVerification')).grokVerification;
            if (current?.tabId === tabId) {
              await resumeTemporaryWindowAfterVerification(current.windowId,tabId);
              await chrome.storage.local.remove('grokVerification');
              await chrome.notifications.clear?.('xf-grok-verification');
              await closeVerificationAlert(current.at);
            }
            return;
          }
        } catch (error) {
          if (error.grokVerificationTimeout) throw error;
          if (!error.userActionRequired && !waiting) throw error;
          waiting = true;
          const tab = await chrome.tabs.get(tabId).catch(()=>null);
          if (!tab) throw Object.assign(new Error('验证标签页已关闭，任务已停止'), {userActionRequired:true});
        }
        if (Date.now() - started >= timeoutMs) throw Object.assign(new Error('等待安全验证超时，任务已停止，请验证后重试'), {userActionRequired:true});
        await new Promise(resolve=>setTimeout(resolve,intervalMs));
      }
    } finally {if (waiting) pausedMs += Date.now() - started;}
  })();
  waiters.set(tabId,promise);
  promise.finally(()=>waiters.delete(tabId)).catch(()=>{});
  return promise;
}
export async function executeGrokScript(options) {
  const tabId = options.target.tabId;
  await waitForGrokVerification(tabId);
  let timer, pending, stopped = false, rejectWatch;
  const watch = new Promise((_,reject)=>{rejectWatch=reject;});
  timer=setInterval(()=>{
    if (pending || stopped) return;
    pending=waitForGrokVerification(tabId);
    pending.catch(rejectWatch).finally(()=>{pending=null;});
  },1000);
  try {
    // Never replay an injected function: it may already have submitted a prompt.
    const result = await Promise.race([chrome.scripting.executeScript(options),watch]);
    if (pending) await pending;
    await waitForGrokVerification(tabId);
    return result;
  } finally {stopped=true;clearInterval(timer);}
}
