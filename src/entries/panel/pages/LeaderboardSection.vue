<template>
  <section
    id="leaderboardSection"
    class="tab-panel leaderboard-panel"
    data-panel="leaderboard"
    :hidden="activeTab !== 'leaderboard'"
    aria-label="X 榜单"
  >
    <!-- Header -->
    <div class="lb-head">
      <div class="lb-heading">
        <div class="lb-title-row">
          <h2>X 榜单</h2>
          <span
            class="lb-owner-badge"
            :title="ownerId ? `当前登录账号 ID: ${ownerId}` : '待识别账号'"
          >
            {{ ownerHandle ? `@${ownerHandle}` : (ownerId ? `账号: ${ownerId}` : '待识别账号') }}
          </span>
          <span
            class="lb-status-badge"
            :class="scanStatusClass"
            :title="scanStatusTitle"
          >
            <span class="lb-status-dot" aria-hidden="true"></span>
            {{ scanStatusLabel }}
          </span>
        </div>
        <p class="lb-subtitle">
          按昨日净增排名 · 定时采集与日报分析
        </p>
      </div>

      <!-- Icon-only actions with hover tips in header -->
      <div class="lb-head-icons">
        <button
          type="button"
          class="secondary lb-icon-btn"
          aria-label="榜单监控设置"
          title="榜单监控设置"
          :disabled="loading || savingSettings || !ownerId"
          @click="openSettings"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/>
            <path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>
          </svg>
        </button>
        <button
          type="button"
          class="secondary lb-icon-btn"
          aria-label="立即扫描快照"
          title="立即扫描快照"
          :disabled="loading || busy"
          @click="triggerScan"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/>
          </svg>
        </button>
        <button
          type="button"
          class="secondary lb-icon-btn"
          aria-label="触发 Grok 日报分析"
          title="触发 Grok 日报分析"
          :disabled="loading || busy || analyzing"
          @click="triggerAnalyze"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <button
          type="button"
          class="secondary lb-icon-btn"
          aria-label="优质帖子日报"
          title="优质帖子日报"
          @click="openReportDrawer"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Toolbar: Search & Summary (统一 height: 30px, line-height: 30px) -->
    <div class="lb-toolbar">
      <div class="lb-search-wrap">
        <input
          v-model="searchQuery"
          type="search"
          placeholder="搜索昵称或 @handle"
          aria-label="搜索榜单账号"
          class="lb-search-input"
        >
      </div>
      <div class="lb-summary-stats">
        <span>已监控 <b>{{ members.length }}</b> 位作者</span>
        <span v-if="filteredMembers.length !== members.length">（筛选出 {{ filteredMembers.length }} 位）</span>
      </div>
    </div>

    <!-- Alerts -->
    <div v-if="error" class="lb-alert lb-alert-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="secondary" @click="fetchState">重试</button>
    </div>
    <div v-if="notice" class="lb-alert lb-alert-info" role="status">
      <span>{{ notice }}</span>
      <button type="button" class="secondary lb-close-notice" @click="notice = ''">×</button>
    </div>

    <!-- Table Container -->
    <div class="lb-table-wrap" :aria-busy="loading">
      <table class="lb-table">
        <thead>
          <tr>
            <th class="th-rank">排名</th>
            <th class="th-account">作者</th>
            <th class="th-metric th-sortable th-followers" @click="changeSort('followers')">
              <button
                type="button"
                class="lb-th-sort is-metric"
                :class="{ 'is-sorted': sortKey === 'followers' }"
                :aria-label="`粉丝总数，点击${sortKey === 'followers' && sortDir === 'desc' ? '升序' : '降序'}`"
              >
                <span>粉丝</span>
                <svg class="lb-sort-icon" viewBox="0 0 10 14" aria-hidden="true">
                  <path d="M5 1 9 6H1Z" :class="{'is-active': sortKey === 'followers' && sortDir === 'asc'}" />
                  <path d="m5 13 4-5H1Z" :class="{'is-active': sortKey === 'followers' && sortDir === 'desc'}" />
                </svg>
              </button>
            </th>
            <th class="th-metric th-sortable th-delta" @click="changeSort('netFollowers')">
              <button
                type="button"
                class="lb-th-sort is-metric"
                :class="{ 'is-sorted': sortKey === 'netFollowers' }"
                :aria-label="`昨日净增，点击${sortKey === 'netFollowers' && sortDir === 'desc' ? '升序' : '降序'}`"
              >
                <span>净增</span>
                <svg class="lb-sort-icon" viewBox="0 0 10 14" aria-hidden="true">
                  <path d="M5 1 9 6H1Z" :class="{'is-active': sortKey === 'netFollowers' && sortDir === 'asc'}" />
                  <path d="m5 13 4-5H1Z" :class="{'is-active': sortKey === 'netFollowers' && sortDir === 'desc'}" />
                </svg>
              </button>
            </th>
            <th class="th-metric th-sortable th-posts" @click="changeSort('posts')">
              <button
                type="button"
                class="lb-th-sort is-metric"
                :class="{ 'is-sorted': sortKey === 'posts' }"
                :aria-label="`昨日发帖，点击${sortKey === 'posts' && sortDir === 'desc' ? '升序' : '降序'}`"
              >
                <span>发帖</span>
                <svg class="lb-sort-icon" viewBox="0 0 10 14" aria-hidden="true">
                  <path d="M5 1 9 6H1Z" :class="{'is-active': sortKey === 'posts' && sortDir === 'asc'}" />
                  <path d="m5 13 4-5H1Z" :class="{'is-active': sortKey === 'posts' && sortDir === 'desc'}" />
                </svg>
              </button>
            </th>
            <th class="th-metric th-sortable th-replies" @click="changeSort('replies')">
              <button
                type="button"
                class="lb-th-sort is-metric"
                :class="{ 'is-sorted': sortKey === 'replies' }"
                :aria-label="`昨日评论，点击${sortKey === 'replies' && sortDir === 'desc' ? '升序' : '降序'}`"
              >
                <span>评论</span>
                <svg class="lb-sort-icon" viewBox="0 0 10 14" aria-hidden="true">
                  <path d="M5 1 9 6H1Z" :class="{'is-active': sortKey === 'replies' && sortDir === 'asc'}" />
                  <path d="m5 13 4-5H1Z" :class="{'is-active': sortKey === 'replies' && sortDir === 'desc'}" />
                </svg>
              </button>
            </th>
            <th class="th-metric th-views" title="昨日采集帖子的公开累计浏览量样本合计，非昨日新增曝光">
              <span>浏览</span>
            </th>
            <th class="th-metric th-top-post" title="7 天最高单帖公开浏览量">
              <span>最高帖</span>
            </th>
            <th class="th-freshness" title="数据快照采集时间">
              <span>采集</span>
            </th>
            <th class="th-status" title="数据同步与覆盖状态">
              <span>状态</span>
            </th>
            <th class="th-actions">
              <span>操作</span>
            </th>
          </tr>
        </thead>
        <tbody v-if="sortedMembers.length > 0">
          <tr v-for="(member, idx) in sortedMembers" :key="member.creatorId || member.handle">
            <!-- Rank -->
            <td class="td-rank">
              <span class="lb-rank-num" :class="`rank-${idx + 1}`">#{{ idx + 1 }}</span>
            </td>
            <!-- Account -->
            <td class="td-account">
              <div class="lb-account-cell">
                <img
                  v-if="member.avatarUrl"
                  :src="member.avatarUrl"
                  class="lb-avatar"
                  alt=""
                  loading="lazy"
                >
                <div v-else class="lb-avatar-placeholder">
                  {{ (member.name || member.handle || '?')[0].toUpperCase() }}
                </div>
                <div class="lb-account-info">
                  <a
                    :href="`https://x.com/${member.handle}`"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="lb-name-link"
                    :title="`${member.name || member.handle} (@${member.handle})`"
                  >
                    <span class="lb-name">{{ member.name || member.handle }}</span>
                  </a>
                  <span class="lb-handle" :title="`@${member.handle}`">@{{ member.handle }}</span>
                </div>
              </div>
            </td>
            <!-- Followers Count -->
            <td class="td-metric td-followers">
              <div class="lb-metric-cell">
                <span class="lb-metric-val">{{ formatNumber(member.followers ?? member.followersCount) }}</span>
              </div>
            </td>
            <!-- Yesterday Net Growth (Snapshot difference) -->
            <td class="td-metric td-delta">
              <div class="lb-metric-cell">
                <template v-if="hasValidDelta(member)">
                  <span
                    class="lb-delta-val"
                    :class="getDelta(member) >= 0 ? 'is-positive' : 'is-negative'"
                  >
                    {{ getDelta(member) >= 0 ? `+${formatNumber(getDelta(member))}` : formatNumber(getDelta(member)) }}
                  </span>
                </template>
                <template v-else-if="member.deltaStatus === 'interval_invalid'">
                  <span class="lb-badge lb-badge-warning" title="两次快照间隔异常（需在18-30小时之间）">间隔异常</span>
                </template>
                <template v-else>
                  <span class="lb-badge lb-badge-muted" title="首次入库或日界快照不足，暂不计入日增">基线不足</span>
                </template>
              </div>
            </td>
            <!-- Yesterday Posts -->
            <td class="td-metric td-posts">
              <div class="lb-metric-cell">
                <template v-if="member.postCount !== null && member.postCount !== undefined">
                  <span class="lb-metric-val">{{ formatNumber(member.postCount) }}</span>
                </template>
                <template v-else-if="member.observedPostCount > 0">
                  <span class="lb-metric-val" title="抓取未覆盖全天，仅代表已知至少发帖">≥{{ formatNumber(member.observedPostCount) }}</span>
                </template>
                <template v-else>
                  <span class="lb-dash">—</span>
                </template>
              </div>
            </td>
            <!-- Yesterday Comments/Replies -->
            <td class="td-metric td-replies">
              <div class="lb-metric-cell">
                <template v-if="member.replyCount !== null && member.replyCount !== undefined">
                  <span class="lb-metric-val">{{ formatNumber(member.replyCount) }}</span>
                </template>
                <template v-else-if="member.observedReplyCount > 0">
                  <span class="lb-metric-val" title="抓取未覆盖全天，仅代表已知至少评论">≥{{ formatNumber(member.observedReplyCount) }}</span>
                </template>
                <template v-else>
                  <span class="lb-dash">—</span>
                </template>
              </div>
            </td>
            <!-- Yesterday Public Views -->
            <td class="td-metric td-views">
              <div class="lb-metric-cell">
                <template v-if="member.viewsTotal !== null && member.viewsTotal !== undefined">
                  <span class="lb-metric-val">{{ formatNumber(member.viewsTotal) }}</span>
                </template>
                <template v-else>
                  <span class="lb-dash" title="第三方公开浏览量字段不可用或私有">—</span>
                </template>
              </div>
            </td>
            <!-- 7d Top Post -->
            <td class="td-metric td-top-post">
              <div class="lb-metric-cell">
                <a
                  v-if="getTopPost(member)"
                  :href="getTopPostUrl(member)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="lb-top-metric-link"
                  :title="`在 X 打开原帖（${formatNumber(getTopPost(member).metrics?.views)} 浏览）`"
                >
                  <span class="lb-metric-val">{{ formatNumber(getTopPost(member).metrics?.views) }}</span>
                </a>
                <span v-else class="lb-dash">—</span>
              </div>
            </td>
            <!-- Freshness -->
            <td class="td-freshness">
              <div class="lb-freshness-cell">
                <span class="lb-time" :title="formatDate(member.lastCapturedAt || member.updatedAt)">
                  {{ formatTimeAgo(member.lastCapturedAt || member.updatedAt) }}
                </span>
              </div>
            </td>
            <!-- Status -->
            <td class="td-status">
              <div class="lb-status-cell">
                <span
                  v-if="member.lastError"
                  class="lb-badge lb-badge-danger"
                  :title="member.lastError"
                >异常</span>
                <span
                  v-else-if="member.followersState === 'stale' || member.followersFreshness === 'stale'"
                  class="lb-badge lb-badge-warning"
                  title="快照已过期，等待下轮采集"
                >过期</span>
                <span
                  v-else-if="member.postCoverage === 'partial'"
                  class="lb-badge lb-badge-warning"
                  title="部分覆盖：部分帖子或回复未完全分页"
                >部分</span>
                <span
                  v-else-if="member.postCoverage === 'complete'"
                  class="lb-badge lb-badge-success"
                  title="快照与帖子已完整同步"
                >完整</span>
                <span
                  v-else
                  class="lb-badge lb-badge-muted"
                  title="快照已记录，等待全量同步"
                >就绪</span>
              </div>
            </td>
            <!-- Actions -->
            <td class="td-actions">
              <div class="lb-actions-cell">
                <button
                  type="button"
                  class="secondary lb-detail-btn"
                  :aria-label="'查看 @' + member.handle + ' 详情'"
                  @click="openMemberDetails(member)"
                >详情</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Empty State -->
      <div v-if="!loading && sortedMembers.length === 0" class="lb-empty-state">
        <p class="lb-empty-title">{{ searchQuery ? '未找到匹配的作者' : '暂无榜单成员' }}</p>
        <p class="lb-empty-desc">
          {{ searchQuery ? '请尝试更换搜索词。' : '在 X.com 任意帖子的操作栏点击灰色的 X 图标，即可将作者加入榜单监控。' }}
        </p>
      </div>

      <!-- Loading State -->
      <div v-if="loading && sortedMembers.length === 0" class="lb-loading-state" role="status">
        <span class="dash-spinner" aria-hidden="true"></span>
        <span>正在读取 X 榜单数据…</span>
      </div>
    </div>

    <ActionSettingsDrawer ref="settingsDrawer" title="榜单监控设置">
      <div class="lb-setting-card">
        <label class="lb-setting-row">
          <span class="lb-setting-copy"><strong>自动监控</strong><small>定时更新作者快照与帖子数据</small></span>
          <input v-model="settingsDraft.enabled" type="checkbox" :disabled="savingSettings" aria-label="自动监控">
        </label>
        <label class="lb-setting-row">
          <span class="lb-setting-copy"><strong>扫描间隔</strong><small>每次自动扫描之间的时间</small></span>
          <span class="lb-setting-number"><input v-model.number="settingsDraft.scanIntervalMinutes" type="number" min="15" max="360" step="1" :disabled="savingSettings" aria-label="扫描间隔分钟">分钟</span>
        </label>
        <label class="lb-setting-row">
          <span class="lb-setting-copy"><strong>每轮人数</strong><small>每轮最多扫描 1–5 位作者</small></span>
          <span class="lb-setting-number"><input v-model.number="settingsDraft.scanBatchSize" type="number" min="1" max="5" step="1" :disabled="savingSettings" aria-label="每轮扫描人数">位</span>
        </label>
        <label class="lb-setting-row">
          <span class="lb-setting-copy"><strong>自动日报</strong><small>扫描后继续生成昨日 Grok 分析</small></span>
          <input v-model="settingsDraft.autoAnalyze" type="checkbox" :disabled="savingSettings" aria-label="自动生成日报">
        </label>
      </div>
      <p class="lb-setting-note">暂停后仍可手动扫描和分析；设置仅用于当前登录账号。</p>
      <p v-if="settingsError" class="lb-alert lb-alert-error" role="alert">{{ settingsError }}</p>
      <template #footer>
        <button type="button" class="secondary" :disabled="savingSettings" @click="settingsDrawer?.close()">取消</button>
        <button type="button" :disabled="savingSettings" @click="saveSettings">{{ savingSettings ? '保存中…' : '保存配置' }}</button>
      </template>
    </ActionSettingsDrawer>

    <ActionSettingsDrawer ref="memberDrawer" title="作者详情">
      <div v-if="selectedMember" class="lb-member-detail">
        <h3>{{ selectedMember.name || selectedMember.handle }} <small>@{{ selectedMember.handle }}</small></h3>
        <dl>
          <dt>粉丝总数</dt><dd>{{ formatNumber(selectedMember.followers ?? selectedMember.followersCount) }}</dd>
          <dt>昨日快照净增</dt><dd>{{ hasValidDelta(selectedMember) ? (getDelta(selectedMember) >= 0 ? `+${formatNumber(getDelta(selectedMember))}` : formatNumber(getDelta(selectedMember))) : (selectedMember.deltaStatus === 'interval_invalid' ? '两次快照间隔异常' : '基线不足') }}</dd>
          <dt>昨日基线</dt><dd>{{ formatDate(selectedMember.deltaEvidence?.before?.at) }}</dd>
          <dt>今日基线</dt><dd>{{ formatDate(selectedMember.deltaEvidence?.after?.at) }}</dd>
          <dt>昨日发帖</dt><dd>{{ selectedMember.postCount == null ? (selectedMember.observedPostCount > 0 ? '至少 ' : '') : '' }}{{ formatNumber(selectedMember.postCount ?? selectedMember.observedPostCount) }}</dd>
          <dt>昨日评论</dt><dd>{{ selectedMember.replyCount == null ? (selectedMember.observedReplyCount > 0 ? '至少 ' : '') : '' }}{{ formatNumber(selectedMember.replyCount ?? selectedMember.observedReplyCount) }}</dd>
          <dt>公开浏览样本</dt><dd>{{ formatNumber(selectedMember.viewsTotal) }}（采样时累计值）</dd>
          <dt>最后采集</dt><dd>{{ formatDate(selectedMember.lastCapturedAt || selectedMember.updatedAt) }}</dd>
          <dt>同步与覆盖</dt><dd>{{ selectedMember.postCoverage === 'complete' ? '完整同步' : (selectedMember.postCoverage === 'partial' ? '部分覆盖' : '快照已记录') }}</dd>
          <dt v-if="selectedMember.followersState === 'stale' || selectedMember.followersFreshness === 'stale'">快照状态</dt>
          <dd v-if="selectedMember.followersState === 'stale' || selectedMember.followersFreshness === 'stale'">快照已过期，等待下轮采集</dd>
        </dl>
        <p v-if="selectedMember.lastError" class="lb-alert lb-alert-error">{{ selectedMember.lastError }}</p>
        <h4>7 天最高单帖样本</h4>
        <template v-if="getTopPost(selectedMember)">
          <p>{{ formatNumber(getTopPost(selectedMember).metrics?.views) }} 浏览 · {{ formatDate(getTopPost(selectedMember).createdAt) }}</p>
          <p class="lb-detail-post">{{ getTopPost(selectedMember).text }}</p>
          <a :href="getTopPostUrl(selectedMember)" target="_blank" rel="noopener noreferrer">在 X 查看原帖</a>
        </template>
        <p v-else>暂无可用帖子样本</p>
        <div class="lb-detail-actions">
                <a
                  :href="`https://x.com/${selectedMember.handle}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="secondary lb-icon-btn"
                  title="在 X 打开主页"
                  aria-label="在 X 打开主页"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>
                  </svg>
                </a>
                <button
                  type="button"
                  class="secondary lb-icon-btn"
                  title="查看该作者日报片段"
                  aria-label="查看该作者日报片段"
                  @click="viewAuthorSnippet(selectedMember)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                  </svg>
                </button>
                <button
                  type="button"
                  class="secondary lb-icon-btn lb-btn-remove"
                  title="移出 X 榜单"
                  aria-label="移出 X 榜单"
                  :disabled="busy"
                  @click="removeMember(selectedMember)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>
                  </svg>
                </button>
              </div>
      </div>
    </ActionSettingsDrawer>

    <!-- Daily Report Drawer -->
    <ActionSettingsDrawer ref="reportDrawer" title="优质帖子日报" @close="activeAuthorFilter = ''">
      <!-- Report Date Tabs / Selector -->
      <div class="lb-report-header">
        <div class="lb-report-dates">
          <label class="lb-date-picker-label">
            <span>选择日期</span>
            <select v-model="selectedReportDate" aria-label="日报日期" @change="loadSelectedReport">
              <option v-for="d in availableReportDates" :key="d" :value="d">{{ d }}</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          class="secondary lb-analyze-btn"
          :disabled="analyzing || busy || currentReport?.status === 'completed' || selectedReportDate !== new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10)"
          title="仅继续处理昨日未完成任务；完整日报不会重跑"
          @click="triggerAnalyze"
        >
          {{ analyzing ? '处理中…' : currentReport?.status === 'completed' ? '已完成' : currentReport ? '继续分析' : '开始分析' }}
        </button>
      </div>

      <!-- Report Content -->
      <div v-if="reportLoading" class="lb-report-loading" role="status">
        <span class="dash-spinner" aria-hidden="true"></span>
        <span>正在读取日报…</span>
      </div>
      <div v-else-if="currentReport" class="lb-report-body">
        <!-- Report Meta Banner -->
        <div class="lb-report-meta-card">
          <div class="lb-report-meta-row">
            <span class="lb-meta-item"><b>分析日期：</b>{{ currentReport.date || selectedReportDate }}</span>
            <span class="lb-meta-item"><b>状态：</b></span>
            <span
              class="lb-badge"
              :class="reportStatusClass(currentReport.status)"
            >
              {{ reportStatusLabel(currentReport.status) }}
            </span>
            <span v-if="currentReport.completedAt" class="lb-meta-item">
              <b>完成时间：</b>{{ formatDate(currentReport.completedAt) }}
            </span>
          </div>
          <div v-if="currentReport.summary" class="lb-overall-summary">
            <b>跨账号写法观察：</b>
            <p v-if="typeof currentReport.summary === 'string'">{{ currentReport.summary }}</p>
            <ul v-if="currentReport.summary?.conclusions?.length" class="lb-patterns-list">
              <li v-for="(p, pIdx) in currentReport.summary.conclusions" :key="pIdx">{{ p.text }}</li>
            </ul>
            <p v-if="currentReport.summary?.limitations">局限：{{ currentReport.summary.limitations }}</p>
          </div>
          <p v-if="currentReport.error" class="lb-report-error">
            {{ currentReport.error }}
          </p>
          <div v-if="activeAuthorFilter" class="lb-report-filter-bar">
            <span>当前筛选作者：@{{ activeAuthorFilter }}</span>
            <button type="button" class="secondary" @click="activeAuthorFilter = ''">查看全部作者</button>
          </div>
        </div>

        <!-- Top Authors Cards -->
        <div v-if="reportAuthorsList.length > 0" class="lb-authors-list">
          <div
            v-for="(author, aIdx) in reportAuthorsList"
            :key="author.creatorId || author.handle || aIdx"
            class="lb-author-card"
          >
            <div class="lb-author-card-head">
              <div class="lb-author-info">
                <span class="lb-author-rank">#{{ aIdx + 1 }}</span>
                <span class="lb-author-name">{{ author.name || author.handle }}</span>
                <a
                  :href="`https://x.com/${author.handle}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="lb-author-handle"
                >@{{ author.handle }}</a>
                <span v-if="author.delta !== undefined && author.delta !== null" class="lb-stat-pill">
                  昨日涨粉 {{ author.delta >= 0 ? `+${author.delta}` : author.delta }}
                </span>
              </div>
              <div class="lb-author-stats">
                <span v-if="author.coverage" class="lb-stat-pill">
                  采样 {{ author.coverage.sampled || 0 }} 帖 (共 {{ author.coverage.postCount || 0 }} 原帖 / {{ author.coverage.replyCount || 0 }} 回复)
                </span>
                <span class="lb-stat-pill">已分析 {{ author.analyzedCount }} 帖</span>
              </div>
            </div>

            <!-- Author Grok Highlights -->
            <div v-if="author.items?.length" class="lb-posts-list">
              <div
                v-for="item in author.items"
                :key="item.postId"
                class="lb-post-card"
              >
                <div class="lb-post-grok-box">
                  <span class="lb-grok-tag">Grok 亮点提炼</span>
                  <p class="lb-grok-text">{{ item.highlights || item.reason }}</p>
                </div>
                <p v-if="item.post?.text" class="lb-post-text">{{ item.post.text }}</p>
                <div class="lb-post-footer">
                  <div class="lb-post-metrics">
                    <span v-if="Number.isFinite(item.post?.metrics?.views)">公开浏览 {{ formatNumber(item.post.metrics.views) }}</span>
                    <span v-if="Number.isFinite(item.post?.metrics?.likes)">点赞 {{ formatNumber(item.post.metrics.likes) }}</span>
                    <span v-if="Number.isFinite(item.post?.metrics?.reposts)">转帖 {{ formatNumber(item.post.metrics.reposts) }}</span>
                    <span v-if="Number.isFinite(item.post?.metrics?.replies)">评论 {{ formatNumber(item.post.metrics.replies) }}</span>
                  </div>
                  <a
                    :href="item.post?.url || `https://x.com/${author.handle}/status/${item.postId}`"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="lb-post-link"
                  >
                    查看原帖 ↗
                  </a>
                </div>
              </div>
            </div>
            <div v-else-if="author.coverage?.error" class="lb-grok-empty">
              <small>{{ author.coverage.error }}</small>
            </div>
            <div v-else class="lb-grok-empty">
              <small>该作者昨日未采集到符合标准的优质帖子或仍在排队分析。</small>
            </div>
          </div>
        </div>
        <div v-else class="lb-empty-report">
          <p>该日期暂无入选前 10 名的作者数据。</p>
        </div>
      </div>
      <div v-else class="lb-empty-report">
        <p>暂无该日期的日报数据，请点击上方“触发分析”进行抓取与 Grok 评估。</p>
      </div>

      <template #footer>
        <button type="button" class="secondary" @click="closeReportDrawer">关闭</button>
      </template>
    </ActionSettingsDrawer>
  </section>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import ActionSettingsDrawer from '../components/ActionSettingsDrawer.vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';

