// These functions run in an isolated world on the visible website DOM only.
export function collectVisible(target) {
  if (!new RegExp(`^/${target}/following/?$`, 'i').test(location.pathname)) throw new Error('当前页面不是目标账号的 following 列表。');
  const root = document.querySelector('[data-testid="primaryColumn"]');
  if (!root) return { handles: [], ready: false };
  const handles = new Set();
  for (const cell of root.querySelectorAll('[data-testid="UserCell"]')) {
    for (const link of cell.querySelectorAll('a[href]')) {
      const match = new URL(link.href, location.origin).pathname.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/);
      if (match && cell.innerText.toLowerCase().includes(`@${match[1].toLowerCase()}`)) handles.add(match[1]);
    }
  }
  window.scrollBy(0, Math.max(600, window.innerHeight * 0.8));
  return { handles: [...handles], ready: true };
}

export function readProfile(handle) {
  if (location.pathname.replaceAll('/', '').toLowerCase() !== handle.toLowerCase()) return { pending: true };
  const root = document.querySelector('[data-testid="primaryColumn"]');
  if (!root) return { pending: true };
  const name = root.querySelector('[data-testid="UserName"]')?.innerText || '';
  const bio = root.querySelector('[data-testid="UserDescription"]')?.innerText || '';
  const countLink = suffixes => [...root.querySelectorAll('a[href]')].find(link => {
    const path = new URL(link.href, location.origin).pathname.toLowerCase();
    return suffixes.some(suffix => path === `/${handle.toLowerCase()}/${suffix}`);
  });
  const following = countLink(['following']);
  const followers = countLink(['followers', 'verified_followers']);
  const avatarUrl = root.querySelector(`a[href="/${handle}/photo"] img`)?.src || '';
  // Do not use generic text: suggested accounts and posts can contain unrelated numbers.
  if (!name || !following || !followers) return { pending: true, name, bio };
  return { pending: false, name: name.split('\n')[0], bio, followersText: followers.innerText, followingText: following.innerText, avatarUrl, status: 'ok' };
}

export function readProfileBundle(handle, recentLimit = 8) {
  if (location.pathname.replaceAll('/', '').toLowerCase() !== handle.toLowerCase()) return {pending:true};
  const root = document.querySelector('[data-testid="primaryColumn"]');
  if (!root) return {pending:true};
  const name = root.querySelector('[data-testid="UserName"]')?.innerText || '';
  const bio = root.querySelector('[data-testid="UserDescription"]')?.innerText || '';
  const countLink = suffixes => [...root.querySelectorAll('a[href]')].find(link => suffixes.some(suffix => new URL(link.href, location.origin).pathname.toLowerCase() === `/${handle.toLowerCase()}/${suffix}`));
  const following = countLink(['following']);
  const followers = countLink(['followers', 'verified_followers']);
  const avatarUrl = root.querySelector(`a[href="/${handle}/photo"] img`)?.src || '';
  if (!name || !following || !followers) return {pending:true, name, bio};
  const articles = [...(root?.querySelectorAll('article') || [])];
  if (articles.length < Math.min(5, recentLimit) && typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
    window.scrollBy(0, 700);
  }
  const posts = articles.slice(0, recentLimit).map(article => {
    const text = (article.innerText || '').replace(/\s+/g, ' ').trim();
    const time = article.querySelector('time')?.getAttribute('datetime') || '';
    const link = [...article.querySelectorAll('a[href]')].find(item => /\/status\/\d+/.test(item.getAttribute('href') || ''));
    return {text, time, url: link ? new URL(link.href, location.origin).href : ''};
  });
  return {pending:false, name:name.split('\n')[0], bio, followersText:followers.innerText, followingText:following.innerText, avatarUrl, status:'ok', posts};
}

export function scanFollowers() {
  if (!/\/followers\/?$/i.test(location.pathname)) throw new Error('当前页面不是粉丝列表。');
  const root = document.querySelector('[data-testid="primaryColumn"]');
  if (!root) return {users:[], ready:false};
  const users = [];
  for (const cell of root.querySelectorAll('[data-testid="UserCell"]')) {
    const profile = [...cell.querySelectorAll('a[href]')].find(link => /^\/[a-zA-Z0-9_]{1,15}\/?$/.test(new URL(link.href, location.origin).pathname));
    if (!profile) continue;
    const handle = new URL(profile.href, location.origin).pathname.replaceAll('/', '');
    const buttons = [...cell.querySelectorAll('button')];
    let state = 'unknown';
    for (const b of buttons) {
      const label = `${b.innerText || ''} ${b.getAttribute('aria-label') || ''}`.trim();
      const testId = b.getAttribute('data-testid') || '';
      if (/follow\s*back|回关/i.test(label)) { state = 'follow_back'; break; }
      if (/following|正在关注/i.test(label) || testId.endsWith('-unfollow')) { state = 'following'; break; }
      if (/pending|等待回应|请求中/i.test(label)) { state = 'pending'; break; }
      if (/^follow$|^关注$/i.test(label) || testId.endsWith('-follow')) { state = 'follow_back'; break; }
    }
    users.push({handle, name:(cell.innerText || '').split('\n')[0] || handle, bio:cell.innerText || '', state});
  }
  window.scrollBy(0, Math.max(600, window.innerHeight * 0.8));
  return {users, ready:true};
}

