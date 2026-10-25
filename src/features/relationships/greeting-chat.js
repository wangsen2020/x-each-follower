import {isAccountUnavailable} from './followback-monitor.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function greetingDue(user, afterDays = 1, now = Date.now()) {
  const followedAt = Date.parse(user?.followedAt || '');
  return !isAccountUnavailable(user) && ['pending', 'overdue'].includes(user?.status)
    && Number.isFinite(followedAt)
    && now - followedAt >= Math.max(1, Number(afterDays) || 1) * 86400000;
}

// Serialized into X's MAIN world. X Chat owns encryption and delivery.
export async function operateGreetingChatOnPage({ownerHandle, ownerId, targetHandle, targetId, text, action, priorRows = []}) {
  if (location.origin !== 'https://x.com') return {blocked: true, reason: '不是 X 页面'};
  const viewer = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.split('/')[1];
  if (!viewer) return {ready: false, stage: 'viewer'};
  if (viewer.toLowerCase() !== ownerHandle.toLowerCase()) return {blocked: true, reason: 'X 登录账号已变化，停止发送'};
  if (action === 'open') {
    if (location.pathname.toLowerCase() !== `/${targetHandle.toLowerCase()}`) return {blocked: true, reason: '不是指定收件人的主页'};
    const button = document.querySelector('[data-testid="sendDMFromProfile"]');
    if (!button) return {ready: false, stage: 'profile-button'};
    if (button.disabled) return {blocked: true, reason: '该账号当前没有可用的私信入口，无法私信'};
    button.click();
    return {opened: true};
  }
  const route = location.pathname.match(/^\/i\/chat\/(\d+)-(\d+)$/);
  if (!route || ![ownerId, targetId].every(id => route.slice(1).includes(String(id)))) {
    if (location.pathname === '/i/chat' || location.pathname.toLowerCase() === `/${targetHandle.toLowerCase()}`) return {ready: false, stage: 'route'};
    return {blocked: true, reason: '当前聊天会话与指定收件人不符'};
  }
  const root = document.querySelector('[data-testid="xchatEmbedRoute"]')?.shadowRoot;
  if (!root) return {ready: false, stage: 'chat-root'};
  if (root.querySelector('input[type="password"],input[autocomplete="one-time-code"]')) return {blocked: true, reason: 'X Chat 需要手动解锁'};
  // The composer mounts before its conversation and encryption state are ready.
  if (!root.querySelector('[data-testid="dm-conversation-header"]') || !root.querySelector('[data-testid="dm-conversation-panel"]')) return {ready: false, stage: 'conversation'};
  const rootText = root.textContent || '';
  const isInboxClosed = rootText.includes('收件箱已关闭') || /inbox is closed/i.test(rootText);
  const requiresPasscode = rootText.includes('安全码') || /passcode/i.test(rootText);
  const cannotMessage = rootText.includes('无法向此账号发送私信') || rootText.includes('无法向此人发送私信') || /can(?:'t|not) message this/i.test(rootText);
  const hasComposer = Boolean(root.querySelector('[data-testid="dm-composer-textarea"]'));
  if ((isInboxClosed || requiresPasscode || cannotMessage) && !hasComposer) {
    return {blocked:true,stage:isInboxClosed?'recipient-permission':requiresPasscode?'chat-passcode':'recipient-permission',reason:isInboxClosed?'该账号已关闭收件箱，无法私信':requiresPasscode?'会话需要安全码，未发送私信':'该账号不允许发送私信',diagnostics:{code:isInboxClosed?'CHAT_INBOX_CLOSED':requiresPasscode?'CHAT_PASSCODE_REQUIRED':'CHAT_PERMISSION_DENIED'}};
  }
  const rows = [...root.querySelectorAll('[data-dm-message-row]')];
  if (action === 'receipt') {
    const receipt = rows.find(row => !priorRows.includes(row.getAttribute('data-dm-message-row')) && row.textContent.includes(text));
    if (!receipt) return {ready: true, pending: true};
    const status = receipt.getAttribute('data-send-status');
    return {sent: status === 'sent', failed: status === 'failed', pending: status !== 'sent' && status !== 'failed', messageId: receipt.getAttribute('data-dm-message-row'), status};
  }
  const input = root.querySelector('[data-testid="dm-composer-textarea"]');
  if (!input || input.disabled) return {ready: false, stage: 'composer-input'};
  if (action !== 'send' && input.value) return {blocked: true, reason: '输入框已有草稿，未覆盖'};
  const fiberKey = Object.keys(input).find(key => key.startsWith('__reactFiber$'));
  let fiber = fiberKey && input[fiberKey];
  let composer;
  for (let depth = 0; fiber && depth < 45; depth++, fiber = fiber.return) {
    if (fiber.memoizedProps?.component?.composer?.state?.state) { composer = fiber.memoizedProps.component.composer; break; }
  }
  if (!composer) return {ready: false, stage: 'composer-state'};
  const state = composer.state.state;
  if (state.isLegacyOrLoading && !state.isLegacy) return {ready: false, stage: 'conversation-loading'};
  if (!state.isLegacy && !state.trustState) return {ready: false, stage: 'trust-state'};
  const attachments = state.attachments?.asJsReadonlyArrayView?.();
  if ((action !== 'send' && state.currentText) || state.isReadOnly || state.editData || state.replyingTo || state.forwardMessage || !Array.isArray(attachments) || attachments.length) {
    return {blocked: true, reason: '聊天输入状态不支持私信，已停止发送'};
  }
  if (input.value || state.currentText) return {blocked: true, reason: '输入框已有草稿，未覆盖'};
  let sender, method, inspectedObjects=0, matchedMethods=0;
  for (const value of Object.values(composer)) {
    if (!value || typeof value !== 'object') continue;
    const prototype = Object.getPrototypeOf(value);
    if (!prototype) continue;
    inspectedObjects++;
    const candidates = Object.getOwnPropertyNames(prototype).filter(name => {
      const method = value[name];
      return typeof method === 'function' && method.length === 5 &&
        /^function\(e,t,n,r,i\)\{return \w+\(this\.\w+,e,t,n,r,i\)\}$/.test(String(method));
    });
    matchedMethods+=candidates.length;
    if (candidates.length === 1) { sender = value; method = candidates[0]; break; }
  }
  if (!sender) return {blocked:true,stage:'sender-discovery',reason:'X Chat 发送入口已变化，未发送私信',diagnostics:{code:'CHAT_SENDER_NOT_FOUND',composerFound:true,inspectedObjects,matchedMethods,isLegacy:Boolean(state.isLegacy),trustReady:Boolean(state.trustState),composerReadOnly:Boolean(state.isReadOnly)}};
  if (action === 'prepare') return {prepared: true, priorRows: rows.map(row => row.getAttribute('data-dm-message-row')).filter(Boolean)};
  if (action === 'send') {
    await sender[method](text, state.attachments, null, null, null);
    return {submitted: true};
  }
  return {ready: true};
}

export async function sendGreetingViaChat({ownerHandle, ownerId, targetHandle, targetId, text, beforeSubmit, api = chrome, focused = true}) {
  if (!/^\d+$/.test(String(ownerId)) || !/^\d+$/.test(String(targetId)) || !/^\w{1,15}$/.test(targetHandle) || !text.trim()) throw new Error('私信收件人或正文无效');
  let windowId;
  let submitted = false;
  let attemptedSubmit = false;
  let lastStep = '';
  const startedAt=Date.now();let diagnostics={};
  try {
    const popup = await api.windows.create({url: `https://x.com/${encodeURIComponent(targetHandle)}`, type: 'popup', focused, width: 1000, height: 760});
    windowId = popup.id;
    const tabId = popup.tabs?.[0]?.id;
    if (!tabId) throw new Error('无法打开目标主页');
    const execute = async (action, priorRows = []) => {
      const result = await api.scripting.executeScript({target: {tabId}, world: 'MAIN', func: operateGreetingChatOnPage, args: [{ownerHandle, ownerId, targetHandle, targetId, text, action, priorRows}]});
      return result?.[0]?.result || {ready: false};
    };
    let opened = false;
    let prepared = false;
    let claimed = false;
    let priorRows = [];
    for (let step = 0; step < 80; step++) {
      const action = submitted ? 'receipt' : prepared && claimed ? 'send' : opened ? 'prepare' : 'open';
      // An execution error after dispatch may hide a successful Send click.
      // Keep the one-message claim locked until the outcome is verified.
      if (action === 'send') attemptedSubmit = true;
      const result = await execute(action, priorRows).catch(error => step < 5 ? {ready: false} : {blocked: true, reason: error.message});
      diagnostics={...diagnostics,...result.diagnostics,action,stage:result.stage||action,pollCount:step+1,elapsedMs:Date.now()-startedAt,prepared,claimed,attemptedSubmit,submitted};
      lastStep = `${action}: ${result.blocked ? result.reason : result.ready === false ? `not ready / ${result.stage || 'unknown'}` : result.prepared ? 'prepared' : result.submitted ? 'submitted' : result.pending ? 'pending' : result.opened ? 'opened' : 'waiting'}`;
      if (result.blocked || result.failed) throw new Error(result.reason || 'X 报告私信发送失败');
      if (result.sent) return {ok: true, messageId: result.messageId,diagnostics:{...diagnostics,submitted:true,receiptConfirmed:true}};
      if (result.opened) opened = true;
      if (result.prepared) {prepared = true; priorRows = result.priorRows || [];}
      if (result.submitted) submitted = true;
      if (prepared && !claimed) {
        if (typeof beforeSubmit === 'function') await beforeSubmit();
        claimed = true;
      }
      await wait(450);
    }
    throw new Error(submitted ? `私信已提交但未确认发送，停止重试（${lastStep}）` : `聊天页未准备好，未发送私信（${lastStep}）`);
  } catch (error) {
    return {ok: false, submitted: submitted || attemptedSubmit, reason: String(error?.message || error),diagnostics:{...diagnostics,lastStep,attemptedSubmit,submitted,elapsedMs:Date.now()-startedAt}};
  } finally {
    if (windowId) await api.windows.remove(windowId).catch(() => {});
  }
}
