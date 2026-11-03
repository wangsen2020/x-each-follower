<template>
  <div>
    <!-- Logs Modal Mask -->
    <div
      id="logsModalMask"
      class="profile-drawer-mask logs-modal-mask"
      :hidden="!isOpen"
      @click="close"
    ></div>

    <!-- Logs Modal Dialog -->
    <div
      id="logsModal"
      class="logs-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="logsModalTitle"
      :hidden="!isOpen"
    >
      <!-- Head Section -->
      <div class="logs-modal-head">
        <div class="logs-modal-title-box">
          <strong id="logsModalTitle">{{ t(title) }}</strong>
          <span id="logsTotalBadge" class="badge">{{ t(totalBadgeText) }}</span>
        </div>
        <div class="logs-modal-head-btns">
          <PanelIconButton id="logsPrevBtn" :icon="ChevronLeft" label="上一页" :disabled="!canPrev" @click="prevPage" />
          <PanelIconButton id="logsNextBtn" :icon="ChevronRight" label="下一页" :disabled="!canNext" @click="nextPage" />
          <PanelIconButton id="clearLogsBtn" class="danger-btn" :icon="Trash2" :label="currentScope==='unreciprocated'?'清空全部分类':'清空日志'" :tip="isFansScope && fansSubTab==='followBack'?'队列回关记录由关注队列统一管理':'清空当前范围的执行日志'" :disabled="status==='loading' || (isFansScope && fansSubTab==='followBack')" @click="clearLogs" />
          <PanelCloseButton
            id="closeLogsModal"
            @click="close"
          />
        </div>
      </div>

      <div v-if="currentScope === 'unreciprocated'" class="logs-modal-subtabs">
        <button type="button" class="subtab-btn" :class="{active: followbackSubTab === 'timeout-monitoring'}" @click="setFollowbackSubTab('timeout-monitoring')">{{ t("超时监测") }}</button>
        <button id="subtabGreetingLogs" type="button" class="subtab-btn" :class="{active: followbackSubTab === 'greeting'}" @click="setFollowbackSubTab('greeting')">{{ t("私信提醒") }}</button>
        <button id="subtabUnfollowLogs" type="button" class="subtab-btn" :class="{active: followbackSubTab === 'unfollow'}" @click="setFollowbackSubTab('unfollow')">{{ t("取消关注") }}</button>
      </div>
      <p v-if="currentScope === 'unreciprocated'" style="margin: 0; padding: 8px 16px; color: #52655e; font-size: 12px">{{ followbackSubTab === 'timeout-monitoring'?t("关系比对与超时判定，不执行提醒或取关。"):followbackSubTab === 'greeting'?t("私信提醒及发送结果；待确认不代表已送达。"):t("自动、手动取关的账号及结果；跳过或待确认不代表已取关。") }}</p>
      <!-- Sub-tabs for Fans Scope (Scan vs Queue Follow-back) -->
      <div v-if="isFansScope" class="logs-modal-subtabs">
        <button
          id="subtabFansScan"
          type="button"
          class="subtab-btn"
          :class="{ active: fansSubTab === 'scan' }"
          @click="setFansSubTab('scan')"
        >{{ t("📋 粉丝扫描日志") }}</button>
        <button
          id="subtabFansFollowBack"
          type="button"
          class="subtab-btn"
          :class="{ active: fansSubTab === 'followBack' }"
          @click="setFansSubTab('followBack')"
        >{{ t("🤝 队列回关日志") }}</button>
        <button v-for="tab in fanWorkflowTabs" :id="'subtabFans'+tab.key" :key="tab.key" type="button" class="subtab-btn" :class="{active:fansSubTab===tab.value}" :aria-pressed="fansSubTab===tab.value" @click="setFansSubTab(tab.value)">{{ t(tab.label) }}</button>
      </div>

      <!-- Body Section -->
      <div class="logs-modal-body">
        <!-- Loading State -->
        <div id="logsLoading" class="logs-empty" :hidden="status !== 'loading'" role="status" aria-live="polite" :aria-busy="status === 'loading'">
          <span class="logs-loading-spinner" aria-hidden="true"></span>
          <p><strong>{{ t(loadingTitle) }}</strong></p>
          <span>{{ t(loadingDetail) }}</span>
          <span class="logs-loading-elapsed">{{ t("已等待 \u007b\u007bv0\u007d\u007d 秒 · 可随时关闭窗口",{v0:elapsedSeconds}) }}</span>
        </div>

        <!-- Error State -->
        <div id="logsError" class="logs-empty" :hidden="status !== 'error'">
          <p><strong>{{ t("执行日志加载失败") }}</strong></p>
          <span id="logsErrorText">{{ t(errorMessage) }}</span>
          <button id="retryLogsBtn" class="secondary logs-retry" type="button" @click="loadPage">{{ t("重新加载") }}</button>
        </div>

        <!-- Empty State -->
        <div id="logsEmpty" class="logs-empty" :hidden="status !== 'ready' || entries.length > 0">
          <p><strong>{{ t(emptyTitle) }}</strong></p>
          <span>{{ t(emptyDescription) }}</span>
        </div>

        <!-- Log List -->
        <div id="logsList" class="logs-list" :hidden="status !== 'ready' || entries.length === 0">
          <div
            v-for="(rawLog, index) in entries"
            :key="rawLog.id || rawLog.at || index"
            class="log-card"
          >
            <!-- 1. Verification Log Card -->
            <template v-if="getCardKind(rawLog) === 'fanWorkflow'">
              <div class="log-card-header">
                <div class="log-card-meta"><span class="log-time">{{ formatTime(rawLog) }}</span><span class="log-scope-badge">{{ t(fanWorkflowScope(rawLog)) }}</span><span class="log-scope-badge">{{ t(rawLog.source==='scheduled'?'自动执行':'手动执行') }}</span></div>
                <span class="badge" :class="['pass','approved','verified','ready','completed','removed'].includes(rawLog.result)?'candidate':'review'" :style="['error','failed','rejected'].includes(rawLog.result)?'background:#fbe9e7;color:#a12b20':''">{{ t(fanLogResultLabel(rawLog.result)) }}</span>
              </div>
              <div v-if="rawLog.handle" class="log-card-target"><a class="log-target-link" :href="'https://x.com/'+encodeURIComponent(rawLog.handle)" target="_blank" rel="noopener noreferrer">@{{ rawLog.handle }}</a></div>
              <div v-else-if="rawLog.total!=null" class="log-stats-bar"><span>{{ t('本轮人数') }}: {{ rawLog.total }} {{ t('人') }}</span><span v-if="rawLog.completed!=null">{{ t('已处理') }}: {{ rawLog.completed }} {{ t('人') }}</span><span v-if="rawLog.requestSize">{{ t('本批提交') }}: {{ rawLog.requestSize }} {{ t('人') }}</span></div>
              <p v-if="rawLog.detail" class="log-detail-text">{{ rawLog.detail }}</p>
              <p v-if="rawLog.executionStatus" class="log-detail-text">{{ t('移除执行') }}: {{ t(fanLogResultLabel(rawLog.executionStatus)) }}</p>
              <div v-if="rawLog.tags?.length" class="log-enqueued-row"><span v-for="tag in rawLog.tags" :key="tag" class="log-handle-tag">{{ tag }}</span></div>
              <p v-if="rawLog.relationship" class="log-detail-text">{{ t('我关注对方') }}: {{ t(relationLabel(rawLog.relationship.following)) }} · {{ t('对方关注我') }}: {{ t(relationLabel(rawLog.relationship.followedBy)) }}</p>
              <p v-if="rawLog.nextAt" class="log-detail-text">{{ t('下次检查') }}: {{ formatTime({at:rawLog.nextAt}) }}</p>
              <details v-if="rawLog.batchId || rawLog.accountId" class="followback-log-details"><summary>{{ t('诊断详情') }}</summary><dl><dt>{{ t('所属账号 ID') }}</dt><dd>{{ rawLog.accountId }}</dd><dt>{{ t('批次编号') }}</dt><dd>{{ rawLog.batchId || '—' }}</dd></dl></details>
            </template>
            <template v-else-if="getCardKind(rawLog) === 'verification'">
              <div class="log-card-header">
                <div class="log-card-meta">
                  <span class="log-time">{{ t(formatTime(rawLog)) }}</span>
                  <span class="log-scope-badge">{{ t("安全验证") }}</span>
                  <span class="log-scope-badge">{{ t("系统检测") }}</span>
                </div>
                <span class="badge review">
                  {{ rawLog.result === 'paused'?t("等待人工验证"):t("安全验证") }}
                </span>
              </div>
              <p v-if="rawLog.detail" class="log-detail-text">{{ t(rawLog.detail) }}</p>
              <p
                v-if="rawLog.signals?.length && !(rawLog.detail || '').includes('证据')"
                class="log-detail-text"
              >{{ t("证据：\u007b\u007bv0\u007d\u007d",{v0:formatSignals(rawLog.signals)}) }}
              </p>
            </template>

            <!-- 2. Fans Management Log Card -->
            <template v-else-if="getCardKind(rawLog) === 'fans'">
              <div class="log-card-header">
                <div class="log-card-meta">
                  <span class="log-time">{{ t(formatTime(rawLog)) }}</span>
                  <span class="log-scope-badge">{{ t("📋 粉丝扫描") }}</span>
                  <span class="log-scope-badge">{{ rawLog.source === 'alarm'?t("定时检测"):t("手动同步") }}</span>
                </div>
                <span
                  class="badge"
                  :class="followbackLogPresentation(rawLog).tone"
                  :style="fansResultBadgeStyle(rawLog.result)"
                >
                  {{ t(fansResultText(rawLog.result)) }}
                </span>
              </div>
              <div class="log-stats-bar">
                <span>{{ t("获取人数：") }}&nbsp;<strong>{{ (t(rawLog.scannedCount) ?? t(0)) }}</strong></span>
                <span>{{ t("当前粉丝：") }}&nbsp;<strong>{{ (t(rawLog.totalFollowers) ?? t(0)) }}</strong></span>
                <span>{{ t("当前关注：") }}&nbsp;<strong>{{ (t(rawLog.totalFollowing) ?? t(0)) }}</strong></span>
                <span>{{ t("需要回关：") }}&nbsp;<strong style="color: #0284c7">{{ (t(rawLog.followBackCount) ?? t(0)) }}</strong></span>
                <span>{{ t("未互关：") }}&nbsp;<strong style="color: #64748b">{{ (t(rawLog.notMutualCount) ?? t(0)) }}</strong></span>
                <span>{{ t("本次新增：") }}&nbsp;<strong style="color: #059669">{{ (t(rawLog.newFollowersCount) ?? t(0)) }}</strong></span>
                <span>{{ t("自动拉取入队：") }}&nbsp;<strong style="color: #16a34a">{{ (t(rawLog.enqueuedCount) ?? t(0)) }}</strong></span>
              </div>
              <div v-if="rawLog.summary" class="log-summary-row">{{ t(rawLog.summary) }}</div>
              <div v-if="rawLog.enqueuedHandles?.length" class="log-enqueued-row">
                <strong>{{ t("已自动拉取至关注队列（\u007b\u007bv0\u007d\u007d 人）：",{v0:rawLog.enqueuedHandles.length}) }}</strong>
                <span
                  v-for="h in rawLog.enqueuedHandles"
                  :key="h"
                  class="log-handle-tag"
                >@{{ t(h) }}</span>
              </div>
            </template>

            <!-- 3. Unreciprocated Log Card -->
            <template v-else-if="getCardKind(rawLog) === 'unreciprocated'">
              <div class="log-card-header">
                <div class="log-card-meta">
                  <span class="log-time">{{ t(formatTime(rawLog)) }}</span>
                  <span class="log-scope-badge">{{ t("回关监控") }}</span>
                  <span class="log-scope-badge">{{ t(followbackLogPresentation(rawLog).source) }}</span>
                </div>
                <span
                  class="badge"
                  :class="followbackLogPresentation(rawLog).tone"
                  :style="followbackLogPresentation(rawLog).tone === 'failed' ? 'background: #fbe9e7; color: #c62828;' : ''"
                >
                  {{ t(followbackLogPresentation(rawLog).label) }}
                </span>
              </div>
              <div v-if="followbackLogPresentation(rawLog).summary || rawLog.summary" class="log-summary-row">{{ (t(followbackLogPresentation(rawLog).summary) || t(rawLog.summary)) }}</div>
              <div class="followback-log-key-info">
                <div v-if="followbackLogPresentation(rawLog).showTarget !== false && (followbackLogContext(rawLog).handle || followbackLogPresentation(rawLog).source.includes('取关'))" class="log-card-target">
                  <strong>{{ t("目标账号：") }}</strong>
                  <a v-if="followbackLogContext(rawLog).handle" class="log-target-link" :href="'https://x.com/' + encodeURIComponent(followbackLogContext(rawLog).handle)" target="_blank" rel="noopener noreferrer">@{{ followbackLogContext(rawLog).handle }}</a>
                  <span v-else>{{ rawLog.result === 'started'?t("尚未选择"):t("未记录") }}</span>
                  <span v-if="followbackLogContext(rawLog).name" class="log-target-name">{{ followbackLogContext(rawLog).name }}</span>
                </div>
                <dl class="followback-log-key-fields"><template v-for="field in followbackLogContext(rawLog).rows" :key="field.label"><dt>{{ t(field.label) }}</dt><dd>{{ t(field.value) }}</dd></template></dl>
              </div>
              <div v-if="rawLog.details" class="followback-log-context">
                <div v-if="Object.keys(rawLog.details['跳过原因统计'] || {}).length">{{ t("跳过：\u007b\u007bv0\u007d\u007d",{v0:Object.entries(rawLog.details['跳过原因统计']).map(([reason, count]) => `${reason} ${count}`).join('；')}) }}</div>
              </div>
              <details v-if="rawLog.details" class="followback-log-details">
                <summary>{{ t("诊断详情") }}<span v-if="rawLog.runId"> · {{ t(rawLog.runId.slice(0, 8)) }}</span></summary>
                <dl><template v-for="(value, key) in rawLog.details" :key="key">
                  <dt>{{ t(key) }}</dt><dd><pre v-if="value !== null &amp;&amp; typeof value === 'object'">{{ JSON.stringify(value, null, 2) }}</pre><span v-else>{{ (value ?? t("未记录")) }}</span></dd>
                </template></dl>
              </details>
              <div v-else class="followback-legacy-note">{{ t("旧日志未记录诊断详情，无法追溯当时执行阶段。") }}</div>
              <div v-if="unfollowLogHandles(rawLog).length" class="log-unfollowed-row">{{ t("已取关账号：\u007b\u007bv0\u007d\u007d",{v0:unfollowLogHandles(rawLog).map(h => '@' + h).join('， ')}) }}
              </div>
            </template>

            <!-- 4. Standard / Queue / Comment / Mutual Log Card -->
            <template v-else>
              <div class="log-card-header">
                <div class="log-card-meta">
                  <span class="log-time">{{ t(formatTime(standardLog(rawLog))) }}</span>
                  <span class="log-scope-badge">{{ t(standardScopeLabel(standardLog(rawLog))) }}</span>
                  <span class="log-scope-badge">{{ t(standardSourceLabel(standardLog(rawLog))) }}</span>
                </div>
                <span
                  class="badge"
                  :class="standardBadgeClass(standardLog(rawLog))"
                  :style="standardBadgeStyle(standardLog(rawLog))"
                >
                  {{ t(standardBadgeText(standardLog(rawLog))) }}
                </span>
              </div>

              <!-- Target User Row -->
              <div v-if="standardLog(rawLog).handle" class="log-card-target">
                <a
                  class="log-target-link"
                  :href="'https://x.com/' + encodeURIComponent(standardLog(rawLog).handle)"
                  target="_blank"
                  rel="noopener noreferrer"
                >@{{ standardLog(rawLog).handle }}</a>
                <span v-if="standardLog(rawLog).name" class="log-target-name">
                  {{ fix(standardLog(rawLog).name) }}
                </span>
              </div>

              <!-- Detail Text -->
              <p v-if="standardLog(rawLog).detail" class="log-detail-text">
                {{ t(standardLog(rawLog).detail) }}
              </p>

              <!-- Scanned Posts Box -->
              <div v-if="shouldShowPostsBox(standardLog(rawLog))" class="log-posts-box">
                <strong class="log-posts-title">{{ t(postsBoxTitle(standardLog(rawLog))) }}</strong>
                <ol v-if="standardLog(rawLog).posts?.length" class="log-posts-list">
                  <li
                    v-for="(p, pIdx) in standardLog(rawLog).posts"
                    :key="pIdx"
                    class="log-post-item"
                  >
                    <span v-if="p.time" class="log-post-time">[{{ t(p.time.slice(0, 10)) }}] </span>
                    <span>{{ fix(p.text || t('(无正文)')).slice(0, 160) }}</span>
                    <a
                      v-if="p.url"
                      class="log-post-link"
                      :href="p.url"
                      target="_blank"
                      rel="noopener noreferrer"
                    >{{ t("查看原帖 ↗") }}</a>
                  </li>
                </ol>
              </div>

              <!-- Grok Comment Box -->
              <div v-if="standardLog(rawLog).grokComment" class="log-grok-box">
                <div class="log-grok-header">
                  <span
                    class="log-grok-tag"
                    :style="standardLog(rawLog).commentPosted ? 'background:#d9eee1;color:#1d5c3a;' : ''"
                  >
                    {{ standardLog(rawLog).commentPosted?t("✔ 已发布 Grok 引用评价"):t("🤖 Grok 引用评价（草稿）") }}
                  </span>
                  <a
                    v-if="standardLog(rawLog).grokCommentPostUrl"
                    class="log-grok-post-link"
                    :href="standardLog(rawLog).grokCommentPostUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ t("被引用原帖 ↗") }}</a>
                  <button
                    class="log-copy-btn"
                    type="button"
                    @click="copyText(standardLog(rawLog).grokComment, $event)"
                  >{{ t("一键复制评价") }}</button>
                </div>
                <div v-if="standardLog(rawLog).grokCommentPost" class="log-grok-post-preview">{{ t("针对推文：\u007b\u007bv0\u007d\u007d",{v0:standardLog(rawLog).grokCommentPost}) }}
                </div>
                <div class="log-grok-body">{{ standardLog(rawLog).grokComment }}</div>
              </div>

              <!-- Queue Detail Rows -->
              <template v-if="standardLog(rawLog).scope === 'queue'">
                <section v-if="rawLog.diagnostic" class="log-diagnostics">
                  <p class="log-detail-text">{{ t("异常账号：@\u007b\u007bv0\u007d\u007d · 阶段：\u007b\u007bv1\u007d\u007d · \u007b\u007bv2\u007d\u007d \u007b\u007bv3\u007d\u007d 次",{v0:(rawLog.diagnostic.handle || t("未记录")),v1:t(rawLog.diagnostic.stageLabel),v2:rawLog.diagnostic.repeatScope === 'target-error'?t("该账号同类异常"):t("同阶段累计异常"),v3:(rawLog.diagnostic.repeatCount || 1)}) }}</p>
                  <p class="log-detail-text">{{ t("诊断编号：\u007b\u007bv0\u007d\u007d · 版本：\u007b\u007bv1\u007d\u007d",{v0:rawLog.diagnostic.id,v1:rawLog.diagnostic.version}) }}</p>
                  <p class="log-detail-text">{{ t("失败网址：\u007b\u007bv0\u007d\u007d",{v0:((rawLog.diagnostic.requestedUrl || rawLog.diagnostic.actualUrl) || t("未记录"))}) }}</p>
                  <details>
                    <summary>{{ t("完整脱敏排查上下文") }}</summary>
                    <pre style="white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0;">{{ JSON.stringify(rawLog.diagnostic, null, 2) }}</pre>
                  </details>
                </section>
                <p v-if="standardLog(rawLog).runId || standardLog(rawLog).jobId" class="log-detail-text">{{ t("执行批次：\u007b\u007bv0\u007d\u007d · 任务：\u007b\u007bv1\u007d\u007d",{v0:(standardLog(rawLog).runId || t("未记录")),v1:(standardLog(rawLog).jobId || t("批次汇总"))}) }}
                </p>
                <p v-if="standardLog(rawLog).sources?.length" class="log-detail-text">{{ t("候选来源：\u007b\u007bv0\u007d\u007d",{v0:formatQueueSources(standardLog(rawLog).sources)}) }}
                </p>
                <p v-if="standardLog(rawLog).startedAt" class="log-detail-text">{{ t("实际用时：\u007b\u007bv0\u007d\u007d 秒 · 已滚动 \u007b\u007bv1\u007d\u007d / \u007b\u007bv2\u007d\u007d 轮\u007b\u007bv3\u007d\u007d",{v0:queueDurationSeconds(standardLog(rawLog)),v1:(standardLog(rawLog).scrollRounds || 0),v2:standardLog(rawLog).plannedScrollRounds,v3:standardLog(rawLog).dwellSeconds?t(" · 目标停留 \u007b\u007bv0\u007d\u007d 秒",{v0:standardLog(rawLog).dwellSeconds}):''}) }}
                </p>
                <template v-for="(ev, evIdx) in (standardLog(rawLog).evaluations || [])" :key="evIdx">
                  <p class="log-detail-text">{{ t("引用评价：\u007b\u007bv0\u007d\u007d\u007b\u007bv1\u007d\u007d",{v0:t(evaluationStatusText(ev.status)),v1:ev.reason?t(" · 原因：\u007b\u007bv0\u007d\u007d",{v0:ev.reason}):''}) }}
                  </p>
                  <p v-if="isValidXUrl(ev.originalPostUrl)" class="log-detail-text">
                    <a :href="ev.originalPostUrl" target="_blank" rel="noopener noreferrer">{{ t("被引用原帖 ↗") }}</a>
                  </p>
                  <p v-if="ev.originalPostText" class="log-detail-text">{{ t("原帖正文：\u007b\u007bv0\u007d\u007d",{v0:ev.originalPostText}) }}</p>
                  <template v-if="ev.text">
                    <p class="log-detail-text">{{ t("评价正文：\u007b\u007bv0\u007d\u007d",{v0:ev.text}) }}</p>
                    <button class="log-copy-btn" type="button" @click="copyText(ev.text, $event)">{{ t("复制评价") }}</button>
                  </template>
                  <p v-if="isValidXUrl(ev.publishedPostUrl)" class="log-detail-text">
                    <a :href="ev.publishedPostUrl" target="_blank" rel="noopener noreferrer">{{ t("查看已发布评价 ↗") }}</a>
                  </p>
                </template>
                <p
                  v-if="standardLog(rawLog).type === 'job-complete' && !(standardLog(rawLog).evaluations?.length) && standardLog(rawLog).result !== 'already_following'"
                  class="log-detail-text"
                >
                  {{ standardLog(rawLog).grokEnabled === false?t("引用评价未启用，本次仅处理关注。"):(t(standardLog(rawLog).reason) || t("此记录未包含引用评价详情。")) }}
                </p>
              </template>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import {t} from '../../../shared/i18n.js';
