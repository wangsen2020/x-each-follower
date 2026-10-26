// Coalesce overlapping scan alarms; never retry an uncertain tab creation.
export function createPanelLauncher({api, sendToPanel, makeToken = () => crypto.randomUUID(), warn = console.warn}) {
  let scanInFlight;

  async function open(url, active, preferredWindowId) {
    try {
      const windows = await api.windows.getAll({windowTypes:['normal']});
      const window = windows.find(item => item.id === preferredWindowId)
        || windows.find(item => item.focused) || windows[0];
      if (!window) return {ok:false, reason:'no_window'};
      const tab = await api.tabs.create({url, active, windowId:window.id});
      return {ok:true, tabId:tab.id};
    } catch (error) {
      warn('看板打开失败，本轮不重试:', error?.message || error);
      return {ok:false, reason:'open_failed'};
    }
  }

  function runScheduledScan() {
    if (scanInFlight) return scanInFlight;
    scanInFlight = (async () => {
      try {
        const url = api.runtime.getURL('panel.html');
        const tabs = (await api.tabs.query({})).filter(tab => tab.url?.startsWith(url));
        if (tabs.some(tab => tab.url.includes('?scheduledFollowers='))) return {ok:true, existing:true};
        if (tabs.length) {
          let timer;
          try {
            const result = await Promise.race([
              sendToPanel({cmd:'runFollowersScanTick', targetPanelTabId:tabs[0].id}),
              new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); })
            ]);
            // A missing response does not prove the scan was not started.
            return {ok:Boolean(result?.ok), existing:true};
          } finally { clearTimeout(timer); }
        }
        const result = await open(`${url}?scheduledFollowers=${makeToken()}`, false);
        if (result.reason === 'no_window') warn('粉丝定时检测延后：没有浏览器窗口，等待下一次定时执行');
        return result;
      } catch (error) {
        warn('粉丝定时检测启动失败，本轮不重试:', error?.message || error);
        return {ok:false, reason:'launch_failed'};
      }
    })().finally(() => { scanInFlight = null; });
    return scanInFlight;
  }

  return {
    runScheduledScan,
    openPanel: windowId => open(api.runtime.getURL('panel.html'), true, windowId)
  };
}
