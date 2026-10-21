<template>
  <section id="followQueueSection" class="tab-panel" data-panel="followQueue" :hidden="activeTab !== 'followQueue'"><div id="followQueueLoad" class="dash-load" role="status" aria-live="polite" aria-busy="true"><span class="dash-spinner" aria-hidden="true"></span><span class="dash-load-text">正在加载关注队列…</span></div><div id="followQueueLoadError" class="dash-load dash-load-error" role="alert" hidden><span class="dash-load-text">加载失败</span><button type="button" class="secondary dash-retry" data-load-retry="followQueue">重试</button></div></section>
</template>
<script setup>
import { panelNavigationController } from '../composables/usePanelNavigation.js';
const { activeTab } = panelNavigationController;
</script>
