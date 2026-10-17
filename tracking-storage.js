import { durableGet } from './persistent-db.js';

/**
 * Read comment tracking data. Background startup must stay local-only so loading
 * Chrome never opens an X window merely to hydrate the extension's cache.
 */
export async function loadCommentTracking({ includeDurable = true, storage = chrome.storage.local, readDurable = durableGet } = {}) {
  const {commentTracking:stored = {users:[], posts:[]}} = await storage.get('commentTracking');
  if (!includeDurable) return stored;
  const durable = await readDurable('commentTracking').catch(() => null);
  return durable?.updatedAt > stored?.updatedAt ? durable : stored;
}
