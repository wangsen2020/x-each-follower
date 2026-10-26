import {createXNetworkClient} from '../../platform/x/network-client.js';
import { repairMojibake } from './scoring.js';
import {ACCOUNT_FOLLOW_LIMIT_MESSAGE, isAccountFollowLimit} from '../../shared/follow-limit.js';

function collectUsers(value, out = new Map()) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) collectUsers(item, out); return out; }
  const legacy = value.legacy || value.core?.user_results?.result?.legacy;
  const core = value.core || {};
  const restId = value.rest_id || value.restId || value.id_str || value.id;
  const handle = legacy?.screen_name || core.screen_name || value.screen_name;
  const relationship = value.relationship_perspectives || value.relationship || {};
  const followers = legacy?.followers_count ?? value.relationship_counts?.followers ?? value.followers_count;
  const following = legacy?.friends_count ?? value.relationship_counts?.following ?? value.friends_count;
  const incoming = [relationship.followed_by, legacy?.followed_by, value.followed_by];
  const followsYou = incoming.includes(true) ? true : incoming.includes(false) ? false : null;
  const followsAccount = legacy?.following ?? relationship.following ?? value.following;
  const relationshipKnown = typeof followsYou === 'boolean' && typeof followsAccount === 'boolean';
  if (restId && handle && /^[A-Za-z0-9_]{1,15}$/.test(handle)) out.set(handle.toLowerCase(), {
    id:String(restId),
    ...(typeof value.is_blue_verified === 'boolean' ? {is_blue_verified:value.is_blue_verified} : {}),
    ...(typeof legacy?.verified === 'boolean' ? {verified:legacy.verified} : {}),
    handle,
    name:repairMojibake(legacy?.name || core.name || value.name || handle),
    bio:repairMojibake(legacy?.description || value.profile_bio?.description || value.description || ''),
    followersText:followers == null ? '' : String(followers),
    followingText:following == null ? '' : String(following),
    state:followsAccount === true ? 'following' : followsAccount === false && followsYou === true ? 'follow_back'
      : followsAccount === false && followsYou === false ? 'none' : 'unknown',
    relationshipKnown,
    relationship:{blocking:relationship.blocking === true, followedBy:typeof followsYou === 'boolean' ? followsYou : null, following:typeof followsAccount === 'boolean' ? followsAccount : null}
  });
  for (const child of Object.values(value)) collectUsers(child, out);
  return out;
}

function findCursor(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.cursor === 'string') return value.cursor;
  const cursorKind = [value.cursorType, value.type, value.__typename].filter(Boolean).join(' ');
  if (typeof value.value === 'string' && /(cursor|bottom|top)/i.test(cursorKind)) return value.value;
  for (const child of Object.values(value)) { const result = findCursor(child); if (result) return result; }
  return '';
}

// Stable business facade. The platform client owns HTTP, auth, signatures and errors.
export {prepareNetworkHeaders, prepareNetworkVariables} from '../../platform/x/network-client.js';
export const networkFetch = (tabId, operation, variables) => createXNetworkClient().query(tabId, operation, variables);
export const networkGetUserProfile = (tabId, handle, options) => createXNetworkClient().profile(tabId, handle, options);
export const networkGetUserPosts = (tabId, userId, variables) => createXNetworkClient().userPosts(tabId, userId, variables);
export const networkGetFollowers = (tabId, userId, variables) => createXNetworkClient().followers(tabId, userId, variables);
export const networkGetFollowing = (tabId, userId, variables) => createXNetworkClient().following(tabId, userId, variables);
export const networkGetTweetDetail = (tabId, variables) => createXNetworkClient().query(tabId, 'TweetDetail', variables);
// A successful HTTP response only proves that X accepted the request. Confirm
// the target's resulting relationship before callers persist a followed state.
export async function networkFollow(tabId, target, client = createXNetworkClient()) {
  const result = await client.follow(tabId, target);
  if (isAccountFollowLimit(result)) return {...result, httpStatus:result.status, status:result.status >= 200 && result.status < 300 ? 0 : result.status,
    followLimit:true, errorCode:161, error:ACCOUNT_FOLLOW_LIMIT_MESSAGE};
  if (!(result.status >= 200 && result.status < 300)) return result;
  const expectedId = String(typeof target === 'object' ? target?.id || '' : target || '');
  const handle = typeof target === 'object' ? String(target?.handle || '').replace(/^@/, '') : '';
  const matches = json => parseNetworkUsers(json).find(user =>
    expectedId ? user.id === expectedId : handle && user.handle.toLowerCase() === handle.toLowerCase());
  if (result.json?.errors?.length) return {...result, status: 0, error: 'X 关注响应包含错误，关系待核实', uncertain: true};
  const responseUser = matches(result.json);
  if (responseUser?.relationship?.following === true) return {...result, verifiedFollowing: true};
  if (handle) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let checked;
      try { checked = await client.profile(tabId, handle); } catch { checked = null; }
      const user = checked?.status === 200 ? matches(checked.json) : null;
      if (user?.relationship?.following === true) return {...result, verifiedFollowing: true};
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
  return {...result, status: 0, error: '关注请求已提交，但未核实到当前关注关系；请稍后重新核对', uncertain: true};
}
export const networkUnfollow = (tabId, target) => createXNetworkClient().unfollow(tabId, target);
export const networkBlock = (tabId, target) => createXNetworkClient().block(tabId, target);
export const networkUnblock = (tabId, target) => createXNetworkClient().unblock(tabId, target);
export const networkFetchOwnPostAnalytics = (tabId, variables) => createXNetworkClient().ownAnalytics(tabId, variables);
// Only call after the business coordinator consumes the user's specific approval.
export const networkDeleteOwnPost = (tabId, postId) => createXNetworkClient().deleteOwnPost(tabId, postId);
export function parseNetworkUsers(json) { return [...collectUsers(json).values()]; }

