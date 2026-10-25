<template>
  <section id="monitorSection" class="monitor-card monitor-panel tab-panel" data-panel="monitor" aria-label="粉丝跟进" :hidden="activeTab !== 'monitor'">
    <div class="monitor-head">
      <div class="follower-tabs" role="tablist">
        <button class="follower-tab active" data-follower-tab="following" role="tab">已关注 <span id="followingCount" aria-busy="true">…</span></button>
        <button class="follower-tab" data-follower-tab="followBack" role="tab">待回关 <span id="followBackCount" aria-busy="true">…</span></button>
        <button class="follower-tab" data-follower-tab="notMutual" role="tab">未互关 <span id="notMutualCount" aria-busy="true">…</span></button>
        <span class="info-tip" data-tip="已关注：相互关注与已关注账号；待回关：对方关注了我们但未回关；未互关：我们关注了对方但对方未回关（单向关注）。" aria-label="粉丝分类说明">?</span>
      </div>
      <div class="monitor-head-right module-header-actions">
        <div class="icon-actions">
          <button id="scanFollowers" class="icon-button" title="增量同步关注与粉丝数据" aria-label="增量同步关注与粉丝">↻</button>
          <button id="openSettingsDrawer" class="icon-button secondary settings-gear-btn" title="粉丝跟进 · 定时检测与自动回关设置" aria-label="粉丝跟进设置"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
        </div>
        <button id="openFollowLogs" class="secondary module-log-button" type="button">执行日志</button>
      </div>
    </div>
    <div id="selectionBar" class="selection-bar monitor-subbar" hidden>
      <div class="subbar-left">
        <div class="search-wrap">
          <input id="followerSearch" type="search" placeholder="账号、名称或简介" autocomplete="off">
          <button id="followerSearchBtn" type="button" class="secondary search-btn">搜索</button>
        </div>
        <button id="analyzeSelected" class="secondary" disabled>Grok 分析</button>
        <button id="batchUnfollow" class="secondary danger-btn" disabled title="批量取消关注选中的账号">批量取关</button>
      </div>
      <div id="monitorPagination" class="monitor-pagination">
        <label>每页<select id="followerPageSize"><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label>
        <span id="followerPageSummary" class="page-summary"></span>
        <div class="page-actions"><button id="followerPrevPage" class="secondary" title="上一页" aria-label="上一页">‹</button><button id="followerNextPage" class="secondary" title="下一页" aria-label="下一页">›</button></div>
      </div>
    </div>
    <div id="monitorLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">正在加载粉丝跟进…</span></div>
    <div id="monitorLoadError" class="dash-load dash-load-error" role="alert" hidden><span class="dash-load-text">加载失败</span><button type="button" class="secondary dash-retry" data-load-retry="monitor">重试</button></div>
    <p id="monitorStatus" class="monitor-status" role="status" aria-live="polite"></p>
    <div id="monitorEmpty" class="monitor-empty" hidden><span class="empty-icon" aria-hidden="true">＋</span><strong id="monitorEmptyTitle">还没有粉丝列表</strong><button id="initialFollowers" class="secondary">获取初始列表</button></div>
    <div id="monitorListHeader" class="monitor-list-header" hidden>
      <span class="col-check">
        <input id="listSelectAll" type="checkbox" title="全选 / 取消全选当前页" aria-label="全选当前页">
      </span>
      <span class="col-profile">
        <span>粉丝画像</span>
        <span class="selected-count-badge">已选 <b id="selectedCount">0</b> / <span id="totalVisibleCount">0</span></span>
      </span>
      <span class="col-tag">标签 <span class="info-tip" data-tip="互粉标签：有互粉意向且推荐互关标为“互粉”，否则为“无”；关注量不少于粉丝数 4/5（差额 1/5 以内）标为“推荐”，否则标为“不推荐”。悬停标签可查看推荐原因或不推荐原因。" aria-label="标签说明">?</span></span>
      <span class="col-status">关系状态</span>
      <span class="col-actions">操作</span>
    </div>
    <div id="monitorList" class="monitor-list" hidden></div>
  </section>
</template>
<script setup>
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>
