export const LEADERBOARD_CONFIG_KEY = 'xefLeaderboardConfigByOwner';

export const DEFAULT_LEADERBOARD_CONFIG = Object.freeze({
  enabled: true,
  scanIntervalMinutes: 60,
  scanBatchSize: 3,
  autoAnalyze: true
});

export function normalizeLeaderboardConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const interval = Number(source.scanIntervalMinutes);
  const batchSize = Number(source.scanBatchSize);
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_LEADERBOARD_CONFIG.enabled,
    scanIntervalMinutes: Number.isInteger(interval) && interval >= 15 && interval <= 360 ? interval : DEFAULT_LEADERBOARD_CONFIG.scanIntervalMinutes,
    scanBatchSize: Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 5 ? batchSize : DEFAULT_LEADERBOARD_CONFIG.scanBatchSize,
    autoAnalyze: typeof source.autoAnalyze === 'boolean' ? source.autoAnalyze : DEFAULT_LEADERBOARD_CONFIG.autoAnalyze
  };
}

export function validateLeaderboardConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('榜单监控配置无效');
  if (typeof value.enabled !== 'boolean' || typeof value.autoAnalyze !== 'boolean') throw new Error('监控开关配置无效');
  if (!Number.isInteger(value.scanIntervalMinutes) || value.scanIntervalMinutes < 15 || value.scanIntervalMinutes > 360) throw new Error('扫描间隔需为 15–360 分钟的整数');
  if (!Number.isInteger(value.scanBatchSize) || value.scanBatchSize < 1 || value.scanBatchSize > 5) throw new Error('每轮人数需为 1–5 的整数');
  return {...value};
}
