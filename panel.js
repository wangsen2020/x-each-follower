import { normalizeHandle, parseCount, assess, riskAssess, csv } from './scoring.js';
import { collectVisible, readProfile, readProfileBundle, scanFollowers, clickFollowBack, clickFollowOnProfile } from './page-reader.js';
import { networkFetch, parseNetworkUsers, findCursor } from './network-api.js';
import { durableGet, durableSet } from './persistent-db.js';

const $ = id => document.getElementById(id);
let rows = [];
let running = false;
let stopped = false;
let inspectionTab;
let options;
let monitor = {enabled:false, every:60, batch:10, batchEvery:10, users:[], queue:[], lastScan:null};
let analysisRows = [];
let explorer = {selected:null, following:[], followers:[], queue:[]};
let explorerRunning = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = text => { $('status').textContent = text; };
const monitorStatus = text => { $('monitorStatus').textContent = text; };
const analysisStatus = text => { $('analysisStatus').textContent = text; };
function setTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(panel => { panel.hidden = panel.dataset.panel !== tab; });
}
document.querySelectorAll('.nav-tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
const persist = (key, value) => durableSet(key, value).catch(() => {});
function explorerStatus(text) { $('explorerStatus').textContent = text; }
function explorerKey(user) { return String(user?.handle || '').toLowerCase(); }
function renderExplorerList(root, users, role) {
  root.replaceChildren();
  if (!users.length) { const empty=document.createElement('p'); empty.className='note'; empty.textContent='还没有收集到账号。'; root.append(empty); return; }
  const queued = new Set((explorer.queue || []).map(explorerKey));
  for (const user of users) {
    const item=document.createElement('div'); item.className='explorer-item';
    const info=document.createElement('div'); const strong=document.createElement('strong'); strong.textContent=`${user.name || user.handle} · @${user.handle}`;
    const detail=document.createElement('small'); detail.textContent=`${user.bio || '暂无简介'}${user.followersText ? ` · 粉丝 ${user.followersText}` : ''}${user.followingText ? ` · 关注 ${user.followingText}` : ''}`;
    info.append(strong, detail);
    const actions=document.createElement('div'); actions.className='explorer-actions';
    const open=document.createElement('button'); open.className='secondary'; open.textContent='查看资料'; open.addEventListener('click', () => exploreProfile(user.handle));
    const add=document.createElement('button'); add.className='queue-status'; add.textContent=queued.has(explorerKey(user)) ? '已在队列' : '加入队列'; add.disabled=queued.has(explorerKey(user)); add.addEventListener('click', () => addExplorerQueue(user, role));
    actions.append(open, add); item.append(info, actions); root.append(item);
  }
}
function renderExplorer() {
  $('explorerFollowingCount').textContent=String(explorer.following?.length || 0);
  $('explorerFollowersCount').textContent=String(explorer.followers?.length || 0);
  const pending=(explorer.queue || []).filter(item => item.status === 'pending').length;
  $('explorerQueueCount').textContent=String(pending);
  $('explorerPendingCount').textContent=String(pending);
  renderExplorerList($('explorerFollowing'), explorer.following || [], 'following');
  renderExplorerList($('explorerFollowers'), explorer.followers || [], 'followers');
  const root=$('explorerQueue'); root.replaceChildren();
  if (!(explorer.queue || []).length) { const empty=document.createElement('p'); empty.className='note'; empty.textContent='选择账号加入后，会在最小化后台标签页中继续采集。'; root.append(empty); return; }
  for (const item of explorer.queue) { const row=document.createElement('div'); row.className=`explorer-item ${item.status === 'done' ? 'is-done' : item.status === 'error' ? 'is-error' : ''}`; const info=document.createElement('div'); const strong=document.createElement('strong'); strong.textContent=`@${item.handle}`; const detail=document.createElement('small'); detail.textContent=item.error || ({pending:'等待采集',running:'正在静默采集',done:`已完成 · ${item.following?.length || 0} following / ${item.followers?.length || 0} followers`}[item.status] || item.status); info.append(strong,detail); const button=document.createElement('button'); button.className='secondary'; button.textContent='查看资料'; button.addEventListener('click',() => exploreProfile(item.handle)); row.append(info,button); root.append(row); }
}
function renderQueue() {
  const filter = $('queueFilter').value;
  const priority = {pending:0, danger:1, followed:2, changed:3, unreadable:4};
  const queue = [...(monitor.queue || [])].filter(user => filter === 'all' ? true : filter === 'danger' ? user.status === 'danger' : user.status === 'pending').sort((a,b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));
  $('queueCount').textContent = String((monitor.queue || []).filter(user => user.status === 'pending').length);
  const root = $('queueList'); root.replaceChildren();
  if (!queue.length) { const empty = document.createElement('p'); empty.className='note'; empty.textContent='当前没有符合筛选条件的账号。'; root.append(empty); return; }
  for (const user of queue) {
    const item = document.createElement('div'); item.className = `queue-item ${user.status === 'danger' ? 'queue-danger' : ''}`;
    const text = document.createElement('div'); const link = document.createElement('a'); link.href=`https://x.com/${user.handle}`; link.target='_blank'; link.rel='noopener'; link.textContent=`${user.name || user.handle} · @${user.handle}`; const detail=document.createElement('small'); detail.textContent=user.risk?.level === 'danger' ? `危险：${user.risk.hits.join('、')}` : (user.bio || '').slice(0,120); text.append(link, detail);
    const inspect = document.createElement('button'); inspect.className='secondary'; inspect.textContent='查看资料'; inspect.addEventListener('click', () => exploreProfile(user.handle));
    const statusEl=document.createElement('span'); statusEl.className='queue-status'; statusEl.textContent={pending:'Follow back',danger:'危险',followed:'已回关',changed:'状态变化',unreadable:'需复核'}[user.status] || user.status;
    item.append(text,inspect,statusEl); root.append(item);
  }
}
const optionKeys = ['target', 'limit', 'minRatio', 'maxRatio', 'minCount', 'delay', 'requirePromise'];

function settings() {
  const result = Object.fromEntries(optionKeys.map(key => [key, key === 'requirePromise' ? $(key).checked : $(key).value]));
  result.target = normalizeHandle(result.target);
  for (const key of ['limit', 'minRatio', 'maxRatio', 'minCount', 'delay']) {
    result[key] = Number(result[key]);
    if (!Number.isFinite(result[key])) throw new Error('筛选条件必须是有效数字。');
  }
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 500 || result.minRatio <= 0 || result.minRatio > result.maxRatio || result.minCount < 0 || result.delay < 3 || result.delay > 60) throw new Error('请检查设置：数量 1–500，比例下限不大于上限，访问间隔 3–60 秒。');
  return result;
}

