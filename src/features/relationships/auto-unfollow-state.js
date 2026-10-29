export const PENDING_RECHECK_INTERVAL_MS = 10 * 60000;
export const pendingHandle = user => String(user?.handle || '').replace(/^@/, '').toLowerCase();
export const samePendingTarget = (entry, user) => Boolean(
  (entry?.user?.id && user?.id && String(entry.user.id) === String(user.id)) ||
  (pendingHandle(entry?.user) && pendingHandle(entry.user) === pendingHandle(user))
);

export function pendingOperations(state = {}) {
  const items = [...(Array.isArray(state.pendingItems) ? state.pendingItems : []), ...(state.pending ? [state.pending] : [])];
  return items.filter((item, index) => !items.slice(0, index).some(previous => samePendingTarget(previous, item?.user)));
}

// Persist the original reservation before starting another target. Usage is never refunded here.
export function isolatePending(state, reason = '') {
  state.pendingItems = pendingOperations(state).map(item => ({...item,
    checks: Number(item.checks) || 0, reason: item.reason || reason || '上次操作结果待确认'}));
  state.pending = null;
  state.queue = (state.queue || []).filter(handle => !state.pendingItems.some(item => pendingHandle(item.user) === handle));
}

export function targetCheckFailure(error) {
  return ['AUTO_UNFOLLOW_TARGET_MISSING', 'AUTO_UNFOLLOW_TARGET_MISMATCH', 'X_PROFILE_UNAVAILABLE',
    'X_PROFILE_IDENTITY_UNRESOLVED', 'X_PROFILE_ACTION_UNAVAILABLE'].includes(error?.code);
}

export function pauseDescription(error) {
  if (error?.code === 'X_PAGE_ACTION_RESTRICTED') return {reason:'X 页面提示操作受限', resume:'等待页面限制解除后，下次计划重新核验'};
  if ([401, 403].includes(Number(error?.status))) return {reason:'登录或权限异常', resume:'恢复绑定账号的登录与权限后，下次计划重新核验'};
  if (/绑定账号|登录账号|登录 X|账号不一致/.test(error?.message || '')) return {reason:'绑定账号未就绪', resume:'保留绑定账号的已登录 X 页面，下次计划重新核验'};
  return {reason:error?.message || '执行异常', resume:'本轮已停止，下次计划重新核验；未确认操作不会重复提交'};
}
