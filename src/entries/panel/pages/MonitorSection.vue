<template>
  <section id="monitorSection" class="monitor-card monitor-panel tab-panel" data-panel="monitor" :aria-label="t(&quot;粉丝跟进&quot;)" :hidden="activeTab !== 'monitor'">
    <div class="monitor-head">
      <div class="follower-tabs" role="tablist">
        <button class="follower-tab active" data-follower-tab="fanFollowing" role="tab">{{ t("已关注") }}<span id="followingCount" aria-busy="true">…</span></button>
        <button class="follower-tab" data-follower-tab="fanPending" role="tab">{{ t("待回关") }}<span id="followBackCount" aria-busy="true">…</span></button>
        <button class="follower-tab" data-follower-tab="fanMutual" role="tab">{{ t("已互关") }}<span id="fanMutualCount" aria-busy="true">…</span></button>
        <button class="follower-tab" data-follower-tab="fanUnknown" role="tab">{{ t("待核实") }}<span id="fanUnknownCount" aria-busy="true">…</span></button>
        <span class="info-tip" :data-tip="t(&quot;已关注：你关注对方，对方未关注你；待回关：对方关注你，你未关注对方；已互关：双方互相关注。每个账号只计一次。关系缺失或历史记录冲突时列入待核实，可点击核验关系更新。分类依据最近一次本地记录，不代表实时关系。搜索覆盖全部本地账号，包括无关系账号。&quot;)" :aria-label="t(&quot;粉丝分类说明&quot;)">?</span>
      </div>
      <PanelActionBar class="monitor-head-right module-header-actions">
        <PanelIconButton id="scanFollowers" :icon="RefreshCw" :label="t(&quot;同步关注与粉丝&quot;)" :tip="t(&quot;增量同步关注与粉丝数据&quot;)" />
        <PanelIconButton id="openSettingsDrawer" :icon="Settings" :label="t(&quot;粉丝跟进设置&quot;)" :tip="t(&quot;定时检测与自动回关设置&quot;)" />
        <PanelIconButton id="openFollowLogs" :icon="ScrollText" :label="t(&quot;执行日志&quot;)" />
      </PanelActionBar>
    </div>
    <div id="selectionBar" class="selection-bar monitor-subbar" hidden>
      <div class="subbar-left">
        <div class="search-wrap">
          <input id="followerSearch" type="search" :placeholder="t(&quot;搜索全部账号、名称或简介&quot;)" :aria-label="t(&quot;搜索全部粉丝档案&quot;)" autocomplete="off">
          <button id="followerSearchBtn" type="button" class="secondary search-btn">{{ t("搜索") }}</button>
        </div>
        <button id="batchInspectFans" class="secondary" disabled :data-panel-tip="t(&quot;只核验当前页勾选的账号。翻页、调整每页数量或切换分类与搜索时，清空选择并取消当前批次；请重新勾选后开始。只更新本地关系，不关注或取关。&quot;)">{{ t("批量核验") }}</button>
        <button id="batchDeleteFans" class="secondary danger-btn" disabled :data-panel-tip="t(&quot;仅删除粉丝管理中的本地记录，不改变 X 关注关系；以后同步可能重新出现。&quot;)">{{ t("批量删除") }}</button>
        <button id="analyzeSelected" class="secondary" disabled>{{ t("Grok 分析") }}</button>
        <button id="batchUnfollow" class="secondary danger-btn" disabled :title="t(&quot;批量取消关注选中的账号&quot;)">{{ t("批量取关") }}</button>
      </div>
      <PanelPagination id="monitorPagination" select-id="followerPageSize" summary-id="followerPageSummary" prev-id="followerPrevPage" next-id="followerNextPage" />
    </div>
    <div id="monitorLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">{{ t("正在加载粉丝跟进…") }}</span></div>
    <div id="monitorLoadError" class="dash-load dash-load-error" role="alert" hidden><span class="dash-load-text">{{ t("加载失败") }}</span><button type="button" class="secondary dash-retry" data-load-retry="monitor">{{ t("重试") }}</button></div>
    <p id="monitorStatus" class="monitor-status" role="status" aria-live="polite"></p>
    <div id="fanInspectionProgress" class="fan-inspection-progress" hidden>
      <span id="fanInspectionStatus" role="status" aria-live="polite"></span>
      <button id="stopFanInspection" class="secondary" hidden>{{ t("停止后续") }}</button>
      <button id="resumeFanInspection" class="secondary" hidden>{{ t("继续核验") }}</button>
      <button id="showFanInspectionResults" class="secondary" hidden>{{ t("查看结果") }}</button>
    </div>
    <dialog id="fanInspectionDialog" class="fan-inspection-dialog" aria-labelledby="fanInspectionTitle">
      <header><strong id="fanInspectionTitle">{{ t("核验结果") }}</strong><PanelCloseButton id="closeFanInspectionDialog" :label="t(&quot;关闭核验结果&quot;)" /></header>
      <p id="fanInspectionSummary"></p>
      <ul id="fanInspectionResults"></ul>
    </dialog>
    <div id="monitorEmpty" class="monitor-empty" hidden><span class="empty-icon" aria-hidden="true">＋</span><strong id="monitorEmptyTitle">{{ t("还没有粉丝列表") }}</strong><button id="initialFollowers" class="secondary">{{ t("获取初始列表") }}</button></div>
    <div id="monitorListHeader" class="monitor-list-header" hidden>
      <span class="col-check">
        <input id="listSelectAll" type="checkbox" :title="t(&quot;全选 / 取消全选当前页&quot;)" :aria-label="t(&quot;全选当前页&quot;)">
      </span>
      <span class="col-profile">
        <span>{{ t("粉丝画像") }}</span>
        <span class="selected-count-badge">{{ t("本页已选") }}<b id="selectedCount">0</b> / <span id="totalVisibleCount">0</span></span>
      </span>
      <span class="col-counts">{{ t("关注 / 粉丝") }}</span>
      <span class="col-tag">{{ t("标签") }}<span class="info-tip" :data-tip="t(&quot;互粉标签：有互粉意向且推荐互关标为“互粉”，否则为“无”；关注量不少于粉丝数 4/5（差额 1/5 以内）标为“推荐”，否则标为“不推荐”。悬停标签可查看推荐原因或不推荐原因。&quot;)" :aria-label="t(&quot;标签说明&quot;)">?</span></span>
      <span class="col-status">{{ t("关系状态") }}</span>
      <span class="col-actions">{{ t("操作") }}</span>
    </div>
    <div id="monitorList" class="monitor-list" hidden></div>
  </section>
</template>
<script setup>
import {t} from '../../../shared/i18n.js';

import PanelActionBar from '../components/PanelActionBar.vue';
import PanelIconButton from '../components/PanelIconButton.vue';
import {RefreshCw, Settings, ScrollText} from 'lucide';
import PanelPagination from '../components/PanelPagination.vue';
import PanelCloseButton from '../components/PanelCloseButton.vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>
