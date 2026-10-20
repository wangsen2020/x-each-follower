import test from 'node:test';
import assert from 'node:assert/strict';
import { useProfileDrawer, isUserVerified } from '../../src/entries/panel/composables/useProfileDrawer.js';

test('isUserVerified correctly identifies blue verified status', () => {
  assert.equal(isUserVerified(null), false);
  assert.equal(isUserVerified({}), false);
  assert.equal(isUserVerified({ is_blue_verified: true }), true);
  assert.equal(isUserVerified({ isBlueVerified: true }), true);
  assert.equal(isUserVerified({ verified: true }), true);
  assert.equal(isUserVerified({ name: 'Web3 Builder [蓝V]' }), true);
  assert.equal(isUserVerified(null, { is_blue_verified: true }), true);
  assert.equal(isUserVerified({ name: 'Ordinary Developer' }), false);
});

test('useProfileDrawer initializes with clean default state', () => {
  const drawer = useProfileDrawer();
  assert.equal(drawer.isOpen.value, false);
  assert.equal(drawer.user.value, null);
  assert.equal(drawer.loading.value, false);
  assert.equal(drawer.mode.value, 'profile');
  assert.equal(drawer.name.value, '');
  assert.equal(drawer.handle.value, '');
  assert.equal(drawer.verified.value, false);
  assert.equal(drawer.bio.value, '暂无简介');
  assert.equal(drawer.recentPosts.value.length, 0);
});

test('useProfileDrawer reactively computes user fields and evalResult upon open()', () => {
  const drawer = useProfileDrawer();

  const mockUser = {
    handle: 'vue_architect',
    name: 'Vue3 Master',
    bio: 'Building reactive extensions with Vue 3. 互粉 交流',
    followersText: '1.2K',
    followingText: '1.1K',
    is_blue_verified: true,
    posts: [
      { text: 'Excited about Vue 3 SFC in extensions! #互关', url: 'https://x.com/vue_architect/status/12345' }
    ],
    grokComment: 'Great post on frontend engineering!',
    grokCommentPost: 'Excited about Vue 3 SFC in extensions!',
    grokCommentPostUrl: 'https://x.com/vue_architect/status/12345'
  };

  drawer.open(mockUser, 'profile');
  assert.equal(drawer.isOpen.value, true);
  assert.equal(drawer.handle.value, 'vue_architect');
  assert.equal(drawer.name.value, 'Vue3 Master');
  assert.equal(drawer.verified.value, true);
  assert.equal(drawer.avatarInitial.value, 'V');
  assert.equal(drawer.bio.value, 'Building reactive extensions with Vue 3. 互粉 交流');
  assert.equal(drawer.recentPosts.value.length, 1);
  assert.equal(drawer.recentPostsTitle.value, '最近帖子（用于互粉关键词匹配）');
  assert.equal(drawer.grokComment.value, 'Great post on frontend engineering!');
  assert.equal(drawer.grokCommentPostUrl.value, 'https://x.com/vue_architect/status/12345');

  // Verify mutual recommendation evaluation
  assert.ok(drawer.evalResult.value);
  assert.ok(drawer.evalResult.value.recommendReason);
  assert.ok(drawer.mutualReasonLines.value.length > 0);

  // Switch to commentPosts mode
  drawer.open({ ...mockUser, recentPosts: [{ text: 'Comment post' }] }, 'commentPosts');
  assert.equal(drawer.mode.value, 'commentPosts');
  assert.equal(drawer.recentPostsTitle.value, '近期帖子历史（1/100）');
  assert.equal(drawer.recentPosts.value.length, 1);

  // Close
  drawer.close();
  assert.equal(drawer.isOpen.value, false);
});

test('useProfileDrawer updateUser reactively merges fresh data', () => {
  const drawer = useProfileDrawer();
  drawer.open({ handle: 'test_dev', name: 'Initial Name' });

  assert.equal(drawer.name.value, 'Initial Name');
  assert.equal(drawer.verified.value, false);

  drawer.updateUser({ name: 'Updated Name', is_blue_verified: true, followersText: '500' });
  assert.equal(drawer.name.value, 'Updated Name');
  assert.equal(drawer.verified.value, true);
  assert.equal(drawer.user.value.followersText, '500');
});
