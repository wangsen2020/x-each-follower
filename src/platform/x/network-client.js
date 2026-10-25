import {assertProfileAvailable,observeProfile,unavailableFromProfileResponse,profileUnavailableError} from './profile-access.js';
// Transport owns session mechanics; confirmation, scheduling and retries belong to callers.
export const X_QUERY_OPERATIONS=Object.freeze(['UserByScreenName','Followers','BlueVerifiedFollowers','Following','TweetDetail','UserTweets','UserTweetsAndReplies','UserOriginalsTimeline','UserRepliesTimeline','contentPageQuery']);
const FORMS=Object.freeze({Follow:'friendships/create.json',Unfollow:'friendships/destroy.json',Block:'blocks/create.json',Unblock:'blocks/destroy.json'});
const SESSION_HEADERS=['authorization','x-csrf-token','x-twitter-auth-type','x-twitter-active-user','x-twitter-client-language'];

export function prepareNetworkHeaders(input={},operation='') {
  const headers={};for(const [k,v]of Object.entries(input))if(v!=null)headers[k.toLowerCase()]=v;
  headers['content-type']='application/json';
  if(operation==='Followers')delete headers['x-client-transaction-id'];
  return headers;
}
export function prepareNetworkVariables(input,overrides={}) {
  let base={};try{base=typeof input==='string'?JSON.parse(input):(input||{});}catch{}
  // Captured first-page templates must not carry pagination into a new scan.
  const {cursor,...rest}=base;return {...rest,...overrides};
}
export function redactNetworkError(value,headers={}) {
  let text=String(value||'');
  for(const key of ['authorization','x-csrf-token','x-client-transaction-id']) {
    const secret=Object.entries(headers).find(([k])=>k.toLowerCase()===key)?.[1];
    if(secret)text=text.split(String(secret)).join('[redacted]');
  }
  return text.replace(/Bearer\s+[\w.\-/+=]+/gi,'Bearer [redacted]').slice(0,240);
}
export function buildXRequest(operation,template,variables={}) {
  if(!X_QUERY_OPERATIONS.includes(operation)&&!FORMS[operation]&&operation!=='DeleteTweet')throw new Error('不支持的 X 网络操作');
  if(!template||!['https://x.com','https://twitter.com'].includes(template.origin))throw new Error('X 请求模板来源无效');
  const lower=prepareNetworkHeaders(template.headers);
  if(!lower.authorization||!lower['x-csrf-token'])throw new Error('当前 X 会话模板尚未就绪');
  const headers=Object.fromEntries(SESSION_HEADERS.filter(k=>lower[k]).map(k=>[k,lower[k]]));
  if(FORMS[operation]) {
    const target=variables || {};const id=String(target.id || target.userId || '');const handle=String(target.handle || target.screen_name || '').replace(/^@/,'');
    if(!/^\d+$/.test(id)&&!/^\w{1,15}$/.test(handle))throw new Error('用户 ID 或账号名无效');
    const params={skip_status:'true'};if(/^\d+$/.test(id))params.user_id=id;if(/^\w{1,15}$/.test(handle))params.screen_name=handle;
    return {operation,origin:template.origin,path:`/i/api/1.1/${FORMS[operation]}`,method:'POST',kind:'form',headers,body:new URLSearchParams(params).toString()};
  }
  if(operation==='DeleteTweet') {
    if(typeof variables.tweet_id!=='string'||!/^\d+$/.test(variables.tweet_id))throw new Error('删除帖子 ID 必须是字符串');
    return {operation,origin:template.origin,method:'POST',kind:'mutation',headers,variables:{tweet_id:variables.tweet_id}};
  }
  if(!/^[\w-]+$/.test(template.queryId || '')||template.op&&template.op!==operation)throw new Error(`未捕获 ${operation} 模板`);
  const query=new URLSearchParams({variables:JSON.stringify(prepareNetworkVariables(template.variables,variables)),...(template.features?{features:template.features}:{}),...(template.fieldToggles?{fieldToggles:template.fieldToggles}:{})});
  return {operation,origin:template.origin,path:`/i/api/graphql/${template.queryId}/${operation}?${query}`,method:'GET',kind:'query',headers};
}

