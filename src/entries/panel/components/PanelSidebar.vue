<template>
  <aside class="sidebar vue-panel-sidebar" aria-label="主导航">
    <div class="brand-mark">
      <div class="brand-logo">
        <img :src="iconUrl" alt="XFollower logo">
      </div>
      <div class="brand-row">
        <div class="brand-name">XFollower</div>
        <span class="brand-version">v{{ version }}</span>
      </div>
    </div>

    <button
      v-for="item in tabs"
      :key="item.key"
      class="nav-tab"
      :class="{ active: activeTab === item.key }"
      :data-tab="item.key"
      type="button"
      :aria-describedby="helpKey === item.key ? 'sidebar-column-help' : undefined"
      @mouseenter="showHelp(item.key, $event)"
      @mouseleave="scheduleHide"
      @focus="showHelp(item.key, $event)"
      @blur="hideHelp"
      @keydown.esc="hideHelp"
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

    <div class="sidebar-foot sidebar-account-footer">
      <a v-if="account" class="sidebar-account" :href="`https://x.com/${account.handle}`" target="_blank" rel="noopener noreferrer" :title="`${account.name} @${account.handle}`">
        <img v-if="account.avatarUrl && !avatarFailed" :src="account.avatarUrl" alt="" class="sidebar-account-avatar" @error="avatarFailed=true">
        <span v-else class="sidebar-account-avatar sidebar-avatar-fallback" aria-hidden="true">{{ account.name?.slice(0,1) || '?' }}</span>
        <span class="sidebar-account-name">{{ account.name || account.handle }}</span>
        <svg v-if="account.blueVerified" class="sidebar-account-blue" viewBox="0 0 24 24" width="14" height="14" role="img" aria-label="蓝 V 已认证"><title>蓝 V 已认证</title><path fill="#1d9bf0" d="m12 1 3 2 3 .5 1.5 3L22 9l-.5 3 1 3-2.5 2-1 3-3 .5-3 2-3-2-3-.5-1.5-3L2 15l.5-3-1-3L4 7l1-3 3-.5z"/><path fill="none" stroke="#fff" stroke-width="2" d="m7 12 3 3 7-7"/></svg>
      </a>
      <button v-else class="sidebar-account sidebar-account-empty" type="button" :title="accountError || '从已登录的 X 页面读取账号，点击重试'" @click="loadAccount">{{ accountLoading ? '正在识别账号…' : '未识别 X 账号' }}</button>
      <button class="sidebar-account-refresh" type="button" :disabled="accountLoading" :aria-busy="accountLoading" :title="accountError || '刷新账号'" aria-label="刷新账号" @click="loadAccount">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg>
      </button>
      <SystemSettingsDialog />
    </div>
  </aside>
  <Teleport to="body">
    <div v-if="helpKey" id="sidebar-column-help" ref="helpBubble" class="sidebar-column-help" role="tooltip" :style="helpPosition" @mouseenter="cancelHide" @mouseleave="hideHelp">
      {{ columnHelp[helpKey] }}
    </div>
  </Teleport>
</template>

<script setup>
import { computed, ref, nextTick, onMounted, onUnmounted } from 'vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';
import SystemSettingsDialog from './SystemSettingsDialog.vue';