function render() {
  const body = $('results');
  body.replaceChildren();
  const visible = rows.map(row => assess(row, options || { minRatio: 0.7, maxRatio: 1.4, minCount: 50, requirePromise: true })).filter(row => $('filter').value === 'all' || row.verdict === $('filter').value);
  for (const row of visible) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    const link = document.createElement('a');
    link.href = row.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${row.name || row.handle} · @${row.handle}`;
    td.append(link);
    for (const text of [row.bio, row.status === 'ok' ? '' : row.error, `检查时间：${new Date(row.checkedAt).toLocaleString()}`]) {
      if (!text) continue;
      const p = document.createElement('p');
      p.textContent = text;
      td.append(p);
    }
    tr.append(td);
    for (const text of [row.followers === null ? '未读取' : row.followers.toLocaleString(), row.following === null ? '未读取' : row.following.toLocaleString(), row.ratio === null ? '—' : row.ratio.toFixed(2), row.promise ? '有相关描述' : '未发现']) {
      const cell = document.createElement('td');
      cell.textContent = text;
      tr.append(cell);
    }
    const result = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${row.verdict === '候选' ? 'candidate' : row.verdict === '未命中' ? '' : 'review'}`;
    badge.textContent = row.verdict;
    result.append(badge);
    if (row.verdict === '候选') {
      const explore = document.createElement('button');
      explore.className = 'secondary';
      explore.style.marginLeft = '8px';
      explore.textContent = '查看资料';
      explore.addEventListener('click', () => exploreProfile(row));
      result.append(explore);
      const follow = document.createElement('button');
      follow.className = 'queue-status';
      follow.style.marginLeft = '8px';
      follow.textContent = '打开并关注';
      follow.addEventListener('click', () => followCandidate(row, follow));
      result.append(follow);
    }
    tr.append(result);
    body.append(tr);
  }
  $('empty').hidden = visible.length > 0;
  $('empty').textContent = rows.length ? '当前筛选下没有结果。' : '还没有检查记录。输入目标账号开始。';
}

async function backgroundProfileTab(handle) {
  const tab = await chrome.tabs.create({url:`https://x.com/${handle}`, active:false});
  if (!tab?.id) throw new Error('后台标签页创建失败');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === 'complete') return tab.id;
    await sleep(500);
  }
  throw new Error('后台标签页加载超时');
}

