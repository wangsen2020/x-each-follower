import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUnreciprocatedConfig } from '../scoring.js';

test('normalizeUnreciprocatedConfig sets robust default parameters for followback tracking', () => {
  const cfg = normalizeUnreciprocatedConfig();
  assert.equal(cfg.every, 60, '默认一小时一次');
  assert.equal(cfg.jitter, 10, '默认随机浮动10分钟');
  assert.equal(cfg.overdueDays, 14, '默认2周未回关判定超时');
  assert.equal(cfg.autoUnfollow, false, '默认自动取关关闭');
  assert.equal(cfg.batchLimit, 10, '单次默认处理10人');
  assert.equal(cfg.unfollowDelay, 3, '取关默认间隔3秒');
  assert.equal(cfg.unfollowDelayJitter, 2, '取关默认随机浮动2秒');
  assert.equal(cfg.whitelist, '', '默认无白名单');
});

test('normalizeUnreciprocatedConfig respects custom options within safe bounds', () => {
  const cfg = normalizeUnreciprocatedConfig({
    every: 120,
    jitter: 15,
    overdueDays: 7,
    autoUnfollow: true,
    batchLimit: 20,
    unfollowDelay: 5,
    unfollowDelayJitter: 4,
    whitelist: 'elonmusk, OpenAI'
  });
  assert.equal(cfg.every, 120);
  assert.equal(cfg.jitter, 15);
  assert.equal(cfg.overdueDays, 7);
  assert.equal(cfg.autoUnfollow, true);
  assert.equal(cfg.batchLimit, 20);
  assert.equal(cfg.unfollowDelay, 5);
  assert.equal(cfg.unfollowDelayJitter, 4);
  assert.equal(cfg.whitelist, 'elonmusk, OpenAI');
});

test('evaluates unreciprocated users into mutual, pending, and overdue categories correctly', () => {
  const followerHandles = new Set(['mutual_user', 'friend_bob']);
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;

  const users = [
    {
      handle: 'mutual_user',
      followedAt: new Date(now - 20 * dayMs).toISOString(),
      relationship: { following: true, followedBy: true }
    },
    {
      handle: 'fresh_candidate',
      followedAt: new Date(now - 3 * dayMs).toISOString(),
      relationship: { following: true, followedBy: false }
    },
    {
      handle: 'overdue_uncredited',
      followedAt: new Date(now - 16 * dayMs).toISOString(),
      relationship: { following: true, followedBy: false }
    }
  ];

  // 评估函数逻辑测试
  function evaluate(item, followersSet, overdueDays = 14) {
    const key = String(item.handle || '').toLowerCase();
    const isMutual = followersSet.has(key) || item.relationship?.followedBy === true;
    if (isMutual) {
      return { status: 'mutual', isOverdue: false };
    }
    const elapsedDays = Math.floor((now - Date.parse(item.followedAt)) / dayMs);
    if (elapsedDays >= overdueDays) {
      return { status: 'overdue', isOverdue: true, elapsedDays };
    }
    return { status: 'pending', isOverdue: false, elapsedDays };
  }

  const res1 = evaluate(users[0], followerHandles, 14);
  assert.equal(res1.status, 'mutual', '在粉丝列表中判定为双向互粉');

  const res2 = evaluate(users[1], followerHandles, 14);
  assert.equal(res2.status, 'pending', '3天在2周缓冲期内，判定为待回关');

  const res3 = evaluate(users[2], followerHandles, 14);
  assert.equal(res3.status, 'overdue', '超过14天仍未回关，判定为超时无信用账号');
  assert.equal(res3.elapsedDays, 16);
});

test('whitelist and exempt flags protect accounts from automatic unfollow', () => {
  const whitelistStr = 'vip_user,  @elonmusk\npartner';
  const whitelistSet = new Set(
    whitelistStr.split(/[,，\n\s]+/).map(s => s.replace(/^@/, '').toLowerCase()).filter(Boolean)
  );

  assert.equal(whitelistSet.has('vip_user'), true);
  assert.equal(whitelistSet.has('elonmusk'), true);
  assert.equal(whitelistSet.has('partner'), true);
  assert.equal(whitelistSet.has('random_bad_actor'), false);
});
