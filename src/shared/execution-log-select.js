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

export function isUnfollowLog(log) {
  return ['unfollow-auto', 'unfollow-manual', 'unfollow-batch'].includes(log?.source) || log?.origin === 'autoUnfollow' || Array.isArray(log?.unfollowedHandles);
}
export function unfollowLogHandles(log) {
  if (Array.isArray(log?.unfollowedHandles)) return [...new Set(log.unfollowedHandles.filter(Boolean))];
  if (isUnfollowLog(log) && log.result === 'success' && log.handle && log.details?.['提交状态'] === '已确认取关并回写本地') return [log.handle];
  return [];
}

// Older running backgrounds do not understand kind; read their existing pages before filtering.
export async function queryUnfollowLogs(send, request) {
  const result = await send(request);
  if (!result?.ok || result.kind === 'unfollow') return result;
  const matches = [];
  let cursor = null;
  do {
    const page = await send({...request, kind: undefined, limit: 50, cursor});
    if (!page?.ok) return page;
    matches.push(...(page.entries || []).filter(isUnfollowLog));
    cursor = page.nextCursor;
  } while (cursor);
  const bound = request.cursor;
  const remaining = matches.filter(e => !bound || e.at < bound.at || (e.at === bound.at && e.id < bound.id));
  const entries = remaining.slice(0, request.limit), last = entries.at(-1);
  return {ok:true,kind:'unfollow',entries,total:matches.length,nextCursor:remaining.length > entries.length && last ? {at:last.at,id:last.id} : null};
}
