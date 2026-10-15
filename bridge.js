(function () {
  window.addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.__xfdNetwork !== true) return;
    chrome.runtime.sendMessage({cmd:'networkTemplate', payload:event.data.payload});
  });
})();
