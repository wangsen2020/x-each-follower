<template>
  <div>
    <!-- Mask -->
    <div
      v-if="unreciprocatedSettingsController.isOpen.value"
      class="profile-drawer-mask unreciprocated-drawer-mask"
      @click="unreciprocatedSettingsController.close()"
    ></div>

    <!-- Drawer -->
    <aside
      id="vueUnreciprocatedSettingsDrawer"
      class="profile-drawer"
      role="dialog"
      aria-modal="true"
      :aria-hidden="!unreciprocatedSettingsController.isOpen.value"
      :hidden="!unreciprocatedSettingsController.isOpen.value"
      aria-labelledby="vueUnreciprocatedSettingsDrawerTitle"
    >
      <div class="profile-drawer-head">
        <strong id="vueUnreciprocatedSettingsDrawerTitle">回关监测设置</strong>
        <div class="drawer-head-actions">
          <button
            id="closeUnreciprocatedSettingsDrawer"
            class="icon-button secondary"
            type="button"
            title="关闭"
            aria-label="关闭"
            @click="unreciprocatedSettingsController.close()"
          >×</button>
        </div>
      </div>

      <div class="profile-drawer-content settings-drawer-content">
        <!-- Error & Success alerts -->
        <div v-if="unreciprocatedSettingsController.errorMessage.value" class="drawer-alert is-error" style="color:#d93025; background:#fce8e6; padding:8px 12px; border-radius:6px; margin-bottom:12px; font-size:12px;">
          {{ unreciprocatedSettingsController.errorMessage.value }}
        </div>
        <div v-if="unreciprocatedSettingsController.successMessage.value" class="drawer-alert is-success" style="color:#188038; background:#e6f4ea; padding:8px 12px; border-radius:6px; margin-bottom:12px; font-size:12px;">
          {{ unreciprocatedSettingsController.successMessage.value }}
        </div>

        <!-- Interval -->
        <div class="drawer-setting-group">
          <label for="unreciprocatedAutoEvery" class="drawer-setting-label">
            <span>检测间隔（分）</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="定时执行回关检测的基础时间周期，默认 60 分钟（即一小时一次）。 默认一小时检测一次，定时比对最新粉丝列表确认对方是否回关。" aria-label="定时执行回关检测的基础时间周期，默认 60 分钟（即一小时一次）。 默认一小时检测一次，定时比对最新粉丝列表确认对方是否回关。">?</span>
          </label>
          <input
            id="unreciprocatedAutoEvery"
            v-model.number="unreciprocatedSettingsController.every.value"
            type="number"
            min="5"
            max="1440"
          />
          
        </div>

        <!-- Jitter -->
        <div class="drawer-setting-group">
          <label for="unreciprocatedAutoJitter" class="drawer-setting-label">
            <span>随机浮动（±分）</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="在基础周期上随机浮动，模拟真人自然作息，避免机械规律。 每次至少浮动 1 分钟，实际检测按基准动态调度。" aria-label="在基础周期上随机浮动，模拟真人自然作息，避免机械规律。 每次至少浮动 1 分钟，实际检测按基准动态调度。">?</span>
          </label>
          <input
            id="unreciprocatedAutoJitter"
            v-model.number="unreciprocatedSettingsController.jitter.value"
            type="number"
            min="1"
            max="60"
          />
          
        </div>

        <!-- Overdue days threshold -->
        <div class="drawer-setting-group">
          <label for="unreciprocatedOverdueDays" class="drawer-setting-label">
            <span>回关期限（天）</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="主动关注对方后，超过多少天仍未回关则判定为无信用超时粉丝，默认 14 天（2周）。 默认 14 天（2周），超过此期限未回关将被标为超时浑水摸鱼账号。" aria-label="主动关注对方后，超过多少天仍未回关则判定为无信用超时粉丝，默认 14 天（2周）。 默认 14 天（2周），超过此期限未回关将被标为超时浑水摸鱼账号。">?</span>
          </label>
          <input
            id="unreciprocatedOverdueDays"
            v-model.number="unreciprocatedSettingsController.overdueDays.value"
            type="number"
            min="1"
            max="90"
          />
          
        </div>

        <!-- Auto unfollow switch -->
        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label">
            <input
              id="unreciprocatedAutoUnfollow"
              v-model="unreciprocatedSettingsController.autoUnfollow.value"
              type="checkbox"
            />
            <span>自动取关超时账号</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="开启后，定时检测到超过设定期限（如14天）仍未回关的账号时，将按批次上限自动执行安全仿真取关。 谨慎开启：定时检测若发现超过 14 天未回关，将自动安全取关清理。" aria-label="开启后，定时检测到超过设定期限（如14天）仍未回关的账号时，将按批次上限自动执行安全仿真取关。 谨慎开启：定时检测若发现超过 14 天未回关，将自动安全取关清理。">?</span>
          </label>
          
        </div>

        <!-- Batch limit -->
        <div class="drawer-setting-group">
          <label for="unreciprocatedBatchLimit" class="drawer-setting-label">
            <span>每轮取关人数</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="每轮定时任务最多自动取消关注多少人，建议单次 5-10 人，少量多次更安全。 控制单次清理频次，防止短时间内大量取关触发平台风控限制。" aria-label="每轮定时任务最多自动取消关注多少人，建议单次 5-10 人，少量多次更安全。 控制单次清理频次，防止短时间内大量取关触发平台风控限制。">?</span>
          </label>
          <input
            id="unreciprocatedBatchLimit"
            v-model.number="unreciprocatedSettingsController.batchLimit.value"
            type="number"
            min="1"
            max="50"
          />
          
        </div>

        <!-- Unfollow delay & jitter -->
        <div class="drawer-setting-group">
          <label for="unreciprocatedUnfollowDelay" class="drawer-setting-label">
            <span>取关间隔（秒）</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="连续取消关注时以此秒数为中心，再按浮动范围随机等待。 默认 3 秒基准、±2 秒浮动；至少浮动 1 秒。" aria-label="连续取消关注时以此秒数为中心，再按浮动范围随机等待。 默认 3 秒基准、±2 秒浮动；至少浮动 1 秒。">?</span>
          </label>
          <input
            id="unreciprocatedUnfollowDelay"
            v-model.number="unreciprocatedSettingsController.unfollowDelay.value"
            type="number"
            min="1"
            max="30"
          />
          
        </div>

        <div class="drawer-setting-group">
          <label for="unreciprocatedUnfollowDelayJitter" class="drawer-setting-label"><span>取关浮动（±秒）</span> <span class="info-tip" tabindex="0" role="note" data-tip="每次取关前的等待时间会在基准范围内随机变化。" aria-label="每次取关前的等待时间会在基准范围内随机变化。">?</span></label>
          <input
            id="unreciprocatedUnfollowDelayJitter"
            v-model.number="unreciprocatedSettingsController.unfollowDelayJitter.value"
            type="number"
            min="1"
            max="15"
          />
          
        </div>

        <!-- Whitelist -->
        <div class="drawer-setting-group">
          <label for="unreciprocatedWhitelist" class="drawer-setting-label">
            <span>免取关名单</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="重要好友、行业大V或特殊关注对象，即使超时也不自动取关。支持用逗号或换行分隔账号 handle。 列入白名单的账号将始终受到保护，绝不被自动取关。" aria-label="重要好友、行业大V或特殊关注对象，即使超时也不自动取关。支持用逗号或换行分隔账号 handle。 列入白名单的账号将始终受到保护，绝不被自动取关。">?</span>
          </label>
          <textarea
            id="unreciprocatedWhitelist"
            v-model="unreciprocatedSettingsController.whitelist.value"
            rows="3"
            placeholder="账号，逗号或换行分隔"
            style="width:100%;box-sizing:border-box;font-size:12px;padding:6px;border:1px solid #cbdacf;border-radius:6px;resize:vertical;"
          ></textarea>
          
        </div>

        <!-- Status -->
        <div class="drawer-setting-group">
          <label class="drawer-setting-label"><span>执行状态与记录</span></label>
          <div class="drawer-checkpoint-display">
            <span id="unreciprocatedAutoSummary" class="checkpoint-handle">{{ unreciprocatedSettingsController.lastSummary.value }}</span>
            <span id="unreciprocatedAutoLastTime" class="checkpoint-time">{{ unreciprocatedSettingsController.lastRunText.value }}</span>
          </div>
        </div>

        <!-- Enable switch -->
        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label">
            <input
              id="unreciprocatedAutoEnabled"
              v-model="unreciprocatedSettingsController.enabled.value"
              type="checkbox"
            />
            <span>后台定时检测</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="开启后后台将默认按每小时一次（带随机浮动）定时自动检测回关情况并记录日志。 默认每小时检测一次，及时掌握主动关注账号的回关动态与信用表现。" aria-label="开启后后台将默认按每小时一次（带随机浮动）定时自动检测回关情况并记录日志。 默认每小时检测一次，及时掌握主动关注账号的回关动态与信用表现。">?</span>
          </label>
          
        </div>
      </div>

      <!-- Actions -->
      <div class="profile-drawer-actions">
        <button
          id="saveUnreciprocatedSettings"
          type="button"
          :disabled="unreciprocatedSettingsController.saving.value"
          @click="unreciprocatedSettingsController.save()"
        >
          {{ unreciprocatedSettingsController.saving.value ? '保存中…' : '保存配置' }}
        </button>
        <button
          id="runUnreciprocatedNow"
          class="secondary"
          type="button"
          :disabled="unreciprocatedSettingsController.running.value"
          @click="unreciprocatedSettingsController.triggerRunNow()"
        >
          {{ unreciprocatedSettingsController.running.value ? '检测中…' : '立即检测' }}
        </button>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { unreciprocatedSettingsController } from '../composables/useUnreciprocatedSettings.js';

function onKeyDown(event) {
  if (event.key === 'Escape' && unreciprocatedSettingsController.isOpen.value) {
    unreciprocatedSettingsController.close();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
});
</script>
