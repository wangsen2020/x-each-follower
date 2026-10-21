import {RECOMMENDED_QUOTE_TAGS, cleanQuoteTag, normalizeQuoteTags, quoteTagSuffix, validateQuoteTags} from '../../features/grok/quote-tags.js';
/**
 * follow-queue-panel.js
 * Unified follow queue panel component (ANTIGRAVITY OWNERSHIP).
 *
 * Implements mountFollowQueuePanel(root, { request, accountId })
 * Secure DOM manipulation (zero untrusted innerHTML).
 */

import { FOLLOW_QUEUE_DEFAULT_SETTINGS } from '../../features/follow-queue/follow-queue-store.js';

export const DEFAULT_SETTINGS = FOLLOW_QUEUE_DEFAULT_SETTINGS || Object.freeze({
  enabled: false,
  every: 8,
  jitter: 2,
  batchLimit: 5,
  inspectLimit: 20,
  timeBudgetMinutes: 10,
  scrollRounds: 5,
  dwellSeconds: 15,
  dwellJitter: 5,
  minFollowers: 50,
  ratioThreshold: 0.8,
  onlyRecommended: true,
  grokEnabled: false,
  autoPublish: false
});

export const SETTINGS_BOUNDS = Object.freeze({
  every: Object.freeze({ min: 1, max: 240, default: 8, type: 'int' }),
  jitter: Object.freeze({ min: 1, max: 120, default: 2, type: 'int' }),
  batchLimit: Object.freeze({ min: 1, max: 50, default: 5, type: 'int' }),
  inspectLimit: Object.freeze({ min: 1, max: 200, default: 20, type: 'int' }),
  timeBudgetMinutes: Object.freeze({ min: 1, max: 120, default: 10, type: 'int' }),
  scrollRounds: Object.freeze({ min: 1, max: 8, default: 5, type: 'int' }),
  dwellSeconds: Object.freeze({ min: 2, max: 60, default: 15, type: 'int' }),
  dwellJitter: Object.freeze({ min: 1, max: 30, default: 5, type: 'int' }),
  minFollowers: Object.freeze({ min: 0, max: 100_000_000, default: 50, type: 'int' }),
  ratioThreshold: Object.freeze({ min: 0, max: 1.0, default: 0.8, type: 'float' }),
  onlyRecommended: Object.freeze({ default: true, type: 'bool' }),
  grokEnabled: Object.freeze({ default: false, type: 'bool' }),
  autoPublish: Object.freeze({ default: false, type: 'bool' }),
  enabled: Object.freeze({ default: false, type: 'bool' })
});

export const STATE_LABELS = Object.freeze({
  pending: '待关注',
  running: '执行中',
  followed: '已关注',
  skipped: '策略跳过',
  retry: '等待重试',
  uncertain: '结果待核实',
  excluded: '已排除'
});

export const MODULE_LABELS = Object.freeze({
  fans: '粉丝管理',
  mutual: '互关追踪',
  comments: '评论追踪'
});

/**
 * Validates external URLs. Rejects javascript:, data:, and any non-https schemes.
 * Returns canonical href or null if invalid/unsafe.
 */
export function safeHttpsUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Builds safe profile URL with encoded handle path.
 */
export function safeHandleUrl(handle) {
  if (typeof handle !== 'string') return null;
  const cleaned = handle.trim().replace(/^@+/, '');
  if (!cleaned) return null;
  return `https://x.com/${encodeURIComponent(cleaned)}`;
}

/**
 * Normalizes and clamps settings within bounds matching store.
 */
export function normalizeSettings(raw = {}) {
  const result = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return result;

  for (const [key, bound] of Object.entries(SETTINGS_BOUNDS)) {
    if (!(key in raw)) continue;
    const val = raw[key];
    if (bound.type === 'bool') {
      result[key] = Boolean(val);
    } else if (bound.type === 'float') {
      const num = parseFloat(val);
      if (Number.isFinite(num)) {
        result[key] = Math.max(bound.min, Math.min(bound.max, Number(num.toFixed(2))));
      }
    } else if (bound.type === 'int') {
      const num = parseInt(val, 10);
      if (Number.isFinite(num)) {
        result[key] = Math.max(bound.min, Math.min(bound.max, num));
      }
    }
  }
  if (result.jitter > result.every) {
    result.jitter = Math.max(1, result.every);
  }
  Object.assign(result, normalizeQuoteTags(raw));
  return result;
}

/**
 * Formats a timestamp into a readable Chinese date string.
 */
function formatTime(val) {
  if (!val) return '-';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return String(val);
  }
}

/**
 * Safe DOM creation helper. Zero innerHTML used.
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (key === 'className') {
      node.className = val;
    } else if (key === 'id') {
      node.id = val;
      node.setAttribute('id', String(val));
    } else if (key === 'style' && typeof val === 'object') {
      Object.assign(node.style, val);
    } else if (key === 'dataset' && typeof val === 'object') {
      for (const [dKey, dVal] of Object.entries(val)) {
        node.dataset[dKey] = dVal;
      }
    } else if (key.startsWith('on') && typeof val === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (typeof val === 'boolean') {
      if (val) node.setAttribute(key, '');
      else node.removeAttribute(key);
    } else if (val !== null && val !== undefined) {
      node.setAttribute(key, String(val));
    }
  }

  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else if (child && (typeof child === 'object' && ('nodeType' in child || 'tagName' in child))) {
      node.appendChild(child);
    }
  }
  return node;
}

/**
 * Mounts the Follow Queue Panel into root.
 *
 * @param {HTMLElement} root Target container element
 * @param {Object} options Configuration options
 * @param {Function} options.request Request dispatcher
 * @param {string} options.accountId Current logged-in X user ID
 * @returns {{ refresh: Function, destroy: Function }} Control handles
 */
