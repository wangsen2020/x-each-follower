import {holdTemporaryWindowForVerification} from './temporary-windows.js';
// Runs in the page's main world; keep detection self-contained.
export function detectGrokVerificationOnPage() {
  const host = location.hostname;
  if (!['x.com','twitter.com','grok.com'].includes(host)) return null;
  const text = (document.body?.innerText || '').slice(0, 12000);
  const title = document.title || '';
  const challenge = document.querySelector('iframe,input[name="cf-turnstile-response"],input[id^="cf-chl-widget-"][id$="_response"],#challenge-running,#challenge-stage,#arkoseFrame,[data-testid="arkoseFrame"]');
  const gate = /verify (?:that )?you are human|verifying you are human|checking your browser|performing security verification|确认您是真人|验证您是人类|请完成.*验证|安全验证|人机验证/i.test(text);
  // A mention of Cloudflare or CAPTCHA in a normal Grok answer is not a challenge.
  if (!challenge && !(gate && /just a moment|security verification|验证|安全检查/i.test(title)) && !(gate && !document.querySelector('textarea,[contenteditable="true"]'))) return null;
  return {url:location.href,host,reason:'页面需要手动完成人机或安全验证'};
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
    if (!preserveNotice && grokVerification?.tabId === tabId) await chrome.storage.local.remove('grokVerification');
    return;
  }
  const tab = await chrome.tabs.get(tabId);
  const {grokVerification:prior} = await chrome.storage.local.get('grokVerification');
  const notice = {...challenge,tabId,windowId:tab.windowId,at:new Date().toISOString()};
  // Hand the window to the user: pool reuse and idle cleanup must not navigate or close it.
  await holdTemporaryWindowForVerification(tab.windowId,tabId);
  if (prior?.tabId !== tabId) {
    await chrome.storage.local.set({grokVerification:notice});
    // The worker owns reminder delivery; the task waits separately for verification.
    chrome.runtime.sendMessage?.({cmd:'notifyGrokVerificationSelf',at:notice.at})?.catch(()=>{});
    await chrome.notifications.create('xf-grok-verification', {type:'basic',iconUrl:chrome.runtime.getURL('icon128.png'),title:'Grok 需要手动验证',message:'任务已暂停。请完成安全校验，聊天输入框恢复后将自动继续。',priority:2,requireInteraction:true}).catch(()=>{});
    await chrome.windows.update(tab.windowId,{focused:true,state:'normal'}).catch(()=>{});
    await chrome.tabs.update(tabId,{active:true}).catch(()=>{});
    chrome.runtime.sendMessage?.({cmd:'showGrokVerificationAlert'})?.catch(()=>{});
  }
  const error = new Error('Grok 需要手动完成安全验证；任务暂停等待验证。');
  error.userActionRequired = true;
  throw error;
}


const waiters = new Map();
let pausedMs = 0;
export const grokTaskNow = () => Date.now() - pausedMs;
export function isGrokInputReadyOnPage() {
  const input = document.querySelector('textarea,[contenteditable="true"]');
  return !!input && !input.disabled && input.getAttribute('aria-disabled') !== 'true'
    && input.getClientRects().length > 0;
}
export function waitForGrokVerification(tabId, {timeoutMs = 10 * 60 * 1000, intervalMs = 1000} = {}) {
  if (waiters.has(tabId)) return waiters.get(tabId);
  const promise = (async () => {
    const started = Date.now();
    let waiting = false;
    try {
      while (true) {
        try {
          await assertGrokVerificationClear(tabId, true);
          if (!waiting) return;
          const result = await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:isGrokInputReadyOnPage});
          if (result?.[0]?.result) {
            await chrome.storage.local.remove('grokVerification');
            await chrome.notifications.clear?.('xf-grok-verification');
            return;
          }
        } catch (error) {
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
