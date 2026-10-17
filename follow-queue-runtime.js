import {createFollowQueueStore} from './follow-queue-store.js';
import {createFollowQueueScheduler} from './follow-queue-scheduler.js';
import {collectFollowQueueCandidates} from './follow-queue-sources.js';
import {networkFetch, networkFollow, parseNetworkUsers, mergeRecentPosts} from './network-api.js';
import {readProfileBundle, simulateProfileScrollStep, publishQuotePostOnPage} from './page-reader.js';
import {parseCount, riskAssess, evaluateMutualProfile} from './scoring.js';
import {requestGrokComment, postQuoteOnTab} from './grok-comment.js';
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
    if (!links.some(a => a.href.includes(`/status/${originalId}`))) continue;
    for (const link of links) {
      const match = new URL(link.href).pathname.match(/^\/([^/]+)\/status\/(\d+)$/);
      if (!match || match[1].toLowerCase() !== handle.toLowerCase() || match[2] === originalId) continue;
      const created = Number((BigInt(match[2]) >> 22n) + 1288834974657n);
      if (created >= after - 5000) return {id:match[2], url:`https://x.com/${match[1]}/status/${match[2]}`};
    }
  }
  return null;
}

export function createFollowQueueRuntime({api = chrome, store} = {}) {
  if (!store) {
    let opened;
    store = new Proxy({}, {get(_target, key) { opened ||= createFollowQueueStore(); return opened[key]?.bind(opened); }});
  }
  let syncing = Promise.resolve();
  const readBinding = async () => (await api.storage.local.get(BINDING_KEY))[BINDING_KEY];
  const script = async (tabId, func, args = []) => (await api.scripting.executeScript({target:{tabId}, func, args}))?.[0]?.result;
  async function viewer(tabId) { return canonical(await script(tabId, readQueueViewerOnPage)); }
  async function identity() {
    const tabs = await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    let temporary;
    try {
      if (!tabs.length) { temporary = await api.tabs.create({url:'https://x.com/home',active:false}); tabs.push(temporary); }
      for (const tab of tabs) {
        let handle = '';
        for (let attempt = 0; attempt < (temporary ? 20 : 1); attempt++) {
          handle = await viewer(tab.id).catch(() => '');
          if (handle) break;
          await sleep(500);
        }
        if (!handle) continue;
        const lookup = await networkFetch(tab.id, 'UserByScreenName', {screen_name:handle});
        const user = lookup.status === 200 && parseNetworkUsers(lookup.json).find(u => canonical(u.handle) === handle);
        if (user?.id) return {accountId:user.id, handle};
      }
      throw new Error('无法确认当前 X 账号，请先打开已登录的 X 首页后重试。');
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
        const newOutcome = (ranks[item.state] || 0) > (ranks[priorState] || 0);
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
      evaluation.text = generated.reply || '';
      evaluation.status = generated.ok ? 'draft' : 'failed';
      evaluation.reason = generated.reason || '';
      await control.checkpoint({stage:'evaluated',followResult,evaluations});
      const live = await store.getSettings(job.accountId);
      if (!generated.ok || !settings.autoPublish || !live.autoPublish) return {state:'followed',followResult,evaluations};
      await guard();
      evaluation.status = 'publishing';
      const submittedAt = Date.now();
      await control.checkpoint({stage:'publishing',followResult,evaluations});
      const published = await postQuoteOnTab(tab.id,post,generated.reply,publishQuotePostOnPage,sleep,{beforePublish:guard});
      evaluation.status = 'uncertain';
      evaluation.reason = published.reason || '等待主页确认引用发布';
      if (published.ok) {
        const binding = await readBinding();
        await api.tabs.update(tab.id,{url:`https://x.com/${binding.handle}`});
        for (let i=0;i<20 && !control.signal.aborted;i++) {
          await sleep(700);
          const proof = await script(tab.id,findPublishedQueueQuoteOnPage,[binding.handle,originalPostId,generated.reply,submittedAt]).catch(() => null);
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
    if (!binding?.activated || binding.accountId !== message.accountId) throw new Error('请先确认队列账号');
    switch(message.cmd) {
      case 'followQueueList': {
        await syncCandidates();
        const settings = await store.getSettings(binding.accountId);
        return {ok:true,jobs:await store.list({accountId:binding.accountId}),summary:{...scheduler.status(),isPaused:!settings.enabled}};
      }
      case 'followQueueSettings': return {ok:true,settings:await store.getSettings(binding.accountId)};
      case 'followQueueSaveSettings': {
        const settings = await store.saveSettings(binding.accountId,message.settings); await schedule(); return {ok:true,settings};
      }
      case 'followQueuePause': await scheduler.pause(binding.accountId); await schedule(); return {ok:true,settings:await store.getSettings(binding.accountId)};
      case 'followQueueRun': return run(true);
      default: throw new Error('未知队列操作');
    }
  }
  return {handle,schedule,run,syncCandidates,store};
}