import {fanLogResultLabel} from '../../../features/relationships/fan-workflow-logs.js';
import {ChevronLeft,ChevronRight,Trash2} from 'lucide';
import PanelIconButton from './PanelIconButton.vue';
const fanWorkflowTabs=[{key:'Review',value:'review',label:'审核日志'},{key:'Verify',value:'verify',label:'核实日志'},{key:'Schedule',value:'schedule',label:'调度日志'}];
const fanWorkflowScope=log=>log.scope==='fanSchedule'?(log.kind==='verify'?'核实调度':'审核调度'):log.scope==='fanVerify'?'核实日志':'审核日志';
const relationLabel=value=>value===true?'是':value===false?'否':'未知';

import {unfollowLogHandles} from '../../../shared/execution-log-select.js';
import {followbackLogPresentation,followbackLogContext} from '../../../features/relationships/followback-log.js';
import { logsModalController } from '../composables/useExecutionLogs.js';
import PanelCloseButton from './PanelCloseButton.vue';
import { repairMojibake } from '../../../features/relationships/scoring.js';
import { normalizeQueueExecutionLog } from '../../../shared/execution-log.js';

// Inject reactive state and actions from the controller
const {
  isOpen,
  currentScope,
  fansSubTab,
  followbackSubTab,
  setFollowbackSubTab,
  isFansScope,
  setFansSubTab,
  status,
  errorMessage,
  elapsedSeconds,
  loadingTitle,
  loadingDetail,
  loadPage,
  entries,
  canPrev,
  canNext,
  title,
  totalBadgeText,
  emptyTitle,
  emptyDescription,
  close,
  prevPage,
  nextPage,
  clearLogs
} = logsModalController;

