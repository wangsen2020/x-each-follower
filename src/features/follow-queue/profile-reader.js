import {parseNetworkUsers} from '../relationships/network-api.js';
import {isPageFailure} from '../../platform/page-failure.js';
import {unavailableFromProfileResponse} from '../../platform/x/profile-access.js';

export async function readQueueProfile({handle,readDom,readNetwork,guard,deadline,signal,
  now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),domTimeoutMs=15000}) {
  const assertTime = () => {
    if (signal?.aborted || now() >= deadline) throw Object.assign(new Error('本轮时间已用完，留待下轮继续'),{code:'QUEUE_BUDGET_EXHAUSTED'});
  };
  const end=Math.min(deadline,now()+domTimeoutMs);
  let profile,lastError;
  while(now()<end){
    assertTime();
    try {profile=await readDom();} catch(error){if(isPageFailure(error))throw error;lastError=error;}
    assertTime();
    if(profile&&!profile.pending)return {profile,lookup:null};
    await wait(Math.min(500,Math.max(1,end-now())));
  }
  assertTime();
  await guard();
  // One read-only fallback; reuse it for the authoritative identity check.
  const lookup=await readNetwork();
  assertTime();
  await guard();
  const unavailable=unavailableFromProfileResponse(lookup);
  if (unavailable && ['suspended','not_found'].includes(unavailable.status)) {
    return {profile:{...unavailable,pending:false,posts:[]},lookup};
  }
  const target=lookup?.status===200 && parseNetworkUsers(lookup.json)
    .find(user=>user.handle.toLowerCase()===handle.toLowerCase());
  if(target?.id && target.name && target.followersText!=='' && target.followingText!=='') {
    return {profile:{...profile,...target,pending:false,status:'ok',posts:profile?.posts || [],profileSource:'network-fallback'},lookup};
  }
  if(lookup?.status===429) throw profileReadLimitError(lookup);
  throw lastError || Object.assign(new Error('主页资料读取超时，资料接口也未返回完整目标资料'),{code:'X_PROFILE_READ_TIMEOUT'});
}

export function profileReadLimitError(response) {
  return Object.assign(new Error('用户资料接口限流，未发送关注请求'),{code:'X_PROFILE_READ_LIMIT',
    networkEvidence:{operation:'UserByScreenName',status:response.status,rateLimit:response.rateLimit || {},
      retryAfterSeconds:response.retryAfterSeconds ?? null,observedAt:Date.now()}});
}
