import {grokProviderController} from './composables/useGrokProvider.js';
import {readSystemSettings, systemSettingsKey} from '../../shared/system-settings.js';
import {cloudflareImagesController} from './composables/useCloudflareImages.js';
import {watch} from 'vue';
import {Clock3, RefreshCw, Sparkles, Settings, Zap, Square, ScrollText, UserRound, UserRoundCheck, Ban, ListTree, Trash2, RotateCcw, Send, ShieldCheck} from 'lucide';
import {panelIcon, panelIconButton} from './panel-icon-button.js';
import {quotePublishIssue} from '../../features/grok/quote-quality.js';
import {originalQualityIssue,originalTextIssue} from '../../features/publishing/original-quality.js';
import {RECOMMENDED_QUOTE_TAGS, cleanQuoteTag, normalizeQuoteTags, quoteTagSuffix, validateQuoteTags} from '../../features/grok/quote-tags.js';
/**
 * follow-queue-panel.js
 * Unified follow queue panel component (ANTIGRAVITY OWNERSHIP).
 *
 * Implements mountFollowQueuePanel(root, { request, accountId })
 * Secure DOM manipulation (zero untrusted innerHTML).
 */

import { FOLLOW_QUEUE_DEFAULT_SETTINGS, PUBLICATION_MODES as STORE_PUBLICATION_MODES, QUOTE_LENGTH_MODES as STORE_QUOTE_LENGTH_MODES } from '../../features/follow-queue/follow-queue-store.js';
import {followQueuePriority} from '../../features/follow-queue/follow-queue-priority.js';
import {displayFollowLimitError, isAccountFollowLimit} from '../../shared/follow-limit.js';

export const PUBLICATION_MODES = STORE_PUBLICATION_MODES || Object.freeze(['quote', 'original']);

export const PUBLICATION_MODE_LABELS = Object.freeze({
  reply: '评论',
  quote: '引用评论',
  article: '文章',
  original: '旧版新帖'
});

export const QUOTE_LENGTH_MODES = STORE_QUOTE_LENGTH_MODES || Object.freeze(['adaptive', 'concise', 'deep']);

export const QUOTE_LENGTH_LABELS = Object.freeze({
  adaptive: '自适应',
  concise: '精简',
  deep: '深入'
});

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
  followBackAllowAll: false,
  grokEnabled: false,
  autoPublish: false,
  publicationMode: 'quote',
  quoteParticipationRate: 60,
  quoteLengthMode: 'adaptive'
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
  followBackAllowAll: Object.freeze({ default: false, type: 'bool' }),
  grokEnabled: Object.freeze({ default: false, type: 'bool' }),
  autoPublish: Object.freeze({ default: false, type: 'bool' }),
  followBackSuffixEnabled: Object.freeze({ default: false, type: 'bool' }),
  publicationMode: Object.freeze({ default: 'quote', type: 'enum', values: PUBLICATION_MODES }),
  quoteParticipationRate: Object.freeze({ min: 0, max: 100, default: 60, type: 'int' }),
  quoteLengthMode: Object.freeze({ default: 'adaptive', type: 'enum', values: QUOTE_LENGTH_MODES }),
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
  fans: '粉丝跟进',
  mutual: '互关追踪',
  comments: '评论追踪'
});

export function summarizeQueueSources(sources) {
  const groups = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source !== 'object') continue;
    const module = source.module || 'fans';
    if (!groups.has(module)) groups.set(module, {module, count: 0, urls: new Set()});
    const group = groups.get(module);
    group.count += 1;
    const safeUrl = safeHttpsUrl(source.url);
    if (safeUrl) group.urls.add(safeUrl);
  }
  return [...groups.values()].map(group => ({
    module: group.module,
    count: group.count,
    url: group.urls.size === 1 ? [...group.urls][0] : null
  }));
}

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