export function isOwnFollowersRoute(url, handle) {
  if (!handle) return false;
  try {
    return new URL(url).pathname.replace(/\/$/, '').toLowerCase() === `/${handle.toLowerCase()}/followers`;
  } catch { return false; }
}

export function clickFollowBack(handle) {
  const root = document.querySelector('[data-testid="primaryColumn"]');
  for (const cell of root?.querySelectorAll('[data-testid="UserCell"]') || []) {
    const link = [...cell.querySelectorAll('a[href]')].find(item => new URL(item.href, location.origin).pathname.toLowerCase() === `/${handle.toLowerCase()}`);
    if (!link) continue;
    const button = [...cell.querySelectorAll('button')].find(item => /follow\s*back|回关/i.test(`${item.innerText} ${item.getAttribute('aria-label') || ''}`));
    if (!button) return {ok:false, reason:'not_available'};
    button.click();
    const pageText = document.body.innerText || '';
    if (/unable to follow|rate limit|try again in an hour|too quickly|无法关注|操作过于频繁|频率受限/i.test(pageText)) return {ok:false, reason:'rate_limited'};
    return {ok:true};
  }
  return {ok:false, reason:'not_visible'};
}

// Individual pending 回关 only. Exact "Follow back" / "回关"; Following and Pending are non-click.
export function clickFollowBackOnProfile(handle) {
  // This function is passed directly to chrome.scripting.executeScript. Keep
  // every dependency inside it because Chrome serializes only this function.
  const actionLabel = item => `${item.innerText || ''} ${item.getAttribute('aria-label') || ''}`.trim();
  const isRateLimited = () => /unable to follow|rate limit|try again in an hour|too quickly|无法关注|操作过于频繁|频率受限/i.test(document.body?.innerText || '');
  const path = location.pathname.replaceAll('/', '').toLowerCase();
  if (path !== handle.toLowerCase()) return {ok:false, reason:'wrong_profile'};
  if (isRateLimited()) return {ok:false, reason:'rate_limited'};
  const root = document.querySelector('[data-testid="primaryColumn"]');
  const buttons = [...(root?.querySelectorAll('button') || [])];
  const button = buttons.find(item => /^(follow\s*back|回关)$/i.test(actionLabel(item)));
  if (!button) {
    const settled = buttons.some(item => /^(following|pending|unfollow|正在关注|等待回应|请求中|取消关注)$/i.test(actionLabel(item)));
    if (settled) return {ok:false, reason:'already_following'};
    return {ok:false, reason:'follow_button_unavailable'};
  }
  button.click();
  if (isRateLimited()) return {ok:false, reason:'rate_limited'};
  return {ok:true};
}

export function clickFollowOnProfile(handle) {
  // See clickFollowBackOnProfile: executeScript serializes this function alone.
  const isRateLimited = () => /unable to follow|rate limit|try again in an hour|too quickly|无法关注|操作过于频繁|频率受限/i.test(document.body?.innerText || '');
  const path = location.pathname.replaceAll('/', '').toLowerCase();
  if (path !== handle.toLowerCase()) return {ok:false, reason:'wrong_profile'};
  if (isRateLimited()) return {ok:false, reason:'rate_limited'};
  const root = document.querySelector('[data-testid="primaryColumn"]');
  const buttons = [...(root?.querySelectorAll('button') || [])];
  const button = buttons.find(item => {
    const label = `${item.innerText || ''} ${item.getAttribute('aria-label') || ''}`.trim();
    return /^(follow|关注)$/i.test(label);
  });
  if (!button) {
    const labels = buttons.map(item => `${item.innerText || ''} ${item.getAttribute('aria-label') || ''}`).join(' | ');
    if (/following|follow\s*back|pending|unfollow|正在关注|回关|等待回应|取消关注/i.test(labels)) return {ok:false, reason:'already_following'};
    return {ok:false, reason:'follow_button_unavailable'};
  }
  button.click();
  if (isRateLimited()) return {ok:false, reason:'rate_limited'};
  return {ok:true};
}

export function simulateProfileScrollStep(stepIndex = 0, distance = 420) {
  const root = document.querySelector('[data-testid="primaryColumn"]');
  const offset = Math.max(180, Number(distance) || 420) + ((Number(stepIndex) || 0) % 3) * 85;
  if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
    window.scrollBy({top: offset, behavior: 'smooth'});
  }
  const articles = [...(root?.querySelectorAll('article') || [])];
  return {
    ok: Boolean(root),
    articleCount: articles.length,
    scrollY: typeof window !== 'undefined' ? (window.scrollY || 0) : 0
  };
}