const { activeTab } = panelNavigationController;

const members = ref([]);
const reports = ref([]);
const ownerId = ref('');
const ownerHandle = ref('');
const scanStatus = ref({});
const config = ref({ enabled: true, scanIntervalMinutes: 60, scanBatchSize: 3, autoAnalyze: true });
const settingsDrawer = ref(null);
const settingsDraft = reactive({ ...config.value });
const savingSettings = ref(false);
const settingsError = ref('');

const loading = ref(false);
const busy = ref(false);
const analyzing = ref(false);
const error = ref('');
const notice = ref('');

const searchQuery = ref('');
const sortKey = ref('netFollowers'); // Default sort: yesterday net delta
const sortDir = ref('desc');

const memberDrawer = ref(null);
const selectedMember = ref(null);
function openMemberDetails(member) { selectedMember.value = member; memberDrawer.value?.open(); }
const reportDrawer = ref(null);
const selectedReportDate = ref('');
const currentReport = ref(null);
const reportLoading = ref(false);
const activeAuthorFilter = ref('');

// Scan status computed
const scanStatusLabel = computed(() => {
  if (busy.value) return '操作中…';
  if (!config.value.enabled) return '已暂停';
  if (scanStatus.value?.nextAt) {
    const diff = scanStatus.value.nextAt - Date.now();
    if (diff > 0 && diff < 60000) return '即将轮询';
  }
  return '监控中';
});

