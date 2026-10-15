import { normalizeHandle, parseCount, assess, csv } from './scoring.js';
import { collectVisible, readProfile } from './page-reader.js';

const $ = id => document.getElementById(id);
let rows = [];
let running = false;
let stopped = false;
let inspectionTab;
let options;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = text => { $('status').textContent = text; };
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