function fix(str) {
  return repairMojibake(str || '');
}

function formatTime(log) {
  if (log?.timeStr) return log.timeStr;
  if (log?.at) {
    try {
      return new Date(log.at).toLocaleString();
    } catch {
      return String(log.at);
    }
  }
  return '未知时间';
}

function getCardKind(log) {
  if (['fanReview','fanVerify','fanSchedule'].includes(log?.scope)) return 'fanWorkflow';
  if (log?.scope === 'verification') return 'verification';
  if (log?.origin === 'monitorLogs' || log?.scope === 'fans' || log?.scope === 'monitor') return 'fans';
  if (log?.origin === 'unreciprocatedLogs' || log?.scope === 'unreciprocated' || log?.totalTracked != null || log?.unfollowedHandles) {
    return 'unreciprocated';
  }
  return 'standard';
}

function formatSignals(signals) {
  const labels = {
    'cf-challenge-iframe': 'Cloudflare 验证框',
    'cf-page-title': '页面标题与正文',
    'cf-page-dom': '验证页标记',
    'arkose-iframe': 'Arkose 验证框',
    'arkose-widget': 'Arkose 组件'
  };
  return (signals || []).map(code => `${code} ${labels[code] || code}`).join('；');
}

function fansResultBadgeStyle(result) {
  if (result === 'success') return '';
  if (result === 'warning') return 'background: #fff8e1; color: #f57f17;';
  return 'background: #fbe9e7; color: #c62828;';
}

