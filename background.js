import { networkFetch, networkFollow, parseNetworkUsers, parseTweetReplies, findBottomCursor, mergeCommentTracking, mergeRecentPosts } from './network-api.js';
import { durableGet, durableSet } from './persistent-db.js';
import { readProfileBundle, simulateProfileScrollStep } from './page-reader.js';
import { evaluateMutualProfile, parseCount } from './scoring.js';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

let networkTemplateWrite = Promise.resolve();
const commentJobs = new Map();
const COMMENT_REPLY_LIMIT = 3000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let commentFollowRunning = false;

function normalizeAutoFollowConfig(cfg = {}) {
  const defaults = {
    enabled: false,
    every: 5,
    jitter: 3,
    batchLimit: 10,
    scrollRounds: 5,
    dwellSeconds: 15,
    minFollowers: 50,
    onlyMutualIntent: true
  };
  const res = { ...defaults, ...(cfg || {}) };
  if (res.every === 45) res.every = defaults.every;
  if (res.jitter === 15) res.jitter = defaults.jitter;
  if (res.batchLimit === 3) res.batchLimit = defaults.batchLimit;
  if (res.scrollRounds === 3) res.scrollRounds = defaults.scrollRounds;
  if (res.dwellSeconds === 6) res.dwellSeconds = defaults.dwellSeconds;
  return res;
}

function scheduleCommentAutoFollow(rawCfg = {}) {
  const cfg = normalizeAutoFollowConfig(rawCfg);
  chrome.alarms.clear('x-comment-auto-follow').then(() => {
    if (!cfg.enabled) return;
    const every = Math.max(5, Number(cfg.every) || 5);
    const jitter = Math.max(0, Math.min(every - 1, Number(cfg.jitter) ?? 3));
    const delta = jitter ? Math.floor((Math.random() * 2 - 1) * jitter) : 0;
    chrome.alarms.create('x-comment-auto-follow', {delayInMinutes:Math.max(5, every + delta)});
  }).catch(() => {});
}

async function loadCommentTracking() {
  const {commentTracking:stored = {users:[], posts:[]}} = await chrome.storage.local.get('commentTracking');
  const durable = await durableGet('commentTracking').catch(() => null);
  return durable?.updatedAt > stored?.updatedAt ? durable : stored;
}

async function saveCommentTrackingData(tracking) {
  tracking.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({commentTracking:tracking});
  await durableSet('commentTracking', tracking).catch(() => {});
}

async function readProfilePosts(tabId, handle, recentLimit = 5, cfg = {}) {
  const deadline = Date.now() + 25000;
  let data = {pending:true};
  while (Date.now() < deadline && data.pending) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('主页标签页已关闭');
    if (tab.status === 'complete') data = (await chrome.scripting.executeScript({target:{tabId}, func:readProfileBundle, args:[handle, recentLimit]}).catch(() => []))?.[0]?.result || data;
    if (data.pending) await sleep(600);
  }
  if (data.pending) throw new Error('公开资料读取超时');
  const rounds = Math.max(1, Math.min(8, Number(cfg.scrollRounds) || 5));
  const totalDwellMs = Math.max(2000, Math.min(60000, (Number(cfg.dwellSeconds) || 15) * 1000));
  const stepDelay = Math.max(600, Math.round(totalDwellMs / rounds));
  for (let round = 0; round < rounds; round++) {
    await chrome.scripting.executeScript({target:{tabId}, func:simulateProfileScrollStep, args:[round, 420]}).catch(() => []);
    await sleep(stepDelay + Math.floor(Math.random() * 350));
  }
  const afterScroll = (await chrome.scripting.executeScript({target:{tabId}, func:readProfileBundle, args:[handle, recentLimit]}).catch(() => []))?.[0]?.result;
  if (afterScroll && !afterScroll.pending && (afterScroll.posts || []).length >= (data.posts || []).length) data = afterScroll;
  return data;
}

// 定时关注执行日志：时间、访问的账号、扫描的帖子、关注结果（面板与后台共用 storage 键 autoFollowLogs）
async function appendAutoFollowLog(entry) {
  const {autoFollowLogs = []} = await chrome.storage.local.get('autoFollowLogs');
  const posts = (entry.posts || []).slice(0, 10).map(post => ({text:String(post.text || post || '').slice(0, 120), url:post.url || ''}));
  autoFollowLogs.unshift({at:new Date().toISOString(), ...entry, posts});
  await chrome.storage.local.set({autoFollowLogs:autoFollowLogs.slice(0, 300)});
}

