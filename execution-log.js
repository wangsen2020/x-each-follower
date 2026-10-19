let writeQueue = Promise.resolve();
export function selectExecutionLogs(logs = [], scope = 'autoFollow') {
  if (scope === 'fans' || scope === 'monitor') {
    return logs.filter(log => log.scope === 'fans' || log.scope === 'monitor' || (log.scope === 'queue' && log.sources?.some(source => source.module === 'fans')))
      .slice().sort((a,b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  }
  return logs.filter(log => !['comment','mutual'].includes(scope) || log.scope === scope || (log.scope === 'queue' && log.sources?.some(source => source.module === (scope === 'comment' ? 'comments' : scope))))
    .slice().sort((a,b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}
// All writers call this in the service worker, so simultaneous panel and alarm
// writes are serialized instead of replacing storage with stale panel memory.
export function appendExecutionLog(entry, storage = chrome.storage.local) {
  const run = writeQueue.then(async () => {
    const {autoFollowLogs = []} = await storage.get('autoFollowLogs');
    const item = {...entry, id:entry.id || `log_${crypto.randomUUID()}`, at:entry.at || new Date().toISOString()};
    const logs = selectExecutionLogs([item, ...autoFollowLogs]).slice(0,300);
    await storage.set({autoFollowLogs:logs});
    return logs;
  });
  writeQueue = run.catch(() => {});
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
