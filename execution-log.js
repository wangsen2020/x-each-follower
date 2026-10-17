let writeQueue = Promise.resolve();
export function selectExecutionLogs(logs = [], scope = 'autoFollow') {
  return logs.filter(log => !['comment','mutual'].includes(scope) || log.scope === scope)
    .slice().sort((a,b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}
// All writers call this in the service worker, so simultaneous panel and alarm
// writes are serialized instead of replacing storage with stale panel memory.
export function appendExecutionLog(entry, storage = chrome.storage.local) {
  const run = writeQueue.then(async () => {
    const {autoFollowLogs = []} = await storage.get('autoFollowLogs');
    const item = {...entry, id:entry.id || `log_${crypto.randomUUID()}`, at:entry.at || new Date().toISOString()};
    const logs = selectExecutionLogs([item, ...autoFollowLogs]).slice(0,300);
    await storage.set({autoFollowLogs:logs});
    return logs;
  });
  writeQueue = run.catch(() => {});
  return run;
}