async function runCommentAutoFollow(source = 'alarm') {
  if (commentFollowRunning) return {ok:false, error:'评论用户关注任务正在运行。'};
  commentFollowRunning = true;
  let tabId = null;
  let tracking;
  try {
    tracking = await loadCommentTracking();
    const cfg = normalizeAutoFollowConfig(tracking.autoFollow);
    if (source === 'alarm' && !cfg.enabled) return {ok:false, error:'定时关注已关闭。'};
    const {monitor = {}} = await chrome.storage.local.get('monitor');
    if (monitor.pausedUntil && Date.now() < Date.parse(monitor.pausedUntil)) return {ok:false, error:`关注操作暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}`};
    const ownFollowing = new Set([...(monitor.followingUsers || []), ...(monitor.users || []).filter(user => user.state === 'following')].map(user => String(user.handle || '').toLowerCase()));
    const candidates = (tracking.users || []).filter(user => {
      const handle = String(user.handle || '').toLowerCase();
      const mutual = user.relationship?.following === true && user.relationship?.followedBy === true;
      return handle && !user.followedAt && !ownFollowing.has(handle) && user.relationship?.following !== true && !mutual;
    }).sort((a,b) => String(a.lastSeenAt || '').localeCompare(String(b.lastSeenAt || ''))).slice(0, Math.max(1, Math.min(20, Number(cfg.batchLimit) || 10)));
    if (!candidates.length) {
      cfg.lastRunAt = new Date().toISOString(); cfg.lastSummary = '没有待关注的评论用户。';
      tracking.autoFollow = cfg; await saveCommentTrackingData(tracking);
      return {ok:true, summary:cfg.lastSummary};
    }
    const tab = await chrome.tabs.create({url:'https://x.com/home', active:false});
    tabId = tab?.id;
    if (!tabId) throw new Error('无法创建 X 后台标签页');
    let rateLimited = false;
    let processedCount = 0;
    let followedCount = 0;
    let skippedCount = 0;
    for (const user of candidates) {
      const handle = String(user.handle || '').replace(/^@/, '');
      let didFollow = false;
      try {
        await chrome.tabs.update(tabId, {url:`https://x.com/${encodeURIComponent(handle)}`});
        const profile = await readProfilePosts(tabId, handle, 5, cfg);
        user.recentPosts = mergeRecentPosts(user.recentPosts || [], profile.posts || [], 100);
        user.recentPostsFetchedAt = new Date().toISOString();
        user.recentPostsCount = user.recentPosts.length;
        user.name = profile.name || user.name; user.bio = profile.bio || user.bio;
        user.followersText = profile.followersText || user.followersText; user.followingText = profile.followingText || user.followingText;
        if (profile.id) user.id = profile.id;
        const {profileCache = {}} = await chrome.storage.local.get('profileCache');
        const profileKey = handle.toLowerCase();
        profileCache[profileKey] = {...(profileCache[profileKey] || {}), ...profile, handle, posts:user.recentPosts.slice(0, 10), profileCachedAt:user.recentPostsFetchedAt};
        await chrome.storage.local.set({profileCache});
        await durableSet('profileCache', profileCache).catch(() => {});
        await saveCommentTrackingData(tracking);
        const followers = parseCount(String(user.followersText || ''));
        const minFollowers = Math.max(0, Number(cfg.minFollowers) || 0);
        const evaluation = evaluateMutualProfile({...user, ...profile, posts:user.recentPosts.slice(0, 10)});
        let skipReason = '';
        if (followers === null && minFollowers > 0) skipReason = '未能读取粉丝数，无法确认最低粉丝数门槛';
        else if (followers !== null && followers < minFollowers) skipReason = `粉丝数 ${followers} 低于最低门槛 ${minFollowers}`;
        else if (evaluation.isNotRecommended) skipReason = evaluation.recommendReason || '主页风险评估未通过';
        else if (cfg.onlyMutualIntent !== false && evaluation.tag !== '互粉' && evaluation.recommendLabel !== '推荐') skipReason = evaluation.intentTooltip || '未达到互粉意向或推荐条件';
        if (skipReason) {
          user.autoFollowState = 'skipped'; user.autoFollowReason = skipReason; user.autoFollowCheckedAt = new Date().toISOString();
          await saveCommentTrackingData(tracking);
          processedCount++;
          skippedCount++;
          await appendAutoFollowLog({scope:'comment', source, handle, result:'skipped', detail:skipReason, posts:profile.posts || []});
          await sleep(500);
          continue;
        }
        let followed = false;
        if (user.id) {
          const result = await networkFollow(tabId, user.id);
          followed = result.status >= 200 && result.status < 300;
          if (!followed) {
            user.followFailureReason = result.error || `关注接口返回 ${result.status}`;
            rateLimited = result.status === 429 || /rate limit|too quickly|频率受限|过于频繁/i.test(user.followFailureReason);
          }
        } else {
          const lookup = await networkFetch(tabId, 'UserByScreenName', {screen_name:handle});
          const target = lookup.status === 200 ? parseNetworkUsers(lookup.json).find(item => item.handle.toLowerCase() === handle.toLowerCase()) : null;
          if (target?.relationship?.following) followed = true;
          else if (target?.id) {
            user.id = target.id;
            const result = await networkFollow(tabId, target.id);
            followed = result.status >= 200 && result.status < 300;
            if (!followed) {
              user.followFailureReason = result.error || `关注接口返回 ${result.status}`;
              rateLimited = result.status === 429 || /rate limit|too quickly|频率受限|过于频繁/i.test(user.followFailureReason);
            }
          } else user.followFailureReason = lookup.error || '无法解析用户 ID';
        }
        if (followed) {
          user.followedAt ||= new Date().toISOString(); user.followSource = 'comment-auto';
          user.relationship = {...(user.relationship || {}), following:true}; delete user.followFailureReason;
          user.autoFollowState = 'followed'; delete user.autoFollowReason;
          didFollow = true;
        } else { user.followFailedAt = new Date().toISOString(); user.autoFollowState = 'failed'; }
      } catch (error) {
        user.followFailedAt = new Date().toISOString(); user.followFailureReason = String(error?.message || error);
      }
      await saveCommentTrackingData(tracking);
      await appendAutoFollowLog({scope:'comment', source, handle, result:didFollow ? 'followed' : 'failed', detail:didFollow ? '已点击并关注成功' : (user.followFailureReason || '关注未成功'), posts:(user.recentPosts || []).slice(0, 5)}).catch(() => {});
      processedCount++;
      if (didFollow) followedCount++;
      if (rateLimited) {
        const monitorState = {...monitor, pausedUntil:new Date(Date.now() + 60 * 60000).toISOString()};
        await chrome.storage.local.set({monitor:monitorState});
        break;
      }
      await sleep(1200 + Math.floor(Math.random() * 1000));
    }
    cfg.lastRunAt = new Date().toISOString(); cfg.lastSummary = `本轮处理 ${processedCount} 人，成功关注 ${followedCount} 人${skippedCount ? `，条件不符跳过 ${skippedCount} 人` : ''}${rateLimited ? '；检测到频率限制，已暂停关注 1 小时' : ''}。`;
    tracking.autoFollow = cfg; await saveCommentTrackingData(tracking);
    return {ok:true, summary:cfg.lastSummary};
  } catch (error) {
    if (tracking) { tracking.autoFollow = {...(tracking.autoFollow || {}), lastRunAt:new Date().toISOString(), lastSummary:`执行失败：${error?.message || error}`}; await saveCommentTrackingData(tracking).catch(() => {}); }
    return {ok:false, error:String(error?.message || error)};
  } finally {
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
    commentFollowRunning = false;
  }
}

