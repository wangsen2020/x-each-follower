import { durableGet } from './persistent-db.js';
import {mergeAutoFollowProgress} from '../shared/auto-follow-history.js';

/**
 * Read comment tracking data. Background startup must stay local-only so loading
 * Chrome never opens an X window merely to hydrate the extension's cache.
 */
export async function loadCommentTracking({ includeDurable = true, storage = chrome.storage.local, readDurable = durableGet, records = null } = {}) {
  if (records) {
    const {commentAutoFollowSettings} = await storage.get('commentAutoFollowSettings');
    const metadata = await records.metadata('commentTracking');
    const tracking = {...(metadata || {}), users: [], posts: []};
    const progress = metadata?.autoFollow && typeof metadata.autoFollow === 'object' ? metadata.autoFollow : {};
    return {...tracking, autoFollow: mergeAutoFollowProgress(commentAutoFollowSettings || {}, progress)};
  }
  const {commentTracking:stored = {users:[], posts:[]}} = await storage.get('commentTracking');
  const {commentAutoFollowSettings} = await storage.get('commentAutoFollowSettings');
  const durable = includeDurable ? await readDurable('commentTracking').catch(() => null) : null;
  const tracking = durable?.updatedAt > stored?.updatedAt ? durable : stored;
  return commentAutoFollowSettings != null ? {...tracking, autoFollow:mergeAutoFollowProgress(commentAutoFollowSettings, tracking.autoFollow)} : tracking;
}
