(function () {
  if (window.__XEF_NET_HOOKED) return;
  window.__XEF_NET_HOOKED = true;
  const OPS = ['HomeTimeline','HomeLatestTimeline','UserByScreenName','Followers','BlueVerifiedFollowers','Following','TweetDetail','UserTweets','UserTweetsAndReplies','UserOriginalsTimeline','UserRepliesTimeline','contentPageQuery'];
  const RE = new RegExp('/graphql/([^/?]+)/(' + OPS.join('|') + ')(?=[/?#]|$)');
  const wanted = ['authorization','x-csrf-token','x-client-transaction-id','x-twitter-auth-type','x-twitter-active-user','x-twitter-client-language'];
  // Only the extension-owned initialization tab may bound X's native first query.
  // Ordinary analytics tabs remain untouched, and one bootstrap cannot fan out.
  const bootstrap=(()=>{try{
    const u=new URL(location.href),id=u.searchParams.get('xef_post_bootstrap'),limit=Number(u.searchParams.get('xef_limit')),from=Number(u.searchParams.get('xef_from')),to=Number(u.searchParams.get('xef_to'));
    if(u.origin!=='https://x.com'||u.pathname!=='/i/account_analytics/content'||!/^[a-z0-9-]{8,64}$/.test(id||'')||!Number.isInteger(limit)||limit<10||limit>1000||!Number.isFinite(from)||!Number.isFinite(to)||from>to||to-from>21600000||from<Date.now()-90*86400000||to>Date.now()+1000)return null;
    return {id,limit,from,to};
  }catch{return null;}})();
  let bootstrapResponse,bootstrapStarted=false;
  function boundBootstrapUrl(input){
    if(!bootstrap)return input;
    try{const u=new URL(String(input),location.origin);if(u.origin!==location.origin||RE.exec(u.href)?.[2]!=='contentPageQuery')return input;
      const variables=JSON.parse(u.searchParams.get('variables')||'{}');Object.assign(variables,{max_results:bootstrap.limit,query_page_size:bootstrap.limit,from_time:new Date(bootstrap.from).toISOString(),to_time:new Date(bootstrap.to).toISOString()});
      u.searchParams.set('variables',JSON.stringify(variables));return u.href;
    }catch{return input;}
  }
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
  const capture = (url, h, json, details={}) => {
    const match = RE.exec(String(url)); if (!match) return;
    const op = match[2];
    const head = headers(h);
    if (op === 'Followers' && !head['x-client-transaction-id']) return;
    const u = new URL(String(url), location.origin); const q = u.searchParams;
    let vars = null; try { vars = JSON.parse(q.get('variables') || '{}'); } catch {}
    if (vars?.cursor) return;
    if (['HomeTimeline','HomeLatestTimeline'].includes(op) && json && !json.errors?.length && location.pathname==='/home') window.__xefNativeHome={op,json,at:Date.now(),template:{op,queryId:match[1],origin:u.origin,features:q.get('features'),fieldToggles:q.get('fieldToggles'),variables:q.get('variables'),headers:head}};
    // Reuse only the native response from this page, never an extension replay.
    if (op === 'UserByScreenName' && json && !json.errors?.length && u.origin === location.origin) {
      const handle = String(vars?.screen_name || '').toLowerCase();
      const route=location.pathname.toLowerCase().split('/').filter(Boolean);
      if (handle && route[0]===handle && (route.length===1 || route.length===2 && ['followers','following','verified_followers','with_replies'].includes(route[1]))) {
        window.__xefNativeProfile = {handle, json, at:Date.now(), path:location.pathname};
      }
    }

    post({op, queryId:match[1], origin:u.origin, features:q.get('features'), fieldToggles:q.get('fieldToggles'), variables:q.get('variables'), headers:head, json:json || null, at:Date.now(),...(bootstrap&&op==='contentPageQuery'?{bootstrapId:bootstrap.id}:{}) ,...details});
  };
  const GROK_RE = /\/2\/grok\/add_response\.json/;
  const beginGrokStream = (input, init) => {
    const state = {requestId:crypto.randomUUID(), nonce:'', startedAt:Date.now(), lastChunkAt:0,
      endedAt:0, chunks:0, status:'pending'};
    window.__xefGrokStream = state;
    const readNonce = body => {
      let text = typeof body === 'string' ? body : '';
      try { text = JSON.stringify(JSON.parse(text)); } catch {}
      state.nonce = text.match(/任务编号[\w-]+/)?.[0] || '';
    };
    if (typeof init?.body === 'string') readNonce(init.body);
    else if (input?.clone) { try { input.clone().text().then(readNonce).catch(()=>{}); } catch {} }
    return state;
  };
  const readGrokStream = async (response, state) => {
    state.httpStatus = response.status;
    state.status = response.ok ? 'streaming' : 'http-error';
    try {
      const copy = response.clone();
      if (!copy.body?.getReader) {
        const text = await copy.text();
        state.lastChunkAt = Date.now();
        if (response.ok) state.status = 'complete';
        state.endedAt = Date.now();
        emitGrok(text);
        return;
      }
      const reader = copy.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        state.lastChunkAt = Date.now();
        state.chunks++;
        // This clone observes the response without consuming X's own stream.
        if (text.length < 4 * 1024 * 1024) text += decoder.decode(chunk.value, {stream:true});
      }
      text += decoder.decode();
      state.endedAt = Date.now();
      if (response.ok) state.status = 'complete';
      emitGrok(text);
    } catch (error) {
      state.status = 'error';
      state.endedAt = Date.now();
      state.error = String(error?.message || error).slice(0,200);
    }
  };
  const emitGrok = text => {
    const finals = [];
    const others = [];
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line).result;
        if (!r || typeof r.message !== 'string') continue;
        if (r.messageTag === 'final') finals.push(r.message);
        else if (!r.isThinking && r.messageTag !== 'header') others.push(r.message);
      } catch {}
    }
    const msg = finals.length ? finals.join('') : others.join('');
    post({ kind: 'grok', text: msg, raw: msg ? '' : String(text).slice(0, 400) });
  };
  // X's current Grok client uses a persistent WebSocket. Silence includes
  // ordinary thinking and heartbeats; only the correlated response.done ends it.
  const socketPrototype = window.WebSocket?.prototype;
  const socketSend = socketPrototype?.send;
  if (socketSend) {
    const sockets = new WeakMap();
    let socketSequence = 0;
    const observeSocket = socket => {
      if (!sockets.has(socket)) {
        const socketId = ++socketSequence;
        sockets.set(socket,socketId);
        socket.addEventListener('message', message => {
          // A response can resume on a replacement socket after reconnecting.
          // Its response ID, rather than the socket object, identifies the turn.
          const current=window.__xefGrokStream;
          if (current?.transport !== 'websocket' || typeof message.data !== 'string') return;
          let incoming;
          try { incoming=JSON.parse(message.data).event; } catch { return; }
          if (incoming?.type==='response.created' && incoming.client_event_id===current.clientEventId) {
            current.responseId=incoming.response?.id || incoming.response?.response_id || '';
            if (current.responseId) {current.status='streaming';current.socketId=socketId;}
            return;
          }
          const responseId=incoming?.response_id || incoming?.response?.id || incoming?.response?.response_id;
          if (!current.responseId || responseId!==current.responseId || current.terminalEvent) return;
          if (incoming.type==='response.chunk') {
            current.lastChunkAt=Date.now();current.chunks++;current.status='streaming';current.socketId=socketId;
          } else if (incoming.type==='response.done') {
            current.endedAt=Date.now();current.terminalEvent='response.done';current.socketId=socketId;
            current.status=incoming.response?.error || /^(?:failed|cancelled|canceled|incomplete|error)$/.test(incoming.response?.status || '') ? 'error' : 'complete';
          }
        });
        for (const eventName of ['close','error']) socket.addEventListener(eventName, () => {
          const current=window.__xefGrokStream;
          if (current?.transport==='websocket' && current.socketId===socketId && !current.endedAt) {
            current.status='reconnecting';current.disconnectedAt=Date.now();
          }
        });
      }
      return socket;
    };
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target,args,newTarget) {return observeSocket(Reflect.construct(target,args,newTarget));}
    });
    socketPrototype.send = function(data) {
      observeSocket(this);
      let envelope;
      try { if (typeof data === 'string') envelope = JSON.parse(data); } catch {}
      const event = envelope?.event;
      if (event?.type === 'response.create' && typeof event.event_id === 'string') {
        const nonce = String(data).match(/任务编号[\w-]+/)?.[0];
        if (nonce) {
          const state = beginGrokStream(null, {body:data});
          state.transport='websocket';state.clientEventId=event.event_id;state.responseId='';
          state.socketId=sockets.get(this);
        }
      }
      return socketSend.call(this,data);
    };
  }
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
    const bounded=bootstrap&&RE.exec(url)?.[2]==='contentPageQuery';
    if(bounded){
      if(bootstrapResponse)return bootstrapResponse.then(r=>r.clone());
      if(bootstrapStarted)return Promise.reject(new Error('初始化分析请求已发出'));
      bootstrapStarted=true;
      url=boundBootstrapUrl(url);args[0]=typeof args[0]==='string'?url:args[0]?.clone?new Request(url,args[0]):url;
    }
    const grokState = GROK_RE.test(url) ? beginGrokStream(args[0], args[1]) : null;
    const promise = fetch0.apply(this, args);
    if(bounded){bootstrapResponse=promise.then(r=>r.clone());bootstrapResponse.catch(()=>{});}
    if (GROK_RE.test(url)) {
      promise.then(r => {
        readGrokStream(r, grokState).catch(() => {});
      }).catch(error => {grokState.status='error';grokState.endedAt=Date.now();grokState.error=String(error?.message || error).slice(0,200);});
    }
    if (!isInternal(h, args[1]) && RE.test(url)) {
      promise.then(r => {
        if (r && r.status >= 200 && r.status < 300) {
          r.clone().json().then(j => capture(url, h, j)).catch(() => capture(url, h));
        }else if(bounded&&r){
          const header=r.headers.get('retry-after');const delay=header?(/^\d+$/.test(header)?Number(header):Math.max(0,(Date.parse(header)-Date.now())/1000)):0;
          capture(url,h,{}, {httpStatus:r.status,retryAfterSeconds:Number.isFinite(delay)?delay:0});
        }
      }).catch(() => {});
    }
    return promise;
  };
  const xp = XMLHttpRequest.prototype, open = xp.open, send = xp.send, set = xp.setRequestHeader;
  xp.open = function(method, url, ...rest) { url=boundBootstrapUrl(url);this.__xefUrl = String(url); this.__xefHeaders = {}; return open.call(this, method, url, ...rest); };
  xp.setRequestHeader = function(k, v) { this.__xefHeaders[String(k).toLowerCase()] = v; return set.call(this, k, v); };
  xp.send = function(...args) {
    if(bootstrap&&RE.exec(this.__xefUrl||'')?.[2]==='contentPageQuery'){
      if(bootstrapStarted){this.abort?.();return;}
      bootstrapStarted=true;
    }
    if (GROK_RE.test(this.__xefUrl || '')) {
      const state = beginGrokStream(null, {body:args[0]});
      state.status = 'streaming';
      this.addEventListener('progress', () => {state.lastChunkAt=Date.now();state.chunks++;});
      this.addEventListener('load', () => {
        state.httpStatus=this.status;
        state.status=this.status>=200 && this.status<300 ? 'complete' : 'http-error';
        state.endedAt=Date.now();
        try { emitGrok(this.responseText); } catch {}
      });
      for (const event of ['error','abort','timeout']) this.addEventListener(event, () => {
        state.status='error';state.endedAt=Date.now();state.error=event;
      });
    }
    if (!this.__xefHeaders?.['x-xef-internal'] && RE.test(this.__xefUrl || '')) {
      this.addEventListener('load', () => {
        try {
          if (this.status >= 200 && this.status < 300) {
            let json = null;
            try { json = JSON.parse(this.responseText); } catch {}
            capture(this.__xefUrl, this.__xefHeaders, json);
          }else if(bootstrap&&RE.exec(this.__xefUrl||'')?.[2]==='contentPageQuery'){
            const header=this.getResponseHeader('retry-after');const delay=header?(/^\d+$/.test(header)?Number(header):Math.max(0,(Date.parse(header)-Date.now())/1000)):0;
            capture(this.__xefUrl,this.__xefHeaders,{}, {httpStatus:this.status,retryAfterSeconds:Number.isFinite(delay)?delay:0});
          }
        } catch {}
      });
    }
    return send.apply(this, args);
  };
})();
