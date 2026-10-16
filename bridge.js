(function () {
  let active = true;
  const isInvalidContext = error => /extension context invalidated|message port closed|receiving end does not exist/i.test(String(error?.message || error));
  const forward = event => {
    if (!active || event.source !== window || !event.data || event.data.__xfdNetwork !== true) return;
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
      const request = chrome.runtime.sendMessage({cmd:'networkTemplate', payload:event.data.payload});
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
