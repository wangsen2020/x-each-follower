(function () {
  let active = true;
  const isInvalidContext = error => /extension context invalidated|message port closed|receiving end does not exist/i.test(String(error?.message || error));
  const forward = event => {
    if (!active || event.source !== window || !event.data || event.data.__xfdNetwork !== true) return;
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
      const payload = event.data.payload;
      if(payload?.kind==='x-rate-limit')return; // Ignore retired observers in existing tabs.
      if (payload?.kind === 'grok') {
        chrome.runtime.sendMessage({cmd: 'grokStreamAnswer', text: payload.text, raw: payload.raw}).catch(() => {});
        return;
      }
      const request = chrome.runtime.sendMessage({cmd:'networkTemplate', payload});
      request?.catch(error => {
        if (isInvalidContext(error)) {
          active = false;
          window.removeEventListener('message', forward);
        }
      });
    } catch (error) {
      if (isInvalidContext(error)) {
        active = false;
        window.removeEventListener('message', forward);
      }
    }
  };
  window.addEventListener('message', forward);
})();
