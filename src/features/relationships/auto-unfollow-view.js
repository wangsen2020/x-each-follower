import {eligibleAutoUnfollow, inUnfollowWindow} from './auto-unfollow.js';
import {pendingOperations, samePendingTarget, pendingHandle} from './auto-unfollow-state.js';
import {heldForReview, sameReviewTarget, profileAttemptLimit} from './auto-unfollow-review.js';

export function autoUnfollowView(config = {}, ledger = {}, alarm = null, now = Date.now()) {
  const account = String(config.autoUnfollowAccount?.id || '');
  const state = ledger.accounts?.[account] || (String(ledger.account || '') === account ? ledger : {});
  const scheduler = state.scheduler || {};
  const active = scheduler.phase === 'running' && now - scheduler.updatedAt < 120000 ? state.pending : null;
  const protectedItems = pendingOperations(state);
  const review = (state.reviewItems||[]).filter(item=>item.status==='review');
  const skipped = (state.reviewItems||[]).filter(item=>item.status==='skipped');
  const pending = protectedItems.filter(item => !heldForReview(state,item.user) && (!active || !samePendingTarget(active,item.user)));
  const queue = [...new Set(state.queue || [])].filter(handle => !protectedItems.some(item => pendingHandle(item.user) === handle) && ![...review,...skipped].some(item=>pendingHandle(item.user)===handle));
  const date = new Date(now), day = `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
  const used = state.day === day ? Number(state.used) || 0 : 0;
  const nextAt = Number(alarm?.scheduledTime || alarm?.when) || null;
  let label = '等待执行', reason = queue.length ? '按队列顺序，每轮最多处理 1 个账号' : '下次计划重新筛选符合条件的账号';
  if (!config.autoUnfollow) {label='未开启';reason='在回关监控设置中开启自动取关';}
  else if (!account || !config.autoUnfollowAccount?.handle) {label='已暂停';reason='缺少绑定账号，请重新保存自动取关设置';}
  else if (used >= config.dailyLimit) {label='今日额度已用完';reason='次日进入执行时段后恢复；待确认操作也计入额度';}
  else if (!inUnfollowWindow(config, now)) {label='等待执行时段';reason=`执行时段 ${config.activeTimeStart}—${config.activeTimeEnd}，进入时段后继续`;}
  else if (scheduler.phase === 'paused') {label='已暂停';reason=`${scheduler.reason}；${scheduler.resume}`;}
  else if (scheduler.phase === 'running' && now - scheduler.updatedAt < 120000) {label=active?'正在处理':'正在检查';reason=active?`正在处理 @${active.user?.handle || '当前账号'}，完成后更新结果`:scheduler.reason || '正在核验账号和关系';}
  else if (!nextAt) {label='计划待恢复';reason='尚未取得下次计划；重新打开扩展后检查，仍未恢复请重新保存设置';}
  if(config.autoUnfollow && !queue.length && review.length && label==='等待执行'){label='待人工审核';reason='问题账号已停止自动核验，其他账号继续按计划处理';}
  return {label, reason, queue, pending, review, skipped, attemptLimit:profileAttemptLimit(config), active, used, limit:config.dailyLimit || 0, nextAt,
    nextText:nextAt ? new Date(nextAt).toLocaleString('zh-CN',{hour12:false}) : '暂无计划', state, config};
}

export function autoUnfollowRowView(user, view, now = Date.now()) {
  if(view.active && samePendingTarget(view.active,user))return {label:'正在处理',tip:'正在核验或提交当前操作，完成后自动更新；不会重复提交。'};
  const held=[...(view.review||[]),...(view.skipped||[])].find(item=>sameReviewTarget(item,user));
  if(held)return {label:held.status==='skipped'?'已跳过':'待人工审核',tip:held.status==='skipped'?'保留去重标记，不再自动调度；可在调度状态中重试。':`${held.reason}。已停止自动核验；可在调度状态中删除、跳过或重试。`};
  const pending = view.pending.find(item => samePendingTarget(item, user));
  if (pending) return {label:'待确认 · 已隔离', tip:`${pending.reason || '上次操作结果待确认'}。不影响其他账号；最多自动核验 ${view.attemptLimit} 次，耗尽后转人工审核；接口与主页确认符合条件后自动恢复排队。`};
  const index = view.queue.indexOf(pendingHandle(user));
  if (index >= 0) return {label:`排队第 ${index + 1} 位`, tip:`当前队列前面有 ${index} 个账号；${view.label}：${view.reason}。下次检查：${view.nextText}。顺序可能随实时核验变化，不代表预计完成时间。`};
  if (view.config.autoUnfollow && eligibleAutoUnfollow(user,view.config,now)) return {label:'待入队核验', tip:'符合本地条件，下次调度将核验并加入队列；已超时不代表已执行取关。'};
  return {label:'', tip:''};
}
