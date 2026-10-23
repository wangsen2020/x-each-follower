<template>
  <section id="unreciprocatedSection" class="tab-panel unreciprocated-panel" data-panel="unreciprocated" aria-label="回关监测" :hidden="activeTab !== 'unreciprocated'">
    <div class="unreciprocated-head">
      <div class="unreciprocated-head-left">
<Teleport to="#panel-title-help" v-if="activeTab === 'unreciprocated'"><InlineHelp label="回关监测说明" text="检测主动关注账号是否回关。超过设置期限仍未回关的账号归为超时；取关前请核对所选范围。" /></Teleport>
        <button id="checkUnreciprocatedBtn" class="primary" title="对比最新粉丝关系并刷新所有主动关注账号的回关状态">开始检测</button>
        <button id="batchUnfollowUnreciprocatedBtn" class="secondary danger-btn" disabled title="批量取消关注已勾选的未回关账号">批量取关</button>
        <button id="unfollowAllOverdueBtn" class="secondary danger-btn" title="一键取消关注所有超过2周仍未回关的账号">取关全部超时</button>
      </div>
      <div class="module-header-actions"><button id="openUnreciprocatedSettingsDrawer" class="icon-button secondary settings-gear-btn" title="回关监测与定时取关设置" aria-label="回关监测与定时取关设置"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button><button id="openUnreciprocatedLogs" class="secondary module-log-button" type="button">执行日志</button></div>
    </div>
    <div class="mutual-subbar unreciprocated-subbar">
      <div class="subbar-left">
        <div class="follower-tabs unreciprocated-tabs" role="tablist" aria-label="回关状态筛选">
          <button class="follower-tab unreciprocated-tab active" data-unreciprocated-tab="overdue" role="tab" aria-selected="true">超时未回关 <span id="tabOverdueCount">0</span></button>
          <button class="follower-tab unreciprocated-tab" data-unreciprocated-tab="pending" role="tab" aria-selected="false">待回关 <span id="tabPendingCount">0</span></button>
          <button class="follower-tab unreciprocated-tab" data-unreciprocated-tab="mutual" role="tab" aria-selected="false">已回关 <span id="tabMutualCount">0</span></button>
          <button class="follower-tab unreciprocated-tab" data-unreciprocated-tab="all" role="tab" aria-selected="false">全部 <span id="tabAllCount">0</span></button>
          <span class="info-tip" data-tip="超时未回关：关注超过指定期限（默认2周/14天）仍未回关你的账号；待回关中：关注在14天缓冲期内等待回关；已回关：对方已回关形成双向互粉。" aria-label="分类说明">?</span>
        </div>
        <div class="search-wrap unreciprocated-search-wrap">
          <input id="unreciprocatedSearch" type="search" placeholder="搜索账号、名称或简介" autocomplete="off">
          <button id="unreciprocatedSearchBtn" type="button" class="secondary search-btn">搜索</button>
        </div>
      </div>
      <div id="unreciprocatedPagination" class="monitor-pagination">
        <label>每页<select id="unreciprocatedPageSize"><option value="20">20</option><option value="50" selected>50</option><option value="100">100</option></select></label>
        <span id="unreciprocatedPageSummary" class="page-summary">第 1 / 1 页</span>
        <div class="page-actions"><button id="unreciprocatedPrevPage" class="icon-button secondary" title="上一页" aria-label="上一页">‹</button><button id="unreciprocatedNextPage" class="icon-button secondary" title="下一页" aria-label="下一页">›</button></div>
      </div>
    </div>
    <div id="unreciprocatedLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">正在加载回关监测…</span></div>
    <div id="unreciprocatedLoadError" class="dash-load dash-load-error" role="alert" hidden><span class="dash-load-text">加载失败</span><button type="button" class="secondary dash-retry" data-load-retry="unreciprocated">重试</button></div>
    <p id="unreciprocatedStatus" class="monitor-status" role="status" aria-live="polite"></p>
    <div class="table-wrap unreciprocated-table-wrap">
      <table class="mutual-table unreciprocated-table">
        <thead>
          <tr>
            <th class="th-check"><input id="unreciprocatedSelectAll" type="checkbox" title="全选 / 取消全选当前页" aria-label="全选当前页"></th>
            <th class="th-account">
              <span>账号与简介</span>
              <span class="selected-count-badge">已选 <b id="unreciprocatedSelectedCount">0</b> / <span id="unreciprocatedTotalVisibleCount">0</span></span>
            </th>
            <th class="th-record" style="width:190px;">关注时间 <span class="info-tip" data-tip="显示我们主动关注对方的时间及距今已等待的天数；若超过阈值（默认14天）则视为无信用超时账号。" aria-label="等待时长说明">?</span></th>
            <th class="th-relation" style="width:130px;">回关状态</th>
            <th class="th-count">粉丝</th>
            <th class="th-count">关注</th>
            <th class="th-actions" style="width:170px;">操作</th>
          </tr>
        </thead>
        <tbody id="unreciprocatedResults"></tbody>
      </table>
      <p id="unreciprocatedEmpty" class="comment-empty" hidden><strong>暂无记录</strong><span></span></p>
    </div>
  </section>
</template>
<script setup>
import InlineHelp from '../components/InlineHelp.vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>
