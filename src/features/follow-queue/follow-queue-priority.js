// Derive priority from authorized sources, including jobs created before this feature.
// A merged comment/mutual candidate becomes a follow-back candidate when fans adds it.
export function followQueuePriority(job) {
  return job?.sources?.some(source => source.module === 'fans' && source.enabled === true) ? 100 : 10;
}

export function compareFollowQueuePriority(a, b) {
  return followQueuePriority(b) - followQueuePriority(a)
    || a.createdAt - b.createdAt
    || String(a.id).localeCompare(String(b.id));
}