async function collectRelations(handle) {
  const tabId = await backgroundProfileTab(handle);
  try {
    await sleep(1200);
    const profile = await networkFetch(tabId, 'UserByScreenName', {screen_name:handle});
    if (profile.status !== 200) throw new Error(profile.error || '未捕获 profile 网络模板，请先在 X 打开一次主页。');
    const owner = parseNetworkUsers(profile.json).find(user => user.handle.toLowerCase() === handle.toLowerCase());
    if (!owner?.id) throw new Error('没有读取到该账号的用户 ID。');
    const collect = async operation => {
      const found = new Map(); let cursor = '';
      for (let page=0; page<10 && found.size<500; page++) {
        const response = await networkFetch(tabId, operation, {userId:owner.id, count:100, ...(cursor ? {cursor} : {})});
        if (response.status !== 200) throw new Error(response.error || `${operation} 网络请求失败（${response.status}）`);
        for (const user of parseNetworkUsers(response.json)) if (user.handle.toLowerCase() !== handle.toLowerCase()) found.set(user.handle.toLowerCase(), user);
        const next=findCursor(response.json); if (!next || next === cursor) break; cursor=next;
      }
      return [...found.values()];
    };
    return {handle, following:await collect('Following'), followers:await collect('Followers'), checkedAt:new Date().toISOString()};
  } finally { await chrome.tabs.remove(tabId).catch(() => {}); }
}

async function saveExplorer() { await chrome.storage.local.set({explorer}); persist('explorer', explorer); }
async function exploreProfile(userOrHandle) {
  const handle = typeof userOrHandle === 'string' ? userOrHandle : userOrHandle.handle;
  setTab('explorer'); explorerStatus(`正在后台打开 @${handle}，不会切换当前窗口…`);
  try {
    const result = await collectRelations(handle);
    explorer.selected = {handle, checkedAt:result.checkedAt}; explorer.following=result.following; explorer.followers=result.followers;
    await saveExplorer(); renderExplorer(); explorerStatus(`已收集 @${handle}：${result.following.length} 个 following，${result.followers.length} 个 followers。可继续把账号加入跟进队列。`);
  } catch (error) { explorerStatus(`采集 @${handle} 失败：${error.message}`); }
}
async function addExplorerQueue(user, role='following') {
  const key=explorerKey(user); if (!key || (explorer.queue || []).some(item => explorerKey(item) === key)) return;
  explorer.queue.push({...user, role, status:'pending', addedAt:new Date().toISOString()}); await saveExplorer(); renderExplorer(); processExplorerQueue();
}
async function processExplorerQueue() {
  if (explorerRunning) return; explorerRunning=true;
  try {
    while (true) {
      const item=(explorer.queue || []).find(entry => entry.status === 'pending'); if (!item) break;
      item.status='running'; renderExplorer(); await saveExplorer(); explorerStatus(`正在后台采集 @${item.handle} 的 following 和 followers…`);
      try {
        const result=await collectRelations(item.handle); item.status='done'; item.checkedAt=result.checkedAt; item.following=result.following; item.followers=result.followers;
        explorer.selected=item; explorer.following=result.following; explorer.followers=result.followers;
        explorerStatus(`已完成 @${item.handle}：${result.following.length} 个 following，${result.followers.length} 个 followers。`);
      } catch (error) { item.status='error'; item.error=error.message; explorerStatus(`@${item.handle} 采集失败：${error.message}`); }
      await saveExplorer(); renderExplorer();
    }
  } finally { explorerRunning=false; }
}

async function followCandidate(row, button) {
  button.disabled = true;
  button.textContent = '正在打开…';
  try {
    const win = await chrome.windows.create({url:`https://x.com/${row.handle}`, type:'popup', state:'minimized', focused:false});
    const tab = win.tabs?.[0];
    if (!tab?.id) throw new Error('后台窗口创建失败');
    const deadline = Date.now() + 30000;
    let lastReason = '主页尚未准备好';
    while (Date.now() < deadline) {
      await sleep(800);
      const current = await chrome.tabs.get(tab.id);
      if (current.status !== 'complete') continue;
      const result = (await chrome.scripting.executeScript({target:{tabId:tab.id}, func:clickFollowOnProfile, args:[row.handle]}))[0]?.result;
      if (result?.ok) { button.textContent = '已点击关注'; button.className = 'queue-status'; return; }
      lastReason = result?.reason || lastReason;
      if (['already_following','follow_button_unavailable'].includes(lastReason)) break;
    }
    button.textContent = lastReason === 'already_following' ? '已关注' : '未执行';
    status(`@${row.handle} 未执行关注：${lastReason}`);
  } catch (error) {
    button.textContent = '失败';
    status(`打开 @${row.handle} 失败：${error.message}`);
  } finally { button.disabled = false; }
}

async function invoke(func, args) {
  const results = await chrome.scripting.executeScript({ target: { tabId: inspectionTab }, func, args });
  if (!results[0]) throw new Error('无法读取页面。请检查 X 登录状态和扩展的网站访问权限。');
  return results[0].result;
}

