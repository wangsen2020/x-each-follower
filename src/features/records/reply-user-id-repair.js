// Repair only IDs proven to be a stored reply's Tweet ID. Snowflake shape/age
// alone cannot distinguish a Tweet ID from a User Rest ID.
export const REPLY_USER_ID_REPAIR_VERSION = 1;
const numericId = value => typeof value === 'string' && /^\d+$/.test(value) ? value : '';
const idFields = ['id', 'userId', 'targetUserId', 'rest_id', 'restId'];
const handleOf = row => String(row.handle || row.payload?.handle || '').replace(/^@/, '').toLowerCase();
export function repairOwner(row, legacyOwner = '') {
  const claims = [...new Set([row.accountId,row.payload?.ownerAccountId,row.payload?.accountId,row.payload?.fanReview?.ownerAccountId]
    .filter(id => id && id !== 'unassigned'))];
  if (claims.length > 1) return `conflict:${row.accountId}:${row.userKey}`;
  return claims[0] || legacyOwner || 'unassigned';
}
export function replyIdEvidence(row) {
  if (row.sourceKey !== 'commentTracking' || row.sourcePath?.[1] !== 'users') return [];
  const payload = row.payload || {};
  const replies = (payload.sources || []).flatMap(source => source.replies || []);
  const ids = new Set(replies.map(reply => numericId(reply.replyId)).filter(Boolean));
  return [...new Set([payload.id, ...(payload.userIdRepair?.previousIds || [])].filter(id => ids.has(id)))];
}

export function planReplyUserIdRepair(seed, rows, legacyOwner = '') {
  const owner = repairOwner(seed, legacyOwner), handle = handleOf(seed);
  const related = rows.filter(row => handleOf(row) === handle && repairOwner(row, legacyOwner) === owner);
  const badIds = new Set(related.flatMap(replyIdEvidence));
  if (!badIds.size) return null;
  const reliable = new Set();
  for (const row of related) {
    if (!['monitor', 'mutualNetwork', 'profileCache', 'commentTracking'].includes(row.sourceKey) || row.sourcePath?.[1] === 'posts') continue;
    for (const key of idFields) {
      // A comment record's generic id is precisely the legacy field at fault.
      if (row.sourceKey === 'commentTracking' && key === 'id') continue;
      const id = numericId(row.payload?.[key]);
      if (id && !badIds.has(id)) reliable.add(id);
    }
  }
  const replacementId = reliable.size === 1 ? [...reliable][0] : '';
  const changes = related.filter(row => !row.sourceKey.startsWith('derived:') && row.module !== 'logs' && row.module !== 'posts')
    .flatMap(row => {
      const patch = {};
      for (const key of idFields) if (badIds.has(row.payload?.[key])) patch[key] = replacementId;
      return Object.keys(patch).length ? [{row, patch}] : [];
    });
  return {owner, handle, previousIds:[...badIds], replacementId, changes};
}

// Keep review/skip choices and unknown external-action receipts intact. This
// migration corrects local references; it never schedules an X operation.
export function repairAutoUnfollowLedger(ledger, plans, at) {
  if (!ledger) return {ledger, changed:0};
  const result = structuredClone(ledger);
  let changed = 0;
  const accounts = result.accounts
    ? Object.fromEntries(Object.entries(result.accounts).map(([id,state]) => [id,structuredClone(state)]))
    : (result.account ? {[result.account]:result} : {});
  if (result.accounts) result.accounts = accounts;
  for (const [owner, state] of Object.entries(accounts)) {
    for (const entry of state.reviewItems || []) {
      if (entry.pending || state.pending && handleOf(state.pending.user || {}) === handleOf(entry.user || {})
        || (state.pendingItems || []).some(item => handleOf(item.user || {}) === handleOf(entry.user || {}))) continue;
      const plan = plans.find(item => item.owner === owner && item.handle === handleOf(entry.user || {}) && item.previousIds.includes(entry.user?.id));
      if (!plan) continue;
      const previousId = entry.user.id;
      entry.user.id = plan.replacementId;
      entry.userIdRepair = {version:REPLY_USER_ID_REPAIR_VERSION, previousId, replacementId:plan.replacementId, at};
      if (entry.code === 'AUTO_UNFOLLOW_TARGET_MISMATCH') {
        entry.code = 'LOCAL_USER_ID_REPAIRED';
        entry.reason = plan.replacementId ? '历史评论 ID 已纠正，可重试核验或删除本地记录' : '历史评论 ID 已清空，可重试获取用户资料或删除本地记录';
      }
      entry.updatedAt = at;
      changed++;
    }
  }
  return {ledger:result, changed};
}