function fansResultText(result) {
  if (result === 'success') return '检测完成 ✓';
  if (result === 'warning') return '部分同步';
  return '检测异常';
}

function standardLog(rawLog) {
  return rawLog.scope === 'queue' ? normalizeQueueExecutionLog(rawLog, {}, rawLog) : rawLog;
}

function standardScopeLabel(log) {
  if (log.scope === 'verification') return '安全验证';
  if (log.scope === 'queue') {
    if (log.sources?.some(s => s.module === 'fans')) return '🤝 队列回关';
    if (log.sources?.some(s => s.module === 'comments')) return '💬 评论互动';
    if (log.sources?.some(s => s.module === 'mutual')) return '👥 互关互动';
    return '关注队列';
  }
  if (log.scope === 'comment') return '评论追踪';
  if (log.scope === 'mutual') return '互关追踪';
  if (log.scope === 'unreciprocated') return '回关监控';
  return '系统日志';
}

function standardSourceLabel(log) {
  if (log.scope === 'verification') return '系统检测';
  if (log.source === 'manual') return '手动执行';
  if (log.source === 'scheduled' || log.scope !== 'queue') return '定时执行';
  return '触发方式未记录';
}

function standardBadgeClass(log) {
  if (log.source === 'manual' && log.grokComment) {
    return log.commentPosted ? 'candidate' : 'review';
  }
  if (['started', 'completed', 'already_following'].includes(log.result)) return 'review';
  if (['info','running','pending','retry','uncertain','excluded','posted','draft','failed','publishing','generating'].includes(log.result)) {
    return 'review';
  }
  if (log.result === 'followed') return 'candidate';
  if (log.result === 'skipped') return 'review';
  return '';
}

