// grok-session-manager.js
// 后台独占的 grok.com 单一常驻窗口与会话复用协调器。
// 实现 50 轮已接收问题复用、第 51 轮前核验删除旧会话、幂等计数与中断恢复、逐轮独立回答隔离。

import {
  waitForGrokVerification,
  grokTaskNow,
  assertPendingGrokVerificationClear,
  executeGrokScript
} from './grok-verification.js';
import {
  createTemporaryWindow,
  closeTemporaryWindow,
  readTemporaryWindowOwnerOnPage
} from './temporary-windows.js';
import { setGrokFrameFallbackOnPage, makeNonce } from './grok-comment.js';

export const GROK_SESSION_STORAGE_KEY = 'grokPersistentSession';
export const DEFAULT_GROK_SESSION_LIMIT = 50;

/**
 * 计算规范化邮箱的稳定哈希值（绝不回显或持久化明文邮箱）
 */
export function computeEmailHash(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x67452301, h4 = 0xefcdab89;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 2246822507);
    h4 = Math.imul(h4 ^ ch, 3266489909);
  }
  const toHex = n => (n >>> 0).toString(16).padStart(8, '0');
  return `ghash_${toHex(h1)}${toHex(h2)}${toHex(h3)}${toHex(h4)}`;
}

/**
 * 提取标准规范化的 Grok 会话路径与标识（忽略 rid 等临时查询参数）
 */
export function extractCanonicalGrokUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.includes('grok.com')) return null;
    const match = url.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
    if (!match) return null;
    return {
      conversationId: match[1],
      canonicalUrl: `https://grok.com/c/${match[1]}`,
      pathname: `/c/${match[1]}`
    };
  } catch {
    return null;
  }
}

/**
 * 默认常驻会话持久化数据结构
 */
export function createDefaultSessionState(overrides = {}) {
  return {
    schemaVersion: 1,
    ownerKey: null,
    accountLabel: null,
    windowId: null,
    tabId: null,
    ownershipToken: null,
    conversationId: null,
    conversationUrl: null,
    createdByExtension: false,
    generation: 1,
    state: 'absent', // 'absent' | 'ready' | 'submitting' | 'generating' | 'rotation_pending' | 'rotating' | 'verification_required' | 'uncertain' | 'user_intervened' | 'paused'
    acceptedCount: 0,
    limit: DEFAULT_GROK_SESSION_LIMIT,
    activeRequest: null,
    rotation: null,
    lastUsedAt: 0,
    lastError: null,
    pausedReuse: false,
    quotaUsage: null,
    ...overrides
  };
}

/**
 * 读取持久化状态（优先读取 local 存储）
 */
export async function getGrokSessionState() {
  const data = await chrome.storage.local?.get?.(GROK_SESSION_STORAGE_KEY);
  const raw = data?.[GROK_SESSION_STORAGE_KEY];
  if (!raw || typeof raw !== 'object') {
    return createDefaultSessionState();
  }
  return { ...createDefaultSessionState(), ...raw };
}

/**
 * 持久化状态
 */
export async function saveGrokSessionState(state) {
  const payload = { [GROK_SESSION_STORAGE_KEY]: state };
  await chrome.storage.local?.set?.(payload);
  return state;
}

/**
 * 重置持久化状态
 */
export async function resetGrokSessionState() {
  const fresh = createDefaultSessionState();
  await saveGrokSessionState(fresh);
  return fresh;
}

// ---------------- in-page 函数（注入 grok.com 页面执行，必须完全自包含） ----------------

/**
 * in-page: 探测 grok.com 额度使用量与重置时间
 * 路径：打开账号菜单 -> 点击设置 -> 选择“使用量”标签页 -> 读取 SuperGrok 与 Grok Bot 剩余额度与重置时间 -> 安全关闭弹窗
 */
export async function inspectGrokComUsageOnPage() {
  const host = location.hostname;
  if (!host.includes('grok.com')) return { ok: false, reason: '非 grok.com 页面' };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('button[aria-label*="Account menu"], button[aria-label*="Watson Taylor"], [aria-label*="Account"], [aria-label*="账户"], [aria-label*="账号"]');
  if (!btn) return { ok: false, notLoggedIn: true, reason: '未找到账户菜单按钮（可能未登录）' };

  let menuOpenedByUs = false;
  let dialogOpenedByUs = false;

  const closeDialog = () => {
    if (!dialogOpenedByUs) return;
    const currentDialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    if (!currentDialog) return;
    const closeBtn = currentDialog.querySelector('button[aria-label="关闭"], button[aria-label="Close"], button[aria-label*="close"]');
    if (closeBtn) closeBtn.click();
    else {
      try {
        currentDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      } catch {}
    }
  };

  const closeMenu = () => {
    if (!menuOpenedByUs) return;
    try {
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    } catch {}
  };

  try {
    const existingMenu = document.querySelector('[role="menu"]');
    if (!existingMenu) {
      btn.click();
      menuOpenedByUs = true;
      await sleep(600);
    }

    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] div'));
    const settingsItem = menuItems.find(el => {
      const t = (el.innerText || el.textContent || '').trim();
      return /^(?:设置|settings)$/i.test(t) || t.includes('设置') || t.includes('Settings');
    });
    if (!settingsItem) {
      return { ok: false, reason: '未找到设置菜单项' };
    }

    const priorDialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    settingsItem.click();
    if (!priorDialog) dialogOpenedByUs = true;
    await sleep(1000);

    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    if (!dialog) return { ok: false, reason: '设置弹窗未打开' };

    const tabs = Array.from(dialog.querySelectorAll('button, [role="tab"], div'));
    const usageTab = tabs.find(el => {
      const t = (el.innerText || el.textContent || '').trim();
      return /^(?:使用量|usage)$/i.test(t);
    });
    if (!usageTab) {
      return { ok: false, reason: '未找到使用量选项卡' };
    }
    usageTab.click();
    await sleep(1200);

    let superGrokUsed = null;
    let superGrokResetAt = null;
    let grokBotUsed = null;
    let grokBotResetAt = null;

    const h3List = Array.from(dialog.querySelectorAll('h3, h4, div.font-semibold'));
    for (const h3 of h3List) {
      const title = (h3.innerText || h3.textContent || '').trim();
      const card = h3.closest('.flex-col') || h3.parentElement;
      if (/SuperGrok/i.test(title)) {
        const flow = card?.querySelector('number-flow-react[aria-label]');
        const aria = flow?.getAttribute('aria-label') || '';
        const m = aria.match(/(\d+)%/);
        if (m) superGrokUsed = parseInt(m[1], 10);

        if (superGrokUsed === null) {
          const text = card?.innerText || card?.textContent || '';
          const buildM = text.match(/Grok Build\s*(\d+)%/);
          const chatM = text.match(/(?:聊天|Chat)\s*(\d+)%/);
          if (buildM || chatM) {
            superGrokUsed = (buildM ? parseInt(buildM[1], 10) : 0) + (chatM ? parseInt(chatM[1], 10) : 0);
          }
        }

        const resetMatch = (card?.innerText || card?.textContent || '').match(/(?:重置|Resets?)\s*(\d+年\d+月\d+日\s*\d+:\d+|\S+)/i);
        if (resetMatch) superGrokResetAt = resetMatch[1].trim();
      } else if (/Grok Bot/i.test(title)) {
        const flow = card?.querySelector('number-flow-react[aria-label]');
        const aria = flow?.getAttribute('aria-label') || '';
        const m = aria.match(/(\d+)%/);
        if (m) grokBotUsed = parseInt(m[1], 10);

        const bar = card?.querySelector('[role="progressbar"][aria-valuenow]');
        if (grokBotUsed === null && bar) {
          grokBotUsed = parseInt(bar.getAttribute('aria-valuenow'), 10);
        }

        const resetMatch = (card?.innerText || card?.textContent || '').match(/(?:重置|Resets?)\s*(\d+年\d+月\d+日\s*\d+:\d+|\S+)/i);
        if (resetMatch) grokBotResetAt = resetMatch[1].trim();
      }
    }

    const superGrokRemaining = superGrokUsed !== null ? Math.max(0, 100 - superGrokUsed) : null;
    const grokBotRemaining = grokBotUsed !== null ? Math.max(0, 100 - grokBotUsed) : null;

    return {
      ok: true,
      sampledAt: Date.now(),
      confidence: (superGrokUsed !== null || grokBotUsed !== null) ? 'high' : 'low',
      superGrok: {
        usedPercent: superGrokUsed,
        remainingPercent: superGrokRemaining,
        resetAt: superGrokResetAt,
        isExhausted: superGrokRemaining !== null ? superGrokRemaining <= 2 : false
      },
      grokBot: {
        usedPercent: grokBotUsed,
        remainingPercent: grokBotRemaining,
        resetAt: grokBotResetAt,
        isAvailable: grokBotRemaining !== null ? grokBotRemaining > 5 : false
      }
    };
  } finally {
    closeDialog();
    closeMenu();
  }
}

/**
 * in-page: 探测当前用户配置的 Grok Bot 列表（优先读取 localStorage 目录，辅助匹配侧边栏）
 */
export function inspectGrokBotsOnPage() {
  const bots = [];
  try {
    const raw = localStorage.getItem('grok-bot-mention-directory');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.name) {
            bots.push({
              agentId: item.agentId || null,
              name: item.name,
              description: item.description || ''
            });
          }
        }
      }
    }
  } catch {}

  const sidebarElements = Array.from(document.querySelectorAll('a, button, div[role="button"]'));
  for (const el of sidebarElements) {
    const text = (el.innerText || el.textContent || '').trim();
    if (text && !bots.some(b => b.name === text)) {
      const parentSection = el.closest('nav, aside, [role="navigation"]') || el.parentElement;
      const sectionText = (parentSection?.innerText || parentSection?.textContent || '');
      if (sectionText.includes('机器人') || sectionText.includes('Bots') || sectionText.includes('Agents')) {
        if (text !== '机器人' && text !== 'Bots' && text !== 'Agents' && text.length < 30) {
          bots.push({ agentId: null, name: text, description: '' });
        }
      }
    }
  }

  return { ok: true, bots };
}

