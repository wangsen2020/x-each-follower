// Read the signed-in account from X navigation, never from the visited profile.
export function readSidebarViewerOnPage() {
  const handle = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.split('/')[1] || '';
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  const lines = (switcher?.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
  const name = lines.find(x => !x.startsWith('@') && x !== '…') || handle;
  return {handle, name, avatarUrl: switcher?.querySelector('img')?.src || ''};
}

export function createSidebarIdentity({api, fetchProfile, parseUsers, now = () => Date.now()}) {
  let cached = null, pending = null;
  async function read(tabId) {
    return (await api.scripting.executeScript({target: {tabId}, func: readSidebarViewerOnPage}))?.[0]?.result || null;
  }
  async function resolve({force = false} = {}) {
    const tabs = (await api.tabs.query({url: ['https://x.com/*', 'https://twitter.com/*']}))
      .filter(t => !t.discarded).sort((a,b) => Number(b.active)-Number(a.active) || (b.lastAccessed||0)-(a.lastAccessed||0));
    for (const tab of tabs) {
      const viewer = await read(tab.id).catch(() => null);
      if (!viewer) continue;
      const handle = viewer.handle.toLowerCase();
      if (!force && cached?.handle.toLowerCase() === handle && now()-cached.checkedAt < 300000) return {ok: true, account: {...cached, ...viewer, name: cached.name || viewer.name, avatarUrl: cached.avatarUrl || viewer.avatarUrl}};
      const response = await fetchProfile(tab.id, handle).catch(() => null);
      const current = await read(tab.id).catch(() => null);
      if (!current || current.handle.toLowerCase() !== handle) continue;
      const user = response?.status === 200 ? parseUsers(response.json).find(u => u.handle?.toLowerCase() === handle) : null;
      const account = {...current, ...(user ? {id: user.id, name: user.name || current.name, avatarUrl: user.avatarUrl || current.avatarUrl, blueVerified: user.is_blue_verified === true || user.blueVerified === true} : {}), checkedAt: now()};
      if (user) cached = account;
      return {ok: true, account};
    }
    cached = null;
    return {ok: true, account: null};
  }
  return {read(options) { if (!pending) pending = resolve(options).finally(() => { pending = null; }); return pending; }};
}
