import {randomizedInteger} from '../../shared/timing.js';

export const QUEUE_PLAN_KEY = 'followQueueSchedule';

// Chrome owns wake-ups; this small adapter preserves the chosen deadline when
// an alarm disappears, or a worker wakes before the queue has started logging.
export function createQueueAlarmPlan({api, name, now = Date.now, delay = randomizedInteger}) {
  let pending = Promise.resolve();
  const serialize = task => {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  };
  const read = async accountId => {
    const state = (await api.storage.local.get(QUEUE_PLAN_KEY))[QUEUE_PLAN_KEY];
    return state?.accountId === accountId ? state : {};
  };
  const write = state => api.storage.local.set({[QUEUE_PLAN_KEY]:state});
  function schedule(accountId, settings, {reset = false, reason = 'ensure'} = {}) {
    return serialize(async () => {
      const state = await read(accountId);
      const alarm = (await api.alarms.getAll()).find(alarm => alarm.name === name);
      if (!settings.enabled) {
        await api.alarms.clear(name);
        await write({...state, accountId, nextRunAt:null, changedAt:now(), reason:'disabled'});
        return;
      }
      // Routine settings saves, enqueueing and worker starts keep the deadline.
      const nextRunAt = !reset && (state.nextRunAt || alarm?.scheduledTime)
        || now() + delay(settings.every, settings.jitter, 1, 240) * 60000;
      await write({...state, accountId, nextRunAt, changedAt:now(), reason});
      if (reset || !alarm || alarm.scheduledTime !== nextRunAt) {
        await api.alarms.create(name, {when:nextRunAt});
      }
    });
  }
  function record(accountId, patch) {
    return serialize(async () => write({...await read(accountId), accountId, ...patch}));
  }
  return {schedule, record, read};
}
