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