const scanStatusClass = computed(() => {
  if (busy.value) return 'is-running';
  if (!config.value.enabled) return 'is-paused';
  return 'is-idle';
});

const scanStatusTitle = computed(() => {
  if (!config.value.enabled) return '自动监控已暂停，可手动扫描和分析';
  if (scanStatus.value?.nextAt) {
    return `下次计划扫描：${formatDate(scanStatus.value.nextAt)}`;
  }
  return '定时轮询快照与指标';
});

function hasValidDelta(member) {
  return member.deltaStatus === 'valid' && typeof member.delta === 'number';
}

function getDelta(member) {
  return member.delta;
}

function getTopPost(member) {
  return member.maxPost7d || member.maxPost || null;
}

function getTopPostUrl(member) {
  const p = getTopPost(member);
  if (!p) return '#';
  return p.url || `https://x.com/${member.handle}/status/${p.postId}`;
}

// Filtered members by search
const filteredMembers = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return members.value;
  return members.value.filter(m =>
    (m.handle && m.handle.toLowerCase().includes(q)) ||
    (m.name && m.name.toLowerCase().includes(q))
  );
});

// Sorted members
const sortedMembers = computed(() => {
  const list = filteredMembers.value.slice();
  list.sort((a, b) => {
    if (sortKey.value === 'netFollowers') {
      const aValid = hasValidDelta(a);
      const bValid = hasValidDelta(b);
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      if (!aValid && !bValid) return 0;
      return sortDir.value === 'desc' ? b.delta - a.delta : a.delta - b.delta;
    }
    if (sortKey.value === 'followers') {
      const aVal = a.followers ?? a.followersCount ?? -1;
      const bVal = b.followers ?? b.followersCount ?? -1;
      return sortDir.value === 'desc' ? bVal - aVal : aVal - bVal;
    }
    if (sortKey.value === 'posts') {
      const aVal = a.postCount ?? a.observedPostCount ?? -1;
      const bVal = b.postCount ?? b.observedPostCount ?? -1;
      return sortDir.value === 'desc' ? bVal - aVal : aVal - bVal;
    }
    if (sortKey.value === 'replies') {
      const aVal = a.replyCount ?? a.observedReplyCount ?? -1;
      const bVal = b.replyCount ?? b.observedReplyCount ?? -1;
      return sortDir.value === 'desc' ? bVal - aVal : aVal - bVal;
    }
    return 0;
  });
  return list;
});

function changeSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc';
  } else {
    sortKey.value = key;
    sortDir.value = 'desc';
  }
}

// Available report dates
const availableReportDates = computed(() => {
  const dates = new Set([new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10)]);
  reports.value.forEach(r => {
    if (typeof r === 'string') dates.add(r);
    else if (r?.date) dates.add(r.date);
  });
  return Array.from(dates).sort().reverse();
});

// Report authors list combining members, coverage, samples and Grok items
const reportAuthorsList = computed(() => {
  if (!currentReport.value) return [];
  const rep = currentReport.value;
  const authorList = rep.members || [];
  const res = authorList.map(m => {
    const coverage = rep.coverage?.find(c => c.creatorId === m.creatorId);
    const analyzed = (rep.items || []).filter(it => it.authorId === m.creatorId || it.handle === m.handle);
    const items = analyzed.filter(it => it.quality === 'high').map(it => {
      const sample = rep.samples?.find(s => s.postId === it.postId);
      return { ...it, post: sample || null };
    });
    return {
      ...m,
      coverage,
      analyzedCount:analyzed.length,
      items
    };
  });
  if (!activeAuthorFilter.value) return res;
  return res.filter(a => (a.handle || '').toLowerCase() === activeAuthorFilter.value.toLowerCase());
});

// Actions
function openSettings() {
  Object.assign(settingsDraft, config.value);
  settingsError.value = '';
  settingsDrawer.value?.open();
}