/**
 * in-page: 切换至目标 Grok Bot 会话
 */
export async function switchToGrokBotOnPage(target) {
  const botName = typeof target === 'string' ? target : (target?.name || '');
  const agentId = typeof target === 'object' && target?.agentId ? target.agentId : null;
  if (!botName && !agentId) return { ok: false, reason: '未指定目标 Grok Bot' };

  const currentPath = typeof location !== 'undefined' ? (location.pathname || '') : '';
  const currentSearch = typeof location !== 'undefined' ? (location.search || '') : '';
  const composer = document.querySelector('[contenteditable="true"], textarea');
  const placeholder = composer?.getAttribute('placeholder') || '';
  const headerText = (document.querySelector('header, [role="banner"], h1, h2, [data-testid="chat-header"]')?.innerText || '');

  const matchesBotTarget = () => {
    if (agentId && (currentPath.includes(`/agent/${agentId}`) || currentPath.includes(`/bot/${agentId}`) || currentSearch.includes(`agent=${agentId}`) || currentSearch.includes(`bot=${agentId}`))) {
      return true;
    }
    if (botName) {
      if (currentPath.includes(`/agent/${encodeURIComponent(botName)}`) || currentPath.includes(`/bot/${encodeURIComponent(botName)}`)) return true;
      if (placeholder && placeholder.toLowerCase().includes(botName.toLowerCase())) return true;
      if (headerText && headerText.toLowerCase().includes(botName.toLowerCase())) return true;
    }
    return false;
  };

  if (matchesBotTarget() && composer) {
    return { ok: true, botName, agentId, alreadyActive: true };
  }

  const candidates = Array.from(document.querySelectorAll('a, button, div[role="button"], span'));
  const match = candidates.find(el => {
    const text = (el.innerText || el.textContent || '').trim();
    const href = el.closest('a')?.getAttribute('href') || el.getAttribute('href') || '';
    if (agentId && href && (href.includes(`/agent/${agentId}`) || href.includes(`/bot/${agentId}`))) {
      return true;
    }
    if (botName && text.toLowerCase() === botName.toLowerCase()) {
      return el.closest('a') || el.closest('button') || el.getAttribute('role') === 'button' || el.classList?.contains('cursor-pointer') || el.parentElement?.getAttribute('role') === 'button';
    }
    return false;
  });

  const clickable = match ? (match.closest('a') || match.closest('button') || match) : null;
  if (!clickable) {
    return { ok: false, reason: `未在页面中找到 Grok Bot [${botName || agentId}] 的入口` };
  }

  clickable.click();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const curPath = typeof location !== 'undefined' ? (location.pathname || '') : '';
    const curSearch = typeof location !== 'undefined' ? (location.search || '') : '';
    const curComposer = document.querySelector('[contenteditable="true"], textarea');
    const curPlaceholder = curComposer?.getAttribute('placeholder') || '';
    const curHeader = (document.querySelector('header, [role="banner"], h1, h2, [data-testid="chat-header"]')?.innerText || '');

    const verified = (
      (agentId && (curPath.includes(`/agent/${agentId}`) || curPath.includes(`/bot/${agentId}`) || curSearch.includes(`agent=${agentId}`) || curSearch.includes(`bot=${agentId}`))) ||
      (botName && (
        (curPlaceholder && curPlaceholder.toLowerCase().includes(botName.toLowerCase())) ||
        (curHeader && curHeader.toLowerCase().includes(botName.toLowerCase())) ||
        curPath.includes(`/agent/${encodeURIComponent(botName)}`) ||
        curPath.includes(`/bot/${encodeURIComponent(botName)}`)
      ))
    );

    if (verified && curComposer) {
      return { ok: true, botName, agentId, switched: true };
    }
  }
  return { ok: false, reason: `切换至 Grok Bot [${botName || agentId}] 超时或未能确认目标会话就绪` };
}

/**
 * in-page: 从可见的账号菜单检查账号身份，提取登录邮箱并转换为稳定哈希值
 * 遵循 Codex 实机勘察路径：
 * 点击 button[aria-label^="Account menu,"] 展开可见 role=menu；
 * 第一行为登录账号邮箱，随后紧接 设置、帮助、退出登陆；
 * 检查后安全关闭菜单，绝不点击设置或退出，绝不持久化或回显明文邮箱。
 */
export async function inspectGrokComAccountIdentityOnPage() {
  const host = location.hostname;
  if (host !== 'grok.com' && !String(host || '').endsWith('.grok.com')) {
    return { ok: false, reason: '非 grok.com 页面' };
  }

  const accountBtn = document.querySelector('button[aria-label^="Account menu"], [aria-label*="Account menu"]');
  if (!accountBtn) {
    return { ok: false, notLoggedIn: true, reason: '未找到账号菜单按钮（可能未登录）' };
  }
  const accountLabel = (accountBtn.getAttribute('aria-label') || '').trim();

  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const readMenu = () => document.querySelector('[role="menu"]');
  let menu = readMenu();
  let openedByUs = false;
  if (!menu) {
    accountBtn.click();
    openedByUs = true;
  }

  // 菜单是异步渲染的。点开后立刻读取会漏掉邮箱，必须等到可见菜单里出现邮箱或确认没有。
  let detectedEmail = null;
  let visibleWithoutEmail = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    menu = readMenu();
    const menuText = (menu?.innerText || menu?.textContent || '').trim();
    const emailMatch = menuText.match(emailPattern);
    if (emailMatch) {
      detectedEmail = emailMatch[0].trim().toLowerCase();
      break;
    }
    visibleWithoutEmail = menu ? visibleWithoutEmail + 1 : 0;
    if (visibleWithoutEmail >= 3) break;
    if (attempt < 39) await new Promise(resolve => setTimeout(resolve, 50));
  }

  if (openedByUs && menu) {
    try {
      if (typeof KeyboardEvent !== 'undefined') {
        accountBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      }
    } catch {}
    try {
      document.body?.click();
    } catch {}
  }

  if (!detectedEmail) {
    return { ok: false, notLoggedIn: true, reason: '未能从账号菜单中识别登录邮箱' };
  }

  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x67452301, h4 = 0xefcdab89;
  for (let i = 0; i < detectedEmail.length; i++) {
    const ch = detectedEmail.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 2246822507);
    h4 = Math.imul(h4 ^ ch, 3266489909);
  }
  const toHex = n => (n >>> 0).toString(16).padStart(8, '0');
  const ownerKey = `ghash_${toHex(h1)}${toHex(h2)}${toHex(h3)}${toHex(h4)}`;

  return {
    ok: true,
    ownerKey,
    accountLabel
  };
}

/**
 * in-page: 查找可见的 Grok 输入框（严格跳过隐藏的 textarea）
 */
export function findVisibleGrokComInputOnPage() {
  const editable = document.querySelector('[contenteditable="true"].tiptap.ProseMirror, [contenteditable="true"]');
  if (editable && (editable.offsetParent !== null || (editable.getClientRects && editable.getClientRects().length > 0))) {
    return editable;
  }
  const all = document.querySelectorAll('[contenteditable="true"], textarea');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.tagName === 'TEXTAREA') {
      const isHidden = el.offsetParent === null ||
        (window.getComputedStyle && (window.getComputedStyle(el).display === 'none' || window.getComputedStyle(el).visibility === 'hidden'));
      if (isHidden) continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 10) return el;
  }
  return null;
}

/**
 * in-page: 提交前安全检查
 * 检查项：是否已登录、输入框是否存在未发送的用户草稿、当前会话是否被用户手动切换
 */
export function inspectGrokComPageBeforeSubmitOnPage(nonce, conversationId, options = {}) {
  const host = location.hostname;
  if (host !== 'grok.com' && !String(host || '').endsWith('.grok.com')) return { ok: false, reason: '当前页面不是 grok.com' };
  if (/\/(login|sign-?in)/i.test(location.pathname)) return { ok: false, notLoggedIn: true, reason: 'grok.com 未登录' };

  // 查找函数必须写在本函数体内。chrome.scripting 只序列化被传入的函数，模块级助手在页面里不存在。
  const findInput = () => {
    const editable = document.querySelector('[contenteditable="true"].tiptap.ProseMirror, [contenteditable="true"]');
    if (editable && (editable.offsetParent !== null || (editable.getClientRects && editable.getClientRects().length > 0))) {
      return editable;
    }
    const all = document.querySelectorAll('[contenteditable="true"], textarea');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.tagName === 'TEXTAREA') {
        const isHidden = el.offsetParent === null ||
          (window.getComputedStyle && (window.getComputedStyle(el).display === 'none' || window.getComputedStyle(el).visibility === 'hidden'));
        if (isHidden) continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 10) return el;
    }
    return null;
  };

  // 1. 输入框与用户草稿检查（严格跳过隐藏 textarea）
  const input = findInput();
  if (!input) return { ok: false, noInput: true, reason: 'grok.com 未找到可见输入框（可能未就绪或未开通）' };

  const draft = (input.tagName === 'TEXTAREA' ? input.value : (input.innerText || input.textContent || '')).trim();
  if (draft.length > 0 && !draft.includes(nonce)) {
    return {
      ok: false,
      userDraftDetected: true,
      draftText: draft.slice(0, 80),
      reason: 'Grok 输入框存在未发送的用户草稿，已暂停自动提交以保护内容'
    };
  }

  // 2. 会话归属与目标 Bot 核验
  const pathname = location.pathname;
  const search = location.search;
  const expectedBotName = options?.expectedBotName;
  const expectedAgentId = options?.expectedAgentId;

  if (expectedBotName || expectedAgentId) {
    const headerText = (document.querySelector('header, [role="banner"], h1, h2, [data-testid="chat-header"]')?.innerText || '');
    const placeholder = input.getAttribute('placeholder') || '';
    const inBotPage = Boolean(
      (expectedAgentId && (pathname.includes(`/agent/${expectedAgentId}`) || pathname.includes(`/bot/${expectedAgentId}`) || search.includes(`agent=${expectedAgentId}`) || search.includes(`bot=${expectedAgentId}`))) ||
      (expectedBotName && (
        (placeholder && placeholder.toLowerCase().includes(expectedBotName.toLowerCase())) ||
        (headerText && headerText.toLowerCase().includes(expectedBotName.toLowerCase())) ||
        pathname.includes(`/agent/${encodeURIComponent(expectedBotName)}`) ||
        pathname.includes(`/bot/${encodeURIComponent(expectedBotName)}`)
      ))
    );
    if (!inBotPage) {
      return {
        ok: false,
        switchedConversation: true,
        reason: `提交前核验失败：当前页面不是目标 Grok Bot [${expectedBotName || expectedAgentId}] 会话`
      };
    }
  } else {
    const match = pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
    const currentConvId = match ? match[1] : null;
    const expectedConvId = conversationId || null;
    if (expectedConvId !== currentConvId) {
      return {
        ok: false,
        switchedConversation: true,
        currentConvId,
        expectedConvId,
        reason: expectedConvId
          ? '当前页面不是已记录的会话，已暂停自动提交'
          : '期望新会话，但当前页面已位于其他会话，已暂停自动提交'
      };
    }
  }

  return {
    ok: true,
    currentConvId: (pathname.match(/\/c\/([a-zA-Z0-9_-]+)/) || [])[1] || null,
    currentUrl: location.href,
    hasDraft: draft.length > 0
  };
}

