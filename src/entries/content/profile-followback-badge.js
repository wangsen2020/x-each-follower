// Read-only profile annotation. Classic content script: no messages, storage or X requests.
(() => {
  if (globalThis.__xefProfileFollowbackBadge) return;
  const BADGE = 'data-xef-followback-badge';
  const reserved = new Set(['home', 'explore', 'search', 'notifications', 'messages', 'i', 'settings', 'compose', 'intent', 'login', 'logout', 'signup', 'tos', 'privacy']);
  const tabs = new Set(['with_replies', 'media', 'highlights', 'articles', 'followers', 'verified_followers', 'following']);

  function profileHandle(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    if (!parts.length || parts.length > 2 || !/^[a-z0-9_]{1,15}$/i.test(parts[0]) || reserved.has(parts[0].toLowerCase()) || (parts[1] && !tabs.has(parts[1]))) return null;
    return parts[0];
  }

  function countFromText(input) {
    const text = String(input ?? '').replace(/[\u200e\u200f\u202a-\u202e\u00a0\u202f]/g, '').trim();
    const match = text.match(/^(\d[\d,]*(?:\.\d+)?)\s*(万|萬|亿|億|[kmb])?(?=\s|$|正在|关注|關注|追蹤|跟隨|位|名|[a-z])/i);
    if (!match) return null;
    const value = Number(match[1].replaceAll(',', ''));
    const scale = {k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8}[match[2]?.toLowerCase()] || 1;
    return Number.isFinite(value) ? Math.round(value * scale) : null;
  }

  function assess(following, followers) {
    if (!Number.isFinite(following) || !Number.isFinite(followers) || following < 0 || followers <= 0) return {level: 'unknown', label: '待确认', ratio: null, symbol: '?', reason: '人数缺失或粉丝数为零，无法判断比例。'};
    const ratio = following / followers;
    if (ratio < .2) return {level: 'high', label: '高', ratio, symbol: '!', reason: '关注数不足粉丝数的20%，本地观察样本中互关表现偏低。'};
    if (ratio < .5) return {level: 'elevated', label: '偏高', ratio, symbol: '!', reason: '关注数为粉丝数的20%至不足50%，本地观察样本中互关表现偏低。'};
    if (ratio < .8) return {level: 'medium', label: '中等', ratio, symbol: '~', reason: '关注数为粉丝数的50%至不足80%，仅作比例参考。'};
    if (ratio < 1.2) return {level: 'lower', label: '较低', ratio, symbol: '✓', reason: '关注数为粉丝数的80%至不足120%，本地观察样本中互关表现较好。'};
    return {level: 'observe', label: '需观察', ratio, symbol: '↔', reason: '关注数达到粉丝数的120%及以上，比例更高不代表回关表现更好。'};
  }

  function describe(model, following, followers, followingText, followersText) {
    const formatted = n => Number.isFinite(n) ? n.toLocaleString('zh-CN') : '未读取到';
    return [
      `回关风险：${model.label} · XFollower`,
      `正在关注：${formatted(following)}　粉丝：${formatted(followers)}`,
      `关注/粉丝：${model.ratio === null ? '待确认' : `${(model.ratio * 100).toFixed(1)}%`}`,
      model.reason,
      /[kmb万萬亿億]/i.test(`${followingText} ${followersText}`.replace(/following|followers/gi, '')) ? '页面人数含缩写，比例为近似值，分档可能受舍入影响。' : '仅使用当前主页显示的人数。',
      '分档依据：2026-10-26单账号858人观察样本；不是全平台结论或个人回关概率。',
      '这不是账号安全、诚信或内容质量判断，也不代表对方是否已回关。'
    ].join('\n');
  }

  const api = {profileHandle, countFromText, assess, describe};
  globalThis.__xefProfileFollowbackBadge = api;
  if (typeof document === 'undefined') return;
  let badge = null, timer = null, stopped = false;

  function remove() { badge?.remove(); badge = null; }
  function read() {
    const handle = profileHandle(location.pathname);
    const root = document.querySelector('[data-testid="primaryColumn"]');
    const header = root?.querySelector('[data-testid="UserName"]');
    if (!handle || !header || header.closest('article,[data-testid="UserCell"]')) return null;
    // SPA navigation may leave the previous profile header mounted briefly.
    const shown = (header.innerText || '').match(/@([a-z0-9_]{1,15})(?![a-z0-9_])/i)?.[1];
    if (shown?.toLowerCase() !== handle.toLowerCase()) return null;
    const links = [...root.querySelectorAll('a[href]')].filter(a => !a.closest('article,[data-testid="UserCell"]'));
    const find = suffixes => links.find(a => {
      try { const url = new URL(a.href, location.href); return url.origin === location.origin && suffixes.some(s => url.pathname.replace(/\/$/, '').toLowerCase() === `/${handle.toLowerCase()}/${s}`); } catch { return false; }
    });
    const followingText = find(['following'])?.innerText || '';
    const followersText = find(['verified_followers', 'followers'])?.innerText || '';
    const following = countFromText(followingText), followers = countFromText(followersText);
    // The first row contains the name and verification icons; keep their order intact.
    const nameRow = header.querySelector('[dir="ltr"], [dir="rtl"], [dir="auto"]');
    if (!nameRow) return null;
    return {handle, header, nameRow, following, followers, followingText, followersText};
  }

  function refresh() {
    timer = null;
    if (stopped) return;
    const current = read();
    if (!current) { remove(); return; }
    const model = assess(current.following, current.followers);
    const title = describe(model, current.following, current.followers, current.followingText, current.followersText);
    if (!badge?.isConnected || badge.parentElement !== current.nameRow) {
      remove();
      badge = document.createElement('span');
      badge.setAttribute(BADGE, '');
      badge.setAttribute('role', 'img');
      badge.tabIndex = 0;
      // Static product-owned SVG only; no profile text is interpreted as markup.
      badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><text x="12" y="12" dominant-baseline="central" text-anchor="middle" fill="currentColor" font-family="Arial, sans-serif" font-size="12" font-weight="700"></text></svg>';
      current.nameRow.append(badge);
    }
    // Avoid an observer feedback loop: change the DOM only when the model changed.
    if (badge.title !== title) {
      badge.title = title;
      badge.setAttribute('aria-label', title);
      badge.dataset.level = model.level;
      badge.dataset.handle = current.handle;
      badge.dataset.ratio = model.ratio === null ? '' : String(model.ratio);
      badge.querySelector('text').textContent = model.symbol;
    }
  }
  function schedule() { if (!stopped && timer === null) timer = setTimeout(refresh, 150); }
  const observer = new MutationObserver(schedule);
  observer.observe(document, {childList: true, subtree: true, characterData: true});
  window.addEventListener('popstate', schedule);
  window.addEventListener('pageshow', schedule);
  api.refresh = refresh;
  api.destroy = () => { stopped = true; clearTimeout(timer); observer.disconnect(); window.removeEventListener('popstate', schedule); window.removeEventListener('pageshow', schedule); remove(); delete globalThis.__xefProfileFollowbackBadge; };
  schedule();
})();
