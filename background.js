import {TEMP_WINDOW_ALARM, ensureTemporaryWindowCleanup, scanTemporaryWindows, handleGrokWindowPool, markTemporaryWindowReady} from './temporary-windows.js';
import {createFollowQueueRuntime, QUEUE_ALARM} from './follow-queue-runtime.js';
import { networkFetch, networkFollow, parseNetworkUsers, parseTweetReplies, findBottomCursor, mergeCommentTracking, mergeRecentPosts } from './network-api.js';
import { durableGet, durableSet } from './persistent-db.js';
import { readProfileBundle, simulateProfileScrollStep, publishQuotePostOnPage } from './page-reader.js';
import { evaluateMutualProfile, parseCount, repairMojibake } from './scoring.js';
import { randomizedInteger, randomizedSeconds } from './timing.js';
import { requestGrokComment, requestGrokText, postQuoteOnTab, deliverGrokStream, appendFollowBackSuffix } from './grok-comment.js';
import { loadCommentTracking } from './tracking-storage.js';
import {appendExecutionLog} from './execution-log.js';
import {handleExecutionLogRequest} from './execution-log-store.js';
import {createBackgroundRecords, mergeCollectedReplies, selectCommentCandidates} from './background-record-data.js';
import {mergeAutoFollowProgress} from './auto-follow-history.js';
import {sendVerificationSelfMessage} from './verification-self-message.js';
import {showVerificationAlert,markVerificationAlertClosed,focusVerificationPage} from './verification-alert-window.js';
import { recoverAutomationAlarms, restoreMissingSyncedSettings } from './automation-recovery.js';
import {recordAutoFollowAttempt} from './auto-follow-history.js';
import {createStorageWriteQueue} from './storage-write-queue.js';
import {createStorageWriteAdapter} from './storage-write-adapter.js';
import {createRecordRuntime} from './record-runtime.js';

const storageWriteQueue = createStorageWriteQueue({onError: error => console.warn('本地写入失败:', error?.message || error)});
const storageWrites = createStorageWriteAdapter({chromeApi: chrome, queue: storageWriteQueue});
const writeLocal = payload => storageWrites.perform({op: 'localSet', payload});
const recordRuntimeService = createRecordRuntime({
  storage: chrome.storage,
  durableGet,
  durableSet,
  queue: storageWriteQueue,
  extensionOrigin: chrome.runtime.getURL('')
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

chrome.notifications.onClicked.addListener(async id => {
  if (id !== 'xf-grok-verification') return;
  await showVerificationAlert({force:true}).catch(()=>{});
});
chrome.windows.onRemoved.addListener(windowId=>{markVerificationAlertClosed(windowId).catch(()=>{});});
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(change.status==='complete')markTemporaryWindowReady(tab.windowId,tabId).catch(()=>{});
});

const backgroundRecords = createBackgroundRecords({
  service: recordRuntimeService,
  extensionUrl: chrome.runtime.getURL('')
});
const followQueueRuntime = createFollowQueueRuntime({records: backgroundRecords});
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
    dwellJitterSeconds: 5,
    minFollowers: 50,
    onlyMutualIntent: true,
    grokAutoComment: false,
    grokFollowBackSuffix: false
  };
  const res = { ...defaults, ...(cfg || {}) };
  res.jitter = Math.max(1, Math.min(120, Number(res.jitter) || defaults.jitter));
  res.dwellSeconds = Math.max(2, Math.min(60, Number(res.dwellSeconds) || defaults.dwellSeconds));
  res.dwellJitterSeconds = Math.max(1, Math.min(30, Number(res.dwellJitterSeconds) || 0));
  if (res.every === 45) res.every = defaults.every;
  if (res.jitter === 15) res.jitter = defaults.jitter;
  if (res.batchLimit === 3) res.batchLimit = defaults.batchLimit;
  if (res.scrollRounds === 3) res.scrollRounds = defaults.scrollRounds;
  if (res.dwellSeconds === 6) res.dwellSeconds = defaults.dwellSeconds;
  res.grokAutoComment = Boolean(res.grokAutoComment);
  res.grokFollowBackSuffix = Boolean(res.grokFollowBackSuffix);
  return res;
}