/**
 * in-page: 快照页面当前已有的推荐问题按钮特征（提交前采集，作为本轮新增推荐问题的比对基准）
 */
export function snapshotGrokComRecommendationsOnPage() {
  const describe = button => {
    const text = String(button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) return null;
    const aria = `${button.getAttribute?.('aria-label') || ''} ${button.getAttribute?.('title') || ''}`;
    if (/copy|复制|clipboard|regenerate|重新生成|retry|重试|like|赞|dislike|踩|share|分享|stop|停止|提交|submit|send|发送/i.test(aria)) return null;
    const slot = button.getAttribute?.('data-slot') || '';
    const ask = selector => {
      try { return button.querySelector?.(selector) || null; } catch { return null; }
    };
    const arrow = ask('svg path[d*="M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12"]');
    const exactSpan = ask('span.min-w-0.overflow-x-clip.text-ellipsis.whitespace-nowrap');
    const container = typeof button.closest === 'function' ? button.closest('div.flex.w-full.flex-col.gap-1.pt-1') : null;
    const arrowDown = ask('g[id*="arrow-down-right"], [id="name=arrow-down-right"], svg[data-icon="arrow-down-right"]');
    const variant1 = Boolean(arrow && text) || Boolean(slot === 'xds-button' && exactSpan && container);
    const variant2 = Boolean(slot === 'button' && arrowDown && ask('span[class*="text-box:trim-both_cap_alphabetic"]'));
    if (!variant1 && !variant2) return null;
    return text;
  };

  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  const signatures = [];
  for (let index = 0; index < buttons.length; index++) {
    const button = buttons[index];
    const text = describe(button);
    if (!text) continue;
    const nodeId = button.getAttribute?.('data-xf-snap') || `snap-${index}-${text.length}`;
    if (typeof button.setAttribute === 'function' && !button.getAttribute('data-xf-snap')) {
      button.setAttribute('data-xf-snap', nodeId);
    }
    signatures.push({ nodeId, text });
  }
  return signatures;
}

/**
 * in-page: 确认本轮问题已被服务器或页面成功接收（作为计数依据）
 * 铁律：
 * 1. 绝不依赖 inputCleared 或泛化叶子节点（防止未填输入或未发送草稿误判）
 * 2. 必须要求在输入框/composer 外部存在明确包含本轮 nonce 的 [data-testid="user-message"]
 * 3. 必须处于规范会话路径 /c/UUID
 */
export function confirmGrokComPromptAcceptedOnPage(nonce) {
  const host = location.hostname;
  if (!host.includes('grok.com')) {
    return { accepted: false, reason: '非 grok.com 页面' };
  }

  const composers = Array.from(document.querySelectorAll?.('[contenteditable="true"], textarea, form, [data-testid="chat-input-container"]') || []);

  const userBubbles = Array.from(document.querySelectorAll?.('[data-testid="user-message"]') || []);
  const matchingBubble = userBubbles.find(bubble => {
    const text = bubble.textContent || '';
    if (!text.includes(nonce)) return false;
    const isInsideComposer = composers.some(comp => comp.contains(bubble) || comp === bubble);
    return !isInsideComposer;
  });

  const hasUserBubbleOutsideComposer = Boolean(matchingBubble);
  const pathname = location.pathname || '';
  const match = pathname.match(/^\/(?:c|agent|bot|g)\/([a-zA-Z0-9_-]+)/) || pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
  const conversationId = match ? match[1] : null;
  const accepted = hasUserBubbleOutsideComposer && Boolean(conversationId);

  return {
    accepted,
    hasUserBubbleOutsideComposer,
    conversationId,
    conversationUrl: conversationId ? `https://grok.com/c/${conversationId}` : location.href,
    reason: !accepted
      ? (!hasUserBubbleOutsideComposer ? '未找到包含当前凭证的独立用户消息气泡' : '当前 URL 未进入有效会话路径 /c/UUID')
      : 'ok'
  };
}

/**
 * in-page: 单轮回答读取与完成核验
 * 核心规则（2026-10-19 最终明确规定）：
 * 1. 定位属于本轮 nonce 的 user-message，并截取紧随其后的 assistant-message，在遇到下一轮 user-message 前停止。
 * 2. 回答文本必须且仅能来自该 assistant-message 内部的 .response-content-markdown，严禁全页面 fallback 或猜测。
 * 3. 严禁回显 prompt，严禁将推荐问题混入回答正文。
 * 4. 完成信号：必须出现本轮紧随回答后的“后续推荐问题（follow-up recommended questions）”！
 *    严禁以 Copy（复制）、Regenerate（重新生成）或任何通用后续按钮作为完成信号。
 * 5. 推荐问题支持变体 1（xds-button / min-w-0 span / 弯箭头）与变体 2（arrow-down-right / text-box:trim-both）。
 * 6. 必须核验无 active stop 按钮，且 Markdown 正文非空稳定。
 */
