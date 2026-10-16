(function () {
  if (window.__XEF_NET_HOOKED) return;
  window.__XEF_NET_HOOKED = true;
  const OPS = ['UserByScreenName','Followers','BlueVerifiedFollowers','Following','TweetDetail'];
  const RE = new RegExp('/graphql/([^/?]+)/(' + OPS.join('|') + ')(?=[/?#]|$)');
  const wanted = ['authorization','x-csrf-token','x-client-transaction-id','x-twitter-auth-type','x-twitter-active-user','x-twitter-client-language'];
  const headers = input => {
    const out = {};
    try {
      if (Array.isArray(input)) {
        for (const [k, v] of input) if (wanted.includes(String(k).toLowerCase())) out[String(k).toLowerCase()] = v;
      } else if (input?.forEach) {
        input.forEach((v, k) => { if (wanted.includes(String(k).toLowerCase())) out[String(k).toLowerCase()] = v; });
      } else {
        for (const key of Object.keys(input || {})) if (wanted.includes(key.toLowerCase())) out[key.toLowerCase()] = input[key];
      }
    } catch {}
    return out;
  };
  const post = payload => window.postMessage({__xfdNetwork:true, payload}, '*');
  const capture = (url, h, json) => {
    const match = RE.exec(String(url)); if (!match) return;
    const op = match[2];
    const head = headers(h);
    if (op === 'Followers' && !head['x-client-transaction-id']) return;
    const u = new URL(String(url), location.origin); const q = u.searchParams;
    let vars = null; try { vars = JSON.parse(q.get('variables') || '{}'); } catch {}
    if (vars?.cursor) return;
    post({op, queryId:match[1], origin:u.origin, features:q.get('features'), fieldToggles:q.get('fieldToggles'), variables:q.get('variables'), headers:head, json:json || null, at:Date.now()});
  };
  const isInternal = (h, init) => {
    try {
      if (init?.__xefInternal === true) return true;
      if (!h) return false;
      if (typeof h.get === 'function') return Boolean(h.get('x-xef-internal'));
      for (const k of Object.keys(h)) if (String(k).toLowerCase() === 'x-xef-internal') return true;
    } catch {}
    return false;
  };
  const fetch0 = window.fetch;
  if (fetch0) window.fetch = function (...args) {
    let url = ''; let h = null;
    try { const a = args[0]; url = typeof a === 'string' ? a : a?.url || a?.href || ''; h = args[1]?.headers || a?.headers; } catch {}
    const promise = fetch0.apply(this, args);
    if (!isInternal(h, args[1]) && RE.test(url)) {
      promise.then(r => {
        if (r && r.status >= 200 && r.status < 300) {
          r.clone().json().then(j => capture(url, h, j)).catch(() => capture(url, h));
        }
      }).catch(() => {});
    }
    return promise;
  };
  const xp = XMLHttpRequest.prototype, open = xp.open, send = xp.send, set = xp.setRequestHeader;
  xp.open = function(method, url, ...rest) { this.__xefUrl = String(url); this.__xefHeaders = {}; return open.call(this, method, url, ...rest); };
  xp.setRequestHeader = function(k, v) { this.__xefHeaders[String(k).toLowerCase()] = v; return set.call(this, k, v); };
  xp.send = function(...args) {
    if (!this.__xefHeaders?.['x-xef-internal'] && RE.test(this.__xefUrl || '')) {
      this.addEventListener('load', () => {
        try {
          if (this.status >= 200 && this.status < 300) {
            let json = null;
            try { json = JSON.parse(this.responseText); } catch {}
            capture(this.__xefUrl, this.__xefHeaders, json);
          }
        } catch {}
      });
    }
    return send.apply(this, args);
  };
})();