export function normalizeUnreciprocatedConfig(cfg = {}) {
  const defaults = {
    enabled: false,
    every: 60,
    jitter: 10,
    overdueDays: 14,
    autoUnfollow: false,
    batchLimit: 10,
    unfollowDelay: 3,
    unfollowDelayJitter: 2,
    whitelist: '',
    lastRunAt: null,
    lastSummary: '尚未执行回关监测'
  };
  const res = { ...defaults, ...(cfg || {}) };
  res.every = Math.max(5, Math.min(1440, Number(res.every) || 60));
  res.jitter = Math.max(1, Math.min(60, Number(res.jitter) || 10));
  res.overdueDays = Math.max(1, Math.min(90, Number(res.overdueDays) || 14));
  res.autoUnfollow = Boolean(res.autoUnfollow);
  res.batchLimit = Math.max(1, Math.min(50, Number(res.batchLimit) || 10));
  res.unfollowDelay = Math.max(1, Math.min(30, Number(res.unfollowDelay) || 3));
  res.unfollowDelayJitter = Math.max(1, Math.min(15, Number(res.unfollowDelayJitter) || 0));
  res.whitelist = String(res.whitelist || '').trim();
  return res;
}

export function scheduleUnreciprocatedTracker(rawCfg = {}) {
  const cfg = normalizeUnreciprocatedConfig(rawCfg);
  chrome.alarms.clear('x-unreciprocated-tracker').then(() => {
    if (!cfg.enabled) return;
    const base = Number(cfg.every) || 60;
    const jitter = Number(cfg.jitter) || 1;
    const nextDelay = randomizedInteger(base, jitter, 5, 1440);
    chrome.alarms.create('x-unreciprocated-tracker', { delayInMinutes: nextDelay });
  }).catch(() => {});
}

async function scheduleCommentAutoFollow(rawCfg = {}) {
  if ((await chrome.storage.local.get('followQueueBinding')).followQueueBinding?.activated) { await chrome.alarms.clear('x-comment-auto-follow'); return; }
  const cfg = normalizeAutoFollowConfig(rawCfg);
  chrome.alarms.clear('x-comment-auto-follow').then(() => {
    if (!cfg.enabled) return;
    const every = Math.max(5, Number(cfg.every) || 5);
    const jitter = Math.max(1, Math.min(every - 1, Number(cfg.jitter) || 1));
    chrome.alarms.create('x-comment-auto-follow', {delayInMinutes:randomizedInteger(every, jitter, 5, 1440)});
  }).catch(() => {});
}

async function createNotification(id, options) {
  try {
    await chrome.notifications.create(id, {
      ...options,
      // Chrome's notification image decoder is not reliable for SVG icons.
      // Use the packaged PNG used by the extension manifest instead.
      iconUrl: chrome.runtime.getURL('icon128.png')
    });
  } catch (error) {
    console.warn('Unable to show XFollower notification:', error?.message || error);
  }
}

