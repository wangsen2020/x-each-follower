import {appendQuoteTags} from '../grok/quote-tags.js';
import {createFollowQueueStore} from './follow-queue-store.js';
import {createFollowQueueScheduler} from './follow-queue-scheduler.js';
import {collectFollowQueueCandidates} from './follow-queue-sources.js';
import {networkFetch, networkGetUserProfile, networkFollow, parseNetworkUsers, mergeRecentPosts} from '../relationships/network-api.js';
import {readProfileBundle, simulateProfileScrollStep, publishQuotePostOnPage, setQuoteFrameFallbackOnPage} from '../../platform/x/page-reader.js';
import {parseCount, riskAssess, evaluateMutualProfile} from '../relationships/scoring.js';
import {requestGrokComment, requestGrokText, postQuoteOnTab, resolveCommentLanguage} from '../grok/grok-comment.js';
import {evaluateProfileGrokRisk, interactionSkipReason} from '../relationships/content-risk.js';
import {randomizedSeconds, randomizedInteger} from '../../shared/timing.js';
import {appendExecutionLog, normalizeQueueExecutionLog} from '../../shared/execution-log.js';
import {readAutoFollowAttempts} from '../../shared/auto-follow-history.js';

export const QUEUE_ALARM = 'x-unified-follow-queue';
const BINDING_KEY = 'followQueueBinding';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => String(value || '').replace(/^@/, '').toLowerCase();

export function quotePublicationState(result) {
  if (result?.riskBlocked) return 'skipped';
  return result?.stage === 'composer' ? 'failed' : 'uncertain';
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
  // A verified follower already chose to follow us. Growth-candidate thresholds
  // must not prevent reciprocation; safety checks above still apply.
  if (confirmedFollowBack) return '';
  if (followers === null || following === null) return '未读全粉丝与关注数';
  if (followers < settings.minFollowers) return `粉丝数低于 ${settings.minFollowers}`;
  if (followers > 0 && following / followers < settings.ratioThreshold) return `关注/粉丝比例低于 ${Math.round(settings.ratioThreshold * 100)}%`;
  // Configurable ratio is authoritative here; do not reuse the legacy fixed 80% veto.
  const evaluation = evaluateMutualProfile(profile);
  const hasIntent = evaluation.promise || profile.grokMutualIntent === true;
  const recommended = followers > 0 && following / followers >= settings.ratioThreshold;
  return settings.onlyRecommended && !hasIntent && !recommended ? '未达到互粉意向或推荐条件' : '';
}

