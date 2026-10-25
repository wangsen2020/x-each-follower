import {queryUnfollowLogs} from '../../../shared/execution-log-select.js';
import {readSystemSettings} from '../../../shared/system-settings.js';
import { ref, computed } from 'vue';
import { createLogPager, LOG_PAGE_SIZE } from '../../../shared/execution-log-store.js';

/**
 * Composable for managing execution logs modal state, reactive pagination,
 * sub-tab classification (Fans Scan Logs vs Queue Follow-Back Logs),
 * and background query/clear communication with multi-generation token safety.
 */
export function useExecutionLogs() {
  const isOpen = ref(false);
  const currentScope = ref('queue');
  const followbackSubTab = ref('all');
  async function setFollowbackSubTab(tab) {
    if (!['all','unfollow'].includes(tab)) return;
    followbackSubTab.value = tab; logPager.reset();
    if (isOpen.value) await loadPage();
  }
  const fansSubTab = ref('scan'); // 'scan' | 'followBack'
  const status = ref('ready'); // 'loading' | 'error' | 'ready'
  const errorMessage = ref('');
  const entries = ref([]);
  const total = ref(0);
  const queryDays = ref(0);
  const canPrev = ref(false);
  const canNext = ref(false);
  const elapsedSeconds = ref(0);
  const recovery = ref(null);
  let loadingTimer;
  const loadingTitle = computed(() => recovery.value?.phase === 'recovering' ? '正在恢复历史日志…' : '正在加载执行日志…');
  const loadingDetail = computed(() => {
    const state = recovery.value;
    if (state?.phase === 'recovering') return `已恢复 ${state.current} / ${state.total} 项历史操作，完成后自动显示。`;
    if (elapsedSeconds.value >= 10) return '加载时间较长，仍在等待后台响应。你可以关闭窗口稍后重试。';
    return '正在读取本页记录，请稍候。';
  });

  function stopLoadingFeedback() {
    clearInterval(loadingTimer);
    loadingTimer = undefined;
  }

  function startLoadingFeedback(token) {
    stopLoadingFeedback();
    elapsedSeconds.value = 0;
    recovery.value = null;
    const started = Date.now();
    let polling = false;
    loadingTimer = setInterval(async () => {
      if (!logPager.current(token) || status.value !== 'loading' || !isOpen.value) return;
      elapsedSeconds.value = Math.floor((Date.now() - started) / 1000);
      if (polling || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
      polling = true;
      try {
        const response = await chrome.runtime.sendMessage({cmd: 'executionLogStatus'});
        if (logPager.current(token) && status.value === 'loading' && response?.ok) recovery.value = response.recovery;
      } catch { /* The primary page request reports failures. */ }
      finally { polling = false; }
    }, 500);
  }

  const logPager = createLogPager();
  let pageSize=LOG_PAGE_SIZE, since=null;

  const isFansScope = computed(() => currentScope.value === 'fans' || currentScope.value === 'monitor');

  async function setFansSubTab(tab) {
    if (tab !== 'scan' && tab !== 'followBack') return;
    if (fansSubTab.value === tab) return;
    fansSubTab.value = tab;
    if (isOpen.value) {
      logPager.reset();
      await loadPage();
    }
  }

  const title = computed(() => {
    const scope = currentScope.value;
    if (scope === 'fans' || scope === 'monitor') {
      if (fansSubTab.value === 'scan') return '粉丝跟进 · 粉丝扫描日志';
      if (fansSubTab.value === 'followBack') return '粉丝跟进 · 队列回关日志';
      return '粉丝跟进 · 全部执行日志';
    }
    if (scope === 'unreciprocated') {
      return '回关监控 · 执行日志';
    }
    const prefix = scope === 'comment' ? '评论追踪' : scope === 'mutual' ? '互关追踪' : '关注队列';
    return `${prefix} · 执行日志`;
  });

  const displayedEntries = computed(() => {
    if (!isFansScope.value) return entries.value;
    if (fansSubTab.value === 'scan') {
      return entries.value.filter(e => e.scope === 'fans' || e.scope === 'monitor' || e.origin === 'monitorLogs' || e.scope === 'verification');
    }
    if (fansSubTab.value === 'followBack') {
      return entries.value.filter(e => e.scope === 'verification' || (e.scope === 'queue' && e.sources?.some(source => source.module === 'fans')));
    }
    return entries.value;
  });

  const totalBadgeText = computed(() => {
    if (status.value === 'loading') return '加载中';
    if (isFansScope.value && fansSubTab.value === 'followBack') {
      return `${queryDays.value ? `近 ${queryDays.value} 天 · ` : ''}${total.value} 条记录`;
    }
    return `${queryDays.value ? `近 ${queryDays.value} 天 · ` : ''}${total.value} 条记录`;
  });

  const emptyTitle = computed(() => {
    const scope = currentScope.value;
    if (scope === 'fans' || scope === 'monitor') {
      if (fansSubTab.value === 'scan') return '暂无粉丝扫描日志';
      if (fansSubTab.value === 'followBack') return '暂无队列回关日志';
      return '暂无粉丝跟进执行日志';
    }
    if (scope === 'unreciprocated') return '暂无回关监控日志';
    return '暂无执行日志记录';
  });

  const emptyDescription = computed(() => {
    const scope = currentScope.value;
    if (scope === 'fans' || scope === 'monitor') {
      if (fansSubTab.value === 'scan') {
        return '定时检测周期到达或点击右上角“↻”手动同步后，将记录扫描人数、获取粉丝、待回关及入队明细。';
      }
      if (fansSubTab.value === 'followBack') {
        return '待回关粉丝加入关注队列并被执行回关时，将记录访问主页、回关结果与互动评价等明细。';
      }
      return '点击“↻ 增量同步关注与粉丝数据”或关注队列执行回关后，相关明细将显示在此。';
    }
    if (scope === 'unreciprocated') {
      return '点击“开始检测”或开启定时取关后，检测与取关记录将显示在此。';
    }
    return '开启定时看帖关注或点击“立即执行”后，访问的主页、扫描的帖子及关注结果将记录在此。';
  });

  function updatePaginationFlags() {
    canPrev.value = status.value !== 'loading' && logPager.canPrev();
    canNext.value = status.value !== 'loading' && logPager.canNext();
  }

  async function loadPage() {
    const token = logPager.begin();
    status.value = 'loading';
    errorMessage.value = '';
    updatePaginationFlags();
    startLoadingFeedback(token);

    let saved;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        let queryScope = currentScope.value;
        if (isFansScope.value && fansSubTab.value === 'followBack') {
          queryScope = 'queueFans';
        }
        const query = {
          cmd: 'queryExecutionLogs',
          scope: queryScope,
          ...(queryScope === 'unreciprocated' && followbackSubTab.value === 'unfollow' ? {kind:'unfollow'} : {}),
          limit: pageSize,
          since,
          cursor: logPager.cursor()
        };
        saved = query.kind === 'unfollow'
          ? await queryUnfollowLogs(message => chrome.runtime.sendMessage(message), query)
          : await chrome.runtime.sendMessage(query);
      } else {
        saved = { ok: true, entries: [], total: 0 };
      }
    } catch (err) {
      if (!logPager.current(token)) return;
      stopLoadingFeedback();
      status.value = 'error';
      errorMessage.value = err?.message || '日志后台未响应，请重新加载扩展';
      entries.value = [];
      updatePaginationFlags();
      return;
    }

    if (!logPager.current(token)) return;
    stopLoadingFeedback();
    if (!saved?.ok) {
      status.value = 'error';
      errorMessage.value = saved?.error || '日志后台未响应，请重新加载扩展';
      entries.value = [];
      updatePaginationFlags();
      return;
    }

    logPager.notePage(token, saved);
    entries.value = Array.isArray(saved.entries) ? saved.entries : [];
    total.value = Number(saved.total) || 0;
    status.value = 'ready';
    updatePaginationFlags();
  }

  async function open(scope = 'queue') {
    currentScope.value = scope === 'autoFollow' ? 'queue' : scope;
    if (scope === 'fans' || scope === 'monitor') {
      fansSubTab.value = 'scan';
    }
    logPager.reset();
    entries.value = [];
    total.value = 0;
    isOpen.value = true;
    status.value = 'loading';
    const generation=logPager.generation();
    try {
      const settings=globalThis.chrome?.storage?.local?.get ? await readSystemSettings('logs') : {pageSize:LOG_PAGE_SIZE,days:0};
      if(!isOpen.value || generation!==logPager.generation())return;
      pageSize=settings.pageSize;
      queryDays.value=settings.days;
      since=settings.days?new Date(Date.now()-settings.days*86400000).toISOString():null;
    } catch(error) {
      if(!isOpen.value || generation!==logPager.generation())return;
      status.value='error';errorMessage.value=error.message;return;
    }
    await loadPage();
  }

  function close() {
    isOpen.value = false;
    logPager.reset();
    stopLoadingFeedback();
  }

  async function prevPage() {
    if (status.value === 'loading' || !logPager.canPrev()) return;
    if (!logPager.back()) return;
    await loadPage();
  }

  async function nextPage() {
    if (status.value === 'loading' || !logPager.canNext()) return;
    if (!logPager.forward()) return;
    await loadPage();
  }

  async function clearLogs() {
    if (currentScope.value === 'unreciprocated' && followbackSubTab.value === 'unfollow') return;
    const scope = currentScope.value;
    if (isFansScope.value && fansSubTab.value === 'followBack') {
      if (typeof window !== 'undefined' && window.alert) {
        window.alert('队列回关记录由关注队列统一管理，如需清空请前往“关注队列”面板。');
      }
      return;
    }

    const label = scope === 'fans' || scope === 'monitor'
      ? (fansSubTab.value === 'scan' ? '粉丝扫描日志' : '粉丝跟进全部日志')
      : scope === 'unreciprocated'
        ? '回关监控执行日志'
        : '当前范围的执行日志';

    if (typeof window !== 'undefined' && window.confirm && !window.confirm(`确定清空${label}吗？包含全部时间的历史记录，此操作不可撤销。`)) {
      return;
    }

    const token = logPager.generation();
    let saved;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        saved = await chrome.runtime.sendMessage({ cmd: 'clearExecutionLogs', scope });
      } else {
        saved = { ok: true };
      }
    } catch (err) {
      if (!isOpen.value || currentScope.value !== scope || logPager.generation() !== token) return;
      status.value = 'error';
      errorMessage.value = err?.message || '清空日志失败';
      return;
    }

    if (!isOpen.value || currentScope.value !== scope || logPager.generation() !== token) return;
    if (!saved?.ok) {
      status.value = 'error';
      errorMessage.value = saved?.error || '清空日志失败';
      return;
    }

    logPager.reset();
    await loadPage();
  }

  async function refreshIfOpen(targetScope) {
    if (targetScope === 'autoFollow') targetScope = 'queue';
    if (!isOpen.value) return;
    if (targetScope) {
      const match = targetScope === currentScope.value ||
        ((targetScope === 'fans' || targetScope === 'monitor') && (currentScope.value === 'fans' || currentScope.value === 'monitor'));
      if (!match) return;
    }
    await loadPage();
  }

  return {
    isOpen,
    currentScope,
    fansSubTab,
    followbackSubTab,
    setFollowbackSubTab,
    isFansScope,
    setFansSubTab,
    status,
    errorMessage,
    elapsedSeconds,
    loadingTitle,
    loadingDetail,
    entries: displayedEntries,
    rawEntries: entries,
    total,
    canPrev,
    canNext,
    title,
    totalBadgeText,
    emptyTitle,
    emptyDescription,
    logPager,
    open,
    close,
    loadPage,
    prevPage,
    nextPage,
    clearLogs,
    refreshIfOpen
  };
}

// Global singleton instance for panel controller coordination
export const logsModalController = useExecutionLogs();
