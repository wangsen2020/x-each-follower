// Shared relationship-verification workflow. Persistence and business writes
// belong to each caller; ordering, stop boundaries and selection are shared.
export function pausesVerification(error){
  return error?.status===429||['X_ACCESS_DEFERRED','X_PROFILE_READ_LIMIT','FAN_INSPECTION_ACCOUNT','FAN_INSPECTION_NETWORK'].includes(error?.code)
    ||/登录|绑定账号|当前账号|HTTP\s*(?:401|403|429)|网络|Failed to fetch|fetch failed/i.test(String(error?.message||error));
}

export async function runVerificationItems({items,startIndex=0,accountId,readAccount,shouldStop,discard=()=>false,
  inspect,onSuccess,onFailure,onAdvance,onCurrent,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),random=Math.random,pauseOnError=pausesVerification}){
  let nextIndex=startIndex;
  for(;nextIndex<items.length;){
    if(shouldStop())return {nextIndex,stage:'paused',reason:'已停止后续核验'};
    if(await readAccount()!==accountId)return {nextIndex,stage:'paused',reason:'当前绑定账号已变化'};
    if(shouldStop())return {nextIndex,stage:'paused',reason:'已停止后续核验'};
    const item=items[nextIndex];await onCurrent?.(item,nextIndex);
    try{
      const result=await inspect(item);
      if(discard())return {nextIndex,stage:'cancelled',reason:''};
      if(!result?.ok)throw Object.assign(Error(result?.error||result?.reason||'关系核验失败'),{status:result?.status,code:result?.code});
      await onSuccess(result,item,nextIndex);
    }catch(error){
      if(discard())return {nextIndex,stage:'cancelled',reason:''};
      if(pauseOnError(error))return {nextIndex,stage:'paused',reason:String(error?.message||error)};
      await onFailure(error,item,nextIndex);
    }
    nextIndex++;await onAdvance?.(nextIndex);
    if(nextIndex<items.length&&!shouldStop())await wait(2000+Math.floor(random()*3001));
  }
  return {nextIndex,stage:'completed',reason:''};
}

export function verificationRowState({running,keys=[]},key,selected=false){
  return {disabled:!!running,checked:running?keys.includes(key):!!selected};
}
