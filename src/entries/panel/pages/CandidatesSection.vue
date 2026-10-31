<template>
  <div id="candidatesSection" class="tab-panel" data-panel="candidates" :hidden="activeTab !== 'candidates'">
    <div class="mutual-network-head">
      <label class="mutual-field mutual-anchor-field"><span class="mutual-field-label">{{ t("互粉锚点") }}<span class="info-tip" :data-tip="t(&quot;输入一个以互关为主、粉丝数和关注数接近的账号。插件读取其 following 和 followers，并将两侧账号去重合并到互关追踪列表。&quot;)" :aria-label="t(&quot;互粉锚点说明&quot;)">?</span></span><input id="networkAnchor" :placeholder="t(&quot;@username 或主页链接&quot;)" autocomplete="off"></label>
      <label class="mutual-field mutual-limit-field"><span class="mutual-field-label">{{ t("每侧上限") }}<span class="info-tip" :data-tip="t(&quot;每次最多读取锚点 following 和 followers 的数量；更大的范围需要更多时间。&quot;)" :aria-label="t(&quot;每侧上限说明&quot;)">?</span></span><PanelSelect id="networkLimit"><option value="100">100</option><option value="250">250</option><option value="500" selected>500</option></PanelSelect></label>
      <button id="collectNetwork">{{ t("开始新追踪") }}</button>
      <PanelActionBar class="module-header-actions">
        <PanelIconButton id="batchRefreshMutual" :icon="RefreshCw" :label="t(&quot;批量更新&quot;)" :tip="t(&quot;更新已选账号；未选择时更新当前页的公开资料及关注关系&quot;)" />
        <PanelIconButton id="grokAnalyzeMutual" :icon="Sparkles" :label="t(&quot;Grok 分析&quot;)" :tip="t(&quot;分析已选账号；未选择时分析当前页，最多 20 个&quot;)" />
        <PanelIconButton id="openMutualLogs" :icon="ScrollText" :label="t(&quot;执行日志&quot;)" />
      </PanelActionBar>
    </div>
    <div class="mutual-subbar">
      <div class="subbar-left">
        <div class="follower-tabs mutual-tabs" role="tablist" :aria-label="t(&quot;互关追踪关系分类&quot;)">
          <button class="follower-tab mutual-tab active" data-mutual-tab="mutual" role="tab" aria-selected="true">{{ t("已互关") }}<span id="mutualTabMutualCount">0</span></button>
          <button class="follower-tab mutual-tab" data-mutual-tab="following" role="tab" aria-selected="false">{{ t("已关注") }}<span id="mutualTabFollowingCount">0</span></button>
          <button class="follower-tab mutual-tab" data-mutual-tab="followBack" role="tab" aria-selected="false">{{ t("待回关") }}<span id="mutualTabFollowBackCount">0</span></button>
          <button class="follower-tab mutual-tab" data-mutual-tab="none" role="tab" aria-selected="false">{{ t("无关系") }}<span id="mutualTabNoneCount">0</span></button>
          <span class="info-tip" :data-tip="t(&quot;已互关：双方互相关注；已关注：你已关注对方但对方未回关；待回关：对方已关注你但你未回关；无关系：双方均未关注或关系未知。&quot;)" :aria-label="t(&quot;互关追踪分类说明&quot;)">?</span>
        </div>
        <div class="search-wrap mutual-search-wrap">
          <input id="mutualSearch" type="search" :placeholder="t(&quot;账号、名称、简介或互粉词&quot;)" autocomplete="off">
          <button id="mutualSearchBtn" type="button" class="secondary search-btn">{{ t("搜索") }}</button>
        </div>
      </div>
      <PanelPagination id="mutualPagination" select-id="mutualPageSize" summary-id="mutualPageSummary" prev-id="mutualPrevPage" next-id="mutualNextPage" :default-size="50" initial-summary="第 1 / 1 页" initially-hidden icon-buttons />
    </div>
    <div id="mutualLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">{{ t("正在加载互关追踪…") }}</span></div>
    <div id="mutualLoadError" class="dash-load dash-load-error" role="alert" hidden><span class="dash-load-text">{{ t("加载失败") }}</span><button type="button" class="secondary dash-retry" data-load-retry="mutual">{{ t("重试") }}</button></div>
    <div id="mutualTagFilterBar" class="tag-filter-bar">
      <span class="tag-filter-label">{{ t("🏷️ 标签筛选:") }}</span>
      <div class="tag-filter-pills" id="mutualTagPills">
        <button type="button" class="tag-filter-pill active" data-tag-filter="all">{{ t("全部") }}</button>
        <button type="button" class="tag-filter-pill tag-quick-back" data-tag-filter="reputation:quick_back">{{ t("⚡ 秒回关") }}</button>
        <button type="button" class="tag-filter-pill tag-mutual-credit" data-tag-filter="reputation:mutual_credit">{{ t("🤝 诚信互关") }}</button>
        <button type="button" class="tag-filter-pill tag-blue-v" data-tag-filter="identity:blue_v">{{ t("🔷 蓝V") }}</button>
        <button type="button" class="tag-filter-pill tag-niche-ai" data-tag-filter="niche:ai_tech">{{ t("💻 AI/科技") }}</button>
        <button type="button" class="tag-filter-pill tag-niche-crypto" data-tag-filter="niche:crypto_web3">🪙 Web3</button>
        <button type="button" class="tag-filter-pill tag-niche-ecom" data-tag-filter="niche:ecommerce">{{ t("📈 跨境电商") }}</button>
        <button type="button" class="tag-filter-pill tag-niche-design" data-tag-filter="niche:creator">{{ t("🎨 创意设计") }}</button>
        <button type="button" class="tag-filter-pill tag-active-daily" data-tag-filter="activity:daily">{{ t("🔥 日更高频") }}</button>
        <button type="button" class="tag-filter-pill tag-bait-risk tag-filter-exclude" data-tag-filter="exclude:bait_risk" :title="t(&quot;勾选后自动排除关注少于粉丝 80% 的骗关嫌疑账号&quot;)">{{ t("🚫 排除骗关") }}</button>
        <button type="button" class="tag-filter-pill tag-risk-politics tag-filter-exclude tag-filter-exclude-risk" data-tag-filter="exclude:risk" :title="t(&quot;勾选后自动排除武装组织、恐怖极端、涉政、涉军、宗教争端、暴力和色情等高危内容账号&quot;)">{{ t("🚫 排除高危") }}</button>
      </div>
    </div>
    <p id="networkStatus" class="monitor-status network-status" role="status" aria-live="polite">{{ t("输入互粉锚点后开始追踪。") }}</p>
    <div class="table-wrap">
      <table class="mutual-table">
        <thead>
          <tr>
            <th class="th-check">
              <input id="mutualSelectAll" type="checkbox" :title="t(&quot;全选 / 取消全选当前页&quot;)" :aria-label="t(&quot;全选当前页&quot;)">
            </th>
            <th class="th-account">
              <span>{{ t("账号与简介") }}</span>
              <span class="selected-count-badge">{{ t("已选") }}<b id="mutualSelectedCount">0</b> / <span id="mutualTotalVisibleCount">0</span></span>
            </th>
            <th class="th-tag">{{ t("标签") }}<span class="info-tip" :data-tip="t(&quot;互粉标签：有互粉意向且推荐互关标为“互粉”，否则为“无”；关注量不少于粉丝数 4/5（差额 1/5 以内）标为“推荐”，否则标为“不推荐”。悬停标签可查看推荐原因或不推荐原因。&quot;)" :aria-label="t(&quot;标签说明&quot;)">?</span></th>
            <th class="th-relation">{{ t("与你的关系") }}<span class="info-tip" :data-tip="t(&quot;按当前登录 X 账号与候选账号之间的关注关系显示；锚点仅用于扩展候选网络。&quot;)" :aria-label="t(&quot;你的关系说明&quot;)">?</span></th>
            <th class="th-count">{{ t("粉丝") }}</th>
            <th class="th-count">{{ t("关注") }}</th>
            <th class="th-count th-record">{{ t("关注记录") }}<span class="info-tip" :data-tip="t(&quot;记录你通过本工具关注该用户的时间，以及对方是否已回关（待回关/已回关），方便日后核实并清理未回关账号。&quot;)" :aria-label="t(&quot;关注记录说明&quot;)">?</span></th>
            <th class="th-actions">{{ t("操作") }}</th>
          </tr>
        </thead>
        <tbody id="mutualResults"></tbody>
      </table>
      <p id="mutualEmpty" hidden>{{ t("还没有互关追踪记录。") }}</p>
    </div>
  </div>
</template>
<script setup>
import {t} from '../../../shared/i18n.js';

import PanelSelect from "../components/PanelSelect.vue";
import PanelActionBar from '../components/PanelActionBar.vue';
import PanelIconButton from '../components/PanelIconButton.vue';
import {RefreshCw, Sparkles, ScrollText} from 'lucide';
import PanelPagination from '../components/PanelPagination.vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>