async function navigate(url) {
  await chrome.tabs.update(inspectionTab, { url });
  const deadline = Date.now() + 30000;
  while (!stopped && Date.now() < deadline) {
    const tab = await chrome.tabs.get(inspectionTab);
    if (tab.status === 'complete' && tab.url?.replace(/\/$/, '') === url.replace(/\/$/, '')) return;
    await sleep(500);
  }
  if (!stopped) throw new Error('页面未能加载，已停止。请检查网络、登录或 X 的访问限制。');
}

async function waitInterruptibly(ms) {
  const deadline = Date.now() + ms;
  while (!stopped && Date.now() < deadline) await sleep(Math.min(250, deadline - Date.now()));
}

$('start').addEventListener('click', async () => {
  if (running) return;
  try { options = settings(); } catch (error) { status(error.message); return; }
  running = true;
  stopped = false;
  $('start').disabled = true;
  $('stop').disabled = false;
  $('clear').disabled = true;
  for (const key of optionKeys) $(key).disabled = true;
  rows = [];
  render();
  try {
    await chrome.storage.local.set({ options, rows });
    persist('rows', rows);
    const tab = await chrome.tabs.create({ url: `https://x.com/${options.target}/following`, active: true });
    inspectionTab = tab.id;
    await navigate(`https://x.com/${options.target}/following`);
    const handles = new Map();
    let idleRounds = 0;
    let ready = false;
    const networkHandles = await scanFollowingFromNetwork(inspectionTab, options.target, options.limit).catch(() => null);
    if (networkHandles?.length) {
      for (const handle of networkHandles) handles.set(handle.toLowerCase(), handle);
      ready = true;
      status(`已通过 X 网络接口静默读取 ${handles.size} 个 following 账号。`);
    }
    for (let round = 0; !stopped && !networkHandles?.length && round < 150 && handles.size < options.limit && idleRounds < 8; round++) {
      const result = await invoke(collectVisible, [options.target]);
      ready ||= result.ready;
      const before = handles.size;
      for (const handle of result.handles) {
        if (handles.size >= options.limit) break;
        handles.set(handle.toLowerCase(), handle);
      }
      idleRounds = handles.size === before ? idleRounds + 1 : 0;
      status(`正在滚动 following，已收集 ${handles.size} 个账号。可随时停止。`);
      await waitInterruptibly(1800);
    }
    if (!stopped && !handles.size) throw new Error(ready ? '未读取到 following。可能列表为空、不可见或尚未加载；请在检查标签页确认后重试。' : '未读取到列表。请确认已登录 X，且目标账号的 following 可访问。');
    let failed = 0;
    for (const handle of handles.values()) {
      if (stopped) break;
      status(`正在查看 @${handle} 的 profile（${rows.length + 1}/${handles.size}）`);
      const url = `https://x.com/${handle}`;
      await navigate(url);
      if (stopped) break;
      let data = { pending: true };
      const deadline = Date.now() + 18000;
      while (!stopped && Date.now() < deadline) {
        data = await invoke(readProfile, [handle]);
        if (!data.pending) break;
        await waitInterruptibly(700);
      }
      if (stopped) break;
      const profile = { ...data, handle, url, followers: data.pending ? null : parseCount(data.followersText), following: data.pending ? null : parseCount(data.followingText), checkedAt: new Date().toISOString(), sourceTarget: options.target };
      profile.status = !data.pending && profile.followers !== null && profile.following !== null ? 'ok' : 'unreadable';
      profile.error = profile.status === 'ok' ? '' : '资料不可读、访问受限、人数缺失或页面结构变化，请打开主页复核。';
      failed = profile.status === 'ok' ? 0 : failed + 1;
      rows.push(profile);
      await chrome.storage.local.set({ rows });
      persist('rows', rows);
      render();
      if (failed >= 3) throw new Error('连续 3 个 profile 未能读取，已停止。请检查登录状态、访问限制或页面变化，已有结果已保存。');
      await waitInterruptibly(options.delay * 1000);
    }
    status(`${stopped ? '已停止' : '本轮结束'}，已检查 ${rows.length} 个账号。列表受 X 可见范围限制，不保证收集完整。`);
  } catch (error) {
    status(`检查中断：${error.message}`);
  } finally {
    running = false;
    $('start').disabled = false;
    $('stop').disabled = true;
    $('clear').disabled = false;
    for (const key of optionKeys) $(key).disabled = false;
  }
});
$('stop').addEventListener('click', () => { stopped = true; status('正在停止，已完成的记录会保留。'); });
$('filter').addEventListener('change', render);
for (const key of ['minRatio', 'maxRatio', 'minCount', 'requirePromise']) $(key).addEventListener('change', () => {
  try { options = settings(); render(); chrome.storage.local.set({ options }); } catch (error) { status(error.message); }
});
$('export').addEventListener('click', () => {
  const assessed = rows.map(row => assess(row, options || settings()));
  const url = URL.createObjectURL(new Blob([csv(assessed)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `x-following-${options?.target || 'results'}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('clear').addEventListener('click', async () => { rows = []; await chrome.storage.local.remove('rows'); persist('rows', []); render(); status('本地检查记录已清空。'); });

async function saveMonitorSettings() {
  const next = {enabled:$('monitorEnabled').checked, every:Number($('monitorEvery').value), batch:Number($('followBatch').value), batchEvery:Number($('batchEvery').value)};
  if (![next.every,next.batch,next.batchEvery].every(Number.isFinite) || next.every < 10 || next.batch < 1 || next.batch > 20 || next.batchEvery < 5) throw new Error('检查间隔至少 10 分钟，每批 1–20 个，批次间隔至少 5 分钟。');
  monitor = {...monitor, ...next};
  await chrome.storage.local.set({monitor});
  persist('monitor', monitor);
  await chrome.alarms.clear('x-followers-scan');
  if (monitor.enabled) await chrome.alarms.create('x-followers-scan', {periodInMinutes:monitor.every});
}

async function followerTab() {
  const tabs = await chrome.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
  const existing = tabs.find(tab => { try { return /\/followers\/?$/.test(new URL(tab.url).pathname); } catch { return false; } });
  const tab = existing || await chrome.tabs.create({url:'https://x.com/followers', active:true});
  await chrome.tabs.update(tab.id, {url:'https://x.com/followers'});
  await sleep(2500);
  return tab.id;
}

async function readOwnHandle(tabId) {
  const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:() => document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replace(/^\//,'').split('/')[0] || ''});
  return result?.[0]?.result || '';
}

async function scanFollowingFromNetwork(tabId, target, limit) {
  const profile = await networkFetch(tabId, 'UserByScreenName', {screen_name:target});
  if (profile.status !== 200) return null;
  const owner = parseNetworkUsers(profile.json).find(user => user.handle.toLowerCase() === target.toLowerCase());
  if (!owner?.id) return null;
  const found = new Map(); let cursor = '';
  for (let page=0; page<10 && found.size<limit; page++) {
    const response = await networkFetch(tabId, 'Following', {userId:owner.id, count:100, ...(cursor ? {cursor} : {})});
    if (response.status !== 200) return null;
    for (const user of parseNetworkUsers(response.json)) if (user.handle.toLowerCase() !== target.toLowerCase()) found.set(user.handle.toLowerCase(), user.handle);
    const next = findCursor(response.json); if (!next || next === cursor) break; cursor = next;
  }
  return [...found.values()].slice(0, limit);
}

async function scanFollowersFromNetwork(tabId, knownHandles = new Set()) {
  const handle = await readOwnHandle(tabId);
  if (!handle) return null;
  const profile = await networkFetch(tabId, 'UserByScreenName', {screen_name:handle});
  if (profile.status !== 200) return null;
  const me = parseNetworkUsers(profile.json).find(user => user.handle.toLowerCase() === handle.toLowerCase());
  if (!me?.id) return null;
  const found = new Map(); let cursor = '';
  for (let page=0; page<10 && found.size<500; page++) {
    const response = await networkFetch(tabId, 'Followers', {userId:me.id, count:100, ...(cursor ? {cursor} : {})});
    if (response.status !== 200) return null;
    let pageHasNew = false;
    for (const user of parseNetworkUsers(response.json)) if (user.handle.toLowerCase() !== handle.toLowerCase()) { if (!knownHandles.has(user.handle.toLowerCase())) pageHasNew = true; found.set(user.handle.toLowerCase(), user); }
    if (knownHandles.size && page > 0 && !pageHasNew) break;
    const next = findCursor(response.json); if (!next || next === cursor) break; cursor = next;
  }
  return [...found.values()];
}

async function scanFollowerList() {
  const tabId = await followerTab();
  const knownHandles = new Set((monitor.users || []).map(user => user.handle.toLowerCase()));
  const networkUsers = await scanFollowersFromNetwork(tabId, knownHandles).catch(() => null);
  if (networkUsers?.length) {
    const previous = new Map((monitor.users || []).map(user => [user.handle.toLowerCase(), user]));
    for (const user of networkUsers) previous.set(user.handle.toLowerCase(), {...previous.get(user.handle.toLowerCase()), ...user});
    const users = [...previous.values()];
    const queueMap = new Map((monitor.queue || []).map(user => [user.handle.toLowerCase(), user]));
    for (const user of networkUsers) if (user.state === 'follow_back' && !queueMap.has(user.handle.toLowerCase())) { const risk = riskAssess(user); queueMap.set(user.handle.toLowerCase(), {...user, risk, discoveredAt:new Date().toISOString(), status:risk.level === 'danger' ? 'danger' : 'pending'}); }
    const queue = [...queueMap.values()];
    queue.sort((a,b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
    monitor = {...monitor, users, queue, lastScan:new Date().toISOString(), source:'network'};
    await chrome.storage.local.set({monitor}); persist('monitor', monitor); renderQueue();
    monitorStatus(`本次发现 ${networkUsers.filter(user => !knownHandles.has(user.handle.toLowerCase())).length} 个新粉丝，累计保存 ${users.length} 个；待回关 ${queue.filter(user => user.status === 'pending').length} 个，危险标记 ${queue.filter(user => user.status === 'danger').length} 个。`);
    return;
  }
  monitorStatus('网络模板尚未捕获，退回页面列表读取…');
  const found = new Map(); let idle = 0;
  for (let i=0; i<100 && found.size<500 && idle<8; i++) {
    const result = (await chrome.scripting.executeScript({target:{tabId}, func:scanFollowers}))[0]?.result;
    const before = found.size;
    for (const user of result?.users || []) found.set(user.handle.toLowerCase(), user);
    idle = before === found.size ? idle + 1 : 0;
    await sleep(1200);
  }
  const users = [...found.values()];
  const previous = new Map((monitor.users || []).map(user => [user.handle.toLowerCase(), user]));
  for (const user of users) previous.set(user.handle.toLowerCase(), {...previous.get(user.handle.toLowerCase()), ...user});
  const allUsers = [...previous.values()];
  const queueMap = new Map((monitor.queue || []).map(user => [user.handle.toLowerCase(), user]));
  for (const user of users.filter(item => item.state === 'follow_back')) if (!queueMap.has(user.handle.toLowerCase())) { const risk=riskAssess(user); queueMap.set(user.handle.toLowerCase(), {...user, risk, discoveredAt:new Date().toISOString(), status:risk.level === 'danger' ? 'danger' : 'pending'}); }
  const queue = [...queueMap.values()];
  queue.sort((a,b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
  monitor = {...monitor, users:allUsers, queue, lastScan:new Date().toISOString()};
  await chrome.storage.local.set({monitor});
  persist('monitor', monitor);
  renderQueue();
  monitorStatus(`本次读取 ${users.length} 个可见粉丝，累计保存 ${allUsers.length} 个；待回关 ${queue.filter(user => user.status === 'pending').length} 个，危险标记 ${queue.filter(user => user.status === 'danger').length} 个（已排除）。`);
}

async function processFollowBack() {
  if (monitor.pausedUntil && Date.now() < new Date(monitor.pausedUntil).getTime()) { monitorStatus(`已暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}，不会重复尝试。`); return; }
  const pending = (monitor.queue || []).filter(user => user.status === 'pending' && user.risk?.level !== 'danger').slice(0, monitor.batch);
  if (!pending.length) { monitorStatus('没有待回关账号，请先扫描粉丝列表。'); return; }
  const tabId = await followerTab(); let completed = 0;
  for (const user of pending) {
    const result = (await chrome.scripting.executeScript({target:{tabId}, func:clickFollowBack, args:[user.handle]}))[0]?.result;
    if (result?.reason === 'rate_limited') { monitor.pausedUntil = new Date(Date.now() + 60 * 60000).toISOString(); monitorStatus('检测到 X 限制，已暂停本批，约一小时后再提醒。'); break; }
    if (!result?.ok) { user.status = result?.reason || 'unreadable'; continue; }
    user.status = 'followed'; user.followedAt = new Date().toISOString(); completed++;
    await sleep(Math.max(15000, monitor.batchEvery * 60000 / pending.length));
  }
  monitor.queue = monitor.queue.map(item => pending.find(user => user.handle === item.handle) || item);
  await chrome.storage.local.set({monitor});
  renderQueue();
  monitorStatus(`本批已处理 ${completed} 个，剩余 ${monitor.queue.filter(user => user.status === 'pending').length} 个。`);
}

$('scanFollowers').addEventListener('click', async () => { try { monitorStatus('正在打开粉丝列表并滚动收集账号…'); await scanFollowerList(); } catch (error) { monitorStatus(`扫描失败：${error.message}`); } });
$('processFollowBack').addEventListener('click', async () => { try { await processFollowBack(); } catch (error) { monitorStatus(`处理失败：${error.message}`); } });
$('monitorEnabled').addEventListener('change', () => saveMonitorSettings().then(() => monitorStatus(monitor.enabled ? `已启用，每 ${monitor.every} 分钟提醒。` : '已关闭定时提醒。')).catch(error => monitorStatus(error.message)));
for (const id of ['monitorEvery','followBatch','batchEvery']) $(id).addEventListener('change', () => saveMonitorSettings().catch(error => monitorStatus(error.message)));
$('queueFilter').addEventListener('change', renderQueue);
$('processExplorerQueue').addEventListener('click', () => processExplorerQueue().catch(error => explorerStatus(`跟进队列失败：${error.message}`)));

function grokPrompt() {
  const items = analysisRows.map((row, index) => [`账号 ${index + 1}`, `用户名：@${row.handle}`, `主页：${row.url}`, `名称：${row.name || ''}`, `简介：${row.bio || ''}`, `粉丝：${row.followersText || '未读取'}`, `关注：${row.followingText || '未读取'}`, `本地危险信号：${row.risk?.level === 'danger' ? `危险（${row.risk.hits.join('、')}）` : '未命中规则'}`, `最近帖子：`, ...(row.posts || []).map((post, postIndex) => `${postIndex + 1}. ${post.text}${post.time ? `（${post.time}）` : ''}${post.url ? ` ${post.url}` : ''}`)].join('\n')).join('\n\n---\n\n');
  return `你是 X 账号筛选助手。下面是同一批 ${analysisRows.length} 个账号的公开 profile 和最近帖子。请逐个输出：\n1. 账号主题与真实活跃方向；\n2. 是否像普通交流账号、营销号、互关号或可疑账号；\n3. 关注/粉丝比例与简介承诺是否一致；\n4. 最近帖子质量、原创性和明显风险，特别标记擦边色情、成人平台、私密导流、博彩、诈骗或可疑外链；\n5. 是否值得人工回关（值得 / 谨慎 / 不建议）及一句理由。危险账号默认不建议回关。最后按“值得回关优先级”给出排序。不要把简介里的“互关/回关”当成事实，要结合最近帖子判断。\n\n${items}`;
}

async function collectAnalysisBatch() {
  const count = Math.max(1, Math.min(20, Number($('analysisBatch').value) || 15));
  const recentLimit = Math.max(1, Math.min(5, Number($('recentPosts').value) || 5));
  const pending = (monitor.queue || []).filter(user => user.status === 'pending' && user.risk?.level !== 'danger');
  const candidates = pending.length ? pending : rows.filter(row => row.verdict === '候选').map(row => ({handle:row.handle, name:row.name, bio:row.bio, url:row.url}));
  if (!candidates.length) throw new Error('没有待分析账号，请先扫描粉丝或完成 profile 检查。');
  analysisRows = []; inspectionTab = await followerTab();
  for (const user of candidates.slice(0, count)) {
    analysisStatus(`正在收集 @${user.handle} 的 profile 和最近帖子（${analysisRows.length + 1}/${Math.min(count, candidates.length)}）…`);
    await navigate(`https://x.com/${user.handle}`);
    let data = {pending:true}; const deadline = Date.now() + 18000;
    while (Date.now() < deadline && data.pending) { data = await invoke(readProfileBundle, [user.handle, recentLimit]); if (data.pending) await sleep(700); }
    const row = {...user, ...data, handle:user.handle, url:`https://x.com/${user.handle}`, posts:data.posts || []};
    analysisRows.push({...row, risk:riskAssess(row)});
  }
  await chrome.storage.local.set({analysisRows});
  persist('analysisRows', analysisRows);
  analysisStatus(`已收集 ${analysisRows.length} 个账号，每个包含最多 ${recentLimit} 条最近帖子。可以复制到 Grok。`);
}

async function submitBatchToGrok() {
  if (!analysisRows.length) await collectAnalysisBatch();
  const prompt = grokPrompt();
  const created = await chrome.windows.create({url:'https://x.com/i/grok', type:'popup', state:'minimized', focused:false});
  const tabId = created.tabs?.[0]?.id;
  if (!tabId) throw new Error('Grok 窗口创建失败。');
  await chrome.storage.local.set({grokWindowId:created.id, grokSubmittedAt:new Date().toISOString()});
  const deadline = Date.now() + 30000;
  let lastReason = 'Grok 页面尚未准备好';
  while (Date.now() < deadline) {
    await sleep(1000);
    const result = (await chrome.scripting.executeScript({target:{tabId}, func:(text) => {
      const input = document.querySelector('textarea, [contenteditable="true"]');
      if (!input) return {ok:false, reason:'找不到 Grok 输入框'};
      if (input.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, text);
      } else {
        input.textContent = text;
      }
      input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      const send = [...document.querySelectorAll('button')].find(button => {
        const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''} ${button.getAttribute('data-testid') || ''}`;
        return /send|提交|发送/i.test(label) && !button.disabled;
      });
      if (!send) return {ok:false, reason:'找不到 Grok 发送按钮'};
      send.click();
      return {ok:true};
    }, args:[prompt]}))[0]?.result;
    if (result?.ok) { analysisStatus(`已在最小化 Grok 窗口提交 ${analysisRows.length} 个账号的分析请求。`); return; }
    lastReason = result?.reason || lastReason;
  }
  await navigator.clipboard.writeText(prompt);
  throw new Error(`${lastReason}。分析包已复制到剪贴板，请在 Grok 窗口粘贴发送。`);
}

$('collectAnalysis').addEventListener('click', async () => { try { await collectAnalysisBatch(); } catch (error) { analysisStatus(`收集失败：${error.message}`); } });
$('submitGrok').addEventListener('click', async () => { try { analysisStatus('正在收集资料并打开最小化 Grok 窗口…'); await submitBatchToGrok(); } catch (error) { analysisStatus(`提交失败：${error.message}`); } });
$('copyGrok').addEventListener('click', async () => { try { if (!analysisRows.length) await collectAnalysisBatch(); await navigator.clipboard.writeText(grokPrompt()); analysisStatus(`已复制 ${analysisRows.length} 个账号的 Grok 分析包，打开 Grok 后粘贴一次即可。`); } catch (error) { analysisStatus(`复制失败：${error.message}`); } });
$('openGrok').addEventListener('click', async () => { await chrome.tabs.create({url:'https://x.com/i/grok', active:true}); });
window.addEventListener('beforeunload', event => { if (running) { event.preventDefault(); event.returnValue = ''; } });
try {
  const saved = await chrome.storage.local.get(['rows', 'options']);
  rows = saved.rows || [];
  options = saved.options;
  if (options) for (const key of optionKeys) {
    if (options[key] !== undefined) {
      if (key === 'requirePromise') $(key).checked = options[key];
      else $(key).value = options[key];
    }
  }
  if (rows.length) status(`已恢复 ${rows.length} 条本地记录。未完成的检查需重新开始。`);
  render();
} catch (error) { status(`本地记录加载失败：${error.message}`); }

try {
  const savedMonitor = await chrome.storage.local.get('monitor');
  monitor = {...monitor, ...(savedMonitor.monitor || {})};
  $('monitorEnabled').checked = !!monitor.enabled;
  $('monitorEvery').value = monitor.every;
  $('followBatch').value = monitor.batch;
  $('batchEvery').value = monitor.batchEvery;
  if (monitor.lastScan) monitorStatus(`上次扫描 ${new Date(monitor.lastScan).toLocaleString()}，待回关 ${monitor.queue?.filter(user => user.status === 'pending').length || 0} 个。`);
  renderQueue();
} catch (error) { monitorStatus(`定时检查记录加载失败：${error.message}`); }

try {
  const savedAnalysis = await chrome.storage.local.get(['analysisRows', 'explorer']);
  analysisRows = savedAnalysis.analysisRows || [];
  explorer = {...explorer, ...(savedAnalysis.explorer || {})};
  if (analysisRows.length) analysisStatus(`已恢复上次收集的 ${analysisRows.length} 个账号资料。`);
  renderExplorer();
} catch (error) { analysisStatus(`分析记录加载失败：${error.message}`); }

setTab('candidates');

try {
  const [savedRows, savedMonitor, savedAnalysis, savedExplorer] = await Promise.all([durableGet('rows'), durableGet('monitor'), durableGet('analysisRows'), durableGet('explorer')]);
  if (!rows.length && Array.isArray(savedRows) && savedRows.length) { rows = savedRows; await chrome.storage.local.set({rows}); render(); status(`已从 X 本地数据库恢复 ${rows.length} 条历史记录。`); }
  if (!monitor.lastScan && savedMonitor) { monitor = {...monitor, ...savedMonitor}; await chrome.storage.local.set({monitor}); renderQueue(); monitorStatus(`已从 X 本地数据库恢复待回关队列。`); }
  if (!analysisRows.length && Array.isArray(savedAnalysis) && savedAnalysis.length) { analysisRows = savedAnalysis; await chrome.storage.local.set({analysisRows}); analysisStatus(`已从 X 本地数据库恢复 ${analysisRows.length} 个历史分析账号。`); }
  if (!(explorer.queue || []).length && savedExplorer) { explorer = {...explorer, ...savedExplorer}; await chrome.storage.local.set({explorer}); renderExplorer(); explorerStatus('已从 X 本地数据库恢复关系探索队列。'); }
} catch (error) { status('本地数据库尚未初始化，将在下一次扫描后建立。'); }