export function readGrokComTurnAnswerOnPage(nonce, preSubmitSignatures = [], options = {}) {
  // 1. 定位包含此 nonce 的用户气泡
  const userBubbles = Array.from(document.querySelectorAll('[data-testid="user-message"]'));
  const userMessage = userBubbles.find(b => (b.textContent || '').includes(nonce));

  if (!userMessage) {
    return { text: '', done: false, notFound: true };
  }

  // 2. 定位属于本轮回复的 assistant 容器，并在遇到下一轮 user-message 前停止
  const allMessages = Array.from(document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]'));
  const userIdx = allMessages.indexOf(userMessage);
  let assistantMessage = null;

  if (userIdx >= 0) {
    for (let i = userIdx + 1; i < allMessages.length; i++) {
      const el = allMessages[i];
      if (el.getAttribute('data-testid') === 'user-message') {
        break;
      }
      if (el.getAttribute('data-testid') === 'assistant-message') {
        assistantMessage = el;
        break;
      }
    }
  }

  if (!assistantMessage) {
    return { text: '', done: false, userMessageFound: true, waitingForAssistant: true };
  }

  // 检查额度提示卡片（识别用户提供的内联提示卡片：您的使用上限已更新 / 您现在可以继续了 / 重试）
  const wholeAssistantText = (assistantMessage.innerText || assistantMessage.textContent || '').trim();
  const isQuotaUpdatedCard = /使用上限已更新|usage limit has (?:been )?updated|usage limit has reset|现在可以继续了|you can (?:now )?continue/i.test(wholeAssistantText);
  const isQuotaExhaustedCard = /已达(?:到)?使用上限|已达到上限|usage limit reached|limit reached|you(?:'ve| have) reached your (?:daily |weekly )?limit/i.test(wholeAssistantText);

  const retryBtn = Array.from(assistantMessage.querySelectorAll('button, [role="button"]')).find(b => {
    const t = (b.innerText || b.textContent || b.getAttribute?.('aria-label') || '').trim();
    return /^(?:重试|retry)$/i.test(t) || t.includes('重试') || t.includes('Retry');
  });

  if (isQuotaUpdatedCard && retryBtn) {
    return {
      text: '',
      done: false,
      quotaPrompt: { type: 'quota_updated_retry_available', canRetry: true },
      failed: false,
      reason: '检测到 Grok 使用上限已更新提示卡片，可安全重试',
      userMessageFound: true
    };
  }

  if (isQuotaExhaustedCard && !retryBtn) {
    return {
      text: '',
      done: false,
      quotaPrompt: { type: 'quota_exhausted', canRetry: false },
      failed: true,
      reason: 'Grok 使用上限已达',
      userMessageFound: true
    };
  }

  // 3. 提取 Markdown 正文（严格仅取 .response-content-markdown，严禁全页面 fallback）
  const mdEl = assistantMessage.querySelector('.response-content-markdown');
  const turnText = mdEl ? (mdEl.innerText || mdEl.textContent || '').trim() : '';

  if (!turnText) {
    return { text: '', done: false, userMessageFound: true, emptyMarkdown: true };
  }

  // 4. 检查是否仍在生成中。停止按钮文案包含 Stop response / 停止响应，不能只认英文 Stop。
  const stopButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
    const aria = (b.getAttribute?.('aria-label') || '').trim();
    const text = (b.innerText || b.textContent || '').trim();
    const stopLabel = /stop(?:\s+(?:generating|response))?|停止(?:生成|响应)?/i;
    return stopLabel.test(aria) || stopLabel.test(text);
  });
  const stillGenerating = stopButtons.length > 0;

  // 5. 检查模型报错信息
  const failed = /Grok was unable to reply|Something went wrong, please refresh|操作过于频繁|无法回复|An error occurred|Limit reached|已达到使用上限/i.test(turnText);
  if (failed) {
    return { text: '', done: false, failed: true, reason: 'Grok 模型报错或无法回复' };
  }

  // 6. 只看当前助手回合父节点里、紧随该 article 的推荐组。复制/重新生成在 article 内部，不能当成完成信号。
  const isHidden = el => {
    if (!el) return true;
    if (el.hidden || el.getAttribute?.('aria-hidden') === 'true' || el.getAttribute?.('data-opacity') === '0') return true;
    try {
      const view = typeof window !== 'undefined' ? window : globalThis;
      const style = view.getComputedStyle ? view.getComputedStyle(el) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return true;
    } catch {}
    return false;
  };
  const turnGroups = [];
  const parent = assistantMessage.parentElement;
  if (parent?.children) {
    const children = Array.from(parent.children);
    const start = children.indexOf(assistantMessage);
    for (let i = start + 1; i < children.length; i++) {
      const child = children[i];
      if (child.getAttribute?.('data-testid') === 'user-message' || child.querySelector?.('[data-testid="user-message"]')) break;
      turnGroups.push(child);
    }
  } else {
    let next = assistantMessage.nextElementSibling;
    while (next) {
      if (next.getAttribute?.('data-testid') === 'user-message' || next.querySelector?.('[data-testid="user-message"]')) break;
      turnGroups.push(next);
      next = next.nextElementSibling;
    }
  }

  const prior = new Map();
  for (const entry of Array.isArray(preSubmitSignatures) ? preSubmitSignatures : []) {
    if (typeof entry === 'string') prior.set(entry, null);
    else if (entry?.nodeId) prior.set(entry.nodeId, entry.text ?? null);
  }

  const recommendationButtons = [];
  for (const root of turnGroups) {
    if (isHidden(root)) continue;
    const btns = Array.from(root.querySelectorAll?.('button, [role="button"]') || []);
    for (const b of btns) {
      if (isHidden(b)) continue;
      const aria = `${b.getAttribute?.('aria-label') || ''} ${b.getAttribute?.('title') || ''}`.trim();
      if (/copy|复制|clipboard|regenerate|重新生成|retry|重试|like|赞|dislike|踩|share|分享|stop|停止|提交|submit|send|发送/i.test(aria)) continue;
      const text = String(b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2) continue;
      const slot = b.getAttribute?.('data-slot') || '';
      const ask = selector => {
        try { return b.querySelector?.(selector) || null; } catch { return null; }
      };
      const arrow = ask('svg path[d*="M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12"]');
      const exactSpan = ask('span.min-w-0.overflow-x-clip.text-ellipsis.whitespace-nowrap');
      const container = typeof b.closest === 'function' ? b.closest('div.flex.w-full.flex-col.gap-1.pt-1') : null;
      const groupIsExact = /gap-1/.test(root.className || '') && /pt-1/.test(root.className || '');
      const variant1 = Boolean(arrow) || Boolean(slot === 'xds-button' && exactSpan && (container || groupIsExact));
      const arrowDown = ask('g[id*="arrow-down-right"], [id="name=arrow-down-right"], svg[data-icon="arrow-down-right"]');
      const variant2 = Boolean(slot === 'button' && arrowDown && ask('span[class*="text-box:trim-both_cap_alphabetic"]'));
      if (!variant1 && !variant2) continue;
      const nodeId = b.getAttribute?.('data-xf-snap') || '';
      const previousText = nodeId && prior.has(nodeId) ? prior.get(nodeId) : undefined;
      const reusedUnchanged = Boolean(nodeId) && prior.has(nodeId) && (previousText === null || previousText === text);
      if (reusedUnchanged) continue;
      recommendationButtons.push(text);
    }
  }

  const currentQuestions = Array.from(new Set(recommendationButtons));
  // 同一问句可以在新回合再次出现。新鲜度看当前回合的节点是否为新节点或文本已相对快照更新，不看问句是否和上一轮相同。
  const hasNewRecommendations = currentQuestions.length > 0;

  // 严格完成门禁：无停止按钮、具有非空 Markdown、且本轮新推荐问题已出现或匹配 Bot 回复终态
  const hasTerminatingCommentTag = (/【引用评价结束】/.test(turnText) && /【评价语言:/.test(turnText)) || turnText.trim() === '【跳过评价】';
  const isBotChat = Boolean(
    (options && options.isBotChannel) ||
    (typeof location !== 'undefined' && (
      (location.pathname && (location.pathname.includes('/agent/') || location.pathname.includes('/bot/'))) ||
      (location.search && location.search.includes('bot='))
    ))
  );
  const done = !stillGenerating && turnText.length > 0 && (Boolean(hasNewRecommendations) || isBotChat || hasTerminatingCommentTag);

  return {
    text: turnText,
    done,
    failed: false,
    emptyMarkdown: turnText.length === 0,
    hasNewRecommendations,
    currentQuestions,
    userMessageFound: true
  };
}

/**
 * in-page: 在 grok.com 页面上执行当前会话的安全核验删除
 */
export function deleteGrokComCurrentConversationOnPage(expectedConversationId) {
  const currentPath = location.pathname;
  const match = currentPath.match(/^\/c\/([a-zA-Z0-9_-]+)/);
  const currentId = match ? match[1] : null;

  if (!expectedConversationId || !currentId || currentId !== expectedConversationId) {
    return { ok: false, reason: `当前会话 ID (${currentId}) 与待删除会话 ID (${expectedConversationId}) 不符，拒绝删除` };
  }

  // 1. 查找会话顶部的“更多”选项菜单按钮
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  const moreBtn = buttons.find(b => {
    const aria = (b.getAttribute('aria-label') || '').trim();
    return /^更多$|^more options$|^more$/i.test(aria) ||
      b.getAttribute('data-testid') === 'conversation-options-button' ||
      b.getAttribute('data-testid') === 'chat-options-menu';
  });

  if (!moreBtn) {
    return { ok: false, reason: '未找到会话头部“更多”选项菜单按钮' };
  }

  moreBtn.click();

  // 2. 再次核验 URL 确保点击后仍处于期望会话
  const recheckPath = location.pathname;
  if (!recheckPath.includes(`/c/${expectedConversationId}`)) {
    document.body?.click();
    return { ok: false, reason: '展开菜单后会话发生偏移，已终止删除' };
  }

  // 3. 在展开的 role=menu 中查找“删除聊天”
  const menuItems = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button, [role="menuitem"]'));
  const deleteItem = menuItems.find(item => {
    const txt = (item.innerText || item.textContent || '').trim();
    return /^(?:删除聊天|delete chat)$/i.test(txt);
  });

  if (!deleteItem) {
    document.body?.click();
    return { ok: false, reason: '菜单中未找到“删除聊天”选项' };
  }

  deleteItem.click();

  // 4. 可选弹窗：严格限定在 role="dialog" 或 role="alertdialog" 范围内点击确认
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
  if (dialog) {
    const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(b => {
      const txt = (b.innerText || b.textContent || '').trim();
      return /^(?:删除|确定|确认|delete|confirm)$/i.test(txt) && !b.disabled;
    });
    if (confirmBtn) {
      confirmBtn.click();
    }
  }

  return { ok: true, action: 'delete_triggered', expectedConversationId };
}

/**
 * in-page: 核验会话删除的实质证据（首页 URL + 侧边栏链接消失 + 删除 toast 提示）
 */
export function verifyGrokComDeletionProofOnPage(oldConversationId) {
  const currentPath = location.pathname;
  const urlOk = (currentPath === '/' || currentPath === '') && !location.href.includes(`/c/${oldConversationId}`);

  const oldSidebarLink = document.querySelector(`a[href*="/c/${oldConversationId}"]`);
  const sidebarLinkAbsent = !oldSidebarLink;

  const toasts = Array.from(document.querySelectorAll('[role="status"], [role="alert"], [data-testid*="toast"], div'));
  const hasToast = toasts.some(el => {
    const txt = (el.innerText || el.textContent || '').trim();
    return /已删除|deleted/i.test(txt);
  });

  const verified = urlOk && sidebarLinkAbsent && hasToast;

  return {
    verified,
    proofs: {
      urlOk,
      sidebarLinkAbsent,
      hasToast
    },
    currentUrl: location.href
  };
}

/**
 * in-page: 点击弹窗中的确认删除按钮（兜底）
 */
export function confirmGrokComDeletionOnPage() {
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
  if (!dialog) return { ok: false, reason: '未找到弹窗' };
  const buttons = Array.from(dialog.querySelectorAll('button'));
  const confirmBtn = buttons.find(b => {
    const txt = `${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`.trim();
    return /^(?:confirm|delete|yes|确定|删除)$/i.test(txt) && !b.disabled;
  });
  if (confirmBtn) {
    confirmBtn.click();
    return { ok: true, action: 'confirmed' };
  }
  return { ok: false, reason: '未找到确认删除弹窗按钮' };
}

/**
 * in-page: 探测 grok.com 页面就绪状态
 */
