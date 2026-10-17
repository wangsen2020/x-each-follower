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
  const s = settings || {};
  const p = progress || {};
  const sTime = Date.parse(s.lastRunAt || '') || 0;
  const pTime = Date.parse(p.lastRunAt || '') || 0;
  const useProgressSummary = pTime >= sTime && Boolean(p.lastRunAt || p.lastSummary);
  const followedCount = Math.max(Number(s.followedCount) || 0, Number(p.followedCount) || 0);
  const merged = {
    ...p,
    ...s,
    processedHandles: [...new Set([
      ...(p.processedHandles || []), ...(s.processedHandles || []),
      ...(p.visitedHandles || []), ...(s.visitedHandles || [])
    ].map(h => String(h || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean))]
  };
  if (followedCount > 0 || 'followedCount' in s || 'followedCount' in p) {
    merged.followedCount = followedCount;
  }
  if (useProgressSummary) {
    if (p.lastRunAt) merged.lastRunAt = p.lastRunAt;
    if (p.lastSummary) merged.lastSummary = p.lastSummary;
  } else {
    if (s.lastRunAt || p.lastRunAt) merged.lastRunAt = s.lastRunAt || p.lastRunAt;
    if (s.lastSummary || p.lastSummary) merged.lastSummary = s.lastSummary || p.lastSummary;
  }
  return merged;
}

