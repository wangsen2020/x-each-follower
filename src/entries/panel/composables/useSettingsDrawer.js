import { ref, computed } from 'vue';

/**
 * Composable for managing 粉丝跟进 · 定时检测与自动回关设置抽屉
 */
export function useSettingsDrawer() {
  const isOpen = ref(false);
  const enabled = ref(false);
  const every = ref(10);
  const jitter = ref(0);
  const followerBatch = ref(1000);
  const followingBatch = ref(1000);
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
    every.value = Number(currentConfig.every) || 10;
    jitter.value = currentConfig.jitter != null ? Number(currentConfig.jitter) : 0;
    followerBatch.value = Number(currentConfig.followerBatch) || 1000;
    followingBatch.value = Number(currentConfig.followingBatch) || 1000;
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
    if (!Number.isFinite(j) || j < 0 || j >= e) {
      throw new Error('随机浮动须在 0 到周期以下；0 表示固定间隔。');
    }
    const f = Number(followerBatch.value);
    const g = Number(followingBatch.value);
    if (!Number.isInteger(f) || f < 100 || f > 1000 || f % 20 || !Number.isInteger(g) || g < 100 || g > 1000 || g % 20) {
      throw new Error('每轮粉丝数和关注数须分别在 100–1000 人之间，并为 20 的倍数。');
    }
    return {
      enabled: Boolean(enabled.value),
      every: e,
      jitter: j,
      followerBatch: f,
      followingBatch: g,
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
    followerBatch,
    followingBatch,
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
