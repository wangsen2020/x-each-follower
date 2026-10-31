// Session storage survives worker termination without reusing tab IDs across browser sessions.
const TAB_KEY = 'followQueueOwnedTabs';
export function createQueueTabs(api) {
  const storage = api.storage.session;
  let memory = {}, chain = Promise.resolve();
  const serial = work => { const next = chain.then(work); chain = next.catch(() => {}); return next; };
  const read = async () => storage ? (await storage.get(TAB_KEY))[TAB_KEY] || {} : memory;
  const write = async rows => { if (storage) await storage.set({[TAB_KEY]:rows}); else memory = rows; };
  async function releaseEntry(rows, key) {
    const row = rows[key];
    if (!row) return;
    const tab = await api.tabs.get(row.id).catch(error => {
      if (/No tab with id|Invalid tab ID/i.test(String(error?.message || error))) return null;
      throw error;
    });
    // A user may have navigated the tab elsewhere. Do not close it in that case.
    if (tab && (tab.pendingUrl || tab.url) === row.url) await api.tabs.remove(row.id);
    delete rows[key];
    await write(rows);
  }
  return {
    recover: () => serial(async () => {
      const rows = await read();
      for (const key of Object.keys(rows)) await releaseEntry(rows, key);
    }),
    acquire: (key, create, expectedUrl) => serial(async () => {
      const rows = await read();
      if (rows[key]) await releaseEntry(rows, key);
      const tab = await create();
      rows[key] = {id:tab.id, url:expectedUrl || tab.pendingUrl || tab.url};
      try { await write(rows); }
      catch (error) { await api.tabs.remove(tab.id).catch(() => {}); throw error; }
      return tab;
    }),
    release: key => serial(async () => releaseEntry(await read(), key))
  };
}

// IndexedDB lease renewals do not reset the MV3 worker idle timer. Only keep an
// active operation alive; clearing this timer lets the worker sleep when idle.
export function startQueueActivity(api, timers = globalThis) {
  if (!api.runtime?.getPlatformInfo) return () => {};
  const tick = () => { try { Promise.resolve(api.runtime.getPlatformInfo()).catch(() => {}); } catch {} };
  tick();
  const timer = timers.setInterval(tick, 20000);
  timer.unref?.();
  return () => timers.clearInterval(timer);
}