export function probeGrokComPageOnPage() {
  const url = window.location.href;
  if (/login|signin/i.test(url)) {
    return { ok: false, reason: 'grok.com 用户未登录' };
  }
  const bodyText = (document.body ? document.body.innerText : '') || '';
  if (/(Sign in|Log in to continue|Sign in with X)/i.test(bodyText) && !document.querySelector('[contenteditable="true"]')) {
    return { ok: false, reason: 'grok.com 用户未登录' };
  }
  if (/Subscription required|Upgrade to continue|Limit reached/i.test(bodyText)) {
    return { ok: false, reason: 'grok.com 未开通使用权限或额度耗尽' };
  }

  // 自包含查找。不能调用模块级 findVisibleGrokComInputOnPage，序列化注入后该名字不存在。
  const editable = document.querySelector('[contenteditable="true"].tiptap.ProseMirror, [contenteditable="true"]');
  if (editable && (editable.offsetParent !== null || (editable.getClientRects && editable.getClientRects().length > 0))) {
    return { ok: true, reason: 'grok.com 输入框就绪（可进行对话互动）' };
  }
  const all = document.querySelectorAll('[contenteditable="true"], textarea');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.tagName === 'TEXTAREA') {
      const isHidden = el.offsetParent === null ||
        (window.getComputedStyle && (window.getComputedStyle(el).display === 'none' || window.getComputedStyle(el).visibility === 'hidden'));
      if (isHidden) continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 10) return { ok: true, reason: 'grok.com 输入框就绪（可进行对话互动）' };
  }
  return { ok: false, reason: '未在 grok.com 找到对话输入框' };
}

// ---------------- 协调器互斥队列与生命周期管理 ----------------

let coordinatorLock = Promise.resolve();

/**
 * 排队串行互斥执行器
 */
export function withSessionLock(fn) {
  const work = coordinatorLock.then(fn, fn);
  coordinatorLock = work.catch(() => {});
  return work;
}

const TEMP_WINDOW_PREFIX = 'xfTemporaryWindow:';

/**
 * 用临时窗口注册表里的原令牌核对 popup、唯一标签、精确 origin 与 window.name。
 * 不匹配时只放弃控制，不关闭用户已经移走或改过的窗口。
 */
export async function confirmGrokWindowOwnership(sessionState, { expectedConversationId, requireConversation = false } = {}) {
  if (!sessionState?.windowId) return { ok: false, absent: true, reason: '没有已记录的常驻窗口' };
  let win = null;
  try {
    win = await chrome.windows.get(sessionState.windowId, { populate: true });
  } catch {
    return { ok: false, missing: true, reason: '已记录的常驻窗口不存在' };
  }
  const key = TEMP_WINDOW_PREFIX + sessionState.windowId;
  const record = (await chrome.storage.session.get(key))?.[key] || null;
  const tabs = Array.isArray(win?.tabs) ? win.tabs : [];
  const tab = tabs.length === 1 ? tabs[0] : null;
  let origin = '';
  try { origin = new URL(tab?.pendingUrl || tab?.url || '').origin; } catch { origin = ''; }
  let marker = null;
  if (tab?.id) {
    try {
      marker = (await executeGrokScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: readTemporaryWindowOwnerOnPage
      }))?.[0]?.result;
    } catch (error) {
      if (error?.userActionRequired || error?.grokVerificationTimeout) throw error;
      marker = null;
    }
  }
  const canonical = extractCanonicalGrokUrl(tab?.pendingUrl || tab?.url || '');
  const owned = Boolean(
    win?.type === 'popup' &&
    tab &&
    tab.id === sessionState.tabId &&
    record &&
    record.windowId === win.id &&
    record.tabId === tab.id &&
    record.ownershipToken &&
    record.ownershipToken === sessionState.ownershipToken &&
    marker === `xfollower-owned:${record.ownershipToken}` &&
    origin === 'https://grok.com'
  );
  if (!owned) {
    return { ok: false, foreign: true, reason: '常驻窗口归属、标签或来源不匹配，已放弃控制且不会关闭该窗口' };
  }
  if (requireConversation) {
    const currentId = canonical?.conversationId || null;
    const expectedId = expectedConversationId || null;
    if (currentId !== expectedId) {
      return {
        ok: false,
        conversationMismatch: true,
        currentId,
        expectedId,
        reason: '当前标签页会话与记录不一致，已拒绝发送、关闭或删除'
      };
    }
  }
  return { ok: true, win, tab, record, canonical };
}

function relinquishGrokWindow(sessionState, reason) {
  sessionState.windowId = null;
  sessionState.tabId = null;
  sessionState.ownershipToken = null;
  sessionState.state = 'paused';
  sessionState.pausedReuse = true;
  sessionState.lastError = reason;
}

/**
 * 确保受管常驻 grok.com 窗口与标签页就绪。
 * 已有窗口校验失败时暂停，不另开第二个窗口。新建窗口沿用临时窗口注册表中的令牌。
 */
export async function ensureGrokPersistentWindow(sessionState) {
  let tabId = null;

  if (sessionState.windowId) {
    const owned = await confirmGrokWindowOwnership(sessionState);
    if (owned.ok) {
      tabId = owned.tab.id;
    } else if (owned.missing) {
      sessionState.windowId = null;
      sessionState.tabId = null;
      sessionState.ownershipToken = null;
    } else {
      relinquishGrokWindow(sessionState, owned.reason);
      await saveGrokSessionState(sessionState);
      return { ok: false, paused: true, reason: owned.reason };
    }
  }

  if (!tabId) {
    if (sessionState.pausedReuse) {
      return { ok: false, paused: true, reason: sessionState.lastError || 'Grok 常驻窗口已暂停，不会另开窗口' };
    }
    const isNewChat = !sessionState.conversationUrl || sessionState.conversationUrl === 'https://grok.com/';
    const targetUrl = sessionState.conversationUrl || 'https://grok.com/';
    const win = await createTemporaryWindow({
      url: targetUrl,
      type: 'popup',
      focused: false,
      width: 800,
      height: 600
    }, 'grok-persistent', 0);

    const tabs = win.tabs || (await chrome.tabs.query({ windowId: win.id }));
    tabId = tabs?.[0]?.id;
    const key = TEMP_WINDOW_PREFIX + win.id;
    const record = (await chrome.storage.session.get(key))?.[key];
    if (!tabId || !record?.ownershipToken || record.tabId !== tabId) {
      relinquishGrokWindow(sessionState, '临时窗口注册表令牌缺失，已暂停且不会另建窗口');
      await saveGrokSessionState(sessionState);
      return { ok: false, paused: true, reason: sessionState.lastError };
    }

    sessionState.windowId = win.id;
    sessionState.tabId = tabId;
    sessionState.ownershipToken = record.ownershipToken;
    if (isNewChat) sessionState.createdByExtension = true;
    sessionState.state = sessionState.acceptedCount >= sessionState.limit ? 'rotation_pending' : 'ready';
    await saveGrokSessionState(sessionState);
  }

  // 等待页面加载完成并注入动画帧兜底
  const deadline = grokTaskNow() + 25000;
  while ((await chrome.tabs.get(tabId)).status !== 'complete') {
    if (grokTaskNow() > deadline) throw new Error('Grok 页面加载超时');
    await waitForGrokVerification(tabId);
    await new Promise(r => setTimeout(r, 250));
  }
  await executeGrokScript({ target: { tabId }, world: 'MAIN', func: setGrokFrameFallbackOnPage, args: [true] });

  return { ok: true, winId: sessionState.windowId, tabId };
}

/**
 * 探测 grok.com 状态（统一走常驻会话协调器，绝不创建独立的 8 分钟临时窗口池）
 */
export async function probeGrokSessionAvailability() {
  return withSessionLock(async () => {
    const session = await getGrokSessionState();
    const ensured = await ensureGrokPersistentWindow(session);
    if (!ensured?.tabId) return { ok: false, reason: ensured?.reason || '未能准备 Grok 窗口' };
    const { tabId } = ensured;
    const res = (await executeGrokScript({
      target: { tabId },
      func: probeGrokComPageOnPage
    }).catch(error => {
      if (error?.userActionRequired || error?.grokVerificationTimeout) throw error;
      return [{ result: { ok: false, reason: String(error?.message || error) } }];
    }))?.[0]?.result;
    return res || { ok: false, reason: '未能探测 grok.com 状态' };
  });
}

/**
 * 启动或恢复时的状态自愈检查与在途请求幂等对账
 * 关键安全纪律：
 * 1. 与提交流程共用协调器锁，避免启动回调与新提交交错。
 * 2. 读取或计数 activeRequest 之前，必须核验现存窗口的精确归属和规范会话。
 *    不得使用存储里可能已过期的 tabId。
 * 3. 在途请求未被确认或无法核验时保持 uncertain，禁止覆盖或重复计数。
 */
export async function recoverGrokSessionOnStartup() {
  return withSessionLock(reconcileGrokSession);
}

