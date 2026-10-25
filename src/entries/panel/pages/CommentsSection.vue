<template>
  <section id="commentsSection" class="tab-panel comments-panel" data-panel="comments" aria-label="评论追踪" :hidden="activeTab !== 'comments'">
    <div class="comments-head">
      <div class="comments-head-left">
        <div class="comments-title">

          <span id="commentsUserCount" class="page-summary" hidden>0 位用户</span>
          <span class="selected-count-badge" id="commentSelectedBadge" hidden>已选 <b id="commentSelectedCount">0</b> / <span id="commentTotalVisibleCount">0</span></span>
        </div>
        <div class="follower-tabs comment-tabs" role="tablist" aria-label="评论用户筛选">
          <button class="follower-tab active" data-comment-filter="notMutual" role="tab" aria-selected="true">未互关 <span id="commentNotMutualCount">0</span></button>
          <button class="follower-tab" data-comment-filter="all" role="tab" aria-selected="false">全部 <span id="commentAllCount">0</span></button>
        </div>
      </div>
      <div class="module-header-actions"><button id="openCommentLogs" class="secondary module-log-button" type="button">执行日志</button></div>
    </div>
    <div class="comments-toolbar">
      <div class="search-wrap"><input id="commentSearch" type="search" placeholder="账号、评论或链接" autocomplete="off"><button id="commentSearchBtn" class="secondary search-btn" type="button">搜索</button></div>
      <div id="commentPagination" class="monitor-pagination">
        <label>每页<select id="commentPageSize"><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label>
        <span id="commentPageSummary" class="page-summary">0 条</span>
        <div class="page-actions"><button id="commentPrevPage" class="secondary" title="上一页" aria-label="上一页">‹</button><button id="commentNextPage" class="secondary" title="下一页" aria-label="下一页">›</button></div>
      </div>
    </div>
    <div id="commentsLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">正在加载评论追踪…</span></div>
    <div id="commentsLoadError" class="dash-load dash-load-error" role="alert" hidden><span class="dash-load-text">加载失败</span><button type="button" class="secondary dash-retry" data-load-retry="comments">重试</button></div>
    <p id="commentTrackingStatus" class="monitor-status" role="status" aria-live="polite"></p>
    <div class="table-wrap comments-table-wrap">
      <table id="commentUsersTable" class="mutual-table comment-table" hidden>
        <thead>
          <tr>
            <th class="th-check"><input id="commentSelectAll" type="checkbox" title="全选 / 取消全选当前页" aria-label="全选当前页"></th>
            <th class="th-account">账号与简介</th>
            <th class="th-source">来源帖子</th>
            <th class="th-relation">关系</th>
            <th class="th-count">粉丝</th>
            <th class="th-count">关注</th>
            <th class="th-count th-record">关注记录 <span class="info-tip" data-tip="记录你通过本工具关注该用户的时间，以及对方是否已回关（待回关/已回关），方便日后核实并清理未回关账号。" aria-label="关注记录说明">?</span></th>
            <th class="th-actions">操作</th>
          </tr>
        </thead>
        <tbody id="commentUsersList"></tbody>
      </table>
      <p id="commentUsersEmpty" class="comment-empty" hidden><strong>暂无评论用户</strong><span></span></p>
    </div>
  </section>
</template>
<script setup>
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>
