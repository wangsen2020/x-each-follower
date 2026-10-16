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

export function publishReplyToTweetOnPage(tweetUrl, replyText) {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const cleanText = String(replyText || '').trim();
    if (!cleanText) return { ok: false, reason: '回复内容为空' };

    let targetArticle = null;
    let replyButton = null;

    if (tweetUrl) {
      const match = String(tweetUrl).match(/\/status\/(\d+)/);
      const tweetId = match ? match[1] : '';
      if (tweetId) {
        const articles = Array.from(document.querySelectorAll('article'));
        targetArticle = articles.find(a => a.querySelector(`a[href*="/status/${tweetId}"]`));
      }
    }

    if (!targetArticle) {
      targetArticle = document.querySelector('article');
    }

    if (targetArticle) {
      replyButton = targetArticle.querySelector('[data-testid="reply"]');
      if (replyButton) {
        replyButton.click();
        await sleep(900);
      }
    }

    let textarea = null;
    for (let i = 0; i < 25; i++) {
      textarea = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"], [data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"]');
      if (textarea && textarea.offsetParent !== null) break;
      await sleep(200);
    }

    if (!textarea) {
      return { ok: false, reason: '未找到推文回复输入框' };
    }

    textarea.focus();
    try {
      document.execCommand('insertText', false, cleanText);
    } catch (e) {}

    const textLen = (textarea.innerText || textarea.textContent || '').trim().length;
    if (textLen < cleanText.length * 0.5) {
      textarea.innerText = cleanText;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await sleep(600);

    let sendBtn = null;
    for (let i = 0; i < 20; i++) {
      const modal = document.querySelector('[role="dialog"]') || document;
      sendBtn = modal.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
      if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') break;
      await sleep(200);
    }

    if (!sendBtn || sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {
      return { ok: false, reason: '回复发送按钮不可用' };
    }

    sendBtn.click();
    await sleep(1500);

    return { ok: true };
  })();
}

