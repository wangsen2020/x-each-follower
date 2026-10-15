chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.cmd !== 'networkTemplate' || !message.payload?.op) return;
  chrome.storage.local.get('networkTemplates').then(({networkTemplates = {}}) => {
    const p = message.payload;
    networkTemplates[p.op] = {...networkTemplates[p.op], ...p, json:undefined};
    return chrome.storage.local.set({networkTemplates});
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.cmd !== 'getNetworkTemplates') return;
  chrome.storage.local.get('networkTemplates').then(({networkTemplates = {}}) => sendResponse(networkTemplates));
  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'x-followers-scan') return;
  const { monitor } = await chrome.storage.local.get('monitor');
  if (!monitor?.enabled) return;
  await chrome.notifications.create(`x-followers-${Date.now()}`, {type:'basic', iconUrl:'icon128.svg', title:'X 回关检查时间到了', message:'打开插件并扫描粉丝，查看待回关账号。'});
});
