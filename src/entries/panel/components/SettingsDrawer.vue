<template>
  <div>
    <!-- Mask -->
    <div
      v-if="settingsDrawerController.isOpen.value"
      class="profile-drawer-mask settings-drawer-mask"
      @click="settingsDrawerController.close()"
    ></div>

    <!-- Drawer -->
    <aside
      id="vueSettingsDrawer"
      class="profile-drawer"
      role="dialog"
      aria-modal="true"
      :aria-hidden="!settingsDrawerController.isOpen.value"
      :hidden="!settingsDrawerController.isOpen.value"
      aria-labelledby="vueSettingsDrawerTitle"
    >
      <div class="profile-drawer-head">
        <strong id="vueSettingsDrawerTitle">粉丝管理设置</strong>
        <div class="drawer-head-actions">
          <button
            id="openMonitorDrawerLogs"
            class="icon-button secondary log-icon-btn"
            type="button"
            title="查看执行日志"
            aria-label="查看执行日志"
            @click="settingsDrawerController.openLogs()"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
          </button>
          <button
            id="closeSettingsDrawer"
            class="icon-button secondary"
            type="button"
            title="关闭"
            aria-label="关闭"
            @click="settingsDrawerController.close()"
          >×</button>
        </div>
      </div>

      <div class="profile-drawer-content settings-drawer-content">
        <!-- Error & Success alerts -->
        <div v-if="settingsDrawerController.errorMessage.value" class="drawer-alert is-error" style="color:#d93025; background:#fce8e6; padding:8px 12px; border-radius:6px; margin-bottom:12px; font-size:12px;">
          {{ settingsDrawerController.errorMessage.value }}
        </div>
        <div v-if="settingsDrawerController.successMessage.value" class="drawer-alert is-success" style="color:#188038; background:#e6f4ea; padding:8px 12px; border-radius:6px; margin-bottom:12px; font-size:12px;">
          {{ settingsDrawerController.successMessage.value }}
        </div>

        <!-- Interval -->
        <div class="drawer-setting-group">
          <label for="monitorEvery" class="drawer-setting-label">
            <span>检测间隔（分）</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="每隔多少分钟自动检测自己的 following 和 follower，检查新增粉丝与回关状态。 默认每 10 分钟检测一轮。" aria-label="每隔多少分钟自动检测自己的 following 和 follower，检查新增粉丝与回关状态。 默认每 10 分钟检测一轮。">?</span>
          </label>
          <input
            id="monitorEvery"
            v-model.number="settingsDrawerController.every.value"
            type="number"
            min="10"
            max="1440"
          />

        </div>

        <!-- Jitter -->
        <div class="drawer-setting-group">
          <label for="monitorJitter" class="drawer-setting-label">
            <span>随机浮动（±分）</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="在基础周期上随机浮动，避免固定时间触发。 设为 0 时固定每 10 分钟检测。" aria-label="在基础周期上随机浮动，避免固定时间触发。 设为 0 时固定每 10 分钟检测。">?</span>
          </label>
          <input
            id="monitorJitter"
            v-model.number="settingsDrawerController.jitter.value"
            type="number"
            min="0"
            max="120"
          />

        </div>

        <div class="drawer-setting-group">
          <label for="monitorFollowerBatch" class="drawer-setting-label">每轮粉丝数 <span class="info-tip" tabindex="0" role="note" data-tip="最多 1,000 人；读到上限后，下轮接着读取。" aria-label="最多 1,000 人；读到上限后，下轮接着读取。">?</span></label>
          <input id="monitorFollowerBatch" v-model.number="settingsDrawerController.followerBatch.value" type="number" min="100" max="1000" step="20" />

        </div>

        <div class="drawer-setting-group">
          <label for="monitorFollowingBatch" class="drawer-setting-label">每轮关注数 <span class="info-tip" tabindex="0" role="note" data-tip="最多 1,000 人；独立保存续扫位置。" aria-label="最多 1,000 人；独立保存续扫位置。">?</span></label>
          <input id="monitorFollowingBatch" v-model.number="settingsDrawerController.followingBatch.value" type="number" min="100" max="1000" step="20" />

        </div>

        <!-- Auto Enqueue -->
        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label">
            <input
              id="monitorAutoEnqueue"
              v-model="settingsDrawerController.autoEnqueue.value"
              type="checkbox"
            />
            <span>待回关自动入队</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="检测到关注自己但未回关且符合条件的用户时，自动推送到统一关注队列进行看帖和回关处理。 开启后，符合条件的待回关粉丝将自动加入统一关注队列，无需手动重复添加。" aria-label="检测到关注自己但未回关且符合条件的用户时，自动推送到统一关注队列进行看帖和回关处理。 开启后，符合条件的待回关粉丝将自动加入统一关注队列，无需手动重复添加。">?</span>
          </label>

        </div>

        <!-- Filter Danger -->
        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label">
            <input
              id="monitorFilterDanger"
              v-model="settingsDrawerController.filterDanger.value"
              type="checkbox"
            />
            <span>过滤风险账号</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="过滤博彩、擦边、欺诈等命中规则的危险粉丝，不自动加入待回关队列。 排查命中关键词和危险信号的账号，确保回关安全性。" aria-label="过滤博彩、擦边、欺诈等命中规则的危险粉丝，不自动加入待回关队列。 排查命中关键词和危险信号的账号，确保回关安全性。">?</span>
          </label>

        </div>

        <!-- Checkpoint display -->
        <div class="drawer-setting-group">
          <label class="drawer-setting-label"><span>执行状态与记录</span></label>
          <div class="drawer-checkpoint-display">
            <span id="monitorCheckpointHandle" class="checkpoint-handle">{{ settingsDrawerController.checkpointDisplayText.value }}</span>
            <span id="monitorCheckpointTime" class="checkpoint-time">{{ settingsDrawerController.checkpointTimeText.value }}</span>
          </div>
          <small id="monitorLastSummaryDisplay" class="drawer-setting-desc" style="margin-top:6px;display:block;">
            {{ settingsDrawerController.lastSummary.value }}
          </small>
        </div>

        <!-- Enable background alarm -->
        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label">
            <input
              id="monitorEnabled"
              v-model="settingsDrawerController.enabled.value"
              type="checkbox"
            />
            <span>后台定时检测</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="开启后后台定时唤醒检测粉丝变动，自动同步并拉取待回关用户。 关闭时仅支持手动点击“↻”进行同步。" aria-label="开启后后台定时唤醒检测粉丝变动，自动同步并拉取待回关用户。 关闭时仅支持手动点击“↻”进行同步。">?</span>
          </label>

        </div>
      </div>

      <!-- Actions -->
      <div class="profile-drawer-actions">
        <button
          id="saveSettingsDrawer"
          type="button"
          :disabled="settingsDrawerController.saving.value"
          @click="settingsDrawerController.save()"
        >
          {{ settingsDrawerController.saving.value ? '保存中…' : '保存配置' }}
        </button>
        <button
          id="runMonitorScanNow"
          class="secondary"
          type="button"
          :disabled="settingsDrawerController.running.value"
          @click="settingsDrawerController.triggerRunNow()"
        >
          {{ settingsDrawerController.running.value ? '检测中…' : '检测并入队' }}
        </button>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { settingsDrawerController } from '../composables/useSettingsDrawer.js';

function onKeyDown(event) {
  if (event.key === 'Escape' && settingsDrawerController.isOpen.value) {
    settingsDrawerController.close();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
});
</script>
