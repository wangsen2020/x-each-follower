import { ref, computed } from 'vue';

export function normalizeUnreciprocatedConfig(cfg = {}) {
  const defaults = {
    enabled: false,
    every: 60,
    jitter: 10,
    overdueDays: 14,
    autoGreeting: false,
    greetingAfterDays: 1,
    greetingText: '你好！刚刚关注了你，期待互关交流！',
    greetingTextEn: 'Hi there! Just followed you, looking forward to connecting and following back!',
    autoUnfollow: false,
    autoUnfollowEvery: 45,
    autoUnfollowJitter: 15,
    batchLimit: 1,
    settingsSchemaVersion: 3,
    dailyLimit: 12,
    unfollowDelay: 15,
    unfollowDelayJitter: 5,
    activeTimeStart: '09:00',
    activeTimeEnd: '21:00',
    whitelist: '',
    lastRunAt: null,
    lastSummary: '尚未执行回关监控'
  };
  const res = { ...defaults, ...(cfg || {}) };
  if (Number(cfg?.settingsSchemaVersion || 0) < 3) {
    if (cfg?.autoUnfollowEvery == null || Number(cfg.autoUnfollowEvery) === 30) res.autoUnfollowEvery = 45;
    if (cfg?.autoUnfollowJitter == null || Number(cfg.autoUnfollowJitter) === 5) res.autoUnfollowJitter = 15;
    if (cfg?.dailyLimit == null || Number(cfg.dailyLimit) === 400) res.dailyLimit = 12;
  }
  res.settingsSchemaVersion = 3;
  res.enabled = Boolean(res.enabled);
  res.every = Math.max(5, Math.min(1440, Number(res.every) || 60));
  res.jitter = Math.max(0, Math.min(60, Number.isFinite(Number(res.jitter)) ? Number(res.jitter) : 10));
  res.overdueDays = Math.max(1, Math.min(90, Number(res.overdueDays) || 14));
  res.autoGreeting = Boolean(res.autoGreeting);
  res.greetingAfterDays = Math.max(1, Math.min(30, Number(res.greetingAfterDays) || 1));
  res.greetingText = String(res.greetingText || defaults.greetingText).trim().slice(0, 1000);
  if (res.greetingText === '你好，刚关注了你，期待交流！') res.greetingText = defaults.greetingText;
  res.greetingTextEn = String(res.greetingTextEn || defaults.greetingTextEn).trim().slice(0, 1000);
  res.autoUnfollow = Boolean(res.autoUnfollow);
  res.autoUnfollowEvery = Math.max(30, Math.min(1440, Number(res.autoUnfollowEvery) || 45));
  res.autoUnfollowJitter = Math.max(0, Math.min(15, Number.isFinite(Number(res.autoUnfollowJitter)) ? Number(res.autoUnfollowJitter) : 15));
  res.batchLimit = 1;
  res.dailyLimit = Math.max(1, Math.min(12, Math.floor(Number(res.dailyLimit)) || 12));
  res.unfollowDelay = Math.max(3, Math.min(300, Number(res.unfollowDelay) || 15));
  res.unfollowDelayJitter = Math.max(0, Math.min(60, Number.isFinite(Number(res.unfollowDelayJitter)) ? Number(res.unfollowDelayJitter) : 5));
  res.activeTimeStart = typeof res.activeTimeStart === 'string' && res.activeTimeStart ? res.activeTimeStart : '09:00';
  res.activeTimeEnd = typeof res.activeTimeEnd === 'string' && res.activeTimeEnd ? res.activeTimeEnd : '21:00';
  res.whitelist = String(res.whitelist || '').trim();
  res.lastSummary = String(res.lastSummary || '尚未执行回关监控').replace('回关监测', '回关监控');
  return res;
}

/**
 * Composable for managing 回关监控 · 定时检测与自动取关设置抽屉
 */
export function useUnreciprocatedSettings() {
  const isOpen = ref(false);
  const enabled = ref(false);
  const every = ref(60);
  const jitter = ref(10);
  const overdueDays = ref(14);
  const autoGreeting = ref(false);
  const greetingAfterDays = ref(1);
  const greetingText = ref('你好！刚刚关注了你，期待互关交流！');
  const greetingTextEn = ref('Hi there! Just followed you, looking forward to connecting and following back!');
  const autoUnfollow = ref(false);
  const autoUnfollowEvery = ref(45);
  const autoUnfollowJitter = ref(15);
  const batchLimit = ref(1);
  const dailyLimit = ref(12);
  const unfollowDelay = ref(15);
  const unfollowDelayJitter = ref(5);
  const activeTimeStart = ref('09:00');
  const activeTimeEnd = ref('21:00');
  const whitelist = ref('');
  const lastSummary = ref('尚未执行回关监控');
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
    autoGreeting.value = norm.autoGreeting;
    greetingAfterDays.value = norm.greetingAfterDays;
    greetingText.value = norm.greetingText;
    greetingTextEn.value = norm.greetingTextEn;
    autoUnfollow.value = norm.autoUnfollow;
    autoUnfollowEvery.value = norm.autoUnfollowEvery;
    autoUnfollowJitter.value = norm.autoUnfollowJitter;
    batchLimit.value = norm.batchLimit;
    dailyLimit.value = norm.dailyLimit;
    unfollowDelay.value = norm.unfollowDelay;
    unfollowDelayJitter.value = norm.unfollowDelayJitter;
    activeTimeStart.value = norm.activeTimeStart;
    activeTimeEnd.value = norm.activeTimeEnd;
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
      autoGreeting: Boolean(autoGreeting.value),
      greetingAfterDays: Number(greetingAfterDays.value),
      greetingText: String(greetingText.value || '').trim(),
      greetingTextEn: String(greetingTextEn.value || '').trim(),
      autoUnfollow: Boolean(autoUnfollow.value),
      autoUnfollowEvery: Number(autoUnfollowEvery.value),
      autoUnfollowJitter: Number(autoUnfollowJitter.value),
      settingsSchemaVersion: 3,
      batchLimit: Number(batchLimit.value),
      dailyLimit: Number(dailyLimit.value),
      unfollowDelay: Number(unfollowDelay.value),
      unfollowDelayJitter: Number(unfollowDelayJitter.value),
      activeTimeStart: String(activeTimeStart.value || '09:00').trim(),
      activeTimeEnd: String(activeTimeEnd.value || '21:00').trim(),
      whitelist: String(whitelist.value || '').trim(),
      lastRunAt: lastRunAt.value || null,
      lastSummary: lastSummary.value || '尚未执行回关监控'
    });
  }

  async function save() {
    if(saving.value)return false;
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
        successMessage.value = '比对已完成';
        setTimeout(() => {
          if (successMessage.value === '比对已完成') successMessage.value = '';
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
    autoGreeting,
    greetingAfterDays,
    greetingText,
    greetingTextEn,
    autoUnfollow,
    autoUnfollowEvery,
    autoUnfollowJitter,
    batchLimit,
    dailyLimit,
    unfollowDelay,
    unfollowDelayJitter,
    activeTimeStart,
    activeTimeEnd,
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
