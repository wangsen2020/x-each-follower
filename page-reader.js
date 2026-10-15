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
  // Do not use generic text: suggested accounts and posts can contain unrelated numbers.
  if (!name || !following || !followers) return { pending: true, name, bio };
  return { pending: false, name: name.split('\n')[0], bio, followersText: followers.innerText, followingText: following.innerText, status: 'ok' };
}

export function readProfileBundle(handle, recentLimit = 5) {
  if (location.pathname.replaceAll('/', '').toLowerCase() !== handle.toLowerCase()) return {pending:true};
  const root = document.querySelector('[data-testid="primaryColumn"]');
  if (!root) return {pending:true};
  const name = root.querySelector('[data-testid="UserName"]')?.innerText || '';
  const bio = root.querySelector('[data-testid="UserDescription"]')?.innerText || '';
  const countLink = suffixes => [...root.querySelectorAll('a[href]')].find(link => suffixes.some(suffix => new URL(link.href, location.origin).pathname.toLowerCase() === `/${handle.toLowerCase()}/${suffix}`));
  const following = countLink(['following']);
  const followers = countLink(['followers', 'verified_followers']);
  if (!name || !following || !followers) return {pending:true, name, bio};
  const posts = [...(root?.querySelectorAll('article') || [])].slice(0, recentLimit).map(article => {
    const text = (article.innerText || '').replace(/\s+/g, ' ').trim();
    const time = article.querySelector('time')?.getAttribute('datetime') || '';
    const link = [...article.querySelectorAll('a[href]')].find(item => /\/status\/\d+/.test(item.getAttribute('href') || ''));
    return {text, time, url: link ? new URL(link.href, location.origin).href : ''};
  });
  return {pending:false, name:name.split('\n')[0], bio, followersText:followers.innerText, followingText:following.innerText, status:'ok', posts};
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
    const label = [...cell.querySelectorAll('button')].map(button => `${button.innerText} ${button.getAttribute('aria-label') || ''}`).find(text => /follow back|following|pending/i.test(text)) || '';
    users.push({handle, name:(cell.innerText || '').split('\n')[0] || handle, bio:cell.innerText || '', state:/follow back/i.test(label) ? 'follow_back' : /pending/i.test(label) ? 'pending' : /following/i.test(label) ? 'following' : 'unknown'});
  }
  window.scrollBy(0, Math.max(600, window.innerHeight * 0.8));
  return {users, ready:true};
}

export function clickFollowBack(handle) {
  const root = document.querySelector('[data-testid="primaryColumn"]');
  for (const cell of root?.querySelectorAll('[data-testid="UserCell"]') || []) {
    const link = [...cell.querySelectorAll('a[href]')].find(item => new URL(item.href, location.origin).pathname.toLowerCase() === `/${handle.toLowerCase()}`);
    if (!link) continue;
    const button = [...cell.querySelectorAll('button')].find(item => /follow back/i.test(`${item.innerText} ${item.getAttribute('aria-label') || ''}`));
    if (!button) return {ok:false, reason:'not_available'};
    button.click();
    const pageText = document.body.innerText || '';
    if (/unable to follow|rate limit|try again in an hour|too quickly/i.test(pageText)) return {ok:false, reason:'rate_limited'};
    return {ok:true};
  }
  return {ok:false, reason:'not_visible'};
}

export function clickFollowOnProfile(handle) {
  const path = location.pathname.replaceAll('/', '').toLowerCase();
  if (path !== handle.toLowerCase()) return {ok:false, reason:'wrong_profile'};
  const root = document.querySelector('[data-testid="primaryColumn"]');
  const buttons = [...(root?.querySelectorAll('button') || [])];
  const button = buttons.find(item => {
    const label = `${item.innerText || ''} ${item.getAttribute('aria-label') || ''}`.trim();
    return /^follow$/i.test(label);
  });
  if (!button) {
    const labels = buttons.map(item => `${item.innerText || ''} ${item.getAttribute('aria-label') || ''}`).join(' | ');
    if (/following|follow back|pending|unfollow/i.test(labels)) return {ok:false, reason:'already_following'};
    return {ok:false, reason:'follow_button_unavailable'};
  }
  button.click();
  return {ok:true};
}
