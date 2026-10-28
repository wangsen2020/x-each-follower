import {observeProfile} from '../../platform/x/profile-access.js';
import {queueRelationshipDecision} from '../relationships/fan-followback-policy.js';
import {readQueueProfile,profileReadLimitError} from './profile-reader.js';
import {readScoredPosts} from './scored-posts.js';
import {createProfileTab,updateProfileTab,readProfileOnTab} from '../../platform/x/profile-access.js';
import {createQueueDiagnostics} from './queue-diagnostics.js';
import {createCommentWorker, COMMENT_ALARM, COMMENT_TASK_TIMEOUT_MS} from './comment-worker.js';
export {COMMENT_ALARM};
import {isPageFailure} from '../../platform/page-failure.js';
import {appendQuoteTags} from '../grok/quote-tags.js';
import {quotePublishIssue,quoteInputComplete,readQuoteSourceOnPage} from '../grok/quote-quality.js';
import {generateDirectReply,generateXArticle} from '../publishing/publication-writer.js';
import {createReplyPublisher} from '../publishing/reply-publisher.js';
import {createArticlePublisher} from '../publishing/article-publisher.js';
import {generateArticleCover} from '../publishing/grok-cover.js';
import {generateOriginalPost} from '../publishing/post-writer.js';
import {createPostPublisher} from '../publishing/post-publisher.js';
import {originalQualityIssue,originalTextIssue} from '../publishing/original-quality.js';
import {createFollowQueueStore} from './follow-queue-store.js';
import {createFollowQueueScheduler} from './follow-queue-scheduler.js';
import {collectFollowQueueCandidates} from './follow-queue-sources.js';
import {createFanInspectionBatch} from '../relationships/fan-inspection-batch.js';
import {networkFetch, networkGetUserProfile, networkFollow, parseNetworkUsers, mergeRecentPosts} from '../relationships/network-api.js';
import {readProfileBundle, simulateProfileScrollStep, publishQuotePostOnPage, setQuoteFrameFallbackOnPage} from '../../platform/x/page-reader.js';
import {parseCount, riskAssess} from '../relationships/scoring.js';
import {requestGrokComment, postQuoteOnTab, resolveCommentLanguage, quoteCandidates, highestScoredPost, composeQueueFollowBack} from '../grok/grok-comment.js';
import {interactionSkipReason} from '../relationships/content-risk.js';
import {followerRatioDecision} from '../relationships/follower-ratio-policy.js';
import {removeRatioFollower} from '../../platform/x/remove-follower.js';
import {randomizedSeconds, randomizedInteger} from '../../shared/timing.js';
import {appendExecutionLog, normalizeQueueExecutionLog} from '../../shared/execution-log.js';
import {readAutoFollowAttempts} from '../../shared/auto-follow-history.js';
import {ACCOUNT_FOLLOW_LIMIT_MESSAGE, isAccountFollowLimit} from '../../shared/follow-limit.js';

export const QUEUE_ALARM = 'x-unified-follow-queue';
const BINDING_KEY = 'followQueueBinding';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => String(value || '').replace(/^@/, '').toLowerCase();

export function quotePublicationState(result) {
  if (result?.riskBlocked) return 'skipped';
  return result?.attempted === false ? 'draft' : result?.stage === 'composer' ? 'failed' : 'uncertain';
}

export function assessQueueProfile(profile, settings, confirmedFollowBack = false) {
  const interactionReason = interactionSkipReason(profile);
  if (interactionReason) return interactionReason;
  if (confirmedFollowBack && settings.followBackAllowAll === true) return '';
  const followers = parseCount(String(profile.followersText ?? ''));
  const following = parseCount(String(profile.followingText ?? ''));
  const risk = riskAssess(profile);
  if (risk.riskCategories.some(category => category === 'armed_group' || category === 'terrorism')) {
    return `命中武装组织或恐怖极端内容门禁（${risk.hits.slice(0, 2).join('、')}）`;
  }
  if (settings.skipRiskContent !== false && risk.level === 'danger') {
    return `命中高风险内容门禁（${risk.hits.slice(0, 2).join('、')}）`;
  }
  // A verified follower already chose to follow us. Growth-candidate thresholds
  // must not prevent reciprocation; safety checks above still apply.
  if (confirmedFollowBack) return '';
  if (followers === null || following === null) return '未读全粉丝与关注数';
  if (followers < settings.minFollowers) return `粉丝数低于 ${settings.minFollowers}`;
  if (followers > 0 && following / followers < settings.ratioThreshold) return `关注/粉丝比例低于 ${Math.round(settings.ratioThreshold * 100)}%`;
  // Configurable ratio is authoritative here; do not reuse the legacy fixed 80% veto.
  return '';
}

export function readQueueViewerOnPage() {
  return document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.split('/')[1] || '';
}

export async function waitForQueueViewer({read,expected,wait=sleep,check=async()=>{},attempts=20}) {
  const wanted=canonical(expected);
  for(let i=0;i<attempts;i++){
    await check();
    let current;
    try{current=canonical(await read());}
    catch(error){
      if(!/execution context was destroyed|cannot find context|frame.*removed|no frame with id/i.test(error.message||''))throw error;
      current='';
    }
    if(current){
      if(current!==wanted)throw new Error(`当前 X 登录账号 @${current} 与队列绑定账号 @${wanted} 不一致`);
      return current;
    }
    if(i<attempts-1)await wait(500);
  }
  throw new Error('X 页面暂未读到登录账号，请等待页面加载后重试；未确认账号变化');
}

export function findPublishedQueueQuoteOnPage(handle, originalId, text, after) {
  const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
  for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
    const body = article.querySelector('[data-testid="tweetText"]')?.innerText || '';
    if (normalized(body) !== normalized(text)) continue;
    const links = [...article.querySelectorAll('a[href*="/status/"]')];
    for (const link of links) {
      const match = new URL(link.href).pathname.match(/^\/([^/]+)\/status\/(\d+)$/);
      if (!match || match[1].toLowerCase() !== handle.toLowerCase() || match[2] === originalId) continue;
      const created = Number((BigInt(match[2]) >> 22n) + 1288834974657n);
      if (created >= after - 5000) return {id:match[2], url:`https://x.com/${match[1]}/status/${match[2]}`};
    }
  }
  return null;
}

