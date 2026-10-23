import {readProfileBundle} from './page-reader.js';

export const PROFILE_ACCESS_PREFIX='xefProfileAccess:';
export const PROFILE_UNAVAILABLE_TTL=86400000;
const terminal=status=>['not_found','suspended'].includes(status);
const queues=new WeakMap();
export function profileHandle(url){
  try{const u=new URL(url);if(!['x.com','twitter.com'].includes(u.hostname))return '';const m=u.pathname.match(/^\/([a-zA-Z0-9_]{1,15})(?:\/(?:following|followers|verified_followers|with_replies))?\/?$/);return m&&!['home','explore','notifications','messages','i','search','settings','compose'].includes(m[1].toLowerCase())?m[1].toLowerCase():'';}catch{return '';}
}
export function profileUnavailableError(row){const error=new Error(row.reason||'账号不可用');error.code='X_PROFILE_UNAVAILABLE';error.availability=row.status;error.handle=row.handle;return error;}
async function read(api,handle){const key=PROFILE_ACCESS_PREFIX+handle;return (await api.storage?.local?.get(key))?.[key]||{};}
async function update(api,handle,patch,event){
  const storage=api.storage?.local;if(!storage?.set)return;
  const previous=queues.get(storage)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{const row=await read(api,handle);await storage.set({[PROFILE_ACCESS_PREFIX+handle]:{...row,...patch,handle,events:[...(row.events||[]),{at:Date.now(),...event}].slice(-12)}})});
  queues.set(storage,next);await next;
}
export async function assertProfileAvailable(api,handle,source){
  handle=String(handle||'').replace(/^@/,'').toLowerCase();if(!/^[a-z0-9_]{1,15}$/.test(handle))throw Error('账号名无效');
  const row=await read(api,handle);
  if(terminal(row.status)&&row.expiresAt>Date.now()){await update(api,handle,{}, {source,action:'blocked',status:row.status}).catch(()=>{});throw profileUnavailableError({...row,handle});}
}
export async function observeProfile(api,handle,result,source){
  handle=String(handle||'').replace(/^@/,'').toLowerCase();if(!terminal(result?.status)&&result?.status!=='ok')return result;
  // Availability caching and visit traces must not replace a real DOM/API result
  // with a storage error. A known terminal result still blocks the current action.
  await update(api,handle,{status:result.status,reason:result.reason||'',checkedAt:Date.now(),expiresAt:terminal(result.status)?Date.now()+PROFILE_UNAVAILABLE_TTL:0},{source,action:'observed',status:result.status}).catch(()=>{});return result;
}
export async function createProfileTab(api,options,source,context={}){
  const handle=profileHandle(options.url);if(handle)await assertProfileAvailable(api,handle,source);
  const tab=await api.tabs.create(options);if(handle)await update(api,handle,{}, {source,action:'open',tabId:tab.id,...(context.jobId?{jobId:context.jobId}:{}),...(context.runId?{runId:context.runId}:{})}).catch(()=>{});return tab;
}
export async function updateProfileTab(api,tabId,options,source){
  const handle=profileHandle(options.url);if(handle)await assertProfileAvailable(api,handle,source);
  const tab=await api.tabs.update(tabId,options);if(handle)await update(api,handle,{}, {source,action:'navigate',tabId}).catch(()=>{});return tab;
}
export async function readProfileOnTab(api,tabId,handle,limit,source){
  const results=await api.scripting.executeScript({target:{tabId},func:readProfileBundle,args:[handle,limit]});
  const result=results?.[0]?.result;if(result)await observeProfile(api,handle,result,source);return result;
}
export function unavailableFromProfileResponse(response){
  if(![200,404].includes(response?.status))return null;
  const user=response.json?.data?.user?.result;
  if(user?.__typename==='User')return {status:'ok'};
  const codes=(response.json?.errors||[]).map(e=>e.code);
  if(codes.includes(50))return {status:'not_found',reason:'此账号不存在'};
  if(codes.includes(63)||user?.__typename==='UserUnavailable'&&user.reason==='Suspended')return {status:'suspended',reason:'账号已停用'};
  return null;
}

export async function acquireProfileTab(api,handle,source,reuseTabId){
  await assertProfileAvailable(api,handle,source);
  const existing=reuseTabId!=null?await api.tabs.get(reuseTabId).catch(()=>null):null;
  const url='https://x.com/'+encodeURIComponent(handle);
  if(existing){if(profileHandle(existing.url)!==handle.toLowerCase())await updateProfileTab(api,existing.id,{url},source);return {tab:existing,owned:false};}
  return {tab:await createProfileTab(api,{url,active:false},source),owned:true};
}