// Self-contained: Chrome serializes this function into the authenticated X MAIN world.
export async function executeXRequestOnPage(request) {
  // One page/session owns pending reads. Never retain completed responses.
  const pending = window.__xefPendingReads ||= new Map();
  const readable = request.kind === 'query' && request.method === 'GET';
  const key = readable ? JSON.stringify([request.origin,request.operation,request.path,
    Object.entries(request.headers || {}).sort(([a],[b])=>a.localeCompare(b))]) : null;
  if (key && pending.has(key)) return structuredClone(await pending.get(key));
  if (!readable) {pending.clear();window.__xefNativeProfile=null;}
  const execute = async () => {
  let attempted=false;const started=Date.now(),timings={metadataMs:0,signatureMs:0,requestMs:0};
  const redact=value=> {
    let text=String(value||'');for(const key of ['authorization','x-csrf-token','x-client-transaction-id'])if(request.headers[key])text=text.split(request.headers[key]).join('[redacted]');
    return text.replace(/Bearer\s+[\w.\-/+=]+/gi,'Bearer [redacted]').slice(0,240);
  };
  try {
    if(!['https://x.com','https://twitter.com'].includes(location.origin)||location.origin!==request.origin)throw new Error('X 请求页面来源不匹配');
    const allowedQueries=['UserByScreenName','Followers','BlueVerifiedFollowers','Following','TweetDetail','UserTweets','UserTweetsAndReplies','UserOriginalsTimeline','UserRepliesTimeline','contentPageQuery'];
    const allowedForms={Follow:'friendships/create.json',Unfollow:'friendships/destroy.json',Block:'blocks/create.json',Unblock:'blocks/destroy.json'};
    if(request.kind==='query') {
      const match=/^\/i\/api\/graphql\/[\w-]+\/([\w]+)\?/.exec(request.path||'');
      if(request.method!=='GET'||!allowedQueries.includes(request.operation)||match?.[1]!==request.operation)throw new Error('不支持的 X 查询路径');
    } else if(request.kind==='form') {
      if(request.method!=='POST'||!allowedForms[request.operation]||request.path!==`/i/api/1.1/${allowedForms[request.operation]}`)throw new Error('不支持的 X 写入路径');
    } else if(request.kind!=='mutation')throw new Error('不支持的 X 请求类型');
    let path=request.path;
    if(request.kind==='mutation') {
      if(request.operation!=='DeleteTweet'||request.method!=='POST'||typeof request.variables?.tweet_id!=='string'||!/^\d+$/.test(request.variables.tweet_id))throw new Error('不支持的写入操作');
      const script=[...document.scripts].map(s=>s.src).find(u=>/^https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[\w]+\.js$/.test(u));
      if(!script)throw new Error('找不到当前 X 客户端，未执行删除');
      const metadataStarted=Date.now(),cached=window.__XEF_DELETE_QUERY_CACHE;
      let queryId=cached?.script===script&&/^[\w-]+$/.test(cached.queryId||'')?cached.queryId:null;
      if(!queryId){
        const response=await fetch(script,{signal:AbortSignal.timeout(25000)});if(!response.ok)throw new Error('X 客户端元数据读取失败');
        queryId=(await response.text()).match(/queryId:"([\w-]+)",operationName:"DeleteTweet",operationType:"mutation"/)?.[1];
        if(!queryId)throw new Error('当前 X 删除接口元数据不可用');
        window.__XEF_DELETE_QUERY_CACHE={script,queryId};
      }
      timings.metadataMs=Date.now()-metadataStarted;
      path=`/i/api/graphql/${queryId}/DeleteTweet`;request.body=JSON.stringify({variables:request.variables,queryId});
    }
    if(typeof window.__XEF_GENERATE_TRANSACTION_ID!=='function')throw new Error('X 请求签名器尚未加载');
    const headers={...request.headers,'content-type':request.kind==='form'?'application/x-www-form-urlencoded;charset=UTF-8':'application/json'};
    // Never replay a captured transaction ID for another method or path.
    const signatureStarted=Date.now();
    headers['x-client-transaction-id']=await window.__XEF_GENERATE_TRANSACTION_ID(request.method,new URL(path,location.origin).pathname);
    timings.signatureMs=Date.now()-signatureStarted;
    const init={method:request.method,credentials:'include',headers,signal:AbortSignal.timeout(25000)};
    if(request.method!=='GET')init.body=request.body;
    Object.defineProperty(init,'__xefInternal',{value:true});
    const requestStarted=Date.now();attempted=true;
    const response=await fetch(new URL(path,location.origin).href,init);
    const text=await response.text();let json=null;try{json=text?JSON.parse(text):null;}catch{}
    timings.requestMs=Date.now()-requestStarted;
    const gqlError=json?.errors?.map(e=>e.message).filter(Boolean).join('；');
    const retryHeader=response.headers?.get?.('retry-after');
    const retryAfterSeconds=retryHeader ? (/^\d+$/.test(retryHeader)?Number(retryHeader):Math.max(0,(Date.parse(retryHeader)-Date.now())/1000)) : null;
    const rateLimit={};
    for(const [key,header] of Object.entries({limit:'x-rate-limit-limit',remaining:'x-rate-limit-remaining',resetAt:'x-rate-limit-reset'})) {
      const value=response.headers?.get?.(header);
      if(value!==null && value!==undefined && /^\d+$/.test(value))rateLimit[key]=Number(value)*(key==='resetAt'?1000:1);
    }
    return {operation:request.operation,rateLimit,timings:{...timings,totalMs:Date.now()-started},status:response.status,json,error:redact(gqlError||(!response.ok?text||`HTTP ${response.status}`:(!json?'X 返回了无效数据':''))),attempted,retryAfterSeconds:Number.isFinite(retryAfterSeconds)?retryAfterSeconds:null};
  }catch(error){return {timings:{...timings,totalMs:Date.now()-started},status:0,json:null,error:redact(error?.message||error),attempted};}
  };
  const task = execute();
  if (key) pending.set(key,task);
  try {return structuredClone(await task);}
  finally {
    if (key && pending.get(key) === task) pending.delete(key);
    if (!readable) {pending.clear();window.__xefNativeProfile=null;}
  }

}

