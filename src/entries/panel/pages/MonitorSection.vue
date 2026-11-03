<template>
  <section id="monitorSection" class="monitor-card monitor-panel tab-panel" data-panel="monitor" :aria-label="t(&quot;粉丝跟进&quot;)" :hidden="activeTab !== 'monitor'">
    <div class="monitor-head">
      <div class="follower-tabs" role="tablist">
        <button class="follower-tab active" data-follower-tab="fanPending" role="tab">{{ t("待回关") }}<span id="followBackCount" aria-busy="true">…</span></button>
        <button class="follower-tab" data-follower-tab="fanReview" role="tab">{{ t("待审核") }}<span id="fanReviewCount" aria-busy="true">…</span></button>
        <button class="follower-tab" data-follower-tab="fanRemoved" role="tab">{{ t("已移除") }}<span id="fanRemovedCount" aria-busy="true">…</span></button>
        <button class="follower-tab" data-follower-tab="fanMutual" role="tab">{{ t("已互关") }}<span id="fanMutualCount" aria-busy="true">…</span></button>
        <button class="follower-tab" data-follower-tab="fanUnknown" role="tab">{{ t("待核实") }}<span id="fanUnknownCount" aria-busy="true">…</span></button>
        <span class="info-tip" tabindex="0" :data-tip="t(&quot;待回关：已放行并加入关注队列。待审核：等待 AI 或人工判断。待核实：补充详细资料与最近 10 条帖子，完成后自动复审一次。回关成功后转为已互关。&quot;)" :aria-label="t(&quot;粉丝分类说明&quot;)">?</span>
      </div>
      <PanelActionBar class="monitor-head-right module-header-actions">
        <FanProfileQueue />
        <PanelIconButton id="scanFollowers" :icon="RefreshCw" :label="t(&quot;同步关注与粉丝&quot;)" :tip="t(&quot;增量同步关注与粉丝数据&quot;)" />
        <PanelIconButton id="openSettingsDrawer" :icon="Settings" :label="t(&quot;粉丝跟进设置&quot;)" :tip="t(&quot;定时检测与自动回关设置&quot;)" />
        <PanelIconButton id="openFollowLogs" :icon="ScrollText" :label="t(&quot;执行日志&quot;)" />
      </PanelActionBar>
    </div>
    <div id="selectionBar" class="selection-bar monitor-subbar" hidden>
      <div class="subbar-left">
        <div class="search-wrap">
          <input id="followerSearch" type="search" :placeholder="t(&quot;搜索全部账号、名称或简介&quot;)" :aria-label="t(&quot;搜索全部粉丝档案&quot;)" autocomplete="off">
          <PanelIconButton id="followerSearchBtn" :icon="Search" :label="t('搜索')" type="button"  />
        </div>
        <div id="fanReviewResultFilter" class="fan-review-result-filter" hidden>
          <PanelSelect id="fanReviewResult" :aria-label="t('审核结果筛选')" :data-panel-tip="t('筛选完整待审核列表。选择全部筛选结果后，可跨页批量通过并入队；执行前仍核实关系。')">
            <option value="">{{ t("全部结果") }}</option>
            <option value="pass">{{ t("通过") }}</option>
            <option value="review">{{ t("历史待确认") }}</option>
            <option value="uncertain">{{ t("资料不足") }}</option>
            <option value="unlabeled">{{ t("未打标") }}</option>
          </PanelSelect>
        </div>
        <PanelIconButton id="batchInspectFans" :icon="ShieldCheck" :label="t('批量核验')" disabled :tip="t('开始后按本批所选账号继续核验，切换页面、分类、搜索或分页不会终止。点击停止图标，完成当前项后暂停；可继续剩余账号。只更新本地关系，不关注或取关。')" />
        <PanelIconButton id="batchDeleteFans" :icon="Trash2" :label="t('批量删除')" class=" danger-btn" disabled :tip="t(&quot;仅删除粉丝管理中的本地记录，不改变 X 关注关系；以后同步可能重新出现。&quot;)" />
        <PanelIconButton id="reviewSelectedFans" :icon="Sparkles" :label="t('AI 审核')"  disabled />
        <PanelIconButton id="approveSelectedFans" :icon="ListPlus" :label="t('通过并入队')"  disabled />
        <PanelIconButton id="removeSelectedFans" :icon="UserRoundX" :label="t('移除此关注者')" class=" danger-btn" disabled />
        <PanelIconButton id="selectAllFilteredFans" :icon="ListChecks" :label="t('选择全部筛选结果')"  />
        <span id="fanReviewSelection" role="status" aria-live="polite"></span>
        <PanelIconButton id="batchUnfollow" :icon="UserMinus" :label="t('批量取关')" class=" danger-btn" disabled :tip="t(&quot;批量取消关注选中的账号&quot;)" />
      </div>
      <PanelPagination id="monitorPagination" select-id="followerPageSize" summary-id="followerPageSummary" prev-id="followerPrevPage" next-id="followerNextPage" />
    </div>
    <div id="monitorLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">{{ t("正在加载粉丝跟进…") }}</span></div>
    <div id="monitorLoadError" class="dash-load dash-load-error" role="alert" hidden><span class="dash-load-text">{{ t("加载失败") }}</span><button type="button" class="secondary dash-retry" data-load-retry="monitor">{{ t("重试") }}</button></div>
    <p id="monitorStatus" class="monitor-status" role="status" aria-live="polite"></p>
    <div id="fanReviewProgress" class="fan-review-progress" hidden>
      <div class="fan-review-progress-actions">
        <span id="fanReviewStatus" role="status" aria-live="polite"></span>
        <PanelIconButton id="stopFanReview" :icon="CircleStop" :label="t('停止后续')"  hidden />
        <PanelIconButton id="resumeFanReview" :icon="Play" :label="t('继续处理')"  hidden />
      </div>
    </div>
    <div id="monitorEmpty" class="monitor-empty" hidden><span class="empty-icon" aria-hidden="true">＋</span><strong id="monitorEmptyTitle">{{ t("还没有粉丝列表") }}</strong><PanelIconButton id="initialFollowers" :icon="Download" :label="t('获取初始列表')"  /></div>
    <div id="monitorListHeader" class="monitor-list-header" hidden>
      <span class="col-check">
        <input id="listSelectAll" type="checkbox" :title="t(&quot;全选 / 取消全选当前页&quot;)" :aria-label="t(&quot;全选当前页&quot;)">
      </span>
      <span class="col-profile">
        <span>{{ t("粉丝画像") }}</span>
        <span class="selected-count-badge">{{ t("本页已选") }}&nbsp;<b id="selectedCount">0</b> / <span id="totalVisibleCount">0</span></span>
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
import FanProfileQueue from '../components/FanProfileQueue.vue';
import PanelIconButton from '../components/PanelIconButton.vue';
import {RefreshCw, Settings, ScrollText, Search, ShieldCheck, Trash2, Sparkles, ListPlus, UserRoundX, ListChecks, UserMinus, CircleStop, Play, Download} from 'lucide';
import PanelPagination from '../components/PanelPagination.vue';
import PanelSelect from '../components/PanelSelect.vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>
<style scoped>
.fan-review-progress{padding:10px 0;border-bottom:1px solid #dce7e1;color:#18302e;font-size:12px;overflow-wrap:anywhere}
.fan-review-progress[hidden]{display:none}.fan-review-progress-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fan-review-progress details{margin-top:8px}.fan-review-progress ul{max-height:240px;overflow:auto;padding-left:20px}
.follower-tabs{flex-wrap:wrap}.subbar-left{flex-wrap:wrap}#fanReviewSelection{font-size:12px}
.fan-review-result-filter:not([hidden]){display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px}.fan-review-result-filter select{min-width:100px}
</style>
