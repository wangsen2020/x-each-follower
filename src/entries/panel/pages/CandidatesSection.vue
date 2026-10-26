<template>
  <div id="candidatesSection" class="tab-panel" data-panel="candidates" :hidden="activeTab !== 'candidates'">
    <div class="mutual-network-head">
      <label class="mutual-field mutual-anchor-field"><span class="mutual-field-label">互粉锚点 <span class="info-tip" data-tip="输入一个以互关为主、粉丝数和关注数接近的账号。插件读取其 following 和 followers，并将两侧账号去重合并到互关追踪列表。" aria-label="互粉锚点说明">?</span></span><input id="networkAnchor" placeholder="@username 或主页链接" autocomplete="off"></label>
      <label class="mutual-field mutual-limit-field"><span class="mutual-field-label">每侧上限 <span class="info-tip" data-tip="每次最多读取锚点 following 和 followers 的数量；更大的范围需要更多时间。" aria-label="每侧上限说明">?</span></span><select id="networkLimit"><option value="100">100</option><option value="250">250</option><option value="500" selected>500</option></select></label>
      <button id="collectNetwork">开始新追踪</button>
      <button id="batchRefreshMutual" class="secondary" title="优先批量更新已勾选账号，未勾选时更新当前页公开资料及关注关系">批量更新</button>
      <button id="grokAnalyzeMutual" class="secondary" title="优先将已勾选账号（最多 20 个）提交给 Grok 分析互粉倾向并回填标签">Grok 分析</button>
      <div class="module-header-actions"><button id="openMutualLogs" class="secondary module-log-button" type="button">执行日志</button></div>
    </div>
    <div class="mutual-subbar">
      <div class="subbar-left">
        <div class="follower-tabs mutual-tabs" role="tablist" aria-label="互关追踪关系分类">
          <button class="follower-tab mutual-tab active" data-mutual-tab="mutual" role="tab" aria-selected="true">已互关 <span id="mutualTabMutualCount">0</span></button>
          <button class="follower-tab mutual-tab" data-mutual-tab="following" role="tab" aria-selected="false">已关注 <span id="mutualTabFollowingCount">0</span></button>
          <button class="follower-tab mutual-tab" data-mutual-tab="followBack" role="tab" aria-selected="false">待回关 <span id="mutualTabFollowBackCount">0</span></button>
          <button class="follower-tab mutual-tab" data-mutual-tab="none" role="tab" aria-selected="false">无关系 <span id="mutualTabNoneCount">0</span></button>
          <span class="info-tip" data-tip="已互关：双方互相关注；已关注：你已关注对方但对方未回关；待回关：对方已关注你但你未回关；无关系：双方均未关注或关系未知。" aria-label="互关追踪分类说明">?</span>
        </div>
        <div class="search-wrap mutual-search-wrap">
          <input id="mutualSearch" type="search" placeholder="账号、名称、简介或互粉词" autocomplete="off">
          <button id="mutualSearchBtn" type="button" class="secondary search-btn">搜索</button>
        </div>
      </div>
      <PanelPagination id="mutualPagination" select-id="mutualPageSize" summary-id="mutualPageSummary" prev-id="mutualPrevPage" next-id="mutualNextPage" :default-size="50" initial-summary="第 1 / 1 页" initially-hidden icon-buttons />
    </div>
    <div id="mutualLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">正在加载互关追踪…</span></div>
    <div id="mutualLoadError" class="dash-load dash-load-error" role="alert" hidden><span class="dash-load-text">加载失败</span><button type="button" class="secondary dash-retry" data-load-retry="mutual">重试</button></div>
    <div id="mutualTagFilterBar" class="tag-filter-bar">
      <span class="tag-filter-label">🏷️ 标签筛选:</span>
      <div class="tag-filter-pills" id="mutualTagPills">
        <button type="button" class="tag-filter-pill active" data-tag-filter="all">全部</button>
        <button type="button" class="tag-filter-pill tag-quick-back" data-tag-filter="reputation:quick_back">⚡ 秒回关</button>
        <button type="button" class="tag-filter-pill tag-mutual-credit" data-tag-filter="reputation:mutual_credit">🤝 诚信互关</button>
        <button type="button" class="tag-filter-pill tag-blue-v" data-tag-filter="identity:blue_v">🔷 蓝V</button>
        <button type="button" class="tag-filter-pill tag-niche-ai" data-tag-filter="niche:ai_tech">💻 AI/科技</button>
        <button type="button" class="tag-filter-pill tag-niche-crypto" data-tag-filter="niche:crypto_web3">🪙 Web3</button>
        <button type="button" class="tag-filter-pill tag-niche-ecom" data-tag-filter="niche:ecommerce">📈 跨境电商</button>
        <button type="button" class="tag-filter-pill tag-niche-design" data-tag-filter="niche:creator">🎨 创意设计</button>
        <button type="button" class="tag-filter-pill tag-active-daily" data-tag-filter="activity:daily">🔥 日更高频</button>
        <button type="button" class="tag-filter-pill tag-bait-risk tag-filter-exclude" data-tag-filter="exclude:bait_risk" title="勾选后自动排除关注少于粉丝 80% 的骗关嫌疑账号">🚫 排除骗关</button>
        <button type="button" class="tag-filter-pill tag-risk-politics tag-filter-exclude tag-filter-exclude-risk" data-tag-filter="exclude:risk" title="勾选后自动排除武装组织、恐怖极端、涉政、涉军、宗教争端、暴力和色情等高危内容账号">🚫 排除高危</button>
      </div>
    </div>
    <p id="networkStatus" class="monitor-status network-status" role="status" aria-live="polite">输入互粉锚点后开始追踪。</p>
    <div class="table-wrap">
      <table class="mutual-table">
        <thead>
          <tr>
            <th class="th-check">
              <input id="mutualSelectAll" type="checkbox" title="全选 / 取消全选当前页" aria-label="全选当前页">
            </th>
            <th class="th-account">
              <span>账号与简介</span>
              <span class="selected-count-badge">已选 <b id="mutualSelectedCount">0</b> / <span id="mutualTotalVisibleCount">0</span></span>
            </th>
            <th class="th-tag">标签 <span class="info-tip" data-tip="互粉标签：有互粉意向且推荐互关标为“互粉”，否则为“无”；关注量不少于粉丝数 4/5（差额 1/5 以内）标为“推荐”，否则标为“不推荐”。悬停标签可查看推荐原因或不推荐原因。" aria-label="标签说明">?</span></th>
            <th class="th-relation">与你的关系 <span class="info-tip" data-tip="按当前登录 X 账号与候选账号之间的关注关系显示；锚点仅用于扩展候选网络。" aria-label="你的关系说明">?</span></th>
            <th class="th-count">粉丝</th>
            <th class="th-count">关注</th>
            <th class="th-count th-record">关注记录 <span class="info-tip" data-tip="记录你通过本工具关注该用户的时间，以及对方是否已回关（待回关/已回关），方便日后核实并清理未回关账号。" aria-label="关注记录说明">?</span></th>
            <th class="th-actions">操作</th>
          </tr>
        </thead>
        <tbody id="mutualResults"></tbody>
      </table>
      <p id="mutualEmpty" hidden>还没有互关追踪记录。</p>
    </div>
  </div>
</template>
<script setup>
import PanelPagination from '../components/PanelPagination.vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>
