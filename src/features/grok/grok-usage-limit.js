export const GROK_USAGE_LIMIT_KEY = 'xfGrokUsageLimit';
export const GROK_USAGE_COOLDOWN_MS = 15 * 60 * 1000;

// Serialized into MAIN world. Inspect system status cards, not quoted prompt text.
export function detectXGrokUsageLimitOnPage(nonce = '') {
  if (!['x.com', 'twitter.com'].includes(location.hostname) || !location.pathname.startsWith('/i/grok')) return null;
  const turns = Array.from(document.querySelectorAll('[data-turn-id]'));
  const normalize = text => String(text || '').replace(/\s+/g, '');
  const turn = nonce ? turns.find(item => Array.from(item.querySelectorAll('[class~="group/user"], [data-testid="user-message"]'))
    .some(node => normalize(node.textContent).includes(normalize(nonce)))) : turns.at(-1);
  if (nonce && !turn) return null;
  const root = turn || document;
  for (const node of root.querySelectorAll('[role="status"], [role="alert"]')) {
    if (node.closest?.('[class~="group/user"], [data-testid="user-message"], textarea, [contenteditable="true"]')) continue;
    if (node.getClientRects && !node.getClientRects().length) continue;
    let hidden = false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(parent) : null;
      if (parent.hidden || parent.getAttribute?.('aria-hidden') === 'true' || style?.display === 'none' || style?.visibility === 'hidden') hidden = true;
    }
    if (hidden) continue;
    const text = String(node.innerText || node.textContent || '').trim();
    if (/^(?:you (?:have|'ve) reached (?:a |the |your )?(?:grok )?(?:usage |daily |weekly )?limit|(?:grok )?usage limit reached|(?:你|您)?(?:已|已经)达(?:到)?(?:了)?\s*(?:Grok\s*)?(?:使用|用量|次数)?上限|(?:Grok\s*)?(?:额度|配额)(?:已)?(?:用完|耗尽))/i.test(text)) {
      return {code:'GROK_USAGE_LIMIT', quotaExhausted:true, channel:'x.com', evidence:text.slice(0, 300),
        reason:'X Grok 使用额度已耗尽，请稍后重试（页面未提供重置时间）'};
    }
  }
  return null;
}

export async function readXGrokUsageCooldown(storage = globalThis.chrome?.storage?.local, now = Date.now()) {
  if (!storage) return null;
  const saved = (await storage.get(GROK_USAGE_LIMIT_KEY))?.[GROK_USAGE_LIMIT_KEY];
  return saved?.channel === 'x.com' && saved.retryAt > now ? {...saved, ok:false, cooldown:true} : null;
}

export async function checkXGrokUsageLimit(tabId, nonce = '', api = globalThis.chrome, now = Date.now()) {
  const result = (await api.scripting.executeScript({target:{tabId}, world:'MAIN', func:detectXGrokUsageLimitOnPage, args:[nonce]}))?.[0]?.result;
  if (!result?.quotaExhausted) return null;
  const notice = {...result, ok:false, detectedAt:now, retryAt:now + GROK_USAGE_COOLDOWN_MS};
  try { await api.storage.local.set({[GROK_USAGE_LIMIT_KEY]:notice}); }
  catch { notice.cooldownPersisted = false; }
  return notice;
}
