import {inspectOrActOnProfile} from '../../platform/x/guarded-relationship.js';
import {createAutoUnfollow,inUnfollowWindow} from './auto-unfollow.js';
import {networkGetUserProfile,parseNetworkUsers} from './network-api.js';
import {readAccountSnapshotOnPage} from '../../platform/x/account-state.js';
import {appendExecutionLog} from '../../shared/execution-log.js';
import {createProfileTab,readProfileOnTab,observeProfile,profileUnavailableError,unavailableFromProfileResponse} from '../../platform/x/profile-access.js';
import {blockedProfileError} from './auto-unfollow-review.js';

// An empty API payload is inconclusive. Confirm only X's scoped profile empty state.
export async function inspectMissingProfile(api,user,owner,{readAccount,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  // Deliberate read-only recheck: a cached not_found must not replace current DOM evidence.
  const tab=await createProfileTab(api,{url:'https://x.com/'+user.handle,active:false},'auto-unfollow-missing',{refreshAvailability:true});
  try {
    for(let i=0;i<20;i++){
      const result=await readProfileOnTab(api,tab.id,user.handle,0,'auto-unfollow-missing');
      if(result && !result.pending){
        const viewer=readAccount?await readAccount():(await api.scripting.executeScript({target:{tabId:tab.id},func:readAccountSnapshotOnPage}))[0]?.result;
        if(viewer?.handle && viewer.handle.toLowerCase()!==owner.toLowerCase())throw Object.assign(new Error('登录账号不一致'),{code:'X_PROFILE_OWNER_MISMATCH'});
        return result;
      }
      await sleep(500);
    }
    return null;
  } finally {await api.tabs.remove(tab.id).catch(()=>{});}
}

// Candidate discovery is a live keyset scan, not a revision-bound UI snapshot.
// Every selected target is still looked up and verified again before any action.
export async function readAutoUnfollowCandidates({records,service}) {
  await records.ready();
  await service.summary({module:'unreciprocated'}); // Flush pending legacy changes once.
  const users=new Map();
  for(const sourceKey of ['derived:tracker','unreciprocatedTracker']){
    let cursor=null;
    do{
      const page=await service.sourcePage({sourceKey,limit:100,cursor});
      for(const row of page.records){
        // Preserve the old query's account scope; never mix another owner's rows.
        if(row.accountId!=='unassigned'||row.module!=='unreciprocated')continue;
        const handle=String(row.payload?.handle||'').replace(/^@/,'').toLowerCase();
        if(handle)users.set(handle,{...row.payload});
      }
      cursor=page.nextCursor;
    }while(cursor);
  }
  return [...users.values()];
}

export function createBackgroundAutoUnfollow({api,service,records,normalize,fetchProfile=networkGetUserProfile,sendUnfollow,inspectProfile=inspectOrActOnProfile,checkMissingProfile=inspectMissingProfile,writeLog=appendExecutionLog,now=Date.now,sleep,readAccount}) {
  async function requestTab(preferred) {
    // X tabs share the current browser session. Page chrome is not a login probe:
    // sidebar loading must not pause a round before any target is inspected.
    const tabs=await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    const available=tabs.filter(tab=>tab.id&&!tab.discarded);
    const tab=available.find(tab=>tab.id===preferred) || available.find(tab=>tab.status==='complete'&&tab.active) || available.find(tab=>tab.status==='complete') || available[0];
    if(!tab)throw Object.assign(new Error('没有可用的 X 页面，请打开 X 后等待下次计划'),{code:'X_REQUEST_TAB_UNAVAILABLE'});
    return tab.id;
  }
  const actionOptions = (user,config) => ({canAct:async()=>{
    if(readAccount&&String((await readAccount())?.id)!==String(config.autoUnfollowAccount.id))return false;
    const current=normalize((await api.storage.local.get('unreciprocatedSettings')).unreciprocatedSettings||{});
    if(!current.autoUnfollow || current.autoUnfollowAccount?.id!==config.autoUnfollowAccount.id || !inUnfollowWindow(current,now()))return false;
    if(String(current.whitelist||'').split(/[,，\s]+/).some(h=>h.replace(/^@/,'').toLowerCase()===user.handle.toLowerCase()))return false;
    const rows=await service.lookupAll({sourceKey:'unreciprocatedTracker',handle:user.handle});
    return !rows.some(row=>row.payload?.exempt);
  }});
  const runtime = createAutoUnfollow({
    storage:api.storage.local,alarms:api.alarms,normalize,now,sleep,
    async candidates(){
      return readAutoUnfollowCandidates({records,service});
    },
    async refreshCandidate(user){
      const rows=[...await service.lookupAll({sourceKey:'unreciprocatedTracker',handle:user.handle}),...await service.lookupAll({sourceKey:'derived:tracker',handle:user.handle})];
      return rows.find(row=>row.module==='unreciprocated')?.payload || null;
    },
    async profile(user,config){
      const tabId=await requestTab();
      const response=await fetchProfile(tabId,user.handle,{refreshAvailability:true,returnUnavailable:true});
      if(response.status!==200 && response.status!==404 && /^\d+$/.test(String(user.id||'')))return {...await inspectProfile(api,user,config.autoUnfollowAccount.handle,'read'),tabId};
      const unavailable=unavailableFromProfileResponse(response);
      if(unavailable?.status==='suspended')throw profileUnavailableError({...unavailable,handle:user.handle});
      if(response.status!==200 && !(response.status===404 && unavailable?.status==='not_found'))throw Object.assign(new Error(`账号核验失败（${response.status||'无响应'}），已停止本轮`),{status:response.status,code:'PROFILE_HTTP_ERROR'});
      const users=parseNetworkUsers(response.json);
      const target=users.find(item=>item.handle.toLowerCase()===user.handle.toLowerCase());
      if(!target?.id){
        const errors=response.json?.errors||[];
        if(errors.some(error=>error.code!==50))throw Object.assign(new Error('资料接口返回错误，无法确认账号状态'),{code:'PROFILE_HTTP_ERROR',status:response.status});
        const apiMissing=users.length===0 && (unavailable?.status==='not_found' || response.status===200 && response.json?.data && typeof response.json.data==='object');
        const page=apiMissing ? await checkMissingProfile(api,user,config.autoUnfollowAccount.handle,{sleep,readAccount}) : null;
          if(page?.status==='not_found'){
          await observeProfile(api,user.handle,page,'auto-unfollow-missing');
          throw Object.assign(profileUnavailableError({...page,handle:user.handle}),{confirmedMissing:true});
        }
        throw Object.assign(new Error('资料未返回目标账号，账号资料待核实'),{code:'AUTO_UNFOLLOW_TARGET_MISSING',expectedId:String(user.id||''),actualId:''});
      }
      if(user.id && String(user.id)!==String(target.id))throw Object.assign(new Error('目标账号 ID 与本地记录不一致，账号资料待核实'),{code:'AUTO_UNFOLLOW_TARGET_MISMATCH',expectedId:String(user.id),actualId:String(target.id)});
      if(target.relationship?.blocking===true){
        const viewer=readAccount?await readAccount():(await api.scripting.executeScript({target:{tabId},func:readAccountSnapshotOnPage}))[0]?.result;
        if(viewer?.handle?.toLowerCase()===config.autoUnfollowAccount.handle.toLowerCase())throw blockedProfileError(target);
      }
      return {...await inspectProfile(api,target,config.autoUnfollowAccount.handle,'read'),tabId};
    },
    async removeLocal(user,ownerId){
      // Reuse the record service's serialized, backed-up source deletion. An
      // incomplete deletion leaves the review item available for another try.
      const response=await service.handle({op:'deleteLocalAccount',handle:user.handle,ownerId:String(ownerId),expectedId:user.id},api.runtime.getURL('background.js'));
      if(!response?.ok)throw new Error(response?.error||'本地删除未完成');
      return response.result;
    },
    async unfollow(user,config,checkpoint={}){if(sendUnfollow){await checkpoint.beforeSubmit?.();return sendUnfollow(user.tabId,user.id);}return inspectProfile(api,user,config.autoUnfollowAccount.handle,'unfollow',{...actionOptions(user,config),...checkpoint});},
    async followback(user,config){return inspectProfile(api,user,config.autoUnfollowAccount.handle,'followback',actionOptions(user,config));},
    async removeMissing(user){
      const response=await service.handle({op:'deleteUnavailableAccount',handle:user.handle,automatic:true},api.runtime.getURL('background.js'));
      if(!response?.ok || response.result?.skipped)throw new Error(response?.error||'账号状态已变化，未清理本地记录');
      return response.result;
    },
    async reconcile(user,live){
      if(live.relationship.following===false){
        // Save an independent tracker row before removing its active-following sources.
        await records.batch({sourceKey:'unreciprocatedTracker',changes:[{handle:user.handle,sourceBucket:'users',create:true,patch:{...user,relationship:{...user.relationship,...live.relationship},status:live.relationship.followedBy===true?'unknown':'unfollowed',unfollowedAt:new Date().toISOString()}}]});
      }
      for(const sourceKey of ['monitor','mutualNetwork','commentTracking','unreciprocatedTracker','derived:tracker']){
        const rows=await service.lookupAll({sourceKey,handle:user.handle});
        for(const row of rows){
          const patch={relationship:{...(row.payload?.relationship||{}),...live.relationship}};
          if(live.relationship.following===false)Object.assign(patch,{status:'unfollowed',state:'unfollowed',autoFollowState:'unfollowed',unfollowedAt:new Date().toISOString()});
          else if(row.module==='unreciprocated' && live.relationship.followedBy===true)patch.status='mutual';
          await records.patch({module:row.module,userKey:row.userKey,expectedHandle:user.handle,operationId:crypto.randomUUID(),patch});
        }
      }
    },
    log:entry=>writeLog({...entry,at:new Date().toISOString(),origin:'autoUnfollow'})
  });
  return {...runtime,
    async run(request) { await records.ready(); return runtime.run(request); },
    async review(request) { await records.ready(); return runtime.review(request); }
  };
}
