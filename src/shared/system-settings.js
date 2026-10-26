export const SYSTEM_DEFAULTS = Object.freeze({
  pagination: {fans:20, mutual:50, comments:20, unreciprocated:50, queue:20},
  logs: {pageSize:30, days:0},
  windows: {idleMinutes:8, lifetimeMinutes:15, checkMinutes:1}
});
export const systemSettingsKey = group => `systemSettings:${group}`;
export function validateSystemSettings(group, value = {}) {
  if (!SYSTEM_DEFAULTS[group]) throw new Error('未知设置分类');
  const result = {...SYSTEM_DEFAULTS[group], ...value};
  for (const key of Object.keys(SYSTEM_DEFAULTS[group])) {
    const n = result[key];
    const choices = group === 'pagination' ? [10,20,50,100] : group === 'logs' ? (key === 'days' ? [0,7,30,90] : [10,20,30,50]) : null;
    const min = key === 'lifetimeMinutes' ? 15 : 1;
    const max = key === 'checkMinutes' ? 30 : 120;
    if (!Number.isInteger(n) || (choices ? !choices.includes(n) : n < min || n > max)) throw new Error('请填写允许范围内的设置值');
  }
  return Object.fromEntries(Object.keys(SYSTEM_DEFAULTS[group]).map(key => [key,result[key]]));
}
export async function readSystemSettings(group, storage = globalThis.chrome?.storage?.local) {
  const saved = await storage?.get?.(systemSettingsKey(group));
  try { return validateSystemSettings(group, saved?.[systemSettingsKey(group)]); }
  catch { return {...SYSTEM_DEFAULTS[group]}; }
}
export async function saveSystemSettings(group, value, storage = globalThis.chrome?.storage?.local) {
  const settings = validateSystemSettings(group,value);
  if (!storage?.set) throw new Error('设置存储不可用');
  await storage.set({[systemSettingsKey(group)]:settings});
  return settings;
}
