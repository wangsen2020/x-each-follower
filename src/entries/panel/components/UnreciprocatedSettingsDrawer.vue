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
      :inert="!unreciprocatedSettingsController.isOpen.value"
      :aria-hidden="!unreciprocatedSettingsController.isOpen.value"
      :hidden="!unreciprocatedSettingsController.isOpen.value"
      aria-labelledby="vueUnreciprocatedSettingsDrawerTitle"
    >
      <div class="profile-drawer-head">
        <strong id="vueUnreciprocatedSettingsDrawerTitle">回关监控设置</strong>
        <div class="drawer-head-actions">
          <PanelCloseButton
            id="closeUnreciprocatedSettingsDrawer"
            @click="unreciprocatedSettingsController.close()"
          />
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

        <!-- 1. 等待期限 -->
        <div class="drawer-section-heading">等待期限</div>

        <div class="drawer-setting-group">
          <label for="unreciprocatedOverdueDays" class="drawer-setting-label">
            <span>最长等待回关（天）</span>
          </label>
          <input
            id="unreciprocatedOverdueDays"
            v-model.number="unreciprocatedSettingsController.overdueDays.value"
            type="number"
            min="1"
            max="90"
          />
            <span class="info-tip" tabindex="0" role="note" data-tip="主动关注对方后，超过多少天仍未回关判定为超时账号，默认 14 天（2周）。" aria-label="最长等待回关时间说明">?</span>
        </div>

        <div class="drawer-setting-group">
          <label for="unreciprocatedAutoEvery" class="drawer-setting-label">
            <span>本地比对间隔（分）</span>
          </label>
          <input
            id="unreciprocatedAutoEvery"
            v-model.number="unreciprocatedSettingsController.every.value"
            type="number"
            min="5"
            max="1440"
          />
            <span class="info-tip" tabindex="0" role="note" data-tip="定时执行本地回关数据比对的基础周期，默认 60 分钟。比对仅在本地刷新关系状态，不联网、不调用外部接口。" aria-label="本地比对间隔说明">?</span>
        </div>

        <div class="drawer-setting-group">
          <label for="unreciprocatedAutoJitter" class="drawer-setting-label">
            <span>比对浮动（±分）</span>
          </label>
          <input
            id="unreciprocatedAutoJitter"
            v-model.number="unreciprocatedSettingsController.jitter.value"
            type="number"
            min="0"
            max="60"
          />
            <span class="info-tip" tabindex="0" role="note" data-tip="在比对周期上增加随机浮动，避免多个定时任务同时开始。" aria-label="比对随机浮动说明">?</span>
        </div>

        <!-- 2. 首次私信提醒 -->
        <div class="drawer-section-heading">私信提醒</div>
        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label"><input id="unreciprocatedAutoGreeting" type="checkbox" v-model="unreciprocatedSettingsController.autoGreeting.value" /><span>启用自动私信</span>
          <InfoTip text="保存后绑定当前 X 账号，每 5 分钟检查，每轮最多处理 5 人。关注满等待天数仍未回关便发送一次，超过当天仍会补发；已发或结果待确认不重复发。需要保留已登录 X 页面。" label="自动私信提醒说明" /></label>
        </div>
        <div class="drawer-setting-group">
          <label for="unreciprocatedGreetingAfterDays" class="drawer-setting-label">
            <span>关注后等待（天）</span>
          </label>
          <input id="unreciprocatedGreetingAfterDays" v-model.number="unreciprocatedSettingsController.greetingAfterDays.value" type="number" min="1" max="30" />
            <span class="info-tip" tabindex="0" role="note" data-tip="默认关注满 24 小时后提醒。达到天数即可，超过第二天或取关期限仍可提醒；已回关、封禁、不存在的跳过。" aria-label="快捷私信等待时间说明">?</span>
        </div>
        <div class="drawer-setting-group">
          <label for="unreciprocatedGreetingText" class="drawer-setting-label">
            <span>默认中文私信</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="发给中文用户时的默认正文；打开预览时可逐条修改。" aria-label="中文私信正文说明">?</span>
          </label>
          <textarea id="unreciprocatedGreetingText" v-model="unreciprocatedSettingsController.greetingText.value" rows="2" maxlength="1000" />
        </div>
        <div class="drawer-setting-group">
          <label for="unreciprocatedGreetingTextEn" class="drawer-setting-label">
            <span>默认英文私信</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="发给英文或非中文用户时的默认正文；打开预览时可逐条修改。" aria-label="英文私信正文说明">?</span>
          </label>
          <textarea id="unreciprocatedGreetingTextEn" v-model="unreciprocatedSettingsController.greetingTextEn.value" rows="2" maxlength="1000" />
        </div>
        <div class="drawer-setting-group greeting-test-group">
          <label for="unreciprocatedGreetingTestHandle" class="drawer-setting-label">
            <span>测试收件人</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="仅用于你已确认同意测试的账号；发送前请核对收件人。" aria-label="测试收件人说明">?</span>
          </label>
          <div class="greeting-test-controls">
            <input id="unreciprocatedGreetingTestHandle" type="text" placeholder="@账号" autocomplete="off" />
            <button id="unreciprocatedGreetingTestBtn" type="button" class="secondary">预览测试</button>
          </div>
        </div>

        <!-- 3. 自动取关 -->
        <div class="drawer-section-heading">自动取关</div>

        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label">
            <input
              id="unreciprocatedAutoUnfollow"
              v-model="unreciprocatedSettingsController.autoUnfollow.value"
              type="checkbox"
            />
            <span>启用自动取关</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="保存后按周期处理超时未回关账号；仅使用当前绑定账号，跳过白名单和豁免账号，每次取关前重新核验关系。需保留该账号的已登录 X 页面。" aria-label="启用自动取关说明">?</span>
          </label>
        </div>

        <div class="drawer-setting-group">
          <label for="unreciprocatedAutoUnfollowEvery" class="drawer-setting-label"><span>取关执行周期（分）</span></label>
          <input
            id="unreciprocatedAutoUnfollowEvery"
            v-model.number="unreciprocatedSettingsController.autoUnfollowEvery.value"
            type="number"
            min="30"
            max="1440"
          />
          <span class="info-tip" tabindex="0" role="note" data-tip="默认每 45±15 分钟检查队列；每轮最多处理 1 人，实际两次取关请求至少间隔 30 分钟。X 官方不允许自动取关，此间隔不是平台认可的安全频率。" aria-label="取关执行周期说明">?</span>
        </div>

        <div class="drawer-setting-group">
          <label for="unreciprocatedAutoUnfollowJitter" class="drawer-setting-label">
            <span>周期浮动（±分）</span>
          </label>
          <input
            id="unreciprocatedAutoUnfollowJitter"
            v-model.number="unreciprocatedSettingsController.autoUnfollowJitter.value"
            type="number"
            min="0"
            max="15"
          />
            <span class="info-tip" tabindex="0" role="note" data-tip="取关检查周期随机浮动，默认 ±15 分钟。" aria-label="取关周期浮动说明">?</span>
        </div>

        <div class="drawer-setting-group">
          <label for="unreciprocatedDailyLimit" class="drawer-setting-label">
            <span>单日取关上限（人）</span>
          </label>
          <input
            id="unreciprocatedDailyLimit"
            v-model.number="unreciprocatedSettingsController.dailyLimit.value"
            type="number"
            min="1"
            max="12"
          />
            <span class="info-tip" tabindex="0" role="note" data-tip="每天最多尝试 12 人；按本机日期累计，结果不确定的请求也占用额度。" aria-label="单日取关上限说明">?</span>
        </div>

        <div class="drawer-setting-group drawer-setting-time">
          <label class="drawer-setting-label">
            <span>执行时段</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="自动取关执行的时间窗口，默认 09:00 至 21:00。时段外暂停执行，进入窗口后继续。" aria-label="执行时段说明">?</span>
          </label>
          <div class="time-window-inputs">
            <input
              id="unreciprocatedActiveTimeStart"
              v-model="unreciprocatedSettingsController.activeTimeStart.value"
              type="time"
            />
            <span class="time-sep">至</span>
            <input
              id="unreciprocatedActiveTimeEnd"
              v-model="unreciprocatedSettingsController.activeTimeEnd.value"
              type="time"
            />
          </div>
        </div>

        <!-- 3. 保护与监控 -->
        <div class="drawer-section-heading">保护与监控</div>

        <div class="drawer-setting-group">
          <label for="unreciprocatedWhitelist" class="drawer-setting-label">
            <span>免取关名单</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="保留关注名单，列入的账号即使超时也受到强保护，绝不被自动取关。支持用逗号或换行分隔账号 handle。" aria-label="免取关名单说明">?</span>
          </label>
          <textarea
            id="unreciprocatedWhitelist"
            v-model="unreciprocatedSettingsController.whitelist.value"
            rows="3"
            placeholder="账号 handle，逗号或换行分隔"
            style="width:100%;box-sizing:border-box;font-size:12px;padding:6px;border:1px solid #cbdacf;border-radius:6px;resize:vertical;"
          ></textarea>
        </div>

        <div class="drawer-setting-group">
          <label class="drawer-setting-label"><span>执行状态与记录</span></label>
          <div class="drawer-checkpoint-display">
            <span id="unreciprocatedAutoSummary" class="checkpoint-handle">{{ unreciprocatedSettingsController.lastSummary.value }}</span>
            <span id="unreciprocatedAutoLastTime" class="checkpoint-time">{{ unreciprocatedSettingsController.lastRunText.value }}</span>
          </div>
        </div>

        <div class="drawer-setting-group drawer-setting-switch">
          <label class="drawer-switch-label">
            <input
              id="unreciprocatedAutoEnabled"
              v-model="unreciprocatedSettingsController.enabled.value"
              type="checkbox"
            />
            <span>面板开启时定时比对</span>
            <span class="info-tip" tabindex="0" role="note" data-tip="开启后按设定周期提醒并在管理面板开启时执行本地比对；面板关闭时只提醒，不会自动取关。" aria-label="定时比对说明">?</span>
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
          {{ unreciprocatedSettingsController.running.value ? '比对中…' : '立即比对' }}
        </button>
      </div>
    </aside>
  </div>
