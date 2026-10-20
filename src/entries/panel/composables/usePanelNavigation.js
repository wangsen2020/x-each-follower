import { ref, computed, reactive } from 'vue';

export const TAB_TITLES = {
  monitor: '粉丝管理',
  candidates: '互关追踪',
  comments: '评论追踪',
  followQueue: '关注队列',
  unreciprocated: '回关监测'
};

export const NAV_TABS = [
  { key: 'monitor', label: '粉丝管理', badgeId: 'queueCount', hasBadge: true },
  { key: 'candidates', label: '互关追踪', badgeId: 'mutualNetworkCount', hasBadge: true },
  { key: 'comments', label: '评论追踪', badgeId: 'commentTrackingCount', hasBadge: true },
  { key: 'followQueue', label: '关注队列', badgeId: null, hasBadge: false },
  { key: 'unreciprocated', label: '回关监测', badgeId: 'unreciprocatedCount', hasBadge: true }
];

export function usePanelNavigation() {
  const activeTab = ref('monitor');
  const version = ref(
    typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version
      ? chrome.runtime.getManifest().version
      : '1.8.4'
  );

  const badges = reactive({
    monitor: { count: null, loading: true },
    candidates: { count: null, loading: true },
    comments: { count: null, loading: true },
    followQueue: { count: null, loading: false },
    unreciprocated: { count: null, loading: true }
  });

  const currentTitle = computed(() => TAB_TITLES[activeTab.value] || '粉丝管理');

  function setTab(tab) {
    if (!TAB_TITLES[tab]) return;
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