// Opt-in for a newly opened queue profile only; verification reads stay fresh.
export function readNativeProfileResponse(handle) {
  const cached = window.__xefNativeProfile;
  const key = String(handle || '').toLowerCase();
  const route=location.pathname.toLowerCase().split('/').filter(Boolean);
  const matches=route[0]===key && (route.length===1 || route.length===2 && ['followers','following','verified_followers','with_replies'].includes(route[1]));
  if (!cached || cached.handle !== key || !matches ||
      cached.path !== location.pathname || Date.now()-cached.at < 0 || Date.now()-cached.at > 30000 ||
      !cached.json || cached.json.errors?.length) return null;
  return {status:200,json:cached.json,error:'',attempted:false,source:'native-page',observedAt:cached.at};
}

export function createXNetworkClient(api=globalThis.chrome) {
  async function request(tabId,operation,variables={},options={}) {
    let template,dispatched=false;
    const handle=operation==='UserByScreenName'?variables.screen_name:null;
    if(handle)await assertProfileAvailable(api,handle,'profile-network');
    try {
      if (handle && options.preferPageResponse === true) {
        const cached = await api.scripting.executeScript({target:{tabId},world:'MAIN',func:readNativeProfileResponse,args:[handle]});
        if (cached?.[0]?.result?.status === 200) return cached[0].result;
      }
      const {networkTemplates={}}=await api.storage.local.get('networkTemplates');
      template=networkTemplates[operation];
      if(FORMS[operation]||operation==='DeleteTweet')template=networkTemplates.contentPageQuery||networkTemplates.UserByScreenName||Object.values(networkTemplates).find(t=>t?.headers?.authorization&&t?.headers?.['x-csrf-token']);
      if(!template)return {status:0,json:null,error:`未捕获 ${operation} 模板`,attempted:false};
      const prepared=buildXRequest(operation,template,variables);
      const [{result:loaded}={}]=await api.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>typeof window.__XEF_GENERATE_TRANSACTION_ID==='function'});
      if(!loaded)await api.scripting.executeScript({target:{tabId},world:'MAIN',files:['transaction-id.bundle.js']});
      dispatched=true;
      const results=await api.scripting.executeScript({target:{tabId},world:'MAIN',func:executeXRequestOnPage,args:[prepared]});
      const response=results?.[0]?.result||{status:0,json:null,error:'X 页面没有返回网络结果',attempted:true};
      if(handle){const state=unavailableFromProfileResponse(response);if(state){await observeProfile(api,handle,state,'profile-network');if(state.status!=='ok')throw profileUnavailableError({...state,handle});}}
      return response;
    }catch(error){if(error.code==='X_PROFILE_UNAVAILABLE')throw error;return {status:0,json:null,error:redactNetworkError(error?.message||error,template?.headers),attempted:dispatched};}
  }
  return {
    query:(tabId,operation,variables)=>X_QUERY_OPERATIONS.includes(operation)?request(tabId,operation,variables):Promise.resolve({status:0,json:null,error:'不支持的 X 查询操作',attempted:false}),
    profile:(tabId,handle,options)=>request(tabId,'UserByScreenName',{screen_name:String(handle).replace(/^@/,'')},options),
    userPosts:(tabId,userId,variables={})=>request(tabId,'UserTweets',{...variables,userId}),
    userOriginals:(tabId,userId,variables={})=>request(tabId,'UserOriginalsTimeline',{...variables,userId}),
    userReplies:(tabId,userId,variables={})=>request(tabId,'UserRepliesTimeline',{...variables,userId}),
    followers:(tabId,userId,variables={})=>request(tabId,'Followers',{...variables,userId}),
    following:(tabId,userId,variables={})=>request(tabId,'Following',{...variables,userId}),
    follow:(tabId,target)=>request(tabId,'Follow',typeof target==='object'?target:{id:target}),
    unfollow:(tabId,target)=>request(tabId,'Unfollow',typeof target==='object'?target:{id:target}),
    block:(tabId,target)=>request(tabId,'Block',typeof target==='object'?target:{id:target}),
    unblock:(tabId,target)=>request(tabId,'Unblock',typeof target==='object'?target:{id:target}),
    ownAnalytics:(tabId,variables)=>request(tabId,'contentPageQuery',variables),
    deleteOwnPost:(tabId,postId)=>request(tabId,'DeleteTweet',{tweet_id:postId})
  };
}
