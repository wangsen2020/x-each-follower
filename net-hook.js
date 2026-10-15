(function () {
  if (window.__XEF_NET_HOOKED) return;
  window.__XEF_NET_HOOKED = true;
  const OPS = ['UserByScreenName','Followers','Following'];
  const RE = new RegExp('/graphql/([^/?]+)/(' + OPS.join('|') + ')');
  const wanted = ['authorization','x-csrf-token','x-twitter-auth-type','x-twitter-active-user','x-twitter-client-language'];
  const headers = input => {
    const out = {};
    try { if (input?.forEach) input.forEach((v,k) => { if (wanted.includes(String(k).toLowerCase())) out[String(k).toLowerCase()] = v; });
      else for (const key of Object.keys(input || {})) if (wanted.includes(key.toLowerCase())) out[key.toLowerCase()] = input[key]; } catch {}
    return out;
  };
  const post = payload => window.postMessage({__xfdNetwork:true, payload}, '*');
  const capture = (url, h, json) => {
    const match = RE.exec(String(url)); if (!match) return;
    const u = new URL(String(url), location.origin); const q = u.searchParams;
    post({op:match[2], queryId:match[1], origin:u.origin, features:q.get('features'), fieldToggles:q.get('fieldToggles'), variables:q.get('variables'), headers:headers(h), json:json || null, at:Date.now()});
  };
  const fetch0 = window.fetch;
  if (fetch0) window.fetch = function (...args) {
    let url=''; let h=null; try { const a=args[0]; url=typeof a==='string'?a:a?.url||a?.href||''; h=args[1]?.headers||a?.headers; } catch {}
    const promise=fetch0.apply(this,args); if (RE.test(url)) { capture(url,h); promise.then(r=>r.clone().json().then(j=>capture(url,h,j)).catch(()=>{})).catch(()=>{}); } return promise;
  };
  const xp=XMLHttpRequest.prototype, open=xp.open, send=xp.send, set=xp.setRequestHeader;
  xp.open=function(method,url,...rest){this.__xefUrl=String(url);this.__xefHeaders={};return open.call(this,method,url,...rest)};
  xp.setRequestHeader=function(k,v){this.__xefHeaders[String(k).toLowerCase()]=v;return set.call(this,k,v)};
  xp.send=function(...args){if(RE.test(this.__xefUrl||'')){capture(this.__xefUrl,this.__xefHeaders);this.addEventListener('load',()=>{try{capture(this.__xefUrl,this.__xefHeaders,JSON.parse(this.responseText))}catch{}})}return send.apply(this,args)};
})();
