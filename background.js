chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'x-followers-scan') return;
  const { monitor } = await chrome.storage.local.get('monitor');
  if (!monitor?.enabled) return;
  await chrome.notifications.create(`x-followers-${Date.now()}`, {type:'basic', iconUrl:'icon128.svg', title:'X 回关检查时间到了', message:'打开插件并扫描粉丝，查看待回关账号。'});
});
