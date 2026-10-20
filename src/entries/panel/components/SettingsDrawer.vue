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
        <strong id="vueSettingsDrawerTitle">粉丝管理 · 定时检测与自动回关设置</strong>
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
            <span>定时检测周期（分钟）</span>
            <span class="info-tip" data-tip="每隔多少分钟自动检测自己的 following 和 follower，检查新增粉丝与回关状态。" aria-label="定时检测周期说明">?</span>
          </label>
          <input
            id="monitorEvery"
            v-model.number="settingsDrawerController.every.value"
            type="number"
            min="10"
            max="1440"
          />
          <small class="drawer-setting-desc">定期检测自身粉丝与关注列表的基础时间间隔（至少 10 分钟）。</small>
        </div>

        <!-- Jitter -->
        <div class="drawer-setting-group">
          <label for="monitorJitter" class="drawer-setting-label">
            <span>随机浮动间隔（±分钟）</span>
            <span class="info-tip" data-tip="在基础周期上随机浮动，避免固定时间触发。" aria-label="随机浮动间隔说明">?</span>
          </label>
          <input
            id="monitorJitter"
            v-model.number="settingsDrawerController.jitter.value"
            type="number"
            min="1"
            max="120"
          />
          <small class="drawer-setting-desc">每次浮动至少 1 分钟，按基础周期动态调度。</small>
        </div>

        <!-- Auto Enqueue -->
        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label">
            <input
              id="monitorAutoEnqueue"
              v-model="settingsDrawerController.autoEnqueue.value"
              type="checkbox"
            />
            <span>自动将待回关用户拉取到关注队列</span>
            <span class="info-tip" data-tip="检测到关注自己但未回关且符合条件的用户时，自动推送到统一关注队列进行看帖和回关处理。" aria-label="自动入队说明">?</span>
          </label>
          <small class="drawer-setting-desc">开启后，符合条件的待回关粉丝将自动加入统一关注队列，无需手动重复添加。</small>
        </div>

        <!-- Filter Danger -->
        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label">
            <input
              id="monitorFilterDanger"
              v-model="settingsDrawerController.filterDanger.value"
              type="checkbox"
            />
            <span>自动过滤高风险账号</span>
            <span class="info-tip" data-tip="过滤博彩、擦边、欺诈等命中规则的危险粉丝，不自动加入待回关队列。" aria-label="过滤高风险账号说明">?</span>
          </label>
          <small class="drawer-setting-desc">排查命中关键词和危险信号的账号，确保回关安全性。</small>
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
            <span>开启后台定时检测与自动入队</span>
            <span class="info-tip" data-tip="开启后后台定时唤醒检测粉丝变动，自动同步并拉取待回关用户。" aria-label="开启定时检测说明">?</span>
          </label>
          <small class="drawer-setting-desc">关闭时仅支持手动点击“↻”进行同步。</small>
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
          {{ settingsDrawerController.running.value ? '检测中…' : '立即检测并拉取入队' }}
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