async function saveSettings() {
  settingsError.value = '';
  const values = { ...settingsDraft };
  if (!Number.isInteger(values.scanIntervalMinutes) || values.scanIntervalMinutes < 15 || values.scanIntervalMinutes > 360) {
    settingsError.value = '扫描间隔需为 15–360 分钟的整数';
    return;
  }
  if (!Number.isInteger(values.scanBatchSize) || values.scanBatchSize < 1 || values.scanBatchSize > 5) {
    settingsError.value = '每轮人数需为 1–5 的整数';
    return;
  }
  savingSettings.value = true;
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'xLeaderboard', action: 'settings', config: values });
    if (!res?.ok) throw new Error(res?.error || '保存榜单配置失败');
    config.value = res.config;
    await fetchState();
    settingsDrawer.value?.close();
    notice.value = '榜单监控配置已保存。';
  } catch (err) {
    settingsError.value = String(err?.message || err || '保存榜单配置失败');
  } finally {
    savingSettings.value = false;
  }
}

async function fetchState() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  loading.value = true;
  error.value = '';
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'xLeaderboard', action: 'state' });
    if (res?.ok) {
      members.value = Array.isArray(res.members) ? res.members : [];
      reports.value = Array.isArray(res.reports) ? res.reports : [];
      ownerId.value = res.ownerId || '';
      ownerHandle.value = res.ownerHandle || '';
      scanStatus.value = res.scanStatus || {};
      config.value = res.config || config.value;
      if (!selectedReportDate.value && availableReportDates.value.length > 0) {
        selectedReportDate.value = availableReportDates.value[0];
      }
    } else {
      error.value = res?.error || '无法获取榜单状态';
    }
  } catch (err) {
    error.value = String(err?.message || err || '无法连接后台');
  } finally {
    loading.value = false;
  }
}

async function triggerScan() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  busy.value = true;
  notice.value = '正在扫描榜单作者快照…';
  error.value = '';
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'xLeaderboard', action: 'scan' });
    if (res?.ok) {
      notice.value = '快照扫描完成。';
      await fetchState();
    } else {
      error.value = res?.error || '扫描执行失败';
    }
  } catch (err) {
    error.value = String(err?.message || err || '扫描请求异常');
  } finally {
    busy.value = false;
    setTimeout(() => { if (notice.value === '快照扫描完成。') notice.value = ''; }, 3500);
  }
}

