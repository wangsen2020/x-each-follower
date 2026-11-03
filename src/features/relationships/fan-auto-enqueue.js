import {requestBackground, noMessageReceiver} from '../../platform/background-request.js';
import {reportSystemException} from '../../shared/system-exceptions.js';

export async function enqueuePendingFans(candidates, {enabled = true, request = requestBackground, report = reportSystemException} = {}) {
  if (!enabled) return {status: 'disabled', count: 0, handles: []};
  if (!candidates.length) return {status: 'empty', count: 0, handles: []};
  try {
    const result = await request({
      cmd: 'followQueueEnqueue',
      candidates: candidates.map(user => ({
        handle: user.handle,
        targetUserId: user.id || user.rest_id || '',
        module: 'fans',
        enabled: true,
        profile: {
          name: user.name || '',
          bio: user.bio || user.description || '',
          avatarUrl: user.avatarUrl || '',
          followersText: user.followersText ?? '',
          followingText: user.followingText ?? ''
        },
        ...(user.fanReview ? {fanReview: user.fanReview} : {}),
        ...(user.fanGrant ? {fanGrant: user.fanGrant} : {})
      }))
    });
    if (!result?.ok) {
      const reason = result?.error || '后台未确认入队';
      await report({source: 'panel', kind: 'fan-auto-enqueue', message: reason}).catch(() => {});
      return {status: result ? 'failed' : 'uncertain', count: 0, handles: [], reason};
    }
    const handles = Array.isArray(result.jobs) ? result.jobs.map(job => job.handle).filter(Boolean) : [];
    const count = Number.isInteger(result.count) && result.count >= 0 ? result.count : handles.length;
    return {status: 'confirmed', count, handles};
  } catch (error) {
    return {status: noMessageReceiver(error) ? 'failed' : 'uncertain', count: 0, handles: [], reason: String(error?.message || error)};
  }
}

export function fanEnqueueSummary(result) {
  if (result.status === 'disabled') return '；自动入队已关闭';
  if (result.status === 'empty') return '；暂无符合条件的待回关用户需入队';
  if (result.status === 'failed') return '；自动入队失败，请查看异常日志';
  if (result.status === 'uncertain') return '；入队结果待确认，请先核对关注队列';
  return result.count > 0 ? `；已确认 ${result.count} 位待回关用户在关注队列中` : '；本轮未加入关注队列';
}
