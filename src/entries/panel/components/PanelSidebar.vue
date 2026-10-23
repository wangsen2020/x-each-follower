<template>
  <aside class="sidebar vue-panel-sidebar" aria-label="主导航">
    <div class="brand-mark">
      <div class="brand-logo">
        <img :src="iconUrl" alt="XFollower logo">
      </div>
      <div class="brand-name">XFollower</div>
      <span class="brand-version">v{{ version }}</span>
      <span>粉丝管理</span>
    </div>

    <button
      v-for="item in tabs"
      :key="item.key"
      class="nav-tab"
      :class="{ active: activeTab === item.key }"
      :data-tab="item.key"
      type="button"
      @click="handleTabClick(item.key)"
    >
      {{ item.label }}
      <span
        v-if="item.hasBadge"
        :id="item.badgeId"
        class="nav-count"
        :class="{ 'nav-count-loading': badges[item.key]?.loading }"
        role="status"
        :aria-label="badges[item.key]?.loading ? '加载中' : `${badges[item.key]?.count || 0} 条`"
        :aria-busy="badges[item.key]?.loading"
      >
        <span v-if="badges[item.key]?.loading" class="dash-spinner" aria-hidden="true"></span>
        <template v-else>{{ badges[item.key]?.count ?? 0 }}</template>
      </span>
    </button>

    <div class="sidebar-foot">
      本地数据
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';

const { activeTab, version, badges, tabs, setTab } = panelNavigationController;

const iconUrl = computed(() => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL('icon128.png');
  }
  return 'icon128.png';
});

function handleTabClick(tab) {
  if (typeof window !== 'undefined' && typeof window.setTab === 'function') {
    window.setTab(tab);
  } else {
    setTab(tab);
  }
}
</script>
