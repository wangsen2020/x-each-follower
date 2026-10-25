<template>
  <section id="unreciprocatedSection" class="tab-panel unreciprocated-panel" data-panel="unreciprocated" aria-label="回关监控" :hidden="activeTab !== 'unreciprocated'">
    <div class="unreciprocated-head">
      <div class="unreciprocated-head-left">
        <button id="checkUnreciprocatedBtn" class="primary" title="对比最新粉丝关系并刷新所有主动关注账号的回关状态">重新比对</button>
        <button id="batchUnfollowUnreciprocatedBtn" class="secondary danger-btn" disabled title="批量取消关注已勾选的未回关账号">批量取关</button>
        <button id="unfollowAllOverdueBtn" class="secondary danger-btn" title="选择所有超过设定天数仍未回关的账号">选择超时账号</button>
      </div>
      <div class="module-header-actions">
        <button id="openUnreciprocatedSettingsDrawer" class="icon-button secondary settings-gear-btn" title="回关监控与定时取关设置" aria-label="回关监控与定时取关设置">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <button id="openUnreciprocatedLogs" class="secondary module-log-button" type="button">执行日志</button>
      </div>
    </div>
    <div class="mutual-subbar unreciprocated-subbar">
      <div class="subbar-left">
        <div class="follower-tabs unreciprocated-tabs" role="tablist" aria-label="回关状态筛选">
          <button class="follower-tab unreciprocated-tab active" data-unreciprocated-tab="unreciprocated" role="tab" aria-selected="true">未回关 <span id="tabUnreciprocatedCount">0</span></button>
          <button class="follower-tab unreciprocated-tab" data-unreciprocated-tab="mutual" role="tab" aria-selected="false">已互关 <span id="tabMutualCount">0</span></button>
          <button class="follower-tab unreciprocated-tab" data-unreciprocated-tab="unfollowed" role="tab" aria-selected="false">已取关 <span id="tabUnfollowedCount">0</span></button>
          <button class="follower-tab unreciprocated-tab" data-unreciprocated-tab="all" role="tab" aria-selected="false">全部 <span id="tabAllCount">0</span></button>
          <span class="info-tip" tabindex="0" role="note" data-tip="未回关：我们关注对方但对方目前未关注我们；已互关：双方已形成互相关注；已取关：本地记录的取关账号及时间；全部：当前主动关注的全部账号，不含已取关。" aria-label="回关状态说明">?</span>
        </div>
        <select id="unreciprocatedOverdueFilter" class="unreciprocated-filter-select" title="期限状态筛选" aria-label="期限状态筛选">
          <option value="all">全部期限</option>
          <option value="overdue">已超时</option>
          <option value="within">未超时</option>
          <option value="unknown">时间未知</option>
        </select>
        <select id="unreciprocatedAvailabilityFilter" class="unreciprocated-filter-select" title="账号状态筛选" aria-label="账号状态筛选">
          <option value="all">全部账号</option>
          <option value="unavailable">账号不可用</option>
          <option value="not_found">账号不存在</option>
          <option value="suspended">已封禁</option>
          <option value="ok">账号正常</option>
          <option value="unknown">待确认</option>
        </select>
        <div class="search-wrap unreciprocated-search-wrap">
          <input id="unreciprocatedSearch" type="search" placeholder="搜索账号、名称或简介" autocomplete="off">
          <button id="unreciprocatedSearchBtn" type="button" class="secondary search-btn">搜索</button>
        </div>
      </div>
      <div id="unreciprocatedPagination" class="monitor-pagination">
        <label class="unreciprocated-pagesize-label"><span>每页</span><select id="unreciprocatedPageSize"><option value="20">20</option><option value="50" selected>50</option><option value="100">100</option></select></label>
        <span id="unreciprocatedPageSummary" class="page-summary">第 1 / 1 页</span>
        <div class="page-actions"><button id="unreciprocatedPrevPage" class="icon-button secondary" title="上一页" aria-label="上一页">‹</button><button id="unreciprocatedNextPage" class="icon-button secondary" title="下一页" aria-label="下一页">›</button></div>
      </div>
    </div>
    <div id="unreciprocatedLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">正在加载回关监控…</span></div>
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
            <th class="th-record" style="width:180px;">关注时间 <span class="info-tip" tabindex="0" role="note" data-tip="显示我们主动关注对方的时间及距今已等待的天数。" aria-label="等待时长说明">?</span></th>
            <th class="th-relation" style="width:110px;">回关状态</th>
            <th class="th-deadline" style="width:100px;">期限状态</th>
            <th class="th-count">粉丝</th>
            <th class="th-count">关注</th>
            <th class="th-actions" style="width:210px;">操作</th>
          </tr>
        </thead>
        <tbody id="unreciprocatedResults"></tbody>
      </table>
      <p id="unreciprocatedEmpty" class="comment-empty" hidden><strong>暂无记录</strong><span></span></p>
    </div>
    <div id="unreciprocatedGreetingMask" class="greeting-dialog-mask" hidden></div>
    <div id="unreciprocatedGreetingDialog" class="greeting-dialog" role="dialog" aria-modal="true" aria-labelledby="unreciprocatedGreetingTitle" hidden>
      <strong id="unreciprocatedGreetingTitle">快捷私信</strong>
      <p id="unreciprocatedGreetingRecipient"></p>
      <label for="unreciprocatedGreetingDraft">私信正文</label>
      <textarea id="unreciprocatedGreetingDraft" rows="4" maxlength="1000"></textarea>
      <p id="unreciprocatedGreetingStatus" role="status" aria-live="polite"></p>
      <div class="greeting-dialog-actions">
        <button id="unreciprocatedGreetingCancel" type="button" class="secondary">取消</button>
        <button id="unreciprocatedGreetingSend" type="button">确认发送</button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>