async function updateCommentStatus(status, tabId) {
  await chrome.storage.local.set({commentTrackingStatus:status});
  if (tabId != null) await durableSet('commentTrackingStatus', status).catch(() => {});
}

async function waitForTweetTemplate(tabId, tweetId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
    const template = networkTemplates.TweetDetail;
    if (template?.queryId && template.variables) {
      let variables = {};
      try { variables = typeof template.variables === 'string' ? JSON.parse(template.variables) : template.variables; } catch {}
      if (!variables.cursor && String(variables.focalTweetId || '') === String(tweetId)) return template;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('读取评论的后台标签页已关闭。');
    await sleep(400);
  }
  throw new Error('等待 X 帖子回复请求超时；请先在 X 打开该帖子后重试。');
}

async function collectTweetReplies(tweetId, url, authorHandle, sourceTab) {
  if (commentJobs.has(tweetId)) return;
  const run = (async () => {
    let tabId;
    const post = {tweetId, url, authorHandle, status:'collecting', replyUsers:0, replies:0, collectedAt:new Date().toISOString()};
    await updateCommentStatus({tweetId, url, state:'collecting', message:'正在后台读取帖子回复…', updatedAt:new Date().toISOString()});
    try {
      const tab = await chrome.tabs.create({url, active:false, ...(sourceTab?.windowId != null ? {windowId:sourceTab.windowId} : {})});
      tabId = tab.id;
      await waitForTweetTemplate(tabId, tweetId);
      const {commentTracking:stored = {users:[], posts:[]}} = await chrome.storage.local.get('commentTracking');
      let tracking = stored;
      const durable = await durableGet('commentTracking').catch(() => null);
      if (durable && (!tracking.updatedAt || durable.updatedAt > tracking.updatedAt)) tracking = durable;
      const replyUsers = new Map();
      const seenReplyIds = new Set();
      let cursor = '';
      let page = 0;
      let repliesRead = 0;
      let complete = false;
      let stopReason = '';
      while (page < 150 && repliesRead < COMMENT_REPLY_LIMIT) {
        const variables = {focalTweetId:String(tweetId), ...(cursor ? {cursor} : {})};
        const response = await networkFetch(tabId, 'TweetDetail', variables);
        if (response.status !== 200) throw new Error(response.error || `TweetDetail 请求失败（${response.status}）`);
        const replies = parseTweetReplies(response.json, tweetId).filter(reply => reply.handle.toLowerCase() !== String(authorHandle || '').toLowerCase());
        let newRepliesOnPage = 0;
        for (const reply of replies) {
          if (!seenReplyIds.has(reply.replyId)) {
            seenReplyIds.add(reply.replyId);
            repliesRead++;
            newRepliesOnPage++;
          }
          const key = reply.handle.toLowerCase();
          const current = replyUsers.get(key) || {...reply, replyIds:new Set(), replyItems:[]};
          current.id = reply.id || current.id;
          if (!current.replyIds.has(reply.replyId)) {
            current.replyIds.add(reply.replyId);
            current.replyItems.push({replyId:reply.replyId, text:reply.replyText || '', createdAt:reply.replyCreatedAt || ''});
          }
          replyUsers.set(key, current);
        }
        page++;
        await updateCommentStatus({tweetId, url, state:'collecting', message:`正在读取回复：第 ${page} 页，发现 ${replyUsers.size} 位评论者…`, updatedAt:new Date().toISOString()}, tabId);
        const next = findBottomCursor(response.json);
        if (!next || next === cursor) { complete = true; break; }
        if (page > 1 && newRepliesOnPage === 0) { stopReason = 'stalled'; break; }
        cursor = next;
        await sleep(350);
      }
      const normalizedReplies = [...replyUsers.values()].map(({replyIds, replyItems, ...user}) => ({...user, sources:[{tweetId, url, postAuthor:authorHandle, replies:replyItems}]}));
      const replyLimitReached = !complete && repliesRead >= COMMENT_REPLY_LIMIT;
      const pageLimitReached = !complete && !stopReason && page >= 150;
      post.status = complete ? 'complete' : (replyLimitReached || pageLimitReached ? 'limit' : 'partial');
      post.stopReason = complete ? '' : (stopReason || (replyLimitReached ? 'reply_limit' : 'page_limit'));
      post.pages = page;
      post.replies = repliesRead;
      post.replyUsers = normalizedReplies.length;
      post.complete = complete;
      post.capped = replyLimitReached || pageLimitReached;
      tracking = mergeCommentTracking(tracking, post, normalizedReplies);
      await chrome.storage.local.set({commentTracking:tracking});
      await durableSet('commentTracking', tracking);
      const message = complete
        ? `完成：读取 ${repliesRead} 条不同回复，去重得到 ${normalizedReplies.length} 位评论者。`
        : replyLimitReached
          ? `达到单帖 ${COMMENT_REPLY_LIMIT} 条回复上限，已保存 ${normalizedReplies.length} 位评论者；结果可能不完整。`
          : pageLimitReached
            ? `达到单帖 150 页安全上限，已保存 ${normalizedReplies.length} 位评论者；结果可能不完整。`
            : `分页未返回新的回复，已保存 ${normalizedReplies.length} 位评论者；结果可能不完整。`;
      await updateCommentStatus({tweetId, url, state:post.status, message, updatedAt:new Date().toISOString()}, tabId);
    } catch (error) {
      const message = String(error?.message || error);
      await updateCommentStatus({tweetId, url, state:'error', message, updatedAt:new Date().toISOString()}, tabId).catch(() => {});
    } finally {
      if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
      commentJobs.delete(tweetId);
    }
  })();
  commentJobs.set(tweetId, run);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.cmd === 'configureCommentAutoFollow') {
    scheduleCommentAutoFollow(message.config || {});
    sendResponse({ok:true});
    return;
  }
  if (message?.cmd === 'runCommentAutoFollowNow') {
    runCommentAutoFollow('manual').then(sendResponse);
    return true;
  }
  if (message?.cmd === 'trackTweetReplies') {
    const tweetId = String(message.tweetId || '');
    const url = String(message.url || '');
    const match = url.match(/^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
    if (!match || match[2] !== tweetId || !sender.tab?.id) {
      sendResponse({ok:false, error:'帖子链接或页面来源无效。'});
      return;
    }
    sendResponse({ok:true, queued:true});
    collectTweetReplies(tweetId, `https://x.com/${match[1]}/status/${tweetId}`, match[1], sender.tab).catch(() => {});
    return;
  }
  if (message?.cmd !== 'networkTemplate' || !message.payload?.op) return;
  const payload = message.payload;
  networkTemplateWrite = networkTemplateWrite.then(async () => {
    const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
    networkTemplates[payload.op] = {...networkTemplates[payload.op], ...payload, json:undefined};
    await chrome.storage.local.set({networkTemplates});
    sendResponse({ok:true, op:payload.op});
  }).catch(error => { sendResponse({ok:false, error:String(error?.message || error)}); });
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.cmd !== 'getNetworkTemplates') return;
  chrome.storage.local.get('networkTemplates').then(({networkTemplates = {}}) => sendResponse(networkTemplates));
  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'x-comment-auto-follow') {
    const tracking = await loadCommentTracking();
    const cfg = tracking.autoFollow || {};
    if (!cfg.enabled) return;
    scheduleCommentAutoFollow(cfg);
    const result = await runCommentAutoFollow('alarm');
    await chrome.notifications.create(`x-comment-auto-${Date.now()}`, {
      type:'basic', iconUrl:'icon128.svg', title:'X 评论追踪 · 自动关注',
      message:result.ok ? result.summary || '评论用户关注任务已完成。' : `评论追踪任务未完成：${result.error || '请检查状态'}`
    }).catch(() => {});
    return;
  }
  if (alarm.name === 'x-followers-scan') {
    const { monitor } = await chrome.storage.local.get('monitor');
    if (!monitor?.enabled) return;
    const base = Number(monitor.every) || 60;
    const jitter = Number(monitor.jitter) || 0;
    const delta = jitter > 0 ? Math.floor((Math.random() * 2 - 1) * jitter) : 0;
    const nextDelay = Math.max(10, base + delta);
    await chrome.alarms.create('x-followers-scan', { delayInMinutes: nextDelay });
    await chrome.notifications.create(`x-followers-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon128.svg',
      title: 'X 关注与粉丝检索提醒',
      message: `增量检索周期已到（下次检索约 ${nextDelay} 分钟后），点击同步增量数据。`
    });
    return;
  }

  if (alarm.name === 'x-mutual-auto-follow') {
    const { mutualNetwork } = await chrome.storage.local.get('mutualNetwork');
    const cfg = normalizeAutoFollowConfig(mutualNetwork?.autoFollow);
    if (!cfg?.enabled) return;
    const base = Number(cfg.every) || 5;
    const jitter = Number(cfg.jitter) ?? 3;
    const delta = jitter > 0 ? Math.floor((Math.random() * 2 - 1) * jitter) : 0;
    const nextDelay = Math.max(5, base + delta);
    await chrome.alarms.create('x-mutual-auto-follow', { delayInMinutes: nextDelay });
    let handledByPanel = false;
    try {
      const res = await chrome.runtime.sendMessage({ cmd: 'runMutualAutoFollowTick' });
      if (res?.ok) handledByPanel = true;
    } catch {}
    if (!handledByPanel) {
      await chrome.notifications.create(`x-mutual-auto-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icon128.svg',
        title: 'X 互粉追踪 · 定时浏览与关注',
        message: `定时互粉浏览周期已到（下次约 ${nextDelay} 分钟后），请保持管理面板开启以自动浏览主页并点击关注。`
      });
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const tracking = await loadCommentTracking().catch(() => null);
  if (tracking?.autoFollow) scheduleCommentAutoFollow(tracking.autoFollow);
});
chrome.runtime.onInstalled.addListener(async () => {
  const tracking = await loadCommentTracking().catch(() => null);
  if (tracking?.autoFollow) scheduleCommentAutoFollow(tracking.autoFollow);
});