function standardBadgeStyle(log) {
  if (log.result === 'rate_limited') return 'background: #fde8e4; color: #a23924;';
  if (log.scope === 'verification' && log.result === 'paused') return '';
  if (!standardBadgeClass(log)) return 'background: #fbe9e7; color: #c62828;';
  return '';
}

function standardBadgeText(log) {
  if (log.source === 'manual' && log.grokComment) {
    return log.commentPosted ? '引用评价已发布 ✓' : '仅生成草稿';
  }
  if (['started', 'completed', 'already_following'].includes(log.result)) {
    return { started: '任务开始', completed: '本轮结束', already_following: '已关注' }[log.result];
  }
  if (['info','running','pending','retry','uncertain','excluded','posted','draft','failed','publishing','generating'].includes(log.result)) {
    return {
      info: '状态更新',
      running: '执行中',
      pending: '待执行',
      retry: '等待重试',
      uncertain: '结果待核实',
      excluded: '已排除',
      posted: '评价已发布',
      draft: '评价草稿',
      failed: '执行失败',
      publishing: '发布待核实',
      generating: '生成评价中'
    }[log.result];
  }
  if (log.result === 'followed') return '关注成功 ✓';
  if (log.result === 'skipped') return '已跳过';
  if (log.result === 'rate_limited') return '频率限制';
  if (log.scope === 'verification' && log.result === 'paused') return '等待人工验证';
  return '未成功';
}

