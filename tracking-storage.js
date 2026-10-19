import { durableGet } from './persistent-db.js';
import {mergeAutoFollowProgress} from './auto-follow-history.js';

/**
 * Read comment tracking data. Background startup must stay local-only so loading
 * Chrome never opens an X window merely to hydrate the extension's cache.
 */
export async function loadCommentTracking({ includeDurable = true, storage = chrome.storage.local, readDurable = durableGet } = {}) {
  const {commentTracking:stored = {users:[], posts:[]}} = await storage.get('commentTracking');
  const {commentAutoFollowSettings} = await storage.get('commentAutoFollowSettings');
  const durable = includeDurable ? await readDurable('commentTracking').catch(() => null) : null;
  const tracking = durable?.updatedAt > stored?.updatedAt ? durable : stored;
  return commentAutoFollowSettings != null ? {...tracking, autoFollow:mergeAutoFollowProgress(commentAutoFollowSettings, tracking.autoFollow)} : tracking;
}
