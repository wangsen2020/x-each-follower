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
      :inert="!settingsDrawerController.isOpen.value"
      :aria-hidden="!settingsDrawerController.isOpen.value"
      :hidden="!settingsDrawerController.isOpen.value"
      aria-labelledby="vueSettingsDrawerTitle"
    >
      <div class="profile-drawer-head">
        <strong id="vueSettingsDrawerTitle">{{ t("粉丝跟进设置") }}</strong>
        <div class="drawer-head-actions">
          <button
            id="openMonitorDrawerLogs"
            class="icon-button secondary log-icon-btn"
            type="button"
            :title="t(&quot;查看执行日志&quot;)"
            :aria-label="t(&quot;查看执行日志&quot;)"
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
          <PanelCloseButton
            id="closeSettingsDrawer"
            @click="settingsDrawerController.close()"
          />
        </div>
      </div>

      <div class="profile-drawer-content settings-drawer-content">
        <!-- Interval -->
        <div class="drawer-setting-group">
          <label for="monitorEvery" class="drawer-setting-label">
            <span>{{ t("检测间隔（分）") }}</span>
            <span class="info-tip" tabindex="0" role="note" :data-tip="t(&quot;每隔多少分钟自动检测自己的 following 和 follower，检查新增粉丝与回关状态。 默认每 10 分钟检测一轮。&quot;)" :aria-label="t(&quot;每隔多少分钟自动检测自己的 following 和 follower，检查新增粉丝与回关状态。 默认每 10 分钟检测一轮。&quot;)">?</span>
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
            <span>{{ t("随机浮动（±分）") }}</span>
            <span class="info-tip" tabindex="0" role="note" :data-tip="t(&quot;在基础周期上随机浮动，避免固定时间触发。 设为 0 时固定每 10 分钟检测。&quot;)" :aria-label="t(&quot;在基础周期上随机浮动，避免固定时间触发。 设为 0 时固定每 10 分钟检测。&quot;)">?</span>
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
          <label for="monitorFollowerBatch" class="drawer-setting-label">{{ t("每轮粉丝数") }}<span class="info-tip" tabindex="0" role="note" :data-tip="t(&quot;最多 1,000 人；读到上限后，下轮接着读取。&quot;)" :aria-label="t(&quot;最多 1,000 人；读到上限后，下轮接着读取。&quot;)">?</span></label>
          <input id="monitorFollowerBatch" v-model.number="settingsDrawerController.followerBatch.value" type="number" min="100" max="1000" step="20" />

        </div>

        <div class="drawer-setting-group">
          <label for="monitorFollowingBatch" class="drawer-setting-label">{{ t("每轮关注数") }}<span class="info-tip" tabindex="0" role="note" :data-tip="t(&quot;最多 1,000 人；独立保存续扫位置。&quot;)" :aria-label="t(&quot;最多 1,000 人；独立保存续扫位置。&quot;)">?</span></label>
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
            <span>{{ t("待回关自动入队") }}</span>
            <span class="info-tip" tabindex="0" role="note" :data-tip="t(&quot;检测到关注自己但未回关且符合条件的用户时，自动推送到统一关注队列进行看帖和回关处理。 开启后，符合条件的待回关粉丝将自动加入统一关注队列，无需手动重复添加。&quot;)" :aria-label="t(&quot;检测到关注自己但未回关且符合条件的用户时，自动推送到统一关注队列进行看帖和回关处理。 开启后，符合条件的待回关粉丝将自动加入统一关注队列，无需手动重复添加。&quot;)">?</span>
          </label>

        </div>

        <div class="drawer-setting-group">
          <button id="openFanReviewSettings" type="button" class="secondary" @click="openFollowReviewSettings('fans')">{{ t("AI 打标与初审配置") }}</button>
          <FollowReviewConfigStatus v-if="settingsDrawerController.isOpen.value" :request="reviewRequest" :inspect="reviewInspect" :timeout-ms="timeoutMs" />
        </div>

        <!-- Checkpoint display -->
        <div class="drawer-setting-group">
          <label class="drawer-setting-label"><span>{{ t("执行状态与记录") }}</span></label>
          <div class="drawer-checkpoint-display">
            <span id="monitorCheckpointHandle" class="checkpoint-handle">{{ t(settingsDrawerController.checkpointDisplayText.value) }}</span>
            <span id="monitorCheckpointTime" class="checkpoint-time">{{ t(settingsDrawerController.checkpointTimeText.value) }}</span>
          </div>
          <small id="monitorLastSummaryDisplay" class="drawer-setting-desc" style="margin-top:6px;display:block;">
            {{ t(settingsDrawerController.lastSummary.value) }}
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
            <span>{{ t("后台定时检测") }}</span>
            <span class="info-tip" tabindex="0" role="note" :data-tip="t(&quot;开启后后台定时唤醒检测粉丝变动，自动同步并拉取待回关用户。 关闭时仅支持手动点击“↻”进行同步。&quot;)" :aria-label="t(&quot;开启后后台定时唤醒检测粉丝变动，自动同步并拉取待回关用户。 关闭时仅支持手动点击“↻”进行同步。&quot;)">?</span>
          </label>

        </div>
      </div>

      <!-- Actions -->
      <div v-if="settingsDrawerController.errorMessage.value || settingsDrawerController.successMessage.value" class="drawer-save-feedback" :class="settingsDrawerController.errorMessage.value?'is-error':'is-success'" :role="settingsDrawerController.errorMessage.value?'alert':'status'">
        {{ t(settingsDrawerController.errorMessage.value || settingsDrawerController.successMessage.value) }}
        <button v-if="settingsDrawerController.errorMessage.value.includes('状态待确认')" type="button" class="secondary" :disabled="settingsDrawerController.reloading.value" @click="settingsDrawerController.reload()">{{ t(settingsDrawerController.reloading.value?'正在读取设置…':'重新读取设置') }}</button>
      </div>
      <div class="profile-drawer-actions">
        <button
          id="saveSettingsDrawer"
          type="button"
          :disabled="settingsDrawerController.saving.value || settingsDrawerController.reloading.value"
          @click="settingsDrawerController.save()"
        >
          {{ settingsDrawerController.saving.value?t("保存中…"):settingsDrawerController.successMessage.value==='配置已保存'?t("已保存 ✓"):t("保存配置") }}
        </button>
        <button
          id="runMonitorScanNow"
          class="secondary"
          type="button"
          :disabled="settingsDrawerController.running.value"
          @click="settingsDrawerController.triggerRunNow()"
        >
          {{ settingsDrawerController.running.value?t("检测中…"):t("检测并入队") }}
        </button>
      </div>
    </aside>
  </div>
</template>

<script setup>
import {t} from '../../../shared/i18n.js';
import {openFollowReviewSettings} from '../follow-review-settings.js';

import {useDrawerFocus} from '../composables/useDrawerFocus.js';
import { onMounted, onUnmounted } from 'vue';
import PanelCloseButton from './PanelCloseButton.vue';
import FollowReviewConfigStatus from './FollowReviewConfigStatus.vue';
import { settingsDrawerController as defaultController } from '../composables/useSettingsDrawer.js';
const props=defineProps({controller:{type:Object,default:()=>defaultController},reviewRequest:Function,reviewInspect:Function,timeoutMs:{type:Number,default:8000}});
const settingsDrawerController=props.controller;

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
useDrawerFocus(settingsDrawerController.isOpen, 'vueSettingsDrawer', 'openSettingsDrawer');
</script>
<style scoped>
.drawer-save-feedback{flex-shrink:0;margin:0 16px 8px;padding:8px 12px;border-radius:6px;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.drawer-save-feedback button{margin-top:6px}.drawer-save-feedback.is-error{color:#b42318;background:#fff0ec}.drawer-save-feedback.is-success{color:#187349;background:#edf7ef}
</style>

