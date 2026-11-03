import {isAccessDeferred} from '../../platform/x/access-budget.js';
import {createQueueTabs,startQueueActivity} from './queue-lifecycle.js';
import {createStorageWriteQueue} from '../../platform/storage-write-queue.js';
import {createFanProfileCollector} from '../relationships/fan-profile-collector.js';
import {readFanProfileQueue,createFanProfileCacheReader} from '../relationships/fan-profile-queue-view.js';
import {cachedReviewPosts,inspectionProfilePatch,reviewProfileEvidence} from '../relationships/fan-profile-evidence.js';
import {createXNetworkClient} from '../../platform/x/network-client.js';
import {parseScoredPosts} from './scored-posts.js';
import {observeProfile,unavailableFromProfileResponse} from '../../platform/x/profile-access.js';
import {queueRelationshipDecision} from '../relationships/fan-followback-policy.js';
import {readQueueProfile,profileReadLimitError,queueExecutionRelationship} from './profile-reader.js';
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
import {createQueueAlarmPlan} from './queue-alarm-plan.js';
import {collectFollowQueueCandidates} from './follow-queue-sources.js';
import {createFanLogSink} from '../relationships/fan-workflow-logs.js';
import {createFanInspectionBatch} from '../relationships/fan-inspection-batch.js';
import {networkFetch, networkGetUserProfile, networkFollow, parseNetworkUsers, mergeRecentPosts} from '../relationships/network-api.js';
import {readProfileBundle, simulateProfileScrollStep, publishQuotePostOnPage, setQuoteFrameFallbackOnPage} from '../../platform/x/page-reader.js';
import {parseCount, riskAssess} from '../relationships/scoring.js';
import {requestGrokComment, postQuoteOnTab, resolveCommentLanguage, quoteCandidates, highestScoredPost, composeQueueFollowBack} from '../grok/grok-comment.js';
import {interactionSkipReason} from '../relationships/content-risk.js';
import {followerRatioDecision} from '../relationships/follower-ratio-policy.js';
import {removeRatioFollower} from '../../platform/x/remove-follower.js';
import {randomizedSeconds} from '../../shared/timing.js';
import {appendExecutionLog, normalizeQueueExecutionLog} from '../../shared/execution-log.js';
import {readAutoFollowAttempts} from '../../shared/auto-follow-history.js';
import {ACCOUNT_FOLLOW_LIMIT_MESSAGE, isAccountFollowLimit} from '../../shared/follow-limit.js';
import {readReviewSettings,hasAuthorizedFanGrant,createFanGrant,runTaggingBatch,selectQueueScreeningPosts,detectLocalHardRule,
  readRemovalTombstones,findRemovalTombstone,recordRemovalTombstone,updateMonitorFanRows} from '../relationships/follow-review-engine.js';

export const QUEUE_ALARM = 'x-unified-follow-queue';
export const RETRY_BATCH_ALARM = 'x-follow-queue-retry-batch';
const BINDING_KEY = 'followQueueBinding';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => String(value || '').replace(/^@/, '').toLowerCase();

export function quotePublicationState(result) {
  if (result?.riskBlocked) return 'skipped';
  return result?.attempted === false ? 'draft' : result?.stage === 'composer' ? 'failed' : 'uncertain';
}

export function blueVerifiedDecision(target, enabled) {
  if (!enabled) return null;
  if (target?.is_blue_verified === true) return null;
  if (target?.is_blue_verified === false) return {state:'skipped', reason:'非蓝 V，按配置跳过关注'};
  return {state:'uncertain', reason:'蓝 V 状态未能核实，未执行关注'};
}

export function assessQueueProfile(profile, settings, confirmedFollowBack = false) {
  const interactionReason = interactionSkipReason(profile);
  if (interactionReason) return interactionReason;
  const followers = parseCount(String(profile.followersText ?? ''));
  const following = parseCount(String(profile.followingText ?? ''));
  const risk = riskAssess(profile);
  if (risk.riskCategories.some(category => category === 'armed_group' || category === 'terrorism')) {
    return `命中武装组织或恐怖极端内容门禁（${risk.hits.slice(0, 2).join('、')}）`;
  }
  if (settings.skipRiskContent !== false && risk.level === 'danger') {
    return `命中高风险内容门禁（${risk.hits.slice(0, 2).join('、')}）`;
  }
  // Abnormally high following counts have a separate exact-count rule. The
  // ordinary following rate only affects queue priority, never admission.
  if (followers === null || following === null) return '未读全粉丝与关注数';
  if (followers < settings.minFollowers) return `粉丝数低于 ${settings.minFollowers}`;
  return '';
}