// Internal reconciliation shares the submission lock; never acquire it twice.
async function reconcileGrokSession() {
    const session = await getGrokSessionState();

    if (!session.activeRequest) {
      if (session.windowId) {
        try {
          await chrome.windows.get(session.windowId);
        } catch {
          session.windowId = null;
          session.tabId = null;
          await saveGrokSessionState(session);
        }
      }
      return session;
    }

    const req = session.activeRequest;
    const isExpired = Boolean(
      (req.deadline != null && Date.now() > req.deadline) ||
      (req.submittedAt && Date.now() - req.submittedAt > 180000)
    );
    const owned = await confirmGrokWindowOwnership(session, {
      expectedConversationId: session.conversationId || null,
      requireConversation: Boolean(session.conversationId)
    });
    if (!owned.ok || owned.tab?.id !== session.tabId) {
      if (owned.missing) {
        session.windowId = null;
        session.tabId = null;
        session.ownershipToken = null;
      }
      if (isExpired && owned.missing) {
        session.activeRequest = null;
        session.state = 'ready';
        session.lastError = '上一在途任务已超时且窗口已关闭，已自动解除状态防护并恢复可用';
        await saveGrokSessionState(session);
        return session;
      }
      session.state = 'uncertain';
      req.stage = 'uncertain';
      session.lastError = owned.reason || '启动恢复未能核验现存窗口与规范会话，在途请求已隔离';
      await saveGrokSessionState(session);
      return session;
    }

    const tabId = owned.tab.id;
    const canonicalId = owned.canonical?.conversationId || null;
    if (session.conversationId && canonicalId !== session.conversationId) {
      session.state = 'uncertain';
      req.stage = 'uncertain';
      session.lastError = '启动恢复时规范会话与记录不一致，已拒绝读取或计数';
      await saveGrokSessionState(session);
      return session;
    }

    try {
      const locate = (await executeGrokScript({
        target: { tabId },
        func: confirmGrokComPromptAcceptedOnPage,
        args: [req.nonce]
      }))?.[0]?.result;

      if (locate?.accepted) {
        const locatedId = locate.conversationId || null;
        if (locatedId && locatedId !== canonicalId) {
          session.state = 'uncertain';
          req.stage = 'uncertain';
          session.lastError = '页面确认的会话与规范会话不一致，已拒绝计数';
        } else {
          if (!req.acceptedCounted) {
            session.acceptedCount = (Number(session.acceptedCount) || 0) + 1;
            req.acceptedCounted = true;
          }
          if (locate.conversationId) {
            session.conversationId = locate.conversationId;
            session.conversationUrl = locate.conversationUrl || owned.canonical?.canonicalUrl || session.conversationUrl;
          }

          const answer = (await executeGrokScript({
            target: { tabId },
            func: readGrokComTurnAnswerOnPage,
            args: [req.nonce, req.preSubmitSignatures || []]
          }))?.[0]?.result;

          if (answer?.done || answer?.failed) {
            session.activeRequest = null;
            session.state = session.acceptedCount >= session.limit ? 'rotation_pending' : 'ready';
            session.lastError = '已自动完成在途状态自愈与恢复';
          } else if (isExpired) {
            session.activeRequest = null;
            session.state = session.acceptedCount >= session.limit ? 'rotation_pending' : 'ready';
            session.lastError = '上一在途任务已超过有效截止时间，已自动释放状态防护并恢复就绪';
          } else {
            session.state = 'uncertain';
            req.stage = 'uncertain';
          }
        }
      } else if (isExpired) {
        session.activeRequest = null;
        session.state = session.acceptedCount >= session.limit ? 'rotation_pending' : 'ready';
        session.lastError = '未确认接收的问题已超过有效截止时间，已自动释放状态防护';
      } else {
        session.state = 'uncertain';
        req.stage = 'uncertain';
      }
    } catch (error) {
      if (error?.userActionRequired || error?.grokVerificationTimeout) throw error;
      session.state = 'uncertain';
      req.stage = 'uncertain';
    }

    await saveGrokSessionState(session);
    return session;
}

/**
 * 执行轮换：在第 51 轮前核验删除旧会话并在同一窗口开启新会话
 * 关键安全纪律：
 * 1. 严格核验会话为扩展自身创建；非自身创建禁止删除。
 * 2. 核验稳定账号身份。
 * 3. 必须获得实质删除凭据（首页 URL + 侧边栏链接消失 + 删除 toast 提示）。
 * 4. 任何删除失败均阻断轮换，严禁清零计数或伪造新会话！
 */
export async function rotateGrokConversation(session, tabId, sleep) {
  if (!session.conversationId) {
    session.acceptedCount = 0;
    session.state = 'ready';
    session.rotation = null;
    await saveGrokSessionState(session);
    return session;
  }
  if (!session.createdByExtension) {
    session.state = 'paused';
    session.lastError = '当前会话非扩展创建，禁止自动删除，请手动处理';
    await saveGrokSessionState(session);
    throw new Error(session.lastError);
  }

  const owned = await confirmGrokWindowOwnership(session, {
    expectedConversationId: session.conversationId,
    requireConversation: true
  });
  if (!owned.ok || owned.tab?.id !== tabId) {
    if (owned.foreign) relinquishGrokWindow(session, owned.reason);
    else {
      session.state = 'paused';
      session.lastError = owned.reason || '删除前窗口或会话归属核验失败';
    }
    await saveGrokSessionState(session);
    throw new Error(session.lastError);
  }

  // 发送和删除都必须先确认身份。菜单未出现或没有邮箱时失败关闭，不能继续删除。
  const ident = (await executeGrokScript({
    target: { tabId },
    func: inspectGrokComAccountIdentityOnPage
  }).catch(error => {
    if (error?.userActionRequired || error?.grokVerificationTimeout) throw error;
    return [];
  }))?.[0]?.result;
  if (!ident?.ok) {
    session.state = 'paused';
    session.lastError = ident?.reason || '无法确认账号身份，已拒绝删除';
    await saveGrokSessionState(session);
    throw new Error(session.lastError);
  }
  if (session.ownerKey && ident.ownerKey !== session.ownerKey) {
    session.state = 'paused';
    session.lastError = '当前登录账号与会话所有者不一致，已拒绝自动删除以保护账号隔离';
    await saveGrokSessionState(session);
    throw new Error(session.lastError);
  }
  if (!session.ownerKey) {
    session.ownerKey = ident.ownerKey;
    session.accountLabel = ident.accountLabel;
  }

  session.state = 'rotating';
  session.rotation = {
    oldConversationId: session.conversationId,
    oldConversationUrl: session.conversationUrl,
    phase: 'delete_triggered',
    startedAt: Date.now(),
    lastError: null
  };
  await saveGrokSessionState(session);

  // 1. 在页面上触发删除
  const deleteRes = (await executeGrokScript({
    target: { tabId },
    func: deleteGrokComCurrentConversationOnPage,
    args: [session.conversationId]
  }).catch(e => {
    if (e?.userActionRequired || e?.grokVerificationTimeout) throw e;
    return [{ result: { ok: false, reason: String(e?.message || e) } }];
  }))?.[0]?.result;

  if (!deleteRes?.ok) {
    session.rotation.phase = 'failed';
    session.state = 'rotation_pending';
    session.lastError = deleteRes?.reason || '触发会话删除失败';
    await saveGrokSessionState(session);
    throw new Error(session.lastError);
  }

  await sleep(1500);

  // 2. 核验实质删除凭据（首页 URL + 侧边栏链接消失 + 删除 toast）
  const proof = (await executeGrokScript({
    target: { tabId },
    func: verifyGrokComDeletionProofOnPage,
    args: [session.conversationId]
  }).catch(() => []))?.[0]?.result;

  if (!proof?.verified) {
    session.rotation.phase = 'failed';
    session.state = 'rotation_pending';
    session.lastError = '会话删除凭证核验未通过，已阻止重置计数以防破坏历史记录';
    await saveGrokSessionState(session);
    throw new Error(session.lastError);
  }

  // 3. 导航回首页开启全新会话
  await chrome.tabs.update(tabId, { url: 'https://grok.com/' });
  const deadline = grokTaskNow() + 25000;
  while ((await chrome.tabs.get(tabId)).status !== 'complete') {
    if (grokTaskNow() > deadline) throw new Error('新会话页面加载超时');
    await waitForGrokVerification(tabId);
    await sleep(250);
  }

  // 4. 核验成功后方可重置计数与生成新会话
  session.conversationId = null;
  session.conversationUrl = 'https://grok.com/';
  session.acceptedCount = 0;
  session.generation = (Number(session.generation) || 1) + 1;
  session.createdByExtension = true;
  session.rotation = null;
  session.state = 'ready';
  session.lastError = null;
  await saveGrokSessionState(session);

  return session;
}

/**
 * 创建答案稳定门禁（与 grok-comment 共用 4 次采样逻辑）
 */
function createTurnAnswerGate(requiredSamples = 4) {
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

/**
 * 驱动 grok.com 输入框（自包含）
 * 严格跳过隐藏 textarea，优先匹配可见 contenteditable.tiptap.ProseMirror 与 chat-submit 按钮
 * 在最终文本注入前再次执行草稿保护核验
 */
async function driveGrokComInputSafe(tabId, prompt, nonce) {
  return (await executeGrokScript({
    target: { tabId },
    func: async (text, taskNonce) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      if (/\/(login|sign-?in)/i.test(location.pathname)) return { ok: false, err: 'grok.com 未登录' };

      const findInput = () => {
        const editable = document.querySelector('[contenteditable="true"].tiptap.ProseMirror, [contenteditable="true"]');
        if (editable && (editable.offsetParent !== null || (editable.getClientRects && editable.getClientRects().length > 0))) {
          return editable;
        }
        const all = document.querySelectorAll('[contenteditable="true"], textarea');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.tagName === 'TEXTAREA') {
            const isHidden = el.offsetParent === null ||
              (window.getComputedStyle && (window.getComputedStyle(el).display === 'none' || window.getComputedStyle(el).visibility === 'hidden'));
            if (isHidden) continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 10) return el;
        }
        return null;
      };

      let el = null;
      for (let i = 0; i < 30 && !el; i++) {
        el = findInput();
        if (!el) await sleep(500);
      }
      if (!el) return { ok: false, err: 'grok.com 未找到可见输入框' };

      // 最终注入前草稿保护
      const current = (el.tagName === 'TEXTAREA' ? el.value : (el.innerText || el.textContent || '')).trim();
      if (current.length > 0 && !current.includes(taskNonce) && !text.includes(current)) {
        return { ok: false, err: 'user_draft_detected', message: '输入框存在用户未发送草稿，已暂停提交以保护内容' };
      }

      el.focus();
      if (el.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter ? setter.call(el, text) : (el.value = text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const inserted = document.execCommand('insertText', false, text);
        if (!inserted) {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
      }
      await sleep(400);

      const findSubmitBtn = () => {
        const testBtn = document.querySelector('button[data-testid="chat-submit"]');
        if (testBtn && !testBtn.disabled && testBtn.getAttribute('aria-disabled') !== 'true') return testBtn;
        const allBtns = Array.from(document.querySelectorAll('button[type="submit"], button'));
        return allBtns.find(b => {
          const aria = `${b.getAttribute('aria-label') || ''} ${b.innerText || ''} ${b.getAttribute('data-testid') || ''}`.trim();
          return /提交|发送|submit|send/i.test(aria) && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
        });
      };

      let btn = null;
      for (let i = 0; i < 20; i++) {
        btn = findSubmitBtn();
        if (btn) break;
        await sleep(200);
      }

      if (btn) {
        btn.click();
      } else {
        el.focus();
        const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, key));
      }

      return { ok: true };
    },
    args: [prompt, nonce]
  }).catch(e => {
    if (e?.userActionRequired || e?.grokVerificationTimeout) throw e;
    return [{ result: { ok: false, err: String(e?.message || e) } }];
  }))?.[0]?.result;
}