async function saveCommentTrackingData(tracking, changedHandle = '') {
  if (tracking.autoFollow) {
    await writeLocal({commentAutoFollowSettings: tracking.autoFollow});
    await backgroundRecords.mergeRoot('commentTracking', {autoFollow: tracking.autoFollow});
  }
  const handle = String(changedHandle || '').replace(/^@/, '').toLowerCase();
  if (!handle) return;
  const user = (tracking.users || []).find(item => String(item?.handle || '').replace(/^@/, '').toLowerCase() === handle);
  if (!user) return;
  await backgroundRecords.batch({sourceKey:'commentTracking', changes:[{handle, sourceBucket:'users', patch:user}]});
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
  if (data.relationship?.following === true) return {...data, dwellSeconds:0};
  const rounds = Math.max(1, Math.min(8, Number(cfg.scrollRounds) || 5));
  const dwellSeconds = randomizedSeconds(cfg.dwellSeconds || 15, cfg.dwellJitterSeconds, 2, 60);
  const totalDwellMs = dwellSeconds * 1000;
  const stepDelay = Math.max(1, Math.floor(totalDwellMs / rounds));
  let remainingDwellMs = totalDwellMs;
  for (let round = 0; round < rounds; round++) {
    await chrome.scripting.executeScript({target:{tabId}, func:simulateProfileScrollStep, args:[round, 420]}).catch(() => []);
    const currentStepDelay = round === rounds - 1 ? remainingDwellMs : stepDelay;
    await sleep(currentStepDelay);
    remainingDwellMs -= currentStepDelay;
  }
  const afterScroll = (await chrome.scripting.executeScript({target:{tabId}, func:readProfileBundle, args:[handle, recentLimit]}).catch(() => []))?.[0]?.result;
  if (afterScroll && !afterScroll.pending && (afterScroll.posts || []).length >= (data.posts || []).length) data = afterScroll;
  return {...data, dwellSeconds};
}

// 定时关注执行日志：时间、访问的账号、扫描的帖子、关注结果（面板与后台共用 storage 键 autoFollowLogs）
async function appendAutoFollowLog(entry) {
  const posts = (entry.posts || []).slice(0, 10).map(post => ({text:String(post.text || post || '').slice(0, 120), url:post.url || ''}));
  return appendExecutionLog({...entry, posts});
}

async function runCommentAutoFollow(source = 'alarm') {
  if ((await chrome.storage.local.get('followQueueBinding')).followQueueBinding?.activated) return {ok:false,error:'请在关注队列中执行统一关注任务'};
  if (commentFollowRunning) return {ok:false, error:'评论用户关注任务正在运行。'};
  await appendAutoFollowLog({scope:'comment', source, result:'started', detail:'评论追踪任务开始，正在读取配置并筛选候选账号。'});
  const result = await executeCommentAutoFollow(source);
  await appendAutoFollowLog({scope:'comment', source, result:result.ok ? 'completed' : 'failed', detail:result.summary || result.error || '任务已结束'});
  return result;
}

