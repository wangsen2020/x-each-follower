import { ref, computed } from 'vue';

export function normalizeUnreciprocatedConfig(cfg = {}) {
  const defaults = {
    enabled: false,
    every: 60,
    jitter: 10,
    overdueDays: 14,
    autoUnfollow: false,
    batchLimit: 10,
    unfollowDelay: 3,
    unfollowDelayJitter: 2,
    whitelist: '',
    lastRunAt: null,
    lastSummary: '尚未执行回关监测'
  };
  const res = { ...defaults, ...(cfg || {}) };
  res.every = Math.max(5, Math.min(1440, Number(res.every) || 60));
  res.jitter = Math.max(1, Math.min(60, Number(res.jitter) || 10));
  res.overdueDays = Math.max(1, Math.min(90, Number(res.overdueDays) || 14));
  res.autoUnfollow = Boolean(res.autoUnfollow);
  res.batchLimit = Math.max(1, Math.min(50, Number(res.batchLimit) || 10));
  res.unfollowDelay = Math.max(1, Math.min(30, Number(res.unfollowDelay) || 3));
  res.unfollowDelayJitter = Math.max(1, Math.min(15, Number(res.unfollowDelayJitter) || 2));
  res.whitelist = String(res.whitelist || '').trim();
  return res;
}

/**
 * Composable for managing 回关监测 · 定时检测与自动取关设置抽屉
 */
export function useUnreciprocatedSettings() {
  const isOpen = ref(false);
  const enabled = ref(false);
  const every = ref(60);
  const jitter = ref(10);
  const overdueDays = ref(14);
  const autoUnfollow = ref(false);
  const batchLimit = ref(10);
  const unfollowDelay = ref(3);
  const unfollowDelayJitter = ref(2);
  const whitelist = ref('');
  const lastSummary = ref('尚未执行回关监测');
  const lastRunAt = ref('');
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
    const norm = normalizeUnreciprocatedConfig(currentConfig);
    enabled.value = norm.enabled;
    every.value = norm.every;
    jitter.value = norm.jitter;
    overdueDays.value = norm.overdueDays;
    autoUnfollow.value = norm.autoUnfollow;
    batchLimit.value = norm.batchLimit;
    unfollowDelay.value = norm.unfollowDelay;
    unfollowDelayJitter.value = norm.unfollowDelayJitter;
    whitelist.value = norm.whitelist;
    lastSummary.value = norm.lastSummary;
    lastRunAt.value = norm.lastRunAt || '';
    isOpen.value = true;
  }

  function close() {
    isOpen.value = false;
    errorMessage.value = '';
    successMessage.value = '';
  }

  const lastRunText = computed(() => {
    if (lastRunAt.value) {
      return `最近执行：${new Date(lastRunAt.value).toLocaleString()}`;
    }
    return '';
  });

  function toConfig() {
    return normalizeUnreciprocatedConfig({
      enabled: Boolean(enabled.value),
      every: Number(every.value),
      jitter: Number(jitter.value),
      overdueDays: Number(overdueDays.value),
      autoUnfollow: Boolean(autoUnfollow.value),
      batchLimit: Number(batchLimit.value),
      unfollowDelay: Number(unfollowDelay.value),
      unfollowDelayJitter: Number(unfollowDelayJitter.value),
      whitelist: String(whitelist.value || '').trim(),
      lastRunAt: lastRunAt.value || null,
      lastSummary: lastSummary.value || '尚未执行回关监测'
    });
  }

  async function save() {
    errorMessage.value = '';
    successMessage.value = '';
    const cfg = toConfig();

    if (saveHandler) {
      saving.value = true;
      try {
        await saveHandler(cfg);
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

  return {
    isOpen,
    enabled,
    every,
    jitter,
    overdueDays,
    autoUnfollow,
    batchLimit,
    unfollowDelay,
    unfollowDelayJitter,
    whitelist,
    lastSummary,
    lastRunAt,
    lastRunText,
    saving,
    running,
    errorMessage,
    successMessage,
    open,
    close,
    toConfig,
    save,
    triggerRunNow,
    setSaveHandler,
    setRunHandler
  };
}

export const unreciprocatedSettingsController = useUnreciprocatedSettings();