</template>

<script setup>
import {useDrawerFocus} from '../composables/useDrawerFocus.js';
import { onMounted, onUnmounted } from 'vue';
import InfoTip from './InfoTip.vue';
import PanelCloseButton from './PanelCloseButton.vue';
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
useDrawerFocus(unreciprocatedSettingsController.isOpen, 'vueUnreciprocatedSettingsDrawer', 'openUnreciprocatedSettingsDrawer');
</script>

<style scoped>
.drawer-section-heading {
  font-size: 13px;
  font-weight: 600;
  color: #173f31;
  margin: 14px 0 8px 0;
  padding-bottom: 4px;
  border-bottom: 1px solid #e4ece6;
}

.drawer-setting-time {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  row-gap: 6px;
}

.drawer-setting-time > .drawer-setting-label {
  margin: 0 10px 0 0;
  min-width: 10em;
  max-width: calc(100% - 90px);
  flex: 0 1 auto;
  line-height: 20px;
}

.time-window-inputs {
  display: inline-flex;
  align-items: center;
  flex-wrap: nowrap;
}

.time-window-inputs > #unreciprocatedActiveTimeStart {
  width: 90px;
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  font-size: 12px;
  padding: 0 6px;
  border: 1px solid #cbdacf;
  border-radius: 6px;
  margin-right: 10px;
  box-sizing: border-box;
}

.time-window-inputs > .time-sep {
  font-size: 12px;
  color: #52685d;
  margin-right: 10px;
  white-space: nowrap;
}

.time-window-inputs > #unreciprocatedActiveTimeEnd {
  width: 90px;
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  font-size: 12px;
  padding: 0 6px;
  border: 1px solid #cbdacf;
  border-radius: 6px;
  margin-right: 0;
  box-sizing: border-box;
}

.profile-drawer-actions > :not(:last-child) {
  margin-right: 10px !important;
}

.profile-drawer-actions button {
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  font-size: 12px;
  box-sizing: border-box;
}

.info-tip {
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
  min-width: 14px;
  max-width: 14px;
  min-height: 14px;
  max-height: 14px;
  border-radius: 50%;
  background: #769287;
  color: #fff;
  font-family: Arial, sans-serif;
  font-size: 10px;
  font-weight: bold;
  line-height: 14px;
  border: none;
  cursor: help;
  vertical-align: middle;
}
</style>