/**
 * 执行向 grok.com 发起单一任务的完整流程（串行互斥协调）
 */
export async function executeGrokComTask({
  prompt,
  nonce,
  taskType = 'comment',
  targetBot = null,
  timeoutMs = 60000,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  extractFn = null
}) {
  return withSessionLock(async () => {
    await assertPendingGrokVerificationClear();
    let session = await getGrokSessionState();

    if (session.pausedReuse) {
      return { ok: false, reason: 'Grok 会话复用已被用户暂停' };
    }

    // A timed-out task may have completed since the previous call. Reconcile
    // its exact owned conversation and nonce before deciding whether to fence.
    if (session.activeRequest && (session.state === 'uncertain' || session.activeRequest.stage === 'uncertain')) {
      session = await reconcileGrokSession();
    }

    // 状态防护：任何未结束的 activeRequest（含 submitting）都禁止盲目覆盖
    if (session.activeRequest) {
      const isExpired = Boolean(
        (session.activeRequest.deadline != null && Date.now() > session.activeRequest.deadline) ||
        (session.activeRequest.submittedAt && Date.now() - session.activeRequest.submittedAt > 180000)
      );
      if (isExpired) {
        session.activeRequest = null;
        session.state = session.acceptedCount >= session.limit ? 'rotation_pending' : 'ready';
        session.lastError = '前序超时未决任务已超过截止时间，已自动释放状态防护并恢复可用';
        await saveGrokSessionState(session);
      } else if (session.state === 'uncertain' || session.activeRequest.stage === 'uncertain') {
        return {
          ok: false,
          reason: '当前存在未决状态的 Grok 任务，已启用状态防护，禁止提交新请求',
          uncertain: true
        };
      } else {
        return {
          ok: false,
          reason: '当前存在未完成的 Grok 任务，禁止覆盖提交',
          busy: true
        };
      }
    }

    const ensured = await ensureGrokPersistentWindow(session);
    if (!ensured?.tabId) return { ok: false, reason: ensured?.reason || '未能准备 Grok 窗口', paused: Boolean(ensured?.paused) };
    const { tabId } = ensured;

    const owned = await confirmGrokWindowOwnership(session, {
      expectedConversationId: session.conversationId,
      requireConversation: true
    });
    if (!owned.ok) {
      if (owned.foreign) relinquishGrokWindow(session, owned.reason);
      else {
        session.state = 'user_intervened';
        session.lastError = owned.reason || '提交前窗口归属核验失败';
      }
      await saveGrokSessionState(session);
      return { ok: false, reason: session.lastError };
    }

    // 身份不可用时失败关闭。不能在 ident.ok 为 false 时继续发送。
    const ident = (await executeGrokScript({
      target: { tabId },
      func: inspectGrokComAccountIdentityOnPage
    }).catch(error => {
      if (error?.userActionRequired || error?.grokVerificationTimeout) throw error;
      return [];
    }))?.[0]?.result;

    if (!ident?.ok) {
      return { ok: false, reason: ident?.reason || '无法确认账号身份，已拒绝提交' };
    }
    if (!session.ownerKey) {
      session.ownerKey = ident.ownerKey;
      session.accountLabel = ident.accountLabel;
      await saveGrokSessionState(session);
    } else if (session.ownerKey !== ident.ownerKey) {
      return { ok: false, reason: '检测到当前登录账号与常驻会话所有者不一致，已拒绝提交以保护账号隔离' };
    }

    // 检查额度与配额熔断（小于等于 2% 触发备用通道或熔断）
    const now = Date.now();
    const quotaCacheTtl = 15 * 60 * 1000;
    let quota = session.quotaUsage;
    if (!quota || !quota.fetchedAt || (now - quota.fetchedAt > quotaCacheTtl)) {
      try {
        const quotaRes = (await executeGrokScript({
          target: { tabId },
          func: inspectGrokComUsageOnPage
        }).catch(err => {
          if (err?.userActionRequired || err?.grokVerificationTimeout) throw err;
          return [];
        }))?.[0]?.result;
        if (quotaRes?.ok) {
          quota = { ...quotaRes, fetchedAt: now };
          session.quotaUsage = quota;
          await saveGrokSessionState(session);
        } else {
          session.quotaUsage = null;
        }
      } catch (err) {
        console.warn('[executeGrokComTask] inspectGrokComUsageOnPage error:', err);
        session.quotaUsage = null;
      }
    }

    let activeBotName = null;
    let activeAgentId = null;
    let targetChannel = 'grok.com';
    if (quota?.superGrok?.isExhausted) {
      if (quota?.grokBot?.isAvailable) {
        const botRes = (await executeGrokScript({
          target: { tabId },
          func: inspectGrokBotsOnPage
        }).catch(() => []))?.[0]?.result;

        const availableBots = botRes?.bots || [];
        let candidateBot = null;
        if (targetBot) {
          const reqName = typeof targetBot === 'string' ? targetBot : targetBot.name;
          const reqAgentId = typeof targetBot === 'object' ? targetBot.agentId : null;
          candidateBot = availableBots.find(b => (reqAgentId && b.agentId === reqAgentId) || (reqName && b.name === reqName)) || null;
        } else if (session.preferredBot) {
          const pref = session.preferredBot;
          candidateBot = availableBots.find(b => (pref.agentId && b.agentId === pref.agentId) || (pref.name && b.name === pref.name)) || null;
        } else if (availableBots.length === 1) {
          candidateBot = availableBots[0];
        }

        if (candidateBot) {
          const switchRes = (await executeGrokScript({
            target: { tabId },
            func: switchToGrokBotOnPage,
            args: [candidateBot]
          }).catch(() => []))?.[0]?.result;

          if (switchRes?.ok) {
            activeBotName = switchRes.botName || candidateBot.name;
            activeAgentId = switchRes.agentId || candidateBot.agentId || null;
            targetChannel = `grok.com (bot: ${activeBotName}${activeAgentId ? `, id: ${activeAgentId}` : ''})`;
          } else {
            activeBotName = null;
            activeAgentId = null;
          }
        }
      }

      if (!activeBotName) {
        return {
          ok: false,
          quotaExhausted: true,
          reason: `SuperGrok 额度已耗尽（剩余 ${quota?.superGrok?.remainingPercent ?? 0}%${quota?.superGrok?.resetAt ? `，重置时间：${quota.superGrok.resetAt}` : ''}），且无可用 Grok Bot 备用通道`,
          quota
        };
      }
    }

    // 1. 检查是否需要轮换（第 51 轮前核验删除旧会话并在同一窗口开启新会话）
    if (session.acceptedCount >= session.limit) {
      await rotateGrokConversation(session, tabId, sleep);
      session = await getGrokSessionState();
    }

    // 2. 提交前安全核验（未登录、用户草稿、错误会话或错误 Bot）
    const inspect = (await executeGrokScript({
      target: { tabId },
      func: inspectGrokComPageBeforeSubmitOnPage,
      args: [nonce, session.conversationId, { expectedBotName: activeBotName, expectedAgentId: activeAgentId }]
    }).catch(e => {
      if (e?.userActionRequired || e?.grokVerificationTimeout) throw e;
      return [{ result: { ok: false, reason: String(e?.message || e) } }];
    }))?.[0]?.result;

    if (!inspect?.ok) {
      if (inspect?.userDraftDetected || inspect?.switchedConversation) {
        session.state = 'user_intervened';
        session.lastError = inspect.reason;
        await saveGrokSessionState(session);
        chrome.notifications?.create?.('xf-grok-intervention', {
          type: 'basic',
          iconUrl: chrome.runtime?.getURL?.('icon128.png') || '',
          title: 'Grok 常驻会话暂停',
          message: inspect.reason,
          priority: 1
        })?.catch?.(() => {});
      }
      return { ok: false, reason: inspect?.reason || '提交前核验失败' };
    }

    // 采集提交前推荐问题快照（用于排查旧推荐问题与本轮新推荐问题）
    const preSubmitSignatures = (await executeGrokScript({
      target: { tabId },
      func: snapshotGrokComRecommendationsOnPage
    }).catch(() => []))?.[0]?.result || [];

    // 3. 构建独立本轮提示词
    const roundNumber = (Number(session.acceptedCount) || 0) + 1;
    const isolationHeader = `【会话轮次凭证: ${nonce} | 第 ${roundNumber}/${session.limit} 次独立任务】\n请注意：本次为完全独立的全新任务，请彻底忽略前文会话中的推文和评价，仅根据下文要求执行。\n\n`;
    const fullPrompt = `${isolationHeader}${prompt}`;

    // 4. 持久化在途任务状态（进入 submitting 阶段）
    const requestId = crypto.randomUUID();
    const leaseId = crypto.randomUUID();
    session.activeRequest = {
      requestId,
      nonce,
      leaseId,
      generation: session.generation,
      taskType,
      stage: 'submitting',
      submittedAt: Date.now(),
      deadline: Date.now() + timeoutMs + 30000,
      acceptedCounted: false,
      preSubmitSignatures
    };
    session.state = 'submitting';
    await saveGrokSessionState(session);
    await executeGrokScript({ target: { tabId }, world: 'MAIN', func: setGrokFrameFallbackOnPage, args: [true] });

    // 5. 驱动输入提交
    const drive = await driveGrokComInputSafe(tabId, fullPrompt, nonce);
    if (!drive?.ok) {
      session.activeRequest = null;
      session.state = session.acceptedCount >= session.limit ? 'rotation_pending' : 'ready';
      session.lastError = drive?.err || '提交失败';
      await saveGrokSessionState(session);
      return { ok: false, reason: drive?.err || 'grok.com 提交失败' };
    }

    // 6. 确认问题已被接收并累计计数（单次 requestId 仅计一次）
    let confirm;
    // Wait for React's message bubble and canonical URL, without resubmitting.
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(2000);
      confirm = (await executeGrokScript({
        target: { tabId },
        func: confirmGrokComPromptAcceptedOnPage,
        args: [nonce]
      }).catch(error => {
        if (error?.userActionRequired || error?.grokVerificationTimeout) throw error;
        return [];
      }))?.[0]?.result;
      if (confirm?.accepted) break;
    }

    if (confirm?.accepted) {
      if (!session.activeRequest.acceptedCounted) {
        session.acceptedCount += 1;
        session.activeRequest.acceptedCounted = true;
      }
      session.activeRequest.stage = 'generating';
      session.state = 'generating';
      session.lastUsedAt = Date.now();
      if (confirm.conversationId) {
        session.conversationId = confirm.conversationId;
        session.conversationUrl = confirm.conversationUrl;
      }
      await saveGrokSessionState(session);
    } else {
      session.state = 'uncertain';
      session.activeRequest.stage = 'uncertain';
      session.lastError = confirm?.reason || '未能确认 Grok 是否接收到问题，已进入未决防护状态';
      await saveGrokSessionState(session);
      return { ok: false, reason: session.lastError, uncertain: true };
    }

    // 7. 等待本轮独立回复
    const deadline = grokTaskNow() + timeoutMs;
    const stable = createTurnAnswerGate(4);
    let finalAnswer = null;

    while (grokTaskNow() < deadline) {
      await sleep(2500);
      let dom;
      try {
        dom = (await executeGrokScript({
          target: { tabId },
          func: readGrokComTurnAnswerOnPage,
          args: [nonce, session.activeRequest.preSubmitSignatures, { isBotChannel: Boolean(activeBotName) }]
        }))?.[0]?.result;
      } catch (error) {
        if (error?.userActionRequired || error?.grokVerificationTimeout) throw error;
        session.state = 'uncertain';
        session.activeRequest.stage = 'uncertain';
        session.lastError = '读取回答时发生异常，在途请求已隔离直至对账';
        await saveGrokSessionState(session);
        return { ok: false, reason: session.lastError, uncertain: true };
      }

      if (dom?.quotaPrompt) {
        if (dom.quotaPrompt.type === 'quota_updated_retry_available') {
          session.activeRequest = null;
          session.state = session.acceptedCount >= session.limit ? 'rotation_pending' : 'ready';
          session.lastError = dom.reason;
          await saveGrokSessionState(session);
          return { ok: false, quotaUpdatedRetryAvailable: true, reason: dom.reason };
        }
        if (dom.quotaPrompt.type === 'quota_exhausted') {
          session.activeRequest = null;
          session.state = session.acceptedCount >= session.limit ? 'rotation_pending' : 'ready';
          session.lastError = dom.reason;
          await saveGrokSessionState(session);
          return { ok: false, quotaExhausted: true, reason: dom.reason };
        }
      }

      if (dom?.failed) {
        session.activeRequest = null;
        session.state = session.acceptedCount >= session.limit ? 'rotation_pending' : 'ready';
        session.lastError = dom.reason;
        await saveGrokSessionState(session);
        return { ok: false, reason: dom.reason };
      }

      const turnText = String(dom?.text || '').trim();
      let evaluatedText = turnText;
      if (extractFn) {
        const parsed = extractFn(turnText);
        evaluatedText = parsed.reply || turnText;
      }

      if (stable(evaluatedText, Boolean(dom?.done))) {
        finalAnswer = turnText;
        break;
      }
    }

    // 超时或无法确认完成时隔离在途请求。没有停止按钮也不能当成已完成或可覆盖。
    if (!finalAnswer) {
      session.state = 'uncertain';
      session.activeRequest.stage = 'uncertain';
      session.lastError = 'Grok 生成超时，在途请求已隔离直至对账';
      await saveGrokSessionState(session);
      return { ok: false, reason: session.lastError, uncertain: true };
    }

    // 8. 终态持久化：检查期间用户是否触发了暂停
    const latestState = await getGrokSessionState();
    session.activeRequest = null;
    if (latestState.pausedReuse) {
      session.pausedReuse = true;
      session.state = 'paused';
    } else if (session.acceptedCount >= session.limit) {
      session.state = 'rotation_pending';
    } else {
      session.state = 'ready';
    }
    await saveGrokSessionState(session);

    if (finalAnswer) {
      if (extractFn) {
        const extracted = extractFn(finalAnswer);
        return { ok: true, ...extracted, rawText: finalAnswer, channel: targetChannel, botName: activeBotName, agentId: activeAgentId, acceptedCount: session.acceptedCount };
      }
      return { ok: true, text: finalAnswer, channel: targetChannel, botName: activeBotName, agentId: activeAgentId, acceptedCount: session.acceptedCount };
    }

    return { ok: false, reason: 'grok.com 生成超时或未给出符合格式的输出', acceptedCount: session.acceptedCount };
  });
}