export function readQueueViewerOnPage() {
  return globalThis.__xfAccountSnapshot?.account?.handle || '';
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

export function createFollowQueueRuntime({api = chrome, store, fetchUser, fetchFanTimeline, fetchIdentity = networkFetch, fetchProfile=networkGetUserProfile, performFollow=networkFollow, removeFollower=removeRatioFollower, generateComment=requestGrokComment, generatePost=generateOriginalPost, generateReply=generateDirectReply, generateArticle=generateXArticle, tagging=runTaggingBatch, gateCandidates, ensureReviewReady=async()=>{}, onFanRelationChanged=()=>{}, replyPublisher, articlePublisher, generateCover, postPublisher, wait = sleep, records = null, readAccount} = {}) {
  const queueTabs = createQueueTabs(api);
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
  let syncing = null;
  const readBinding = async () => (await api.storage.local.get(BINDING_KEY))[BINDING_KEY];
  const alarmPlan = createQueueAlarmPlan({api,name:QUEUE_ALARM});
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
  async function viewer(tabId) { return readAccount?canonical((await readAccount())?.handle):canonical(await script(tabId, readQueueViewerOnPage)); }
  let identifying;
  let identityStage = 'idle';
  async function identity() {
    if (identifying) return identifying;
    identityStage = 'checking';
    identifying = resolveIdentity().then(result => { identityStage = 'ready'; return result; }, error => { identityStage = 'failed'; throw error; }).finally(() => { identifying = null; });
    return identifying;
  }
  async function resolveIdentity() {
    if(readAccount){const account=await readAccount();if(!account?.id)throw Error('账号模块正在刷新登录信息，请稍后重试');return {accountId:account.id,handle:account.handle};}
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
    await ensureReviewReady(binding);
    if(readAccount){const account=await readAccount();return !!account&&String(account.id)===String(accountId)||blockRun('account-state',account?'账号模块已确认切换登录账号':'等待账号模块获取登录信息');}
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
  function authorizedFanGrant(job, targetId) {
    const grant=job.fanGrant || job.followResult?.fanGrant;
    return Boolean(targetId && String(grant?.targetUserId || '')===String(targetId)
      && job.sources?.some(source=>source.module==='fans' && source.enabled===true)
      && hasAuthorizedFanGrant(grant,job.accountId,targetId,job.handle,{requireTargetUserId:true}));
  }
  async function fanRuleBypass(job,target) {
    const binding=await readBinding();
    if(binding?.accountId!==job.accountId || binding.sources?.fans!==true || !authorizedFanGrant(job,target?.id))return false;
    if((await readReviewSettings(api.storage.local,job.accountId)).followBackSkipRules!==true)return false;
    const frozen=job.fanGrant || job.followResult?.fanGrant;
    const payloads=await currentFanPayloads(job,target.id);
    const decisionVersion=payload=>Number(payload.fanReview?.decisionVersion) || Number((payload.fanReview?.grant || payload.fanGrant)?.decisionVersion) || 0;
    const latestVersion=Math.max(0,...payloads.map(decisionVersion));
    return payloads.filter(payload=>decisionVersion(payload)===latestVersion).some(payload=>{
      if(payload.fanReview && Object.hasOwn(payload.fanReview,'grant') && payload.fanReview.grant===null)return false;
      const grant=payload.fanReview?.grant || payload.fanGrant;
      return !payload.legacyHandleIdentityConflict && (!payload.fanReview?.state || payload.fanReview.state==='approved')
        && String(grant?.targetUserId || '')===String(target.id) && hasAuthorizedFanGrant(grant,job.accountId,target.id,job.handle,{requireTargetUserId:true})
        && (!payload.fanReview?.decisionVersion || payload.fanReview.decisionVersion===grant.decisionVersion)
        && grant.decisionVersion===frozen.decisionVersion && grant.grantedAt===frozen.grantedAt && grant.source===frozen.source;
    });
  }
  async function currentFanPayloads(job,targetId=job.targetUserId) {
    let rows;
    if(typeof records?.fanDirectory==='function')rows=await records.fanDirectory([canonical(job.handle)],{accountId:job.accountId,includeUnassigned:true});
    else {
      const monitor=(await api.storage.local.get('monitor')).monitor || {};
      rows=['users','queue','followingUsers'].flatMap(bucket=>monitor[bucket] || []).map(payload=>({payload}));
    }
    const qualified=[];
    for(const row of rows || []) {
      const payload=row.payload || row;
      if(canonical(payload.handle || row.handle)!==canonical(job.handle))continue;
      const review=payload.fanReview;
      const declared=[payload.accountId,payload.ownerAccountId,review?.ownerAccountId,payload.fanGrant?.ownerAccountId].filter(id=>id&&id!=='unassigned');
      if(declared.some(id=>id!==job.accountId))continue;
      const id=String(review?.targetUserId || payload.targetUserId || payload.rest_id || payload.id || payload.fanGrant?.targetUserId || '');
      if(id && targetId && id!==targetId)continue;
      qualified.push(payload);
    }
    return qualified;
  }
  async function currentFanHold(job,targetId=job.targetUserId) {
    if(!job.sources?.some(source=>source.module==='fans'&&source.enabled))return '';
    for(const payload of await currentFanPayloads(job,targetId)) {
      const review=payload.fanReview;
      if(['review','initial','failed','removed'].includes(review?.state))return review.reason || '粉丝审核状态已变化，停止队列执行';
    }
    return '';
  }
  async function gateSourceCandidates(binding,candidates) {
    await ensureReviewReady(binding);
    if(gateCandidates)return gateCandidates(binding,candidates);
    const settings=await readReviewSettings(api.storage.local,binding.accountId);
    const tombstones=await readRemovalTombstones(api.storage.local,binding.accountId);
    const accepted=[];
    for(let candidate of candidates) {
      if(findRemovalTombstone(tombstones,candidate))continue;
      if(candidate.sources?.some(source=>source.module==='fans'&&source.enabled)) {
        if(['review','initial','failed','removed'].includes(candidate.fanReview?.state))continue;
        if(!candidate.fanGrant) {
          if(settings.initialReviewEnabled)continue;
          const prior=await priorByHandle(binding.accountId,candidate.handle);
          const fanGrant=prior?.fanGrant || createFanGrant({accountId:binding.accountId,targetUserId:candidate.targetUserId,handle:candidate.handle,source:'initial-review-disabled'});
          candidate={...candidate,fanGrant};
        }
      }
      accepted.push(candidate);
    }
    return accepted;
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
  const profileWrites=createStorageWriteQueue();
  const readCachedFanResults=createFanProfileCacheReader({records,storage:api.storage.local});
  const readCachedProfile=async handle=>records ? (await records.lookup({module:'profiles',handle:canonical(handle)}))?.payload||{} : (await api.storage.local.get('profileCache')).profileCache?.[canonical(handle)]||{};
  function updateCachedProfile(handle,transform,expectedTargetUserId){return profileWrites.enqueue(async()=>{
    const key=canonical(handle),previous=await readCachedProfile(key);
    const incoming=await transform(previous),patch={...previous,...incoming,handle:key,profileCachedAt:new Date().toISOString()};
    if(records)await records.batch({sourceKey:'profileCache',changes:[{accountId:'unassigned',handle:key,sourceBucket:'map',create:true,patch,...(expectedTargetUserId?{expectedTargetUserId}:{})}]});
    else {const {profileCache={}}=await api.storage.local.get('profileCache');profileCache[key]=patch;await writeLocal({profileCache});}
    return patch;
  });}
  function saveProfile(handle,incoming,expectedTargetUserId){return updateCachedProfile(handle,previous=>({...incoming,posts:mergeRecentPosts(previous.posts||[],incoming.posts||[],100)}),expectedTargetUserId);}
  const fanProfiles=createFanProfileCollector({storage:api.storage.local,alarms:api.alarms,binding:readBinding,
    readProfile:item=>readCachedProfile(item.handle),
    updateProfile:async(item,transform)=>updateCachedProfile(item.handle,async previous=>{const binding=await readBinding();if(binding?.accountId!==item.accountId)throw Error('资料缓存归属已变化');return transform(previous);},item.targetUserId),
    readTimeline:fetchFanTimeline || (async item=>{
      const binding=await readBinding();if(binding?.accountId!==item.accountId)throw Error('帖子采集归属已变化');
      return withVerifiedXTab(binding,async tab=>{
        if(String(tab.url||'').replace(/\/$/,'').toLowerCase()===`https://x.com/${item.handle}`){
          const loaded=await script(tab.id,readProfileBundle,[item.handle,15]).catch(()=>null);
          if(!loaded?.pending&&loaded?.id===item.targetUserId&&cachedReviewPosts(loaded.posts,item.handle).length){
            if(await viewer(tab.id)!==canonical(binding.handle))throw Error('帖子采集期间 X 登录账号已变化');
            return {status:200,posts:cachedReviewPosts(loaded.posts,item.handle),complete:false,source:'loaded-profile'};
          }
        }
        const templates=(await api.storage.local.get('networkTemplates')).networkTemplates||{};
        const operation=templates.UserOriginalsTimeline?'UserOriginalsTimeline':'UserTweets';
        const response=await createXNetworkClient(api).query(tab.id,operation,{userId:item.targetUserId,count:30,includePromotedContent:false});
        if(await viewer(tab.id)!==canonical(binding.handle))throw Error('帖子采集期间 X 登录账号已变化');
        if(response.status!==200||response.error)return response;
        const parsed=parseScoredPosts(response.json,{userId:item.targetUserId,handle:item.handle});
        return {...response,posts:cachedReviewPosts(parsed.posts,item.handle),complete:!parsed.hasMore&&parsed.unavailable===0,source:operation};
      },item.handle);
    })});

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
    const ranks = {skipped:1, uncertain:2, excluded:3, followed:4};
    for (const candidate of await gateSourceCandidates(binding,candidates)) {
      const prior = await priorByHandle(binding.accountId, candidate.handle);
      if (prior && !prior.targetUserId && typeof records?.fanDirectory === 'function') {
        const directory = await records.fanDirectory([canonical(candidate.handle)]);
        if (directory.some(row=>row.payload?.legacyHandleIdentityConflict||row.payload?.legacyHandleIdentityHistory)) continue;
      }
      const item = candidate;
      const newSource = !prior || item.sources.some(source => !prior.sources.some(s => s.module === source.module && s.url === source.url));
      const priorState = prior?.followResult?.succeeded ? 'followed' : prior?.importedHold?.state || prior?.state;
      const verifiedNotFollowing = prior?.followResult?.verifiedAt && prior?.followResult?.following === false;
      const blockedByActiveOrVerified = verifiedNotFollowing
        || ((prior?.state === 'running' || prior?.followResult?.verifiedAt) && item.state !== 'followed');
      const newOutcome = !blockedByActiveOrVerified && (ranks[item.state] || 0) > (ranks[priorState] || 0);
      const profile = profiles.get(canonical(item.handle)) || item.profile || null;
      const priorityChanged = typeof item.followBackCandidate === 'boolean' && item.followBackCandidate !== prior?.followBackCandidate;
      const grantChanged=priorState!=='followed'&&item.fanGrant&&JSON.stringify(item.fanGrant)!==JSON.stringify(prior?.fanGrant);
      if (prior && !newSource && !newOutcome && !priorityChanged && !grantChanged && !profileChanged(prior.profile, profile)) continue;
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
            .filter(user => {const rel=directory.get(canonical(user.handle))?.relationship;return rel?.following===true||rel?.following===false&&rel?.followedBy===true;})
            .map(user => ({...user,relationship:directory.get(canonical(user.handle)).relationship,
              state:directory.get(canonical(user.handle)).relationship.following===false ? 'follow_back' : 'following'}));
        }
        await enqueueCandidates(binding, collectFollowQueueCandidates({
          accountId:binding.accountId, ...snapshot, attempts, sourceEnabled:binding.sources
        }), profiles);
        pageCursor = page.nextCursor || null;
      } while (pageCursor);
    }
  }
  async function syncCandidates() {
    if(syncing)return syncing;
    const run = (async () => {
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
    })();
    syncing = run;
    try{return await run;}finally{if(syncing===run)syncing=null;}
  }
  const executionAudits = new Map();
  const screeningBatchKey=(account,id)=>`followQueueScreeningBatch:${account}:${id}`;
  async function screeningInput(job,profile,target,role) {
    const item={handle:canonical(job.handle),targetUserId:String(target.id),ownerAccountId:job.accountId,
      name:profile.name || target.name || '',bio:profile.bio || target.bio || '',
      followersText:target.followersText,followingText:target.followingText,relationship:{following:target.relationship?.following??null},
      posts:selectQueueScreeningPosts(profile.posts,job.handle,10)};
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({version:1,item,role})));
    return {item,inputDigest:[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};
  }
  async function writeQueueScreening(job,screening,current,control) {
    const binding=await readBinding();
    if(binding?.accountId!==job.accountId)throw new Error('打标回写时队列账号已变化');
    const latest=await readJob(job.accountId,job.id);
    if(!latest || canonical(latest.handle)!==canonical(job.handle) || (latest.targetUserId && latest.targetUserId!==screening.targetUserId))return false;
    if(latest.id!==current.id && !['pending','retry'].includes(latest.state))return false;
    const followResult={...latest.followResult,queueScreening:screening};
    if(latest.id===current.id)await control.checkpoint({followResult});
    else if(typeof store.patchQueueScreening==='function') {
      const saved=await store.patchQueueScreening({accountId:job.accountId,id:job.id,targetUserId:screening.targetUserId,handle:job.handle,screening,
        expectedScreeningBatchId:job.followResult?.queueScreening?.batchId || null,expectedFanGrant:job.fanGrant || null});
      return saved.ok===true;
    } else {
      const saved=await store.resolveJob({accountId:job.accountId,id:job.id,followResult});
      return saved?.ok===true;
    }
    return true;
  }
  async function prepareQueueTagging(current,profile,target,settings,control,guard) {
    const role=settings.queueTagging;
    const currentInput=await screeningInput(current,profile,target,role);
    const previous=(await readJob(current.accountId,current.id))?.followResult?.queueScreening;
    if(previous?.phase==='complete' && previous.inputDigest===currentInput.inputDigest) {
      const retained=(await api.storage.local.get(screeningBatchKey(current.accountId,previous.batchId)))[screeningBatchKey(current.accountId,previous.batchId)];
      // A checkpoint may have failed after other members were saved. Finish only
      // the local writes from the received result; never ask the AI again here.
      if(retained?.receivedTagging && retained.items?.length)return finishQueueTagging(retained,current,control);
      return previous;
    }
    if(previous && ['submitted','pending','unknown'].includes(previous.phase)) {
      const batch=(await api.storage.local.get(screeningBatchKey(current.accountId,previous.batchId)))[screeningBatchKey(current.accountId,previous.batchId)];
      if(!previous.relayJobId && !batch?.receivedTagging)return {...previous,phase:'unknown',reason:'上次打标请求结果未知，未重复提交'};
      if(!batch?.items?.length)return {...previous,phase:'unknown',reason:'缺少原打标批次快照，未重复提交'};
      if(!batch.receivedTagging && batch.nextPollAt>Date.now())return {...previous,phase:'pending',reason:'原打标批次仍在等待结果，已保留任务编号'};
      const completed=await finishQueueTagging(batch,current,control);
      const frozenInput=await screeningInput(current,profile,target,batch.roleSnapshot);
      if(completed.phase==='complete' && completed.inputDigest!==frozenInput.inputDigest)return {...completed,phase:'stale',reason:'原打标结果已保存，资料变化后需重新分析'};
      return completed;
    }
    if(!['grok-local','codex','antigravity'].includes(role?.provider) || !role?.botId)return {phase:'unconfigured',decision:'uncertain',reason:'队列打标引擎未配置独立 AI 引擎与会话'};
    const items=[{job:current,...currentInput}];
    const candidates=typeof store.listByState==='function'
      ? [...await store.listByState({accountId:current.accountId,state:'pending'}),...await store.listByState({accountId:current.accountId,state:'retry'})]
      : (await store.list({accountId:current.accountId})).filter(row=>['pending','retry'].includes(row.state));
    for(const candidate of candidates) {
      if(items.length>=role.batchSize || control.signal?.aborted)break;
      if(candidate.id===current.id || !candidate.targetUserId || candidate.accountId!==current.accountId || candidate.nextEligibleAt>Date.now()
        || candidate.importedHold?.state || candidate.followResult?.attemptedAt || candidate.followResult?.followerRemoval?.attemptedAt
        || candidate.followResult?.queueScreening || !candidate.sources?.some(source=>source.enabled))continue;
      // Batch assembly is local-only. Missing/stale data never triggers a profile visit.
      await guard();
      if(await currentFanHold(candidate))continue;
      const cached=reviewProfileEvidence(await readCachedProfile(candidate.handle),{
        accountId:candidate.accountId,targetUserId:candidate.targetUserId,handle:candidate.handle});
      const other=cached.profile;
      if(!other || !Number.isFinite(other.profileObservedAt) || other.profileObservedAt>Date.now()
        || Date.now()-other.profileObservedAt>6*60*60*1000 || other.relationship?.following!==false
        || await fanRuleBypass(candidate,other))continue;
      if(!other.bio?.trim()&&!cached.posts.length)continue;
      const ratio=followerRatioDecision(other,settings.ratioLimit),otherProfile={...other,posts:cached.posts};
      if(!ratio.known || ratio.remove || detectLocalHardRule(otherProfile,selectQueueScreeningPosts(cached.posts,candidate.handle,10)).blocked)continue;
      const input=await screeningInput(candidate,otherProfile,other,role);
      if(JSON.stringify([...items.map(entry=>entry.item),input.item]).length>100000)break;
      items.push({job:candidate,...input});
    }
    const clockKey=`followQueueTaggingLastSubmitted:${current.accountId}`;
    const last=(await api.storage.local.get(clockKey))[clockKey] || 0;
    const delay=Math.max(0,last+(role.intervalSeconds || 0)*1000-Date.now());
    if(delay){if(Date.now()+delay>=control.deadline)throw Object.assign(new Error('打标批次间隔超过本轮时间预算'),{code:'QUEUE_BUDGET_EXHAUSTED'});await wait(delay);await guard();}
    const batch={id:crypto.randomUUID(),accountId:current.accountId,roleSnapshot:structuredClone(role),items,createdAt:Date.now(),relayJobId:''};
    await api.storage.local.set({[screeningBatchKey(current.accountId,batch.id)]:batch});
    for(const entry of items)await writeQueueScreening(entry.job,{batchId:batch.id,targetUserId:entry.item.targetUserId,inputDigest:entry.inputDigest,
      phase:'submitted',roleSnapshot:batch.roleSnapshot,submittedAt:Date.now()},current,control);
    await guard();
    await api.storage.local.set({[clockKey]:Date.now()});
    return finishQueueTagging(batch,current,control);
  }
  async function finishQueueTagging(batch,current,control) {
    let result=batch.receivedTagging;
    if(!result) {
      result=await tagging({role:'queueTagging',roleConfig:batch.roleSnapshot,items:batch.items.map(entry=>entry.item),relayJobId:batch.relayJobId,
      batchId:batch.id,ownerAccountId:batch.accountId,requestContext:{accountId:batch.accountId,batchId:batch.id,ruleVersion:1},connection:batch.connection,
      beforeSubmit:async()=>{
        if(!await control.canAct() || (await readBinding())?.accountId!==batch.accountId)return false;
        for(const entry of batch.items)if(await currentFanHold(entry.job,entry.item.targetUserId))return false;
        return true;
      },
      onRelayJobCreated:async receipt=>{
        batch.relayJobId=String(receipt?.id || receipt?.jobId || receipt || '');
        if(receipt?.connection)batch.connection=receipt.connection;
        await api.storage.local.set({[screeningBatchKey(batch.accountId,batch.id)]:batch});
        for(const entry of batch.items)await writeQueueScreening(entry.job,{batchId:batch.id,targetUserId:entry.item.targetUserId,inputDigest:entry.inputDigest,
          phase:'pending',roleSnapshot:batch.roleSnapshot,relayJobId:batch.relayJobId,submittedAt:batch.createdAt},current,control);
      }});
      // Persist paid-for results before any per-job checkpoint. If a later write
      // fails, restart applies this result without generating or polling again.
      if(result.ok===true) {
        batch.receivedTagging=structuredClone(result);
        await api.storage.local.set({[screeningBatchKey(batch.accountId,batch.id)]:batch});
      }
    }
    if((await readBinding())?.accountId!==batch.accountId)throw new Error('打标完成时队列账号已变化，结果未写入其他账号');
    batch.nextPollAt=result.pending?Date.now()+30000:0;
    if(result.relayJobId)batch.relayJobId=result.relayJobId;
    await api.storage.local.set({[screeningBatchKey(batch.accountId,batch.id)]:batch});
    let currentResult,allComplete=result.ok===true;
    for(const entry of batch.items) {
      const decision=result.results?.find(row=>canonical(row.handle)===entry.item.handle && row.targetUserId===entry.item.targetUserId);
      const screening={batchId:batch.id,targetUserId:entry.item.targetUserId,inputDigest:entry.inputDigest,roleSnapshot:batch.roleSnapshot,
        phase:result.pending?'pending':result.ok?'complete':result.submitted===false?'unsubmitted':(result.relayJobId || batch.relayJobId)?'pending':'unknown',
        relayJobId:result.relayJobId || batch.relayJobId || '',decision:decision?.decision || 'uncertain',valid:decision?.valid===true,
        tags:decision?.tags || [],evidence:decision?.evidence || [],reason:decision?.reason || result.error || '打标未返回有效结果',completedAt:Date.now()};
      const saved=(await readJob(batch.accountId,entry.job.id))?.followResult?.queueScreening;
      const alreadyComplete=saved?.phase==='complete' && saved.batchId===batch.id
        && saved.targetUserId===entry.item.targetUserId && saved.inputDigest===entry.inputDigest;
      if(!alreadyComplete && !await writeQueueScreening(entry.job,screening,current,control))allComplete=false;
      if(entry.job.id===current.id)currentResult=screening;
    }
    if(allComplete) {
      const key=screeningBatchKey(batch.accountId,batch.id);
      // Full profile/post snapshots are recovery data, not a permanent archive.
      // Failed cleanup preserves them; unresolved or partially saved batches are
      // never removed. Small per-job decisions and action receipts remain intact.
      try {
        if(typeof api.storage.local.remove==='function')await api.storage.local.remove(key);
        else await api.storage.local.set({[key]:null});
      } catch {}
    }
    return currentResult || {phase:'unknown',decision:'uncertain',reason:'打标批次未包含当前任务'};
  }
  async function reflectQueueRemoval(job,target,receipt,rule) {
    receipt={...receipt,accountId:job.accountId,ownerAccountId:job.accountId,targetUserId:target.id,removed:true,verifiedAt:receipt.verifiedAt || Date.now()};
    await recordRemovalTombstone(api.storage.local,job.accountId,{targetUserId:target.id,handle:job.handle,state:'removed',
      reason:rule.reason,tags:rule.tags || [],source:rule.source || 'queue'});
    await updateMonitorFanRows({records,storage:api.storage.local,accountId:job.accountId,targetUserId:target.id,handle:job.handle,createIfMissing:true,
      patch:previous=>({...previous,id:target.id,targetUserId:target.id,handle:job.handle,
        relationship:{...previous.relationship,...target.relationship,...receipt.live?.relationship,following:false,followedBy:false},
        state:'removed_follower',autoFollowState:'skipped',followerRemovedAt:new Date().toISOString(),followerRemoval:receipt,fanGrant:null,
        fanReview:{...previous.fanReview,state:'removed',ownerAccountId:job.accountId,targetUserId:target.id,source:rule.source || 'queue',
          tags:rule.tags || [],evidence:rule.evidence || [],reason:rule.reason,updatedAt:new Date().toISOString(),removalReceipt:receipt}})});
  }
  async function execute(job, settings, control) {
    const audit = {startedAt:new Date().toISOString(), posts:[], scanned:false, scrollRounds:0, plannedScrollRounds:settings.scrollRounds, grokEnabled:settings.grokEnabled, autoPublish:settings.autoPublish};
    audit.recentStages=[];
    const stage=name=>{audit.stage=name;audit.recentStages.push({stage:name,at:new Date().toISOString()});audit.recentStages=audit.recentStages.slice(-12);};
    stage('open-profile');
    executionAudits.set(job.id,audit);
    let tab, detachAbort = () => {};
    let followResult = job.followResult || {};
    let attemptedFollow = false;
    const evaluations = [...(job.evaluations || [])];
    async function guard() {
      if (!await control.canAct()) throw new Error('任务已暂停、账号变化或时间预算耗尽');
      const binding = await readBinding();
      const hold=await currentFanHold(job);
      if(hold && !followResult.followerRemoval?.attemptedAt)throw new Error(hold);
      if (tab) await waitForQueueViewer({read:()=>viewer(tab.id),expected:binding?.handle,wait,check:async()=>{if(!await control.canAct())throw new Error('任务已暂停、账号变化或时间预算耗尽');}});
    }
    try {
      tab = await queueTabs.acquire(job.id, () => createProfileTab(api,{url:`https://x.com/${encodeURIComponent(job.handle)}`, active:false},'follow-queue',{jobId:job.id,runId:control.runId,signal:control.signal,deadline:control.deadline,check:guard}), `https://x.com/${encodeURIComponent(job.handle)}`);
      const closeOnAbort = () => { queueTabs.release(job.id).catch(() => {}); };
      control.signal?.addEventListener('abort', closeOnAbort, {once:true});
      detachAbort = () => control.signal?.removeEventListener('abort', closeOnAbort);
      if (control.signal?.aborted) throw new Error('任务已中断');
      const initialReviewSettings=await readReviewSettings(api.storage.local,job.accountId);
      const initialPostLimit=initialReviewSettings.followBackSkipRules && authorizedFanGrant(job,job.targetUserId) ? 0 : 20;
      const loaded = await readQueueProfile({handle:job.handle,
        readDom:()=>script(tab.id,readProfileBundle,[job.handle,initialPostLimit]),
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
      const unavailable=unavailableFromProfileResponse(lookup);
      if (['not_found','suspended'].includes(unavailable?.status)) return {state:'excluded',reason:unavailable.reason,followResult:{...followResult,availability:unavailable.status,reason:unavailable.reason,checkedAt:Date.now()}};
      if (lookup.status!==200 || lookup.error) return {state:'retry',reason:lookup.error || `用户资料请求返回 ${lookup.status}`};
      if (!target?.id) {await observeProfile(api,job.handle,{status:'identity_unresolved',reason:'无法解析目标用户 ID'},'queue-identity');return {state:'uncertain',reason:'账号资料待核实，已暂停自动请求'};}
      if (job.targetUserId && job.targetUserId !== target.id) return {state:'excluded',reason:'账号名称对应的用户 ID 已变化'};
      target.relationship=queueExecutionRelationship(target,profile);
      if (profile.pendingRequestUserId === target.id) {
        const reason='主页确认关注请求等待对方批准，跳过重复关注';
        return {state:'uncertain',reason,followResult:{...followResult,followRequestPending:true,targetUserId:target.id,reason,verifiedAt:Date.now()}};
      }
      if (target.relationship?.following === false && followResult.succeeded) {
        followResult = {...followResult, succeeded:false, following:false, verifiedAt:Date.now()};
      }
      stage('verify-relationship');
      const bypassSourceRules=await fanRuleBypass(job,target);
      const relationshipDecision = {...queueRelationshipDecision(job, target.relationship), checkedAt:Date.now(),
        targetUserId:target.id, source:lookup.source || 'profile-api'};
      if(bypassSourceRules&&target.relationship?.following===false&&target.relationship?.followRequestSent!==true){
        relationshipDecision.code=target.relationship.followedBy===true?'follow-back':'approved-fan';
        relationshipDecision.reason='粉丝渠道前置审核已通过，跳过重复筛选与审核';
      }
      audit.relationshipDecision = relationshipDecision;
      followResult = {...followResult, relationshipDecision};
      await control.checkpoint({followResult});
      if (followResult.followerRemoval?.attemptedAt) {
        const removed=target.relationship?.followedBy===false && target.relationship?.following===false;
        const receipt={...followResult.followerRemoval,accountId:job.accountId,ownerAccountId:job.accountId,targetUserId:target.id,removed,verifiedAt:Date.now()};
        if(removed)await reflectQueueRemoval(job,target,receipt,receipt.policy || {reason:'已核实移除此关注者',source:'queue-recovery'});
        return {state:removed?'skipped':'uncertain',followResult:{...followResult,followerRemoval:receipt},reason:removed?'已核实移除此关注者，跳过回关':'移除关注者结果待核实，禁止自动重复提交'};
      }
      if(followResult.attemptedAt && !followResult.succeeded && target.relationship?.following!==true)return {state:'uncertain',reason:'已有关注提交记录，结果待核实，禁止自动重复提交',followResult};
      if (relationshipDecision.code === 'request-pending' || (target.protected === true && target.relationship?.following !== true && target.relationship?.followRequestSent !== false)) {
        const reason = relationshipDecision.code === 'request-pending' ? relationshipDecision.reason : '受保护账号的关注请求状态不明确，等待核实，未发送关注';
        return {state:'uncertain',reason,followResult:{...followResult,reason,followRequestPending:relationshipDecision.code === 'request-pending'}};
      }
      if (relationshipDecision.code === 'relationship-unknown') {
        return {state:'uncertain', reason:relationshipDecision.reason, followResult};
      }
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
      if (duplicates.length) return {state:'uncertain',reason:'资料合并存在其他记录，需要核对'};
      if (target.relationship?.following === true || (target.relationship?.following !== false && profile.relationship?.following === true)) {
        return {state:'followed',followResult:{...followResult,succeeded:true,alreadyFollowing:true,targetUserId:target.id,at:Date.now()},evaluations};
      }
      const reviewSettings=await readReviewSettings(api.storage.local,job.accountId);
      const tombstone=findRemovalTombstone(await readRemovalTombstones(api.storage.local,job.accountId),{targetUserId:target.id,handle:job.handle});
      if(tombstone)return {state:'skipped',reason:tombstone.reason || '该账号已被移除或排除',followResult};
      stage('read-posts');
      const dwell = bypassSourceRules ? 0 : randomizedSeconds(settings.dwellSeconds, settings.dwellJitter, 2, 60);
      async function collectExecutionPosts() {
      const observedPosts = new Map();
      const rememberPosts = bundle => {
        for (const post of bundle?.posts || []) {
          if (!post.isPinned && post.url && (observedPosts.has(post.url) || observedPosts.size < 20)) observedPosts.set(post.url,post);
        }
      };
      rememberPosts(profile);
      for (let round=0; round<(!bypassSourceRules || settings.grokEnabled ? settings.scrollRounds : 0); round++) {
        await guard();
        await script(tab.id,simulateProfileScrollStep,[round,420]);
        audit.scrollRounds = round + 1;
        await wait(dwell * 1000 / settings.scrollRounds);
        if (!bypassSourceRules || settings.grokEnabled) rememberPosts(await script(tab.id,readProfileBundle,[job.handle,20]));
      }
      const fresh = !bypassSourceRules || settings.grokEnabled ? await script(tab.id,readProfileBundle,[job.handle,20]) : null;
      if (fresh && !fresh.pending) profile = {...profile,...fresh};
      rememberPosts(profile);
      if (!bypassSourceRules || settings.grokEnabled) {
        let timeline;
        try {timeline=await readScoredPosts({api,tabId:tab.id,userId:target.id,handle:job.handle,guard});}
        catch(error){audit.postReadError=error.message;if(error.status===429||isAccessDeferred(error))throw error;}
        if(timeline?.posts.length){profile.posts=timeline.posts;audit.postSelectionSource=timeline.source;audit.excludedPinnedPostIds=timeline.pinnedIds;}
        else {
        let unchanged=0;
        for (let round=0; observedPosts.size<(settings.grokEnabled?20:10) && unchanged<2 && round<20; round++) {
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
      }
      if(!bypassSourceRules)await collectExecutionPosts();
      stage('save-profile');
      let reusedTimeline=null;
      if(!bypassSourceRules&&!profile.posts?.length){
        const cached=reviewProfileEvidence(await readCachedProfile(job.handle),{accountId:job.accountId,handle:job.handle,targetUserId:target.id});
        const completePosts=cached.posts.filter(post=>post.textComplete!==false);
        if(completePosts.length){profile={...profile,posts:completePosts};reusedTimeline=cached.profile.fanInspectionTimeline;}
      }
      const observedAt=Date.now(),screeningPosts=cachedReviewPosts(profile.posts,job.handle);
      await saveProfile(job.handle,{...profile,id:target.id,targetUserId:target.id,profileObservedAt:observedAt,
        profileEvidence:{...inspectionProfilePatch({...target,bio:profile.bio||target.bio},job.accountId,observedAt).profileEvidence,source:'follow-queue'},
        ...(screeningPosts.length?{fanInspectionTimeline:reusedTimeline||{ownerAccountId:job.accountId,targetUserId:target.id,
          fetchedAt:observedAt,status:screeningPosts.length>=10&&screeningPosts.every(post=>post.textComplete!==false)?'ready':'partial',posts:screeningPosts,source:'follow-queue'}}:{})},target.id);
      async function removeForRule(rule) {
        rule={...rule,source:rule.source || 'queue-local'};
        if(target.relationship?.followedBy!==true) {
          await recordRemovalTombstone(api.storage.local,job.accountId,{targetUserId:target.id,handle:job.handle,state:'excluded',reason:rule.reason,tags:rule.tags || [],source:rule.source});
          return {state:'skipped',reason:rule.reason,followResult:{...followResult,exclusion:rule}};
        }
        stage('remove-follower');
        const binding=await readBinding();
        const receipt=await removeFollower({api,tabId:tab.id,handle:job.handle,targetId:target.id,owner:binding.handle,wait,ratioLimit:reviewSettings.ratioLimit,
          policy:live=>rule.category==='ratio' ? followerRatioDecision(live,reviewSettings.ratioLimit)
            : rule.source==='queue-ai' ? {remove:true,reason:rule.reason}
              : {...detectLocalHardRule({...profile,...live},selectQueueScreeningPosts(profile.posts,job.handle,10)),remove:detectLocalHardRule({...profile,...live},selectQueueScreeningPosts(profile.posts,job.handle,10)).blocked},
          readProfile:async()=>{const response=await fetchProfile(tab.id,job.handle,{preferPageResponse:false});return response.status===200&&parseNetworkUsers(response.json).find(user=>canonical(user.handle)===canonical(job.handle));},
          canAct:async()=>{await guard();return !await fanRuleBypass((await readJob(job.accountId,job.id)) || job,target);},
          checkpoint:async intent=>{
            followResult={...followResult,followerRemoval:{...intent,policy:rule}};
            await control.checkpoint({stage:'remove-follower',followResult});
            await recordRemovalTombstone(api.storage.local,job.accountId,{targetUserId:target.id,handle:job.handle,state:'uncertain',reason:rule.reason,tags:rule.tags || [],source:rule.source});
          }});
        followResult={...followResult,followerRemoval:{...followResult.followerRemoval,...receipt,accountId:job.accountId,ownerAccountId:job.accountId,targetUserId:target.id,live:undefined,policy:rule,verifiedAt:Date.now()}};
        await control.checkpoint({followResult});
        if(receipt.removed)await reflectQueueRemoval(job,target,receipt,rule);
        return {state:receipt.removed?'skipped':'uncertain',reason:receipt.removed?rule.reason:receipt.reason,followResult};
      }
      if(!bypassSourceRules) {
        const hard=detectLocalHardRule({...profile,...target,bio:profile.bio || target.bio},selectQueueScreeningPosts(profile.posts,job.handle,10));
        if(hard.blocked)return removeForRule(hard);
        const ratio=followerRatioDecision(target,reviewSettings.ratioLimit);
        if(!ratio.known)return {state:'uncertain',reason:ratio.reason,followResult};
        if(ratio.remove)return removeForRule({...ratio,category:'ratio',tags:['异常关注比例']});
        stage('queue-tagging');
        const screening=await prepareQueueTagging(job,profile,target,reviewSettings,control,guard);
        followResult={...(await readJob(job.accountId,job.id))?.followResult,queueScreening:screening};
        if(screening.phase!=='complete' || !screening.valid || screening.decision==='uncertain')return {state:['pending','unconfigured','unsubmitted','stale'].includes(screening.phase)?'retry':'uncertain',reason:screening.reason,followResult};
        const hardTags=screening.tags?.some(tag=>/宗教|军事|政治|武装|恐怖|religio|military|politic|terror/i.test(String(tag)));
        if(screening.decision==='remove' || hardTags)return removeForRule({...screening,source:'queue-ai'});
        if(screening.decision!=='pass')return {state:'uncertain',reason:screening.reason || 'AI 未确认准入通过，未执行关注',followResult};
      }
      const reason=bypassSourceRules ? '' : assessQueueProfile({...profile,...target,bio:profile.bio || target.bio,posts:selectQueueScreeningPosts(profile.posts,job.handle,10)},settings);
      audit.relationshipDecision = {...relationshipDecision, allowAll:bypassSourceRules,
        screening:reason ? 'blocked' : 'allowed', screeningReason:reason || (bypassSourceRules ? '跳过粉丝已授权' : '完整筛选通过')};
      followResult = {...followResult, relationshipDecision:audit.relationshipDecision};
      if (reason) return {state:'skipped',reason,followResult};
      await guard();
      const finalBlueDecision = bypassSourceRules ? null : blueVerifiedDecision(target, (await store.getSettings(job.accountId)).blueVerifiedOnly === true);
      if (finalBlueDecision) return {...finalBlueDecision,followResult:{...followResult,targetUserId:target.id,reason:finalBlueDecision.reason}};
      const finalLookup=await fetchProfile(tab.id,job.handle,{preferPageResponse:false});
      await guard();
      const finalUnavailable=unavailableFromProfileResponse(finalLookup);
      if(['not_found','suspended'].includes(finalUnavailable?.status))return {state:'excluded',reason:finalUnavailable.reason,followResult:{...followResult,availability:finalUnavailable.status,reason:finalUnavailable.reason,checkedAt:Date.now()}};
      const finalTarget=finalLookup.status===200 && parseNetworkUsers(finalLookup.json).find(user=>canonical(user.handle)===canonical(job.handle));
      if(finalTarget?.id!==target.id)return {state:'uncertain',reason:'执行前目标账号未能再次确认，未发送关注',followResult};
      const finalPage=await readProfileOnTab(api,tab.id,job.handle,0,'queue-follow-button');
      await guard();
      if(['not_found','suspended'].includes(finalPage?.status))return {state:'excluded',reason:finalPage.reason,followResult:{...followResult,availability:finalPage.status,reason:finalPage.reason,checkedAt:Date.now()}};
      finalTarget.relationship=queueExecutionRelationship(finalTarget,finalPage);
      if(finalTarget.relationship.followRequestSent===true)return {state:'uncertain',reason:'关注请求已发送，等待对方确认，跳过重复关注',followResult:{...followResult,followRequestPending:true}};
      if(finalTarget.relationship?.following===true)return {state:'followed',followResult:{...followResult,succeeded:true,alreadyFollowing:true,targetUserId:target.id,at:Date.now()},evaluations};
      if(finalTarget.relationship?.following!==false || finalTarget.relationship?.followRequestSent===true)return {state:'uncertain',reason:'执行前关注关系不明确或请求已发送，未重复关注',followResult};
      const finalRelationship=queueRelationshipDecision((await readJob(job.accountId,job.id)) || job,finalTarget.relationship);
      if(finalRelationship.code==='relationship-unknown' || finalRelationship.code==='request-pending'
        || finalTarget.protected===true && finalTarget.relationship?.followRequestSent!==false)return {state:'uncertain',reason:finalRelationship.reason || '执行前关系待核实',followResult};
      if(findRemovalTombstone(await readRemovalTombstones(api.storage.local,job.accountId),{targetUserId:target.id,handle:job.handle}))return {state:'skipped',reason:'提交前排除状态已变化，未发送关注',followResult};
      if(bypassSourceRules && !await fanRuleBypass((await readJob(job.accountId,job.id)) || job,finalTarget))return {state:'retry',reason:'跳过粉丝条件已变化，等待完整筛选',followResult};
      if(!bypassSourceRules) {
        const blue=blueVerifiedDecision(finalTarget,(await store.getSettings(job.accountId)).blueVerifiedOnly===true);
        if(blue)return {...blue,followResult};
        const finalProfile={...profile};
        for(const field of ['name','bio'])if(finalTarget[field]!==target[field])finalProfile[field]=finalTarget[field];
        const finalInput=await screeningInput(job,finalProfile,finalTarget,followResult.queueScreening.roleSnapshot);
        if(finalInput.inputDigest!==followResult.queueScreening.inputDigest)return {state:'retry',reason:'执行前资料已变化，等待重新筛选',followResult};
      }
      followResult={...followResult,attemptedAt:Date.now(),targetUserId:target.id};
      await control.checkpoint({stage:'following',followResult});
      await guard();
      if(findRemovalTombstone(await readRemovalTombstones(api.storage.local,job.accountId),{targetUserId:target.id,handle:job.handle}))return {state:'uncertain',reason:'关注提交检查点后排除状态已变化，未发送请求',followResult};
      if(bypassSourceRules && !await fanRuleBypass((await readJob(job.accountId,job.id)) || job,finalTarget))return {state:'uncertain',reason:'关注提交检查点后放行凭据已变化，未发送请求',followResult};
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
      // Follow first. Optional post selection cannot delay or roll back the follow.
      if(bypassSourceRules)await collectExecutionPosts();
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
      const post = highestScoredPost(quoteCandidates(job.handle,eligiblePosts,profile.name,profile,{bypassSourceRules}).candidates);
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
      if(control.signal?.aborted&&Date.now()<control.deadline)return {state:followResult.succeeded?'followed':attemptedFollow?'uncertain':'pending',paused:true,followResult,evaluations,reason:'队列已暂停，已保存进度'};
      if(isAccessDeferred(error))return {state:followResult.succeeded?'followed':attemptedFollow?'uncertain':'retry',
        accessDeferred:true,retryAt:error.retryAt,rateLimited:true,profileReadLimited:true,followResult,evaluations,reason:error.message};
      if(error.code==='QUEUE_BUDGET_EXHAUSTED' || (control.signal.aborted && Date.now()>=control.deadline)) return {state:followResult.succeeded?'followed':attemptedFollow?'uncertain':'retry',budgetExhausted:true,followResult,evaluations,reason:'本轮时间已用完，留待下轮继续'};
      if(error.code==='X_PROFILE_IDENTITY_UNRESOLVED'&&!attemptedFollow&&!followResult.succeeded)return {state:'uncertain',reason:error.message,followResult:{...followResult,reason:error.message}};
      if(error.code==='X_PROFILE_UNAVAILABLE'&&!attemptedFollow&&!followResult.succeeded)return {state:'excluded',reason:error.message,followResult:{...followResult,availability:error.availability,reason:error.message,checkedAt:Date.now()}};
      const failure=await diagnostics.record(error,{deferLog:true,stage:audit.stage,manual:control.manual,accountId:job.accountId,targetUserId:job.targetUserId,retryCount:job.followResult?.retryCount,settings,jobId:job.id,runId:control.runId,handle:job.handle,requestedUrl:`https://x.com/${encodeURIComponent(job.handle)}`,tabId:tab?.id,recentStages:audit.recentStages,followAttempted:attemptedFollow,followSucceeded:followResult.succeeded});
      if(runFailures)runFailures.push(failure);
      audit.diagnostic=failure.diagnostic;
      const profileReadLimited = error.code === 'X_PROFILE_READ_LIMIT' && !attemptedFollow;
      return {state:followResult.succeeded ? 'followed' : attemptedFollow ? 'uncertain' : 'retry',followResult,evaluations,
        rateLimited:profileReadLimited,profileReadLimited,diagnostic:failure.diagnostic,reason:failure.message};
    } finally { detachAbort(); audit.finishedAt = new Date().toISOString(); audit.evaluations = structuredClone(evaluations); if (tab) await queueTabs.release(job.id).catch(error => { audit.tabCleanupError = String(error?.message || error); }); }
  }
  let reflectJobs = null,runFailures=null,runPromise=null;
  const scheduler = createFollowQueueScheduler({store,execute,canRun,getBlockReason:()=>runBlockReason,onEvent:async event => {
    if (event.type === 'run-start') await alarmPlan.record(event.accountId,{lastRunId:event.runId,lastRunAt:event.at || Date.now()});
    const job = event.jobId ? await readJob(event.accountId, event.jobId) || {} : {};
    if (reflectJobs && (event.type === 'job-complete' || event.state === 'followed') && (event.state === 'followed' || event.followResult?.succeeded)) {
      reflectJobs.push({handle:event.handle || job.handle, followResult:event.followResult || job.followResult, updatedAt:event.at || job.updatedAt});
    }
    if (event.type === 'job-start') executionAudits.delete(event.jobId);
    const audit = executionAudits.get(event.jobId) || {};
    await appendExecutionLog(normalizeQueueExecutionLog(event,job,audit),api.storage.local);
    if (event.type === 'job-complete') await alarmPlan.record(event.accountId,{lastJobAt:event.at || Date.now(),lastJobHandle:event.handle || job.handle});
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
  async function withVerifiedXTab(binding, work,preferredHandle='') {
    if(readAccount){const account=await readAccount();if(!account||String(account.id)!==String(binding.accountId))throw Error('账号模块尚未确认当前队列账号');}
    const tabs = await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    if(preferredHandle)tabs.sort((a,b)=>Number(String(b.url||'').replace(/\/$/,'').toLowerCase()===`https://x.com/${preferredHandle}`)-Number(String(a.url||'').replace(/\/$/,'').toLowerCase()===`https://x.com/${preferredHandle}`));
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
  async function reconcileFan(binding, {handle, inspectOnly = false, signal, expectedTargetUserId} = {}) {
    signal?.throwIfAborted();
    const key = canonical(handle);
    if (!key || !/^[a-z0-9_]{1,15}$/.test(key)) throw new Error('无效粉丝账号');
    if (!inspectOnly && binding.sources?.fans !== true) throw new Error('粉丝来源未启用');
    if (!records) throw new Error('粉丝档案不可用');
    let queueRows = await records.lookupAll({sourceKey:'monitor', bucket:'queue', handle:key});
    let allRows = inspectOnly ? (await Promise.all(['users','queue','followingUsers'].map(bucket => records.lookupAll({sourceKey:'monitor',bucket,handle:key})))).flat() : queueRows;
    if(expectedTargetUserId){
      if(!/^\d+$/.test(expectedTargetUserId))throw new Error('目标用户 ID 无效');
      const legacyOwner=await records.fanReviewOwner?.();
      const owns=row=>{
        const payload=row.payload||{},claims=[payload.accountId,payload.ownerAccountId,payload.fanReview?.ownerAccountId,payload.fanGrant?.ownerAccountId].filter(id=>id&&id!=='unassigned');
        return !claims.some(id=>id!==binding.accountId)&&(row.accountId===binding.accountId||row.accountId==='unassigned'&&legacyOwner===binding.accountId);
      };
      queueRows=queueRows.filter(owns);allRows=allRows.filter(owns);
      if(allRows.some(row=>row.payload?.id&&String(row.payload.id)!==expectedTargetUserId))throw new Error('粉丝档案目标用户 ID 已变化');
    }
    const frozenIdentity=row=>expectedTargetUserId?{accountId:row.accountId,userKey:row.userKey,expectedTargetUserId,expectedOwnerAccountId:binding.accountId}:{};
    signal?.throwIfAborted();
    if (!allRows.length) throw new Error('粉丝档案不存在');
    return withVerifiedXTab(binding, async tab => {
      signal?.throwIfAborted();
      const readTarget = async () => typeof fetchUser === 'function'
        ? await fetchUser(tab.id, key)
        : await (async () => {
            const lookup = await fetchProfile(tab.id, key);
            if (lookup.status === 429) throw profileReadLimitError(lookup);
            if (lookup.status !== 200) {
              const error=new Error(lookup.error || `关系读取失败 HTTP ${lookup.status}`);
              error.status=lookup.status;error.code='FAN_INSPECTION_NETWORK';throw error;
            }
            return lookup.status === 200
              ? parseNetworkUsers(lookup.json).find(user => canonical(user.handle) === key) : null;
          })();
      let target=await readTarget();
      const complete=value=>value?.id&&value.relationshipKnown===true
        &&typeof value.relationship?.following==='boolean'&&typeof value.relationship?.followedBy==='boolean';
      // A successful HTTP response can still omit viewer relationship fields.
      // Retry the read once, never loop or repeat a follow/remove operation.
      if(!complete(target)){
        signal?.throwIfAborted();await wait(1000);signal?.throwIfAborted();
        target=await readTarget();
      }
      signal?.throwIfAborted();
      if(expectedTargetUserId&&target?.id&&target.id!==expectedTargetUserId)throw new Error('关系核验返回的目标账号记录不一致');
      if (!target?.id || target.relationshipKnown !== true
        || typeof target.relationship.followedBy !== 'boolean'
        || typeof target.relationship.following !== 'boolean') {
        const reason=target?.id?'X 未返回完整关注关系，已重试一次，请稍后重试':'X 未返回该账号资料，已重试一次，请确认账号是否可访问';
        if(inspectOnly) {
          await records.batch({sourceKey:'monitor',changes:allRows.map(row=>({handle:key,sourceBucket:row.sourcePath?.[1] || 'queue',...frozenIdentity(row),patch:{
            relationship:{following:null,followedBy:null},relationshipKnown:false,state:'unknown',status:'unknown',relationshipVerifiedAt:new Date().toISOString(),
            fanInspectionFailure:{code:target?.id?'relationship_incomplete':'profile_missing',reason,at:Date.now()}
          }}))});
          const pending=await priorByHandle(binding.accountId,key);
          signal?.throwIfAborted();
          if(typeof target?.relationship?.following!=='boolean' && pending && ['pending','retry'].includes(pending.state)) await store.resolveJob({accountId:binding.accountId,id:pending.id,state:'uncertain',stage:'uncertain',
            followResult:{...(pending.followResult || {}),reason:'X 关系字段不完整或相互冲突，暂停粉丝回关任务'}});
        }
        throw Object.assign(new Error(`无法核实 @${key} 的完整关注关系：${reason}`),{code:'FAN_INSPECTION_INCOMPLETE'});
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
      const identityHistory=mismatched.length>0||allRows.some(row=>row.payload?.legacyHandleIdentityConflict||row.payload?.legacyHandleIdentityHistory);
      if (inspectOnly && job && !job.targetUserId && identityHistory) job=null;
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
      } else if (!inspectOnly && followedBy && !following && job?.state === 'skipped'
        && /^关注\/粉丝比例低于 \d+%$/.test(String(job.followResult?.reason || ''))) {
        const resolved = await store.resolveJob({accountId:binding.accountId,id:job.id,state:'pending',stage:'queued',nextEligibleAt:stamp,
          followResult:{targetUserId:target.id,verifiedAt:stamp,reason:'X 关系核实待回关，恢复比例门槛跳过任务'}});
        if (!resolved?.ok) throw new Error(`恢复 @${key} 待回关任务失败`);
        result = 'reopened';
      }
      const observedProfile=inspectionProfilePatch(target,binding.accountId,stamp);
      const changes = allRows.map(row => ({handle:key,sourceBucket:row.sourcePath?.[1] || 'queue',
        ...frozenIdentity(row),patch:{...observedProfile,
        relationship:{...(row.payload?.relationship || {}),following,followedBy},relationshipKnown:true,
        status:following ? 'followed' : followedBy ? 'pending' : 'no_longer_following',
        state:following ? 'following' : followedBy ? 'follow_back' : 'no_longer_following',
        relationshipVerifiedAt:new Date(stamp).toISOString(),fanInspectionFailure:null,
        ...(inspectOnly&&!expectedTargetUserId&&row.payload?.fanReview?.decision==='uncertain'&&row.payload.fanReview.enrichmentCompletedAt
          ?{fanReview:{...row.payload.fanReview,state:'verify',source:'manual-verification',enrichmentStartedAt:stamp,enrichmentCompletedAt:0,retryAt:0,
            decisionVersion:(Number(row.payload.fanReview.decisionVersion)||0)+1,updatedAt:stamp}}:{}),
        ...(inspectOnly?{legacyHandleIdentityConflict:false,...(identityHistory?{legacyHandleIdentityHistory:true}:{})}:{})
      }}));
      signal?.throwIfAborted();
      await records.batch({sourceKey:'monitor',changes});
      signal?.throwIfAborted();
      if (following && job) await reflectFollowed(binding.accountId,[{...job,followResult:{...(job.followResult || {}),at:stamp},updatedAt:stamp}]);
      let profileCollection;
      if(following||followedBy){
        try{profileCollection=await fanProfiles.observe(target,binding.accountId);}catch(error){profileCollection={profile:'failed',posts:'not-collected',reason:error.message};}
      }
      let reviewTransition;
      try{reviewTransition=await onFanRelationChanged({accountId:binding.accountId,handle:key,targetUserId:target.id,manualVerification:inspectOnly&&!expectedTargetUserId});}
      catch(error){reviewTransition={state:'verify',ready:false,reason:'审核状态更新未完成：'+error.message};}
      return {ok:true,handle:key,relationship:{followedBy,following},jobState:result,profileCollection,...(reviewTransition?{reviewTransition}:{})};
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
      const hold=await currentFanHold(latest);
      if(hold)throw new Error(hold);
      if(findRemovalTombstone(await readRemovalTombstones(api.storage.local,binding.accountId),{targetUserId:latest.targetUserId,handle:latest.handle}))throw new Error('该账号已被排除，未继续评论');
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
    async function verifyCommentTarget() {
      await guardComment();
      if(!/^\d+$/.test(String(job.targetUserId || '')))throw new Error('评论目标缺少稳定用户 ID，未发送生成或发布请求');
      if(targetEval?.originalAuthorId && String(targetEval.originalAuthorId)!==String(job.targetUserId))throw new Error('原帖作者账号与评论目标不一致，未发送请求');
      const response=await fetchProfile(tab.id,job.handle,{preferPageResponse:false});
      await guardComment();
      const target=response.status===200 && parseNetworkUsers(response.json).find(user=>canonical(user.handle)===canonical(job.handle));
      if(target?.id!==job.targetUserId)throw new Error('评论目标账号未能核实或已变化，未发送请求');
      if(target.relationship?.following!==true)throw new Error('评论目标当前关注关系未能核实，未发送请求');
      return target;
    }
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
      // A comment retry can reuse a fan admission decision only after confirming
      // the same owner, stable identity and current follower relationship.
      let bypassSourceRules=false;
      if(authorizedFanGrant(job,job.targetUserId)) {
        const target=await verifyCommentTarget();
        bypassSourceRules=await fanRuleBypass(job,target);
      }
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
      if (!bypassSourceRules && interactionReason) {
        ev.status = 'skipped';
        ev.reason = interactionReason;
        const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        return {ok:true,summary:interactionReason,job:saved.job,evaluation:ev};
      }
      if (!bypassSourceRules && safetyRisk.level === 'danger') {
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
        const selection = quoteCandidates(job.handle,initialCandidates,safetyProfile.name,safetyProfile,{bypassSourceRules});
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
        if (!bypassSourceRules && sourceInteractionReason) {
          ev.status='skipped'; ev.reason=sourceInteractionReason; ev.reasonCode='interaction_scope'; ev.grokCalls=0;
          const saved=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          return {ok:true,job:saved.job,evaluation:ev,summary:ev.reason};
        }
        const reviewSettings=await readReviewSettings(api.storage.local,binding.accountId);
        const commentEngine=ev.relayJobId ? (ev.commentEngine || null) : reviewSettings.commentEngine;
        if(!ev.relayJobId && (!['grok-local','codex','antigravity'].includes(commentEngine?.provider) || !commentEngine?.botId)) {
          ev.status='failed';ev.reasonCode='comment_engine_unconfigured';ev.reason='评论引擎未配置独立 AI 引擎与会话';
          const saved=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          return {ok:false,error:ev.reason,job:saved.job,evaluation:ev,summary:ev.reason};
        }
        if(commentEngine)ev.commentEngine=structuredClone(commentEngine);
        ev.generationAttemptedAt = Date.now();
        ev.candidatePosts = candidates;
        ev.reasonCode = 'generation_started';
        const started = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        if (!started.ok) throw new Error('未能保存 Grok 请求状态，未发送请求');
        if(!ev.relayJobId)await verifyCommentTarget();
        const generate=({reply:generateReply,article:generateArticle,original:generatePost})[publicationMode]||generateComment;
        progress('已按综合互动分选帖，Grok 正在生成内容…');
        const generated = await generate(job.handle,candidates,job.handle,{sleep,profile:safetyProfile,writerAccountId:job.accountId,commentEngine,bypassSourceRules,connection:ev.connection,knowledgePurpose:['quote','reply'].includes(publicationMode)?publicationMode:'article',
          qualityFirst:true,qualityGate:!['quote','reply'].includes(publicationMode),lengthMode:commentSettings.quoteLengthMode || 'adaptive',relayJobId:ev.relayJobId,knowledgeSnapshot:ev.knowledgeSnapshot,
          onRelayJobCreated:async relay=>{
            await guardComment();
            Object.assign(ev,{...(relay.commentEngine?{commentEngine:relay.commentEngine}:{}),...(relay.connection?{connection:relay.connection}:{}),...(relay.knowledgeUsed?{knowledgeUsed:relay.knowledgeUsed}:{}),...(relay.knowledgeSnapshot?{knowledgeSnapshot:relay.knowledgeSnapshot}:{}),relayJobId:relay.id,channel:'grok-bot',reasonCode:'bot_pending'});
            const checkpoint=await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
            if(!checkpoint.ok)throw new Error('未能保存 Bot 任务编号，未发送生成请求');
          }});
        if(generated.knowledgeUsed)ev.knowledgeUsed=generated.knowledgeUsed;
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
      if (!bypassSourceRules && finalInteractionReason) {
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
        const currentTarget=await verifyCommentTarget();
        if(bypassSourceRules && !await fanRuleBypass((await readJob(binding.accountId,job.id)) || job,currentTarget))throw new Error('评论提交前放行凭据已变化，草稿已保留');
        if (automatic && !(await store.getSettings(binding.accountId)).autoPublish) throw new Error('自动发布已关闭，未提交');
      };
      const published = publicationMode==='article'
        ? await articles.publish({owner:binding.handle,article:{...ev.article,body:ev.text},canPublish:async()=>{await beforePublish();return true;}})
        : publicationMode==='reply' ? await replies.publish({owner:binding.handle,sourcePostUrl:ev.originalPostUrl,text:ev.text,canPublish:async()=>{await beforePublish();return true;}})
        : publicationMode==='original'
        ? await publishing.publish({owner:binding.handle,text:ev.text,sourceText:ev.originalPostText,canPublish:async()=>{await beforePublish();return true;}})
        : await postQuoteOnTab(tab.id,post,ev.text,publishQuotePostOnPage,sleep,{beforePublish,bypassSourceRules});
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
    botAvailable:async(job,ev)=>{
      const role=ev?.relayJobId ? ev.commentEngine : (await readReviewSettings(api.storage.local,job.accountId)).commentEngine;
      return Boolean(ev?.relayJobId || ['grok-local','codex','antigravity'].includes(role?.provider));
    },
    onSkip:entry=>safeLog({...entry,scope:'comment',result:'skipped',detail:entry.reason,at:new Date().toISOString()}),
    isBusy:job => commentLocks.has(job.accountId+':'+job.id)});
  async function scheduleRetryBatch(delayMs = 5*60000) {
    const binding = await readBinding();
    if (!binding?.activated || !store.pendingRetryBatch) return;
    if (await store.pendingRetryBatch(binding.accountId)) {
      const alarm = await api.alarms.get(RETRY_BATCH_ALARM);
      const when = Date.now()+delayMs;
      if (!alarm || (delayMs === 1 && alarm.scheduledTime > when)) await api.alarms.create(RETRY_BATCH_ALARM, {when});
    } else await api.alarms.clear(RETRY_BATCH_ALARM);
  }
  async function runRetryBatch() {
    // A one-shot alarm is already consumed. Recreate it if the shared worker is busy.
    if (runPromise) { await scheduleRetryBatch(30000); return {ok:true,summary:'当前任务结束后处理重试批次'}; }
    const binding = await readBinding();
    if (!binding?.activated || !await store.pendingRetryBatch(binding.accountId)) return {ok:true};
    try { return await run(true, true); }
    finally { await scheduleRetryBatch(5*60000); }
  }
  async function schedule({reset = false, reason = 'ensure'} = {}) {
    const binding = await readBinding();
    if (!binding?.activated) return;
    await api.alarms.create(COMMENT_ALARM,{periodInMinutes:1}).catch(error=>console.warn('评论调度创建失败:',error.message));
    // Queue takeover is durable, including when its own enabled switch is off.
    await api.alarms.clear('x-mutual-auto-follow');
    await api.alarms.clear('x-comment-auto-follow');
    const settings = await store.getSettings(binding.accountId);
    await alarmPlan.schedule(binding.accountId,settings,{reset,reason});
    await scheduleRetryBatch();
  }
  async function run(manual=false,retryBatchOnly=false){
    if(runPromise)return {ok:false,notify:false,summary:'队列正在执行，已跳过重复触发。'};
    const stopActivity = startQueueActivity(api);
    runPromise=runCycle(manual,retryBatchOnly);try{return await runPromise;}finally{stopActivity();runPromise=null;}
  }
  async function runCycle(manual = false, retryBatchOnly = false) {
    const binding = await readBinding();
    if (!binding?.activated) throw new Error('请先确认统一队列的数据归属和来源');
    // Create only one temporary tab if a scheduled task has no X tab available.
    let bootstrap,runStage='bootstrap';
    const stage = async value => {
      runStage=value;
      await alarmPlan.record(binding.accountId,{lastStage:value,lastStageAt:Date.now(),lastTrigger:manual?'manual':'scheduled'});
    };
    try {
      await queueTabs.recover();
      const previous = await alarmPlan.read(binding.accountId);
      const recovered = typeof store.recoverInterrupted === 'function'
        ? await store.recoverInterrupted({accountId:binding.accountId,currentOwner:scheduler.status().owner}) : [];
      for (const job of recovered) await appendExecutionLog({scope:'queue',type:'job-interrupted-recovered',
        result:job.state,accountId:binding.accountId,jobId:job.id,handle:job.handle,runId:previous.lastRunId || '',
        source:manual?'manual':'scheduled',detail:job.interruptionCount>=3?'连续执行中断，已暂停自动重试，请检查后台状态后重试。':job.state==='pending'?'上次执行中断已归档；尚未发送操作，退避后重试。'
          :job.state==='followed'?'上次执行中断已归档；保留已成功关注结果。'
          :'上次执行中断已归档；已尝试操作，转为待核实并释放执行占用。'},api.storage.local);
      if (previous.lastStage && previous.lastStage !== 'idle') {
        await appendExecutionLog({scope:'queue',type:'dispatch-interrupted',result:'uncertain',accountId:binding.accountId,
          source:manual?'manual':'scheduled',runId:previous.lastRunId || '',
          detail:`上次调度在 ${previous.lastStage} 阶段中断。已保存的逐项结果保留；已尝试关注或发布但未确认的任务需核实，未自动重发。`},api.storage.local).catch(()=>{});
      }
      await stage('bootstrap');
      await appendExecutionLog({scope:'queue',type:'dispatch-start',result:'started',accountId:binding.accountId,
        source:manual?'manual':'scheduled',detail:manual?'手动调度已接收，准备同步候选。':'定时调度已触发，准备同步候选。'},api.storage.local).catch(error=>console.warn('队列触发日志写入失败:',error.message));
      if (!(await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']})).length) {
        bootstrap = await createProfileTab(api,{url:'https://x.com/home',active:false},'follow-queue');
        for(let i=0;i<30;i++) { if(await viewer(bootstrap.id).catch(error=>{if(isPageFailure(error))throw error;return '';})) break; await sleep(500); }
      }
      reflectJobs = [];runFailures=[];
      await stage('sync-candidates');
      const ready=typeof store.listByState==='function'?(await Promise.all(['pending','retry'].map(state=>store.listByState({accountId:binding.accountId,state}))))
        .flat().some(job=>job.nextEligibleAt<=Date.now()&&job.sources?.some(source=>source.enabled)&&!job.importedHold?.state):false;
      const failures=runFailures;
      const refresh=syncCandidates().catch(async error=>{const failure=await diagnostics.record(error,{stage:'sync-candidates',manual,accountId:binding.accountId,handle:binding.handle,requestedUrl:`https://x.com/${binding.handle}`});failures.push(failure);});
      // Existing admitted work must not wait behind a complete source scan.
      if(!ready)await refresh;
      // A source/backup failure must not prevent already queued jobs from running.
      // The scheduler still validates the live account before every job.
      await stage('run-queue');
      const result = await scheduler.run({accountId:binding.accountId,manual,retryBatchOnly});
      await stage('reflect-results');
      try{await reflectFollowed(binding.accountId, reflectJobs);}catch(error){const failure=await diagnostics.record(error,{stage:runStage,manual,accountId:binding.accountId,handle:reflectJobs?.at(-1)?.handle||'',runId:result.runId});return {...result,summary:result.summary+' 本地同步暂未完成。'+failureNotice(failure),notify:failure.notify};}
      if(runFailures.length)return {...result,notify:runFailures.some(f=>f.notify),summary:result.summary+' '+failureNotice(runFailures[0])};
      return result;
    } catch(error){const failure=await diagnostics.record(error,{stage:runStage,manual,accountId:binding.accountId,handle:binding.handle,runId:scheduler.status().runId,requestedUrl:`https://x.com/${binding.handle}`,tabId:bootstrap?.id});return {ok:false,error:failure.message,summary:failure.message+' '+failureNotice(failure),notify:failure.notify};}
    finally { reflectJobs = null;runFailures=null; if(bootstrap) await api.tabs.remove(bootstrap.id).catch(()=>{}); await alarmPlan.record(binding.accountId,{lastStage:'idle',lastCompletedAt:Date.now()}).catch(()=>{}); await schedule({reset:true,reason:'cycle-complete'}).catch(async error=>{await diagnostics.record(error,{stage:'schedule-next',accountId:binding.accountId,handle:binding.handle});}); }
  }
  async function handle(message) {
    if(message.cmd==='followQueueFanProfileStatus')return {ok:true,...await readFanProfileQueue({storage:api.storage.local,alarms:api.alarms,binding:readBinding,readCachedResults:readCachedFanResults},message)};
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
    // The fan page asks for progress on startup, before queue onboarding.
    // No binding means no visible batch; it must not create an error or touch
    // another account's stored batch. Mutating requests still require activation.
    if (message.cmd === 'followQueueFanBatchStatus' && !binding?.activated) {
      return {ok:true,batch:null,requiresActivation:true};
    }
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
          summary: {...scheduler.status(), ...await alarmPlan.read(binding.accountId), isPaused: !settings.enabled, stats: page.stats}
        };
      }
      case 'followQueueRunCheck': return {ok:true,allowed:await canRun(binding.accountId),blockReason:runBlockReason};
      case 'followQueueSyncSources': await syncCandidates(); return {ok:true};
      case 'followQueueSettings': return {ok:true,settings:await store.getSettings(binding.accountId)};
      case 'followQueueSaveSettings': {
        const previous = await store.getSettings(binding.accountId);
        const settings = await store.saveSettings(binding.accountId,message.settings);
        const reset = settings.enabled && (!previous.enabled || settings.every !== previous.every || settings.jitter !== previous.jitter);
        await schedule({reset,reason:reset?'timing-changed':'settings-saved'}); return {ok:true,settings};
      }
      case 'followQueueRetryBatch': {
        const result = await store.requestRetryBatch({accountId:binding.accountId,jobIds:message.jobIds});
        await scheduleRetryBatch(1);
        return {ok:true,...result};
      }
      case 'followQueuePause': await store.pendingRetryBatch(binding.accountId,{cancel:true}); await api.alarms.clear(RETRY_BATCH_ALARM); await scheduler.pause(binding.accountId); await schedule(); return {ok:true,settings:await store.getSettings(binding.accountId)};
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
      case 'followQueueInspectFan': {
        const log=createFanLogSink(entry=>appendExecutionLog(entry,api.storage.local));
        const entry={scope:'fanVerify',source:'manual',accountId:binding.accountId,handle:message.handle};
        if(message.recordLog!==false)await log({...entry,result:'running'});
        try {const result=await reconcileFan(binding,{...message,inspectOnly:true});
          if(message.recordLog!==false)await log({...entry,result:result?.jobState==='identity-mismatch'?'identity-mismatch':'verified',relationship:result?.relationship||null,detail:result?.reason||'',jobState:result?.jobState||''});
          return result;
        }catch(error){if(message.recordLog!==false)await log({...entry,result:'error',detail:error.message,nextAt:error.retryAt||0});throw error;}
      }
      case 'followQueueFanBatchStart': {
        if(!Array.isArray(message.handles)||!message.handles.length)throw new Error('请先勾选当前页需要核验的账号');
        return {ok:true,batch:await fanInspectionBatch.start(binding.accountId,message)};
      }
      case 'followQueueFanBatchStatus': return {ok:true,batch:await fanInspectionBatch.status(binding.accountId)};
      case 'followQueueFanBatchResume': return {ok:true,batch:await fanInspectionBatch.resume(binding.accountId)};
      case 'followQueueFanBatchStop': return {ok:true,batch:await fanInspectionBatch.stop(binding.accountId)};
      case 'followQueueFanBatchCancel': return {ok:true,batch:await fanInspectionBatch.cancel(binding.accountId,message.contextChange)};
      case 'followQueueRetryEvaluation': return retryEvaluation(binding, message);
      case 'followQueueBackfillProfiles': return {ok: true, ...(await backfillProfiles(message))};
      case 'followQueueEnqueue': {
        const rawList = Array.isArray(message.candidates) ? message.candidates : [message.candidate || (message.handle ? {...message,module:message.sourceModule || message.module} : null)].filter(Boolean);
        const enqueued = [];
        const candidates=rawList.filter(item=>item?.handle).map(item=>{
          const candidateSources = Array.isArray(item.sources) && item.sources.length > 0
            ? item.sources.map(s => ({ module: s.module || 'comments', url: s.url || '', enabled: s.enabled !== false }))
            : [{ module: item.module || 'comments', url: item.url || '', enabled: true }];
          return {...item,sources:candidateSources};
        });
        for (const item of await gateSourceCandidates(binding,candidates)) {
          const res = await store.enqueue({
            accountId: binding.accountId,
            targetUserId: item.targetUserId || '',
            handle: item.handle,
            sources: item.sources,
            profile: item.profile || null,
            ...(item.fanGrant?{fanGrant:item.fanGrant}:{})
          });
          if (!res.deleted && ['pending','retry'].includes(res.state) && !res.importedHold?.state) enqueued.push(res);
        }
        await schedule();
        return {ok: true, count: enqueued.length, jobs: enqueued};
      }
      default: throw new Error('未知队列操作');
    }
  }
  return {handle,schedule,run,runRetryBatch,fanProfiles,isJobActive:job=>commentLocks.has(job.accountId+':'+job.id),runComments:commentWorker.run,syncCandidates,backfillProfiles,reflectFollowed,store};
}
