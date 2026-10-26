// This is source eligibility, not proof of the current X relationship.
// The follow executor must confirm followedBy=true and following=false again.
export function isPendingFanFollowBack(user) {
  return user?.relationship?.followedBy === true && user.relationship?.following === false;
}

// Only current network evidence authorizes execution; local evidence only orders jobs.
export function queueRelationshipDecision(job, relationship = {}) {
  const following = typeof relationship.following === 'boolean' ? relationship.following : null;
  const followedBy = typeof relationship.followedBy === 'boolean' ? relationship.followedBy : null;
  const fanSource = job.sources?.some(source => source.module === 'fans' && source.enabled === true) === true;
  const evidence = {following, followedBy, fanSource};
  if (following === true) return {...evidence, code:'already-following', reason:'已关注，无需重复关注'};
  if (following === null || followedBy === null) return {...evidence, code:'relationship-unknown',
    reason:`关系待核实：${following === null ? '是否已关注对方' : '对方是否关注我'}未明确，未发送关注请求`};
  if (fanSource && followedBy) return {...evidence, code:'follow-back', reason:'确认待回关，跳过比例和互粉意向筛选'};
  return {...evidence, code:'ordinary', reason:fanSource ? '对方当前未关注我，不满足待回关条件，按普通候选筛选' : '普通来源，按普通候选筛选'};
}

export function shouldEnqueueFan(user, config = {}) {
  return config.autoEnqueue !== false && user?.status === 'pending'
    && (config.filterDanger === false || user.risk?.level !== 'danger')
    && user.state !== 'following' && user.relationship?.following !== true;
}
