import {getDefaultExecutionLogStore} from './execution-log-store.js';
import {selectExecutionLogs} from './execution-log-select.js';

export {selectExecutionLogs};

let writeQueue = Promise.resolve();
// Extension pages send entries through the background appendExecutionLog command.
// This queue is the only storage writer, so panel and alarm writes cannot replace each other.
function verificationEpisodeKey(entry) {
  if (entry?.scope !== 'verification') return '';
  return entry.episodeKey || (entry.tabId != null && entry.at ? `${entry.tabId}:${entry.at}` : '');
}
function usesLegacyArrayStorage(storage) {
  // Injected test doubles keep the 300-row array writer. Production chrome.storage.local is indexed.
  if (storage && storage !== globalThis.chrome?.storage?.local) return true;
  return typeof indexedDB === 'undefined';
}
export function appendExecutionLog(entry, storage = chrome.storage.local) {
  if (!usesLegacyArrayStorage(storage)) return getDefaultExecutionLogStore().append(entry);
  const run = writeQueue.then(async () => {
    const {autoFollowLogs = []} = await storage.get('autoFollowLogs');
    const item = {...entry, id:entry.id || `log_${crypto.randomUUID()}`, at:entry.at || new Date().toISOString()};
    const episodeKey = verificationEpisodeKey(item);
    let next = autoFollowLogs;
    if (episodeKey) {
      const index = autoFollowLogs.findIndex(log => verificationEpisodeKey(log) === episodeKey);
      if (index >= 0) {
        const prior = autoFollowLogs[index];
        const updated = {...prior, ...item, id:prior.id, at:prior.at, episodeKey};
        next = autoFollowLogs.map((log, i) => i === index ? updated : log);
      } else next = [{...item, episodeKey}, ...autoFollowLogs];
    } else next = [item, ...autoFollowLogs];
    const logs = selectExecutionLogs(next).slice(0,300);
    await storage.set({autoFollowLogs:logs});
    return logs;
  });
  writeQueue = run.then(() => {}, () => {});
  return run;
}

export function normalizeQueueExecutionLog(event, job = {}, audit = {}) {
  const type = event.type;
  const evaluations = event.evaluations || job.evaluations || [];
  const labels = {'job-start':'开始访问主页并读取账号资料','job-complete':'账号任务处理结束','run-start':'本轮任务开始','run-complete':'本轮任务结束','job-settle-failed':'任务结果保存失败','job-imported-hold-applied':'采用历史处理结果'};
  let result = type === 'job-start' || type === 'run-start' ? 'started' : type === 'run-complete' ? 'completed' : event.state || event.result || 'info';
  const follow = event.followResult || job.followResult || {};
  if (result === 'followed' && (event.alreadyFollowing || follow.alreadyFollowing)) result = 'already_following';
  return {...event, ...audit, scope:'queue',
    handle:event.handle || job.handle || '', name:audit.name || job.profile?.name || '',
    sources:event.sources || job.sources || [], evaluations, followResult:follow,
    result, source:event.manual === true ? 'manual' : event.manual === false ? 'scheduled' : event.source || 'unknown',
    detail:event.summary || event.reason || (result === 'already_following' ? '主页确认原本已关注，未重复关注，本次未生成引用评价。' : '') || (event.detail !== event.type ? event.detail : '') || follow.error || follow.reason || labels[type] || '队列状态更新',
    at:new Date(event.at || Date.now()).toISOString()};
}
