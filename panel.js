import { normalizeHandle, parseCount, assess, csv } from './scoring.js';
import { collectVisible, readProfile, scanFollowers, clickFollowBack } from './page-reader.js';

const $ = id => document.getElementById(id);
let rows = [];
let running = false;
let stopped = false;
let inspectionTab;
let options;
let monitor = {enabled:false, every:60, batch:10, batchEvery:10, users:[], queue:[], lastScan:null};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = text => { $('status').textContent = text; };
const monitorStatus = text => { $('monitorStatus').textContent = text; };
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
    tr.append(result);
    body.append(tr);
  }
  $('empty').hidden = visible.length > 0;
  $('empty').textContent = rows.length ? '当前筛选下没有结果。' : '还没有检查记录。输入目标账号开始。';
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
    const tab = await chrome.tabs.create({ url: `https://x.com/${options.target}/following`, active: true });
    inspectionTab = tab.id;
    await navigate(`https://x.com/${options.target}/following`);
    const handles = new Map();
    let idleRounds = 0;
    let ready = false;
    for (let round = 0; !stopped && round < 150 && handles.size < options.limit && idleRounds < 8; round++) {
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
$('clear').addEventListener('click', async () => { rows = []; await chrome.storage.local.remove('rows'); render(); status('本地检查记录已清空。'); });

async function saveMonitorSettings() {
  const next = {enabled:$('monitorEnabled').checked, every:Number($('monitorEvery').value), batch:Number($('followBatch').value), batchEvery:Number($('batchEvery').value)};
  if (![next.every,next.batch,next.batchEvery].every(Number.isFinite) || next.every < 10 || next.batch < 1 || next.batch > 20 || next.batchEvery < 5) throw new Error('检查间隔至少 10 分钟，每批 1–20 个，批次间隔至少 5 分钟。');
  monitor = {...monitor, ...next};
  await chrome.storage.local.set({monitor});
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

async function scanFollowerList() {
  const tabId = await followerTab();
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
  const queue = users.filter(user => user.state === 'follow_back').map(user => ({...user, discoveredAt:previous.get(user.handle.toLowerCase())?.discoveredAt || new Date().toISOString(), status:previous.get(user.handle.toLowerCase())?.status === 'followed' ? 'followed' : 'pending'}));
  monitor = {...monitor, users, queue, lastScan:new Date().toISOString()};
  await chrome.storage.local.set({monitor});
  monitorStatus(`最近扫描 ${users.length} 个粉丝，待回关 ${queue.filter(user => user.status === 'pending').length} 个。`);
}

async function processFollowBack() {
  if (monitor.pausedUntil && Date.now() < new Date(monitor.pausedUntil).getTime()) { monitorStatus(`已暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}，不会重复尝试。`); return; }
  const pending = (monitor.queue || []).filter(user => user.status === 'pending').slice(0, monitor.batch);
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
  monitorStatus(`本批已处理 ${completed} 个，剩余 ${monitor.queue.filter(user => user.status === 'pending').length} 个。`);
}

$('scanFollowers').addEventListener('click', async () => { try { monitorStatus('正在打开粉丝列表并滚动收集账号…'); await scanFollowerList(); } catch (error) { monitorStatus(`扫描失败：${error.message}`); } });
$('processFollowBack').addEventListener('click', async () => { try { await processFollowBack(); } catch (error) { monitorStatus(`处理失败：${error.message}`); } });
$('monitorEnabled').addEventListener('change', () => saveMonitorSettings().then(() => monitorStatus(monitor.enabled ? `已启用，每 ${monitor.every} 分钟提醒。` : '已关闭定时提醒。')).catch(error => monitorStatus(error.message)));
for (const id of ['monitorEvery','followBatch','batchEvery']) $(id).addEventListener('change', () => saveMonitorSettings().catch(error => monitorStatus(error.message)));
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
} catch (error) { monitorStatus(`定时检查记录加载失败：${error.message}`); }
