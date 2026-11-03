<template>
  <section id="commentsSection" class="tab-panel comments-panel" data-panel="comments" :aria-label="t(&quot;评论追踪&quot;)" :hidden="activeTab !== 'comments'">
    <div class="comments-head">
      <div class="comments-head-left">
        <div class="comments-title">

          <span id="commentsUserCount" class="page-summary" hidden>{{ t("0 位用户") }}</span>
          <span class="selected-count-badge" id="commentSelectedBadge" hidden>{{ t("已选") }}&nbsp;<b id="commentSelectedCount">0</b> / <span id="commentTotalVisibleCount">0</span></span>
        </div>
        <div class="follower-tabs comment-tabs" role="tablist" :aria-label="t(&quot;评论用户筛选&quot;)">
          <button class="follower-tab active" data-comment-filter="notMutual" role="tab" aria-selected="true">{{ t("未互关") }}<span id="commentNotMutualCount">0</span></button>
          <button class="follower-tab" data-comment-filter="all" role="tab" aria-selected="false">{{ t("全部") }}<span id="commentAllCount">0</span></button>
        </div>
      </div>
      <PanelActionBar class="module-header-actions"><PanelIconButton id="openCommentLogs" :icon="ScrollText" :label="t(&quot;执行日志&quot;)" /></PanelActionBar>
    </div>
    <div class="comments-toolbar">
      <div class="search-wrap"><input id="commentSearch" type="search" :placeholder="t(&quot;账号、评论或链接&quot;)" autocomplete="off"><button id="commentSearchBtn" class="secondary search-btn" type="button">{{ t("搜索") }}</button></div>
      <PanelPagination id="commentPagination" select-id="commentPageSize" summary-id="commentPageSummary" prev-id="commentPrevPage" next-id="commentNextPage" initial-summary="0 条" />
    </div>
    <div id="commentsLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">{{ t("正在加载评论追踪…") }}</span></div>
    <div id="commentsLoadError" class="dash-load dash-load-error" role="alert" hidden><span class="dash-load-text">{{ t("加载失败") }}</span><button type="button" class="secondary dash-retry" data-load-retry="comments">{{ t("重试") }}</button></div>
    <p id="commentTrackingStatus" class="monitor-status" role="status" aria-live="polite"></p>
    <div class="table-wrap comments-table-wrap">
      <table id="commentUsersTable" class="mutual-table comment-table" hidden>
        <thead>
          <tr>
            <th class="th-check"><input id="commentSelectAll" type="checkbox" :title="t(&quot;全选 / 取消全选当前页&quot;)" :aria-label="t(&quot;全选当前页&quot;)"></th>
            <th class="th-account">{{ t("账号与简介") }}</th>
            <th class="th-source">{{ t("来源帖子") }}</th>
            <th class="th-relation">{{ t("关系") }}</th>
            <th class="th-count">{{ t("粉丝") }}</th>
            <th class="th-count">{{ t("关注") }}</th>
            <th class="th-count th-record">{{ t("关注记录") }}<span class="info-tip" :data-tip="t(&quot;记录你通过本工具关注该用户的时间，以及对方是否已回关（待回关/已回关），方便日后核实并清理未回关账号。&quot;)" :aria-label="t(&quot;关注记录说明&quot;)">?</span></th>
            <th class="th-actions">{{ t("操作") }}</th>
          </tr>
        </thead>
        <tbody id="commentUsersList"></tbody>
      </table>
      <p id="commentUsersEmpty" class="comment-empty" hidden><strong>{{ t("暂无评论用户") }}</strong><span></span></p>
    </div>
  </section>
</template>
<script setup>
import {t} from '../../../shared/i18n.js';

import PanelActionBar from '../components/PanelActionBar.vue';
import PanelIconButton from '../components/PanelIconButton.vue';
import {ScrollText} from 'lucide';
import PanelPagination from '../components/PanelPagination.vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>
