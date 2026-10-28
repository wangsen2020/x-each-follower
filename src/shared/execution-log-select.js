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

export function matchesFollowbackLogKind(log, kind) {
  if (kind === 'unfollow') return isUnfollowLog(log);
  const greeting = !isUnfollowLog(log) && (/^greeting(?:-|$)/.test(log?.source || '') || log?.origin === 'autoGreeting');
  if (kind === 'greeting') return greeting;
  const handling = isUnfollowLog(log) || greeting;
  return kind === 'timeout-handling' ? handling : kind === 'timeout-monitoring' ? !handling : false;
}

// Older running backgrounds do not understand kind; read their existing pages before filtering.
export async function queryUnfollowLogs(send, request) {
  const result = await send(request);
  if (!result?.ok || result.kind === request.kind && result.presentationVersion === 2) return result;
  const matches = [];
  let cursor = null;
  do {
    const page = await send({...request, kind: undefined, limit: 50, cursor});
    if (!page?.ok) return page;
    matches.push(...(page.entries || []).filter(log => matchesFollowbackLogKind(log, request.kind)));
    cursor = page.nextCursor;
  } while (cursor);
  const visible = collapseUnfollowSummaries(matches);
  const bound = request.cursor;
  const remaining = visible.filter(e => !bound || e.at < bound.at || (e.at === bound.at && e.id < bound.id));
  const entries = remaining.slice(0, request.limit), last = entries.at(-1);
  return {ok:true,kind:request.kind,entries,total:visible.length,nextCursor:remaining.length > entries.length && last ? {at:last.at,id:last.id} : null};
}

export function collapseUnfollowSummaries(entries) {
  const round = e => e.runId || e.details?.['轮次编号'];
  const idle = e => e.source==='unfollow-auto' && ['success','waiting'].includes(e.result) && e.details?.['阶段']==='本轮结束' && e.details['符合超时条件人数']===0 && e.details['成功人数']===0 && e.details['处理次数']===0 && !(e.details['清理不存在账号数']>0) && !(e.unfollowedHandles?.length);
  const idleRounds=new Set(entries.filter(idle).map(round).filter(Boolean));
  entries=entries.filter(e=>!idle(e) && !(e.source==='unfollow-auto' && e.result==='started' && idleRounds.has(round(e))));
  const detailed = new Set(entries.filter(e => isUnfollowLog(e) && e.result === 'success' && e.handle && e.details?.['阶段'] !== '本轮结束' && round(e)).map(round));
  return entries.filter(e => !(isUnfollowLog(e) && e.result === 'success' && e.details?.['阶段'] === '本轮结束' && detailed.has(round(e))));
}
