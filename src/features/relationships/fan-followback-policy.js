// This is source eligibility, not proof of the current X relationship.
// Once admitted, the executor only checks our own follow/request state.
export function isPendingFanFollowBack(user) {
  return user?.relationship?.followedBy === true && user.relationship?.following === false;
}

// The other account's follow state is informational, never an execution gate.
export function queueRelationshipDecision(job, relationship = {}) {
  const following = typeof relationship.following === 'boolean' ? relationship.following : null;
  const followedBy = typeof relationship.followedBy === 'boolean' ? relationship.followedBy : null;
  const fanSource = job.sources?.some(source => source.module === 'fans' && source.enabled === true) === true;
  const evidence = {following, followedBy, fanSource};
  if (relationship.followRequestSent === true) return {...evidence, code:'request-pending', reason:'关注请求已发送，等待对方确认，跳过重复关注'};
  if (following === true) return {...evidence, code:'already-following', reason:'已关注，无需重复关注'};
  if (following === null) return {...evidence, code:'relationship-unknown',
    reason:'关系待核实：是否已关注对方未明确，未发送关注请求'};
  if (fanSource) return {...evidence, code:followedBy === true ? 'follow-back' : 'fan-follow', reason:'粉丝渠道已入队，继续执行关注'};
  return {...evidence, code:'ordinary', reason:'普通来源，按普通候选筛选'};
}

export function shouldEnqueueFan(user, config = {}) {
  return config.autoEnqueue !== false && user?.status === 'pending'
    && (config.filterDanger === false || user.risk?.level !== 'danger')
    && user.state !== 'following' && user.relationship?.following !== true;
}