export async function confirmPublishedQueueQuote({api = chrome, tabId, handle, originalId, text, after,
  wait = sleep, now = Date.now, canContinue = () => true, timeoutMs = 45000}) {
  const started = now();
  const url = `https://x.com/${encodeURIComponent(handle)}`;
  await updateProfileTab(api,tabId,{url},'follow-queue');
  let prepared = false;
  let refreshed = false;
  while (now() - started < timeoutMs && await canContinue()) {
    await wait(700);
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status !== 'complete') continue;
    if (!prepared) {
      await api.scripting.executeScript({target:{tabId},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(error=>{if(isPageFailure(error))throw error;});
      prepared = true;
    }
    const proof = (await api.scripting.executeScript({target:{tabId},func:findPublishedQueueQuoteOnPage,
      args:[handle,originalId,text,after]}).catch(error=>{if(isPageFailure(error))throw error;return [];}))?.[0]?.result;
    if (proof?.id && proof?.url) return proof;
    // X can initially return the pre-publication profile timeline. Refresh only
    // this verification tab, never click Post again to compensate for stale data.
    if (!refreshed && now() - started >= 15000) {
      await api.tabs.reload(tabId);
      refreshed = true;
      prepared = false;
    }
  }
  return null;
}

export function createFollowQueueRuntime({api = chrome, store, fetchUser, fetchIdentity = networkFetch, fetchProfile=networkGetUserProfile, performFollow=networkFollow, removeFollower=removeRatioFollower, generateComment=requestGrokComment, generatePost=generateOriginalPost, generateReply=generateDirectReply, generateArticle=generateXArticle, replyPublisher, articlePublisher, generateCover, postPublisher, wait = sleep, records = null} = {}) {
  const publishing=postPublisher || createPostPublisher({api});
  const replies=replyPublisher || createReplyPublisher({api});
  const articles=articlePublisher || createArticlePublisher({api});
  const modeLabel=mode=>({reply:'评论',quote:'引用评价',article:'文章',original:'旧版新帖'}[mode]||'引用评价');
  const makeCover=generateCover || (options=>generateArticleCover({...options,api}));
  if (!store) {
    let opened;
    store = new Proxy({}, {get(_target, key) { opened ||= createFollowQueueStore(); return opened[key]?.bind(opened); }});
  }
  const writeLocal = payload => api.storage.local.set(payload);
  let syncing = Promise.resolve();
  const readBinding = async () => (await api.storage.local.get(BINDING_KEY))[BINDING_KEY];
  const diagnostics=createQueueDiagnostics({api});
  const failureNotice=f=>`异常账号 ${f.diagnostic.handle?'@'+f.diagnostic.handle:'批次级'}，阶段：${f.diagnostic.stageLabel}。详情见执行日志，诊断 ${f.diagnostic.id.slice(0,8)}。`;
  const script = async (tabId, func, args = []) => {try{if(func===readProfileBundle)return await readProfileOnTab(api,tabId,args[0],args[1],'follow-queue');return (await api.scripting.executeScript({target:{tabId},func,args}))?.[0]?.result;}catch(error){error.pageContext={...error.pageContext,tabId,operation:func.name,callerStack:new Error('队列页面读取调用位置').stack};throw error;}};
  const safeLog = async entry => {
    if (typeof api?.storage?.local?.get === 'function' && typeof api?.storage?.local?.set === 'function') {
      await (async () => {
        const job = entry.jobId ? await readJob(entry.accountId, entry.jobId) || {} : {};
        const normalized = normalizeQueueExecutionLog({...entry,source:'manual'},job);
        if (entry.scope === 'comment') normalized.scope = 'comment';
        await appendExecutionLog(normalized, api.storage.local);
      })().catch(() => {});
    }
  };
  async function viewer(tabId) { return canonical(await script(tabId, readQueueViewerOnPage)); }
  let identifying;
  let identityStage = 'idle';
  async function identity() {
    if (identifying) return identifying;
    identityStage = 'checking';
    identifying = resolveIdentity().then(result => { identityStage = 'ready'; return result; }, error => { identityStage = 'failed'; throw error; }).finally(() => { identifying = null; });
    return identifying;
  }
  async function resolveIdentity() {
    const tabs = await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    const binding = await readBinding();
    // The account ID was verified when this queue was activated. X's profile
    // navigation link identifies the current viewer independently of the
    // display name; avoid a fresh GraphQL lookup on every panel opening.
    const boundViewer = handle => binding?.activated && binding.accountId &&
      canonical(binding.handle) === handle ? {accountId:binding.accountId,handle} : null;
    const lookup = async (tabId, handle) => {
      const result = await fetchIdentity(tabId, 'UserByScreenName', {screen_name:handle});
      const user = result.status === 200 && parseNetworkUsers(result.json).find(u => canonical(u.handle) === handle);
      if (!user?.id) return null;
      if (binding?.activated && binding.accountId === user.id && canonical(binding.handle) !== handle) {
        await writeLocal({[BINDING_KEY]:{...binding,handle}});
      }
      return {accountId:user.id, handle};
    };
    // Existing pages may still belong to the extension context removed during uninstall.
    // Try them first, then use one owned page to capture a fresh request template.
    for (const tab of tabs) {
      const handle = await viewer(tab.id).catch(() => '');
      if (!handle) continue;
      const bound = boundViewer(handle);
      if (bound) return bound;
      const found = await lookup(tab.id, handle).catch(() => null);
      if (found) return found;
    }
    let temporary;
    try {
      identityStage = 'opening';
      temporary = await createProfileTab(api,{url:'https://x.com/home',active:false},'follow-queue');
      let handle = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        handle = await viewer(temporary.id).catch(() => '');
        if (handle) break;
        await wait(500);
      }
      if (!handle) throw new Error('未能读取登录账号，请先在 X 首页完成登录，再点击重试。');
      const bound = boundViewer(handle);
      if (bound) return bound;
      identityStage = 'initializing';
      await updateProfileTab(api,temporary.id,{url:'https://x.com/' + encodeURIComponent(handle)},'follow-queue');
      for (let attempt = 0; attempt < 40; attempt++) {
        // Require the freshly loaded page to confirm the same logged-in viewer.
        const current = await viewer(temporary.id).catch(() => '');
        if (current && current !== handle) throw new Error('X 登录账号发生变化，请重新确认。');
        if (current === handle) {
          const found = await lookup(temporary.id, handle).catch(() => null);
          if (found) return found;
        }
        await wait(500);
      }
      throw new Error('账号初始化未完成，X 页面可能加载缓慢或请求受限，请稍后点击重试。');
    } finally { if (temporary) await api.tabs.remove(temporary.id).catch(() => {}); }
  }
  let runBlockReason = null;
  const blockRun = (code,message,extra={}) => {runBlockReason={code,message,...extra};return false;};
  async function canRun(accountId) {
    runBlockReason = null;
    const binding = await readBinding();
    if (!binding?.activated) return blockRun('unbound','尚未确认队列账号，请先确认数据归属。');
    if (binding.accountId !== accountId) return blockRun('binding-changed','队列绑定账号已变化，本轮已停止。');
    const tabs = await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    let pageError;
    for (const tab of tabs) {
      const handle = await viewer(tab.id).catch(error=>{if(isPageFailure(error))pageError={error,tab};return '';});
      if (handle) return handle === canonical(binding.handle) || blockRun('viewer-mismatch',`当前 X 登录账号 @${handle} 与队列账号 @${binding.handle} 不一致。`);
    }
    if(pageError){const failure=await diagnostics.record(pageError.error,{stage:'check-account',accountId,handle:binding.handle,tabId:pageError.tab.id,requestedUrl:pageError.tab.url});if(runFailures)runFailures.push(failure);}
    return blockRun(pageError?'page-unavailable':'viewer-unavailable',pageError?'X 页面加载失败，无法核实登录账号，请恢复页面后重试。':'未读到 X 登录账号，请打开已登录的 X 页面并等待加载完成。');
  }
  async function readJob(accountId, jobId) {
    if (!jobId) return null;
    if (typeof store.get === 'function') {
      const job = await store.get(jobId);
      if (!job || (accountId && job.accountId !== accountId)) return null;
      return job;
    }
    return (await store.list({accountId})).find(item => item.id === jobId) || null;
  }
  async function priorByHandle(accountId, handle) {
    if (typeof store.lookup === 'function') return store.lookup({accountId, handle});
    let prior = null;
    for (const job of await store.list({accountId})) {
      if (canonical(job.handle) === canonical(handle)) prior = job;
    }
    return prior;
  }
  function profilesFromSnapshot(data) {
    const profiles = new Map();
    const merge = (user, fallback = '') => {
      if (!user || typeof user !== 'object') return;
      const handle = canonical(user.handle || fallback);
      if (!handle) return;
      const current = {...(profiles.get(handle) || {}), handle};
      for (const field of ['name', 'bio', 'avatarUrl', 'followersText', 'followingText']) {
        if (user[field] != null && String(user[field]).trim() !== '') current[field] = String(user[field]);
      }
      const blue = user.blueVerified ?? user.is_blue_verified ?? user.isBlueVerified;
      if (typeof blue === 'boolean') current.blueVerified = blue;
      if (typeof user.verified === 'boolean') current.verified = user.verified;
      profiles.set(handle, current);
    };
    for (const rows of [data?.monitor?.users, data?.monitor?.queue, data?.monitor?.followingUsers, data?.mutualNetwork?.users, data?.commentTracking?.users]) {
      for (const user of Array.isArray(rows) ? rows : []) merge(user);
    }
    for (const [handle, user] of Object.entries(data?.profileCache || {})) merge(user, handle);
    return profiles;
  }
  function profileChanged(previous, incoming) {
    if (!incoming) return false;
    const prior = previous && typeof previous === 'object' ? previous : {};
    for (const field of ['name', 'bio', 'avatarUrl', 'followersText', 'followingText', 'blueVerified', 'verified']) {
      if (incoming[field] != null && incoming[field] !== prior[field]) return true;
    }
    return false;
  }
  async function saveProfile(handle, incoming) {
    const key = canonical(handle);
    if (!records) {
      const {profileCache = {}} = await api.storage.local.get('profileCache');
      const previous = profileCache[key] || {};
      profileCache[key] = {...previous, ...incoming, posts:mergeRecentPosts(previous.posts || [], incoming.posts || [], 100), profileCachedAt:new Date().toISOString()};
      await writeLocal({profileCache});
      return profileCache[key];
    }
    const existing = await records.lookup({module:'profiles', handle:key});
    const previous = existing?.payload || {};
    const patch = {...previous, ...incoming, handle:incoming.handle || previous.handle || handle, posts:mergeRecentPosts(previous.posts || [], incoming.posts || [], 100), profileCachedAt:new Date().toISOString()};
    await records.batch({sourceKey:'profileCache', changes:[{handle:key, sourceBucket:'map', create:!existing, patch}]});
    return patch;
  }
  async function backfillProfiles({cursor = null, limit = 50} = {}) {
    const binding = await readBinding();
    if (!binding?.activated) throw new Error('请先确认队列账号');
    if (typeof store.backfillProfiles !== 'function') throw new Error('队列档案回填尚未接入');
    if (!records) {
      const data = await api.storage.local.get(['monitor', 'mutualNetwork', 'commentTracking', 'profileCache']);
      return store.backfillProfiles({accountId:binding.accountId, profiles:[...profilesFromSnapshot(data).values()], cursor, limit});
    }
    if (typeof store.queryPage !== 'function') throw new Error('队列档案回填尚未接入');
    const page = await store.queryPage({accountId:binding.accountId, state:'all', source:'all', cursor, limit});
    const handles = [...new Set((page.jobs || []).map(job => canonical(job.handle)).filter(Boolean))].slice(0, 100);
    const rows = handles.length ? await records.profiles(handles) : [];
    const profiles = new Map();
    for (const row of rows) {
      const handle = canonical(row?.payload?.handle || row?.handle);
      const merged = absorbProfile(null, {...(row.payload || {}), handle});
      if (handle && merged) profiles.set(handle, merged);
    }
    for (const handle of handles) {
      if (profiles.has(handle)) continue;
      for (const sourceKey of ['monitor', 'mutualNetwork', 'commentTracking']) {
        const found = await records.lookupAll({sourceKey, bucket:'users', handle});
        for (const row of found) {
          const merged = absorbProfile(profiles.get(handle), row.payload || {});
          if (merged) profiles.set(handle, merged);
        }
      }
    }
    return store.backfillProfiles({accountId:binding.accountId, profiles:[...profiles.values()], cursor, limit});
  }
  async function enqueueCandidates(binding, candidates, profiles) {
    const allowAll = typeof store.getSettings === 'function' && (await store.getSettings(binding.accountId)).followBackAllowAll === true;
    const ranks = {skipped:1, uncertain:2, excluded:3, followed:4};
    for (const candidate of candidates) {
      const prior = await priorByHandle(binding.accountId, candidate.handle);
      if (prior && !prior.targetUserId && typeof records?.fanDirectory === 'function') {
        const directory = await records.fanDirectory([canonical(candidate.handle)]);
        if (directory.some(row=>row.payload?.legacyHandleIdentityConflict)) continue;
      }
      const verifiedDecision = prior?.followResult?.relationshipDecision;
      const bypass = allowAll && candidate.followBackCandidate && (!verifiedDecision || verifiedDecision.code === 'follow-back')
        && candidate.sources.some(s=>s.module === 'fans' && s.enabled);
      const item = bypass && candidate.state === 'skipped' ? {...candidate,state:''} : candidate;
      if (bypass && prior?.state === 'skipped' && !prior.followResult?.succeeded && !verifiedDecision && !prior.followResult?.fanBypassReopened) {
        await store.resolveJob({accountId:binding.accountId,id:prior.id,state:'pending',stage:'pending',nextEligibleAt:0,
          followResult:{...prior.followResult,fanBypassReopened:true,reason:'待回关一律放行，重新核验关系后回关'}});
      }
      const newSource = !prior || item.sources.some(source => !prior.sources.some(s => s.module === source.module && s.url === source.url));
      const priorState = prior?.followResult?.succeeded ? 'followed' : prior?.importedHold?.state || prior?.state;
      const verifiedNotFollowing = prior?.followResult?.verifiedAt && prior?.followResult?.following === false;
      const blockedByActiveOrVerified = verifiedNotFollowing
        || ((prior?.state === 'running' || prior?.followResult?.verifiedAt) && item.state !== 'followed');
      const newOutcome = !blockedByActiveOrVerified && (ranks[item.state] || 0) > (ranks[priorState] || 0);
      const profile = profiles.get(canonical(item.handle)) || item.profile || null;
      const priorityChanged = typeof item.followBackCandidate === 'boolean' && item.followBackCandidate !== prior?.followBackCandidate;
      if (prior && !newSource && !newOutcome && !priorityChanged && !profileChanged(prior.profile, profile)) continue;
      if (item.state && item.state !== 'pending' && newOutcome) await store.importOutcome({...item, profile});
      else await store.enqueue({...item, profile});
    }
  }
  function emptyModules() {
    return {monitor:{users:[], queue:[], followingUsers:[]}, mutualNetwork:{users:[]}, commentTracking:{users:[], posts:[]}};
  }
  function placeRow(snapshot, row) {
    const payload = row?.payload;
    if (!payload || typeof payload !== 'object') return;
    const bucket = row.sourcePath?.[1];
    const key = row.sourcePath?.[0] || row.sourceKey;
    if (key === 'monitor' && bucket === 'queue') snapshot.monitor.queue.push(payload);
    else if (key === 'monitor' && bucket === 'followingUsers') snapshot.monitor.followingUsers.push(payload);
    else if (key === 'monitor') snapshot.monitor.users.push(payload);
    else if (key === 'mutualNetwork') snapshot.mutualNetwork.users.push(payload);
    else if (bucket === 'posts' || row.module === 'posts') snapshot.commentTracking.posts.push(payload);
    else if (key === 'commentTracking') snapshot.commentTracking.users.push(payload);
  }
  function absorbProfile(current, incoming) {
    const next = {...(current || {})};
    if (!incoming || typeof incoming !== 'object') return next.handle ? next : null;
    for (const field of ['name', 'bio', 'avatarUrl', 'followersText', 'followingText']) {
      if (incoming[field] != null && String(incoming[field]).trim() !== '') next[field] = String(incoming[field]);
    }
    const blue = incoming.blueVerified ?? incoming.is_blue_verified ?? incoming.isBlueVerified;
    if (typeof blue === 'boolean') next.blueVerified = blue;
    if (typeof incoming.verified === 'boolean') next.verified = incoming.verified;
    next.handle = next.handle || canonical(incoming.handle);
    return next.handle ? next : null;
  }
  async function profilesForHandles(handles, snapshot) {
    const profiles = profilesFromSnapshot(snapshot);
    const unique = [...new Set(handles.map(canonical).filter(Boolean))];
    if (!unique.length) return profiles;
    for (const row of await records.profiles(unique)) {
      const handle = canonical(row?.payload?.handle || row?.handle);
      if (!handle) continue;
      const merged = absorbProfile(profiles.get(handle) || {handle}, row.payload || {});
      if (merged) profiles.set(handle, merged);
    }
    return profiles;
  }
  async function syncFromRecords(binding) {
    const settings = await api.storage.local.get(['mutualAutoFollowSettings', 'commentAutoFollowSettings']);
    await enqueueCandidates(binding, collectFollowQueueCandidates({
      accountId:binding.accountId, ...emptyModules(), attempts:{}, sourceEnabled:binding.sources,
      mutualAutoFollowSettings:settings.mutualAutoFollowSettings, commentAutoFollowSettings:settings.commentAutoFollowSettings
    }), new Map());
    for (const sourceKey of ['monitor', 'mutualNetwork', 'commentTracking']) {
      let pageCursor = null;
      do {
        const page = await records.sourcePage({sourceKey, limit:100, cursor:pageCursor});
        const rows = page.records || [];
        const snapshot = emptyModules();
        const handles = [];
        for (const row of rows) {
          placeRow(snapshot, row);
          const handle = canonical(row.payload?.handle || row.handle);
          if (handle && row.module !== 'posts' && row.sourcePath?.[1] !== 'posts') handles.push(handle);
        }
        for (const user of snapshot.commentTracking.users) {
          for (const source of user.sources || []) {
            if (!source?.tweetId || source.url) continue;
            const found = await records.lookupAll({sourceKey:'commentTracking', bucket:'posts', tweetId:String(source.tweetId)});
            const match = found.find(row => row.payload?.tweetId === source.tweetId && row.payload?.url);
            if (match) snapshot.commentTracking.posts.push({tweetId:source.tweetId, url:match.payload.url});
          }
        }
        const attempts = handles.length ? await readAutoFollowAttempts(handles.map(handle => ({handle})), api.storage.local) : {};
        const profiles = await profilesForHandles(handles, snapshot);
        if (sourceKey === 'monitor' && typeof records.fanDirectory === 'function') {
          const directory = new Map((await records.fanDirectory([...new Set(handles)])).map(row => [canonical(row.handle),row.payload]));
          for (const bucket of ['users','queue','followingUsers']) snapshot.monitor[bucket] = snapshot.monitor[bucket]
            .filter(user => ['following','mutual','pending'].includes(directory.get(canonical(user.handle))?.fanCategory))
            .map(user => ({...user,relationship:directory.get(canonical(user.handle)).relationship,
              state:directory.get(canonical(user.handle)).fanCategory === 'pending' ? 'follow_back' : 'following'}));
        }
        await enqueueCandidates(binding, collectFollowQueueCandidates({
          accountId:binding.accountId, ...snapshot, attempts, sourceEnabled:binding.sources
        }), profiles);
        pageCursor = page.nextCursor || null;
      } while (pageCursor);
    }
  }
  async function syncCandidates() {
    const run = syncing.then(async () => {
      const binding = await readBinding();
      if (!binding?.activated || !await canRun(binding.accountId)) return;
      if (records) {
        await syncFromRecords(binding);
        return;
      }
      const data = await api.storage.local.get(null);
      const profiles = profilesFromSnapshot(data);
      const candidates = collectFollowQueueCandidates({accountId:binding.accountId, ...data,
        attempts:data, sourceEnabled:binding.sources});
      await enqueueCandidates(binding, candidates, profiles);
    });
    syncing = run.catch(() => {});
    return run;
  }
  const executionAudits = new Map();
  async function execute(job, settings, control) {
    const audit = {startedAt:new Date().toISOString(), posts:[], scanned:false, scrollRounds:0, plannedScrollRounds:settings.scrollRounds, grokEnabled:settings.grokEnabled, autoPublish:settings.autoPublish};
    audit.recentStages=[];
    const stage=name=>{audit.stage=name;audit.recentStages.push({stage:name,at:new Date().toISOString()});audit.recentStages=audit.recentStages.slice(-12);};
    stage('open-profile');
    executionAudits.set(job.id,audit);
    let tab;
    let followResult = job.followResult || {};
    let attemptedFollow = false;
    const evaluations = [...(job.evaluations || [])];
    async function guard() {
      if (!await control.canAct()) throw new Error('任务已暂停、账号变化或时间预算耗尽');
      const binding = await readBinding();
      if (tab) await waitForQueueViewer({read:()=>viewer(tab.id),expected:binding?.handle,wait,check:async()=>{if(!await control.canAct())throw new Error('任务已暂停、账号变化或时间预算耗尽');}});
    }
    try {
      tab = await createProfileTab(api,{url:`https://x.com/${encodeURIComponent(job.handle)}`, active:false},'follow-queue',{jobId:job.id,runId:control.runId});
      const loaded = await readQueueProfile({handle:job.handle,
        readDom:()=>script(tab.id,readProfileBundle,[job.handle,20]),
        readNetwork:()=>fetchProfile(tab.id,job.handle,{preferPageResponse:true}),guard,
        deadline:control.deadline,signal:control.signal});
      let profile=loaded.profile;
      if (['not_found','suspended'].includes(profile.status)) {
        await guard();
        return {state:'excluded',reason:profile.reason,followResult:{...followResult,reason:profile.reason,availability:profile.status,checkedAt:Date.now()}};
      }
      Object.assign(audit,{name:profile.name,posts:profile.posts || [],scanned:true});
      const storedProfile = {
        name: profile.name || '',
        bio: profile.bio || '',
        avatarUrl: profile.avatarUrl || '',
        followersText: profile.followersText || '',
        followingText: profile.followingText || '',
        blueVerified: profile.is_blue_verified === true || profile.isBlueVerified === true,
        verified: profile.verified === true
      };
      await control.checkpoint({profile: storedProfile});
      await guard();
      // Resolve authoritative User Rest ID from a user operation, never a tweet's ID.
      stage('resolve-user');
      const lookup = loaded.lookup || await fetchProfile(tab.id, job.handle,{preferPageResponse:true});
      await guard();
      const target = lookup.status === 200 && parseNetworkUsers(lookup.json).find(u => canonical(u.handle) === canonical(job.handle));
      if (lookup.status === 429) throw profileReadLimitError(lookup);
      if (lookup.status!==200 || lookup.error) return {state:'retry',reason:lookup.error || `用户资料请求返回 ${lookup.status}`};
      if (!target?.id) {await observeProfile(api,job.handle,{status:'identity_unresolved',reason:'无法解析目标用户 ID'},'queue-identity');return {state:'uncertain',reason:'身份待核实，已暂停自动请求'};}
      if (job.targetUserId && job.targetUserId !== target.id) return {state:'excluded',reason:'账号名称对应的用户 ID 已变化'};
      if (profile.pendingRequestUserId === target.id) {
        const reason='主页确认关注请求等待对方批准，跳过重复关注';
        return {state:'uncertain',reason,followResult:{...followResult,followRequestPending:true,targetUserId:target.id,reason,verifiedAt:Date.now()}};
      }
      if (target.relationship?.following === false && followResult.succeeded) {
        followResult = {...followResult, succeeded:false, following:false, verifiedAt:Date.now()};
      }
      stage('verify-relationship');
      const relationshipDecision = {...queueRelationshipDecision(job, target.relationship), checkedAt:Date.now(),
        targetUserId:target.id, source:lookup.source || 'profile-api'};
      audit.relationshipDecision = relationshipDecision;
      followResult = {...followResult, relationshipDecision};
      await control.checkpoint({followResult});
      if (followResult.followerRemoval?.attemptedAt) {
        const removed=target.relationship?.followedBy===false && target.relationship?.following===false;
        return {state:removed?'excluded':'uncertain',followResult:{...followResult,followerRemoval:{...followResult.followerRemoval,removed,verifiedAt:Date.now()}},reason:removed?'已核实移除此关注者，跳过回关':'移除关注者结果待核实，禁止自动重复提交'};
      }
      if (relationshipDecision.code === 'request-pending' || (target.protected === true && target.relationship?.following !== true && target.relationship?.followRequestSent !== false)) {
        const reason = relationshipDecision.code === 'request-pending' ? relationshipDecision.reason : '受保护账号的关注请求状态不明确，等待核实，未发送关注';
        return {state:'uncertain',reason,followResult:{...followResult,reason,followRequestPending:relationshipDecision.code === 'request-pending'}};
      }
      if (relationshipDecision.code === 'relationship-unknown') {
        return {state:'uncertain', reason:relationshipDecision.reason, followResult};
      }
      if (relationshipDecision.code === 'not-a-follower') return {state:'excluded',reason:relationshipDecision.reason,followResult};
      const merged = await store.enqueue({accountId:job.accountId,targetUserId:target.id,handle:job.handle,sources:job.sources});
      if (merged.importedHold?.state && !(merged.importedHold.state === 'followed' && target.relationship?.following === false)) {
        const holdState = merged.importedHold.state;
        const holdRes = merged.importedHold.followResult || {};
        return {
          state: holdState,
          followResult: holdState === 'followed'
            ? {...holdRes, ...followResult, succeeded:true, alreadyFollowing:true, targetUserId:target.id, at:Date.now()}
            : {...followResult, ...holdRes, targetUserId:target.id},
          evaluations: merged.evaluations || evaluations,
          reason: holdRes.reason || '命中历史去重记录'
        };
      }
      await guard();
      if (merged.id !== job.id) return {state:'excluded',reason:'相同用户已有队列记录'};
      const duplicates = typeof store.listByTarget === 'function'
        ? (await store.listByTarget({accountId:job.accountId, targetUserId:target.id})).filter(other => other.id !== job.id)
        : (await store.list({accountId:job.accountId})).filter(other => other.id !== job.id && other.targetUserId === target.id);
      if (duplicates.length) return {state:'uncertain',reason:'身份合并存在其他记录，需要核对'};
      if (target.relationship?.following === true || (target.relationship?.following !== false && profile.relationship?.following === true)) {
        return {state:'followed',followResult:{...followResult,succeeded:true,alreadyFollowing:true,targetUserId:target.id,at:Date.now()},evaluations};
      }
      if (relationshipDecision.code==='follow-back' && (await store.getSettings(job.accountId)).followBackAllowAll===true) {
        const ratio=followerRatioDecision(target);
        if(!ratio.known)return {state:'uncertain',reason:ratio.reason,followResult};
        if(ratio.remove){
          stage('remove-follower');
          const binding=await readBinding();
          const result=await removeFollower({api,tabId:tab.id,handle:job.handle,targetId:target.id,owner:binding.handle,wait,
            readProfile:async()=>{const response=await fetchProfile(tab.id,job.handle,{preferPageResponse:false});return response.status===200&&parseNetworkUsers(response.json).find(u=>canonical(u.handle)===canonical(job.handle));},
            canAct:async()=>{await guard();return (await store.getSettings(job.accountId)).followBackAllowAll===true;},
            checkpoint:async intent=>{followResult={...followResult,followerRemoval:intent};await control.checkpoint({stage:'remove-follower',followResult});}
          });
          followResult={...followResult,followerRemoval:{...followResult.followerRemoval,...result,live:undefined,policy:ratio,verifiedAt:Date.now()},
            relationshipDecision:{...relationshipDecision,allowAll:true,screening:'blocked',screeningReason:ratio.reason}};
          audit.relationshipDecision=followResult.relationshipDecision;
          await control.checkpoint({followResult});
          if(result.removed) {
            const patch={relationship:{...result.live.relationship,following:false,followedBy:false},state:'removed_follower',autoFollowState:'excluded',followerRemovedAt:new Date().toISOString()};
            if(records){const changes=[];for(const bucket of ['users','queue','followingUsers'])for(const row of await records.lookupAll({sourceKey:'monitor',bucket,handle:job.handle}))changes.push({handle:job.handle,sourceBucket:bucket,patch});if(changes.length)await records.batch({sourceKey:'monitor',changes});}
            else {const data=(await api.storage.local.get('monitor')).monitor;if(data){let changed=false;for(const bucket of ['users','queue','followingUsers'])if(Array.isArray(data[bucket]))data[bucket]=data[bucket].map(u=>canonical(u.handle)===canonical(job.handle)?(changed=true,{...u,...patch}):u);if(changed)await api.storage.local.set({monitor:data});}}
          }
          return {state:result.removed?'excluded':'uncertain',reason:result.removed?ratio.reason:result.reason,followResult};
        }
      }
      stage('read-posts');
      const observedPosts = new Map();
      const rememberPosts = bundle => {
        for (const post of bundle?.posts || []) {
          if (!post.isPinned && post.url && (observedPosts.has(post.url) || observedPosts.size < 20)) observedPosts.set(post.url,post);
        }
      };
      rememberPosts(profile);
      const dwell = randomizedSeconds(settings.dwellSeconds, settings.dwellJitter, 2, 60);
      for (let round=0; round<settings.scrollRounds; round++) {
        await guard();
        await script(tab.id,simulateProfileScrollStep,[round,420]);
        audit.scrollRounds = round + 1;
        await wait(dwell * 1000 / settings.scrollRounds);
        if (settings.grokEnabled) rememberPosts(await script(tab.id,readProfileBundle,[job.handle,20]));
      }
      const fresh = await script(tab.id,readProfileBundle,[job.handle,20]);
      if (fresh && !fresh.pending) profile = {...profile,...fresh};
      rememberPosts(profile);
      if (settings.grokEnabled) {
        let timeline;
        try {timeline=await readScoredPosts({api,tabId:tab.id,userId:target.id,handle:job.handle,guard});}
        catch(error){audit.postReadError=error.message;if(error.status===429)throw error;}
        if(timeline?.posts.length){profile.posts=timeline.posts;audit.postSelectionSource=timeline.source;audit.excludedPinnedPostIds=timeline.pinnedIds;}
        else {
        let unchanged=0;
        for (let round=0; observedPosts.size<20 && unchanged<2 && round<20; round++) {
          await guard();
          const previous=observedPosts.size;
          await script(tab.id,simulateProfileScrollStep,[round,700]);
          await wait(500);
          rememberPosts(await script(tab.id,readProfileBundle,[job.handle,20]));
          unchanged=previous===observedPosts.size ? unchanged+1 : 0;
        }
        profile.posts=[...observedPosts.values()];
        }
      }
      Object.assign(audit,{name:profile.name,posts:profile.posts || [],dwellSeconds:dwell});
      stage('save-profile');
      await saveProfile(job.handle, profile);
      const confirmedFollowBack = relationshipDecision.code === 'follow-back';
      const followBackAllowAll = confirmedFollowBack && (await store.getSettings(job.accountId)).followBackAllowAll === true;
      const reason = assessQueueProfile({...profile,...target,bio:profile.bio || target.bio},{...settings,followBackAllowAll},confirmedFollowBack);
      audit.relationshipDecision = {...relationshipDecision, allowAll:followBackAllowAll,
        screening:reason ? 'blocked' : 'allowed', screeningReason:reason || (confirmedFollowBack ? '待回关放行' : '普通筛选通过')};
      followResult = {...followResult, relationshipDecision:audit.relationshipDecision};
      if (reason) return {state:'skipped',reason,followResult};
      await guard();
      await control.checkpoint({stage:'following',followResult:{attemptedAt:Date.now(),targetUserId:target.id}});
      stage('following');
      attemptedFollow = true;
      const result = await performFollow(tab.id,{id:target.id,handle:job.handle});
      if (isAccountFollowLimit(result) || !(result.status >= 200 && result.status < 300)) {
        if (isAccountFollowLimit(result)) {
          return {state:'uncertain',followResult:{...followResult,attemptedAt:Date.now(),targetUserId:target.id,responseStatus:result.status,errorCode:161},
            rateLimited:true,accountFollowLimit:true,
            reason:`${ACCOUNT_FOLLOW_LIMIT_MESSAGE} 本轮停止；该账号的关注关系待核实。`};
        }
        if (result.status === 429) {
          return {state:'uncertain',followResult:{...followResult,attemptedAt:Date.now(),targetUserId:target.id,responseStatus:429},
            rateLimited:true,
            reason:'关注接口返回限流（HTTP 429），本轮停止；下轮按正常调度检查。该账号的关注关系待核实。'};
        }
        return {state:'uncertain',followResult:{...followResult,attemptedAt:Date.now(),targetUserId:target.id,followRequestPending:result.followRequestPending === true},reason:result.error || `关注返回 ${result.status}，需要核对实际关系`};
      }
      followResult = {...followResult,succeeded:true,alreadyFollowing:false,targetUserId:target.id,at:Date.now(),dwellSeconds:dwell};
      await control.checkpoint({stage:'followed',followResult});
      if (!settings.grokEnabled) return {state:'followed',followResult,evaluations};
      const recentPosts = (profile.posts || []).filter(p=>!p.isPinned).slice(0, 20).filter(p => {
        const match = String(p.url || '').match(/^https:\/\/(?:x\.com|twitter\.com)\/([^/]+)\/status\/\d+/);
        return match && canonical(match[1]) === canonical(job.handle) && String(p.text || '').length >= 8;
      });
      if (!recentPosts.length) return {state:'followed',followResult,evaluations,reason:'最近 20 条非置顶帖子没有可评价的原创正文'};
      const existingJobs = typeof store.hasPostEvaluation === 'function' ? null : await store.list({accountId:job.accountId});
      const eligiblePosts = [];
      for (const post of recentPosts) {
        const postId = post.url.match(/\/status\/(\d+)/)[1];
        const alreadyQueued = typeof store.hasPostEvaluation === 'function'
          ? await store.hasPostEvaluation({accountId:job.accountId, postId})
          : existingJobs.some(other => other.evaluations?.some(e => e.originalPostId === postId));
        if (!alreadyQueued) eligiblePosts.push(post);
      }
      if (!eligiblePosts.length) return {state:'followed',followResult,evaluations,reason:'最近 20 条非置顶帖子均已有评价记录'};
      // Only persist intent here: comments have their own worker and deadline.
      const post = highestScoredPost(quoteCandidates(job.handle,eligiblePosts,profile.name,profile).candidates);
      if (!post) return {state:'followed',followResult,evaluations,reason:'没有可按综合互动分确定的合格原帖，未调用 Grok'};
      const originalPostId = post.url.match(/\/status\/(\d+)/)[1];
      const sampled = await store.ensureQuoteDecision({accountId:job.accountId,id:job.id,rate:settings.quoteParticipationRate ?? 60});
      if (!sampled.ok) throw new Error('引用抽样结果未能保存，已停止引用流程');
      const quoteDecision = sampled.decision;
      const creationForm=modeLabel(settings.publicationMode);
      evaluations.push({taskId:job.accountId+':'+originalPostId, followJobId:job.id,
        targetUserId:target.id, originalAuthorId:target.id, originalPostId,
        originalPostUrl:post.url, originalPostText:post.text,
        automaticComment:true, candidatePosts:[post],quoteDecision,grokCalls:0,publicationMode:settings.publicationMode || 'quote',
        status:quoteDecision.selected ? 'pending' : 'skipped',reasonCode:quoteDecision.selected ? 'probability_selected' : 'probability_skip',
        reason:quoteDecision.selected ? `已抽中${creationForm}（概率 ${quoteDecision.rate}%），等待生成评价` : `未抽中${creationForm}（概率 ${quoteDecision.rate}%），未调用 Grok`});
      return {state:'followed',followResult,evaluations};
    } catch (error) {
      if(error.code==='QUEUE_BUDGET_EXHAUSTED' || (control.signal.aborted && Date.now()>=control.deadline)) return {state:followResult.succeeded?'followed':attemptedFollow?'uncertain':'retry',budgetExhausted:true,followResult,evaluations,reason:'本轮时间已用完，留待下轮继续'};
      if(error.code==='X_PROFILE_IDENTITY_UNRESOLVED'&&!attemptedFollow&&!followResult.succeeded)return {state:'uncertain',reason:error.message,followResult:{...followResult,reason:error.message}};
      if(error.code==='X_PROFILE_UNAVAILABLE'&&!attemptedFollow&&!followResult.succeeded)return {state:'excluded',reason:error.message,followResult:{...followResult,availability:error.availability,reason:error.message,checkedAt:Date.now()}};
      const failure=await diagnostics.record(error,{deferLog:true,stage:audit.stage,manual:control.manual,accountId:job.accountId,targetUserId:job.targetUserId,retryCount:job.followResult?.retryCount,settings,jobId:job.id,runId:control.runId,handle:job.handle,requestedUrl:`https://x.com/${encodeURIComponent(job.handle)}`,tabId:tab?.id,recentStages:audit.recentStages,followAttempted:attemptedFollow,followSucceeded:followResult.succeeded});
      if(runFailures)runFailures.push(failure);
      audit.diagnostic=failure.diagnostic;
      const profileReadLimited = error.code === 'X_PROFILE_READ_LIMIT' && !attemptedFollow;
      return {state:followResult.succeeded ? 'followed' : attemptedFollow ? 'uncertain' : 'retry',followResult,evaluations,
        rateLimited:profileReadLimited,profileReadLimited,diagnostic:failure.diagnostic,reason:failure.message};
    } finally { audit.finishedAt = new Date().toISOString(); audit.evaluations = structuredClone(evaluations); if (tab) await api.tabs.remove(tab.id).catch(() => {}); }
  }
  let reflectJobs = null,runFailures=null,runPromise=null;
  const scheduler = createFollowQueueScheduler({store,execute,canRun,getBlockReason:()=>runBlockReason,onEvent:async event => {
    const job = event.jobId ? await readJob(event.accountId, event.jobId) || {} : {};
    if (reflectJobs && (event.type === 'job-complete' || event.state === 'followed') && (event.state === 'followed' || event.followResult?.succeeded)) {
      reflectJobs.push({handle:event.handle || job.handle, followResult:event.followResult || job.followResult, updatedAt:event.at || job.updatedAt});
    }
    if (event.type === 'job-start') executionAudits.delete(event.jobId);
    const audit = executionAudits.get(event.jobId) || {};
    await appendExecutionLog(normalizeQueueExecutionLog(event,job,audit),api.storage.local);
    if (event.type === 'job-complete' || event.type === 'job-settle-failed') executionAudits.delete(event.jobId);
  }});
  async function reflectFollowed(accountId, jobs) {
    const followedJobs = Array.isArray(jobs) ? jobs : (!records && typeof store.listByState === 'function'
      ? await store.listByState({accountId, state:'followed'})
      : (!records ? (await store.list({accountId})).filter(job => job.state === 'followed') : []));
    const followed = new Map(followedJobs.map(job=>[canonical(job.handle),job]));
    if (!followed.size) return;
    if (records) {
      const groups = {monitor:[], mutualNetwork:[], commentTracking:[]};
      const buckets = {monitor:['users','queue','followingUsers'], mutualNetwork:['users'], commentTracking:['users']};
      for (const [handle, job] of followed) {
        for (const [sourceKey, names] of Object.entries(buckets)) {
          for (const bucket of names) {
            const rows = await records.lookupAll({sourceKey, bucket, handle});
            for (const row of rows) {
              if (row.payload?.relationship?.following === true) continue;
              groups[sourceKey].push({handle, sourceBucket:bucket, patch:{
                relationship:{...(row.payload?.relationship || {}), following:true},
                followingObservedAt:job.followResult?.at || job.followResult?.verifiedAt || job.updatedAt,
                state:'following', autoFollowState:'followed',
                followedAt:row.payload?.followedAt || new Date(job.followResult?.at || job.updatedAt).toISOString()
              }});
            }
          }
        }
      }
      for (const [sourceKey, changes] of Object.entries(groups)) {
        if (changes.length) await records.batch({sourceKey, changes});
      }
      return;
    }
    const data = await api.storage.local.get(['monitor','mutualNetwork','commentTracking']);
    const changed = {};
    for (const key of ['monitor','mutualNetwork','commentTracking']) {
      const record = data[key];
      if (!record?.users) continue;
      let dirty = false;
      const users = record.users.map(user=>{
        const job = followed.get(canonical(user.handle));
        if (!job || user.relationship?.following === true) return user;
        dirty = true;
        return {...user,relationship:{...user.relationship,following:true},state:'following',autoFollowState:'followed',
          followedAt:user.followedAt || new Date(job.followResult?.at || job.updatedAt).toISOString()};
      });
      if (dirty) changed[key] = {...record,users};
    }
    if (Object.keys(changed).length) await writeLocal(changed);
  }
  async function withVerifiedXTab(binding, work) {
    const tabs = await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    let temporary;
    try {
      let targetTab = null;
      for (const tab of tabs) {
        const handle = await viewer(tab.id).catch(() => '');
        if (handle && handle === canonical(binding.handle)) { targetTab = tab; break; }
      }
      if (!targetTab) {
        temporary = await createProfileTab(api,{url:'https://x.com/home',active:false},'follow-queue');
        for (let i=0;i<20;i++) {
          const handle = await viewer(temporary.id).catch(() => '');
          if (handle) {
            if (handle !== canonical(binding.handle)) throw new Error('当前 X 登录账号与队列绑定账号不一致');
            targetTab = temporary;
            break;
          }
          await sleep(500);
        }
      }
      if (!targetTab) throw new Error('无法打开已登录的 X 页面进行核实');
      return await work(targetTab);
    } finally {
      if (temporary) await api.tabs.remove(temporary.id).catch(() => {});
    }
  }
  async function verifyUncertain(binding, {jobId, mode = 'check'} = {}) {
    const job = await readJob(binding.accountId, jobId);
    if (!job) throw new Error('未找到对应的待核实任务');
    if (job.state !== 'uncertain') throw new Error('仅结果待核实的任务支持人工核验恢复');
    if (mode === 'exclude') {
      const resolved = await store.resolveJob({
        accountId:binding.accountId,
        id:job.id,
        state:'excluded',
        stage:'excluded',
        followResult:{...(job.followResult || {}), reason:'人工核实排除', verifiedAt:Date.now()}
      });
      if (!resolved?.ok) throw new Error(resolved?.reason === 'leased' ? '任务正在执行中，请稍后操作' : '排除任务失败');
      await safeLog({scope:'queue',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),result:'excluded',detail:`人工排除待核实任务 @${job.handle}`});
      return {ok:true,resolvedState:'excluded',job:resolved.job,summary:`已排除 @${job.handle}`};
    }
    return withVerifiedXTab(binding, async tab => {
      const target = typeof fetchUser === 'function'
        ? await fetchUser(tab.id, job.handle)
        : await (async () => {
            const lookup = await networkGetUserProfile(tab.id, job.handle);
            return lookup.status === 200 && parseNetworkUsers(lookup.json).find(u => canonical(u.handle) === canonical(job.handle));
          })();
      if (!target?.id) throw new Error(`无法读取 @${job.handle} 的最新关注关系，请稍后重试`);
      if (job.targetUserId && job.targetUserId !== target.id) {
        const excluded = await store.resolveJob({
          accountId:binding.accountId,
          id:job.id,
          state:'excluded',
          stage:'excluded',
          followResult:{...(job.followResult || {}), reason:'账号名称对应的用户 ID 已变化', verifiedAt:Date.now()}
        });
        return {ok:true,resolvedState:'excluded',job:excluded.job,summary:`@${job.handle} 的用户 ID 已变化，已排除`};
      }
      if (!job.targetUserId) {
        await store.enqueue({accountId:binding.accountId,targetUserId:target.id,handle:job.handle,sources:job.sources});
      }
      if (target.relationship?.following === true && target.relationship?.followRequestSent !== true) {
        const resolved = await store.resolveJob({
          accountId:binding.accountId,
          id:job.id,
          state:'followed',
          stage:'followed',
          followResult:{...(job.followResult || {}), succeeded:true, following:true, alreadyFollowing:true, targetUserId:target.id, verifiedAt:Date.now(), reason:'核实确认已关注'}
        });
        if (!resolved?.ok) throw new Error('更新任务关注状态失败');
        await reflectFollowed(binding.accountId, [{handle:job.handle, followResult:job.followResult, updatedAt:job.updatedAt}]);
        await safeLog({scope:'queue',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),result:'followed',detail:`核实确认 @${job.handle} 已关注，已同步状态`});
        return {ok:true,resolvedState:'followed',job:resolved.job,summary:`已核实 @${job.handle} 处于已关注状态`};
      }
      const relationshipDecision = {...queueRelationshipDecision(job, target.relationship), checkedAt:Date.now(), targetUserId:target.id, source:'manual-verification'};
      if (relationshipDecision.code === 'request-pending' || ((target.protected === true || job.followResult?.followRequestPending === true || job.followResult?.attemptedAt) && target.relationship?.followRequestSent !== false)) {
        const reason = relationshipDecision.code === 'request-pending' ? relationshipDecision.reason : '关注请求状态不明确，继续等待核实，避免重复提交';
        const resolved = await store.resolveJob({accountId:binding.accountId,id:job.id,state:'uncertain',stage:'uncertain',followResult:{...(job.followResult || {}),relationshipDecision,followRequestPending:relationshipDecision.code === 'request-pending',reason,verifiedAt:Date.now()}});
        if (!resolved?.ok) throw new Error('更新任务状态失败');
        return {ok:true,resolvedState:'uncertain',job:resolved.job,summary:reason};
      }
      if (relationshipDecision.code === 'relationship-unknown') throw new Error(relationshipDecision.reason);
      const reopened = await store.resolveJob({
        accountId:binding.accountId,
        id:job.id,
        state:'pending',
        stage:'queued',
        nextEligibleAt:Date.now(),
        followResult:{targetUserId:target.id, following:false, verifiedAt:Date.now(), relationshipDecision, reason:'核实确认未关注，恢复待关注'}
      });
      if (!reopened?.ok) throw new Error('恢复待关注状态失败');
      await safeLog({scope:'queue',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),result:'pending',detail:`核实确认 @${job.handle} 未关注，已恢复为待关注`});
      return {ok:true,resolvedState:'pending',job:reopened.job,summary:`已核实 @${job.handle} 尚未关注，已恢复待关注`};
    });
  }
  async function reconcileFan(binding, {handle, inspectOnly = false, signal} = {}) {
    signal?.throwIfAborted();
    const key = canonical(handle);
    if (!key || !/^[a-z0-9_]{1,15}$/.test(key)) throw new Error('无效粉丝账号');
    if (!inspectOnly && binding.sources?.fans !== true) throw new Error('粉丝来源未启用');
    if (!records) throw new Error('粉丝档案不可用');
    const queueRows = await records.lookupAll({sourceKey:'monitor', bucket:'queue', handle:key});
    let allRows = inspectOnly ? (await Promise.all(['users','queue','followingUsers'].map(bucket => records.lookupAll({sourceKey:'monitor',bucket,handle:key})))).flat() : queueRows;
    signal?.throwIfAborted();
    if (!allRows.length) throw new Error('粉丝档案不存在');
    return withVerifiedXTab(binding, async tab => {
      signal?.throwIfAborted();
      const target = typeof fetchUser === 'function'
        ? await fetchUser(tab.id, key)
        : await (async () => {
            const lookup = await networkGetUserProfile(tab.id, key);
            if (lookup.status === 429) throw profileReadLimitError(lookup);
            if (lookup.status !== 200) {
              const error=new Error(lookup.error || `关系读取失败 HTTP ${lookup.status}`);
              error.status=lookup.status;error.code='FAN_INSPECTION_NETWORK';throw error;
            }
            return lookup.status === 200
              ? parseNetworkUsers(lookup.json).find(user => canonical(user.handle) === key) : null;
          })();
      signal?.throwIfAborted();
      if (!target?.id || target.relationshipKnown !== true
        || typeof target.relationship.followedBy !== 'boolean'
        || typeof target.relationship.following !== 'boolean') {
        if(inspectOnly && target?.id) {
          await records.batch({sourceKey:'monitor',changes:allRows.map(row=>({handle:key,sourceBucket:row.sourcePath?.[1] || 'queue',patch:{
            relationship:{following:null,followedBy:null},relationshipKnown:false,state:'unknown',status:'unknown',relationshipVerifiedAt:new Date().toISOString()
          }}))});
          const pending=await priorByHandle(binding.accountId,key);
          signal?.throwIfAborted();
          if(pending && ['pending','retry'].includes(pending.state)) await store.resolveJob({accountId:binding.accountId,id:pending.id,state:'uncertain',stage:'uncertain',
            followResult:{...(pending.followResult || {}),reason:'X 关系字段不完整或相互冲突，暂停粉丝回关任务'}});
        }
        throw new Error(`无法核实 @${key} 的完整关注关系`);
      }
      const mismatched = allRows.filter(row => row.payload?.id && String(row.payload.id) !== target.id);
      if (inspectOnly && mismatched.length) {
        const moves = [];
        for (const row of mismatched) {
          const oldId = String(row.payload.id);
          const sameId = await records.lookupAll({sourceKey:'monitor',tweetId:oldId});
          const candidates = [...new Set(sameId.filter(other => other.accountId === row.accountId && String(other.payload?.id) === oldId)
            .map(other => canonical(other.payload?.handle || other.handle)).filter(handle => handle && handle !== key))];
          if (candidates.length !== 1) break;
          const candidate = candidates[0];
          const lookup = typeof fetchUser === 'function' ? await fetchUser(tab.id,candidate) : await (async()=>{
            const response=await networkGetUserProfile(tab.id,candidate);
            return response.status===200 ? parseNetworkUsers(response.json).find(user=>canonical(user.handle)===candidate) : null;
          })();
          signal?.throwIfAborted();
          if (!lookup || String(lookup.id) !== oldId || canonical(lookup.handle) !== candidate) break;
          moves.push({accountId:row.accountId,userKey:row.userKey,sourceBucket:row.sourcePath?.[1],handle:key,
            patch:{handle:lookup.handle,previousHandles:[...new Set([...(Array.isArray(row.payload.previousHandles) ? row.payload.previousHandles : []),row.payload.handle].filter(Boolean))]}});
        }
        if (allRows.some(row=>String(row.payload?.id || '') === String(target.id)) && moves.length === mismatched.length && moves.every(move=>move.userKey && move.accountId)) {
          const currentRows = allRows.filter(row=>!mismatched.includes(row));
          await records.batch({sourceKey:'monitor',changes:currentRows.map(row=>({accountId:row.accountId,userKey:row.userKey,sourceBucket:row.sourcePath?.[1],handle:key,patch:{legacyHandleIdentityConflict:true}}))});
          await records.batch({sourceKey:'monitor',changes:moves});
          allRows = currentRows;
        }
      }
      if (allRows.some(row => row.payload?.id && String(row.payload.id) !== target.id)) {
        await records.batch({sourceKey:'monitor',changes:queueRows.map(row=>({handle:key,sourceBucket:'queue',patch:{
          status:'identity_mismatch',state:'identity_mismatch',relationshipKnown:false,
          relationshipVerifiedAt:new Date().toISOString()
        }}))});
        return {ok:true,handle:key,jobState:'identity-mismatch'};
      }
      let job = await priorByHandle(binding.accountId, key);
      // A historical handle-only job may belong to the former owner. Preserve it
      // without promoting or reconciling it to the newly verified user.
      if (inspectOnly && job && !job.targetUserId && (mismatched.length || allRows.some(row=>row.payload?.legacyHandleIdentityConflict))) job=null;
      signal?.throwIfAborted();
      if (inspectOnly && job?.state === 'running') throw new Error(`@${key} 正在由关注队列处理，请稍后核验`);
      if (job?.targetUserId && job.targetUserId !== target.id) throw new Error(`@${key} 的队列用户 ID 不一致`);
      if (inspectOnly && job && typeof store.enqueue === 'function') {
        // Verified identity lets the existing store merge a legacy handle job
        // with its Rest ID job, retaining sources, evaluations and outcomes.
        job = await store.enqueue({accountId:binding.accountId,targetUserId:target.id,handle:key,sources:job.sources || [],
          followBackCandidate:target.relationship.followedBy===true && target.relationship.following===false});
        signal?.throwIfAborted();
        if (job.state === 'running') throw new Error(`@${key} 正在由关注队列处理，请稍后核验`);
      }
      const following = target.relationship.following;
      const followedBy = target.relationship.followedBy;
      const stamp = Date.now();
      let result = 'unchanged';
      if (following && job && job.state !== 'followed') {
        const resolved = await store.resolveJob({accountId:binding.accountId,id:job.id,state:'followed',stage:'followed',
          followResult:{...(job.followResult || {}),succeeded:true,following:true,alreadyFollowing:true,targetUserId:target.id,verifiedAt:stamp,reason:'X 关系核实已关注'}});
        if (!resolved?.ok) throw new Error(`更新 @${key} 队列状态失败`);
        result = 'already-following';
      } else if (inspectOnly && !following && job?.state === 'followed') {
        const resolved = await store.resolveJob({accountId:binding.accountId,id:job.id,state:'uncertain',stage:'uncertain',
          followResult:{...(job.followResult || {}),succeeded:false,following:false,verifiedAt:stamp,reason:'历史关注结果与当前关系不一致，等待人工核对，不自动重复关注'}});
        if (!resolved?.ok) throw new Error(`更新 @${key} 队列状态失败`);
        result = 'uncertain';
      } else if (inspectOnly && !following && !followedBy && job && ['pending','retry','skipped'].includes(job.state)
        && job.sources?.some(source=>source.enabled && source.module==='fans')
        && !job.sources.some(source=>source.enabled && source.module!=='fans')) {
        const resolved=await store.resolveJob({accountId:binding.accountId,id:job.id,state:'excluded',stage:'excluded',
          followResult:{...(job.followResult || {}),following:false,verifiedAt:stamp,reason:'对方已未关注你，退出粉丝回关队列',relationshipDecision:{code:'not-a-follower',following:false,followedBy:false,checkedAt:stamp}}});
        if(!resolved?.ok)throw new Error(`更新 @${key} 队列状态失败`);
        result='excluded';
      } else if (!inspectOnly && followedBy && !following && job?.state === 'skipped'
        && /^关注\/粉丝比例低于 \d+%$/.test(String(job.followResult?.reason || ''))) {
        const resolved = await store.resolveJob({accountId:binding.accountId,id:job.id,state:'pending',stage:'queued',nextEligibleAt:stamp,
          followResult:{targetUserId:target.id,verifiedAt:stamp,reason:'X 关系核实待回关，恢复比例门槛跳过任务'}});
        if (!resolved?.ok) throw new Error(`恢复 @${key} 待回关任务失败`);
        result = 'reopened';
      }
      const changes = allRows.map(row => ({handle:key,sourceBucket:row.sourcePath?.[1] || 'queue',patch:{
        relationship:{...(row.payload?.relationship || {}),following,followedBy},relationshipKnown:true,
        status:following ? 'followed' : followedBy ? 'pending' : 'no_longer_following',
        state:following ? 'following' : followedBy ? 'follow_back' : 'no_longer_following',
        relationshipVerifiedAt:new Date(stamp).toISOString()
      }}));
      signal?.throwIfAborted();
      await records.batch({sourceKey:'monitor',changes});
      signal?.throwIfAborted();
      if (following && job) await reflectFollowed(binding.accountId,[{...job,followResult:{...(job.followResult || {}),at:stamp},updatedAt:stamp}]);
      return {ok:true,handle:key,relationship:{followedBy,following},jobState:result};
    });
  }
  const fanInspectionBatch=createFanInspectionBatch({storage:api.storage.local,binding:readBinding,
    targets:request=>records.fanInspectionTargets(request),inspect:(handle,{signal}={})=>readBinding().then(binding=>reconcileFan(binding,{handle,inspectOnly:true,signal}))});
  const commentLocks = new Set();
  async function retryEvaluation(binding, options = {}) {
    const key = binding.accountId+':'+options.jobId;
    if (commentLocks.has(key)) return {ok:false, error:'评论任务正在执行'};
    commentLocks.add(key);
    const controller = new AbortController();
    const timer = options.signal ? null : setTimeout(()=>controller.abort(),COMMENT_TASK_TIMEOUT_MS);
    try { return await performEvaluation(binding, {...options,signal:options.signal || controller.signal}); }
    finally { clearTimeout(timer); commentLocks.delete(key); }
  }
  async function performEvaluation(binding, {jobId, taskId, publish = false, verifyOnly = false, signal, automatic = false} = {}) {
    let tab;
    const progress=label=>{
      try{api.runtime?.sendMessage?.({cmd:'followQueueEvaluationProgress',accountId:binding.accountId,jobId,taskId,label})?.catch(()=>{});}catch{}
    };
    async function guardComment() {
      if (signal?.aborted) throw new Error('评论任务超时，关注结果不受影响');
      const current = await readBinding();
      if (current?.accountId !== binding.accountId) throw new Error('评论绑定账号已变化');
      if (tab) await waitForQueueViewer({read:()=>viewer(tab.id),expected:binding.handle,wait,check:async()=>{
        if(signal?.aborted)throw new Error('评论任务超时，关注结果不受影响');
        if((await readBinding())?.accountId!==binding.accountId)throw new Error('评论绑定账号已变化');
      }});
      const latest = await readJob(binding.accountId, jobId);
      if (!latest || latest.state !== 'followed') throw new Error('评论对应的关注记录已移除或变化');
      if (automatic) {
        const settings = await store.getSettings(binding.accountId);
        if (!settings.grokEnabled || settings.quoteParticipationRate === 0) throw new Error('自动生成已暂停，未继续生成或提交');
      }
      if (signal?.aborted) throw new Error('评论任务超时，关注结果不受影响');
    }
    await guardComment();
    const job = await readJob(binding.accountId, jobId);
    if (!job) throw new Error('未找到对应的队列任务');
    if (job.state !== 'followed') throw new Error('仅已关注成功的任务支持独立重试引用评价，禁止回退关注步骤');
    const existingEvals = Array.isArray(job.evaluations) ? job.evaluations : [];
    const targetEval = (taskId ? existingEvals.find(e => e.taskId === taskId) : existingEvals[0]) || null;
    let publicationMode=targetEval?.publicationMode || 'quote';
    let form=modeLabel(publicationMode);
    if (targetEval && (targetEval.status === 'posted' || targetEval.status === 'published')) {
      return {ok:true,job,evaluation:targetEval,summary:'该引用评价已发布，无需重复执行'};
    }
    // Generation has no publishing side effect. A manual check can finish this
    // stage without replaying the paid request or clearing its audit evidence.
    if (!automatic && targetEval && !targetEval.text && (verifyOnly || targetEval.status === 'uncertain') && !(targetEval.relayJobId && targetEval.reasonCode==='bot_pending' && !targetEval.publishedAttemptedAt && !targetEval.publishedPostId && !targetEval.publishedPostUrl && !targetEval.articleDraftUrl)) {
      const ev = {...targetEval};
      const publicationEvidence = ev.publishedAttemptedAt || ev.publishedPostId || ev.publishedPostUrl
        || ev.articleDraftUrl || (Array.isArray(ev.attempts) && ev.attempts.some(a=>/publish|发布/i.test(String(a?.stage || ''))));
      const generationOnly = ev.generationAttemptedAt && ['generation_uncertain','generation_started','generation_retry_ready'].includes(ev.reasonCode);
      if (generationOnly && !publicationEvidence) {
        if (ev.reasonCode === 'generation_retry_ready') return {ok:true,job,evaluation:ev,summary:ev.reason};
        const {recoveryHistory: priorHistory, ...snapshot} = ev;
        ev.recoveryHistory = [...(priorHistory || []), {
          id:`generation:${ev.generationAttemptedAt}`, at:Date.now(), action:'generation-retry-ready',
          basis:'generation-checkpoint-without-publication', evaluation:snapshot
        }];
        ev.status = 'failed'; ev.reasonCode = 'generation_retry_ready'; ev.recoveryDraftOnly = true;
        ev.reason = '生成结果未保存，已确认尚未进入发布；可重新生成，完成后先保留草稿';
        const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        if (!saved.ok) throw new Error('恢复状态未保存，请重试核对；未重新生成或发布');
        await safeLog({scope:'comment',accountId:binding.accountId,jobId:job.id,handle:job.handle,
          at:new Date().toISOString(),result:'generation-retry-ready',detail:ev.reason});
        return {ok:true,job:saved.job,evaluation:ev,summary:ev.reason};
      }
      const reason = publicationEvidence
        ? '存在发布记录但缺少核对正文，请从溯源详情核对原发布结果；未重新生成或发布'
        : '缺少可确认的生成阶段记录，请从溯源详情核对历史；未重新生成或发布';
      return {ok:false,error:reason,job,evaluation:ev};
    }
    try {
      progress('正在核验登录账号…');
      tab = await createProfileTab(api,{url:`https://x.com/${encodeURIComponent(binding.handle)}`,active:false},'follow-queue');
      await guardComment();
      let ev = targetEval ? {...targetEval} : null;
      const hadPinnedEvaluation = Boolean(ev?.originalPostUrl);
      // Step 1: If uncertain or draft, verify on viewer's profile page first before any re-publish
      if (ev?.text) {
        ev.originalPostId ||= ev.originalPostUrl?.match(/\/status\/(\d+)/)?.[1] || '';
        if (!ev.originalPostId && ['quote','reply'].includes(publicationMode)) {
          return {ok:false,error:'缺少原帖标识，无法核对发布结果；未重复发布',evaluation:ev,job};
        }
        progress('正在核对是否已发布…');
        const proof = publicationMode==='article'
          ? (ev.article?await articles.verify({owner:binding.handle,article:ev.article,after:ev.publishedAttemptedAt||0}):null)
          : publicationMode==='reply' ? await replies.verify({owner:binding.handle,sourcePostUrl:ev.originalPostUrl,text:ev.text,after:ev.publishedAttemptedAt||0})
          : publicationMode==='original'
          ? await publishing.verify({owner:binding.handle,text:ev.text,after:ev.publishedAttemptedAt || ev.generationAttemptedAt || 0})
          : await confirmPublishedQueueQuote({api,tabId:tab.id,handle:binding.handle,originalId:ev.originalPostId,text:ev.text,after:0});
        if (proof) {
          ev = {...ev, status:'posted', publishedPostId:proof.id, publishedPostUrl:proof.url, reason:''};
          const saved = await store.resolveJob({accountId:binding.accountId, id:job.id, evaluations:[ev]});
          await safeLog({scope:'comment', accountId:binding.accountId, jobId:job.id, handle:job.handle, at:new Date().toISOString(), result:'posted', detail:`主页核实 ${form} 已发布`});
          return {ok:true, job:saved.job, evaluation:ev, summary:`主页已确认${form}发布成功`};
        }
        if (ev.status === 'uncertain') {
          ev = {...ev, status:'uncertain', reason:`主页暂未确认${form}已发布；结果仍待核实，未重复提交`};
          await store.resolveJob({accountId:binding.accountId, id:job.id, evaluations:[ev]});
          return {ok:true, job:job, evaluation:ev, summary:ev.reason};
        }
      }
      // Step 2: Locate post if needed
      const cachedProfile = records
        ? ((await records.lookup({module:'profiles', handle:canonical(job.handle)}))?.payload || {})
        : ((await api.storage.local.get('profileCache')).profileCache || {})[canonical(job.handle)] || {};
      let cachedPosts = cachedProfile.posts || [];
      let post = ev?.originalPostUrl
        ? (cachedPosts.find(p => p.url === ev.originalPostUrl) || {url:ev.originalPostUrl,text:ev.originalPostText || ''})
        : cachedPosts.find(p => {
            const match = String(p.url || '').match(/^https:\/\/(?:x\.com|twitter\.com)\/([^/]+)\/status\/\d+/);
            return match && canonical(match[1]) === canonical(job.handle) && String(p.text || '').length >= 8;
          });
      if (!post || (!post.text && !ev?.text)) {
        await updateProfileTab(api,tab.id,{url:`https://x.com/${encodeURIComponent(job.handle)}`},'follow-queue');
        for (let i=0;i<20;i++) {
          const bundle = await script(tab.id,readProfileBundle,[job.handle,20]).catch(() => null);
          if (bundle && !bundle.pending && Array.isArray(bundle.posts) && bundle.posts.some(item => /^https:\/\/(?:x\.com|twitter\.com)\/[a-zA-Z0-9_]+\/status\/\d+/.test(String(item?.url || '')) && String(item?.text || '').trim().length >= 8)) {
            cachedPosts = bundle.posts;
            const saved = await saveProfile(job.handle, bundle);
            cachedPosts = saved.posts || bundle.posts;
            break;
          }
          await sleep(500);
        }
        post = (ev?.originalPostUrl && cachedPosts.find(p => p.url === ev.originalPostUrl)) || cachedPosts.find(p => {
          const match = String(p.url || '').match(/^https:\/\/(?:x\.com|twitter\.com)\/([^/]+)\/status\/\d+/);
          return match && canonical(match[1]) === canonical(job.handle) && String(p.text || '').length >= 8;
        }) || post;
      }
      if (!post?.url) throw new Error('未找到可引用评价的原帖');
      const safetyProfile = {
        handle: job.handle,
        name: cachedProfile.name || job.profile?.name || '',
        bio: cachedProfile.bio || job.profile?.bio || '',
        posts: [...cachedPosts, post],
        grokRiskAssessment: cachedProfile.grokRiskAssessment || job.profile?.grokRiskAssessment
      };
      const safetyRisk = riskAssess(safetyProfile);
      const interactionReason = interactionSkipReason(safetyProfile);
      let originalPostId = ev?.originalPostId || post.url.match(/\/status\/(\d+)/)?.[1] || '';
      if (!originalPostId) throw new Error('原帖链接缺少有效推文 ID');
      const prevAttempts = Array.isArray(ev?.attempts) ? ev.attempts.length : (Number(ev?.attempts) || 0);
      ev = {
        ...ev,
        publicationMode,
        taskId: ev?.taskId || `${binding.accountId}:${originalPostId}`,
        followJobId: job.id,
        targetUserId: job.targetUserId || '',
        originalAuthorId: ev?.originalAuthorId || job.targetUserId || '',
        originalPostId,
        originalPostUrl: post.url,
        originalPostText: post.text || ev?.originalPostText || '',
        text: ev?.text || '',
        baseText: ev?.baseText || '',
        language: ev?.language || '',
        channel: ev?.channel || '',
        status: ev?.status || 'generating',
        publishedPostId: ev?.publishedPostId || '',
        publishedPostUrl: ev?.publishedPostUrl || '',
        reason: '',
        attempts: prevAttempts + 1
      };
      if (interactionReason) {
        ev.status = 'skipped';
        ev.reason = interactionReason;
        const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        return {ok:true,summary:interactionReason,job:saved.job,evaluation:ev};
      }
      if (safetyRisk.level === 'danger') {
        throw new Error(`目标账号命中高风险内容门禁：${safetyRisk.hits.slice(0, 2).join('、')}`);
      }
      await guardComment();
      const commentSettings = await store.getSettings(binding.accountId);
      if(!targetEval){publicationMode=commentSettings.publicationMode || 'quote';ev.publicationMode=publicationMode;form=modeLabel(publicationMode);}
      // Local gates and comment-count selection run before the writing request.
      // Reuse existing draft text if available; only call Grok when draft text is empty
      if (!ev.text) {
        if (ev.generationAttemptedAt && !['quota_not_sent','quality_skip',...(!automatic ? ['generation_retry_ready'] : [])].includes(ev.reasonCode) && !ev.relayJobId) {
          ev.status = 'uncertain'; ev.reason = '上次 Grok 请求结果待核实，未重复调用';
          const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          return {ok:true,job:saved.job,evaluation:ev,summary:ev.reason};
        }
        const initialCandidates = (targetEval?.automaticComment || targetEval?.relayJobId) && targetEval.candidatePosts?.length
          ? targetEval.candidatePosts : hadPinnedEvaluation ? post : cachedPosts.filter(p=>!p.isPinned).slice(0, 20);
        const selection = quoteCandidates(job.handle,initialCandidates,safetyProfile.name,safetyProfile);
        const fixedPost = highestScoredPost(selection.candidates);
        if (!fixedPost) {
          ev.status='skipped';ev.reasonCode='engagement_metrics_unknown';ev.grokCalls=0;
          ev.reason=selection.interactionReason || '没有可按综合互动分确定的合格原帖，未调用 Grok';
          const saved=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          return {ok:true,job:saved.job,evaluation:ev,summary:ev.reason};
        }
        // Persist the source before generation. Retries keep the same decision.
        Object.assign(ev,{candidatePosts:[fixedPost],originalPostId:fixedPost.url.match(/\/status\/(\d+)/)[1],originalPostUrl:fixedPost.url,originalPostText:fixedPost.text});
        const candidates=[];
        for (const [candidateIndex,candidate] of [fixedPost].entries()) {
          progress(`正在读取原帖 ${candidateIndex+1}…`);
          if (quoteInputComplete(candidate)) { candidates.push(candidate); continue; }
          await guardComment();
          const url=String(candidate?.url || '');
          if (!/^https:\/\/(?:x\.com|twitter\.com)\/[a-zA-Z0-9_]+\/status\/\d+(?:[/?#]|$)/.test(url)) continue;
          await updateProfileTab(api,tab.id,{url},'follow-queue');
          let full;
          for (let i=0;i<12;i++) {
            await guardComment();
            full=await script(tab.id,readQuoteSourceOnPage,[url]);
            if (full) break;
            await sleep(500);
          }
          if (full?.textComplete) candidates.push({...candidate,...full});
        }
        if (!candidates.length) {
          ev.status='skipped';ev.reasonCode='context_incomplete';ev.grokCalls=0;
          ev.reason='未能获取完整原创正文，未调用 Grok';
          const saved=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          await safeLog({scope:'comment',accountId:binding.accountId,jobId:job.id,handle:job.handle,result:'skipped',detail:ev.reason});
          return {ok:true,job:saved.job,evaluation:ev,summary:ev.reason};
        }
        const sourceInteractionReason = interactionSkipReason({...safetyProfile, posts:[...candidates, ...cachedPosts]});
        if (sourceInteractionReason) {
          ev.status='skipped'; ev.reason=sourceInteractionReason; ev.reasonCode='interaction_scope'; ev.grokCalls=0;
          const saved=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          return {ok:true,job:saved.job,evaluation:ev,summary:ev.reason};
        }
        ev.generationAttemptedAt = Date.now();
        ev.candidatePosts = candidates;
        ev.reasonCode = 'generation_started';
        const started = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        if (!started.ok) throw new Error('未能保存 Grok 请求状态，未发送请求');
        const generate=({reply:generateReply,article:generateArticle,original:generatePost})[publicationMode]||generateComment;
        progress('已按综合互动分选帖，Grok 正在生成内容…');
        const generated = await generate(job.handle,candidates,job.handle,{sleep,profile:safetyProfile,writerAccountId:job.accountId,
          qualityFirst:true,qualityGate:!['quote','reply'].includes(publicationMode),lengthMode:commentSettings.quoteLengthMode || 'adaptive',relayJobId:ev.relayJobId,
          onRelayJobCreated:async relay=>{
            await guardComment();
            Object.assign(ev,{relayJobId:relay.id,channel:'grok-bot',reasonCode:'bot_pending'});
            const checkpoint=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
            if(!checkpoint.ok)throw new Error('未能保存 Bot 任务编号，未发送生成请求');
          }});
        if(generated.pending){
          Object.assign(ev,{status:'uncertain',reasonCode:'bot_pending',relayJobId:generated.jobId,channel:'grok-bot',reason:generated.reason||'Bot 结果待确认，已保留原任务'});
          const saved=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          return {ok:false,pending:true,error:ev.reason,evaluation:ev,job:saved.job,summary:ev.reason};
        }
        if (generated.quotaExhausted) {
          // Only an explicit pre-submit quota check authorizes a future request.
          const unsent = generated.generationAttempted === false;
          ev.reasonCode = unsent ? 'quota_not_sent' : 'generation_uncertain';
          ev.status = unsent ? (ev.recoveryDraftOnly ? 'failed' : 'pending') : 'uncertain';
          ev.reason = unsent ? 'Grok 额度不足，未发送生成请求' : 'Grok 提交后触发额度限制，结果待核实，未重复请求';
          ev.grokCalls=(Number(ev.grokCalls)||0)+(generated.grokCalls || 0);
          await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          return {ok:false, ...generated,evaluation:ev};
        }
        Object.assign(ev,{quality:generated.quality || null,lengthPolicy:generated.lengthPolicy || null,
          grokCalls:(Number(ev.grokCalls)||0)+(generated.grokCalls ?? 1),reasonCode:generated.reasonCode || ''});
        ev.text = generated.reply || '';
        if(generated.article)ev.article=generated.article;
        if(generated.reviewRequired)ev.quality={...ev.quality,reviewRequired:true};
        ev.language = generated.language || 'und';
        ev.channel = generated.channel || ev.channel || '';
        ev.status = generated.ok ? 'draft' : (generated.riskBlocked || generated.skipped ? 'skipped' : 'failed');
        ev.riskBlocked = Boolean(generated.riskBlocked);
        ev.reason = generated.reason || '';
        if (!generated.ok) {
          const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          await safeLog({scope:'comment',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),
            result:ev.status,reasonCode:ev.reasonCode,grokCalls:ev.grokCalls,detail:ev.reason || 'Grok 未生成有效评价'});
          return {ok:Boolean(generated.skipped),error:generated.skipped ? '' : ev.reason || 'Grok 生成评价失败',summary:ev.reason,job:saved.job,evaluation:ev};
        }
        post = generated.post;
        originalPostId = post.url.match(/\/status\/(\d+)/)?.[1] || '';
        if (!originalPostId) throw new Error('Grok 选中的帖子缺少有效推文 ID');
        Object.assign(ev,{taskId:targetEval?.automaticComment ? targetEval.taskId : `${binding.accountId}:${originalPostId}`,originalPostId,originalPostUrl:post.url,originalPostText:post.text});
        // Preserve paid-for output even if a user pauses while Grok is replying.
        const drafted = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        if (!drafted.ok) throw new Error('评价草稿未能保存，已停止发布');
        await guardComment();
      } else {
        ev.status = 'draft';
      }
      const settings = await store.getSettings(binding.accountId);
      ev.baseText ||= ev.text;
      ev.language = resolveCommentLanguage(ev.baseText, ev.language);
      const ending = composeQueueFollowBack(ev.baseText,ev.language,settings.followBackSuffixEnabled && ['reply','quote'].includes(publicationMode));
      ev.text = publicationMode!=='quote' ? ending.text : appendQuoteTags(ending.text, settings, ev.language || 'und', {previousText: ev.text,lengthPolicy:ev.lengthPolicy});
      const reviewIssue = ending.issue || (ev.reasonCode === 'draft_too_long' || ev.quality?.reviewRequired ? ev.reason || '质量判断待复核'
        : publicationMode==='article' ? (!ev.article?'缺少文章结构，请重新检查草稿':originalQualityIssue(ev.quality))
        : publicationMode==='original' ? originalQualityIssue(ev.quality) || originalTextIssue(ev.text,ev.originalPostText) : quotePublishIssue(ev.text));
      if (reviewIssue) {
        ev.status = 'draft'; ev.reason = reviewIssue;
        const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        await safeLog({scope:'comment',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),result:'draft',detail:reviewIssue});
        return {ok:true,job:saved.job,evaluation:ev,summary:reviewIssue};
      }
      if ((ev.recoveryDraftOnly && (automatic || !targetEval?.text || !publish)) || (!publish && !settings.autoPublish) || verifyOnly) {
        if (ev.recoveryDraftOnly) ev.reason = '重新生成的草稿已保留，请检查后再点击发布评价';
        const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        if (!saved.ok) throw new Error('评价草稿未保存，已停止发布');
        await safeLog({scope:'comment',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),result:'draft',detail:`${form}草稿已就绪（未开启自动发布）`});
        return {ok:true,job:saved.job,evaluation:ev,summary:ev.reason || `${form}草稿已就绪（未自动发布）`};
      }
      const finalInteractionReason = interactionSkipReason({...safetyProfile, posts:[post, {text:ev.originalPostText}, {text:ev.text}, ...cachedPosts]});
      if (finalInteractionReason) {
        ev.status='skipped'; ev.reason=finalInteractionReason; ev.reasonCode='interaction_scope';
        const saved=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        return {ok:true,job:saved.job,evaluation:ev,summary:ev.reason};
      }
      await guardComment();
      if (automatic && !(await store.getSettings(binding.accountId)).autoPublish) {
        ev.status = 'draft'; ev.reason = '自动发布已关闭，草稿已保留';
        const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        return {ok:true,job:saved.job,evaluation:ev,summary:ev.reason};
      }
      if(publicationMode==='article'&&!ev.article?.cover){
        progress('正在生成文章配图…');
        if(automatic&&ev.coverAttemptedAt){ev.status='draft';ev.reason='配图尚未完成，请手动重试，正文已保留';await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});return {ok:true,evaluation:ev,summary:ev.reason};}
        ev.coverAttemptedAt=Date.now();ev.status='draft';
        const checkpoint=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        if(!checkpoint.ok)throw Error('未保存配图请求状态，未调用生图');
        const image=await makeCover({owner:binding.handle,prompt:ev.article.coverPrompt,title:ev.article.title,canGenerate:async()=>{await guardComment();return true;}});
        if(!image.ok){ev.reason=image.reason||'配图未完成，文章正文已保留';await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});return {ok:true,evaluation:ev,summary:ev.reason};}
        ev.article={...ev.article,cover:image.cover};
        const savedCover=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        if(!savedCover.ok)throw Error('文章配图未保存，未提交发布');
        await guardComment();
      }
      ev.status = 'publishing';
      ev.recoveryDraftOnly = false;
      progress('正在发布并核验结果…');
      ev.publishedAttemptedAt=Date.now();
      const publishingCheckpoint = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
      if (!publishingCheckpoint.ok) throw new Error('未能保存发布检查点，未提交发布');
      const submittedAt = Date.now();
      const beforePublish=async()=>{
        await guardComment();
        if (automatic && !(await store.getSettings(binding.accountId)).autoPublish) throw new Error('自动发布已关闭，未提交');
      };
      const published = publicationMode==='article'
        ? await articles.publish({owner:binding.handle,article:{...ev.article,body:ev.text},canPublish:async()=>{await beforePublish();return true;}})
        : publicationMode==='reply' ? await replies.publish({owner:binding.handle,sourcePostUrl:ev.originalPostUrl,text:ev.text,canPublish:async()=>{await beforePublish();return true;}})
        : publicationMode==='original'
        ? await publishing.publish({owner:binding.handle,text:ev.text,sourceText:ev.originalPostText,canPublish:async()=>{await beforePublish();return true;}})
        : await postQuoteOnTab(tab.id,post,ev.text,publishQuotePostOnPage,sleep,{beforePublish});
      if(published.draftUrl)ev.articleDraftUrl=published.draftUrl;
      ev.status = publicationMode!=='quote' ? published.status || 'uncertain' : quotePublicationState(published);
      ev.reason = published.reason || `等待主页确认${form}发布`;
      if(publicationMode!=='quote' && published.status==='posted')Object.assign(ev,{publishedPostId:published.publishedPostId,publishedPostUrl:published.publishedPostUrl,reason:''});
      if (published.ok && publicationMode==='quote') {
        const proof = await confirmPublishedQueueQuote({api,tabId:tab.id,handle:binding.handle,
          originalId:originalPostId,text:ev.text,after:submittedAt});
        if (proof) Object.assign(ev,{status:'posted',publishedPostId:proof.id,publishedPostUrl:proof.url,reason:''});
      }
      const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
      await safeLog({scope:'comment',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),result:ev.status,detail:ev.status === 'posted' ? `${form}已发布并核验` : (ev.reason || `${form}处理结束`)});
      return {ok:true,job:saved.job,evaluation:ev,summary:ev.status === 'posted' ? `${form}已发布并核验` : ev.reason};
    } finally {
      if (tab) await api.tabs.remove(tab.id).catch(() => {});
    }
  }
  const commentWorker = createCommentWorker({store, storage:api.storage.local,
    readBinding, execute:retryEvaluation,
    onSkip:entry=>safeLog({...entry,scope:'comment',result:'skipped',detail:entry.reason,at:new Date().toISOString()}),
    isBusy:job => commentLocks.has(job.accountId+':'+job.id)});
  async function schedule({preserve = false} = {}) {
    const binding = await readBinding();
    if (!binding?.activated) return;
    await api.alarms.create(COMMENT_ALARM,{periodInMinutes:1}).catch(error=>console.warn('评论调度创建失败:',error.message));
    // Queue takeover is durable, including when its own enabled switch is off.
    await api.alarms.clear('x-mutual-auto-follow');
    await api.alarms.clear('x-comment-auto-follow');
    const settings = await store.getSettings(binding.accountId);
    if (preserve && settings.enabled && (await api.alarms.getAll()).some(alarm=>alarm.name === QUEUE_ALARM)) return;
    await api.alarms.clear(QUEUE_ALARM);
    if (settings.enabled) await api.alarms.create(QUEUE_ALARM,{delayInMinutes:randomizedInteger(settings.every,settings.jitter,1,240)});
  }
  async function run(manual=false){
    if(runPromise)return {ok:false,notify:false,summary:'队列正在执行，已跳过重复触发。'};
    runPromise=runCycle(manual);try{return await runPromise;}finally{runPromise=null;}
  }
  async function runCycle(manual = false) {
    const binding = await readBinding();
    if (!binding?.activated) throw new Error('请先确认统一队列的数据归属和来源');
    // Create only one temporary tab if a scheduled task has no X tab available.
    let bootstrap,runStage='bootstrap';
    try {
      if (!(await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']})).length) {
        bootstrap = await createProfileTab(api,{url:'https://x.com/home',active:false},'follow-queue');
        for(let i=0;i<30;i++) { if(await viewer(bootstrap.id).catch(error=>{if(isPageFailure(error))throw error;return '';})) break; await sleep(500); }
      }
      reflectJobs = [];runFailures=[];
      runStage='sync-candidates';
      try{await syncCandidates();}catch(error){const failure=await diagnostics.record(error,{stage:runStage,manual,accountId:binding.accountId,handle:binding.handle,requestedUrl:`https://x.com/${binding.handle}`});runFailures.push(failure);}
      // A source/backup failure must not prevent already queued jobs from running.
      // The scheduler still validates the live account before every job.
      runStage='run-queue';
      const result = await scheduler.run({accountId:binding.accountId,manual});
      runStage='reflect-results';
      try{await reflectFollowed(binding.accountId, reflectJobs);}catch(error){const failure=await diagnostics.record(error,{stage:runStage,manual,accountId:binding.accountId,handle:reflectJobs?.at(-1)?.handle||'',runId:result.runId});return {...result,summary:result.summary+' 本地同步暂未完成。'+failureNotice(failure),notify:failure.notify};}
      if(runFailures.length)return {...result,notify:runFailures.some(f=>f.notify),summary:result.summary+' '+failureNotice(runFailures[0])};
      return result;
    } catch(error){const failure=await diagnostics.record(error,{stage:runStage,manual,accountId:binding.accountId,handle:binding.handle,runId:scheduler.status().runId,requestedUrl:`https://x.com/${binding.handle}`,tabId:bootstrap?.id});return {ok:false,error:failure.message,summary:failure.message+' '+failureNotice(failure),notify:failure.notify};}
    finally { reflectJobs = null;runFailures=null; if(bootstrap) await api.tabs.remove(bootstrap.id).catch(()=>{}); await schedule().catch(async error=>{await diagnostics.record(error,{stage:'schedule-next',accountId:binding.accountId,handle:binding.handle});}); }
  }
  async function handle(message) {
    if (message.cmd === 'followQueueIdentityStatus') return {ok:true,stage:identityStage};
    if (message.cmd === 'followQueueIdentity') return {ok:true,...await identity(),binding:await readBinding()};
    if (message.cmd === 'followQueueActivate') {
      if (message.confirmed !== true) throw new Error('请确认本地数据属于当前账号');
      const current = await identity();
      if (current.accountId !== message.accountId) throw new Error('当前账号变化，请重新确认');
      const sources = Object.fromEntries(['fans','mutual','comments'].map(k=>[k,message.sources?.[k] === true]));
      await writeLocal({[BINDING_KEY]:{...current,activated:true,sources,confirmedAt:Date.now()}});
      await schedule();
      await store.updateSources({accountId:current.accountId,modules:sources});
      await syncCandidates(); await schedule(); return {ok:true};
    }
    const binding = await readBinding();
    if (!binding?.activated || (message.accountId && binding.accountId !== message.accountId)) throw new Error('请先确认队列账号');
    switch(message.cmd) {
      case 'followQueueList': {
        const settings = await store.getSettings(binding.accountId);
        const page = await store.queryPage({
          accountId: binding.accountId,
          state: message.state || 'all',
          source: message.source || 'all',
          q: message.q || '',
          order: message.order || null,
          cursor: message.cursor || null,
          limit: Number.isInteger(message.limit) ? message.limit : 20,
          signal: message.signal || null
        });
        const jobs = page.jobs.map(job => ({
          ...job,
          profile: job.profile && typeof job.profile === 'object' ? job.profile : null,
          profileStatus: job.profile && typeof job.profile === 'object' ? 'stored' : 'unavailable'
        }));
        return {
          ok: true,
          paged: true,
          jobs,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore === true,
          total: page.total,
          totalKnown: page.totalKnown === true,
          stats: page.stats,
          revision: page.revision,
          scanned: page.scanned,
          scanBatch: page.scanBatch,
          scanLimited: page.scanLimited === true,
          scanExhausted: page.scanExhausted === true,
          summary: {...scheduler.status(), isPaused: !settings.enabled, stats: page.stats}
        };
      }
      case 'followQueueRunCheck': return {ok:true,allowed:await canRun(binding.accountId),blockReason:runBlockReason};
      case 'followQueueSyncSources': await syncCandidates(); return {ok:true};
      case 'followQueueSettings': return {ok:true,settings:await store.getSettings(binding.accountId)};
      case 'followQueueSaveSettings': {
        const settings = await store.saveSettings(binding.accountId,message.settings); await schedule(); return {ok:true,settings};
      }
      case 'followQueuePause': await scheduler.pause(binding.accountId); await schedule(); return {ok:true,settings:await store.getSettings(binding.accountId)};
      case 'followQueueRun': return run(true);
      case 'followQueueVerify': return verifyUncertain(binding, message);
      case 'followQueueDelete': {
        if (message.confirmed !== true) throw new Error('请确认删除队列记录');
        const result = await store.deleteJob({accountId:binding.accountId, id:message.jobId});
        if (result.ok) await safeLog({scope:'queue', accountId:binding.accountId, handle:result.handle,
          jobId:message.jobId, at:new Date().toISOString(), result:'deleted', detail:'已手动删除队列记录，并阻止旧来源重新加入'});
        return result;
      }
      case 'followQueueReconcileFan': return reconcileFan(binding, message);
      case 'followQueueInspectFan': return reconcileFan(binding, {...message,inspectOnly:true});
      case 'followQueueFanBatchStart': {
        if(!Array.isArray(message.handles)||!message.handles.length)throw new Error('请先勾选当前页需要核验的账号');
        return {ok:true,batch:await fanInspectionBatch.start(binding.accountId,message)};
      }
      case 'followQueueFanBatchStatus': return {ok:true,batch:await fanInspectionBatch.status(binding.accountId)};
      case 'followQueueFanBatchResume': return {ok:true,batch:await fanInspectionBatch.resume(binding.accountId)};
      case 'followQueueFanBatchStop': return {ok:true,batch:await fanInspectionBatch.stop(binding.accountId)};
      case 'followQueueFanBatchCancel': return {ok:true,batch:await fanInspectionBatch.cancel(binding.accountId)};
      case 'followQueueRetryEvaluation': return retryEvaluation(binding, message);
      case 'followQueueBackfillProfiles': return {ok: true, ...(await backfillProfiles(message))};
      case 'followQueueEnqueue': {
        const rawList = Array.isArray(message.candidates) ? message.candidates : [message.candidate].filter(Boolean);
        const enqueued = [];
        for (const item of rawList) {
          if (!item?.handle) continue;
          const candidateSources = Array.isArray(item.sources) && item.sources.length > 0
            ? item.sources.map(s => ({ module: s.module || 'comments', url: s.url || '', enabled: s.enabled !== false }))
            : [{ module: item.module || 'comments', url: item.url || '', enabled: true }];
          const res = await store.enqueue({
            accountId: binding.accountId,
            targetUserId: item.targetUserId || '',
            handle: item.handle,
            sources: candidateSources,
            profile: item.profile || null
          });
          if (!res.deleted) enqueued.push(res);
        }
        await schedule();
        return {ok: true, count: enqueued.length, jobs: enqueued};
      }
      default: throw new Error('未知队列操作');
    }
  }
  return {handle,schedule,run,runComments:commentWorker.run,syncCandidates,backfillProfiles,reflectFollowed,store};
}