function shouldShowPostsBox(log) {
  return Boolean(
    log.posts?.length ||
    (log.handle && log.result !== 'already_following' && log.result !== 'started' && (log.scope !== 'queue' || log.scanned || log.type === 'job-complete'))
  );
}

function postsBoxTitle(log) {
  if (log.posts?.length) return `扫描主页帖子（共 ${log.posts.length} 条）：`;
  if (log.scope === 'queue') {
    return log.scanned ? '本次主页读取未获取到公开帖子' : '此记录未包含主页扫描详情';
  }
  return '未扫描到主页公开帖子';
}

function formatQueueSources(sources) {
  const map = { fans: '粉丝跟进', mutual: '互关追踪', comments: '评论追踪' };
  const list = [...new Set((sources || []).map(s => map[s.module] || s.module))];
  return list.join('、');
}

function queueDurationSeconds(log) {
  const start = Date.parse(log.startedAt);
  const end = Date.parse(log.finishedAt || log.at);
  if (isNaN(start) || isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

function evaluationStatusText(status) {
  const map = {
    posted: '已发布并核验',
    published: '已发布',
    draft: '已生成草稿',
    failed: '失败',
    uncertain: '发布结果待核实',
    publishing: '发布中，待核实',
    generating: '生成中'
  };
  return map[status] || status || '未记录状态';
}

function isValidXUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['x.com', 'twitter.com'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function copyText(text, event) {
  if (!text) return;
  const btn = event?.currentTarget;
  const oldText = btn ? btn.textContent : '';
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      btn.textContent = t('已复制！');
      setTimeout(() => { btn.textContent = t(oldText || '复制'); }, 1800);
    }
  } catch {
    if (btn) {
      btn.textContent = t('复制失败');
      setTimeout(() => { btn.textContent = t(oldText || '复制'); }, 1800);
    }
  }
}
</script>

<style scoped>
.logs-modal-subtabs{flex-wrap:wrap}.logs-modal-subtabs .subtab-btn{margin-bottom:4px}.logs-modal-head-btns{flex-shrink:0}.logs-modal-head-btns>:not(:last-child){margin-right:10px}.log-detail-text,.followback-log-details dd{overflow-wrap:anywhere}.log-card-meta{flex-wrap:wrap}
@media(max-width:600px){.logs-modal-head{flex-wrap:wrap}.logs-modal-title-box{margin-bottom:8px}.logs-modal-head-btns{margin-left:auto}}

.logs-loading-spinner {
  display: inline-block;
  width: 26px;
  height: 26px;
  border: 3px solid #dce9df;
  border-top-color: #268456;
  border-radius: 50%;
  animation: logs-spin .8s linear infinite;
}
.logs-loading-elapsed { display: block; margin-top: 10px; font-size: 12px; color: #617369; }
.logs-retry { display: block; margin: 12px auto 0; }
@keyframes logs-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .logs-loading-spinner { animation: none; } }
.logs-modal-subtabs {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
}
.subtab-btn {
  height: 28px;
  padding: 0 12px;
  margin-right: 8px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid #cbd5e1;
  background: #ffffff;
  color: #475569;
  cursor: pointer;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.subtab-btn:hover {
  background: #f1f5f9;
  border-color: #94a3b8;
}
.subtab-btn.active {
  background: #0284c7;
  color: #ffffff;
  border-color: #0284c7;
}
.log-stats-bar {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  background: #f8fafc;
  font-size: 12px;
  color: #475569;
  border-bottom: 1px solid #e2e8f0;
  flex-wrap: wrap;
  align-items: center;
}
.log-stats-bar strong {
  color: #0f172a;
}
.log-summary-row {
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.5;
  color: #1e293b;
}
.log-enqueued-row {
  padding: 0 12px 10px;
  font-size: 12px;
  color: #15803d;
}
.log-handle-tag {
  display: inline-block;
  background: #dcfce7;
  color: #166534;
  padding: 2px 6px;
  border-radius: 4px;
  margin: 2px 4px 2px 0;
}
.log-unfollowed-row {
  padding: 0 12px 8px;
  font-size: 12px;
  color: #c62828;
}
.log-grok-post-preview {
  font-size: 11px;
  color: var(--text-subtle, #617369);
  margin-bottom: 4px;
  padding-left: 6px;
  border-left: 2px solid var(--border-soft, #e1ebe4);
  max-height: 38px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

<style scoped>
.followback-log-context { margin-top: 6px; font-size: 12px; color: #60776c; line-height: 1.6; overflow-wrap: anywhere; }
.followback-log-key-info { margin-top: 10px; padding: 10px 12px; background: #f4f8f6; border-radius: 6px; font-size: 12px; }
.followback-log-key-fields { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 5px 10px; margin: 8px 0 0; line-height: 1.5; }
.followback-log-key-fields dt { color: #60776c; }
.followback-log-key-fields dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.followback-log-details { margin: 8px 0 0; font-size: 12px; }
.followback-log-details summary { cursor: pointer; color: #356451; padding: 4px 0; }
.followback-log-details summary:focus-visible { outline: 2px solid #769287; outline-offset: 2px; }
.followback-log-details dl { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 6px 10px; margin: 8px 0 0; }
.followback-log-details dt { color: #60776c; overflow-wrap: anywhere; }
.followback-log-details dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.followback-log-details pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.followback-legacy-note { margin-top: 6px; font-size: 11px; color: #769287; }
@media (max-width: 480px) { .followback-log-details dl { grid-template-columns: 100px minmax(0, 1fr); } }
</style>
