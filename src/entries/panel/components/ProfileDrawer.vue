<template>
  <div>
    <!-- Mask -->
    <div
      v-if="profileDrawerController.isOpen.value"
      id="vueProfileDrawerMask"
      class="profile-drawer-mask"
      @click="profileDrawerController.close()"
    ></div>

    <!-- Drawer dialog -->
    <aside
      id="profileDrawer"
      class="profile-drawer"
      role="dialog"
      aria-modal="true"
      :inert="!profileDrawerController.isOpen.value"
      :aria-hidden="!profileDrawerController.isOpen.value"
      :hidden="!profileDrawerController.isOpen.value"
      aria-labelledby="profileDrawerTitle"
    >
      <div class="profile-drawer-head">
        <strong id="profileDrawerTitle">@{{ profileDrawerController.handle.value }}</strong>
        <PanelCloseButton
          id="closeProfileDrawer"
          @click="profileDrawerController.close()"
        />
      </div>

      <div id="profileDrawerContent" class="profile-drawer-content">
        <!-- Identity -->
        <div class="drawer-identity">
          <div class="drawer-avatar">
            <img
              v-if="profileDrawerController.avatarUrl.value"
              :src="profileDrawerController.avatarUrl.value"
              alt=""
            />
            <template v-else>{{ profileDrawerController.avatarInitial.value }}</template>
          </div>
          <div>
            <strong style="display:inline-flex; align-items:center;">
              {{ profileDrawerController.name.value }}
              <svg
                v-if="profileDrawerController.verified.value"
                viewBox="0 0 22 22"
                aria-label="蓝V认证"
                title="已认证的 Twitter/X 蓝V账号"
                class="x-verified-badge"
                style="width:16px;height:16px;min-width:16px;margin:0 3px;vertical-align:-2px;display:inline-block;fill:#1d9bf0;flex-shrink:0;"
              >
                <g><path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.434-1.246.296-.59.4-1.256.302-1.91-.097-.654-.39-1.26-.838-1.742-.442-.482-1.018-.813-1.66-1.002-.643-.19-1.32-.152-1.92.112-.395-.515-.926-.89-1.536-1.085C12.16 2.116 11.5 2.14 10.884 2.38c-.598.232-1.11.63-1.48 1.15-.37.52-.57 1.14-.57 1.78-.607.03-1.196.22-1.7.55-.504.33-.913.78-1.18 1.3-.578.18-1.076.54-1.435 1.03-.36.49-.55 1.08-.55 1.69 0 .61.19 1.2.55 1.69.36.49.86.85 1.44 1.03.27.52.68.97 1.18 1.3.14.33 1.09.52 1.7.55 0 .64.2 1.26.57 1.78.37.52.88.92 1.48 1.15.62.24 1.28.26 1.89.07.61-.19 1.14-.57 1.54-1.08.6.26 1.28.3 1.92.11.64-.19 1.22-.52 1.66-1 .45-.48.74-1.09.84-1.74.1-.65-.01-1.32-.3-1.91.58-.27 1.08-.71 1.43-1.25.36-.54.55-1.17.57-1.82zM8.9 15.65l-3.3-3.3 1.41-1.41 1.89 1.89 5.89-5.89 1.41 1.41-7.3 7.3z"/></g>
              </svg>
            </strong>
            <small>@{{ profileDrawerController.handle.value }}</small>
          </div>
        </div>

        <!-- Facts -->
        <div class="drawer-facts">
          <div class="drawer-field">
            <span>粉丝</span>
            <strong>{{ profileDrawerController.user.value?.followersText || '未读取' }}</strong>
          </div>
          <div class="drawer-field">
            <span>关注</span>
            <strong>{{ profileDrawerController.user.value?.followingText || '未读取' }}</strong>
          </div>
          <div class="drawer-field">
            <span>互粉标签</span>
            <strong>{{ profileDrawerController.evalResult.value.tag }}{{ profileDrawerController.tagSourceSuffix.value }}</strong>
          </div>
          <div class="drawer-field">
            <span>推荐评估</span>
            <strong>{{ profileDrawerController.evalResult.value.recommendLabel }}</strong>
          </div>
        </div>

        <!-- Multi-tag badges -->
        <section v-if="profileDrawerController.multiTags.value.length" class="drawer-section">
          <h3>多维画像标签</h3>
          <div class="col-tag-cell" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">
            <span
              v-for="tag in profileDrawerController.multiTags.value"
              :key="tag.id"
              :class="['tag-badge', tag.colorClass]"
              :title="tag.desc"
              :data-tip="tag.desc"
            >{{ tag.label }}</span>
          </div>
        </section>

        <!-- Bio -->
        <section class="drawer-section">
          <h3>简介</h3>
          <p>{{ profileDrawerController.bio.value }}</p>
        </section>

        <!-- Mutual Intent & Recommendation -->
        <section :class="['drawer-section', 'drawer-risk', { 'is-danger': profileDrawerController.evalResult.value.isNotRecommended }]">
          <h3>互粉意向与推荐评估</h3>
          <p style="white-space: pre-line;">{{ profileDrawerController.mutualReasonLines.value.join('\n') }}</p>
        </section>

        <!-- Content Risk -->
        <section :class="['drawer-section', 'drawer-risk', { 'is-danger': profileDrawerController.risk.value.level === 'danger' }]">
          <h3>{{ profileDrawerController.risk.value.level === 'danger' ? '风险标记' : '内容风险检查' }}</h3>
          <p>{{ profileDrawerController.risk.value.level === 'danger' ? profileDrawerController.risk.value.hits.join('；') : '未命中本地内容危险信号' }}</p>
        </section>

        <!-- Recent Posts -->
        <section class="drawer-section">
          <h3>{{ profileDrawerController.recentPostsTitle.value }}</h3>
          <p v-if="!profileDrawerController.recentPosts.value.length">
            {{ profileDrawerController.loading.value ? '正在读取公开资料…' : '尚未采集，点击“采集资料”读取最近帖子。' }}
          </p>
          <ol v-else>
            <li v-for="(post, index) in profileDrawerController.recentPosts.value" :key="index">
              <span>{{ post.text || '无文字内容' }}</span>
              <template v-if="post.url">
                · <a :href="post.url" target="_blank" rel="noopener noreferrer">打开帖子</a>
              </template>
            </li>
          </ol>
        </section>

        <!-- Grok Comment Draft -->
        <section v-if="profileDrawerController.grokComment.value" class="drawer-section">
          <h3>🤖 Grok 引用评价（草稿）</h3>
          <div class="log-grok-box" style="margin: 6px 0 0;">
            <div class="log-grok-header">
              <span class="log-grok-tag">引用评价</span>
              <a
                v-if="profileDrawerController.grokCommentPostUrl.value"
                class="log-grok-post-link"
                :href="profileDrawerController.grokCommentPostUrl.value"
                target="_blank"
                rel="noopener noreferrer"
              >原推 ↗</a>
              <button
                type="button"
                class="log-copy-btn"
                @click="profileDrawerController.copyGrokComment()"
              >
                {{ profileDrawerController.copyStatus.value === 'copied' ? '已复制！' : profileDrawerController.copyStatus.value === 'failed' ? '复制失败' : '复制评价' }}
              </button>
            </div>
            <div
              v-if="profileDrawerController.grokCommentPost.value"
              style="font-size:11px;color:var(--text-subtle);margin-bottom:4px;padding-left:6px;border-left:2px solid var(--border-soft);max-height:38px;overflow:hidden;text-overflow:ellipsis;"
            >针对推文：{{ profileDrawerController.grokCommentPost.value }}</div>
            <div class="log-grok-body">{{ profileDrawerController.grokComment.value }}</div>
          </div>
        </section>
      </div>

      <!-- Actions -->
      <div class="profile-drawer-actions">
        <button
          id="drawerRefreshProfile"
          type="button"
          class="secondary"
          :disabled="profileDrawerController.loading.value"
          @click="profileDrawerController.triggerRefresh()"
        >
          {{ profileDrawerController.loading.value ? '采集中…' : '采集资料' }}
        </button>
        <button
          id="drawerOpenX"
          type="button"
          @click="profileDrawerController.openOnX()"
        >在 X 打开</button>
      </div>
    </aside>
  </div>
</template>

<script setup>
import {useDrawerFocus} from '../composables/useDrawerFocus.js';
import { onMounted, onUnmounted } from 'vue';
import PanelCloseButton from './PanelCloseButton.vue';
import { profileDrawerController } from '../composables/useProfileDrawer.js';

function onKeyDown(event) {
  if (event.key === 'Escape' && profileDrawerController.isOpen.value) {
    profileDrawerController.close();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
});
useDrawerFocus(profileDrawerController.isOpen, 'profileDrawer', '');
</script>
