import {postEngagementScore} from '../grok/grok-comment.js';

export function isPendingComment(row) {
  return row.tag==='mutual' && Boolean(row.taggedAt && row.tagBatchId) &&
    !row.decorationIssue && ['ready','generating','draft'].includes(row.status);
}

export function commentPriority(row) {
  const score=postEngagementScore(row);
  const boosted=isPendingComment(row) && row.following===false;
  // Only explicitly unfollowed, classified posts receive either bonus.
  return {weight:boosted ? 1000+(Number.isFinite(score)?score%1000:0) : 0,
    engagementScore:Number.isFinite(score)?score:null};
}

export function compareCommentPriority(a,b) {
  return commentPriority(b).weight-commentPriority(a).weight ||
    (a.lastAttemptAt||0)-(b.lastAttemptAt||0) || b.createdAt-a.createdAt ||
    String(a.postId).localeCompare(String(b.postId));
}

export function compareCommentList(a,b,order='desc') {
  const pendingA=isPendingComment(a),pendingB=isPendingComment(b);
  return Number(pendingB)-Number(pendingA) ||
    (pendingA ? (order==='asc' ? commentPriority(a).weight-commentPriority(b).weight : commentPriority(b).weight-commentPriority(a).weight) ||
      (a.lastAttemptAt||0)-(b.lastAttemptAt||0)||b.createdAt-a.createdAt||String(a.postId).localeCompare(String(b.postId)) : b.createdAt-a.createdAt);
}
