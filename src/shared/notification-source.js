// Stable IDs also resolve notifications created before a service-worker restart.
const SOURCES = [
  ['follow-queue-', 'followQueue', '关注队列'],
  ['x-comment-auto-', 'comments', '评论追踪'],
  ['x-mutual-auto-', 'candidates', '互关追踪'],
  ['x-unreciprocated-', 'unreciprocated', '回关监控']
];
const PANEL_TABS = new Set(['monitor', 'candidates', 'comments', 'postTracking', 'leaderboard', 'followQueue', 'unreciprocated', 'knowledge']);

export function notificationSource(id) {
  const source = SOURCES.find(([prefix]) => String(id).startsWith(prefix));
  return source ? {tab: source[1], label: source[2]} : null;
}

export function panelSourceTab(search) {
  const tab = new URLSearchParams(search).get('tab');
  return PANEL_TABS.has(tab) ? tab : null;
}

export function panelSourcePath(tab) {
  return PANEL_TABS.has(tab) ? `panel.html?tab=${encodeURIComponent(tab)}` : 'panel.html';
}

export function createNotificationClickHandler({api, launcher, openVerification, openGrok, warn = console.warn}) {
  return async id => {
    try {
      let result;
      if (id === 'xf-grok-verification') result = await openVerification();
      else if (id === 'xf-grok-intervention') result = await openGrok();
      else {
        const source = notificationSource(id);
        if (!source) return;
        result = await launcher.openPanel(undefined, source.tab);
      }
      if (result?.ok !== false) await api.notifications.clear(id);
    } catch (error) {
      warn('通知来源打开失败:', error?.message || error);
    }
  };
}