async function executeCommentAutoFollow(source = 'alarm') {
  if (commentFollowRunning) return {ok:false, error:'评论用户关注任务正在运行。'};
  commentFollowRunning = true;
  let tabId = null;
  let tracking;
  try {
    const {commentAutoFollowSettings} = await chrome.storage.local.get('commentAutoFollowSettings');
    const commentMeta = await backgroundRecords.metadata('commentTracking');
    const cfg = normalizeAutoFollowConfig(mergeAutoFollowProgress(commentAutoFollowSettings || {}, commentMeta.autoFollow || {}));
    if (source === 'alarm' && !cfg.enabled) return {ok:false, error:'定时关注已关闭。'};
    const monitor = await backgroundRecords.metadata('monitor');
    if (monitor.pausedUntil && Date.now() < Date.parse(monitor.pausedUntil)) return {ok:false, error:`关注操作暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}`};
    const candidates = await selectCommentCandidates(backgroundRecords, cfg, chrome.storage.local);
    tracking = {autoFollow: cfg, users: candidates};
    if (!candidates.length) {
      cfg.lastRunAt = new Date().toISOString();
      const totalFollowed = Number(cfg.followedCount) || 0;
      cfg.lastSummary = `没有待关注的评论用户${totalFollowed ? `（累计已关注 ${totalFollowed} 人）` : ''}。`;
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
    let alreadyFollowingCount = 0;
    const skipReasons = {};
    for (const user of candidates) {
      const handle = String(user.handle || '').replace(/^@/, '');
      let didFollow = false;
      let actualDwellSeconds = cfg.dwellSeconds;
      let commentRes = {status:'off'};
      await recordAutoFollowAttempt(handle, 'processing', '', undefined);
      try {
        await chrome.tabs.update(tabId, {url:`https://x.com/${encodeURIComponent(handle)}`});
        const profile = await readProfilePosts(tabId, handle, 5, cfg);
        actualDwellSeconds = profile.dwellSeconds ?? actualDwellSeconds;
        delete profile.dwellSeconds;
        if (profile.relationship?.following === true) {
          user.relationship = {...(user.relationship || {}), following:true};
          if (profile.id) user.id = profile.id;
          user.autoFollowState = 'followed';
          user.autoFollowCheckedAt = new Date().toISOString();
          delete user.autoFollowReason;
          await recordAutoFollowAttempt(handle, 'followed', '主页确认已关注', undefined);
          await saveCommentTrackingData(tracking, handle);
          await appendAutoFollowLog({scope:'comment', source, handle, result:'already_following', detail:'主页确认已关注，已纠正本地关系；无需再次看帖或关注。'});
          processedCount++;
          alreadyFollowingCount++;
          continue;
        }
        user.recentPosts = mergeRecentPosts(user.recentPosts || [], profile.posts || [], 100);
        user.recentPostsFetchedAt = new Date().toISOString();
        user.recentPostsCount = user.recentPosts.length;
        user.name = profile.name || user.name; user.bio = profile.bio || user.bio;
        user.followersText = profile.followersText || user.followersText; user.followingText = profile.followingText || user.followingText;
        user.relationship = {...(user.relationship || {}), ...(profile.relationship || {})};
        if (profile.id) user.id = profile.id;
        const profileKey = handle.toLowerCase();
        const existingProfile = await backgroundRecords.lookup({module:'profiles', handle:profileKey});
        const previousProfile = existingProfile?.payload || {};
        await backgroundRecords.batch({sourceKey:'profileCache', changes:[{
          handle:profileKey, sourceBucket:'map', create:!existingProfile,
          patch:{...previousProfile, ...profile, relationship:user.relationship, handle, posts:mergeRecentPosts(previousProfile.posts || [], user.recentPosts || [], 10).slice(0, 10), profileCachedAt:user.recentPostsFetchedAt}
        }]});
        await saveCommentTrackingData(tracking, handle);
        const followers = parseCount(String(user.followersText || ''));
        const minFollowers = Math.max(0, Number(cfg.minFollowers) || 0);
        const evaluation = evaluateMutualProfile({...user, ...profile, relationship:user.relationship, posts:user.recentPosts.slice(0, 10)});
        let skipReason = '';
        if (followers === null && minFollowers > 0) skipReason = '未能读取粉丝数，无法确认最低粉丝数门槛';
        else if (followers !== null && followers < minFollowers) skipReason = `粉丝数 ${followers} 低于最低门槛 ${minFollowers}`;
        else if (evaluation.isNotRecommended) skipReason = evaluation.recommendReason || '主页风险评估未通过';
        else if (cfg.onlyMutualIntent !== false && evaluation.tag !== '互粉' && evaluation.recommendLabel !== '推荐') skipReason = evaluation.intentTooltip || '未达到互粉意向或推荐条件';
        if (skipReason) {
          const category = followers === null ? '资料未读全' : followers < minFollowers ? '粉丝数低于门槛' : evaluation.hasBaitRisk ? '关注/粉丝比例不足80%' : evaluation.isNotRecommended ? '内容风险规则' : '未命中互粉或推荐条件';
          skipReasons[category] = (skipReasons[category] || 0) + 1;
          await recordAutoFollowAttempt(handle, 'skipped', skipReason, undefined);
          user.autoFollowState = 'skipped'; user.autoFollowReason = skipReason; user.autoFollowCheckedAt = new Date().toISOString();
          cfg.processedHandles = [...new Set([...(cfg.processedHandles || []), handle.toLowerCase()])].slice(-2000);
          tracking.autoFollow = cfg;
          await saveCommentTrackingData(tracking, handle);
          processedCount++;
          skippedCount++;
          await appendAutoFollowLog({scope:'comment', source, handle, result:'skipped', detail:skipReason, posts:profile.posts || []});
          await sleep(500 + Math.floor(Math.random() * 1000));
          continue;
        }
        let followed = false;
        if (user.id) {
          const result = await networkFollow(tabId, {id:user.id, handle});
          followed = result.status >= 200 && result.status < 300;
          if (!followed) {
            user.followFailureReason = result.error || `关注接口返回 ${result.status}`;
            rateLimited = result.status === 429 || /rate limit|too quickly|频率受限|过于频繁/i.test(user.followFailureReason);
          }
        }
        if (!followed && !rateLimited) {
          const lookup = await networkFetch(tabId, 'UserByScreenName', {screen_name:handle});
          const target = lookup.status === 200 ? parseNetworkUsers(lookup.json).find(item => item.handle.toLowerCase() === handle.toLowerCase()) : null;
          if (target?.relationship?.following) followed = true;
          else if (target?.id) {
            user.id = target.id;
            const result = await networkFollow(tabId, {id:target.id, handle});
            followed = result.status >= 200 && result.status < 300;
            if (!followed) {
              user.followFailureReason = result.error || `关注接口返回 ${result.status}`;
              rateLimited = result.status === 429 || /rate limit|too quickly|频率受限|过于频繁/i.test(user.followFailureReason);
            }
          } else if (!user.followFailureReason) {
            user.followFailureReason = lookup.error || '无法解析用户 ID';
          }
        }
        if (followed) {
          await recordAutoFollowAttempt(handle, 'followed', '', undefined);
          user.followedAt ||= new Date().toISOString(); user.followSource = 'comment-auto';
          user.relationship = {...(user.relationship || {}), following:true}; delete user.followFailureReason;
          user.autoFollowState = 'followed'; delete user.autoFollowReason;
          didFollow = true;
          if (cfg.grokAutoComment) {
            const posts = (user.recentPosts || []).filter(p => String(p?.text || '').trim().length >= 8 && /\/status\/\d+/.test(p?.url || ''));
            if (!posts.length) commentRes = {status:'skipped', reason:'没有读到带链接的帖子，无法定位评论目标'};
            else {
              const chosen = posts[Math.floor(Math.random() * posts.length)];
              const g = await requestGrokComment(handle, chosen, user.name, {sleep, fix:repairMojibake});
              if (!g.ok) commentRes = {status:'grok_failed', reason:g.reason};
              else {
                const replyText = cfg.grokFollowBackSuffix ? appendFollowBackSuffix(g.reply, undefined, g.language) : g.reply;
                const pub = await postQuoteOnTab(tabId, chosen, replyText, publishQuotePostOnPage, sleep);
                commentRes = {status:pub.ok ? 'posted' : 'post_failed', reason:pub.reason || '', reply:replyText, post:g.postText, postUrl:g.postUrl, channel:g.channel, language:g.language};
                if (pub.ok) { user.grokCommentAt = new Date().toISOString(); user.grokComment = replyText; user.grokCommentPostUrl = g.postUrl; }
              }
            }
          }
        } else { user.followFailedAt = new Date().toISOString(); user.autoFollowState = 'failed'; }
      } catch (error) {
        user.followFailedAt = new Date().toISOString(); user.followFailureReason = String(error?.message || error);
      }
      cfg.processedHandles = [...new Set([...(cfg.processedHandles || []), handle.toLowerCase()])].slice(-2000);
      await recordAutoFollowAttempt(handle, didFollow ? 'followed' : 'failed', user.followFailureReason || '', undefined);
      tracking.autoFollow = cfg;
      await saveCommentTrackingData(tracking, handle);
      const commentNote = {
        posted: `；✔ 已通过 Grok（${commentRes.channel}）引用原帖发布评价`,
        post_failed: `；Grok 已写好评价但引用发布失败：${commentRes.reason}`,
        grok_failed: `；Grok 未能写出评价：${commentRes.reason}`,
        skipped: `；未发布引用评价：${commentRes.reason}`
      }[commentRes.status] || '';
      await appendAutoFollowLog({scope:'comment', source, handle, result:didFollow ? 'followed' : 'failed', detail:didFollow ? `主页看帖目标停留约 ${actualDwellSeconds} 秒后关注成功${commentNote}` : (user.followFailureReason || '关注未成功'), posts:(user.recentPosts || []).slice(0, 5), grokComment:commentRes.reply || '', grokCommentPost:commentRes.post || '', grokCommentPostUrl:commentRes.postUrl || '', commentPosted:commentRes.status === 'posted'}).catch(() => {});
      processedCount++;
      if (didFollow) followedCount++;
      if (rateLimited) {
        await backgroundRecords.mergeRoot('monitor', {pausedUntil:new Date(Date.now() + 60 * 60000).toISOString()});
        break;
      }
      await sleep(1200 + Math.floor(Math.random() * 1000));
    }
    const totalFollowed = (Number(cfg.followedCount) || 0) + followedCount;
    cfg.followedCount = totalFollowed;
    cfg.lastRunAt = new Date().toISOString();
    cfg.lastSummary = `本轮处理 ${processedCount} 人，新增关注 ${followedCount} 人${alreadyFollowingCount ? `，已关注 ${alreadyFollowingCount} 人` : ''}${skippedCount ? `，条件不符 ${skippedCount} 人（${Object.entries(skipReasons).map(([reason, count]) => `${reason} ${count} 人`).join('、')}）` : ''}${processedCount > followedCount + skippedCount + alreadyFollowingCount ? `，执行失败 ${processedCount - followedCount - skippedCount - alreadyFollowingCount} 人，请查看执行日志` : ''}${totalFollowed ? ` · 累计已关注 ${totalFollowed} 人` : ''}${rateLimited ? '；检测到频率限制，已暂停关注 1 小时' : ''}。`;
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
  await writeLocal({commentTrackingStatus:status});
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
          const { id: _replyTweetId, ...replyRest } = reply;
          const current = replyUsers.get(key) || {...replyRest, id: reply.userId || '', replyIds:new Set(), replyItems:[]};
          current.id = reply.userId || (current.id && current.id !== reply.id ? current.id : '');
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
      await mergeCollectedReplies(backgroundRecords, {post, replies:normalizedReplies, mergeCommentTracking});
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

export const BACKGROUND_BUILD_VERSION = '1.6.0';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.cmd === 'recordData') {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ok:false, error:'仅扩展内部可访问记录'});
      return;
    }
    recordRuntimeService.handle(message, sender.url).then(
      result => sendResponse(result),
      error => sendResponse({ok:false, error:String(error?.message || error)})
    );
    return true;
  }
  if (message?.cmd === 'storageWrite') {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ok:false, error:'仅扩展内部可写本地数据'});
      return;
    }
    storageWrites.perform(message).then(
      result => sendResponse(result),
      error => sendResponse({ok:false, error:String(error?.message || error)})
    );
    return true;
  }
  if (['showGrokVerificationAlert','focusGrokVerificationPage'].includes(message?.cmd)) {
    if (sender.id !== chrome.runtime.id || (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL('')))) {sendResponse({ok:false,error:'仅扩展内部可操作验证提醒'});return;}
    const operation=message.cmd==='showGrokVerificationAlert'?showVerificationAlert():focusVerificationPage();
    operation.then(value=>sendResponse({ok:true,...value}),error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if (message?.cmd === 'notifyGrokVerificationSelf') {
    if (sender.id !== chrome.runtime.id || (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL('')))) {sendResponse({ok:false,error:'仅扩展内部可发送本人验证提醒'});return;}
    (async()=>{
      const {grokVerification:notice}=await chrome.storage.local.get('grokVerification');
      if(!notice || notice.at!==message.at)return {ok:false,stale:true};
      const identity=await followQueueRuntime.handle({cmd:'followQueueIdentity'});
      return sendVerificationSelfMessage({identity,notice}).finally(()=>showVerificationAlert().catch(()=>{}));
    })().then(sendResponse,async error=>{
      const reason=String(error?.message || error);
      await writeLocal({grokVerificationSelfMessage:{status:'failed',reason,at:Date.now()}});
      sendResponse({ok:false,error:reason});
    });
    return true;
  }
  if (message?.cmd === 'grokWindowPool') {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) { sendResponse({ok:false,error:'仅扩展页面可管理 Grok 窗口'}); return; }
    handleGrokWindowPool(message).then(value=>sendResponse({ok:true,value}),error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if (message?.cmd?.startsWith('followQueue')) {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) { sendResponse({ok:false,error:'仅扩展页面可操作关注队列'}); return; }
    followQueueRuntime.handle(message).then(sendResponse,error=>sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }
  if (message?.cmd === 'getBackgroundBuildVersion') {
    sendResponse({ok:true, version:BACKGROUND_BUILD_VERSION});
    return;
  }
  if (message?.cmd === 'grokStreamAnswer') {
    deliverGrokStream(message.text || '');
    return;
  }
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
    await writeLocal({networkTemplates});
    sendResponse({ok:true, op:payload.op});
  }).catch(error => { sendResponse({ok:false, error:String(error?.message || error)}); });
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.cmd !== 'getNetworkTemplates') return;
  chrome.storage.local.get('networkTemplates').then(({networkTemplates = {}}) => sendResponse(networkTemplates));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => handleExecutionLogRequest(message, sender, sendResponse));

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === TEMP_WINDOW_ALARM) { await scanTemporaryWindows().catch(error=>console.warn('临时窗口清理失败:',error)); return; }
  if (alarm.name === QUEUE_ALARM) {
    const result = await followQueueRuntime.run().catch(error=>({ok:false,error:error.message}));
    await createNotification(`follow-queue-${Date.now()}`,{type:'basic',title:'X 关注队列',message:result.summary || result.error || '本轮结束'});
    return;
  }
  if (['x-mutual-auto-follow','x-comment-auto-follow'].includes(alarm.name) && (await chrome.storage.local.get('followQueueBinding')).followQueueBinding?.activated) { await chrome.alarms.clear(alarm.name); return; }
  if (alarm.name === 'x-comment-auto-follow') {
    const {commentAutoFollowSettings} = await chrome.storage.local.get('commentAutoFollowSettings');
    const cfg = commentAutoFollowSettings || {};
    if (!cfg.enabled) return;
    scheduleCommentAutoFollow(cfg);
    const result = await runCommentAutoFollow('alarm');
    await createNotification(`x-comment-auto-${Date.now()}`, {
      type:'basic', title:'X 评论追踪 · 自动关注',
      message:result.ok ? result.summary || '评论用户关注任务已完成。' : `评论追踪任务未完成：${result.error || '请检查状态'}`
    });
    return;
  }
  if (alarm.name === 'x-followers-scan') {
    let monitor;
    try { monitor = await backgroundRecords.metadata('monitor'); } catch (error) { console.warn('粉丝定时配置不可用:', error?.message || error); return; }
    if (!monitor?.enabled) return;
    const base = Number(monitor.every) || 60;
    const jitter = Math.max(1, Number(monitor.jitter) || 1);
    const nextDelay = randomizedInteger(base, jitter, 10, 1440);
    await chrome.alarms.create('x-followers-scan', { delayInMinutes: nextDelay });
    let handledByPanel = false;
    try {
      const res = await chrome.runtime.sendMessage({ cmd: 'runFollowersScanTick' });
      if (res?.ok) handledByPanel = true;
    } catch {}
    if (!handledByPanel) {
      await createNotification(`x-followers-${Date.now()}`, {
        type: 'basic',
        title: 'X 粉丝管理 · 定时检测提醒',
        message: `增量检测周期已到（下次约 ${nextDelay} 分钟后），请打开管理面板以自动同步粉丝数据并拉取待回关用户。`
      });
    }
    return;
  }

  if (alarm.name === 'x-mutual-auto-follow') {
    const {mutualAutoFollowSettings} = await chrome.storage.local.get('mutualAutoFollowSettings');
    const cfg = normalizeAutoFollowConfig(mutualAutoFollowSettings || {});
    if (!cfg?.enabled) return;
    const base = Number(cfg.every) || 5;
    const jitter = Number(cfg.jitter) || 1;
    const nextDelay = randomizedInteger(base, jitter, 5, 1440);
    await chrome.alarms.create('x-mutual-auto-follow', { delayInMinutes: nextDelay });
    let handledByPanel = false;
    try {
      const res = await chrome.runtime.sendMessage({ cmd: 'runMutualAutoFollowTick' });
      if (res?.ok) handledByPanel = true;
    } catch {}
    if (!handledByPanel) {
      await createNotification(`x-mutual-auto-${Date.now()}`, {
        type: 'basic',
        title: 'X 互粉追踪 · 定时浏览与关注',
        message: `定时互粉浏览周期已到（下次约 ${nextDelay} 分钟后），请保持管理面板开启以自动浏览主页并点击关注。`
      });
    }
  }

  if (alarm.name === 'x-unreciprocated-tracker') {
    const {unreciprocatedSettings} = await chrome.storage.local.get('unreciprocatedSettings');
    const cfg = normalizeUnreciprocatedConfig(unreciprocatedSettings || {});
    if (!cfg?.enabled) return;
    const base = Number(cfg.every) || 60;
    const jitter = Number(cfg.jitter) || 1;
    const nextDelay = randomizedInteger(base, jitter, 5, 1440);
    await chrome.alarms.create('x-unreciprocated-tracker', { delayInMinutes: nextDelay });
    let handledByPanel = false;
    try {
      const res = await chrome.runtime.sendMessage({ cmd: 'runUnreciprocatedTick' });
      if (res?.ok) handledByPanel = true;
    } catch {}
    if (!handledByPanel) {
      await createNotification(`x-unreciprocated-${Date.now()}`, {
        type: 'basic',
        title: 'X 回关监测 · 定时检测提醒',
        message: `定时回关检测周期已到（默认一小时一次），请保持管理面板开启以自动检测对方回关状态并清理超时未回关账号。`
      });
    }
  }
});