async function triggerAnalyze() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  analyzing.value = true;
  notice.value = '已提交 Grok 分析任务，正在评估昨日优质帖子…';
  error.value = '';
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'xLeaderboard', action: 'analyze' });
    if (res?.ok) {
      const status=res.report?.status;
      notice.value=status==='completed'?'昨日日报已完成。':status==='baseline_missing'?'缺少两日有效粉丝快照，日报暂不能生成。':'日报进度已保存，将分批继续采集或分析。';
      await fetchState();
      if (selectedReportDate.value) {
        await loadSelectedReport();
      }
    } else {
      error.value = res?.error || 'Grok 分析失败';
    }
  } catch (err) {
    error.value = String(err?.message || err || '分析请求异常');
  } finally {
    analyzing.value = false;
    setTimeout(() => { if (notice.value === '昨日日报已完成。') notice.value = ''; }, 3500);
  }
}

async function loadSelectedReport() {
  if (!selectedReportDate.value || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  reportLoading.value = true;
  try {
    const res = await chrome.runtime.sendMessage({
      cmd: 'xLeaderboard',
      action: 'report',
      date: selectedReportDate.value
    });
    if (res?.ok) {
      currentReport.value = res.report || null;
    } else {
      currentReport.value = null;
    }
  } catch {
    currentReport.value = null;
  } finally {
    reportLoading.value = false;
  }
}

async function removeMember(member) {
  if (!confirm(`确定将 @${member.handle} 移出 X 榜单？历史快照和日报将保留。`)) return;
  busy.value = true;
  try {
    const res = await chrome.runtime.sendMessage({
      cmd: 'xLeaderboard',
      action: 'remove',
      handle: member.handle
    });
    if (res?.ok) {
      members.value = members.value.filter(m => m.handle !== member.handle);
      notice.value = `已将 @${member.handle} 移出 X 榜单。`;
    } else {
      error.value = res?.error || '移出操作失败';
    }
  } catch (err) {
    error.value = String(err?.message || err || '移出异常');
  } finally {
    busy.value = false;
    setTimeout(() => { if (notice.value.includes('移出')) notice.value = ''; }, 3000);
  }
}

function viewAuthorSnippet(member) {
  activeAuthorFilter.value = member.handle;
  openReportDrawer();
}

function openReportDrawer() {
  reportDrawer.value?.open();
  if (selectedReportDate.value) {
    loadSelectedReport();
  }
}

function closeReportDrawer() {
  reportDrawer.value?.close();
  activeAuthorFilter.value = '';
}

// Helpers
function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return Number(num).toLocaleString();
}

function formatDate(isoOrTs) {
  if (!isoOrTs) return '—';
  try {
    const d = new Date(isoOrTs);
    if (isNaN(d.getTime())) return String(isoOrTs);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return String(isoOrTs);
  }
}

function formatTimeAgo(isoOrTs) {
  if (!isoOrTs) return '未采集';
  try {
    const d = new Date(isoOrTs);
    const diffMs = Date.now() - d.getTime();
    if (isNaN(diffMs)) return '—';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
  } catch {
    return '—';
  }
}

function reportStatusLabel(status) {
  switch (status) {
    case 'completed': return '完整';
    case 'partial': return '部分完成';
    case 'baseline_missing': return '暂无有效快照';
    case 'collecting': return '采集帖子中';
    case 'running': return 'Grok 分析中';
    case 'failed': return '分析失败';
    default: return status || '待生成';
  }
}

function reportStatusClass(status) {
  switch (status) {
    case 'completed': return 'lb-badge-success';
    case 'partial': return 'lb-badge-warning';
    case 'baseline_missing': return 'lb-badge-muted';
    case 'collecting':
    case 'running': return 'lb-badge-running';
    case 'failed': return 'lb-badge-danger';
    default: return 'lb-badge-muted';
  }
}

watch(activeTab, tab => {
  if (tab === 'leaderboard') fetchState();
});

onMounted(() => {
  if (activeTab.value === 'leaderboard') fetchState();
});
</script>

<style scoped>
.leaderboard-panel {
  --lb-space: 10px;
  --lb-control-height: 30px;
  --lb-border: #dce7df;
  padding: var(--lb-space);
  color: #18302e;
  background: #fff;
  border: 1px solid var(--lb-border);
  border-radius: 10px;
  box-sizing: border-box;
}

#leaderboardSection {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  max-height: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow: hidden;
}

#leaderboardSection[hidden] {
  display: none;
}

/* 统一规范：组件高统一 30px，line-height: 30px，padding: 0 10px */
.leaderboard-panel button,
.leaderboard-panel select,
.leaderboard-panel input:not([type="checkbox"]) {
  display: inline-block;
  height: var(--lb-control-height);
  min-height: var(--lb-control-height);
  max-height: var(--lb-control-height);
  box-sizing: border-box;
  font-size: 12px;
  line-height: var(--lb-control-height);
  padding: 0 10px;
  border-radius: 6px;
  vertical-align: middle;
}

.leaderboard-panel button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* Header */
.lb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  flex-shrink: 0;
}

.lb-heading h2 {
  font-size: 14px;
  line-height: var(--lb-control-height);
  height: var(--lb-control-height);
  margin: 0;
  font-weight: 700;
  color: #18302e;
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
}

.lb-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.lb-subtitle {
  margin: 4px 0 0;
  font-size: 11px;
  color: #63766a;
  line-height: 18px;
}

.lb-owner-badge {
  display: inline-flex;
  align-items: center;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  font-size: 12px;
  color: #245b45;
  background: #eef4ef;
  padding: 0 10px;
  border-radius: 6px;
  box-sizing: border-box;
  vertical-align: middle;
}

.lb-status-badge {
  display: inline-flex;
  align-items: center;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  font-size: 12px;
  padding: 0 10px;
  border-radius: 6px;
  background: #f0f3f1;
  color: #63766a;
  box-sizing: border-box;
  vertical-align: middle;
}

.lb-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 6px;
  background: #63766a;
}

.lb-status-badge.is-running .lb-status-dot {
  background: #1d9bf0;
  animation: lb-pulse 1.5s infinite;
}

.lb-status-badge.is-idle .lb-status-dot {
  background: #14744c;
}

.lb-status-badge.is-paused .lb-status-dot {
  background: #89978e;
}

.lb-setting-card {
  border: 1px solid var(--lb-border);
  border-radius: 8px;
  overflow: hidden;
}

.lb-setting-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  min-height: 66px;
  padding: 10px 12px;
  box-sizing: border-box;
}

.lb-setting-row:not(:last-child) {
  border-bottom: 1px solid #e7eee8;
}

.lb-setting-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-right: 10px;
}

.lb-setting-copy strong {
  font-size: 12px;
  line-height: 18px;
}

.lb-setting-copy small {
  color: #63766a;
  font-size: 11px;
  line-height: 16px;
}

.lb-setting-number {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: #63766a;
  font-size: 11px;
}

.lb-setting-number input {
  width: 74px;
  margin-right: 6px;
  text-align: right;
}