<style scoped>
#unreciprocatedSection .unreciprocated-head-left > :not(:last-child) {
  margin-right: 10px;
}
#unreciprocatedSection .module-header-actions > :not(:last-child) {
  margin-right: 10px;
}

#unreciprocatedSection .unreciprocated-subbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  row-gap: 8px;
  min-width: 0;
}

#unreciprocatedSection .subbar-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  row-gap: 8px;
  min-width: 0;
}

#unreciprocatedSection .subbar-left > :not(:last-child) {
  margin-right: 10px;
}

#unreciprocatedSection .unreciprocated-tabs > :not(:last-child) {
  margin-right: 4px;
}

.unreciprocated-filter-select {
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  font-size: 12px;
  padding: 0 8px;
  border: 1px solid #cbdacf;
  border-radius: 6px;
  background-color: #fff;
  color: #18302e;
  box-sizing: border-box;
  vertical-align: middle;
}
.unreciprocated-filter-select:focus {
  outline: 2px solid #65a88a;
  outline-offset: 1px;
}

#unreciprocatedSection .unreciprocated-search-wrap {
  display: inline-flex;
  align-items: center;
}
#unreciprocatedSection .unreciprocated-search-wrap > input[type="search"] {
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  font-size: 12px;
  margin-right: 10px;
  box-sizing: border-box;
}
#unreciprocatedSection .unreciprocated-search-wrap > .search-btn {
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  font-size: 12px;
  margin-right: 0;
  box-sizing: border-box;
}

#unreciprocatedSection #unreciprocatedPagination {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}
#unreciprocatedSection #unreciprocatedPagination > :not(:last-child) {
  margin-right: 10px;
}

#unreciprocatedSection #unreciprocatedPagination label.unreciprocated-pagesize-label {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  white-space: nowrap;
  margin: 0;
}
#unreciprocatedSection #unreciprocatedPagination label.unreciprocated-pagesize-label > span {
  margin-right: 10px;
  font-size: 12px;
}
#unreciprocatedSection #unreciprocatedPageSize {
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  font-size: 12px;
  box-sizing: border-box;
}

#unreciprocatedSection #unreciprocatedPagination .page-actions {
  display: inline-flex;
  align-items: center;
}
#unreciprocatedSection #unreciprocatedPagination .page-actions > :not(:last-child) {
  margin-right: 10px;
}
#unreciprocatedSection #unreciprocatedPagination .page-actions button {
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  width: 30px;
  min-width: 30px;
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

.mutual-table th.th-deadline,
:deep(.mutual-table td.col-relation) {
  text-align: center;
  font-size: 12px;
  white-space: nowrap;
}
</style>
