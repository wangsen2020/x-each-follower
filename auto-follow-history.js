const keyFor = handle => `autoFollowAttempt:${String(handle || '').trim().replace(/^@/, '').toLowerCase()}`;
export async function readAutoFollowAttempts(users, storage = chrome.storage.local) {
  return storage.get([...new Set(users.map(user => keyFor(user.handle)))]);
}
export function wasAutoFollowAttempted(handle, attempts, now = Date.now()) {
  const item = attempts[keyFor(handle)];
  if (!item) return false;
  if (item.state === 'processing') return now - item.at < 30 * 60000;
  return ['skipped', 'followed', 'failed'].includes(item.state);
}
export async function recordAutoFollowAttempt(handle, state, reason = '', storage = chrome.storage.local) {
  await storage.set({[keyFor(handle)]: {state, reason, at: Date.now()}});
}
export function mergeAutoFollowProgress(settings = {}, progress = {}) {
  return {...progress, ...settings, processedHandles:[...new Set([
    ...(progress.processedHandles || []), ...(settings.processedHandles || []),
    ...(progress.visitedHandles || []), ...(settings.visitedHandles || [])
  ].map(h => String(h || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean))]};
}