export function mountFollowQueuePanel(root, { request, accountId } = {}) {
  if (!root) throw new Error('mountFollowQueuePanel requires a root element');

  let currentAccountId = accountId || '';
  let jobs = [];
  let settings = { ...DEFAULT_SETTINGS };
  let summary = null;
  let loading = false;
  let error = null;
  let settingsFetchError = null;
  let settingsError = null;
  let isSettingsSaving = false;
  let activeReqId = 0;
  let isDestroyed = false;

  // View state
  let stateFilter = 'all';
  let moduleFilter = 'all';
  let searchQuery = '';
  let currentPage = 1;
  let pageSize = 20;
  let serverPaging = false;
  let serverTotal = null;
  let totalKnown = false;
  let serverHasMore = false;
  let startCursors = [null];
  let scanStatus = '';
  let scanActive = false;
  const selectedJobIds = new Set();
  let inspectingJob = null;
  let isSettingsOpen = false;
  let isExecuting = false;
  const busyJobIds = new Set();

  const cleanups = [];

  function clearAccountState() {
    jobs = [];
    selectedJobIds.clear();
    busyJobIds.clear();
    settings = { ...DEFAULT_SETTINGS };
    inspectingJob = null;
    isSettingsOpen = false;
    summary = null;
    error = null;
    settingsFetchError = null;
    settingsError = null;
    currentPage = 1;
    serverPaging = false;
    serverTotal = null;
    totalKnown = false;
    serverHasMore = false;
    startCursors = [null];
    scanStatus = '';
    scanActive = false;
    searchQuery = '';
    stateFilter = 'all';
    moduleFilter = 'all';
    isExecuting = false;
  }

  // Set root class
  root.classList.add('fq-panel-root');

  // DOM node references for fast updates
  let container = null;
  let drawerOverlay = null;

  async function fetchAll() {
    if (isDestroyed) return;
    const reqAccount = currentAccountId;
    const reqId = ++activeReqId;

    if (!reqAccount) {
      clearAccountState();
      loading = false;
      render();
      return;
    }

    loading = true;
    error = null;
    settingsFetchError = null;
    scanStatus = '';
    scanActive = false;
    render();

    const stillCurrent = () => !isDestroyed && currentAccountId === reqAccount && reqId === activeReqId;

    try {
      const settingsPromise = typeof request === 'function'
        ? request({ cmd: 'followQueueSettings', accountId: reqAccount }).catch(err => ({
          ok: false,
          error: err?.message || '获取关注队列配置失败'
        }))
        : Promise.resolve({ ok: false, error: '缺少 request 处理函数' });
      const listRes = typeof request === 'function'
        ? await fillCurrentPage(reqId, reqAccount)
        : { ok: false, error: '缺少 request 处理函数' };
      const settingsRes = await settingsPromise;

      if (!stillCurrent()) return;

      loading = false;
      scanActive = false;

      if (!listRes || listRes.stale) return;
      if (!listRes.ok) {
        const listError = listRes.error || '获取关注队列数据失败';
        if (currentPage !== 1 && /cursor/.test(listError)) {
          currentPage = 1;
          startCursors = [null];
          loading = false;
          return fetchAll();
        }
        error = listError;
      } else {
        jobs = Array.isArray(listRes.jobs) ? listRes.jobs : [];
        serverPaging = listRes.paged === true;
        totalKnown = listRes.totalKnown === true && Number.isFinite(listRes.total);
        serverTotal = totalKnown ? listRes.total : null;
        serverHasMore = listRes.hasMore === true && Boolean(listRes.nextCursor);
        if (serverPaging && listRes.nextCursor) startCursors[currentPage] = listRes.nextCursor;
        summary = listRes.summary || null;
        if (serverPaging && listRes.stats) summary = {...(summary || {}), stats: listRes.stats};
        scanStatus = serverPaging && !totalKnown ? formatScanStatus(listRes.scanned, !serverHasMore) : '';
        if (inspectingJob) {
          inspectingJob = jobs.find(j => j.id === inspectingJob.id) || inspectingJob;
        }
      }

      if (!settingsRes || !settingsRes.ok) {
        settingsFetchError = settingsRes?.error || '获取关注队列配置失败';
      } else if (settingsRes.settings) {
        settings = normalizeSettings(settingsRes.settings);
        settingsFetchError = null;
      }

    } catch (err) {
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      loading = false;
      const message = err?.message || '网络连接或执行异常';
      if (serverPaging && currentPage !== 1 && /cursor/.test(message)) {
        currentPage = 1;
        startCursors = [null];
        loading = false;
        return fetchAll();
      }
      error = message;
    }

    render();
  }

  function formatScanStatus(scanned, done) {
    const count = Number.isFinite(scanned) ? `已扫描 ${scanned} 条` : '';
    if (done) return count ? `已检索完 · ${count}` : '已检索完';
    return count ? `正在检索，${count}…` : '正在继续检索…';
  }

  function scannedCount(payload) {
    if (Number.isFinite(payload?.scanned)) return payload.scanned;
    if (Number.isFinite(payload?.scan?.scanned)) return payload.scan.scanned;
    return null;
  }

  async function fillCurrentPage(reqId, reqAccount) {
    const want = Math.min(100, pageSize);
    let cursor = startCursors[currentPage - 1] || null;
    const collected = [];
    const seen = new Set();
    let hasMore = false;
    let nextCursor = null;
    let total = null;
    let pageTotalKnown = false;
    let stats = null;
    let pageSummary = null;
    let scanned = 0;
    let sawScanned = false;
    let paged = false;
    while (collected.length < want) {
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return {stale: true};
      const asked = want - collected.length;
      const payload = await request({
        cmd: 'followQueueList',
        accountId: reqAccount,
        state: stateFilter,
        source: moduleFilter,
        q: searchQuery,
        cursor,
        limit: asked
      });
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return {stale: true};
      if (!payload || payload.ok === false) return {ok: false, error: payload?.error || '获取关注队列数据失败'};
      if (payload.paged !== true) {
        return {ok: true, paged: false, jobs: Array.isArray(payload.jobs) ? payload.jobs : [], summary: payload.summary || null};
      }
      paged = true;
      const chunk = Array.isArray(payload.jobs) ? payload.jobs : [];
      for (const job of chunk) {
        if (!job || seen.has(job.id) || collected.length >= want) continue;
        seen.add(job.id);
        collected.push(job);
      }
      const batchScanned = scannedCount(payload);
      if (batchScanned != null) {
        sawScanned = true;
        scanned += batchScanned;
      }
      hasMore = payload.hasMore === true || Boolean(payload.nextCursor);
      nextCursor = payload.nextCursor || null;
      if (payload.totalKnown === true && Number.isFinite(payload.total)) {
        pageTotalKnown = true;
        total = payload.total;
      }
      stats = payload.stats || stats;
      pageSummary = payload.summary || pageSummary;
      const shortBatch = chunk.length < asked;
      if (!shortBatch || !hasMore || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
      scanActive = true;
      scanStatus = formatScanStatus(sawScanned ? scanned : null, false);
      render();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return {stale: true};
    return {
      ok: true,
      paged,
      jobs: collected,
      hasMore: hasMore && Boolean(nextCursor) && collected.length >= want,
      nextCursor: hasMore ? nextCursor : null,
      total,
      totalKnown: pageTotalKnown,
      stats,
      summary: pageSummary,
      scanned: sawScanned ? scanned : null
    };
  }

  async function handleRunNow() {
    if (!currentAccountId || isExecuting || isDestroyed || typeof request !== 'function') return;
    const reqAccount = currentAccountId;
    const reqId = ++activeReqId;
    isExecuting = true;
    render();
    try {
      const res = await request({ cmd: 'followQueueRun', accountId: reqAccount });
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      if (!res || !res.ok) {
        error = res?.error || '立即执行失败';
        isExecuting = false;
        render();
        return;
      }
      if (res.summary) summary = res.summary;
      isExecuting = false;
      await fetchAll();
    } catch (err) {
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      error = err?.message || '立即执行失败';
      isExecuting = false;
      render();
    } finally {
      if (!isDestroyed && currentAccountId === reqAccount && isExecuting) {
        isExecuting = false;
        render();
      }
    }
  }

  async function handleVerifyJob(job, mode = 'check') {
    if (!currentAccountId || !job?.id || busyJobIds.has(job.id) || isDestroyed || typeof request !== 'function') return;
    const reqAccount = currentAccountId;
    busyJobIds.add(job.id);
    error = null;
    render();
    try {
      const res = await request({
        cmd: 'followQueueVerify',
        accountId: reqAccount,
        jobId: job.id,
        mode
      });
      if (isDestroyed || currentAccountId !== reqAccount) return;
      if (!res || !res.ok) {
        error = res?.error || res?.reason || '核对主页关系失败';
        render();
        return;
      }
      await fetchAll();
    } catch (err) {
      if (isDestroyed || currentAccountId !== reqAccount) return;
      error = err?.message || '核对主页关系异常';
      render();
    } finally {
      busyJobIds.delete(job.id);
      if (!isDestroyed && currentAccountId === reqAccount) render();
    }
  }

  async function handleRetryEvaluation(job, ev, publish = true) {
    if (!currentAccountId || !job?.id || busyJobIds.has(job.id) || isDestroyed || typeof request !== 'function') return;
    const reqAccount = currentAccountId;
    busyJobIds.add(job.id);
    error = null;
    render();
    try {
      const res = await request({
        cmd: 'followQueueRetryEvaluation',
        accountId: reqAccount,
        jobId: job.id,
        taskId: ev?.taskId || '',
        publish
      });
      if (isDestroyed || currentAccountId !== reqAccount) return;
      if (!res || !res.ok) {
        error = res?.error || res?.reason || '重试引用评价失败';
        render();
        return;
      }
      await fetchAll();
    } catch (err) {
      if (isDestroyed || currentAccountId !== reqAccount) return;
      error = err?.message || '重试引用评价异常';
      render();
    } finally {
      busyJobIds.delete(job.id);
      if (!isDestroyed && currentAccountId === reqAccount) render();
    }
  }

  async function handleToggleAutoSchedule(nextEnabled) {
    if (!currentAccountId || isDestroyed || typeof request !== 'function') return;
    const reqAccount = currentAccountId;
    const reqId = ++activeReqId;
    try {
      const res = await request(nextEnabled
        ? { cmd: 'followQueueSaveSettings', accountId: reqAccount, settings: { enabled: true } }
        : { cmd: 'followQueuePause', accountId: reqAccount });
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      if (!res || !res.ok) {
        error = res?.error || '切换自动调度状态失败';
        render();
        return;
      }
      if (res.settings) settings = normalizeSettings(res.settings);
      else settings.enabled = nextEnabled;
      if (res.summary) summary = res.summary;
      await fetchAll();
    } catch (err) {
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      error = err?.message || '切换自动调度状态异常';
      render();
    }
  }

  async function handleStopExecution() {
    if (!currentAccountId || isDestroyed || typeof request !== 'function') return;
    const reqAccount = currentAccountId;
    const reqId = ++activeReqId;
    isExecuting = false;
    render();
    try {
      const res = await request({ cmd: 'followQueuePause', accountId: reqAccount });
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      if (res?.summary) summary = res.summary;
      await fetchAll();
    } catch (err) {
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      error = err?.message || '停止执行失败';
      render();
    }
  }

  async function handleTogglePause() {
    return handleToggleAutoSchedule(!settings.enabled);
  }

  async function handleSaveSettings(formValues) {
    if (!currentAccountId || isDestroyed || typeof request !== 'function' || isSettingsSaving || settingsFetchError) return;
    const reqAccount = currentAccountId;
    const reqId = ++activeReqId;
    const validated = normalizeSettings(formValues);
    try { validateQuoteTags(validated); } catch(error) { settingsError=error.message; render(); return; }
    isSettingsSaving = true;
    settingsError = null;
    render();
    try {
      const res = await request({ cmd: 'followQueueSaveSettings', accountId: reqAccount, settings: validated });
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      if (res && res.ok) {
        settings = normalizeSettings(res.settings || validated);
        isSettingsOpen = false;
        isSettingsSaving = false;
        await fetchAll();
      } else {
        settingsError = res?.error || '保存配置失败';
        isSettingsSaving = false;
        render();
      }
    } catch (err) {
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      settingsError = err?.message || '保存配置请求异常';
      isSettingsSaving = false;
      render();
    } finally {
      if (!isDestroyed && currentAccountId === reqAccount && isSettingsSaving) {
        isSettingsSaving = false;
        render();
      }
    }
  }

  function resetPageQuery() {
    currentPage = 1;
    startCursors = [null];
  }

  function applyListChange() {
    resetPageQuery();
    if (serverPaging) fetchAll();
    else render();
  }

  function turnPage(page) {
    if (page < 1 || page === currentPage) return;
    if (serverPaging && page > 1 && !Object.prototype.hasOwnProperty.call(startCursors, page - 1)) return;
    currentPage = page;
    if (serverPaging) fetchAll();
    else render();
  }

  function getFilteredJobs() {
    if (serverPaging) return jobs;
    return jobs.filter(job => {
      if (stateFilter !== 'all' && job.state !== stateFilter) return false;
      if (moduleFilter !== 'all') {
        const hasModule = Array.isArray(job.sources) && job.sources.some(s => s.module === moduleFilter);
        if (!hasModule) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const handleMatch = [job.handle,job.profile?.name,job.profile?.bio].some(v=>String(v||'').toLowerCase().includes(q));
        const idMatch = job.targetUserId && String(job.targetUserId).includes(q);
        if (!handleMatch && !idMatch) return false;
      }
      return true;
    });
  }

  function computeStats() {
    const stats = {
      total: jobs.length,
      pending: 0,
      running: 0,
      followed: 0,
      skipped: 0,
      retry: 0,
      uncertain: 0,
      excluded: 0
    };
    for (const job of jobs) {
      if (job.state in stats) stats[job.state]++;
    }
    return stats;
  }

  // --- Render Helpers ---

  function renderHeader() {
    const autoScheduleSwitch = el('label', {
      className: 'fq-header-switch-label',
      title: '开启后后台按设定周期自动在后台调度关注任务'
    }, [
      el('input', {
        type: 'checkbox',
        className: 'fq-switch-checkbox',
        checked: Boolean(settings.enabled),
        disabled: !currentAccountId,
        onChange: e => handleToggleAutoSchedule(e.target.checked)
      }),
      el('span', { className: 'fq-switch-title' }, '定时自动调度')
    ]);

    const settingsBtn = el('button', {
      type: 'button',
      className: 'icon-button secondary fq-header-icon-btn',
      title: '关注队列设置',
      'aria-label': '关注队列设置',
      onClick: () => { isSettingsOpen = true; render(); }
    }, [
      el('span', { className: 'fq-btn-icon-symbol' }, '⚙️')
    ]);

    const refreshBtn = el('button', {
      type: 'button',
      className: 'icon-button secondary fq-header-icon-btn',
      title: '刷新队列',
      'aria-label': '刷新队列',
      onClick: () => fetchAll()
    }, [
      el('span', { className: 'fq-btn-icon-symbol' }, '↻')
    ]);

    const execBtn = isExecuting
      ? el('button', {
          type: 'button',
          className: 'icon-button fq-action-icon-btn fq-btn-danger fq-exec-stop-btn fq-btn-executing',
          title: '停止执行',
          'aria-label': '停止执行',
          disabled: !currentAccountId,
          onClick: handleStopExecution
        }, [
          el('span', { className: 'fq-btn-icon-symbol' }, '⏹')
        ])
      : el('button', {
          type: 'button',
          className: 'icon-button fq-action-icon-btn fq-btn-primary fq-exec-run-btn',
          title: '立即执行',
          'aria-label': '立即执行',
          disabled: !currentAccountId,
          onClick: handleRunNow
        }, [
          el('span', { className: 'fq-btn-icon-symbol' }, '⚡')
        ]);

    return el('div', { className: 'fq-header' }, [
      el('div', { className: 'fq-header-title-wrap' }, [
        el('h2', { className: 'fq-header-title' }, [
          el('span', { className: 'fq-title-icon' }, '🎯'),
          '关注队列'
        ]),
        el('span', { className: 'fq-header-subtitle' }, '唯一后台调度器 · 统一候选执行中心')
      ]),
      el('div', { className: 'fq-header-actions module-header-actions' }, [
        currentAccountId
          ? el('span', { className: 'fq-account-badge' }, [
              el('span', { className: 'fq-account-icon' }, '👤'),
              `当前账号: ${currentAccountId}`
            ])
          : el('span', { className: 'fq-account-badge fq-account-badge-missing' }, '未登录 X 账号'),
        autoScheduleSwitch,
        refreshBtn,
        settingsBtn,
        execBtn,
        el('button', {
          type: 'button', className: 'fq-btn fq-btn-secondary fq-open-logs module-log-button',
          onClick: () => root.dispatchEvent(new CustomEvent('open-execution-logs', {bubbles:true}))
        }, '执行日志')
      ])
    ]);
  }

  function renderNotice() {
    if (!currentAccountId) {
      return el('div', { className: 'fq-alert fq-alert-warning' }, [
        el('strong', {}, '⚠️ 未检测到有效 X 账号：'),
        el('span', {}, '关注队列已暂停。请在 X 标签页登录或刷新账号，然后点击刷新。')
      ]);
    }
    const notices = [];
    if (error) {
      notices.push(el('div', { className: 'fq-alert fq-alert-error' }, [
        el('strong', {}, '❌ 错误：'),
        el('span', {}, error),
        el('button', {
          className: 'fq-btn fq-btn-sm fq-btn-secondary',
          style: { marginLeft: '12px' },
          onClick: () => fetchAll()
        }, '重试')
      ]));
    }
    if (settingsFetchError) {
      notices.push(el('div', { className: 'fq-alert fq-alert-error' }, [
        el('strong', {}, '❌ 配置加载失败：'),
        el('span', {}, `${settingsFetchError}（已禁用保存以防覆盖原有设置）`),
        el('button', {
          className: 'fq-btn fq-btn-sm fq-btn-secondary',
          style: { marginLeft: '12px' },
          onClick: () => fetchAll()
        }, '重试')
      ]));
    }
    if (notices.length === 1) return notices[0];
    if (notices.length > 1) return el('div', { className: 'fq-notices-wrap' }, notices);
    return null;
  }

  function renderSummaryBar() {
    const stats = summary?.stats || computeStats();
    const items = [
      el('span', { className: 'fq-summary-item' }, [`总任务 `, el('strong', {}, stats.total)]),
      el('span', { className: 'fq-summary-item' }, [`待关注 `, el('strong', { className: 'fq-text-pending' }, stats.pending)]),
      el('span', { className: 'fq-summary-item' }, [`执行中 `, el('strong', { className: 'fq-text-running' }, stats.running)]),
      el('span', { className: 'fq-summary-item' }, [`已关注 `, el('strong', { className: 'fq-text-followed' }, stats.followed)]),
      el('span', { className: 'fq-summary-item' }, [`跳过 `, el('strong', { className: 'fq-text-skipped' }, stats.skipped)]),
      el('span', { className: 'fq-summary-item' }, [`重试 `, el('strong', { className: 'fq-text-retry' }, stats.retry)]),
      el('span', { className: 'fq-summary-item' }, [`待核实 `, el('strong', { className: 'fq-text-uncertain' }, stats.uncertain)]),
      el('span', { className: 'fq-summary-item' }, [`已排除 `, el('strong', { className: 'fq-text-excluded' }, stats.excluded)])
    ];

    if (summary?.lastRunAt) {
      items.push(el('span', { className: 'fq-summary-item fq-summary-time' }, `上次执行: ${formatTime(summary.lastRunAt)}`));
    }
    if (summary?.nextRunAt) {
      items.push(el('span', { className: 'fq-summary-item fq-summary-time' }, `下次计划: ${formatTime(summary.nextRunAt)}`));
    }

    return el('div', { className: 'fq-summary-bar' }, items);
  }

  function renderCursorPagination() {
    const visited = [];
    for (let page = 1; page <= startCursors.length; page += 1) {
      if (page > 1 && startCursors[page - 1] == null) break;
      visited.push(page);
    }
    const summaryText = totalKnown
      ? `第 ${currentPage} 页 · 共 ${serverTotal} 条`
      : `第 ${currentPage} 页 · 总数未知${scanStatus ? ` · ${scanStatus}` : ''}`;
    return el('div', { className: 'monitor-pagination fq-pagination' }, [
      el('label', { className: 'fq-pagesize-label' }, [
        el('span', {}, '每页'),
        el('select', {
          className: 'fq-select fq-pagesize-select',
          value: String(pageSize),
          title: '选择每页展示条数',
          onChange: e => {
            pageSize = Math.min(100, parseInt(e.target.value, 10) || 20);
            applyListChange();
          }
        }, [10, 20, 50, 100].map(size => el('option', { value: String(size), selected: pageSize === size }, String(size))))
      ]),
      el('span', { className: 'page-summary fq-page-summary' }, summaryText),
      el('div', { className: 'page-actions fq-page-actions' }, [
        el('button', {
          type: 'button',
          className: 'icon-button secondary fq-page-nav-btn',
          disabled: currentPage <= 1,
          title: '上一页',
          'aria-label': '上一页',
          onClick: () => { if (currentPage > 1) turnPage(currentPage - 1); }
        }, '‹'),
        ...visited.map(page => el('button', {
          type: 'button',
          className: `fq-page-btn ${page === currentPage ? 'active' : ''}`,
          title: `第 ${page} 页`,
          disabled: page === currentPage,
          onClick: () => turnPage(page)
        }, String(page))),
        el('button', {
          type: 'button',
          className: 'icon-button secondary fq-page-nav-btn',
          disabled: !serverHasMore,
          title: '下一页',
          'aria-label': '下一页',
          onClick: () => { if (serverHasMore) turnPage(currentPage + 1); }
        }, '›')
      ])
    ]);
  }

  function renderPaginationControls(totalCount) {
    if (serverPaging) return renderCursorPagination();
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;

    const pageSizeSelect = el('select', {
      className: 'fq-select fq-pagesize-select',
      value: String(pageSize),
      title: '选择每页展示条数',
      onChange: e => {
        pageSize = Math.min(100, parseInt(e.target.value, 10) || 20);
        applyListChange();
      }
    }, [
      el('option', { value: '10', selected: pageSize === 10 }, '10'),
      el('option', { value: '20', selected: pageSize === 20 }, '20'),
      el('option', { value: '50', selected: pageSize === 50 }, '50'),
      el('option', { value: '100', selected: pageSize === 100 }, '100')
    ]);

    const prevBtn = el('button', {
      type: 'button',
      className: 'icon-button secondary fq-page-nav-btn',
      disabled: currentPage <= 1,
      title: '上一页',
      'aria-label': '上一页',
      onClick: () => {
        if (currentPage > 1) turnPage(currentPage - 1);
      }
    }, '‹');

    const nextBtn = el('button', {
      type: 'button',
      className: 'icon-button secondary fq-page-nav-btn',
      disabled: currentPage >= totalPages,
      title: '下一页',
      'aria-label': '下一页',
      onClick: () => {
        if (currentPage < totalPages) turnPage(currentPage + 1);
      }
    }, '›');

    const pageButtons = [];
    const maxPageButtons = 7;
    if (totalPages <= maxPageButtons) {
      for (let p = 1; p <= totalPages; p++) {
        pageButtons.push(el('button', {
          type: 'button',
          className: `fq-page-btn ${p === currentPage ? 'active' : ''}`,
          title: `第 ${p} 页`,
          disabled: p === currentPage,
          onClick: () => turnPage(p)
        }, String(p)));
      }
    } else {
      const left = Math.max(2, currentPage - 1);
      const right = Math.min(totalPages - 1, currentPage + 1);
      pageButtons.push(el('button', {
        type: 'button',
        className: `fq-page-btn ${1 === currentPage ? 'active' : ''}`,
        title: '第 1 页',
        disabled: 1 === currentPage,
        onClick: () => turnPage(1)
      }, '1'));
      if (left > 2) pageButtons.push(el('span', { className: 'fq-page-ellipsis' }, '…'));
      for (let p = left; p <= right; p++) {
        pageButtons.push(el('button', {
          type: 'button',
          className: `fq-page-btn ${p === currentPage ? 'active' : ''}`,
          title: `第 ${p} 页`,
          disabled: p === currentPage,
          onClick: () => turnPage(p)
        }, String(p)));
      }
      if (right < totalPages - 1) pageButtons.push(el('span', { className: 'fq-page-ellipsis' }, '…'));
      pageButtons.push(el('button', {
        type: 'button',
        className: `fq-page-btn ${totalPages === currentPage ? 'active' : ''}`,
        title: `第 ${totalPages} 页`,
        disabled: totalPages === currentPage,
        onClick: () => turnPage(totalPages)
      }, String(totalPages)));
    }

    return el('div', { className: 'monitor-pagination fq-pagination' }, [
      el('label', { className: 'fq-pagesize-label' }, [
        el('span', {}, '每页'),
        pageSizeSelect
      ]),
      el('span', { className: 'page-summary fq-page-summary' }, `第 ${currentPage} / ${totalPages} 页 · 共 ${totalCount} 条`),
      el('div', { className: 'page-actions fq-page-actions' }, [
        prevBtn,
        ...pageButtons,
        nextBtn
      ])
    ]);
  }

  function renderFilterBar(filteredTotal) {
    const states = [
      { id: 'all', label: '全部状态' },
      { id: 'pending', label: '待关注' },
      { id: 'running', label: '执行中' },
      { id: 'followed', label: '已关注' },
      { id: 'skipped', label: '策略跳过' },
      { id: 'retry', label: '等待重试' },
      { id: 'uncertain', label: '待核实' },
      { id: 'excluded', label: '已排除' }
    ];

    const modules = [
      { id: 'all', label: '全部来源' },
      { id: 'fans', label: '粉丝管理' },
      { id: 'mutual', label: '互关追踪' },
      { id: 'comments', label: '评论追踪' }
    ];

    const stateTabs = states.map(s => el('button', {
      type: 'button',
      className: `fq-filter-tab ${stateFilter === s.id ? 'active' : ''}`,
      onClick: () => {
        stateFilter = s.id;
        applyListChange();
      }
    }, s.label));

    const moduleSelect = el('select', {
      className: 'fq-select fq-module-select',
      value: moduleFilter,
      onChange: e => {
        moduleFilter = e.target.value || 'all';
        applyListChange();
      }
    }, modules.map(m => el('option', { value: m.id, selected: moduleFilter === m.id }, m.label)));

    const searchInput = el('input', {
      type: 'search',
      className: 'fq-search-input',
      placeholder: '搜索昵称、账号、简介或 ID...',
      value: searchQuery,
      onInput: e => {
        searchQuery = e.target.value;
        applyListChange();
      }
    });

    const selectionInfo = selectedJobIds.size > 0
      ? el('div', { className: 'fq-selection-info' }, [
          el('span', {}, `已选 ${selectedJobIds.size} 项`),
          el('button', {
            type: 'button',
            className: 'fq-btn fq-btn-sm fq-btn-secondary',
            onClick: () => {
              selectedJobIds.clear();
              render();
            }
          }, '清空选择')
        ])
      : null;

    const subbarLeft = el('div', { className: 'fq-subbar-left' }, [
      el('label', { className: 'fq-filter-label' }, ['来源: ', moduleSelect]),
      searchInput,
      selectionInfo
    ].filter(Boolean));

    const subbarRight = renderPaginationControls(filteredTotal);

    const subbar = el('div', { className: 'fq-subbar' }, [
      subbarLeft,
      subbarRight
    ]);

    return el('div', { className: 'fq-filter-bar' }, [
      el('div', { className: 'fq-filter-tabs' }, stateTabs),
      subbar
    ]);
  }

  function renderTable(filteredJobs) {
    const totalCount = serverPaging ? serverTotal : filteredJobs.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    if (!serverPaging && currentPage > totalPages) currentPage = totalPages;

    const startIndex = (currentPage - 1) * pageSize;
    const visibleJobs = serverPaging ? filteredJobs : filteredJobs.slice(startIndex, startIndex + pageSize);

    const isAllVisibleSelected = visibleJobs.length > 0 && visibleJobs.every(j => selectedJobIds.has(j.id));
    const isSomeVisibleSelected = visibleJobs.length > 0 && visibleJobs.some(j => selectedJobIds.has(j.id));

    const headerCheckbox = el('input', {
      type: 'checkbox',
      checked: isAllVisibleSelected,
      onChange: e => {
        const checked = e.target.checked;
        visibleJobs.forEach(j => {
          if (checked) selectedJobIds.add(j.id);
          else selectedJobIds.delete(j.id);
        });
        render();
      }
    });
    headerCheckbox.indeterminate = !isAllVisibleSelected && isSomeVisibleSelected;

    const thead = el('thead', {}, [
      el('tr', {}, [
        el('th', { className: 'fq-col-check' }, [headerCheckbox]),
        el('th', { className: 'fq-col-target' }, '目标账号'),
        el('th', { className: 'fq-col-sources' }, '来源'),
        el('th', { className: 'fq-col-state' }, '状态 / 阶段'),
        el('th', { className: 'fq-col-result' }, '关注结果'),
        el('th', { className: 'fq-col-eval' }, 'Grok 引用评价'),
        el('th', { className: 'fq-col-actions' }, '操作')
      ])
    ]);

    let tbodyContent;
    if (visibleJobs.length === 0 && loading) {
      tbodyContent = el('tr', {}, [
        el('td', { colSpan: 7, className: 'fq-empty-cell' }, [
          el('div', { className: 'dash-load fq-load', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, [
            el('span', { className: 'dash-spinner', 'aria-hidden': 'true' }),
            el('span', { className: 'dash-load-text' }, '正在加载关注队列…')
          ])
        ])
      ]);
    } else if (visibleJobs.length === 0 && (error || settingsFetchError)) {
      tbodyContent = el('tr', {}, [
        el('td', { colSpan: 7, className: 'fq-empty-cell' }, [
          el('div', { className: 'dash-load dash-load-error', role: 'alert' }, [
            el('span', { className: 'dash-load-text' }, '关注队列读取失败，尚未确认列表为空')
          ])
        ])
      ]);
    } else if (visibleJobs.length === 0) {
      const emptyTitle = scanActive ? '正在检索匹配任务' : '关注队列暂无匹配任务';
      const emptyDesc = scanActive || scanStatus
        ? (scanStatus || '正在继续检索…')
        : '粉丝管理、互关追踪或评论追踪发现候选后，将自动或手动投递至此处执行。';
      tbodyContent = el('tr', {}, [
        el('td', { colSpan: 7, className: 'fq-empty-cell' }, [
          el('div', { className: 'fq-empty-wrap' }, [
            el('p', { className: 'fq-empty-title' }, emptyTitle),
            el('p', { className: 'fq-empty-desc fq-scan-status' }, emptyDesc)
          ])
        ])
      ]);
    } else {
      tbodyContent = visibleJobs.map(job => {
        const isSelected = selectedJobIds.has(job.id);
        const rowCheckbox = el('input', {
          type: 'checkbox',
          checked: isSelected,
          onChange: e => {
            if (e.target.checked) selectedJobIds.add(job.id);
            else selectedJobIds.delete(job.id);
            render();
          }
        });

        // Target cell
        const handleUrl = safeHandleUrl(job.handle);
        const displayHandle = job.handle ? `@${job.handle.trim().replace(/^@+/, '')}` : '未知用户名';
        const profileKnown = job.profileStatus === 'stored' && job.profile && typeof job.profile === 'object';
        const profile = profileKnown ? job.profile : (job.profileStatus === 'unavailable' ? {} : (job.profile || {}));
        const bioText = job.profileStatus === 'unavailable' ? '资料暂不可用' : (profile.bio || '暂无简介');
        const countText = job.profileStatus === 'unavailable'
          ? '粉丝 未读取 · 关注 未读取'
          : '粉丝 '+(profile.followersText?.replace(/\s*(Followers|粉丝).*$/i,'') ?? '未读取')+' · 关注 '+(profile.followingText?.replace(/\s*(Following|正在关注|关注).*$/i,'') ?? '未读取');
        const nameRow = el('div', {className:'fq-profile-name'}, [
          el(handleUrl?'a':'span', handleUrl?{href:handleUrl,target:'_blank',rel:'noopener noreferrer',className:'fq-user-handle'}:{className:'fq-user-handle'}, profile.name || displayHandle)
        ]);
        if(profile.blueVerified === true) nameRow.appendChild(el('span',{className:'fq-blue-verified',title:'已采集的蓝 V 认证','aria-label':'蓝 V 认证'},'✓'));
        else if(profile.verified === true) nameRow.appendChild(el('span',{className:'fq-verified-label',title:'已采集认证状态，未确认蓝 V 类型'},'已认证'));
        const targetCell = el('td', { className: 'fq-col-target' }, [
          el('div', {className:'fq-user-info'}, [
            nameRow,
            profile.name ? el('small',{className:'fq-user-id'},displayHandle) : null,
            el('div',{className:'fq-profile-bio',title:bioText},bioText),
            el('small',{className:'fq-profile-counts'},countText),
            job.targetUserId ? el('small',{className:'fq-user-id'},'ID: '+job.targetUserId) : null
          ].filter(Boolean))
        ]);

        // Sources cell
        const sourcesList = Array.isArray(job.sources) ? job.sources : [];
        const sourceTags = sourcesList.map(src => {
          const modLabel = MODULE_LABELS[src.module] || src.module;
          const badge = el('span', {
            className: `fq-tag fq-module-${src.module || 'fans'}`
          }, modLabel);

          const safeUrl = safeHttpsUrl(src.url);
          if (safeUrl) {
            return el('a', {
              href: safeUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: 'fq-source-link',
              title: safeUrl
            }, [badge]);
          }
          return badge;
        });

        const sourcesCell = el('td', { className: 'fq-col-sources' }, [
          el('div', { className: 'fq-tags-wrap' }, sourceTags.length > 0 ? sourceTags : [el('span', { className: 'fq-text-muted' }, '-')])
        ]);

        // State cell
        const stateClass = `fq-status-${job.state || 'pending'}`;
        const stateText = STATE_LABELS[job.state] || job.state || '待关注';
        const stateBadge = el('span', { className: `fq-tag ${stateClass}` }, stateText);
        const stageText = job.stage ? el('small', { className: 'fq-stage-text' }, job.stage) : null;
        const leaseBadge = job.lease?.owner ? el('small', { className: 'fq-lease-text' }, `租约: ${job.lease.owner}`) : null;

        const stateCell = el('td', { className: 'fq-col-state' }, [
          stateBadge,
          stageText,
          leaseBadge
        ]);

        // Follow result cell
        let resultDisplay = '-';
        if (job.state === 'followed') {
          resultDisplay = '关注成功';
        } else if (job.state === 'skipped') {
          resultDisplay = job.followResult?.reason || '条件不符';
        } else if (job.state === 'retry') {
          resultDisplay = job.followResult?.error || '等待重试';
        } else if (job.state === 'uncertain') {
          resultDisplay = '待核对主页关系';
        } else if (job.followResult?.error) {
          resultDisplay = job.followResult.error;
        }
        const resultCell = el('td', { className: 'fq-col-result' }, [
          el('span', { className: 'fq-result-text' }, resultDisplay)
        ]);

        // Evaluations cell
        const evals = Array.isArray(job.evaluations) ? job.evaluations : [];
        let evalCellContent;
        if (evals.length === 0) {
          evalCellContent = el('span', { className: 'fq-text-muted' }, '无评价');
        } else {
          evalCellContent = el('div', { className: 'fq-eval-summary' }, evals.map(ev => {
            const statusBadge = el('span', {
              className: `fq-tag fq-eval-status-${ev.status || 'drafted'}`
            }, ev.status || '草稿');

            const publishedSafe = safeHttpsUrl(ev.publishedPostUrl);
            const originalSafe = safeHttpsUrl(ev.originalPostUrl);
            let postLink = null;
            if (publishedSafe) {
              postLink = el('a', {
                href: publishedSafe,
                target: '_blank',
                rel: 'noopener noreferrer',
                className: 'fq-link fq-post-link'
              }, '已发布帖子');
            } else if (originalSafe) {
              postLink = el('a', {
                href: originalSafe,
                target: '_blank',
                rel: 'noopener noreferrer',
                className: 'fq-link fq-post-link'
              }, '原帖');
            } else if (ev.publishedPostUrl || ev.originalPostUrl) {
              postLink = el('span', { className: 'fq-text-muted' }, ev.publishedPostUrl ? '已发布帖子' : '原帖');
            }

            return el('div', { className: 'fq-eval-row' }, [statusBadge, postLink]);
          }));
        }
        const evalCell = el('td', { className: 'fq-col-eval' }, [evalCellContent]);

        // Actions cell
        const isJobBusy = busyJobIds.has(job.id);
        const actionButtons = [];
        if (job.state === 'uncertain') {
          actionButtons.push(el('button', {
            className: 'fq-btn fq-btn-sm fq-btn-primary',
            disabled: isJobBusy,
            onClick: () => handleVerifyJob(job, 'check')
          }, isJobBusy ? '核对中…' : '核对关系'));
          actionButtons.push(el('button', {
            className: 'fq-btn fq-btn-sm fq-btn-secondary',
            disabled: isJobBusy,
            onClick: () => handleVerifyJob(job, 'exclude')
          }, '排除'));
        } else if (job.state === 'followed') {
          const pendingEval = evals.find(ev => ev && ev.status !== 'posted' && ev.status !== 'published');
          if (pendingEval) {
            const retryLabel = pendingEval.status === 'uncertain'
              ? '核对评价'
              : ((pendingEval.status === 'draft' || pendingEval.status === 'drafted') && pendingEval.text ? '发布评价' : '重试评价');
            actionButtons.push(el('button', {
              className: 'fq-btn fq-btn-sm fq-btn-primary',
              disabled: isJobBusy,
              onClick: () => handleRetryEvaluation(job, pendingEval, true)
            }, isJobBusy ? '处理中…' : retryLabel));
          }
        }
        const traceBtn = el('button', {
          className: 'fq-btn fq-btn-sm fq-btn-secondary',
          onClick: () => {
            inspectingJob = job;
            render();
          }
        }, '溯源详情');
        actionButtons.push(traceBtn);
        const actionsCell = el('td', { className: 'fq-col-actions' }, [
          el('div', { className: 'fq-actions-group' }, actionButtons)
        ]);

        return el('tr', {
          className: isSelected ? 'fq-row-selected' : '',
          key: job.id
        }, [
          el('td', { className: 'fq-col-check' }, [rowCheckbox]),
          targetCell,
          sourcesCell,
          stateCell,
          resultCell,
          evalCell,
          actionsCell
        ]);
      });
    }

    const tbody = el('tbody', {}, tbodyContent);
    const table = el('table', { className: 'fq-table' }, [thead, tbody]);
    const tableWrap = el('div', { className: 'fq-table-wrap' }, [table]);

    const selectionSummary = selectedJobIds.size > 0
      ? el('div', { className: 'fq-selection-info' }, [
          el('span', {}, `已选 ${selectedJobIds.size} 项`),
          el('button', {
            type: 'button',
            className: 'fq-btn fq-btn-sm fq-btn-secondary',
            onClick: () => {
              selectedJobIds.clear();
              render();
            }
          }, '清空选择')
        ])
      : null;

    const paginationWrap = el('div', { className: 'fq-pagination-wrap' }, [
      selectionSummary,
      renderPaginationControls(totalCount)
    ].filter(Boolean));

    return el('div', { className: 'fq-list-section' }, [
      tableWrap,
      paginationWrap
    ]);
  }

  // --- Traceability Drawer ---

  function renderTraceabilityDrawer() {
    if (!inspectingJob) return null;
    const job = inspectingJob;
    const isJobBusy = busyJobIds.has(job.id);

    const sources = Array.isArray(job.sources) ? job.sources : [];
    const evals = Array.isArray(job.evaluations) ? job.evaluations : [];

    const closeBtn = el('button', {
      className: 'fq-drawer-close',
      'aria-label': '关闭',
      onClick: () => {
        inspectingJob = null;
        render();
      }
    }, '×');

    const header = el('div', { className: 'fq-drawer-header' }, [
      el('strong', { className: 'fq-drawer-title' }, `关注任务溯源 · @${job.handle || job.targetUserId}`),
      closeBtn
    ]);

    const chainSection = el('div', { className: 'fq-trace-section' }, [
      el('div', { className: 'fq-trace-section-title' }, '🔗 完整追溯链路'),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '当前操作账号:'),
        el('span', { className: 'fq-trace-val' }, job.accountId || currentAccountId || '-')
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '目标 Handle:'),
        el('span', { className: 'fq-trace-val' }, (() => {
          const handleUrl = safeHandleUrl(job.handle);
          const displayHandle = job.handle ? `@${job.handle.trim().replace(/^@+/, '')}` : '-';
          return handleUrl
            ? el('a', { href: handleUrl, target: '_blank', rel: 'noopener noreferrer' }, displayHandle)
            : displayHandle;
        })())
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '目标 Rest ID:'),
        el('span', { className: 'fq-trace-val' }, job.targetUserId || '-')
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '任务 ID:'),
        el('span', { className: 'fq-trace-val' }, job.id || '-')
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '当前状态:'),
        el('span', { className: 'fq-trace-val' }, [
          el('span', { className: `fq-tag fq-status-${job.state || 'pending'}` }, STATE_LABELS[job.state] || job.state)
        ])
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '执行阶段:'),
        el('span', { className: 'fq-trace-val' }, job.stage || '-')
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '关注结果 / 跳过原因:'),
        el('span', { className: 'fq-trace-val' },
          typeof job.followResult === 'string'
            ? job.followResult
            : (job.followResult?.reason || job.followResult?.error || (job.state === 'followed' ? '已关注成功' : '-'))
        )
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '创建时间:'),
        el('span', { className: 'fq-trace-val' }, formatTime(job.createdAt))
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '更新时间:'),
        el('span', { className: 'fq-trace-val' }, formatTime(job.updatedAt))
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '下次合格时间:'),
        el('span', { className: 'fq-trace-val' }, formatTime(job.nextEligibleAt))
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '活动租约:'),
        el('span', { className: 'fq-trace-val' }, job.lease?.owner ? `${job.lease.owner} (v${job.lease.version || 0})` : '无')
      ])
    ]);

    const sourcesSection = el('div', { className: 'fq-trace-section' }, [
      el('div', { className: 'fq-trace-section-title' }, `📍 候选来源记录 (${sources.length})`),
      ...(sources.length === 0
        ? [el('p', { className: 'fq-text-muted' }, '无来源详情记录')]
        : sources.map((src, idx) => el('div', { className: 'fq-trace-source-item' }, [
            el('div', { className: 'fq-trace-row' }, [
              el('span', { className: 'fq-trace-label' }, `来源 #${idx + 1}:`),
              el('span', { className: 'fq-trace-val' }, [
                el('span', { className: `fq-tag fq-module-${src.module || 'fans'}` }, MODULE_LABELS[src.module] || src.module)
              ])
            ]),
            el('div', { className: 'fq-trace-row' }, [
              el('span', { className: 'fq-trace-label' }, '来源链接:'),
              el('span', { className: 'fq-trace-val' }, (() => {
                if (!src.url) return '-';
                const safeUrl = safeHttpsUrl(src.url);
                if (safeUrl) {
                  return el('a', { href: safeUrl, target: '_blank', rel: 'noopener noreferrer' }, src.url);
                }
                return el('span', { className: 'fq-text-muted', title: '链接不安全，已禁用跳转' }, src.url);
              })())
            ]),
            el('div', { className: 'fq-trace-row' }, [
              el('span', { className: 'fq-trace-label' }, '发现时间:'),
              el('span', { className: 'fq-trace-val' }, formatTime(src.discoveredAt))
            ]),
            el('div', { className: 'fq-trace-row' }, [
              el('span', { className: 'fq-trace-label' }, '自动入队授权:'),
              el('span', { className: 'fq-trace-val' }, src.enabled ? '✅ 已授权' : '⚠️ 仅采集未授权')
            ])
          ])))
    ]);

    const evalSection = el('div', { className: 'fq-trace-section' }, [
      el('div', { className: 'fq-trace-section-title' }, `✍️ Grok 引用评价记录 (${evals.length})`),
      ...(evals.length === 0
        ? [el('p', { className: 'fq-text-muted' }, '该任务暂无关联引用评价')]
        : evals.map((ev, idx) => {
            const attemptCount = Array.isArray(ev.attempts) ? ev.attempts.length : (ev.attempts || 0);
            const canRetryEval = job.state === 'followed' && ev.status !== 'posted' && ev.status !== 'published';
            const evalActions = canRetryEval
              ? el('div', { className: 'fq-trace-actions' }, [
                  el('button', {
                    className: 'fq-btn fq-btn-sm fq-btn-primary',
                    disabled: isJobBusy,
                    onClick: () => handleRetryEvaluation(job, ev, true)
                  }, isJobBusy
                    ? '处理中…'
                    : (ev.status === 'uncertain' ? '核对并补发评价' : (ev.text ? '发布现有草稿' : '重新生成并发布'))),
                  !ev.text
                    ? el('button', {
                        className: 'fq-btn fq-btn-sm fq-btn-secondary',
                        disabled: isJobBusy,
                        onClick: () => handleRetryEvaluation(job, ev, false)
                      }, '仅生成草稿')
                    : null
                ])
              : null;
            return el('div', { className: 'fq-eval-card' }, [
              el('div', { className: 'fq-trace-row' }, [
                el('span', { className: 'fq-trace-label' }, `子任务 #${idx + 1}:`),
                el('span', { className: 'fq-trace-val' }, ev.taskId || '-')
              ]),
              el('div', { className: 'fq-trace-row' }, [
                el('span', { className: 'fq-trace-label' }, '原帖作者:'),
                el('span', { className: 'fq-trace-val' }, ev.originalAuthorId || '-')
              ]),
              el('div', { className: 'fq-trace-row' }, [
                el('span', { className: 'fq-trace-label' }, '原帖链接:'),
                el('span', { className: 'fq-trace-val' }, (() => {
                  if (!ev.originalPostUrl) return '-';
                  const safe = safeHttpsUrl(ev.originalPostUrl);
                  const label = ev.originalPostId || '查看原帖';
                  if (safe) {
                    return el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, label);
                  }
                  return el('span', { className: 'fq-text-muted', title: '链接不安全，已禁用跳转' }, label);
                })())
              ]),
              el('div', { className: 'fq-trace-row' }, [
                el('span', { className: 'fq-trace-label' }, '评价状态:'),
                el('span', { className: 'fq-trace-val' }, ev.status || '-')
              ]),
              el('div', { className: 'fq-trace-row' }, [
                el('span', { className: 'fq-trace-label' }, '已发布链接:'),
                el('span', { className: 'fq-trace-val' }, (() => {
                  if (!ev.publishedPostUrl) return '尚未发布';
                  const safe = safeHttpsUrl(ev.publishedPostUrl);
                  const label = ev.publishedPostId || '已发布引用帖';
                  if (safe) {
                    return el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, label);
                  }
                  return el('span', { className: 'fq-text-muted', title: '链接不安全，已禁用跳转' }, label);
                })())
              ]),
              el('div', { className: 'fq-trace-row' }, [
                el('span', { className: 'fq-trace-label' }, '尝试次数:'),
                el('span', { className: 'fq-trace-val' }, String(attemptCount))
              ]),
              ev.text ? el('blockquote', { className: 'fq-eval-quote' }, ev.text) : null,
              evalActions
            ]);
          }))
    ]);

    let resultOutcome = '未执行';
    if (job.state === 'followed') {
      resultOutcome = '关注成功';
    } else if (job.state === 'skipped') {
      resultOutcome = job.followResult?.reason || '条件不符跳过';
    } else if (job.state === 'retry') {
      resultOutcome = job.followResult?.error || '异常等待重试';
    } else if (job.state === 'uncertain') {
      resultOutcome = '发送后结果待核实';
    } else if (job.followResult?.error) {
      resultOutcome = job.followResult.error;
    }

    const uncertainActions = job.state === 'uncertain'
      ? el('div', { className: 'fq-trace-actions' }, [
          el('button', {
            className: 'fq-btn fq-btn-sm fq-btn-primary',
            disabled: isJobBusy,
            onClick: () => handleVerifyJob(job, 'check')
          }, isJobBusy ? '正在核对…' : '核对主页关系'),
          el('button', {
            className: 'fq-btn fq-btn-sm fq-btn-secondary',
            disabled: isJobBusy,
            onClick: () => handleVerifyJob(job, 'exclude')
          }, '标记排除')
        ])
      : null;

    const followResultSection = el('div', { className: 'fq-trace-section' }, [
      el('div', { className: 'fq-trace-section-title' }, '🎯 关注执行结果'),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '关注状态:'),
        el('span', { className: 'fq-trace-val' }, [
          el('span', { className: `fq-tag fq-status-${job.state || 'pending'}` }, STATE_LABELS[job.state] || job.state)
        ])
      ]),
      el('div', { className: 'fq-trace-row' }, [
        el('span', { className: 'fq-trace-label' }, '结果摘要:'),
        el('span', { className: 'fq-trace-val' }, resultOutcome)
      ]),
      job.followResult?.reason
        ? el('div', { className: 'fq-trace-row' }, [
            el('span', { className: 'fq-trace-label' }, '跳过原因:'),
            el('span', { className: 'fq-trace-val' }, job.followResult.reason)
          ])
        : null,
      job.followResult?.error
        ? el('div', { className: 'fq-trace-row' }, [
            el('span', { className: 'fq-trace-label' }, '失败详情:'),
            el('span', { className: 'fq-trace-val' }, job.followResult.error)
          ])
        : null,
      uncertainActions
    ]);

    const body = el('div', { className: 'fq-drawer-body' }, [
      chainSection,
      sourcesSection,
      followResultSection,
      evalSection
    ]);

    const drawer = el('aside', {
      className: 'fq-drawer',
      role: 'dialog',
      'aria-modal': 'true'
    }, [header, body]);

    return el('div', {
      className: 'fq-drawer-backdrop',
      onClick: e => {
        if (e.target === e.currentTarget) {
          inspectingJob = null;
          render();
        }
      }
    }, [drawer]);
  }

  // --- Settings Drawer ---

  function renderSettingsDrawer() {
    if (!isSettingsOpen) return null;

    // Local form state
    const current = { ...settings };

    const closeBtn = el('button', {
      className: 'fq-drawer-close',
      'aria-label': '关闭',
      onClick: () => {
        isSettingsOpen = false;
        render();
      }
    }, '×');

    const header = el('div', { className: 'fq-drawer-header' }, [
      el('strong', { className: 'fq-drawer-title' }, '关注队列 · 统一调度与执行设置'),
      closeBtn
    ]);

    // Input builders
    function createNumberGroup(id, label, desc, key, min, max, step = 1) {
      const input = el('input', {
        id,
        name: key,
        type: 'number',
        className: 'fq-setting-input',
        value: String(current[key] ?? SETTINGS_BOUNDS[key].default),
        min: String(min),
        max: String(max),
        step: String(step),
        onInput: e => {
          current[key] = parseFloat(e.target.value);
        }
      });

      return el('div', { className: 'fq-setting-group' }, [
        el('label', { htmlFor: id, className: 'fq-setting-label' }, [
          el('span', {}, label)
        ]),
        input,
        el('small', { className: 'fq-setting-desc' }, desc)
      ]);
    }

    function createSwitchGroup(id, label, desc, key) {
      const input = el('input', {
        id,
        name: key,
        type: 'checkbox',
        checked: Boolean(current[key]),
        onChange: e => {
          current[key] = e.target.checked;
        }
      });

      return el('div', { className: 'fq-setting-group fq-setting-switch' }, [
        el('label', { className: 'fq-switch-label' }, [
          input,
          el('span', {}, label)
        ]),
        el('small', { className: 'fq-setting-desc' }, desc)
      ]);
    }

    const tags = el('div', {className:'fq-quote-tags'});
    const tagPreview = el('p', {className:'fq-setting-desc'});
    const tagError = el('p', {role:'status',className:'fq-tag-error'});
    const tagInput = el('input', {type:'text',placeholder:'例如 #互关 或 #SíguemeYTeSigo', 'aria-label':'自定义引用标签'});
    const renderTags = () => {
      tags.replaceChildren();
      for(const tag of [...RECOMMENDED_QUOTE_TAGS,...current.quoteCustomTags]) {
        const check=el('input',{type:'checkbox',checked:current.quoteSelectedTags.includes(tag),onChange:e=>{
          tagError.textContent='';
          if(e.target.checked && current.quoteSelectedTags.length>=10){e.target.checked=false;tagError.textContent='最多选择 10 个标签，请先取消其他标签。';return;}
          current.quoteSelectedTags=e.target.checked?[...current.quoteSelectedTags,tag]:current.quoteSelectedTags.filter(t=>t!==tag);
          renderTags();
        }});
        const chip=el('span',{className:'fq-tag-option'},[el('label',{},[check,el('span',{},'#'+tag)])]);
        if(current.quoteCustomTags.includes(tag))chip.appendChild(el('button',{type:'button','aria-label':'删除标签 '+tag,onClick:()=>{
          current.quoteCustomTags=current.quoteCustomTags.filter(t=>t!==tag);current.quoteSelectedTags=current.quoteSelectedTags.filter(t=>t!==tag);renderTags();
        }},'×'));
        tags.appendChild(chip);
      }
      tagPreview.textContent='结尾预览：'+(quoteTagSuffix(current)||'不追加标签')+'（已选 '+current.quoteSelectedTags.length+'/10）';
    };
    const enableTags=el('input',{type:'checkbox',checked:current.quoteTagsEnabled,onChange:e=>{current.quoteTagsEnabled=e.target.checked;renderTags();}});
    const tagSection=el('div',{className:'fq-setting-section'},[
      el('h4',{className:'fq-setting-section-title'},'引用评价标签'),
      el('label',{className:'fq-switch-label'},[enableTags,el('span',{},'在引用评价结尾追加标签')]),
      el('small',{className:'fq-setting-desc'},'开启后默认选中 10 个中英文推荐标签，可取消或换成自定义标签。发布时按评价语言筛选：中文使用中文标签，其他已识别语言使用非中文标签；自定义拉丁字母标签不区分英语、西语和葡语，请自行勾选目标语言标签。标签用空格分隔；正文超长时会缩短正文以保留标签。'),
      tags,el('div',{className:'fq-tag-add'},[tagInput,el('button',{type:'button',onClick:()=>{
        const tag=cleanQuoteTag(tagInput.value);tagError.textContent='';
        if(!tag){tagError.textContent='请输入单个标签，支持中文、英文和带重音字母；不要包含空格或标点。';return;}
        if([...RECOMMENDED_QUOTE_TAGS,...current.quoteCustomTags].some(t=>t.toLowerCase()===tag.toLowerCase())){tagError.textContent='这个标签已存在。';return;}
        if(current.quoteCustomTags.length>=50){tagError.textContent='最多保存 50 个自定义标签。';return;}
        current.quoteCustomTags=[...current.quoteCustomTags,tag];tagInput.value='';renderTags();
      }},'添加标签')]),tagError,tagPreview
    ]);
    renderTags();
    const body = el('div', { className: 'fq-drawer-body' }, [
      settingsFetchError
        ? el('div', { className: 'fq-alert fq-alert-error' }, [
            el('strong', {}, '❌ 获取配置失败：'),
            el('span', {}, settingsFetchError),
            el('p', { className: 'fq-setting-desc', style: { margin: '4px 0 0 0' } }, '由于未能成功获取账号原有配置，为防默认配置意外覆盖原有设置，已禁用保存。请刷新后重试。')
          ])
        : null,
      settingsError
        ? el('div', { className: 'fq-alert fq-alert-error' }, [
            el('strong', {}, '❌ 保存失败：'),
            el('span', {}, settingsError)
          ])
        : null,
      el('div', { className: 'fq-setting-section' }, [
        el('h4', { className: 'fq-setting-section-title' }, '⏱ 调度周期与执行预算'),
        createNumberGroup('fq_every', '基础调度间隔（分钟）', '每隔多少分钟调度器唤醒一次检查队列，默认 8 分钟 (1-240)。', 'every', SETTINGS_BOUNDS.every.min, SETTINGS_BOUNDS.every.max),
        createNumberGroup('fq_jitter', '随机浮动间隔（±分钟）', '在基础周期上增减的随机分钟数，默认 ±2 分钟 (1-120)。', 'jitter', SETTINGS_BOUNDS.jitter.min, SETTINGS_BOUNDS.jitter.max),
        createNumberGroup('fq_batchLimit', '单轮新增关注上限（人）', '每轮最多成功新增关注的人数，达到后停止并等待下轮，默认 5 人 (1-50)。', 'batchLimit', SETTINGS_BOUNDS.batchLimit.min, SETTINGS_BOUNDS.batchLimit.max),
        createNumberGroup('fq_inspectLimit', '单轮新检查上限（人）', '单轮最多检查候选人数，防止无限扫页看帖，默认 20 人 (1-200)。', 'inspectLimit', SETTINGS_BOUNDS.inspectLimit.min, SETTINGS_BOUNDS.inspectLimit.max),
        createNumberGroup('fq_timeBudget', '单轮时间预算（分钟）', '单轮任务最长耗时，超时则保存断点下一轮继续，默认 10 分钟 (1-120)。', 'timeBudgetMinutes', SETTINGS_BOUNDS.timeBudgetMinutes.min, SETTINGS_BOUNDS.timeBudgetMinutes.max)
      ]),
      el('div', { className: 'fq-setting-section' }, [
        el('h4', { className: 'fq-setting-section-title' }, '👀 主页访问与模拟看帖'),
        createNumberGroup('fq_scrollRounds', '主页下拉看帖次数', '打开对方主页后向下模拟滚动的分段次数，默认 5 次 (1-8)。', 'scrollRounds', SETTINGS_BOUNDS.scrollRounds.min, SETTINGS_BOUNDS.scrollRounds.max),
        createNumberGroup('fq_dwellSec', '看帖停留基准（秒）', '打开主页后的浏览停留基准秒数，默认 15 秒 (2-60)。', 'dwellSeconds', SETTINGS_BOUNDS.dwellSeconds.min, SETTINGS_BOUNDS.dwellSeconds.max),
        createNumberGroup('fq_dwellJitter', '停留随机浮动（±秒）', '在停留基准上的随机增减秒数，默认 ±5 秒 (1-30)。', 'dwellJitter', SETTINGS_BOUNDS.dwellJitter.min, SETTINGS_BOUNDS.dwellJitter.max)
      ]),
      el('div', { className: 'fq-setting-section' }, [
        el('h4', { className: 'fq-setting-section-title' }, '🛡️ 筛选过滤与意向门槛'),
        createNumberGroup('fq_minFollowers', '最低粉丝数门槛', '过滤粉丝过少的小号，优先活跃账号，默认 50 (0-100000000)。', 'minFollowers', SETTINGS_BOUNDS.minFollowers.min, SETTINGS_BOUNDS.minFollowers.max),
        createNumberGroup('fq_ratioThreshold', '回关比例门槛（关注/粉丝）', '关注数达到粉丝数该比例以上（默认 0.8 即 80%），防止骗关 (0-1)。', 'ratioThreshold', SETTINGS_BOUNDS.ratioThreshold.min, SETTINGS_BOUNDS.ratioThreshold.max, 0.05),
        createSwitchGroup('fq_onlyRecommended', '仅关注推荐/互粉意向账号', '对方需带有互粉标签或符合推荐条件，否则自动策略跳过。', 'onlyRecommended'),
        createSwitchGroup('fq_skipRiskContent', '安全门禁：跳过涉政/涉军/涉宗教/暴力/色情敏感内容', '默认开启。原帖或账号若涉及高危内容，自动跳过关注与引用评论，杜绝违规封号风险。', 'skipRiskContent')
      ]),
      el('div', { className: 'fq-setting-section' }, [
        el('h4', { className: 'fq-setting-section-title' }, '🤖 Grok 引用评价与发布'),
        createSwitchGroup('fq_grokEnabled', '启用 Grok 生成引用评价', '关注成功后自动提取原帖调用 Grok 生成引用评价草稿。', 'grokEnabled'),
        createSwitchGroup('fq_autoPublish', '允许自动发布引用评价（显式确认）', '如开启，评价草稿就绪后将直接发布公开引用推文。未开启则仅存草稿。', 'autoPublish'),
        el('small', {className:'fq-setting-desc'}, '自动评价仅使用 X 内置 Grok；失败时跳过本次评价，不会打开 grok.com。')
      ]), tagSection
    ]);

    const footer = el('div', { className: 'fq-drawer-footer' }, [
      el('button', {
        className: 'fq-btn fq-btn-secondary',
        onClick: () => {
          isSettingsOpen = false;
          settingsError = null;
          render();
        }
      }, '取消'),
      el('button', {
        className: 'fq-btn fq-btn-primary',
        disabled: !currentAccountId || Boolean(settingsFetchError) || isSettingsSaving,
        onClick: () => handleSaveSettings(current)
      }, isSettingsSaving ? '保存中...' : '保存配置')
    ]);

    const drawer = el('aside', {
      className: 'fq-drawer',
      role: 'dialog',
      'aria-modal': 'true'
    }, [header, body, footer]);

    return el('div', {
      className: 'fq-drawer-backdrop',
      onClick: e => {
        if (e.target === e.currentTarget) {
          isSettingsOpen = false;
          render();
        }
      }
    }, [drawer]);
  }

  function renderQueueLoading() {
    if (!loading) return null;
    return el('div', { className: 'dash-load fq-load', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, [
      el('span', { className: 'dash-spinner', 'aria-hidden': 'true' }),
      el('span', { className: 'dash-load-text' }, jobs.length ? '正在刷新关注队列…' : '正在加载关注队列…')
    ]);
  }

  // --- Main Render Function ---

  function render() {
    if (isDestroyed) return;

    const filteredJobs = getFilteredJobs();

    const children = [
      renderHeader(),
      renderQueueLoading(),
      renderNotice(),
      renderSummaryBar(),
      renderFilterBar(filteredJobs.length),
      renderTable(filteredJobs),
      renderTraceabilityDrawer(),
      renderSettingsDrawer()
    ].filter(Boolean);

    root.replaceChildren(...children);
  }

  // Keydown listener for ESC to close drawers
  const onKeydown = e => {
    if (e.key === 'Escape') {
      if (inspectingJob) {
        inspectingJob = null;
        render();
      } else if (isSettingsOpen) {
        isSettingsOpen = false;
        render();
      }
    }
  };
  document.addEventListener('keydown', onKeydown);
  cleanups.push(() => document.removeEventListener('keydown', onKeydown));

  // Initial load
  fetchAll();

  return {
    refresh: async (opts = {}) => {
      if (isDestroyed) return;
      if (opts && typeof opts.accountId === 'string') {
        const nextAccount = opts.accountId.trim();
        if (nextAccount !== currentAccountId) {
          currentAccountId = nextAccount;
          activeReqId++;
          clearAccountState();
          render();
        }
      }
      await fetchAll();
    },
    destroy: () => {
      isDestroyed = true;
      activeReqId++;
      clearAccountState();
      for (const fn of cleanups) {
        try { fn(); } catch {}
      }
      root.replaceChildren();
      root.classList.remove('fq-panel-root');
    }
  };
}
