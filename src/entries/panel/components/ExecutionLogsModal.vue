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
          <strong id="logsModalTitle">{{ title }}</strong>
          <span id="logsTotalBadge" class="badge">{{ totalBadgeText }}</span>
        </div>
        <div class="logs-modal-head-btns">
          <button
            id="logsPrevBtn"
            class="secondary"
            type="button"
            :disabled="!canPrev"
            style="margin-right: 10px"
            @click="prevPage"
          >上一页</button>
          <button
            id="logsNextBtn"
            class="secondary"
            type="button"
            :disabled="!canNext"
            style="margin-right: 10px"
            @click="nextPage"
          >下一页</button>
          <button
            id="clearLogsBtn"
            class="secondary danger-btn"
            type="button"
            :title="isFansScope && fansSubTab === 'followBack' ? '队列回关记录由关注队列统一管理' : '清空当前范围的执行日志'"
            :disabled="isFansScope && fansSubTab === 'followBack'"
            style="margin-right: 10px"
            @click="clearLogs"
          >清空日志</button>
          <button
            id="closeLogsModal"
            class="icon-button secondary"
            type="button"
            title="关闭"
            aria-label="关闭"
            @click="close"
          >×</button>
        </div>
      </div>

      <!-- Sub-tabs for Fans Scope (Scan vs Queue Follow-back) -->
      <div v-if="isFansScope" class="logs-modal-subtabs">
        <button
          id="subtabFansScan"
          type="button"
          class="subtab-btn"
          :class="{ active: fansSubTab === 'scan' }"
          @click="setFansSubTab('scan')"
        >
          📋 粉丝扫描日志
        </button>
        <button
          id="subtabFansFollowBack"
          type="button"
          class="subtab-btn"
          :class="{ active: fansSubTab === 'followBack' }"
          @click="setFansSubTab('followBack')"
        >
          🤝 队列回关日志
        </button>
      </div>

      <!-- Body Section -->
      <div class="logs-modal-body">
        <!-- Loading State -->
        <div id="logsLoading" class="logs-empty" :hidden="status !== 'loading'">
          <p><strong>正在加载执行日志…</strong></p>
        </div>

        <!-- Error State -->
        <div id="logsError" class="logs-empty" :hidden="status !== 'error'">
          <p><strong>执行日志加载失败</strong></p>
          <span id="logsErrorText">{{ errorMessage }}</span>
        </div>

        <!-- Empty State -->
        <div id="logsEmpty" class="logs-empty" :hidden="status !== 'ready' || entries.length > 0">
          <p><strong>{{ emptyTitle }}</strong></p>
          <span>{{ emptyDescription }}</span>
        </div>

        <!-- Log List -->
        <div id="logsList" class="logs-list" :hidden="status !== 'ready' || entries.length === 0">
          <div
            v-for="(rawLog, index) in entries"
            :key="rawLog.id || rawLog.at || index"
            class="log-card"
          >
            <!-- 1. Verification Log Card -->
            <template v-if="getCardKind(rawLog) === 'verification'">
              <div class="log-card-header">
                <div class="log-card-meta">
                  <span class="log-time">{{ formatTime(rawLog) }}</span>
                  <span class="log-scope-badge">安全验证</span>
                  <span class="log-scope-badge">系统检测</span>
                </div>
                <span class="badge review">
                  {{ rawLog.result === 'paused' ? '等待人工验证' : '安全验证' }}
                </span>
              </div>
              <p v-if="rawLog.detail" class="log-detail-text">{{ rawLog.detail }}</p>
              <p
                v-if="rawLog.signals?.length && !(rawLog.detail || '').includes('证据')"
                class="log-detail-text"
              >
                证据：{{ formatSignals(rawLog.signals) }}
              </p>
            </template>

            <!-- 2. Fans Management Log Card -->
            <template v-else-if="getCardKind(rawLog) === 'fans'">
              <div class="log-card-header">
                <div class="log-card-meta">
                  <span class="log-time">{{ formatTime(rawLog) }}</span>
                  <span class="log-scope-badge">📋 粉丝扫描</span>
                  <span class="log-scope-badge">{{ rawLog.source === 'alarm' ? '定时检测' : '手动同步' }}</span>
                </div>
                <span
                  class="badge"
                  :class="{ candidate: rawLog.result === 'success' }"
                  :style="fansResultBadgeStyle(rawLog.result)"
                >
                  {{ fansResultText(rawLog.result) }}
                </span>
              </div>
              <div class="log-stats-bar">
                <span>获取人数：<strong>{{ rawLog.scannedCount ?? 0 }}</strong></span>
                <span>当前粉丝：<strong>{{ rawLog.totalFollowers ?? 0 }}</strong></span>
                <span>当前关注：<strong>{{ rawLog.totalFollowing ?? 0 }}</strong></span>
                <span>需要回关：<strong style="color: #0284c7">{{ rawLog.followBackCount ?? 0 }}</strong></span>
                <span>未互关：<strong style="color: #64748b">{{ rawLog.notMutualCount ?? 0 }}</strong></span>
                <span>本次新增：<strong style="color: #059669">{{ rawLog.newFollowersCount ?? 0 }}</strong></span>
                <span>自动拉取入队：<strong style="color: #16a34a">{{ rawLog.enqueuedCount ?? 0 }}</strong></span>
              </div>
              <div v-if="rawLog.summary" class="log-summary-row">{{ rawLog.summary }}</div>
              <div v-if="rawLog.enqueuedHandles?.length" class="log-enqueued-row">
                <strong>已自动拉取至关注队列（{{ rawLog.enqueuedHandles.length }} 人）：</strong>
                <span
                  v-for="h in rawLog.enqueuedHandles"
                  :key="h"
                  class="log-handle-tag"
                >@{{ h }}</span>
              </div>
            </template>

            <!-- 3. Unreciprocated Log Card -->
            <template v-else-if="getCardKind(rawLog) === 'unreciprocated'">
              <div class="log-card-header">
                <div class="log-card-meta">
                  <span class="log-time">{{ formatTime(rawLog) }}</span>
                  <span class="log-scope-badge">回关监测</span>
                  <span class="log-scope-badge">{{ rawLog.source === 'manual' ? '手动检测' : '定时执行' }}</span>
                </div>
                <span
                  class="badge"
                  :class="{ candidate: rawLog.result === 'success' }"
                  :style="rawLog.result === 'success' ? '' : 'background: #fbe9e7; color: #c62828;'"
                >
                  {{ rawLog.result === 'success' ? '执行完成 ✓' : '执行失败' }}
                </span>
              </div>
              <div v-if="rawLog.summary" class="log-summary-row">{{ rawLog.summary }}</div>
              <div v-if="rawLog.unfollowedHandles?.length" class="log-unfollowed-row">
                已取关账号：{{ rawLog.unfollowedHandles.map(h => '@' + h).join('， ') }}
              </div>
            </template>

            <!-- 4. Standard / Queue / Comment / Mutual Log Card -->
            <template v-else>
              <div class="log-card-header">
                <div class="log-card-meta">
                  <span class="log-time">{{ formatTime(standardLog(rawLog)) }}</span>
                  <span class="log-scope-badge">{{ standardScopeLabel(standardLog(rawLog)) }}</span>
                  <span class="log-scope-badge">{{ standardSourceLabel(standardLog(rawLog)) }}</span>
                </div>
                <span
                  class="badge"
                  :class="standardBadgeClass(standardLog(rawLog))"
                  :style="standardBadgeStyle(standardLog(rawLog))"
                >
                  {{ standardBadgeText(standardLog(rawLog)) }}
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
                {{ standardLog(rawLog).detail }}
              </p>

              <!-- Scanned Posts Box -->
              <div v-if="shouldShowPostsBox(standardLog(rawLog))" class="log-posts-box">
                <strong class="log-posts-title">{{ postsBoxTitle(standardLog(rawLog)) }}</strong>
                <ol v-if="standardLog(rawLog).posts?.length" class="log-posts-list">
                  <li
                    v-for="(p, pIdx) in standardLog(rawLog).posts"
                    :key="pIdx"
                    class="log-post-item"
                  >
                    <span v-if="p.time" class="log-post-time">[{{ p.time.slice(0, 10) }}] </span>
                    <span>{{ fix(p.text || '(无正文)').slice(0, 160) }}</span>
                    <a
                      v-if="p.url"
                      class="log-post-link"
                      :href="p.url"
                      target="_blank"
                      rel="noopener noreferrer"
                    >查看原帖 ↗</a>
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
                    {{ standardLog(rawLog).commentPosted ? '✔ 已发布 Grok 引用评价' : '🤖 Grok 引用评价（草稿）' }}
                  </span>
                  <a
                    v-if="standardLog(rawLog).grokCommentPostUrl"
                    class="log-grok-post-link"
                    :href="standardLog(rawLog).grokCommentPostUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >被引用原帖 ↗</a>
                  <button
                    class="log-copy-btn"
                    type="button"
                    @click="copyText(standardLog(rawLog).grokComment, $event)"
                  >一键复制评价</button>
                </div>
                <div v-if="standardLog(rawLog).grokCommentPost" class="log-grok-post-preview">
                  针对推文：{{ standardLog(rawLog).grokCommentPost }}
                </div>
                <div class="log-grok-body">{{ standardLog(rawLog).grokComment }}</div>
              </div>

              <!-- Queue Detail Rows -->
              <template v-if="standardLog(rawLog).scope === 'queue'">
                <section v-if="rawLog.diagnostic" class="log-diagnostics">
                  <p class="log-detail-text">异常账号：@{{ rawLog.diagnostic.handle || '未记录' }} · 阶段：{{ rawLog.diagnostic.stageLabel }} · 累计 {{ rawLog.diagnostic.repeatCount || 1 }} 次</p>
                  <p class="log-detail-text">诊断编号：{{ rawLog.diagnostic.id }} · 版本：{{ rawLog.diagnostic.version }}</p>
                  <p class="log-detail-text">失败网址：{{ rawLog.diagnostic.requestedUrl || rawLog.diagnostic.actualUrl || '未记录' }}</p>
                  <details>
                    <summary>完整脱敏排查上下文</summary>
                    <pre style="white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0;">{{ JSON.stringify(rawLog.diagnostic, null, 2) }}</pre>
                  </details>
                </section>
                <p v-if="standardLog(rawLog).runId || standardLog(rawLog).jobId" class="log-detail-text">
                  执行批次：{{ standardLog(rawLog).runId || '未记录' }} · 任务：{{ standardLog(rawLog).jobId || '批次汇总' }}
                </p>
                <p v-if="standardLog(rawLog).sources?.length" class="log-detail-text">
                  候选来源：{{ formatQueueSources(standardLog(rawLog).sources) }}
                </p>
                <p v-if="standardLog(rawLog).startedAt" class="log-detail-text">
                  实际用时：{{ queueDurationSeconds(standardLog(rawLog)) }} 秒 · 已滚动 {{ standardLog(rawLog).scrollRounds || 0 }} / {{ standardLog(rawLog).plannedScrollRounds }} 轮{{ standardLog(rawLog).dwellSeconds ? ' · 目标停留 ' + standardLog(rawLog).dwellSeconds + ' 秒' : '' }}
                </p>
                <template v-for="(ev, evIdx) in (standardLog(rawLog).evaluations || [])" :key="evIdx">
                  <p class="log-detail-text">
                    引用评价：{{ evaluationStatusText(ev.status) }}{{ ev.reason ? ' · 原因：' + ev.reason : '' }}
                  </p>
                  <p v-if="isValidXUrl(ev.originalPostUrl)" class="log-detail-text">
                    <a :href="ev.originalPostUrl" target="_blank" rel="noopener noreferrer">被引用原帖 ↗</a>
                  </p>
                  <p v-if="ev.originalPostText" class="log-detail-text">原帖正文：{{ ev.originalPostText }}</p>
                  <template v-if="ev.text">
                    <p class="log-detail-text">评价正文：{{ ev.text }}</p>
                    <button class="log-copy-btn" type="button" @click="copyText(ev.text, $event)">复制评价</button>
                  </template>
                  <p v-if="isValidXUrl(ev.publishedPostUrl)" class="log-detail-text">
                    <a :href="ev.publishedPostUrl" target="_blank" rel="noopener noreferrer">查看已发布评价 ↗</a>
                  </p>
                </template>
                <p
                  v-if="standardLog(rawLog).type === 'job-complete' && !(standardLog(rawLog).evaluations?.length) && standardLog(rawLog).result !== 'already_following'"
                  class="log-detail-text"
                >
                  {{ standardLog(rawLog).grokEnabled === false ? '引用评价未启用，本次仅处理关注。' : (standardLog(rawLog).reason || '此记录未包含引用评价详情。') }}
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
import { logsModalController } from '../composables/useExecutionLogs.js';
import { repairMojibake } from '../../../features/relationships/scoring.js';
import { normalizeQueueExecutionLog } from '../../../shared/execution-log.js';

// Inject reactive state and actions from the controller
const {
  isOpen,
  currentScope,
  fansSubTab,
  isFansScope,
  setFansSubTab,
  status,
  errorMessage,
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
  if (log.scope === 'unreciprocated') return '回关监测';
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
  const map = { fans: '粉丝管理', mutual: '互关追踪', comments: '评论追踪' };
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
      btn.textContent = '已复制！';
      setTimeout(() => { btn.textContent = oldText || '复制'; }, 1800);
    }
  } catch {
    if (btn) {
      btn.textContent = '复制失败';
      setTimeout(() => { btn.textContent = oldText || '复制'; }, 1800);
    }
  }
}
</script>

<style scoped>
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
