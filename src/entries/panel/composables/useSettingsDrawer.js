import { ref, computed } from 'vue';

/**
 * Composable for managing 粉丝管理 · 定时检测与自动回关设置抽屉
 */
export function useSettingsDrawer() {
  const isOpen = ref(false);
  const enabled = ref(false);
  const every = ref(60);
  const jitter = ref(15);
  const autoEnqueue = ref(true);
  const filterDanger = ref(true);
  const checkpointHandle = ref('');
  const checkpointAt = ref('');
  const lastSummary = ref('尚未执行检测');
  const saving = ref(false);
  const running = ref(false);
  const errorMessage = ref('');
  const successMessage = ref('');

  let saveHandler = null;
  let runHandler = null;

  function setSaveHandler(fn) {
    saveHandler = fn;
  }

  function setRunHandler(fn) {
    runHandler = fn;
  }

  function open(currentConfig = {}) {
    errorMessage.value = '';
    successMessage.value = '';
    enabled.value = Boolean(currentConfig.enabled);
    every.value = Number(currentConfig.every) || 60;
    jitter.value = currentConfig.jitter != null ? Number(currentConfig.jitter) : 15;
    autoEnqueue.value = currentConfig.autoEnqueue !== false;
    filterDanger.value = currentConfig.filterDanger !== false;
    checkpointHandle.value = currentConfig.checkpointHandle || '';
    checkpointAt.value = currentConfig.checkpointAt || '';
    lastSummary.value = currentConfig.lastSummary || (currentConfig.lastScan ? `上次检测于 ${new Date(currentConfig.lastScan).toLocaleString()}` : '尚未执行检测');
    isOpen.value = true;
  }

  function close() {
    isOpen.value = false;
    errorMessage.value = '';
    successMessage.value = '';
  }

  const checkpointDisplayText = computed(() => {
    if (checkpointHandle.value) {
      return `最新位点：@${checkpointHandle.value}`;
    }
    return '未记录位点（首次将建立增量基准）';
  });

  const checkpointTimeText = computed(() => {
    if (checkpointAt.value) {
      return `记录于 ${new Date(checkpointAt.value).toLocaleString()}`;
    }
    return '';
  });

  function validate() {
    const e = Number(every.value);
    const j = Number(jitter.value);
    if (!Number.isFinite(e) || e < 10) {
      throw new Error('基准检索间隔至少 10 分钟。');
    }
    if (!Number.isFinite(j) || j < 1 || j >= e) {
      throw new Error('随机浮动必须至少 1 分钟且小于基准间隔。');
    }
    return {
      enabled: Boolean(enabled.value),
      every: e,
      jitter: j,
      autoEnqueue: Boolean(autoEnqueue.value),
      filterDanger: Boolean(filterDanger.value)
    };
  }

  async function save() {
    errorMessage.value = '';
    successMessage.value = '';
    let validatedConfig;
    try {
      validatedConfig = validate();
    } catch (err) {
      errorMessage.value = err.message;
      return false;
    }

    if (saveHandler) {
      saving.value = true;
      try {
        await saveHandler(validatedConfig);
        successMessage.value = '配置已保存';
        setTimeout(() => {
          if (successMessage.value === '配置已保存') successMessage.value = '';
        }, 2000);
        return true;
      } catch (err) {
        errorMessage.value = err.message || '保存失败';
        return false;
      } finally {
        saving.value = false;
      }
    }
    return true;
  }

  async function triggerRunNow() {
    if (running.value) return;
    errorMessage.value = '';
    if (runHandler) {
      running.value = true;
      try {
        await runHandler();
        successMessage.value = '检测已完成';
        setTimeout(() => {
          if (successMessage.value === '检测已完成') successMessage.value = '';
        }, 2000);
      } catch (err) {
        errorMessage.value = err.message || '执行失败';
      } finally {
        running.value = false;
      }
    }
  }

  function openLogs() {
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('open-execution-logs', { detail: { scope: 'fans' } }));
    }
  }

  return {
    isOpen,
    enabled,
    every,
    jitter,
    autoEnqueue,
    filterDanger,
    checkpointHandle,
    checkpointAt,
    lastSummary,
    checkpointDisplayText,
    checkpointTimeText,
    saving,
    running,
    errorMessage,
    successMessage,
    open,
    close,
    validate,
    save,
    triggerRunNow,
    openLogs,
    setSaveHandler,
    setRunHandler
  };
}

export const settingsDrawerController = useSettingsDrawer();
