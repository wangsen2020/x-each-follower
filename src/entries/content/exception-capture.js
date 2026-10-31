// Classic isolated-world content script: no imports, page objects, or request bodies.
(() => {
  const flag = Symbol.for('xf.content-exception-capture');
  if (globalThis[flag]) return;
  globalThis[flag] = true;
  const redact = value => String(value || '').slice(0, 8000)
    .replace(/Bearer\s+[^\s,"';]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:token|password|authorization|api[_-]?key|secret|cookie|signature)["']?\s*[:=]\s*)["']?[^\s,"';]+/gi, '$1[已隐藏]')
    .replace(/\b(?:sk-[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[已隐藏]')
    .replace(/https?:\/\/[^\s<>"')]+/g, raw => { try { const url = new URL(raw); return url.origin + (/webhook|automation/i.test(url.pathname) ? '/[已隐藏]' : url.pathname); } catch { return '[链接已隐藏]'; } });
  const report = (error, message, kind = 'runtime', level = 'error') => {
    let entry;
    try {
      if (!chrome.runtime?.id) return;
      entry = {id:crypto.randomUUID(),at:Date.now(),source:'content',level,kind,message:redact(message || error?.message || '内容脚本异常').slice(0,2000),stack:redact(error?.stack).slice(0,6000),context:location.origin + location.pathname,version:chrome.runtime.getManifest().version};
    } catch { return; } // Old content scripts may outlive their extension context.
    const fallback = async () => {
      try {
        const saved = await chrome.storage.local.get(null);
        const pending = Object.entries(saved).filter(([key]) => key.startsWith('xfSystemException:')).sort((a,b)=>b[1].at-a[1].at);
        if(pending.length>=100)await chrome.storage.local.remove(pending.slice(99).map(([key])=>key));
        await chrome.storage.local.set({['xfSystemException:' + entry.id]:entry});
      } catch {}
    };
    try { chrome.runtime.sendMessage({cmd:'reportSystemException',entry}, response => { if (chrome.runtime.lastError || !response?.ok) void fallback(); }); }
    catch { void fallback(); }
  };
  const ownError = error => { try { return error?.stack?.includes(chrome.runtime.getURL('')); } catch { return false; } };
  addEventListener('error', event => { if (ownError(event.error) || event.filename?.startsWith(`chrome-extension://${chrome.runtime?.id}/`)) report(event.error, event.message, 'uncaught'); });
  addEventListener('unhandledrejection', event => { if (ownError(event.reason)) report(event.reason, '', 'unhandledrejection'); });
  for (const method of ['warn','error']) {
    const original = console[method];
    console[method] = function (...args) {
      original.apply(this,args);
      const error = args.find(value => value instanceof Error);
      report(error,args.filter(value => ['string','number','boolean'].includes(typeof value)).concat(error?.message || []).join(' '),`console.${method}`,method==='warn'?'warning':'error');
    };
  }
})();
