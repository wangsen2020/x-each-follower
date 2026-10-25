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
  const starting = type === 'job-start' || type === 'run-start';
  // A start event describes a new attempt; it must never inherit old scan/failure data.
  if (starting) audit = {};
  else if (audit.diagnostic && event.runId && audit.diagnostic.runId !== event.runId) {
    audit = {...audit}; delete audit.diagnostic;
  }
  const evaluations = starting ? [] : event.evaluations || job.evaluations || [];
  const labels = {'job-start':'开始访问主页并读取账号资料','job-complete':'账号任务处理结束','run-start':'本轮任务开始','run-complete':'本轮任务结束','job-settle-failed':'任务结果保存失败','job-imported-hold-applied':'采用历史处理结果'};
  let result = type === 'job-start' || type === 'run-start' ? 'started' : type === 'run-complete' ? 'completed' : event.state || event.result || 'info';
  const follow = starting ? {} : event.followResult || job.followResult || {};
  if (result === 'followed' && (event.alreadyFollowing || follow.alreadyFollowing)) result = 'already_following';
  const succeeded = result === 'followed' || result === 'already_following';
  const successDetail = result === 'already_following' ? '主页确认原本已关注，未重复关注，本次未生成引用评价。' : '关注成功。';
  // Old successful entries may have copied their previous retry reason into detail.
  // Correct presentation without rewriting the original historical record.
  const explicitDetail = event.detail !== event.type && (!succeeded ||
    (event.detail !== follow.reason && event.detail !== follow.error)) ? event.detail : '';
  const decision = starting ? null : audit.relationshipDecision || event.relationshipDecision || follow.relationshipDecision;
  const relationshipLabel = value => value === true ? '是' : value === false ? '否' : '未知';
  const relationshipSummary = decision ? `${decision.reason}；对方关注我：${relationshipLabel(decision.followedBy)}，我关注对方：${relationshipLabel(decision.following)}${decision.screeningReason ? `；筛选：${decision.screeningReason}` : ''}` : '';
  let detail = (starting ? labels[type] : '') || event.summary || event.reason || explicitDetail || (succeeded ? successDetail : follow.error || follow.reason) || labels[type] || '队列状态更新';
  if (relationshipSummary && !detail.includes(relationshipSummary)) detail += ` ${relationshipSummary}`;
  return {...event, ...audit, scope:'queue',
    handle:event.handle || job.handle || '', name:audit.name || job.profile?.name || '',
    sources:event.sources || job.sources || [], evaluations, followResult:follow,
    result, source:event.manual === true ? 'manual' : event.manual === false ? 'scheduled' : event.source || 'unknown',
    detail,
    at:new Date(event.at || Date.now()).toISOString()};
}