.lb-setting-row input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  flex-shrink: 0;
  accent-color: #14744c;
}

.lb-setting-note {
  margin: 10px 0;
  color: #63766a;
  font-size: 11px;
  line-height: 1.5;
}

@keyframes lb-pulse {
  0% { opacity: 0.4; }
  50% { opacity: 1; }
  100% { opacity: 0.4; }
}

.lb-head-icons {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.lb-icon-btn {
  width: var(--lb-control-height);
  min-width: var(--lb-control-height);
  max-width: var(--lb-control-height);
  height: var(--lb-control-height);
  min-height: var(--lb-control-height);
  max-height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  box-sizing: border-box;
  padding: 0;
  border-radius: 6px;
  border: 1px solid var(--lb-border);
  background: transparent;
  color: #63766a;
  cursor: pointer;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  vertical-align: middle;
}

.lb-icon-btn svg {
  display: block;
  width: 16px;
  height: 16px;
  min-width: 16px;
  max-width: 16px;
  min-height: 16px;
  max-height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lb-icon-btn:hover:not(:disabled) {
  background: #eef4ef;
  color: #245b45;
  border-color: #245b45;
}

.lb-icon-btn:focus-visible {
  outline: 2px solid #245b45;
}

.lb-btn-remove:hover:not(:disabled) {
  background: #fff0f1;
  color: #a52e3c;
  border-color: #e9b3a9;
}

/* Toolbar */
.lb-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  flex-shrink: 0;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
}

.lb-search-wrap {
  flex: 0 1 260px;
}

.lb-search-input {
  width: 100%;
  height: var(--lb-control-height);
  min-height: var(--lb-control-height);
  max-height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  padding: 0 10px;
  border: 1px solid var(--lb-border);
  border-radius: 6px;
  font-size: 12px;
  box-sizing: border-box;
  vertical-align: middle;
}

.lb-search-input:focus {
  outline: 2px solid #245b45;
  border-color: transparent;
}

.lb-summary-stats {
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  color: #63766a;
  vertical-align: middle;
}

/* Alerts */
.lb-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  margin-bottom: 10px;
  border-radius: 6px;
  font-size: 12px;
  flex-shrink: 0;
  box-sizing: border-box;
}

.lb-alert-error {
  background: #fff2f2;
  color: #a52e3c;
  border: 1px solid #ffd4d4;
}

.lb-alert-info {
  background: #eef6f2;
  color: #245b45;
  border: 1px solid #d6eadc;
}

.lb-close-notice {
  background: transparent;
  border: 0;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}

/* Table Wrap */
.lb-table-wrap {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: #fff;
  border: 1px solid var(--lb-border);
  border-radius: 8px;
}

.lb-table {
  width: 100%;
  min-width: 0;
  table-layout: fixed;
  border-collapse: collapse;
  text-align: left;
  font-size: 12px;
}

.lb-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: var(--lb-control-height);
  min-height: var(--lb-control-height);
  max-height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  box-sizing: border-box;
  padding: 0 8px;
  border-bottom: 0;
  box-shadow: inset 0 -1px 0 #e7eee8;
  background: #f0f5ef;
  color: #4e6558;
  font-size: 12px;
  font-weight: 600;
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lb-table td {
  padding: 0 8px;
  height: 38px;
  min-height: 38px;
  box-sizing: border-box;
  border-bottom: 1px solid #e7eee8;
  vertical-align: middle;
  overflow: hidden;
}

.lb-table tbody tr:hover {
  background: #f8fbf8;
}

/* Column Alignments & Stable Widths */
.th-rank, .td-rank {
  width: 44px;
  min-width: 44px;
  max-width: 44px;
  text-align: center;
  padding: 0 4px;
}

.lb-rank-num {
  font-weight: 700;
  color: #63766a;
  line-height: var(--lb-control-height);
  display: inline-block;
}

.lb-rank-num.rank-1 { color: #d49514; font-size: 13px; }
.lb-rank-num.rank-2 { color: #8899a6; font-size: 13px; }
.lb-rank-num.rank-3 { color: #cd7f32; font-size: 13px; }

.th-account, .td-account {
  width: 24%;
  min-width: 130px;
  text-align: left;
  padding: 0 10px;
}

.lb-account-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  height: 100%;
}

.lb-avatar, .lb-avatar-placeholder {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  flex-shrink: 0;
  display: block;
}

.lb-avatar {
  object-fit: cover;
}

.lb-avatar-placeholder {
  background: #e2e8e3;
  color: #4e6558;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 11px;
}

.lb-account-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  line-height: 1.25;
}

.lb-name-link {
  display: block;
  text-decoration: none;
  color: #18302e;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lb-name-link:hover {
  text-decoration: underline;
  color: #245b45;
}

.lb-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lb-handle {
  display: block;
  font-size: 11px;
  color: #63766a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Sortable Headers */
.th-sortable {
  cursor: pointer;
  user-select: none;
}

.lb-th-sort {
  width: 100%;
  height: var(--lb-control-height);
  min-height: var(--lb-control-height);
  max-height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  box-sizing: border-box;
}

.lb-th-sort.is-metric {
  justify-content: flex-end;
}

.lb-th-sort.is-sorted {
  color: #245b45;
  font-weight: 700;
}

.lb-sort-icon {
  width: 10px;
  height: 14px;
  margin-left: 4px;
  flex-shrink: 0;
  fill: currentColor;
  vertical-align: middle;
}

.lb-sort-icon path {
  opacity: .3;
}

.lb-sort-icon path.is-active {
  opacity: 1;
}

/* Metric columns (one metric per column, right aligned, stable widths) */
.th-metric, .td-metric {
  width: auto;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  vertical-align: middle;
  padding: 0 8px;
}

.lb-metric-cell {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 100%;
  height: 100%;
  white-space: nowrap;
}

.lb-metric-val {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: #18302e;
  line-height: var(--lb-control-height);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lb-delta-val {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: var(--lb-control-height);
  white-space: nowrap;
}

.lb-delta-val.is-positive {
  color: #14744c;
}

.lb-delta-val.is-negative {
  color: #a52e3c;
}

.lb-top-metric-link {
  text-decoration: none;
  color: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
}

.lb-top-metric-link:hover .lb-metric-val {
  color: #245b45;
  text-decoration: underline;
}

.lb-dash {
  color: #99a89e;
  line-height: var(--lb-control-height);
  white-space: nowrap;
}

/* Freshness Column */
.th-freshness, .td-freshness {
  width: 68px;
  min-width: 68px;
  max-width: 76px;
  text-align: right;
  padding: 0 8px;
  vertical-align: middle;
}

.lb-freshness-cell {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 100%;
  height: 100%;
  white-space: nowrap;
}

.lb-time {
  font-size: 11px;
  color: #63766a;
  white-space: nowrap;
}

/* Status Column */
.th-status, .td-status {
  width: 60px;
  min-width: 60px;
  max-width: 66px;
  text-align: center;
  padding: 0 6px;
  vertical-align: middle;
}

.lb-status-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  white-space: nowrap;
}

/* Actions Column */
.th-actions, .td-actions {
  width: 56px;
  min-width: 56px;
  max-width: 60px;
  text-align: center;
  padding: 0 6px;
  vertical-align: middle;
}

.lb-actions-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  white-space: nowrap;
}

.lb-detail-btn {
  height: 24px;
  min-height: 24px;
  max-height: 24px;
  line-height: 22px;
  padding: 0 8px;
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}

/* Badges */
.lb-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  line-height: 20px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  vertical-align: middle;
  box-sizing: border-box;
}

