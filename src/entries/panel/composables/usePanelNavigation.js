import {APP_VERSION} from '../../../shared/version.js';
import { ref, computed, reactive } from 'vue';
import {logsModalController} from './useExecutionLogs.js';

export const TAB_TITLES = {
  monitor: '粉丝跟进',
  candidates: '互关追踪',
  comments: '评论追踪',
  mutualComments: '互粉评论',
  postTracking: '帖子追踪',
  leaderboard: 'X 榜单',
  followQueue: '关注队列',
  unreciprocated: '回关监控',
  knowledge: '知识库'
};

const ALL_NAV_TABS = [
  { key: 'monitor', label: '粉丝跟进', badgeId: 'queueCount', hasBadge: true },
  { key: 'candidates', label: '互关追踪', badgeId: 'mutualNetworkCount', hasBadge: true },
  { key: 'comments', label: '评论追踪', badgeId: 'commentTrackingCount', hasBadge: true },
  { key: 'mutualComments', label: '互粉评论', badgeId: null, hasBadge: false },
  { key: 'postTracking', label: '帖子追踪', badgeId: null, hasBadge: false },
  { key: 'leaderboard', label: 'X 榜单', badgeId: null, hasBadge: false },
  { key: 'followQueue', label: '关注队列', badgeId: null, hasBadge: false },
  { key: 'unreciprocated', label: '回关监控', badgeId: 'unreciprocatedCount', hasBadge: true },
  { key: 'knowledge', label: '知识库', badgeId: null, hasBadge: false }
];

export const NAV_TABS = ALL_NAV_TABS;

export function usePanelNavigation() {
  const activeTab = ref('monitor');
  const version = ref(
    typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version
      ? chrome.runtime.getManifest().version
      : APP_VERSION
  );

  const badges = reactive({
    monitor: { count: null, loading: true },
    candidates: { count: null, loading: true },
    comments: { count: null, loading: true },
    postTracking: { count: null, loading: false },
    leaderboard: { count: null, loading: false },
    followQueue: { count: null, loading: false },
    unreciprocated: { count: null, loading: true },
    knowledge: { count: null, loading: false }
  });

  const currentTitle = computed(() => TAB_TITLES[activeTab.value] || '粉丝跟进');

  function setTab(tab) {
    if (!TAB_TITLES[tab]) return;
    if (tab !== activeTab.value) logsModalController.close();
    activeTab.value = tab;
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('panel-tab-changed', { detail: { tab } }));
    }
  }

  function updateBadge(key, { count = null, loading = false } = {}) {
    if (!badges[key]) return;
    badges[key].count = count;
    badges[key].loading = loading;
  }

  return {
    activeTab,
    version,
    badges,
    currentTitle,
    tabs: NAV_TABS,
    setTab,
    updateBadge
  };
}

export const panelNavigationController = usePanelNavigation();
