import { ref, computed } from 'vue';
import { createLogPager, LOG_PAGE_SIZE } from '../../../../execution-log-store.js';

/**
 * Composable for managing execution logs modal state, reactive pagination,
 * and background query/clear communication with multi-generation token safety.
 */
export function useExecutionLogs() {
  const isOpen = ref(false);
  const currentScope = ref('autoFollow');
  const status = ref('ready'); // 'loading' | 'error' | 'ready'
  const errorMessage = ref('');
  const entries = ref([]);
  const total = ref(0);
  const canPrev = ref(false);
  const canNext = ref(false);

  const logPager = createLogPager();

  const title = computed(() => {
    const scope = currentScope.value;
    if (scope === 'fans' || scope === 'monitor') {
      return '粉丝管理 · 粉丝检测与回关入队日志';
    }
    if (scope === 'unreciprocated') {
      return '回关监测 · 定时检测与取关日志';
    }
    const prefix = scope === 'comment' ? '评论追踪' : scope === 'mutual' ? '互关追踪' : '关注队列';
    return `${prefix} · 执行日志`;
  });

  const totalBadgeText = computed(() => `${total.value} 条记录`);

  const emptyTitle = computed(() => {
    const scope = currentScope.value;
    if (scope === 'fans' || scope === 'monitor') return '暂无粉丝管理执行日志';
    if (scope === 'unreciprocated') return '暂无回关监测日志';
    return '暂无执行日志记录';
  });

  const emptyDescription = computed(() => {
    const scope = currentScope.value;
    if (scope === 'fans' || scope === 'monitor') {
      return '点击“↻ 增量同步关注与粉丝数据”或开启定时检测后，检测记录、粉丝变动及自动拉取至关注队列的明细将显示在此。';
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
      ? '粉丝管理检测与回关入队日志'
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
    status,
    errorMessage,
    entries,
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
