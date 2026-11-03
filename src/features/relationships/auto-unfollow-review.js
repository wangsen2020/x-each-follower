// Business recovery state lives in the existing per-owner scheduler ledger.
// Browser alarms, worker restarts and fresh candidate scans share this budget.
export const DEFAULT_PROFILE_ATTEMPTS = 3;
export const profileAttemptLimit = config => Math.max(1, Math.min(10, Math.floor(Number(config?.autoUnfollowMaxAttempts) || DEFAULT_PROFILE_ATTEMPTS)));
export const reviewHandle = user => String(user?.handle || '').replace(/^@/, '').toLowerCase();
const reviewUser = user => ({id:String(user?.id||''),handle:user?.handle||'',name:user?.name||''});
export function sameReviewTarget(entry, user) {
  if (entry?.user?.id && user?.id) return String(entry.user.id) === String(user.id);
  return Boolean(reviewHandle(entry?.user) && reviewHandle(entry.user) === reviewHandle(user));
}
export const reviewEntry = (state, user) => (state.reviewItems || []).find(item => sameReviewTarget(item, user));
export const heldForReview = (state, user) => ['review', 'skipped'].includes(reviewEntry(state, user)?.status);
export const blockedProfileError = user => Object.assign(new Error('当前账号已屏蔽该用户'), {code:'X_PROFILE_BLOCKED', targetId:String(user?.id || ''), handle:user?.handle});
export const isBlockedProfile = error => ['X_PROFILE_BLOCKED', 'X_PROFILE_BLOCKED_BY'].includes(error?.code);

export function markForReview(state, user, error, now, {pending = false} = {}) {
  const entry = reviewEntry(state, user) || {user:reviewUser(user), attempts:0};
  Object.assign(entry, {user:reviewUser(user), status:'review', pending, reason:error?.message || '核验结果仍不明确', code:error?.code || '', updatedAt:now});
  state.reviewItems = [...(state.reviewItems || []).filter(item => !sameReviewTarget(item, user)), entry];
  state.queue = (state.queue || []).filter(handle => handle !== reviewHandle(user));
  return entry;
}

export function prepareReviewState(state, config, now) {
  state.reviewItems ||= [];
  const limit = profileAttemptLimit(config);
  for (const entry of state.reviewItems) {
    if (entry.status === 'retry' && entry.attempts >= limit) markForReview(state, entry.user, {message:entry.reason || '自动核验次数已用完', code:entry.code}, now);
  }
  for (const item of state.pendingItems || []) {
    if (item.checks >= limit && !heldForReview(state, item.user)) {
      const entry = markForReview(state, item.user, {message:item.reason || '操作结果仍待确认，自动核验次数已用完'}, now, {pending:true});
      entry.attempts = item.checks;
    }
  }
  state.queue = (state.queue || []).filter(handle => !state.reviewItems.some(item => ['review','skipped'].includes(item.status) && reviewHandle(item.user) === handle));
}

export function beginProfileAttempt(state, user, now) {
  const entry = reviewEntry(state, user) || {user:reviewUser(user), attempts:0};
  Object.assign(entry, {status:'retry', attempts:entry.attempts + 1, updatedAt:now});
  state.reviewItems = [...(state.reviewItems || []).filter(item => !sameReviewTarget(item, user)), entry];
  return entry;
}

export function finishProfileFailure(state, user, error, config, now) {
  const entry = reviewEntry(state, user);
  Object.assign(entry, {reason:error.message, code:error.code || '', updatedAt:now});
  if (isBlockedProfile(error) || error.code==='X_PROFILE_UNAVAILABLE' && ['suspended','not_found'].includes(error.availability) || entry.attempts >= profileAttemptLimit(config)) return markForReview(state, user, error, now);
  return entry;
}