const { activeTab, version, badges, tabs, setTab } = panelNavigationController;
const columnHelp = {
  monitor: '读取粉丝与关注列表，识别待回关账号，查看资料、标签和关系变化。',
  candidates: '查看互关关系与候选账号，补全公开资料，并将符合条件的账号加入关注队列。',
  comments: '在 X 帖子操作栏点击评论追踪图标，收集评论用户。可按关系筛选并查看来源。',
  mutualComments: '定时扫描首页，由 AI 判断互关意愿并评论。只留言、不主动关注，可回溯原帖、判断与发布结果。',
  postTracking: '追踪自己的帖子与回复，监控最近 30 条。可筛选、分析和保留内容；删除前需确认。使用指南可查看详细规则。',
  leaderboard: '按昨日净增排名，定时采集并生成日报。在 X 帖子操作栏点击灰色 X 图标，将作者加入榜单。',
  followQueue: '统一管理待处理账号，按配置执行资料检查、关注和引用评价，并查看任务状态与执行日志。',
  unreciprocated: '检测主动关注账号是否回关。超过设置期限仍未回关的账号归为超时；取关前请核对所选范围。',
  knowledge: '批量分析帖子，积累经验并合入智慧。生成时按开关引用当前智慧，经验与历史版本按账号独立保存。'
};
const helpKey = ref('');
const helpBubble = ref(null);
const helpPosition = ref({});
const account=ref(null), accountLoading=ref(false), accountError=ref(''), avatarFailed=ref(false);
async function loadAccount(){if(accountLoading.value)return;accountLoading.value=true;try{const result=await chrome.runtime.sendMessage({action:'sidebarIdentity',force:true});if(!result?.ok)throw new Error(result?.error||'账号识别失败');account.value=result.account;avatarFailed.value=false;accountError.value='';}catch(error){account.value=null;accountError.value=error.message;}finally{accountLoading.value=false;}}
onMounted(loadAccount);
let hideTimer;
function cancelHide() { clearTimeout(hideTimer); }
function hideHelp() { cancelHide(); helpKey.value = ''; }
function scheduleHide() { cancelHide(); hideTimer = setTimeout(() => { if (document.activeElement?.dataset.tab !== helpKey.value) hideHelp(); }, 120); }
async function showHelp(key, event) {
  cancelHide();
  const rect = event.currentTarget.getBoundingClientRect();
  const width = Math.min(280, window.innerWidth - 20);
  const fitsRight = rect.right + 10 + width <= window.innerWidth - 10;
  helpPosition.value = {width: `${width}px`, left: `${fitsRight ? rect.right + 10 : Math.max(10, Math.min(rect.left, window.innerWidth - width - 10))}px`, top: `${fitsRight ? rect.top : rect.bottom + 10}px`};
  helpKey.value = key;
  await nextTick();
  if (helpKey.value !== key || !helpBubble.value) return;
  const height = helpBubble.value.getBoundingClientRect().height;
  helpPosition.value.top = `${Math.max(10, Math.min(fitsRight ? rect.top : rect.bottom + 10, window.innerHeight - height - 10))}px`;
}
onMounted(() => { window.addEventListener('resize', hideHelp); window.addEventListener('scroll', hideHelp, true); });
onUnmounted(() => { cancelHide(); window.removeEventListener('resize', hideHelp); window.removeEventListener('scroll', hideHelp, true); });

const iconUrl = computed(() => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL('icon128.png');
  }
  return 'icon128.png';
});

function handleTabClick(tab) {
  hideHelp();
  if (typeof window !== 'undefined' && typeof window.setTab === 'function') {
    window.setTab(tab);
  } else {
    setTab(tab);
  }
}
</script>

<style scoped>
.sidebar-account-refresh{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:26px;height:30px;padding:0!important;margin-right:4px;background:transparent!important;border:0!important;color:inherit!important;box-shadow:none!important}.sidebar-account-refresh:hover{background:#ffffff12!important}.sidebar-account-refresh:disabled{opacity:.45;cursor:wait}.sidebar-account-refresh:focus-visible{outline:2px solid #9bc6b1;outline-offset:1px}
.sidebar-account-footer{display:flex;align-items:center;justify-content:space-between}.sidebar-account{display:flex;align-items:center;min-width:0;flex:1;margin-right:10px;color:#e3eee9;text-decoration:none;font-size:12px;overflow:hidden}.sidebar-account-avatar{width:30px;height:30px;border-radius:50%;object-fit:cover;flex-shrink:0;margin-right:8px}.sidebar-avatar-fallback{display:grid;place-items:center;background:#426759;color:#fff}.sidebar-account-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.sidebar-account-blue{flex-shrink:0;margin-left:4px}.sidebar-account-empty{background:transparent;border:0;padding:0;height:30px;text-align:left;font-weight:400;box-shadow:none}
.sidebar-column-help { position: fixed; z-index: 10000; box-sizing: border-box; padding: 10px; border-radius: 6px; background: #18302e; color: #fff; box-shadow: 0 4px 14px #18302e33; font-size: 12px; font-weight: 400; line-height: 1.6; text-align: left; white-space: normal; overflow-wrap: anywhere; }
@media(min-width:601px) and (max-width:900px){.sidebar-account-footer{flex-wrap:wrap;padding:8px 0}.sidebar-account{flex-basis:100%;margin-right:0;margin-bottom:4px}.sidebar-account-refresh{width:24px;margin-right:0}}
@media(max-width:600px){.sidebar-account-footer{display:none}}
</style>
