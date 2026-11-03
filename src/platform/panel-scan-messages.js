export function createPanelScanListener({api, scan, report = () => {}}) {
  const record = error => { Promise.resolve().then(() => report(error)).catch(() => {}); };
  return (message, sender, sendResponse) => {
    if (message?.cmd !== 'runFollowersScanTick') return false;
    const reply = response => { try { sendResponse(response); } catch (error) { record(error); } };
    Promise.resolve().then(() => api.tabs.getCurrent()).then(tab => {
      if (message.targetPanelTabId && tab?.id !== message.targetPanelTabId) {
        reply({ok: false, ignored: true}); return;
      }
      reply({ok: true, handledByPanel: true});
      Promise.resolve().then(() => scan('alarm')).catch(record);
    }, error => {
      reply({ok: false, error: String(error?.message || error)});
      record(error);
    });
    return true;
  };
}

export function finishScheduledPanel(message, sender, sendResponse, api) {
  const tab = sender.tab;
  const expected = api.runtime.getURL('panel.html');
  if (sender.id !== api.runtime.id || !tab?.id || tab.url?.split(/[?#]/)[0] !== expected || new URL(tab.url).searchParams.get('scheduledFollowers') !== message.token) {
    sendResponse({ok: false}); return false;
  }
  // Acknowledge while the sender is alive, then close only this scheduled tab.
  sendResponse({ok: true});
  setTimeout(() => { Promise.resolve().then(() => api.tabs.remove(tab.id)).catch(error => console.warn('定时面板关闭失败:', error)); }, 0);
  return false;
}