export function clickAnyFollowOnProfile(handle) {
  const isRateLimited = () => /unable to follow|rate limit|try again in an hour|too quickly|无法关注|操作过于频繁|频率受限/i.test(document.body?.innerText || '');
  const path = location.pathname.replaceAll('/', '').toLowerCase();
  if (path !== handle.toLowerCase()) return {ok:false, reason:'wrong_profile'};
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    window.scrollTo({top: 0, behavior: 'smooth'});
  }
  if (isRateLimited()) return {ok:false, reason:'rate_limited'};
  const root = document.querySelector('[data-testid="primaryColumn"]');
  const buttons = [...(root?.querySelectorAll('button') || [])];
  const button = buttons.find(item => {
    const label = `${item.innerText || ''} ${item.getAttribute('aria-label') || ''}`.trim();
    const testId = item.getAttribute('data-testid') || '';
    return /^(follow|follow\s*back|关注|回关)$/i.test(label) || testId.endsWith('-follow');
  });
  if (!button) {
    const labels = buttons.map(item => `${item.innerText || ''} ${item.getAttribute('aria-label') || ''}`).join(' | ');
    if (/following|pending|unfollow|正在关注|等待回应|请求中|取消关注/i.test(labels)) return {ok:false, reason:'already_following'};
    return {ok:false, reason:'follow_button_unavailable'};
  }
  button.click();
  if (isRateLimited()) return {ok:false, reason:'rate_limited'};
  return {ok:true};
}

export function publishQuotePostOnPage(tweetUrl, quoteText) {
  // 经 executeScript 序列化注入，必须自包含。
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const text = String(quoteText || '').trim();
    if (!text) return { ok: false, reason: '引用评价内容为空' };
    const tweetId = (String(tweetUrl || '').match(/\/status\/(\d+)/) || [])[1] || '';
    if (!tweetId || !location.pathname.includes(`/status/${tweetId}`)) return { ok: false, reason: '当前页面不是目标帖子详情页' };
    const visible = el => el && el.offsetParent !== null;
    const blocked = () => /unable to post|rate limit|try again|something went wrong|无法发布|操作过于频繁|稍后再试|已被限制/i.test(
      (document.querySelector('[data-testid="toast"]') || {}).innerText || '');

    // 目标帖：详情页里链接到该 tweetId 的 article；找不到就说明页面没渲染出目标帖，直接失败。
    let article = null;
    for (let i = 0; i < 30 && !article; i++) {
      article = [...document.querySelectorAll('article')].find(a => a.querySelector(`a[href*="/status/${tweetId}"]`));
      if (!article) await sleep(400);
    }
    if (!article) return { ok: false, reason: '没有在页面中找到目标帖子' };

    const repostBtn = article.querySelector('[data-testid="retweet"]');
    if (!repostBtn) return { ok: false, reason: '目标帖没有引用/转发按钮' };
    repostBtn.click();

    let quoteItem = null;
    for (let i = 0; i < 25 && !quoteItem; i++) {
      quoteItem = [...document.querySelectorAll('[role="menuitem"]')].find(item =>
        /^(quote|quote post|引用|引用帖子|引用推文)$/i.test((item.innerText || item.getAttribute('aria-label') || '').trim())
      );
      if (!visible(quoteItem)) quoteItem = null;
      if (!quoteItem) await sleep(250);
    }
    if (!quoteItem) return { ok: false, reason: '没有找到 X 的“Quote/引用”菜单项' };
    quoteItem.click();

    const findDialog = () => document.querySelector('[role="dialog"]');
    const findBox = () => findDialog()?.querySelector('[data-testid="tweetTextarea_0"]');
    let box = null;
    for (let i = 0; i < 30 && !box; i++) { box = findBox(); if (!visible(box)) box = null; if (!box) await sleep(300); }
    if (!box) return { ok: false, reason: '没有弹出引用帖编辑框' };

    const dialog = findDialog();
    if (!dialog.querySelector(`a[href*="/status/${tweetId}"]`)) {
      return { ok: false, reason: '引用编辑框未嵌入目标原帖，已停止发布' };
    }

    box.focus();
    document.execCommand('insertText', false, text);
    await sleep(500);
    const typed = (box.innerText || '').replace(/\s+/g, '');
    if (typed.length < text.replace(/\s+/g, '').length * 0.9) return { ok: false, reason: '引用评价没有写入输入框' };

    let send = null;
    for (let i = 0; i < 25; i++) {
      send = findDialog()?.querySelector('[data-testid="tweetButton"]');
      if (send && send.getAttribute('aria-disabled') !== 'true' && !send.disabled) break;
      send = null; await sleep(300);
    }
    if (!send) return { ok: false, reason: '引用帖发送按钮一直不可用（可能超长或被限制）' };
    send.click();

    // 确认发出：引用帖编辑框关闭且没有失败提示 = X 已接受。
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      if (blocked()) return { ok: false, reason: 'X 拒绝发布引用帖（限流或风控）' };
      if (!findBox()) return { ok: true, mode: 'quote' };
    }
    return { ok: false, reason: '点击发送后引用编辑框未关闭，无法确认已发出' };
  })();
}


