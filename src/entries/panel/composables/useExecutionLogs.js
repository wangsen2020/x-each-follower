import { ref, computed } from 'vue';
import { createLogPager, LOG_PAGE_SIZE } from '../../../../execution-log-store.js';

/**
 * Composable for managing execution logs modal state, reactive pagination,
 * sub-tab classification (Fans Scan Logs vs Queue Follow-Back Logs),
 * and background query/clear communication with multi-generation token safety.
 */
export function useExecutionLogs() {
  const isOpen = ref(false);
  const currentScope = ref('autoFollow');
  const fansSubTab = ref('scan'); // 'scan' | 'followBack' | 'all'
  const status = ref('ready'); // 'loading' | 'error' | 'ready'
  const errorMessage = ref('');
  const entries = ref([]);
  const total = ref(0);
  const canPrev = ref(false);
  const canNext = ref(false);

  const logPager = createLogPager();

  const isFansScope = computed(() => currentScope.value === 'fans' || currentScope.value === 'monitor');

  function setFansSubTab(tab) {
    fansSubTab.value = tab;
  }

  const title = computed(() => {
    const scope = currentScope.value;
    if (scope === 'fans' || scope === 'monitor') {
      if (fansSubTab.value === 'scan') return '粉丝管理 · 粉丝扫描日志';
      if (fansSubTab.value === 'followBack') return '粉丝管理 · 队列回关日志';
      return '粉丝管理 · 全部执行日志';
    }
    if (scope === 'unreciprocated') {
      return '回关监测 · 定时检测与取关日志';
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
      return entries.value.filter(e => e.scope === 'queue' || e.scope === 'verification');
    }
    return entries.value;
  });

  const totalBadgeText = computed(() => {
    if (isFansScope.value && fansSubTab.value !== 'all') {
      return `${displayedEntries.value.length} 条记录`;
    }
    return `${total.value} 条记录`;
  });

  const emptyTitle = computed(() => {
    const scope = currentScope.value;
    if (scope === 'fans' || scope === 'monitor') {
      if (fansSubTab.value === 'scan') return '暂无粉丝扫描日志';
      if (fansSubTab.value === 'followBack') return '暂无队列回关日志';
      return '暂无粉丝管理执行日志';
    }
    if (scope === 'unreciprocated') return '暂无回关监测日志';
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

    let saved;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        saved = await chrome.runtime.sendMessage({
          cmd: 'queryExecutionLogs',
          scope: currentScope.value,
          limit: LOG_PAGE_SIZE,
          cursor: logPager.cursor()
        });
      } else {
        saved = { ok: true, entries: [], total: 0 };
      }
    } catch (err) {
      if (!logPager.current(token)) return;
      status.value = 'error';
      errorMessage.value = err?.message || '日志后台未响应，请重新加载扩展';
      entries.value = [];
      updatePaginationFlags();
      return;
    }

    if (!logPager.current(token)) return;
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

  async function open(scope = 'autoFollow') {
    currentScope.value = scope;
    if (scope === 'fans' || scope === 'monitor') {
      fansSubTab.value = 'scan';
    }
    logPager.reset();
    entries.value = [];
    total.value = 0;
    isOpen.value = true;
    await loadPage();
  }

  function close() {
    isOpen.value = false;
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
    const scope = currentScope.value;
    const label = scope === 'fans' || scope === 'monitor'
      ? (fansSubTab.value === 'scan' ? '粉丝扫描日志' : fansSubTab.value === 'followBack' ? '队列回关日志' : '粉丝管理全部日志')
      : scope === 'unreciprocated'
        ? '回关监测执行日志'
        : '当前范围的执行日志';

    if (typeof window !== 'undefined' && window.confirm && !window.confirm(`确定清空${label}吗？此操作不可撤销。`)) {
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
    isFansScope,
    setFansSubTab,
    status,
    errorMessage,
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