function parseQuoteParticipationRateInput(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^(?:0|[1-9]\d?|100)$/.test(trimmed)) return null;
    return Number(trimmed);
  }
  return null;
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
      if (key === 'quoteParticipationRate') {
        const parsedRate = parseQuoteParticipationRateInput(val);
        if (parsedRate !== null) {
          result[key] = parsedRate;
        }
        continue;
      }
      const num = parseInt(val, 10);
      if (Number.isFinite(num)) {
        result[key] = Math.max(bound.min, Math.min(bound.max, num));
      }
    } else if (bound.type === 'enum') {
      if (Array.isArray(bound.values) && bound.values.includes(val)) {
        result[key] = val;
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
      if (key === 'type') node.type = String(val);
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
export function mountFollowQueuePanel(root, { request, accountId, accountHandle } = {}) {
  if (!root) throw new Error('mountFollowQueuePanel requires a root element');

  let currentAccountId = accountId || '';
  let jobs = [];
  let settings = { ...DEFAULT_SETTINGS };
  let summary = null;
  let loading = false;
  let error = null;
  let settingsFetchError = null;
  let settingsLoaded = false;
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
  let priorityOrder = 'desc';
  let serverPaging = false;
  let serverTotal = null;
  let totalKnown = false;
  let serverHasMore = false;
  let startCursors = [null];
  let scanStatus = '';
  let scanActive = false;
  const selectedJobIds = new Set();
  let batchAction = null;
  let inspectingJob = null;
  let isSettingsOpen = false;
  let settingsDraft = null;
  let settingsFieldErrors = {};
  let isExecuting = false;
  const busyJobIds = new Set();
  const evaluationFeedback = new Map();
  const activeEvaluations = new Set();

  const cleanups = [];

  function createSettingsDraft(base = settings) {
    const normalized = normalizeSettings(base);
    return {
      ...normalized,
      quoteCustomTags: Array.isArray(normalized.quoteCustomTags) ? [...normalized.quoteCustomTags] : [],
      quoteSelectedTags: Array.isArray(normalized.quoteSelectedTags) ? [...normalized.quoteSelectedTags] : [],
      publicationModeRaw: String(normalized.publicationMode || DEFAULT_SETTINGS.publicationMode),
      quoteParticipationRateRaw: String(normalized.quoteParticipationRate ?? DEFAULT_SETTINGS.quoteParticipationRate),
      quoteLengthModeRaw: String(normalized.quoteLengthMode || DEFAULT_SETTINGS.quoteLengthMode)
    };
  }

  function closeSettingsDrawer() {
    isSettingsOpen = false;
    settingsDraft = null;
    settingsFieldErrors = {};
    settingsError = null;
  }

  function clearAccountState() {
    if (batchAction) batchAction.cancelled = true;
    batchAction = null;
    jobs = [];
    selectedJobIds.clear();
    busyJobIds.clear();
    evaluationFeedback.clear();
    activeEvaluations.clear();
    settings = { ...DEFAULT_SETTINGS };
    settingsLoaded = false;
    inspectingJob = null;
    closeSettingsDrawer();
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

  async function fetchAll(cursorRetries = 0, options = {}) {
    if (isDestroyed) return;
    const preserveSettings = options?.preserveSettings === true;
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
    if (!preserveSettings) settingsFetchError = null;
    scanStatus = '';
    scanActive = false;
    render();

    const stillCurrent = () => !isDestroyed && currentAccountId === reqAccount && reqId === activeReqId;

    try {
      const settingsPromise = preserveSettings
        ? Promise.resolve({ ok: true, settings })
        : (typeof request === 'function'
          ? request({ cmd: 'followQueueSettings', accountId: reqAccount }).catch(err => ({
            ok: false,
            error: err?.message || '获取关注队列配置失败'
          }))
          : Promise.resolve({ ok: false, error: '缺少 request 处理函数' }));
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
        if (/invalid follow queue cursor/i.test(listError) && cursorRetries < 2) {
          currentPage = 1;
          startCursors = [null];
          loading = false;
          return fetchAll(cursorRetries + 1, options);
        }
        error = /invalid follow queue cursor/i.test(listError) ? '队列正在更新，请稍后重试。' : listError;
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

      if (!preserveSettings) {
        if (!settingsRes || !settingsRes.ok) {
          settingsLoaded = false;
          settingsFetchError = settingsRes?.error || '获取关注队列配置失败';
        } else if (settingsRes.settings) {
          settings = normalizeSettings(settingsRes.settings);
          settingsLoaded = true;
          if (!isSettingsOpen) settingsDraft = null;
          settingsFetchError = null;
        }
      }

    } catch (err) {
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      loading = false;
      scanActive = false;
      const message = err?.message || '网络连接或执行异常';
      if (/invalid follow queue cursor/i.test(message) && cursorRetries < 2) {
        currentPage = 1;
        startCursors = [null];
        loading = false;
        return fetchAll(cursorRetries + 1, options);
      }
      error = /invalid follow queue cursor/i.test(message) ? '队列正在更新，请稍后重试。' : message;
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
        order: priorityOrder,
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

  async function handleDeleteJob(job) {
    if (!currentAccountId || !job?.id || job.state === 'running' || busyJobIds.has(job.id) || isDestroyed) return;
    if (!globalThis.confirm(`删除 @${job.handle || job.targetUserId} 的关注队列记录？旧来源将不会重新加入该账号；此操作不会在 X 上取关或删除账号。`)) return;
    const reqAccount = currentAccountId;
    busyJobIds.add(job.id);
    error = null;
    render();
    try {
      const res = await request({cmd:'followQueueDelete', accountId:reqAccount, jobId:job.id, confirmed:true});
      if (isDestroyed || currentAccountId !== reqAccount) return;
      if (!res?.ok) { error = res?.error || res?.reason || '删除队列记录失败'; return; }
      selectedJobIds.delete(job.id);
      if (inspectingJob?.id === job.id) inspectingJob = null;
      currentPage = 1;
      startCursors = [null];
      await fetchAll();
    } catch (err) {
      if (!isDestroyed && currentAccountId === reqAccount) error = err?.message || '删除队列记录失败';
    } finally {
      busyJobIds.delete(job.id);
      if (!isDestroyed && currentAccountId === reqAccount) render();
    }
  }

  async function handleBatchUncertain(mode) {
    if (batchAction?.running || loading || !currentAccountId || stateFilter !== 'uncertain') return;
    const targets = jobs.filter(job => selectedJobIds.has(job.id) && job.state === 'uncertain');
    if (!targets.length) return;
    const label = mode === 'delete' ? '删除' : mode === 'exclude' ? '排除' : '核对关系';
    const impact = mode === 'delete' ? '删除队列记录并阻止旧来源重新加入，不会在 X 上取关。'
      : mode === 'exclude' ? '将任务标为已排除，停止后续执行，不会在 X 上取关。'
      : '逐项读取最新关注关系并更新任务状态；确认未关注的任务会恢复为待关注，开启定时调度时可能在后续执行。';
    if (!globalThis.confirm(`对当前页选中的 ${targets.length} 项任务批量${label}？${impact}`)) return;
    const account = currentAccountId;
    const action = batchAction = {running:true, cancelled:false, label, total:targets.length, processed:0, success:0, failures:[]};
    render();
    for (const job of targets) {
      if (isDestroyed || currentAccountId !== account || action.cancelled || batchAction !== action) break;
      try {
        const result = await request(mode === 'delete'
          ? {cmd:'followQueueDelete', accountId:account, jobId:job.id, confirmed:true}
          : {cmd:'followQueueVerify', accountId:account, jobId:job.id, mode:mode === 'exclude' ? 'exclude' : 'check'});
        if (!result?.ok) throw new Error(result?.error || result?.reason || `${label}失败`);
        if (isDestroyed || currentAccountId !== account || batchAction !== action) return;
        action.success++;
        selectedJobIds.delete(job.id);
      } catch (err) {
        action.failures.push({handle:job.handle || job.targetUserId || job.id, reason:err?.message || `${label}失败`});
      }
      action.processed++;
      render();
    }
    if (isDestroyed || currentAccountId !== account || batchAction !== action) return;
    action.running = false;
    currentPage = 1;
    startCursors = [null];
    await fetchAll();
  }

  function renderBatchFeedback() {
    if (!batchAction) return null;
    const b = batchAction;
    const message = `${b.label}${b.running ? '中' : b.cancelled ? '已停止' : '完成'}：已处理 ${b.processed}/${b.total}，成功 ${b.success}，失败 ${b.failures.length}${b.cancelled && b.running ? '；当前项完成后停止' : ''}`;
    return el('div', {className:'fq-batch-feedback'}, [
      el('span', {role:'status', 'aria-live':'polite'}, message),
      b.running ? el('button', {type:'button', className:'secondary', 'data-batch-stop':'true', disabled:b.cancelled,
        onClick:()=>{b.cancelled=true;render();}}, b.cancelled ? '正在停止' : '停止后续') : null,
      b.failures.length ? el('details', {}, [el('summary', {}, `失败详情 ${b.failures.length}`),
        el('ul', {}, b.failures.map(f=>el('li', {}, `@${f.handle}：${f.reason}`)))]) : null
    ]);
  }

  function renderSelectionActions() {
    if (!selectedJobIds.size) return null;
    return el('div', {className:'fq-selection-info'}, [
      el('span', {}, `已选 ${selectedJobIds.size} 项`),
      ...(stateFilter === 'uncertain' ? [
        el('button', {type:'button', className:'fq-btn fq-btn-sm fq-btn-primary', disabled:loading, onClick:()=>handleBatchUncertain('check')}, '批量核对'),
        el('button', {type:'button', className:'fq-btn fq-btn-sm fq-btn-secondary', disabled:loading, onClick:()=>handleBatchUncertain('exclude')}, '批量排除'),
        el('button', {type:'button', className:'fq-btn fq-btn-sm fq-btn-secondary', disabled:loading, onClick:()=>handleBatchUncertain('delete')}, '批量删除')
      ] : []),
      el('button', {type:'button', className:'fq-btn fq-btn-sm fq-btn-secondary', onClick:()=>{selectedJobIds.clear();render();}}, '清空选择')
    ]);
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
    evaluationFeedback.set(job.id,'正在开始处理评价…');
    activeEvaluations.add(job.id);
    error = null;
    render();
    try {
      const res = await request({
        cmd: 'followQueueRetryEvaluation',
        accountId: reqAccount,
        jobId: job.id,
        taskId: ev?.taskId || '',
        verifyOnly: ev?.status === 'uncertain',
        publish
      });
      activeEvaluations.delete(job.id);
      if (isDestroyed || currentAccountId !== reqAccount) return;
      if (!res || !res.ok) {
        error = res?.error || res?.reason || '重试引用评价失败';
        evaluationFeedback.set(job.id,error);
        render();
        return;
      }
      evaluationFeedback.set(job.id,res.summary||res.evaluation?.reason||'评价处理完成');
      await fetchAll();
    } catch (err) {
      if (isDestroyed || currentAccountId !== reqAccount) return;
      error = err?.message || '重试引用评价异常';
      activeEvaluations.delete(job.id);
      evaluationFeedback.set(job.id,error);
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
    if (!currentAccountId || isDestroyed || typeof request !== 'function' || isSettingsSaving || settingsFetchError || !settingsLoaded) return;
    const rawRate = formValues && Object.prototype.hasOwnProperty.call(formValues, 'quoteParticipationRateRaw')
      ? formValues.quoteParticipationRateRaw
      : formValues?.quoteParticipationRate;
    const rawLengthMode = formValues && Object.prototype.hasOwnProperty.call(formValues, 'quoteLengthModeRaw')
      ? formValues.quoteLengthModeRaw
      : formValues?.quoteLengthMode;
    const parsedRate = parseQuoteParticipationRateInput(rawRate);
    const rawPublicationMode = formValues && Object.prototype.hasOwnProperty.call(formValues, 'publicationModeRaw')
      ? formValues.publicationModeRaw
      : (formValues && Object.prototype.hasOwnProperty.call(formValues, 'publicationMode')
        ? formValues.publicationMode
        : DEFAULT_SETTINGS.publicationMode);
    const nextFieldErrors = {};
    if (!PUBLICATION_MODES.includes(rawPublicationMode)) {
      nextFieldErrors.publicationMode = '发帖形式请选择评论、引用评论或文章';
    }
    if (parsedRate === null) {
      nextFieldErrors.quoteParticipationRate = '请输入 0—100 的整数';
    }
    if (!QUOTE_LENGTH_MODES.includes(rawLengthMode)) {
      nextFieldErrors.quoteLengthMode = '篇幅仅支持自适应、精简或深入';
    }
    settingsFieldErrors = nextFieldErrors;
    if (Object.keys(nextFieldErrors).length > 0) {
      if (nextFieldErrors.publicationMode) {
        settingsError = '发帖形式请选择评论、引用评论或文章';
      } else if (nextFieldErrors.quoteParticipationRate) {
        settingsError = '引用概率请输入 0—100 的整数';
      } else {
        settingsError = '篇幅仅支持自适应（adaptive）、精简（concise）或深入（deep）';
      }
      render();
      return;
    }

    const reqAccount = currentAccountId;
    const reqId = ++activeReqId;
    const cleanForm = { ...formValues, publicationMode: rawPublicationMode, quoteParticipationRate: parsedRate, quoteLengthMode: rawLengthMode };
    delete cleanForm.publicationModeRaw;
    delete cleanForm.quoteParticipationRateRaw;
    delete cleanForm.quoteLengthModeRaw;
    const validated = normalizeSettings(cleanForm);
    validated.publicationMode = rawPublicationMode;
    validated.quoteParticipationRate = parsedRate;
    validated.quoteLengthMode = rawLengthMode;
    try { validateQuoteTags(validated); } catch(error) { settingsError=error.message; render(); return; }
    isSettingsSaving = true;
    settingsError = null;
    render();
    try {
      const res = await request({ cmd: 'followQueueSaveSettings', accountId: reqAccount, settings: validated });
      if (isDestroyed || currentAccountId !== reqAccount || reqId !== activeReqId) return;
      if (res && res.ok) {
        const persisted = normalizeSettings(res.settings || validated);
        settings = persisted;
        closeSettingsDrawer();
        isSettingsSaving = false;
        await fetchAll(0, { preserveSettings: Boolean(res.settings) });
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
    if (batchAction?.running) return;
    if (stateFilter === 'uncertain') selectedJobIds.clear();
    resetPageQuery();
    if (serverPaging) fetchAll();
    else render();
  }

  function turnPage(page) {
    if (batchAction?.running) return;
    if (page < 1 || page === currentPage) return;
    if (serverPaging && page > 1 && !Object.prototype.hasOwnProperty.call(startCursors, page - 1)) return;
    if (stateFilter === 'uncertain') selectedJobIds.clear();
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
    }).sort((a, b) => (priorityOrder === 'desc' ? -1 : 1) * (followQueuePriority(a) - followQueuePriority(b)) || a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
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
    const publicationModeLabel = PUBLICATION_MODE_LABELS[settings.publicationMode] || PUBLICATION_MODE_LABELS.quote;
    const quoteLengthLabel = QUOTE_LENGTH_LABELS[settings.quoteLengthMode] || QUOTE_LENGTH_LABELS.adaptive;
    const grokStatus = settings.grokEnabled ? 'Grok 开启' : 'Grok 关闭';
    const grokDetails = `${grokStatus}；发帖形式：${publicationModeLabel}；创作概率：${settings.quoteParticipationRate ?? 60}%；篇幅：${quoteLengthLabel}；自动发布：${settings.autoPublish ? '开启' : '关闭'}`;
    const openSettings = () => {
      if(!settingsLoaded&&!settingsFetchError)return;
      isSettingsOpen = true;
      settingsDraft = createSettingsDraft(settings);
      settingsFieldErrors = {};
      settingsError = null;
      render();
    };
    const grokStatusEntry = panelIconButton(Sparkles, {
      label: 'Grok 创作设置', tip: grokDetails,
      className: `fq-grok-status ${settings.grokEnabled ? 'is-active' : ''}`,
      disabled: !currentAccountId || (!settingsLoaded && !settingsFetchError),
      onClick: openSettings
    });
    const scheduleTip = `定时调度：${settings.enabled ? '已开启' : '已关闭'}。点击${settings.enabled ? '关闭' : '开启'}后台周期调度；立即执行可单独运行一轮。`;
    const autoScheduleSwitch = el('label', {
      className: `panel-icon-button fq-schedule-toggle ${settings.enabled ? 'is-active' : ''}`,
      'data-panel-tip': scheduleTip
    }, [
      el('input', {
        type: 'checkbox',
        className: 'fq-switch-checkbox',
        checked: Boolean(settings.enabled),
        disabled: !currentAccountId,
        'aria-label': '定时调度',
        onChange: e => handleToggleAutoSchedule(e.target.checked)
      }),
      panelIcon(Clock3)
    ]);

    const settingsBtn = panelIconButton(Settings, {
      label: '关注队列设置',
      className: 'fq-header-icon-btn',
      disabled: !currentAccountId || (!settingsLoaded && !settingsFetchError),
      'aria-busy': !settingsLoaded && !settingsFetchError ? 'true' : 'false',
      onClick: openSettings
    });

    const refreshBtn = panelIconButton(RefreshCw, {
      label: '刷新队列', className: 'fq-header-icon-btn',
      onClick: () => fetchAll()
    });

    const execBtn = isExecuting
      ? panelIconButton(Square, {
          label: '停止执行',
          className: 'fq-action-icon-btn fq-btn-danger fq-exec-stop-btn fq-btn-executing',
          disabled: !currentAccountId,
          onClick: handleStopExecution
        })
      : panelIconButton(Zap, {
          label: '立即执行',
          className: 'fq-action-icon-btn fq-btn-primary fq-exec-run-btn',
          disabled: !currentAccountId,
          onClick: handleRunNow
        });
    const accountTip = currentAccountId
      ? `队列执行账号${accountHandle ? `：@${String(accountHandle).replace(/^@/, '')}` : ''}。任务和设置按此账号隔离；关注、创作及发布使用此账号。内部用户 ID：${currentAccountId}`
      : '未识别队列执行账号，请在 X 登录后重新识别。';

    return el('div', { className: 'fq-header' }, [
      el('div', { className: 'fq-header-title-wrap' }, [
        el('h2', { className: 'fq-header-title' }, [
          el('span', { className: 'fq-title-icon' }, '🎯'),
          '关注队列'
        ]),
        el('span', { className: 'fq-header-subtitle' }, '唯一后台调度器 · 统一候选执行中心')
      ]),
      el('div', { className: 'fq-header-actions module-header-actions panel-action-bar' }, [
        el('span', { className: `panel-icon-button fq-account-badge ${currentAccountId ? '' : 'fq-account-badge-missing'}`, tabindex:'0', role:'note', 'aria-label': accountTip, 'data-panel-tip':accountTip }, [panelIcon(UserRound)]),
        autoScheduleSwitch,
        refreshBtn,
        grokStatusEntry,
        settingsBtn,
        execBtn,
        panelIconButton(ScrollText, {
          label:'执行日志', className: 'fq-open-logs',
          onClick: () => root.dispatchEvent(new CustomEvent('open-execution-logs', {bubbles:true, detail:{scope:'queue'}}))
        })
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
      el('label', { className: 'fq-pagesize-label page-size-label' }, [
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
      el('label', { className: 'fq-pagesize-label page-size-label' }, [
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
      { id: 'fans', label: '粉丝跟进' },
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

    const selectionInfo = renderSelectionActions();

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
      subbar,
      renderBatchFeedback()
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
        el('th', { className: 'fq-col-priority', 'aria-sort': priorityOrder === 'desc' ? 'descending' : 'ascending' }, [
          el('button', {type:'button', className:'fq-priority-sort', title:priorityOrder === 'desc' ? '当前从大到小，点击从小到大排列' : '当前从小到大，点击从大到小排列', onClick:()=>{
            priorityOrder = priorityOrder === 'desc' ? 'asc' : 'desc';
            currentPage = 1; startCursors = [null]; selectedJobIds.clear(); fetchAll();
          }}, ['权重 ', el('span', {'aria-hidden':'true'}, priorityOrder === 'desc' ? '↓' : '↑')])
        ]),
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
        el('td', { colSpan: 8, className: 'fq-empty-cell' }, [
          el('div', { className: 'dash-load fq-load', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, [
            el('span', { className: 'dash-spinner', 'aria-hidden': 'true' }),
            el('span', { className: 'dash-load-text' }, '正在加载关注队列…')
          ])
        ])
      ]);
    } else if (visibleJobs.length === 0 && (error || settingsFetchError)) {
      tbodyContent = el('tr', {}, [
        el('td', { colSpan: 8, className: 'fq-empty-cell' }, [
          el('div', { className: 'dash-load dash-load-error', role: 'alert' }, [
            el('span', { className: 'dash-load-text' }, '关注队列读取失败，尚未确认列表为空')
          ])
        ])
      ]);
    } else if (visibleJobs.length === 0) {
      const emptyTitle = scanActive ? '正在检索匹配任务' : '关注队列暂无匹配任务';
      const emptyDesc = scanActive || scanStatus
        ? (scanStatus || '正在继续检索…')
        : '粉丝跟进、互关追踪或评论追踪发现候选后，将自动或手动投递至此处执行。';
      tbodyContent = el('tr', {}, [
        el('td', { colSpan: 8, className: 'fq-empty-cell' }, [
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
        const sourceTags = summarizeQueueSources(job.sources).map(src => {
          const modLabel = MODULE_LABELS[src.module] || src.module;
          const badge = el('span', {
            className: `fq-tag fq-module-${src.module}`,
            title: src.count > 1 ? `${src.count} 条来源记录，详情见溯源` : modLabel
          }, modLabel);

          if (src.url) {
            return el('a', {
              href: src.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: 'fq-source-link',
              title: src.count > 1 ? `${src.count} 条来源记录，详情见溯源` : src.url
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
        const stageText = job.stage ? el('span', { className: 'fq-tag fq-stage-tag' }, job.stage) : null;
        const leaseBadge = job.lease?.owner ? el('span', { className: 'fq-tag fq-stage-tag' }, `租约: ${job.lease.owner}`) : null;

        const stateCell = el('td', { className: 'fq-col-state' }, [
          el('div', {className:'fq-tags-wrap'}, [stateBadge, stageText, leaseBadge])
        ]);

        // Follow result cell
        let resultDisplay = '-';
        if (job.state === 'followed') {
          resultDisplay = '关注成功';
        } else if (job.state === 'skipped') {
          resultDisplay = displayFollowLimitError(job.followResult?.reason || '条件不符');
        } else if (job.state === 'retry') {
          resultDisplay = displayFollowLimitError(job.followResult?.error || '等待重试');
        } else if (job.state === 'uncertain') {
          resultDisplay = isAccountFollowLimit(job.followResult) ? '关注超额，关系待核实' : '待核对主页关系';
        } else if (job.followResult?.error) {
          resultDisplay = displayFollowLimitError(job.followResult.error);
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
            const evalMode = PUBLICATION_MODES.includes(ev?.publicationMode) ? ev.publicationMode : 'quote';
            const evalModeLabel = PUBLICATION_MODE_LABELS[evalMode] || PUBLICATION_MODE_LABELS.quote;
            const modeBadge = el('span', {
              className: `fq-tag fq-eval-mode-${evalMode}`,
              title: `发帖形式: ${evalModeLabel}`
            }, evalModeLabel);
            const statusBadge = el('span', {
              className: `fq-tag fq-eval-status-${ev.status || 'drafted'}`
            }, ev.recoveryDraftOnly && !ev.text && ev.status==='failed' ? '待生成' : ({pending:'待评论',processing:'评论中',publishing:'发布中',failed:'评论失败',uncertain:'待核实',draft:'草稿',posted:'已发布',skipped:'已跳过'})[ev.status] || ev.status || '草稿');

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

            return el('div', { className: 'fq-eval-row' }, [modeBadge, statusBadge, postLink]);
          }));
        }
        const feedback=evaluationFeedback.get(job.id)||evals.find(ev=>ev.reason)?.reason;
        const evalCell = el('td', { className: 'fq-col-eval' }, [
          busyJobIds.has(job.id)&&evaluationFeedback.has(job.id)?null:evalCellContent,
          feedback?el('div',{className:'fq-evaluation-feedback',role:'status','aria-live':'polite',title:feedback},feedback):null
        ].filter(Boolean));

        // Actions cell
        const isJobBusy = busyJobIds.has(job.id);
        const actionButtons = [];
        if (job.state === 'uncertain') {
          actionButtons.push(panelIconButton(UserRoundCheck, {
            label: '核对关系', tip: isJobBusy ? '核对中…' : '核对最新关注关系并更新任务状态',
            className: 'panel-icon-primary', 'aria-busy':String(isJobBusy),
            disabled: isJobBusy,
            onClick: () => handleVerifyJob(job, 'check')
          }));
          actionButtons.push(panelIconButton(Ban, {
            label: '排除', tip:'将任务标为已排除，停止后续执行',
            disabled: isJobBusy,
            onClick: () => handleVerifyJob(job, 'exclude')
          }));
        } else if (job.state === 'followed') {
          const pendingEval = evals.find(ev => ev && ev.status !== 'posted' && ev.status !== 'published');
          if (pendingEval && !['pending','processing','publishing'].includes(pendingEval.status)) {
            const retryLabel = pendingEval.status === 'uncertain'
              ? '核对评价'
              : ((pendingEval.status === 'draft' || pendingEval.status === 'drafted') && pendingEval.text ? '发布评价' : pendingEval.recoveryDraftOnly && !pendingEval.text?'重新生成':pendingEval.reasonCode==='quality_skip'?'重新评估':'重试评价');
            const retryIcon = retryLabel === '核对评价' ? ShieldCheck : retryLabel === '发布评价' ? Send : RotateCcw;
            actionButtons.push(panelIconButton(retryIcon, {
              label: retryLabel, tip:isJobBusy ? '处理中…' : retryLabel,
              className:'panel-icon-primary', 'aria-busy':String(isJobBusy),
              disabled: isJobBusy,
              onClick: () => handleRetryEvaluation(job, pendingEval, true)
            }));
          }
        }
        const traceBtn = panelIconButton(ListTree, {
          label: '溯源详情',
          onClick: () => {
            inspectingJob = job;
            render();
          }
        });
        actionButtons.push(traceBtn);
        actionButtons.push(panelIconButton(Trash2, {
          label:'删除', className: 'fq-delete-job',
          tip: job.state === 'running' ? '任务正在执行，结束后可删除' : '删除队列记录并阻止旧来源重新加入，不会在 X 上取关',
          disabled: isJobBusy || job.state === 'running',
          onClick: () => handleDeleteJob(job)
        }));
        const actionsCell = el('td', { className: 'fq-col-actions' }, [
          el('div', { className: 'fq-actions-group panel-action-bar' }, actionButtons)
        ]);

        return el('tr', {
          className: isSelected ? 'fq-row-selected' : '',
          key: job.id
        }, [
          el('td', { className: 'fq-col-check' }, [rowCheckbox]),
          targetCell,
          el('td', {className:'fq-col-priority'}, [el('span', {className:'fq-tag fq-priority-tag', title:'权重越高越先执行；确认待回关为 200，其他粉丝来源为 100；执行前重新核实关系，其他账号按本地回关数据换算'}, String(followQueuePriority(job)))]),
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

    const selectionSummary = renderSelectionActions();

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
      className: 'panel-close-button',
      type: 'button',
      'aria-label': '关闭',
      title: '关闭',
      onClick: () => {
        inspectingJob = null;
        render();
      }
    }, '');

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
          displayFollowLimitError(typeof job.followResult === 'string'
            ? job.followResult
            : (job.followResult?.reason || job.followResult?.error || (job.state === 'followed' ? '已关注成功' : '-')))
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
            const evalMode = PUBLICATION_MODES.includes(ev?.publicationMode) ? ev.publicationMode : 'quote';
            const evalModeLabel = PUBLICATION_MODE_LABELS[evalMode] || PUBLICATION_MODE_LABELS.quote;
            const evalModeDesc = evalMode === 'original'
              ? `${evalModeLabel}（独立发帖，不附带引用卡片）`
              : (evalMode==='quote'?`${evalModeLabel}（附带引用卡片）`:evalMode==='reply'?`${evalModeLabel}（原帖下回复）`:`${evalModeLabel}（X 长文与配图）`);
            const attemptCount = Array.isArray(ev.attempts) ? ev.attempts.length : (ev.attempts || 0);
            const draftIssue = ev.text ? (ev.quality?.reviewRequired ? '草稿质量判断待复核'
              : ev.publicationMode==='article' ? originalQualityIssue(ev.quality) : ev.publicationMode==='original' ? originalQualityIssue(ev.quality) || originalTextIssue(ev.text,ev.originalPostText) : quotePublishIssue(ev.text)) : '';
            const canRetryEval = job.state === 'followed' && ev.status !== 'posted' && ev.status !== 'published';
            const evalActions = canRetryEval
              ? el('div', { className: 'fq-trace-actions' }, [
                  el('button', {
                    className: 'fq-btn fq-btn-sm fq-btn-primary',
                    disabled: isJobBusy || Boolean(draftIssue),
                    title: draftIssue,
                    onClick: () => handleRetryEvaluation(job, ev, true)
                  }, isJobBusy
                    ? '处理中…'
                    : (draftIssue ? '草稿待复核' : ev.status === 'uncertain' ? '核对评价' : (ev.text ? '发布现有草稿' : ev.recoveryDraftOnly ? '重新生成' : '重新生成并发布'))),
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
                el('span', { className: 'fq-trace-label' }, '发帖形式:'),
                el('span', { className: 'fq-trace-val' }, evalModeDesc)
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
              ev.reason ? el('div', {className:'fq-trace-row'}, [el('span',{className:'fq-trace-label'},'处理原因:'),el('span',{className:'fq-trace-val'},ev.reason)]) : null,
              typeof ev.grokCalls === 'number' ? el('div', {className:'fq-trace-row'}, [el('span',{className:'fq-trace-label'},'Grok 调用:'),el('span',{className:'fq-trace-val'},String(ev.grokCalls))]) : null,
              ev.quality?.reason ? el('div', {className:'fq-trace-row'}, [el('span',{className:'fq-trace-label'},'引用价值:'),el('span',{className:'fq-trace-val'},ev.quality.reason)]) : null,
              el('div', { className: 'fq-trace-row' }, [
                el('span', { className: 'fq-trace-label' }, '已发布链接:'),
                el('span', { className: 'fq-trace-val' }, (() => {
                  if (!ev.publishedPostUrl) return '尚未发布';
                  const safe = safeHttpsUrl(ev.publishedPostUrl);
                  const label = ev.publishedPostId || (evalMode === 'original' ? '已发布新帖' : '已发布引用帖');
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
              ev.recoveryHistory?.length ? el('details', {className:'fq-recovery-history'}, [
                el('summary', {}, `恢复记录 ${ev.recoveryHistory.length}`),
                ...ev.recoveryHistory.map(entry=>el('div', {className:'fq-trace-section'}, [
                  el('p', {}, `${new Date(entry.at).toLocaleString()} · 生成未完成，未进入发布`),
                  el('p', {}, `原状态：${entry.evaluation?.status || '-'}；原因：${entry.evaluation?.reason || '-'}`),
                  el('p', {}, `原生成时间：${entry.evaluation?.generationAttemptedAt ? new Date(entry.evaluation.generationAttemptedAt).toLocaleString() : '-'}；原尝试次数：${Array.isArray(entry.evaluation?.attempts) ? entry.evaluation.attempts.length : entry.evaluation?.attempts || 0}`)
                ]))
              ]) : null,
              evalActions
            ]);
          }))
    ]);

    let resultOutcome = '未执行';
    if (job.state === 'followed') {
      resultOutcome = '关注成功';
    } else if (job.state === 'skipped') {
      resultOutcome = displayFollowLimitError(job.followResult?.reason || '条件不符跳过');
    } else if (job.state === 'retry') {
      resultOutcome = displayFollowLimitError(job.followResult?.error || '异常等待重试');
    } else if (job.state === 'uncertain') {
      resultOutcome = isAccountFollowLimit(job.followResult) ? '关注超额，关系待核实' : '发送后结果待核实';
    } else if (job.followResult?.error) {
      resultOutcome = displayFollowLimitError(job.followResult.error);
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
            el('span', { className: 'fq-trace-label' }, job.state === 'skipped' ? '跳过原因:' : '处理原因:'),
            el('span', { className: 'fq-trace-val' }, displayFollowLimitError(job.followResult.reason))
          ])
        : null,
      job.followResult?.error
        ? el('div', { className: 'fq-trace-row' }, [
            el('span', { className: 'fq-trace-label' }, '失败详情:'),
            el('span', { className: 'fq-trace-val' }, displayFollowLimitError(job.followResult.error))
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

    if (!settingsDraft) {
      settingsDraft = createSettingsDraft(settings);
    }
    const current = settingsDraft;

    const closeBtn = el('button', {
      className: 'panel-close-button',
      type: 'button',
      'aria-label': '关闭',
      title: '关闭',
      onClick: () => {
        closeSettingsDrawer();
        render();
      }
    }, '');

    const header = el('div', { className: 'fq-drawer-header' }, [
      el('strong', { className: 'fq-drawer-title' }, '关注队列设置'),
      closeBtn
    ]);

    // Input builders
    const settingHelp = text => el('span', {className: 'info-tip', tabindex: '0', role: 'note', 'data-tip': text, 'aria-label': text}, '?');
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
          el('span', {}, label), settingHelp(desc)
        ]),
        input
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
          el('span', {}, label), settingHelp(desc)
        ])
      ]);
    }

    const publicationModeHelpText = '评论直接回复原帖；引用评论附带原帖卡片；文章发布为 X 长文。默认引用评论，创作概率统一适用于三种形式。切换仅影响新任务，旧任务保持原定形式。';
    const publicationModeOptionHelp = {
      reply: '直接在原帖下发表评论，使用独立评论提示词。',
      article: '发布 X 长文，包含标题、分节正文、短描述和至少一张 5:2 封面；独立生成提示词，缺少封面时保留草稿。',
      quote: '附带原帖引用卡片发布评论；切换发帖形式仅影响新创建的任务。',
      original: '作为独立新帖发布（不附带引用卡片），要求具备更强的独立价值，不足时可能跳过；切换发帖形式仅影响新创建的任务。'
    };
    const publicationModeError = el('p', {
      id: 'fq_publicationMode_error',
      role: 'alert',
      className: 'fq-field-error fq-setting-error',
      style: { display: settingsFieldErrors.publicationMode ? 'block' : 'none' }
    }, settingsFieldErrors.publicationMode || '');
    const publicationModeValue = Object.prototype.hasOwnProperty.call(current, 'publicationModeRaw')
      ? String(current.publicationModeRaw)
      : String(current.publicationMode || DEFAULT_SETTINGS.publicationMode);
    let publicationModeRadiogroup = null;
    const publicationModeRadios = {};
    const syncPublicationMode = rawVal => {
      const rawStr = String(rawVal ?? '');
      current.publicationModeRaw = rawStr;
      current.publicationMode = rawStr;
      for (const [mode, radioNode] of Object.entries(publicationModeRadios)) {
        const isChecked = rawStr === mode;
        radioNode.checked = isChecked;
        if (isChecked) radioNode.setAttribute('checked', '');
        else radioNode.removeAttribute('checked');
        radioNode.setAttribute('aria-checked', isChecked ? 'true' : 'false');
      }
      if (!PUBLICATION_MODES.includes(rawStr)) {
        settingsFieldErrors.publicationMode = '发帖形式请选择评论、引用评论或文章';
        if (publicationModeRadiogroup) publicationModeRadiogroup.setAttribute('aria-invalid', 'true');
        publicationModeError.textContent = settingsFieldErrors.publicationMode;
        publicationModeError.style.display = 'block';
      } else {
        delete settingsFieldErrors.publicationMode;
        if (publicationModeRadiogroup) publicationModeRadiogroup.removeAttribute('aria-invalid');
        publicationModeError.textContent = '';
        publicationModeError.style.display = 'none';
      }
    };
    const radioOptions = PUBLICATION_MODES.filter(mode=>mode!=='original').map(mode => {
      const radioId = `fq_publicationMode_${mode}`;
      const isChecked = publicationModeValue === mode;
      const radioInput = el('input', {
        id: radioId,
        name: 'publicationMode',
        type: 'radio',
        className: 'fq-radio-input',
        value: mode,
        checked: isChecked,
        'aria-checked': isChecked ? 'true' : 'false',
        onClick: () => syncPublicationMode(mode),
        onInput: e => syncPublicationMode(e?.target?.value ?? mode),
        onChange: e => syncPublicationMode(e?.target?.value ?? mode)
      });
      publicationModeRadios[mode] = radioInput;
      return el('label', {
        htmlFor: radioId,
        className: 'fq-radio-label'
      }, [
        radioInput,
        el('span', {}, PUBLICATION_MODE_LABELS[mode] || mode),
        settingHelp(publicationModeOptionHelp[mode])
      ]);
    });
    publicationModeRadiogroup = el('div', {
      id: 'fq_publicationMode',
      role: 'radiogroup',
      'aria-labelledby': 'fq_publicationMode_label',
      'aria-describedby': 'fq_publicationMode_error',
      className: 'fq-radio-group fq-publication-mode-group',
      ...(settingsFieldErrors.publicationMode ? { 'aria-invalid': 'true' } : {}),
      onInput: e => { if (e?.target?.value !== undefined) syncPublicationMode(e.target.value); },
      onChange: e => { if (e?.target?.value !== undefined) syncPublicationMode(e.target.value); }
    }, radioOptions);
    const publicationModeGroup = el('div', { className: 'fq-setting-group fq-publication-mode-setting' }, [
      el('div', { id: 'fq_publicationMode_label', className: 'fq-setting-label' }, [
        el('span', {}, '发帖形式'),
        settingHelp(publicationModeHelpText + (publicationModeValue==='original' ? ' 当前仍使用旧版新帖，请选择一种形式并保存，已有任务不变。' : ''))
      ]),
      publicationModeRadiogroup,
      publicationModeError
    ]);

    const quoteRateHelpText = '每个任务在调用 Grok 创作前只抽取一次，抽中后仍可能因内容质量不足而跳过；设为 0% 会暂停所有未提交的自动创作（评论、引用评论与文章）任务。适用于新成功关注任务中的合格候选；修改比例仅影响尚未抽取的任务，不重抽已有结果，关注动作不受影响。';
    const quoteRateError = el('p', {
      id: 'fq_quoteParticipationRate_error',
      role: 'alert',
      className: 'fq-field-error fq-setting-error',
      style: { display: settingsFieldErrors.quoteParticipationRate ? 'block' : 'none' }
    }, settingsFieldErrors.quoteParticipationRate || '');
    const quoteRateValue = Object.prototype.hasOwnProperty.call(current, 'quoteParticipationRateRaw')
      ? String(current.quoteParticipationRateRaw)
      : String(current.quoteParticipationRate ?? DEFAULT_SETTINGS.quoteParticipationRate);
    let quoteRateInput = null;
    const syncQuoteRate = rawVal => {
      const rawStr = String(rawVal ?? '');
      current.quoteParticipationRateRaw = rawStr;
      const parsed = parseQuoteParticipationRateInput(rawStr);
      if (parsed === null) {
        current.quoteParticipationRate = rawStr;
        settingsFieldErrors.quoteParticipationRate = '请输入 0—100 的整数';
        if (quoteRateInput) quoteRateInput.setAttribute('aria-invalid', 'true');
        quoteRateError.textContent = settingsFieldErrors.quoteParticipationRate;
        quoteRateError.style.display = 'block';
      } else {
        current.quoteParticipationRate = parsed;
        delete settingsFieldErrors.quoteParticipationRate;
        if (quoteRateInput) quoteRateInput.removeAttribute('aria-invalid');
        quoteRateError.textContent = '';
        quoteRateError.style.display = 'none';
      }
    };
    quoteRateInput = el('input', {
      id: 'fq_quoteParticipationRate',
      name: 'quoteParticipationRate',
      type: 'number',
      className: 'fq-setting-input',
      value: quoteRateValue,
      min: '0',
      max: '100',
      step: '1',
      'aria-describedby': 'fq_quoteParticipationRate_error',
      ...(settingsFieldErrors.quoteParticipationRate ? { 'aria-invalid': 'true' } : {}),
      onInput: e => syncQuoteRate(e.target.value),
      onChange: e => syncQuoteRate(e.target.value)
    });
    const quoteRateGroup = el('div', { className: 'fq-setting-group' }, [
      el('label', { htmlFor: 'fq_quoteParticipationRate', className: 'fq-setting-label' }, [
        el('span', {}, '创作概率'),
        settingHelp(quoteRateHelpText)
      ]),
      quoteRateInput,
      quoteRateError
    ]);

    const quoteLengthHelpText = '自适应按原帖信息量表达，可选精简或深入；不设置必须写满的字数，平台能力上限始终有效。';
    const quoteLengthError = el('p', {
      id: 'fq_quoteLengthMode_error',
      role: 'alert',
      className: 'fq-field-error fq-setting-error',
      style: { display: settingsFieldErrors.quoteLengthMode ? 'block' : 'none' }
    }, settingsFieldErrors.quoteLengthMode || '');
    const quoteLengthValue = Object.prototype.hasOwnProperty.call(current, 'quoteLengthModeRaw')
      ? String(current.quoteLengthModeRaw)
      : String(current.quoteLengthMode || DEFAULT_SETTINGS.quoteLengthMode);
    let quoteLengthSelect = null;
    const syncQuoteLength = rawVal => {
      const rawStr = String(rawVal ?? '');
      current.quoteLengthModeRaw = rawStr;
      current.quoteLengthMode = rawStr;
      if (!QUOTE_LENGTH_MODES.includes(rawStr)) {
        settingsFieldErrors.quoteLengthMode = '篇幅仅支持自适应、精简或深入';
        if (quoteLengthSelect) quoteLengthSelect.setAttribute('aria-invalid', 'true');
        quoteLengthError.textContent = settingsFieldErrors.quoteLengthMode;
        quoteLengthError.style.display = 'block';
      } else {
        delete settingsFieldErrors.quoteLengthMode;
        if (quoteLengthSelect) quoteLengthSelect.removeAttribute('aria-invalid');
        quoteLengthError.textContent = '';
        quoteLengthError.style.display = 'none';
      }
    };
    quoteLengthSelect = el('select', {
      id: 'fq_quoteLengthMode',
      name: 'quoteLengthMode',
      className: 'fq-select fq-setting-select',
      value: quoteLengthValue,
      'aria-describedby': 'fq_quoteLengthMode_error',
      ...(settingsFieldErrors.quoteLengthMode ? { 'aria-invalid': 'true' } : {}),
      onInput: e => syncQuoteLength(e.target.value),
      onChange: e => syncQuoteLength(e.target.value)
    }, QUOTE_LENGTH_MODES.map(mode => el('option', {
      value: mode,
      selected: quoteLengthValue === mode
    }, QUOTE_LENGTH_LABELS[mode] || mode)));
    const quoteLengthGroup = el('div', { className: 'fq-setting-group' }, [
      el('label', { htmlFor: 'fq_quoteLengthMode', className: 'fq-setting-label' }, [
        el('span', {}, '篇幅'),
        settingHelp(quoteLengthHelpText)
      ]),
      quoteLengthSelect,
      quoteLengthError
    ]);

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
      tagPreview.textContent='随机抽取示例：'+(quoteTagSuffix(current)||'不追加标签')+'（候选 '+current.quoteSelectedTags.length+'/10）';
    };
    const enableTags=el('input',{type:'checkbox',checked:current.quoteTagsEnabled,onChange:e=>{current.quoteTagsEnabled=e.target.checked;renderTags();}});
    const tagSection=el('div',{className:'fq-setting-section'},[
      el('h4',{className:'fq-setting-section-title'},'引用评价标签'),
      el('label',{className:'fq-switch-label'},[enableTags,el('span',{},'追加随机标签'), settingHelp('从候选标签随机选取最多 2 个，并按评价语言筛选。重试沿用原标签；空间不足时减少标签，不截断正文。')]),
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
        createNumberGroup('fq_every', '调度间隔（分）', '每隔多少分钟调度器唤醒一次检查队列，默认 8 分钟 (1-240)。', 'every', SETTINGS_BOUNDS.every.min, SETTINGS_BOUNDS.every.max),
        createNumberGroup('fq_jitter', '随机浮动（±分）', '在基础周期上增减的随机分钟数，默认 ±2 分钟 (1-120)。', 'jitter', SETTINGS_BOUNDS.jitter.min, SETTINGS_BOUNDS.jitter.max),
        createNumberGroup('fq_batchLimit', '每轮关注人数', '每轮最多成功新增关注的人数，达到后停止并等待下轮，默认 5 人 (1-50)。', 'batchLimit', SETTINGS_BOUNDS.batchLimit.min, SETTINGS_BOUNDS.batchLimit.max),
        createNumberGroup('fq_inspectLimit', '每轮检查人数', '单轮最多检查候选人数，防止无限扫页看帖，默认 20 人 (1-200)。', 'inspectLimit', SETTINGS_BOUNDS.inspectLimit.min, SETTINGS_BOUNDS.inspectLimit.max),
        createNumberGroup('fq_timeBudget', '每轮时限（分）', '单轮任务最长耗时，超时则保存断点下一轮继续，默认 10 分钟 (1-120)。', 'timeBudgetMinutes', SETTINGS_BOUNDS.timeBudgetMinutes.min, SETTINGS_BOUNDS.timeBudgetMinutes.max)
      ]),
      el('div', { className: 'fq-setting-section' }, [
        el('h4', { className: 'fq-setting-section-title' }, '👀 主页访问与模拟看帖'),
        createNumberGroup('fq_scrollRounds', '主页滚动次数', '打开对方主页后向下模拟滚动的分段次数，默认 5 次 (1-8)。', 'scrollRounds', SETTINGS_BOUNDS.scrollRounds.min, SETTINGS_BOUNDS.scrollRounds.max),
        createNumberGroup('fq_dwellSec', '停留时间（秒）', '打开主页后的浏览停留基准秒数，默认 15 秒 (2-60)。', 'dwellSeconds', SETTINGS_BOUNDS.dwellSeconds.min, SETTINGS_BOUNDS.dwellSeconds.max),
        createNumberGroup('fq_dwellJitter', '停留随机浮动（±秒）', '在停留基准上的随机增减秒数，默认 ±5 秒 (1-30)。', 'dwellJitter', SETTINGS_BOUNDS.dwellJitter.min, SETTINGS_BOUNDS.dwellJitter.max)
      ]),
      el('div', { className: 'fq-setting-section' }, [
        el('h4', { className: 'fq-setting-section-title' }, '🛡️ 筛选过滤与意向门槛'),
        createNumberGroup('fq_minFollowers', '最低粉丝数', '过滤粉丝过少的小号，优先活跃账号，默认 50 (0-100000000)。', 'minFollowers', SETTINGS_BOUNDS.minFollowers.min, SETTINGS_BOUNDS.minFollowers.max),
        createNumberGroup('fq_ratioThreshold', '关注／粉丝比', '关注数达到粉丝数该比例以上（默认 0.8 即 80%），防止骗关 (0-1)。', 'ratioThreshold', SETTINGS_BOUNDS.ratioThreshold.min, SETTINGS_BOUNDS.ratioThreshold.max, 0.05),
        createSwitchGroup('fq_followBackAllowAll', '待回关放行', '默认关闭。仅粉丝跟进来源且执行时确认对方关注我、我尚未回关的任务，跳过普通关注筛选。例外：关注数超过粉丝数10倍时不回关，通过X接口移除此关注者；移除前再次核验，关系或数据不明时待核实。不影响采集、入队与评论审核。', 'followBackAllowAll'),
        createSwitchGroup('fq_onlyRecommended', '仅推荐或互粉账号', '对方需带有互粉标签或符合推荐条件，否则自动策略跳过。', 'onlyRecommended'),
        createSwitchGroup('fq_skipRiskContent', '跳过敏感内容', '默认开启。原帖或账号若涉及高危内容，自动跳过关注与引用评论，杜绝违规封号风险。', 'skipRiskContent')
      ]),
      el('div', { className: 'fq-setting-section' }, [
        el('h4', { className: 'fq-setting-section-title' }, '🤖 Grok 创作与发布'),
        el('div',{className:'fq-setting-row'},[
          el('label',{'for':'fq_grokProvider'},[el('span',{},'生成通道'),settingHelp('Grok Hook 通过自动化 Webhook 生成，不代表独立 Bot 额度。切换立即保存，未绑定时打开向导。文章配图仍使用独立配图服务。')]),
          el('select',{id:'fq_grokProvider',value:grokProviderController.provider.value,onChange:async event=>{const control=event.target;control.disabled=true;try{await grokProviderController.select(control.value);}catch(error){settingsError=error.message;render();}finally{control.value=grokProviderController.provider.value;control.disabled=false;}}},[
            el('option',{value:'grok',selected:grokProviderController.provider.value==='grok'},'Grok'),
            el('option',{value:'grok-bot',selected:grokProviderController.provider.value==='grok-bot'},'Grok Hook'),
            el('option',{value:'grok-local',selected:grokProviderController.provider.value==='grok-local'},'Grok Bot')])]),
        createSwitchGroup('fq_grokEnabled', 'Grok 自动创作', '排除置顶帖后取最近最多 20 条帖子，综合分＝评论＋3×转发＋3×点赞＋3×收藏。同分保留时间线靠前的一条；指标缺失不按零处理。仅抽中参与概率的任务交给 Grok 评估并写作，质量不足跳过且不换帖。', 'grokEnabled'),
        createSwitchGroup('fq_followBackSuffixEnabled', '来关必回', '默认关闭。开启后，在评论和引用评论末尾按评价语言追加：中文“来关必回”、英文“I follow back.”，西班牙语和葡萄牙语使用对应文案；已有同义文案不重复。空间不足时保留草稿并提示，不截断正文。文章不追加。', 'followBackSuffixEnabled'),
        publicationModeGroup,
        el('button', {type:'button',className:'fq-btn fq-btn-secondary',id:'fq_cloudflare_connection',title:'文章配图优先使用 X.com Grok；额度耗尽或出图失败时，才使用已绑定的 Cloudflare 生成无文字封面兜底。点击管理、解绑或重新绑定。',onClick:()=>cloudflareImagesController.open().catch(error=>{settingsError=error.message;render();})}, cloudflareImagesController.connected.value?'Cloudflare 已绑定 · 管理':'连接文章配图服务'),
        quoteRateGroup,
        quoteLengthGroup,
        createSwitchGroup('fq_autoPublish', '自动公开发布', '如开启，创作草稿就绪后将按所选发帖形式直接公开发布。未开启则仅存草稿。', 'autoPublish')
      ]), tagSection
    ]);

    const footer = el('div', { className: 'fq-drawer-footer' }, [
      el('button', {
        className: 'fq-btn fq-btn-secondary',
        onClick: () => {
          closeSettingsDrawer();
          render();
        }
      }, '取消'),
      el('button', {
        className: 'fq-btn fq-btn-primary',
        disabled: !currentAccountId || !settingsLoaded || Boolean(settingsFetchError) || isSettingsSaving,
        onClick: () => {
          const resolvePublicationModeBeforeSave = () => {
            if (!PUBLICATION_MODES.includes(current.publicationModeRaw)) {
              return current.publicationModeRaw;
            }
            const checkedModes = Object.entries(publicationModeRadios)
              .filter(([, node]) => node.checked)
              .map(([mode]) => mode);
            if (checkedModes.length === 0) return '';
            if (checkedModes.length === 1) return checkedModes[0];
            const changedMode = checkedModes.find(mode => mode !== current.publicationModeRaw);
            return changedMode || checkedModes[0];
          };
          syncPublicationMode(resolvePublicationModeBeforeSave());
          syncQuoteRate(quoteRateInput.value);
          syncQuoteLength(quoteLengthSelect.value);
          handleSaveSettings(current);
        }
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
          closeSettingsDrawer();
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
    if (batchAction?.running) {
      for (const tag of ['button','input','select']) for (const control of root.querySelectorAll(tag)) {
        if (!control.hasAttribute('data-batch-stop')) control.disabled = true;
      }
    }
  }

  // Keydown listener for ESC to close drawers
  const onKeydown = e => {
    if (e.key === 'Escape') {
      if (inspectingJob) {
        inspectingJob = null;
        render();
      } else if (isSettingsOpen) {
        closeSettingsDrawer();
        render();
      }
    }
  };
  document.addEventListener('keydown', onKeydown);
  const onEvaluationProgress=message=>{
    if(message?.cmd!=='followQueueEvaluationProgress'||message.accountId!==currentAccountId||!activeEvaluations.has(message.jobId)||isDestroyed)return;
    evaluationFeedback.set(message.jobId,String(message.label||'正在处理评价…'));render();
  };
  globalThis.chrome?.runtime?.onMessage?.addListener(onEvaluationProgress);
  cleanups.push(()=>globalThis.chrome?.runtime?.onMessage?.removeListener(onEvaluationProgress));
  cleanups.push(() => document.removeEventListener('keydown', onKeydown));
  // This panel renders native DOM outside Vue. Update only the connection
  // button, preserving unsaved settings and the drawer's scroll position.
  cleanups.push(watch(cloudflareImagesController.connected,connected=>{
    const button=root.querySelector('#fq_cloudflare_connection');
    if(button)button.textContent=connected?'Cloudflare 已绑定 · 管理':'连接文章配图服务';
  }));
  cleanups.push(watch(grokProviderController.provider,value=>{const control=document.getElementById('fq_grokProvider');if(control)control.value=value;}));
  grokProviderController.refresh().catch(console.warn);
  const onGrokProviderChange=(changes,area)=>{if(area==='local'&&changes['systemSettings:grokProvider'])grokProviderController.refresh().catch(console.warn);};
  globalThis.chrome?.storage?.onChanged?.addListener(onGrokProviderChange);
  cleanups.push(()=>globalThis.chrome?.storage?.onChanged?.removeListener(onGrokProviderChange));
  const refreshImageConnection=()=>cloudflareImagesController.refreshStatus().catch(()=>{});
  refreshImageConnection();
  globalThis.window?.addEventListener?.('focus',refreshImageConnection);
  cleanups.push(()=>globalThis.window?.removeEventListener?.('focus',refreshImageConnection));

  const applyPagePreference=async(initial=false)=>{
    const preference=await readSystemSettings('pagination');
    if(isDestroyed)return;
    pageSize=preference.queue;
    if(initial)await fetchAll();else applyListChange();
  };
  const onPreferences=(changes,area)=>{if(area==='local'&&changes[systemSettingsKey('pagination')])applyPagePreference().catch(console.warn);};
  globalThis.chrome?.storage?.onChanged?.addListener(onPreferences);
  cleanups.push(()=>globalThis.chrome?.storage?.onChanged?.removeListener(onPreferences));
  if(globalThis.chrome?.storage?.local?.get && currentAccountId)applyPagePreference(true).catch(()=>fetchAll());
  else fetchAll();

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
