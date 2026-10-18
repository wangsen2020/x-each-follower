import {enrichQueueProfiles} from './follow-queue-profiles.js';
import {appendQuoteTags} from './quote-tags.js';
import {createFollowQueueStore} from './follow-queue-store.js';
import {createFollowQueueScheduler} from './follow-queue-scheduler.js';
import {collectFollowQueueCandidates} from './follow-queue-sources.js';
import {networkFetch, networkFollow, parseNetworkUsers, mergeRecentPosts} from './network-api.js';
import {readProfileBundle, simulateProfileScrollStep, publishQuotePostOnPage} from './page-reader.js';
import {parseCount, riskAssess, evaluateMutualProfile} from './scoring.js';
import {requestGrokComment, postQuoteOnTab, resolveCommentLanguage} from './grok-comment.js';
import {randomizedSeconds, randomizedInteger} from './timing.js';
import {appendExecutionLog} from './execution-log.js';

export const QUEUE_ALARM = 'x-unified-follow-queue';
const BINDING_KEY = 'followQueueBinding';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => String(value || '').replace(/^@/, '').toLowerCase();

export function assessQueueProfile(profile, settings) {
  const followers = parseCount(String(profile.followersText ?? ''));
  const following = parseCount(String(profile.followingText ?? ''));
  if (riskAssess(profile).level === 'danger') return '命中高风险内容规则';
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

export function createFollowQueueRuntime({api = chrome, store, fetchUser, fetchIdentity = networkFetch, wait = sleep} = {}) {
  if (!store) {
    let opened;
    store = new Proxy({}, {get(_target, key) { opened ||= createFollowQueueStore(); return opened[key]?.bind(opened); }});
  }
  let syncing = Promise.resolve();
  const readBinding = async () => (await api.storage.local.get(BINDING_KEY))[BINDING_KEY];
  const script = async (tabId, func, args = []) => (await api.scripting.executeScript({target:{tabId}, func, args}))?.[0]?.result;
  const safeLog = async entry => {
    if (typeof api?.storage?.local?.get === 'function' && typeof api?.storage?.local?.set === 'function') {
      await appendExecutionLog(entry, api.storage.local).catch(() => {});
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
    const {monitor = {}} = await api.storage.local.get('monitor');
    if (Date.parse(monitor.pausedUntil || '') > Date.now()) return false;
    const tabs = await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    for (const tab of tabs) {
      const handle = await viewer(tab.id).catch(() => '');
      if (handle) return handle === canonical(binding.handle);
    }
    return false;
  }
  async function syncCandidates() {
    const run = syncing.then(async () => {
      const binding = await readBinding();
      if (!binding?.activated || !await canRun(binding.accountId)) return;
      const data = await api.storage.local.get(null);
      const candidates = collectFollowQueueCandidates({accountId:binding.accountId, ...data,
        attempts:data, sourceEnabled:binding.sources});
      const existing = new Map((await store.list({accountId:binding.accountId})).map(job=>[canonical(job.handle),job]));
      const ranks = {skipped:1,uncertain:2,excluded:3,followed:4};
      for (const item of candidates) {
        const prior = existing.get(canonical(item.handle));
        const newSource = !prior || item.sources.some(source=>!prior.sources.some(s=>s.module===source.module && s.url===source.url));
        const priorState = prior?.followResult?.succeeded ? 'followed' : prior?.importedHold?.state || prior?.state;
        const blockedByActiveOrVerified = (prior?.state === 'running' || prior?.followResult?.verifiedAt) && item.state !== 'followed';
        const newOutcome = !blockedByActiveOrVerified && (ranks[item.state] || 0) > (ranks[priorState] || 0);
        if (prior && !newSource && !newOutcome) continue;
        if (item.state && item.state !== 'pending' && newOutcome) await store.importOutcome(item);
        else await store.enqueue(item);
      }
    });
    syncing = run.catch(() => {});
    return run;
  }
  async function execute(job, settings, control) {
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
      await guard();
      // Resolve authoritative User Rest ID from a user operation, never a tweet's ID.
      const lookup = await networkFetch(tab.id,'UserByScreenName',{screen_name:job.handle});
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
      const duplicates = (await store.list({accountId:job.accountId})).filter(other => other.id !== job.id && other.targetUserId === target.id);
      if (duplicates.length) return {state:'uncertain',reason:'身份合并存在其他记录，需要核对'};
      if (target.relationship?.following || profile.relationship?.following || followResult.succeeded) {
        return {state:'followed',followResult:{...followResult,succeeded:true,alreadyFollowing:true,targetUserId:target.id,at:Date.now()},evaluations};
      }
      const dwell = randomizedSeconds(settings.dwellSeconds, settings.dwellJitter, 2, 60);
      for (let round=0; round<settings.scrollRounds; round++) {
        await guard();
        await script(tab.id,simulateProfileScrollStep,[round,420]);
        await sleep(dwell * 1000 / settings.scrollRounds);
      }
      const fresh = await script(tab.id,readProfileBundle,[job.handle,5]);
      if (fresh && !fresh.pending) profile = {...profile,...fresh};
      const {profileCache = {}} = await api.storage.local.get('profileCache');
      const previous = profileCache[canonical(job.handle)] || {};
      profileCache[canonical(job.handle)] = {...previous,...profile,posts:mergeRecentPosts(previous.posts || [],profile.posts || [],100),profileCachedAt:new Date().toISOString()};
      await api.storage.local.set({profileCache});
      const reason = assessQueueProfile({...profile,...target,bio:profile.bio || target.bio},settings);
      if (reason) return {state:'skipped',reason};
      await guard();
      await control.checkpoint({stage:'following',followResult:{attemptedAt:Date.now(),targetUserId:target.id}});
      attemptedFollow = true;
      const result = await networkFollow(tab.id,{id:target.id,handle:job.handle});
      if (!(result.status >= 200 && result.status < 300)) {
        if (result.status === 429) {
          const {monitor = {}} = await api.storage.local.get('monitor');
          await api.storage.local.set({monitor:{...monitor,pausedUntil:new Date(Date.now()+3600000).toISOString()}});
        }
        return {state:'uncertain',reason:result.error || `关注返回 ${result.status}，需要核对实际关系`};
      }
      followResult = {succeeded:true,alreadyFollowing:false,targetUserId:target.id,at:Date.now(),dwellSeconds:dwell};
      await control.checkpoint({stage:'followed',followResult});
      if (!settings.grokEnabled) return {state:'followed',followResult,evaluations};
      const post = (profile.posts || []).find(p => {
        const match = String(p.url || '').match(/^https:\/\/(?:x\.com|twitter\.com)\/([^/]+)\/status\/\d+/);
        return match && canonical(match[1]) === canonical(job.handle) && String(p.text || '').length >= 8;
      });
      if (!post) return {state:'followed',followResult,evaluations,reason:'没有可评价的近期帖子'};
      const originalPostId = post.url.match(/\/status\/(\d+)/)[1];
      const evaluation = {taskId:`${job.accountId}:${originalPostId}`,followJobId:job.id,targetUserId:target.id,
        originalAuthorId:target.id,originalPostId,originalPostUrl:post.url,status:'generating',attempts:1};
      const jobs = await store.list({accountId:job.accountId});
      if (jobs.some(other => other.evaluations?.some(e => e.originalPostId === originalPostId))) return {state:'followed',followResult,evaluations};
      evaluations.push(evaluation);
      await guard();
      await control.checkpoint({stage:'evaluating',followResult,evaluations});
      const generated = await requestGrokComment(job.handle,post,profile.name,{sleep});
      evaluation.baseText = generated.reply || '';
      evaluation.language = generated.language || 'und';
      evaluation.text = appendQuoteTags(evaluation.baseText, settings, evaluation.language);
      evaluation.channel = generated.channel || '';
      evaluation.status = generated.ok ? 'draft' : 'failed';
      evaluation.reason = generated.reason || '';
      await control.checkpoint({stage:'evaluated',followResult,evaluations});
      const live = await store.getSettings(job.accountId);
      if (!generated.ok || !settings.autoPublish || !live.autoPublish) return {state:'followed',followResult,evaluations};
      await guard();
      evaluation.status = 'publishing';
      const submittedAt = Date.now();
      await control.checkpoint({stage:'publishing',followResult,evaluations});
      const published = await postQuoteOnTab(tab.id,post,evaluation.text,publishQuotePostOnPage,sleep,{beforePublish:guard});
      evaluation.status = 'uncertain';
      evaluation.reason = published.reason || '等待主页确认引用发布';
      if (published.ok) {
        const binding = await readBinding();
        await api.tabs.update(tab.id,{url:`https://x.com/${binding.handle}`});
        for (let i=0;i<20 && !control.signal.aborted;i++) {
          await sleep(700);
          const proof = await script(tab.id,findPublishedQueueQuoteOnPage,[binding.handle,originalPostId,evaluation.text,submittedAt]).catch(() => null);
          if (proof) { Object.assign(evaluation,{status:'posted',publishedPostId:proof.id,publishedPostUrl:proof.url,reason:''}); break; }
        }
      } else if (published.stage === 'composer') evaluation.status = 'failed';
      return {state:'followed',followResult,evaluations};
    } catch (error) {
      return {state:followResult.succeeded ? 'followed' : attemptedFollow ? 'uncertain' : 'retry',followResult,evaluations,reason:String(error?.message || error)};
    } finally { if (tab) await api.tabs.remove(tab.id).catch(() => {}); }
  }
  const scheduler = createFollowQueueScheduler({store,execute,canRun,onEvent:event => appendExecutionLog({
    ...event, scope:'queue', at:new Date(event.at || Date.now()).toISOString(),
    result:event.state || event.type, detail:event.summary || event.reason || event.type
  })});
  async function reflectFollowed(accountId) {
    const followed = new Map((await store.list({accountId})).filter(job=>job.state === 'followed').map(job=>[canonical(job.handle),job]));
    if (!followed.size) return;
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
    if (Object.keys(changed).length) await api.storage.local.set(changed);
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
    const jobs = await store.list({accountId:binding.accountId});
    const job = jobs.find(item => item.id === jobId);
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
            const lookup = await networkFetch(tab.id,'UserByScreenName',{screen_name:job.handle});
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
        await reflectFollowed(binding.accountId);
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
  async function retryEvaluation(binding, {jobId, taskId, publish = false} = {}) {
    const jobs = await store.list({accountId:binding.accountId});
    const job = jobs.find(item => item.id === jobId);
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
      // Step 1: If uncertain or draft, verify on viewer's profile page first before any re-publish
      if (ev && ev.originalPostId && ev.text) {
        let proof = null;
        for (let i = 0; i < 20; i++) {
          await sleep(500);
          proof = await script(tab.id, findPublishedQueueQuoteOnPage, [binding.handle, ev.originalPostId, ev.text, 0]).catch(() => null);
          if (proof) break;
        }
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
      const {profileCache = {}} = await api.storage.local.get('profileCache');
      let cachedPosts = profileCache[canonical(job.handle)]?.posts || [];
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
            const prev = profileCache[canonical(job.handle)] || {};
            profileCache[canonical(job.handle)] = {...prev,...bundle,posts:mergeRecentPosts(prev.posts || [],bundle.posts,100),profileCachedAt:new Date().toISOString()};
            await api.storage.local.set({profileCache});
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
      const originalPostId = ev?.originalPostId || post.url.match(/\/status\/(\d+)/)?.[1] || '';
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
      // Reuse existing draft text if available; only call Grok when draft text is empty
      if (!ev.text) {
        const generated = await requestGrokComment(job.handle,post,job.handle,{sleep});
        ev.text = generated.reply || '';
        ev.language = generated.language || 'und';
        ev.channel = generated.channel || ev.channel || '';
        ev.status = generated.ok ? 'draft' : 'failed';
        ev.reason = generated.reason || '';
        if (!generated.ok) {
          const saved = await store.resolveJob({accountId:binding.accountId,id:job.id,evaluations:[ev]});
          return {ok:false,error:ev.reason || 'Grok 生成评价失败',job:saved.job,evaluation:ev};
        }
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
      ev.status = 'uncertain';
      ev.reason = published.reason || '等待主页确认引用发布';
      if (published.ok) {
        await api.tabs.update(tab.id,{url:`https://x.com/${binding.handle}`});
        for (let i=0;i<20;i++) {
          await sleep(700);
          const proof = await script(tab.id,findPublishedQueueQuoteOnPage,[binding.handle,originalPostId,ev.text,submittedAt]).catch(() => null);
          if (proof) {
            Object.assign(ev,{status:'posted',publishedPostId:proof.id,publishedPostUrl:proof.url,reason:''});
            break;
          }
        }
      } else if (published.stage === 'composer') {
        ev.status = 'failed';
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
      await syncCandidates();
      const result = await scheduler.run({accountId:binding.accountId,manual});
      await reflectFollowed(binding.accountId);
      return result;
    } finally { if(bootstrap) await api.tabs.remove(bootstrap.id).catch(()=>{}); await schedule(); }
  }
  async function handle(message) {
    if (message.cmd === 'followQueueIdentityStatus') return {ok:true,stage:identityStage};
    if (message.cmd === 'followQueueIdentity') return {ok:true,...await identity(),binding:await readBinding()};
    if (message.cmd === 'followQueueActivate') {
      if (message.confirmed !== true) throw new Error('请确认本地数据属于当前账号');
      const current = await identity();
      if (current.accountId !== message.accountId) throw new Error('当前账号变化，请重新确认');
      const sources = Object.fromEntries(['fans','mutual','comments'].map(k=>[k,message.sources?.[k] === true]));
      await api.storage.local.set({[BINDING_KEY]:{...current,activated:true,sources,confirmedAt:Date.now()}});
      await schedule();
      await store.updateSources({accountId:current.accountId,modules:sources});
      await syncCandidates(); await schedule(); return {ok:true};
    }
    const binding = await readBinding();
    if (!binding?.activated || (message.accountId && binding.accountId !== message.accountId)) throw new Error('请先确认队列账号');
    switch(message.cmd) {
      case 'followQueueList': {
        await syncCandidates();
        const settings = await store.getSettings(binding.accountId);
        const jobs = enrichQueueProfiles(await store.list({accountId:binding.accountId}), await api.storage.local.get(['monitor','mutualNetwork','commentTracking','profileCache']));
        return {ok:true,jobs,summary:{...scheduler.status(),isPaused:!settings.enabled}};
      }
      case 'followQueueSettings': return {ok:true,settings:await store.getSettings(binding.accountId)};
      case 'followQueueSaveSettings': {
        const settings = await store.saveSettings(binding.accountId,message.settings); await schedule(); return {ok:true,settings};
      }
      case 'followQueuePause': await scheduler.pause(binding.accountId); await schedule(); return {ok:true,settings:await store.getSettings(binding.accountId)};
      case 'followQueueRun': return run(true);
      case 'followQueueVerify': return verifyUncertain(binding, message);
      case 'followQueueRetryEvaluation': return retryEvaluation(binding, message);
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
            sources: candidateSources
          });
          enqueued.push(res);
        }
        await schedule();
        return {ok: true, count: enqueued.length, jobs: enqueued};
      }
      default: throw new Error('未知队列操作');
    }
  }
  return {handle,schedule,run,syncCandidates,store};
}
