import { repairMojibake } from './scoring.js';

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
  const followsYou = relationship.followed_by ?? legacy?.followed_by ?? value.followed_by;
  const followsAccount = legacy?.following ?? relationship.following ?? value.following;
  const relationshipKnown = typeof followsYou === 'boolean' && typeof followsAccount === 'boolean';
  if (restId && handle && /^[A-Za-z0-9_]{1,15}$/.test(handle)) out.set(handle.toLowerCase(), {
    id:String(restId),
    handle,
    name:repairMojibake(legacy?.name || core.name || value.name || handle),
    bio:repairMojibake(legacy?.description || value.profile_bio?.description || value.description || ''),
    followersText:followers == null ? '' : String(followers),
    followingText:following == null ? '' : String(following),
    state:followsAccount === true ? 'following' : followsAccount === false || followsYou === true ? 'follow_back' : 'unknown',
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

export function prepareNetworkHeaders(templateHeaders = {}, operation = '') {
  const headers = {};
  for (const [k, v] of Object.entries(templateHeaders || {})) {
    if (v != null) headers[k.toLowerCase()] = v;
  }
  headers['content-type'] = 'application/json';
  if (operation === 'Followers') {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'x-client-transaction-id') delete headers[k];
    }
  }
  return headers;
}

export function prepareNetworkVariables(templateVariables, callVariables = {}) {
  let base = {};
  try {
    base = typeof templateVariables === 'string' ? JSON.parse(templateVariables) : (templateVariables || {});
  } catch {}
  delete base.cursor;
  return {...base, ...callVariables};
}

export async function networkFetch(tabId, op, variables) {
  const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
  const template = networkTemplates[op];
  if (!template) return {status:0, error:`未捕获 ${op} 模板`};
  if (op === 'Followers') {
    try {
      const [{result: signerState} = {}] = await chrome.scripting.executeScript({
        target:{tabId},
        world:'MAIN',
        func:() => typeof window.__XEF_GENERATE_TRANSACTION_ID === 'function'
      });
      if (!signerState) {
        await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', files:['transaction-id.bundle.js']});
      }
    } catch (error) {
      return {status:0, error:`无法在 X 页面加载 Followers 请求签名器：${String(error?.message || error).slice(0, 160)}`};
    }
  }
  const mergedVars = prepareNetworkVariables(template.variables, variables);
  const reqHeaders = prepareNetworkHeaders(template.headers, op);
  const result = await chrome.scripting.executeScript({
    target:{tabId},
    world:'MAIN',
    func:async (operation, queryVars, headers, t) => {
      if (!t) return {status:0, error:`未捕获 ${operation} 模板`};
      const query = new URLSearchParams({
        variables:JSON.stringify(queryVars),
        ...(t.features ? {features:t.features} : {}),
        ...(t.fieldToggles ? {fieldToggles:t.fieldToggles} : {})
      });
      const url = `${t.origin}/i/api/graphql/${t.queryId}/${operation}?${query}`;
      if (operation === 'Followers') {
        const generateTransactionId = window.__XEF_GENERATE_TRANSACTION_ID;
        if (typeof generateTransactionId !== 'function') return {status:0, error:'Followers 请求签名器尚未加载，请刷新 X 页面后重试。'};
        try { headers['x-client-transaction-id'] = await generateTransactionId('GET', new URL(url).pathname); }
        catch (error) { return {status:0, error:`无法生成 Followers 请求签名：${String(error?.message || error).slice(0, 160)}`}; }
      }
      const init = {credentials:'include', headers};
      Object.defineProperty(init, '__xefInternal', {value:true});
      const response = await fetch(url, init);
      const text = await response.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
      return {status:response.status, json, error:response.ok ? '' : (json?.errors?.map(item => item.message).filter(Boolean).join('；') || text.slice(0, 240))};
    },
    args:[op, mergedVars, reqHeaders, template]
  });
  return result?.[0]?.result || {status:0, error:'页面没有返回网络结果'};
}

export async function networkFollow(tabId, userId) {
  const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
  const template = networkTemplates.UserByScreenName || Object.values(networkTemplates).find(t => t?.origin && t?.headers?.authorization && t?.headers?.['x-csrf-token']);
  if (!template?.origin || !template?.headers?.authorization || !template?.headers?.['x-csrf-token']) {
    return {status:0, error:'未捕获 X 网络请求模板；请先打开 X 或扫描一次粉丝列表。'};
  }
  const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:async (target, t) => {
    const id = typeof target === 'object' ? (target?.id || target?.userId) : target;
    const screenName = typeof target === 'object' ? (target?.handle || target?.screen_name) : '';
    const params = {skip_status:'true'};
    if (id) params.user_id = String(id);
    if (screenName) params.screen_name = String(screenName).replace(/^@/, '');
    const body = new URLSearchParams(params).toString();
    const response = await fetch(`${t.origin}/i/api/1.1/friendships/create.json`, {
      method:'POST',
      credentials:'include',
      headers:{...(t.headers || {}), 'content-type':'application/x-www-form-urlencoded;charset=UTF-8'},
      body
    });
    const text = await response.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return {status:response.status, json, error:response.ok ? '' : (json?.errors?.map(item => item.message).join('；') || text.slice(0, 240))};
  }, args:[userId, template]});
  return result?.[0]?.result || {status:0, error:'X 页面没有返回关注结果'};
}

export async function networkUnfollow(tabId, userId) {
  const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
  const template = networkTemplates.UserByScreenName || Object.values(networkTemplates).find(t => t?.origin && t?.headers?.authorization && t?.headers?.['x-csrf-token']);
  if (!template?.origin || !template?.headers?.authorization || !template?.headers?.['x-csrf-token']) {
    return {status:0, error:'未捕获 X 网络请求模板；请先打开 X 或扫描一次粉丝列表。'};
  }
  const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:async (target, t) => {
    const id = typeof target === 'object' ? (target?.id || target?.userId) : target;
    const screenName = typeof target === 'object' ? (target?.handle || target?.screen_name) : '';
    const params = {skip_status:'true'};
    if (id) params.user_id = String(id);
    if (screenName) params.screen_name = String(screenName).replace(/^@/, '');
    const body = new URLSearchParams(params).toString();
    const response = await fetch(`${t.origin}/i/api/1.1/friendships/destroy.json`, {
      method:'POST',
      credentials:'include',
      headers:{...(t.headers || {}), 'content-type':'application/x-www-form-urlencoded;charset=UTF-8'},
      body
    });
    const text = await response.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return {status:response.status, json, error:response.ok ? '' : (json?.errors?.map(item => item.message).join('；') || text.slice(0, 240))};
  }, args:[userId, template]});
  return result?.[0]?.result || {status:0, error:'X 页面没有返回取关结果'};
}

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
  if (value.cursorType === 'Bottom' && typeof value.value === 'string') return value.value;
  for (const child of Object.values(value)) {
    const found = findBottomCursor(child);
    if (found) return found;
  }
  return '';
}

export function addUniqueUsersUpTo(found, users, limit, mapUser = user => user) {
  for (const user of users || []) {
    if (found.size >= limit) break;
    const key = String(user?.handle || '').toLowerCase();
    if (key && !found.has(key)) found.set(key, mapUser(user));
  }
  return found;
}
export const GRAPHQL_OP_RE = new RegExp('/graphql/([^/?]+)/(UserByScreenName|Followers|BlueVerifiedFollowers|Following|TweetDetail)(?=[/?#]|$)');

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
