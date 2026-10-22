const PANEL_ACTIONS = new Set(['state', 'settings', 'scan', 'analyze', 'report', 'membership', 'add', 'remove']);
const CONTENT_ACTIONS = new Set(['membership', 'add', 'remove']);

export function canUseLeaderboardAction({runtimeId, panelUrl, sender, action}) {
  if (sender?.id !== runtimeId) return false;
  const url = sender.url?.split(/[?#]/)[0];
  if (url === panelUrl) return PANEL_ACTIONS.has(action);
  return Number.isInteger(sender.tab?.id)
    && /^https:\/\/(?:x\.com|twitter\.com)\//.test(sender.url || '')
    && CONTENT_ACTIONS.has(action);
}