export function parseTweetReplies(json, focalTweetId = '') {
  const replies = new Map();
  const seen = new WeakSet();
  const walk = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const wrapped = value.tweet_results?.result;
    if (wrapped) {
      const tweet = wrapped.tweet || wrapped;
      const legacy = tweet.legacy || {};
      const user = tweet.core?.user_results?.result || tweet.user_results?.result || {};
      const userLegacy = user.legacy || {};
      const userCore = user.core || {};
      const id = String(tweet.rest_id || legacy.id_str || '');
      const userId = String(user.rest_id || userLegacy.id_str || user.id_str || (user.id && !String(user.id).startsWith('VXNl') ? user.id : '') || '');
      const handle = userLegacy.screen_name || userCore.screen_name || user.screen_name || '';
      if (id && id !== String(focalTweetId) && /^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        const relationship = tweet.core?.user_results?.result?.relationship_perspectives || user.relationship_perspectives || {};
        replies.set(id, {
          id,
          userId,
          handle,
          name:repairMojibake(userLegacy.name || userCore.name || handle),
          bio:repairMojibake(userLegacy.description || user.profile_bio?.description || ''),
          avatarUrl:userLegacy.profile_image_url_https || user.profile_image_url_https || '',
          followersText:userLegacy.followers_count == null ? '' : String(userLegacy.followers_count),
          followingText:userLegacy.friends_count == null ? '' : String(userLegacy.friends_count),
          relationship:{
            following:typeof relationship.following === 'boolean' ? relationship.following : null,
            followedBy:typeof relationship.followed_by === 'boolean' ? relationship.followed_by : null,
            blocking:relationship.blocking === true
          },
          replyId:id,
          replyText:repairMojibake(legacy.full_text || legacy.text || ''),
          replyCreatedAt:legacy.created_at || ''
        });
      }
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(json?.data?.threaded_conversation_with_injections_v2 || json);
  return [...replies.values()];
}

export function mergeCommentTracking(tracking = {users:[], posts:[]}, post, replies = []) {
  const users = new Map((tracking.users || []).map(user => [String(user.handle || '').toLowerCase(), user]));
  for (const reply of replies) {
    const key = String(reply.handle || '').toLowerCase();
    if (!key) continue;
    const { id: _replyTweetId, ...replyRest } = reply;
    const current = users.get(key) || {...replyRest, id: reply.userId || '', sources:[]};
    current.sources ||= [];
    current.id = reply.userId || (current.id && current.id !== reply.id ? current.id : '');
    current.name = reply.name || current.name || reply.handle;
    current.bio = reply.bio || current.bio || '';
    current.avatarUrl = reply.avatarUrl || current.avatarUrl || '';
    current.followersText = reply.followersText || current.followersText || '';
    current.followingText = reply.followingText || current.followingText || '';
    current.relationship = {...(current.relationship || {}), ...(reply.relationship || {})};
    current.lastSeenAt = new Date().toISOString();
    const source = current.sources.find(item => item.tweetId === post.tweetId) || {tweetId:post.tweetId, url:post.url, postAuthor:post.authorHandle, replies:[]};
    source.replies ||= [];
    for (const item of reply.sources?.[0]?.replies || []) {
      if (!source.replies.some(existing => existing.replyId === item.replyId)) source.replies.push(item);
    }
    if (!current.sources.includes(source)) current.sources.push(source);
    users.set(key, current);
  }
  const usersForPost = [...users.values()].filter(user => user.sources?.some(source => source.tweetId === post.tweetId)).length;
  const posts = new Map((tracking.posts || []).map(item => [item.tweetId, item]));
  const previous = posts.get(post.tweetId) || {};
  posts.set(post.tweetId, {...previous, ...post, replyUsers:usersForPost, collectedAt:new Date().toISOString()});
  return {...tracking, users:[...users.values()], posts:[...posts.values()], updatedAt:new Date().toISOString()};
}

export function mergeRecentPosts(history = [], incoming = [], limit = 100) {
  const merged = new Map();
  for (const post of [...(incoming || []), ...(history || [])]) {
    const url = String(post?.url || '').trim();
    const key = url || `${String(post?.time || post?.createdAt || '')}\n${String(post?.text || '').trim()}`;
    if (!key.replace(/\s/g, '')) continue;
    const previous = merged.get(key) || {};
    merged.set(key, {...post, ...previous, url: url || previous.url || '', firstSeenAt: previous.firstSeenAt || post.firstSeenAt || post.collectedAt || ''});
  }
  return [...merged.values()].map(post => ({...post, firstSeenAt:post.firstSeenAt || new Date().toISOString()})).sort((a,b) => String(b.time || b.createdAt || '').localeCompare(String(a.time || a.createdAt || ''))).slice(0, Math.max(1, Number(limit) || 100));
}

export function findBottomCursor(value) {
  if (!value || typeof value !== 'object') return '';
  if (/^Bottom(?:Cursor)?$/.test(value.cursorType || '') && typeof value.value === 'string') return value.value;
  for (const child of Object.values(value)) {
    const found = findBottomCursor(child);
    if (found) return found;
  }
  return '';
}

export function nextUserListPage(json, currentCursor, users) {
  if (!users?.length) return {next:'',complete:false,reason:'empty'};
  const next=findBottomCursor(json);
  if (!next) return {next:'',complete:true,reason:''};
  if (next===currentCursor) return {next:'',complete:false,reason:'stalled'};
  return {next,complete:false,reason:''};
}

export function addUniqueUsersUpTo(found, users, limit, mapUser = user => user) {
  for (const user of users || []) {
    if (found.size >= limit) break;
    const key = String(user?.handle || '').toLowerCase();
    if (key && !found.has(key)) found.set(key, mapUser(user));
  }
  return found;
}
export const GRAPHQL_OP_RE = new RegExp('/graphql/([^/?]+)/(UserByScreenName|Followers|BlueVerifiedFollowers|Following|TweetDetail|UserOriginalsTimeline|UserRepliesTimeline)(?=[/?#]|$)');

export function isUsableNetworkTemplate(operation, template) {
  if (!template?.queryId) return false;
  if (template.op && template.op !== operation) return false;
  return true;
}
export function personalRelationshipLabel(user) {
  const following = user.relationship?.following;
  const followedBy = user.relationship?.followedBy;
  if (typeof following !== 'boolean') return '关系未知';
  if (following === true && followedBy === true) return '互相关注';
  if (following === true && followedBy === false) return '你关注对方';
  if (following === true) return '你关注对方';
  if (following === false && followedBy === true) return '对方关注你';
  if (following === false && followedBy === false) return '未互关';
  return following === false ? '你未关注对方' : '关系未知';
}
export function mutualUserCategory(user) {
  const following = user?.relationship?.following === true;
  const followedBy = user?.relationship?.followedBy === true;
  if (following && followedBy) return 'mutual';
  if (following) return 'following';
  if (followedBy) return 'followBack';
  return 'none';
}
export function reconcileFollowBackQueue(queue = [], users = [], assessRisk = () => ({level:'normal', hits:[]})) {
  const reconciled = new Map((queue || []).filter(user => user?.handle).map(user => [user.handle.toLowerCase(), user]));
  for (const user of users || []) {
    if (!user?.handle) continue;
    const key = user.handle.toLowerCase();
    const existing = reconciled.get(key);
    if (user.state === 'following' || user.relationship?.following === true) {
      reconciled.delete(key);
      continue;
    }
    if (user.relationship?.followedBy === false) {
      if (existing) reconciled.set(key, {...existing, ...user, state:'no_longer_following', status:'no_longer_following'});
      continue;
    }
    if (user.state !== 'follow_back') continue;
    const risk = existing?.risk || assessRisk(user);
    if (existing) {
      reconciled.set(key, {
        ...existing,
        ...user,
        risk,
        status:existing.status === 'followed' ? (risk.level === 'danger' ? 'danger' : 'pending') : existing.status
      });
    } else {
      reconciled.set(key, {
        ...user,
        risk,
        discoveredAt:user.discoveredAt || new Date().toISOString(),
        status:risk.level === 'danger' ? 'danger' : 'pending'
      });
    }
  }
  return [...reconciled.values()];
}
export function capturedPageRequestCursor(capture) {
  try { return String(JSON.parse(capture?.variables || '{}')?.cursor || ''); }
  catch { return ''; }
}
export function isCapturedPageForCursor(capture, cursor = '') {
  return capture?.operation === 'Followers' && Boolean(capture.json) && Number(capture.at) > 0 &&
    capturedPageRequestCursor(capture) === String(cursor || '');
}
export { findCursor };