async function restoreSettingsFromSync() {
  await restoreMissingSyncedSettings().catch(() => {});
}

chrome.runtime.onStartup.addListener(async () => {
  await restoreSettingsFromSync();
  await recoverAutomationAlarms();
});
chrome.runtime.onInstalled.addListener(async () => {
  await restoreSettingsFromSync();
  await recoverAutomationAlarms();
});

recoverAutomationAlarms().catch(error => console.warn('恢复自动任务失败:', error));

followQueueRuntime.schedule({preserve:true}).catch(error => console.warn('恢复关注队列失败:', error));

let queueSourceSyncTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    recordRuntimeService.noteLegacyChange(changes).catch(error => console.warn('记录库变更标记失败:', error?.message || error));
  }
  if (area !== 'local' || !['monitor','mutualNetwork','commentTracking'].some(key => changes[key])) return;
  clearTimeout(queueSourceSyncTimer);
  queueSourceSyncTimer = setTimeout(() => followQueueRuntime.syncCandidates().catch(error => console.warn('关注队列入队失败:', error)), 800);
});

ensureTemporaryWindowCleanup().catch(error=>console.warn('临时窗口清理初始化失败:',error));

let lastGrokFocusedWindow;
chrome.windows.onFocusChanged.addListener(windowId => {
  const previous=lastGrokFocusedWindow;lastGrokFocusedWindow=windowId;
  for(const id of new Set([previous,windowId])) if(Number.isInteger(id)&&id>=0)handleGrokWindowPool({action:'touch',windowId:id}).catch(()=>{});
});
