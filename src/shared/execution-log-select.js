const newestFirst = logs => logs.slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

export function selectExecutionLogs(logs = [], scope = 'autoFollow') {
  if (scope === 'queue') return newestFirst(logs.filter(log => log.scope === 'queue'));
  if (scope === 'queueFans') return newestFirst(logs.filter(log => log.scope === 'queue' && log.sources?.some(source => source.module === 'fans')));
  const verification = log => log.scope === 'verification';
  if (scope === 'fans' || scope === 'monitor') {
    return newestFirst(logs.filter(log =>
      verification(log) ||
      log.scope === 'fans' ||
      log.scope === 'monitor' ||
      log.origin === 'monitorLogs' ||
      (log.scope === 'queue' && log.sources?.some(source => source.module === 'fans'))
    ));
  }
  if (scope === 'unreciprocated') {
    return newestFirst(logs.filter(log => verification(log) || log.scope === 'unreciprocated' || log.origin === 'unreciprocatedLogs'));
  }
  return newestFirst(logs.filter(log => verification(log) || !['comment', 'mutual', 'unreciprocated'].includes(scope) || log.scope === scope || (log.scope === 'queue' && log.sources?.some(source => source.module === (scope === 'comment' ? 'comments' : scope)))));
}
