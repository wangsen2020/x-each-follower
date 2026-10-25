import {parseCount} from '../relationships/scoring.js';

// Derive priority from authorized sources, including jobs created before this feature.
// A merged comment/mutual candidate becomes a follow-back candidate when fans adds it.
export function followerCountPriority(value) {
  const followers = typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : parseCount(String(value ?? ''));
  if (followers == null) return 10;
  if (followers < 500) return 20;
  if (followers < 1_000) return 35;
  if (followers < 2_000) return 50;
  if (followers < 3_000) return 60;
  if (followers < 4_000) return 50;
  if (followers < 5_000) return 45;
  if (followers < 6_000) return 40;
  if (followers < 7_000) return 35;
  if (followers < 8_000) return 30;
  if (followers < 10_000) return 25;
  if (followers < 20_000) return 15;
  if (followers < 30_000) return 8;
  return 3;
}

export function followQueuePriority(job) {
  if (job?.sources?.some(source => source.module === 'fans' && source.enabled === true)) {
    const evidence = job.followResult?.relationshipDecision;
    const confirmed = evidence ? evidence.code === 'follow-back' : job.followBackCandidate === true;
    return confirmed ? 200 : 100;
  }
  return followerCountPriority(job?.profile?.followersText);
}

export function compareFollowQueuePriority(a, b) {
  return followQueuePriority(b) - followQueuePriority(a)
    || a.createdAt - b.createdAt
    || String(a.id).localeCompare(String(b.id));
}