export function readQueueViewerOnPage() {
  return document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.split('/')[1] || '';
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
  await api.tabs.update(tabId, {url});
  let prepared = false;
  let refreshed = false;
  while (now() - started < timeoutMs && await canContinue()) {
    await wait(700);
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status !== 'complete') continue;
    if (!prepared) {
      await api.scripting.executeScript({target:{tabId},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(() => {});
      prepared = true;
    }
    const proof = (await api.scripting.executeScript({target:{tabId},func:findPublishedQueueQuoteOnPage,
      args:[handle,originalId,text,after]}).catch(() => []))?.[0]?.result;
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

export function createFollowQueueRuntime({api = chrome, store, fetchUser, fetchIdentity = networkFetch, wait = sleep, records = null} = {}) {
  if (!store) {
    let opened;
    store = new Proxy({}, {get(_target, key) { opened ||= createFollowQueueStore(); return opened[key]?.bind(opened); }});
  }
  const writeLocal = payload => api.storage.local.set(payload);
  let syncing = Promise.resolve();
  const readBinding = async () => (await api.storage.local.get(BINDING_KEY))[BINDING_KEY];
  const script = async (tabId, func, args = []) => (await api.scripting.executeScript({target:{tabId}, func, args}))?.[0]?.result;
  const safeLog = async entry => {
    if (typeof api?.storage?.local?.get === 'function' && typeof api?.storage?.local?.set === 'function') {
      await (async () => {
        const job = entry.jobId ? await readJob(entry.accountId, entry.jobId) || {} : {};
        await appendExecutionLog(normalizeQueueExecutionLog({...entry,source:'manual'},job), api.storage.local);
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
    const lookup = async (tabId, handle) => {
      const result = await fetchIdentity(tabId, 'UserByScreenName', {screen_name:handle});
      const user = result.status === 200 && parseNetworkUsers(result.json).find(u => canonical(u.handle) === handle);
      return user?.id ? {accountId:user.id, handle} : null;
    };
    // Existing pages may still belong to the extension context removed during uninstall.
    // Try them first, then use one owned page to capture a fresh request template.
    for (const tab of tabs) {
      const handle = await viewer(tab.id).catch(() => '');
      if (!handle) continue;
      const found = await lookup(tab.id, handle).catch(() => null);
      if (found) return found;
    }
    let temporary;
    try {
      identityStage = 'opening';
      temporary = await api.tabs.create({url:'https://x.com/home',active:false});
      let handle = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        handle = await viewer(temporary.id).catch(() => '');
        if (handle) break;
        await wait(500);
      }
      if (!handle) throw new Error('未能读取登录账号，请先在 X 首页完成登录，再点击重试。');
      identityStage = 'initializing';
      await api.tabs.update(temporary.id,{url:'https://x.com/' + encodeURIComponent(handle)});
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
  async function canRun(accountId) {
    const binding = await readBinding();
    if (!binding?.activated || binding.accountId !== accountId) return false;
    const monitor = records ? await records.metadata('monitor') : ((await api.storage.local.get('monitor')).monitor || {});
    if (Date.parse(monitor.pausedUntil || '') > Date.now()) return false;
    const tabs = await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    for (const tab of tabs) {
      const handle = await viewer(tab.id).catch(() => '');
      if (handle) return handle === canonical(binding.handle);
    }
    return false;
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
  async function pauseMonitor(hours = 1) {
    const pausedUntil = new Date(Date.now() + hours * 3600000).toISOString();
    if (records) {
      await records.mergeRoot('monitor', {pausedUntil});
      return;
    }
    const {monitor = {}} = await api.storage.local.get('monitor');
    await writeLocal({monitor:{...monitor, pausedUntil}});
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
    const ranks = {skipped:1, uncertain:2, excluded:3, followed:4};
    for (const item of candidates) {
      const prior = await priorByHandle(binding.accountId, item.handle);
      const newSource = !prior || item.sources.some(source => !prior.sources.some(s => s.module === source.module && s.url === source.url));
      const priorState = prior?.followResult?.succeeded ? 'followed' : prior?.importedHold?.state || prior?.state;
      const blockedByActiveOrVerified = (prior?.state === 'running' || prior?.followResult?.verifiedAt) && item.state !== 'followed';
      const newOutcome = !blockedByActiveOrVerified && (ranks[item.state] || 0) > (ranks[priorState] || 0);
      const profile = profiles.get(canonical(item.handle)) || item.profile || null;
      if (prior && !newSource && !newOutcome && !profileChanged(prior.profile, profile)) continue;
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
    executionAudits.set(job.id,audit);
    let tab;
    let followResult = job.followResult || {};
    let attemptedFollow = false;
    const evaluations = [...(job.evaluations || [])];
    async function guard() {
      if (!await control.canAct()) throw new Error('任务已暂停、账号变化或时间预算耗尽');
      const binding = await readBinding();
      if (tab && await viewer(tab.id) !== canonical(binding?.handle)) throw new Error('当前 X 登录账号发生变化');
    }
    try {
      tab = await api.tabs.create({url:`https://x.com/${encodeURIComponent(job.handle)}`, active:false});
      const end = Math.min(control.deadline, Date.now() + 30000);
      let profile;
      while (Date.now() < end && !control.signal.aborted) {
        profile = await script(tab.id, readProfileBundle, [job.handle,5]).catch(() => null);
        if (profile && !profile.pending) break;
        await sleep(500);
      }
      if (!profile || profile.pending) return {state:'retry', reason:'主页资料读取超时'};
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
      const lookup = await networkGetUserProfile(tab.id, job.handle);
      await guard();
      const target = lookup.status === 200 && parseNetworkUsers(lookup.json).find(u => canonical(u.handle) === canonical(job.handle));
      if (!target?.id) return {state:'retry',reason:'无法解析目标用户 ID'};
      if (job.targetUserId && job.targetUserId !== target.id) return {state:'excluded',reason:'账号名称对应的用户 ID 已变化'};
      const merged = await store.enqueue({accountId:job.accountId,targetUserId:target.id,handle:job.handle,sources:job.sources});
      if (merged.importedHold?.state) {
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
      if (target.relationship?.following || profile.relationship?.following || followResult.succeeded) {
        return {state:'followed',followResult:{...followResult,succeeded:true,alreadyFollowing:true,targetUserId:target.id,at:Date.now()},evaluations};
      }
      const dwell = randomizedSeconds(settings.dwellSeconds, settings.dwellJitter, 2, 60);
      for (let round=0; round<settings.scrollRounds; round++) {
        await guard();
        await script(tab.id,simulateProfileScrollStep,[round,420]);
        audit.scrollRounds = round + 1;
        await sleep(dwell * 1000 / settings.scrollRounds);
      }
      const fresh = await script(tab.id,readProfileBundle,[job.handle,10]);
      if (fresh && !fresh.pending) profile = {...profile,...fresh};
      Object.assign(audit,{name:profile.name,posts:profile.posts || [],dwellSeconds:dwell});
      await saveProfile(job.handle, profile);
      const confirmedFollowBack = job.sources?.some(source => source.module === 'fans' && source.enabled === true)
        && target.relationship?.followedBy === true && target.relationship?.following === false;
      const reason = assessQueueProfile({...profile,...target,bio:profile.bio || target.bio},settings,confirmedFollowBack);
      if (reason) return {state:'skipped',reason};
      if (settings.skipRiskContent !== false && (settings.grokEnabled || settings.grokProfileAssessment !== false)) {
        const grokAssessment = await evaluateProfileGrokRisk(profile, {
          sleep,
          runner: prompt => requestGrokText(prompt, { sleep, timeoutMs: 60000 })
        });
        if (grokAssessment.evaluated) {
          profile.grokRiskAssessment = grokAssessment;
          profile.grokAssessedAt = grokAssessment.at;
          if (Array.isArray(grokAssessment.tags) && grokAssessment.tags.length) {
            profile.tags = [...new Set([...(profile.tags || []), ...grokAssessment.tags])];
          }
          await saveProfile(job.handle, profile);
          if (!grokAssessment.safe) {
            const labels = grokAssessment.labels?.length ? grokAssessment.labels.join('、') : '高危敏感内容';
            return {state:'skipped', reason:`命中 Grok 风险标签门禁（${labels}）`};
          }
        }
      }
      await guard();
      await control.checkpoint({stage:'following',followResult:{attemptedAt:Date.now(),targetUserId:target.id}});
      attemptedFollow = true;
      const result = await networkFollow(tab.id,{id:target.id,handle:job.handle});
      if (!(result.status >= 200 && result.status < 300)) {
        if (result.status === 429) await pauseMonitor(1);
        return {state:'uncertain',reason:result.error || `关注返回 ${result.status}，需要核对实际关系`};
      }
      followResult = {succeeded:true,alreadyFollowing:false,targetUserId:target.id,at:Date.now(),dwellSeconds:dwell};
      await control.checkpoint({stage:'followed',followResult});
      if (!settings.grokEnabled) return {state:'followed',followResult,evaluations};
      const recentPosts = (profile.posts || []).slice(0, 5).filter(p => {
        const match = String(p.url || '').match(/^https:\/\/(?:x\.com|twitter\.com)\/([^/]+)\/status\/\d+/);
        return match && canonical(match[1]) === canonical(job.handle) && String(p.text || '').length >= 8;
      });
      if (!recentPosts.length) return {state:'followed',followResult,evaluations,reason:'最近 5 条帖子没有可评价的原创正文'};
      const existingJobs = typeof store.hasPostEvaluation === 'function' ? null : await store.list({accountId:job.accountId});
      const eligiblePosts = [];
      for (const post of recentPosts) {
        const postId = post.url.match(/\/status\/(\d+)/)[1];
        const alreadyQueued = typeof store.hasPostEvaluation === 'function'
          ? await store.hasPostEvaluation({accountId:job.accountId, postId})
          : existingJobs.some(other => other.evaluations?.some(e => e.originalPostId === postId));
        if (!alreadyQueued) eligiblePosts.push(post);
      }
      if (!eligiblePosts.length) return {state:'followed',followResult,evaluations,reason:'最近 5 条帖子均已有引用评价记录'};
      await guard();
      await control.checkpoint({stage:'evaluating',followResult,evaluations});
      const generated = await requestGrokComment(job.handle,eligiblePosts,profile.name,{sleep,profile,writerAccountId:job.accountId});
      if (!generated.ok) {
        await control.checkpoint({stage:'evaluated',followResult,evaluations});
        return {state:'followed',followResult,evaluations,reason:generated.reason || 'Grok 未选出值得评价的帖子'};
      }
      const post = generated.post;
      const originalPostId = post.url.match(/\/status\/(\d+)/)[1];
      const evaluation = {taskId:`${job.accountId}:${originalPostId}`,followJobId:job.id,targetUserId:target.id,
        originalAuthorId:target.id,originalPostId,originalPostUrl:post.url,originalPostText:post.text,status:'draft',attempts:1};
      evaluations.push(evaluation);
      evaluation.baseText = generated.reply || '';
      evaluation.language = generated.language || 'und';
      evaluation.text = appendQuoteTags(evaluation.baseText, settings, evaluation.language);
      evaluation.channel = generated.channel || '';
      evaluation.status = 'draft';
      evaluation.riskBlocked = Boolean(generated.riskBlocked);
      evaluation.reason = generated.reason || '';
      await control.checkpoint({stage:'evaluated',followResult,evaluations});
      const live = await store.getSettings(job.accountId);
      if (!settings.autoPublish || !live.autoPublish) return {state:'followed',followResult,evaluations};
      await guard();
      evaluation.status = 'publishing';
      const submittedAt = Date.now();
      await control.checkpoint({stage:'publishing',followResult,evaluations});
      const published = await postQuoteOnTab(tab.id,post,evaluation.text,publishQuotePostOnPage,sleep,{beforePublish:guard});
      evaluation.status = quotePublicationState(published);
      evaluation.reason = published.reason || '等待主页确认引用发布';
      if (published.ok) {
        const binding = await readBinding();
        const proof = await confirmPublishedQueueQuote({api,tabId:tab.id,handle:binding.handle,
          originalId:originalPostId,text:evaluation.text,after:submittedAt,canContinue:()=>!control.signal.aborted});
        if (proof) Object.assign(evaluation,{status:'posted',publishedPostId:proof.id,publishedPostUrl:proof.url,reason:''});
      }
      return {state:'followed',followResult,evaluations};
    } catch (error) {
      return {state:followResult.succeeded ? 'followed' : attemptedFollow ? 'uncertain' : 'retry',followResult,evaluations,reason:String(error?.message || error)};
    } finally { audit.finishedAt = new Date().toISOString(); audit.evaluations = structuredClone(evaluations); if (tab) await api.tabs.remove(tab.id).catch(() => {}); }
  }
  let reflectJobs = null;
  const scheduler = createFollowQueueScheduler({store,execute,canRun,onEvent:async event => {
    const job = event.jobId ? await readJob(event.accountId, event.jobId) || {} : {};
    if (reflectJobs && (event.type === 'job-complete' || event.state === 'followed') && (event.state === 'followed' || event.followResult?.succeeded)) {
      reflectJobs.push({handle:event.handle || job.handle, followResult:event.followResult || job.followResult, updatedAt:event.at || job.updatedAt});
    }
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
        temporary = await api.tabs.create({url:'https://x.com/home',active:false});
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
      if (target.relationship?.following === true) {
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
      const reopened = await store.resolveJob({
        accountId:binding.accountId,
        id:job.id,
        state:'pending',
        stage:'queued',
        nextEligibleAt:Date.now(),
        followResult:{targetUserId:target.id, verifiedAt:Date.now(), reason:'核实确认未关注，恢复待关注'}
      });
      if (!reopened?.ok) throw new Error('恢复待关注状态失败');
      await safeLog({scope:'queue',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),result:'pending',detail:`核实确认 @${job.handle} 未关注，已恢复为待关注`});
      return {ok:true,resolvedState:'pending',job:reopened.job,summary:`已核实 @${job.handle} 尚未关注，已恢复待关注`};
    });
  }
  async function reconcileFan(binding, {handle} = {}) {
    const key = canonical(handle);
    if (!key || !/^[a-z0-9_]{1,15}$/.test(key)) throw new Error('无效粉丝账号');
    if (binding.sources?.fans !== true) throw new Error('粉丝来源未启用');
    if (!records) throw new Error('粉丝档案不可用');
    const queueRows = await records.lookupAll({sourceKey:'monitor', bucket:'queue', handle:key});
    if (!queueRows.length) throw new Error('粉丝待回关档案不存在');
    return withVerifiedXTab(binding, async tab => {
      const target = typeof fetchUser === 'function'
        ? await fetchUser(tab.id, key)
        : await (async () => {
            const lookup = await networkGetUserProfile(tab.id, key);
            return lookup.status === 200
              ? parseNetworkUsers(lookup.json).find(user => canonical(user.handle) === key) : null;
          })();
      if (!target?.id || target.relationshipKnown !== true
        || typeof target.relationship.followedBy !== 'boolean'
        || typeof target.relationship.following !== 'boolean') {
        throw new Error(`无法核实 @${key} 的完整关注关系`);
      }
      if (queueRows.some(row => row.payload?.id && String(row.payload.id) !== target.id)) {
        await records.batch({sourceKey:'monitor',changes:queueRows.map(row=>({handle:key,sourceBucket:'queue',patch:{
          status:'identity_mismatch',state:'identity_mismatch',relationshipKnown:false,
          relationshipVerifiedAt:new Date().toISOString()
        }}))});
        return {ok:true,handle:key,jobState:'identity-mismatch'};
      }
      const job = await priorByHandle(binding.accountId, key);
      if (job?.targetUserId && job.targetUserId !== target.id) throw new Error(`@${key} 的队列用户 ID 不一致`);
      const following = target.relationship.following;
      const followedBy = target.relationship.followedBy;
      const stamp = Date.now();
      let result = 'unchanged';
      if (following && job && job.state !== 'followed') {
        const resolved = await store.resolveJob({accountId:binding.accountId,id:job.id,state:'followed',stage:'followed',
          followResult:{...(job.followResult || {}),succeeded:true,following:true,alreadyFollowing:true,targetUserId:target.id,verifiedAt:stamp,reason:'X 关系核实已关注'}});
        if (!resolved?.ok) throw new Error(`更新 @${key} 队列状态失败`);
        result = 'already-following';
      } else if (followedBy && !following && job?.state === 'skipped'
        && /^关注\/粉丝比例低于 \d+%$/.test(String(job.followResult?.reason || ''))) {
        const resolved = await store.resolveJob({accountId:binding.accountId,id:job.id,state:'pending',stage:'queued',nextEligibleAt:stamp,
          followResult:{targetUserId:target.id,verifiedAt:stamp,reason:'X 关系核实待回关，恢复比例门槛跳过任务'}});
        if (!resolved?.ok) throw new Error(`恢复 @${key} 待回关任务失败`);
        result = 'reopened';
      }
      const changes = queueRows.map(row => ({handle:key,sourceBucket:'queue',patch:{
        relationship:{...(row.payload?.relationship || {}),following,followedBy},relationshipKnown:true,
        status:following ? 'followed' : followedBy ? 'pending' : 'no_longer_following',
        state:following ? 'following' : followedBy ? 'follow_back' : 'no_longer_following',
        relationshipVerifiedAt:new Date(stamp).toISOString()
      }}));
      await records.batch({sourceKey:'monitor',changes});
      if (following && job) await reflectFollowed(binding.accountId,[{...job,followResult:{...(job.followResult || {}),at:stamp},updatedAt:stamp}]);
      return {ok:true,handle:key,relationship:{followedBy,following},jobState:result};
    });
  }
  async function retryEvaluation(binding, {jobId, taskId, publish = false} = {}) {
    const job = await readJob(binding.accountId, jobId);
    if (!job) throw new Error('未找到对应的队列任务');
    if (job.state !== 'followed') throw new Error('仅已关注成功的任务支持独立重试引用评价，禁止回退关注步骤');
    const existingEvals = Array.isArray(job.evaluations) ? job.evaluations : [];
    const targetEval = (taskId ? existingEvals.find(e => e.taskId === taskId) : existingEvals[0]) || null;
    if (targetEval && (targetEval.status === 'posted' || targetEval.status === 'published')) {
      return {ok:true,job,evaluation:targetEval,summary:'该引用评价已发布，无需重复执行'};
    }
    let tab;
    try {
      tab = await api.tabs.create({url:`https://x.com/${encodeURIComponent(binding.handle)}`,active:false});
      let viewerHandle = '';
      for (let i=0;i<20;i++) {
        viewerHandle = await viewer(tab.id).catch(() => '');
        if (viewerHandle) break;
        await sleep(500);
      }
      if (viewerHandle !== canonical(binding.handle)) throw new Error('当前 X 登录账号与队列绑定账号不一致');
      let ev = targetEval ? {...targetEval} : null;
      const hadPinnedEvaluation = Boolean(ev?.originalPostUrl);
      // Step 1: If uncertain or draft, verify on viewer's profile page first before any re-publish
      if (ev && ev.originalPostId && ev.text) {
        const proof = await confirmPublishedQueueQuote({api,tabId:tab.id,handle:binding.handle,
          originalId:ev.originalPostId,text:ev.text,after:0});
        if (proof) {
          ev = {...ev, status:'posted', publishedPostId:proof.id, publishedPostUrl:proof.url, reason:''};
          const saved = await store.resolveJob({accountId:binding.accountId, id:job.id, evaluations:[ev]});
          await safeLog({scope:'queue', accountId:binding.accountId, jobId:job.id, handle:job.handle, at:new Date().toISOString(), result:'posted', detail:`主页核实 @${job.handle} 的引用评价已发布`});
          return {ok:true, job:saved.job, evaluation:ev, summary:'主页已确认该引用评价发布成功'};
        }
        if (ev.status === 'uncertain') {
          ev = {...ev, status:ev.text ? 'draft' : 'failed', reason:'主页未发现已发布引用帖，已转为草稿可重试发布'};
          await store.resolveJob({accountId:binding.accountId, id:job.id, evaluations:[ev]});
          if (!publish) {
            return {ok:true, job:job, evaluation:ev, summary:ev.reason};
          }
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
        await api.tabs.update(tab.id,{url:`https://x.com/${encodeURIComponent(job.handle)}`});
        for (let i=0;i<20;i++) {
          const bundle = await script(tab.id,readProfileBundle,[job.handle,5]).catch(() => null);
          if (bundle && !bundle.pending && Array.isArray(bundle.posts)) {
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
      // Reuse existing draft text if available; only call Grok when draft text is empty
      if (!ev.text) {
        const generated = await requestGrokComment(job.handle,hadPinnedEvaluation ? post : cachedPosts.slice(0, 5),job.handle,{sleep,profile:safetyProfile,writerAccountId:job.accountId});
        ev.text = generated.reply || '';
        ev.language = generated.language || 'und';
        ev.channel = generated.channel || ev.channel || '';
        ev.status = generated.ok ? 'draft' : (generated.riskBlocked || generated.skipped ? 'skipped' : 'failed');
        ev.riskBlocked = Boolean(generated.riskBlocked);
        ev.reason = generated.reason || '';
        if (!generated.ok) {
          const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          return {ok:Boolean(generated.skipped),error:generated.skipped ? '' : ev.reason || 'Grok 生成评价失败',summary:ev.reason,job:saved.job,evaluation:ev};
        }
        post = generated.post;
        originalPostId = post.url.match(/\/status\/(\d+)/)?.[1] || '';
        if (!originalPostId) throw new Error('Grok 选中的帖子缺少有效推文 ID');
        Object.assign(ev,{taskId:`${binding.accountId}:${originalPostId}`,originalPostId,originalPostUrl:post.url,originalPostText:post.text});
      } else {
        ev.status = 'draft';
      }
      const settings = await store.getSettings(binding.accountId);
      ev.baseText ||= ev.text;
      ev.language = resolveCommentLanguage(ev.baseText, ev.language);
      ev.text = appendQuoteTags(ev.baseText, settings, ev.language || 'und');
      if (!publish && !settings.autoPublish) {
        const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
        await safeLog({scope:'queue',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),result:'draft',detail:`已为 @${job.handle} 生成评价草稿（未开启自动发布）`});
        return {ok:true,job:saved.job,evaluation:ev,summary:'评价草稿已就绪（未自动发布）'};
      }
      const submittedAt = Date.now();
      const published = await postQuoteOnTab(tab.id,post,ev.text,publishQuotePostOnPage,sleep);
      ev.status = quotePublicationState(published);
      ev.reason = published.reason || '等待主页确认引用发布';
      if (published.ok) {
        const proof = await confirmPublishedQueueQuote({api,tabId:tab.id,handle:binding.handle,
          originalId:originalPostId,text:ev.text,after:submittedAt});
        if (proof) Object.assign(ev,{status:'posted',publishedPostId:proof.id,publishedPostUrl:proof.url,reason:''});
      }
      const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
      await safeLog({scope:'queue',accountId:binding.accountId,jobId:job.id,handle:job.handle,at:new Date().toISOString(),result:ev.status,detail:ev.status === 'posted' ? `已发布 @${job.handle} 的引用评价` : (ev.reason || '引用评价重试结束')});
      return {ok:true,job:saved.job,evaluation:ev,summary:ev.status === 'posted' ? '引用评价已发布并核验' : ev.reason};
    } finally {
      if (tab) await api.tabs.remove(tab.id).catch(() => {});
    }
  }
  async function schedule({preserve = false} = {}) {
    const binding = await readBinding();
    if (!binding?.activated) return;
    // Queue takeover is durable, including when its own enabled switch is off.
    await api.alarms.clear('x-mutual-auto-follow');
    await api.alarms.clear('x-comment-auto-follow');
    const settings = await store.getSettings(binding.accountId);
    if (preserve && settings.enabled && (await api.alarms.getAll()).some(alarm=>alarm.name === QUEUE_ALARM)) return;
    await api.alarms.clear(QUEUE_ALARM);
    if (settings.enabled) await api.alarms.create(QUEUE_ALARM,{delayInMinutes:randomizedInteger(settings.every,settings.jitter,1,240)});
  }
  async function run(manual = false) {
    const binding = await readBinding();
    if (!binding?.activated) throw new Error('请先确认统一队列的数据归属和来源');
    // Create only one temporary tab if a scheduled task has no X tab available.
    let bootstrap;
    try {
      if (!(await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']})).length) {
        bootstrap = await api.tabs.create({url:'https://x.com/home',active:false});
        for(let i=0;i<30;i++) { if(await viewer(bootstrap.id).catch(()=>'')) break; await sleep(500); }
      }
      reflectJobs = [];
      await syncCandidates();
      const result = await scheduler.run({accountId:binding.accountId,manual});
      await reflectFollowed(binding.accountId, reflectJobs);
      return result;
    } finally { reflectJobs = null; if(bootstrap) await api.tabs.remove(bootstrap.id).catch(()=>{}); await schedule(); }
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
      case 'followQueueSettings': return {ok:true,settings:await store.getSettings(binding.accountId)};
      case 'followQueueSaveSettings': {
        const settings = await store.saveSettings(binding.accountId,message.settings); await schedule(); return {ok:true,settings};
      }
      case 'followQueuePause': await scheduler.pause(binding.accountId); await schedule(); return {ok:true,settings:await store.getSettings(binding.accountId)};
      case 'followQueueRun': return run(true);
      case 'followQueueVerify': return verifyUncertain(binding, message);
      case 'followQueueReconcileFan': return reconcileFan(binding, message);
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
          enqueued.push(res);
        }
        await schedule();
        return {ok: true, count: enqueued.length, jobs: enqueued};
      }
      default: throw new Error('未知队列操作');
    }
  }
  return {handle,schedule,run,syncCandidates,backfillProfiles,reflectFollowed,store};
}