/**
 * 统一会话调用入口（自动区分 background 运行还是 panel 前端委托）
 */
export async function requestGrokComPersistentSession({
  prompt,
  nonce = makeNonce(),
  taskType = 'comment',
  targetBot = null,
  timeoutMs = 60000,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  extractFn = null
}) {
  if (typeof document !== 'undefined') {
    const response = await chrome.runtime.sendMessage({
      cmd: 'grokSessionExecuteTask',
      prompt,
      nonce,
      taskType,
      targetBot,
      timeoutMs
    });
    if (!response?.ok) {
      if (response?.userActionRequired) {
        const err = new Error(response.error || 'Grok 需要手动验证');
        err.userActionRequired = true;
        throw err;
      }
      return { ok: false, reason: response?.error || 'grok.com 协调器调用失败' };
    }
    const rawText = response.text || '';
    if (extractFn) {
      const extracted = extractFn(rawText);
      return { ok: true, ...extracted, rawText, channel: response.channel || 'grok.com', botName: response.botName, agentId: response.agentId, acceptedCount: response.acceptedCount };
    }
    return { ok: true, text: rawText, channel: response.channel || 'grok.com', botName: response.botName, agentId: response.agentId, acceptedCount: response.acceptedCount };
  }

  return executeGrokComTask({ prompt, nonce, taskType, targetBot, timeoutMs, sleep, extractFn });
}

/**
 * 处理用户界面或外部触发的 Grok 会话控制动作
 * 关键安全纪律：
 * 1. 严格在 withSessionLock 互斥锁内排队执行，禁止并发绕过。
 * 2. reset_rotation 严禁逃避核验删除；若存在活跃会话必须先通过 rotateGrokConversation 执行真实删除。
 * 3. resume 必须重新核验窗口与状态。
 */
export async function handleGrokSessionAction(action, payload = {}) {
  return withSessionLock(async () => {
    const session = await getGrokSessionState();
    if (action === 'pause') {
      session.pausedReuse = true;
      if (session.state !== 'generating' && session.state !== 'submitting') {
        session.state = 'paused';
      }
      await saveGrokSessionState(session);
      return { ok: true, state: session };
    }
    if (action === 'resume') {
      session.pausedReuse = false;
      if (session.windowId) {
        try {
          const win = await chrome.windows.get(session.windowId);
          if (!win || win.type !== 'popup') { session.windowId = null; session.tabId = null; }
        } catch {
          session.windowId = null;
          session.tabId = null;
        }
      }
      if (session.state === 'paused') {
        session.state = session.acceptedCount >= session.limit ? 'rotation_pending' : 'ready';
      }
      await saveGrokSessionState(session);
      return { ok: true, state: session };
    }
    if (action === 'close_window') {
      if (!session.windowId) return { ok: true, state: session };
      const owned = await confirmGrokWindowOwnership(session, {
        expectedConversationId: session.conversationId,
        requireConversation: true
      });
      if (!owned.ok) {
        if (owned.foreign || owned.missing) {
          if (owned.foreign) relinquishGrokWindow(session, owned.reason);
          else {
            session.windowId = null;
            session.tabId = null;
            session.ownershipToken = null;
          }
          await saveGrokSessionState(session);
        } else {
          session.state = 'user_intervened';
          session.lastError = owned.reason;
          await saveGrokSessionState(session);
        }
        return { ok: false, error: owned.reason, state: session };
      }
      await closeTemporaryWindow(session.windowId);
      session.windowId = null;
      session.tabId = null;
      session.ownershipToken = null;
      await saveGrokSessionState(session);
      return { ok: true, state: session };
    }
    if (action === 'open_window') {
      if (session.windowId && !session.pausedReuse) {
        const owned = await confirmGrokWindowOwnership(session);
        if (owned.ok) {
          await chrome.windows.update(session.windowId, { focused: true, state: 'normal' }).catch(() => {});
          return { ok: true, state: session };
        }
      }
      const ensured = await ensureGrokPersistentWindow(session);
      return ensured?.ok ? { ok: true, state: session } : { ok: false, error: ensured?.reason || '无法打开窗口', state: session };
    }
    if (action === 'reset_rotation') {
      if (session.conversationId) {
        if (!session.createdByExtension) {
          return { ok: false, error: '当前会话非扩展创建，禁止自动重置删除，请先手动处理' };
        }
        if (!session.tabId || !session.windowId) {
          return { ok: false, error: '缺少已确认的旧会话窗口，不能清零计数' };
        }
        await rotateGrokConversation(session, session.tabId, ms => new Promise(r => setTimeout(r, ms)));
        const fresh = await getGrokSessionState();
        return { ok: true, state: fresh };
      }
      session.acceptedCount = 0;
      session.generation = (Number(session.generation) || 1) + 1;
      session.conversationId = null;
      session.conversationUrl = 'https://grok.com/';
      session.rotation = null;
      session.state = 'ready';
      session.lastError = null;
      await saveGrokSessionState(session);
      return { ok: true, state: session };
    }
    return { ok: false, error: `不支持的会话动作: ${action}` };
  });
}