.lb-badge-success { background: #e7f5eb; color: #14744c; }
.lb-badge-warning { background: #fdf6e2; color: #976417; }
.lb-badge-running { background: #e8f5fd; color: #1d9bf0; }
.lb-badge-danger { background: #fff0f1; color: #a52e3c; }
.lb-badge-muted { background: #f0f3f1; color: #69766c; }

/* Empty & Loading States */
.lb-empty-state, .lb-loading-state {
  padding: 30px 10px;
  text-align: center;
  color: #63766a;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.lb-empty-title {
  font-size: 13px;
  font-weight: 600;
  color: #18302e;
  margin: 0;
  line-height: var(--lb-control-height);
}

.lb-empty-desc {
  font-size: 12px;
  margin: 0;
  max-width: 440px;
  line-height: 1.5;
}

/* Daily Report Drawer Styles */
.lb-report-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--lb-border);
  height: var(--lb-control-height);
}

.lb-date-picker-label {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
}

.lb-date-picker-label select {
  margin: 0;
  height: var(--lb-control-height);
  min-height: var(--lb-control-height);
  max-height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  padding: 0 10px;
  border: 1px solid var(--lb-border);
  border-radius: 6px;
  font-size: 12px;
  box-sizing: border-box;
}

.lb-analyze-btn {
  height: var(--lb-control-height);
  min-height: var(--lb-control-height);
  max-height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  padding: 0 10px;
  font-size: 12px;
  box-sizing: border-box;
}

.lb-report-loading, .lb-empty-report {
  padding: 30px 10px;
  text-align: center;
  color: #63766a;
  font-size: 12px;
}

.lb-report-meta-card {
  background: #f9fbf9;
  border: 1px solid var(--lb-border);
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 10px;
}

.lb-report-meta-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  min-height: var(--lb-control-height);
  line-height: var(--lb-control-height);
}

.lb-overall-summary {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #18302e;
  background: #fff;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid #eef2ef;
}

.lb-overall-summary p {
  margin: 4px 0 0;
}

.lb-patterns-list {
  margin: 4px 0 0;
  padding-left: 18px;
}

.lb-report-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: #a52e3c;
}

.lb-report-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #eef2ef;
  font-size: 12px;
  color: #245b45;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
}

.lb-authors-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lb-author-card {
  border: 1px solid var(--lb-border);
  border-radius: 8px;
  padding: 10px;
  background: #fff;
}

.lb-author-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  flex-wrap: wrap;
  gap: 6px;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
}

.lb-author-info {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
}

.lb-author-rank {
  font-weight: 700;
  color: #d49514;
}

.lb-author-name {
  font-weight: 600;
  font-size: 13px;
}

.lb-author-handle {
  font-size: 11px;
  color: #63766a;
  text-decoration: none;
}

.lb-author-handle:hover {
  text-decoration: underline;
  color: #245b45;
}

.lb-author-stats {
  display: flex;
  gap: 6px;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
  align-items: center;
}

.lb-stat-pill {
  font-size: 10px;
  background: #f0f5ef;
  color: #4e6558;
  padding: 0 6px;
  height: 20px;
  line-height: 20px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
}

.lb-posts-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lb-post-card {
  background: #fafcfa;
  border: 1px solid #eef2ef;
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
}

.lb-post-grok-box {
  background: #f4f8f5;
  border-left: 3px solid #245b45;
  padding: 6px 10px;
  border-radius: 0 4px 4px 0;
  margin-bottom: 6px;
}

.lb-grok-tag {
  font-size: 10px;
  font-weight: 700;
  color: #245b45;
}

.lb-grok-text {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: #18302e;
}

.lb-post-text {
  margin: 0 0 6px;
  line-height: 1.5;
  color: #18302e;
  overflow-wrap: anywhere;
}

.lb-post-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
  height: var(--lb-control-height);
  line-height: var(--lb-control-height);
}

.lb-post-metrics {
  display: flex;
  gap: 8px;
  color: #63766a;
}

.lb-post-link {
  color: #245b45;
  text-decoration: none;
  font-weight: 500;
}

.lb-post-link:hover {
  text-decoration: underline;
}

.lb-grok-empty {
  padding: 10px;
  color: #63766a;
  font-size: 11px;
  background: #f9fbf9;
  border-radius: 4px;
}

/* Details Drawer */
.lb-member-detail {
  overflow-wrap: anywhere;
}

.lb-member-detail h3 small {
  display: block;
  margin-top: 6px;
  font-weight: normal;
}

.lb-member-detail dl {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 4px 10px;
  margin: 10px 0;
}

.lb-member-detail dt, .lb-member-detail dd {
  margin: 0;
  padding: 6px 0;
}

.lb-member-detail dt {
  color: #63766a;
  font-weight: 500;
}

.lb-member-detail dd {
  color: #18302e;
}

.lb-detail-post {
  white-space: pre-wrap;
  line-height: 1.7;
}

.lb-detail-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}

/* Responsive column visibility without horizontal overflow */
@media (max-width: 1060px) {
  .th-top-post, .td-top-post,
  .th-views, .td-views {
    display: none !important;
  }
}

@media (max-width: 880px) {
  .th-top-post, .td-top-post,
  .th-views, .td-views,
  .th-replies, .td-replies {
    display: none !important;
  }
}

@media (max-width: 720px) {
  .th-top-post, .td-top-post,
  .th-views, .td-views,
  .th-replies, .td-replies,
  .th-posts, .td-posts,
  .th-freshness, .td-freshness {
    display: none !important;
  }
}

@media (max-width: 480px) {
  .th-top-post, .td-top-post,
  .th-views, .td-views,
  .th-replies, .td-replies,
  .th-posts, .td-posts,
  .th-freshness, .td-freshness,
  .th-followers, .td-followers,
  .th-status, .td-status {
    display: none !important;
  }

  .th-rank, .td-rank {
    width: 36px;
    min-width: 36px;
  }

  .th-account, .td-account {
    width: auto;
  }

  .lb-table th, .lb-table td {
    padding: 0 4px;
  }
}
</style>
