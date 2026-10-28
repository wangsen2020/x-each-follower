import {inspectOrActOnProfile} from '../../platform/x/guarded-relationship.js';
import {createAutoUnfollow,inUnfollowWindow} from './auto-unfollow.js';
import {networkGetUserProfile,parseNetworkUsers} from './network-api.js';
import {readSidebarViewerOnPage} from '../../platform/x/sidebar-identity.js';
import {appendExecutionLog} from '../../shared/execution-log.js';
import {readProfileOnTab,observeProfile,profileUnavailableError,unavailableFromProfileResponse} from '../../platform/x/profile-access.js';

// An empty API payload is inconclusive. Confirm only X's scoped profile empty state.
export async function inspectMissingProfile(api,user,owner,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  // Deliberate read-only recheck: a cached not_found must not replace current DOM evidence.
  const tab=await api.tabs.create({url:'https://x.com/'+user.handle,active:false});
  try {
    for(let i=0;i<20;i++){
      const result=await readProfileOnTab(api,tab.id,user.handle,0,'auto-unfollow-missing');
      if(result && !result.pending){
        const viewer=(await api.scripting.executeScript({target:{tabId:tab.id},func:readSidebarViewerOnPage}))[0]?.result;
        if(viewer?.handle?.toLowerCase()!==owner.toLowerCase())throw Object.assign(new Error('登录账号不一致'),{code:'X_PROFILE_OWNER_MISMATCH'});
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

export function createBackgroundAutoUnfollow({api,service,records,normalize,fetchProfile=networkGetUserProfile,sendUnfollow,inspectProfile=inspectOrActOnProfile,checkMissingProfile=inspectMissingProfile,writeLog=appendExecutionLog,now=Date.now,sleep}) {
  async function ownerTab(config, preferred) {
    const tabs=preferred?[{id:preferred}] : await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    for(const tab of tabs){
      if(!tab.id||tab.discarded)continue;
      const result=await api.scripting.executeScript({target:{tabId:tab.id},func:readSidebarViewerOnPage}).catch(()=>[]);
      if(result[0]?.result?.handle?.toLowerCase()===config.autoUnfollowAccount.handle.toLowerCase())return tab.id;
    }
    throw new Error('请保留绑定账号的已登录 X 页面；账号不一致时不会取关');
  }
  const actionOptions = (user,config) => ({canAct:async()=>{
    const current=normalize((await api.storage.local.get('unreciprocatedSettings')).unreciprocatedSettings||{});
    if(!current.autoUnfollow || current.autoUnfollowAccount?.id!==config.autoUnfollowAccount.id || !inUnfollowWindow(current,now()))return false;
    if(String(current.whitelist||'').split(/[,，\s]+/).some(h=>h.replace(/^@/,'').toLowerCase()===user.handle.toLowerCase()))return false;
    const rows=await service.lookupAll({sourceKey:'unreciprocatedTracker',handle:user.handle});
    return !rows.some(row=>row.payload?.exempt);
  }});
  return createAutoUnfollow({
    storage:api.storage.local,alarms:api.alarms,normalize,now,sleep,
    async candidates(){
      return readAutoUnfollowCandidates({records,service});
    },
    async verifyAccount(config){
      const tabId=await ownerTab(config);
      const response=await fetchProfile(tabId,config.autoUnfollowAccount.handle);
      const owner=response.status===200 && parseNetworkUsers(response.json).find(item=>item.handle.toLowerCase()===config.autoUnfollowAccount.handle.toLowerCase());
      await ownerTab(config,tabId);
      if(!owner || String(owner.id)!==String(config.autoUnfollowAccount.id))throw new Error('当前登录账号与绑定账号身份不一致，已停止本轮');
    },
    async refreshCandidate(user){
      const rows=[...await service.lookupAll({sourceKey:'unreciprocatedTracker',handle:user.handle}),...await service.lookupAll({sourceKey:'derived:tracker',handle:user.handle})];
      return rows.find(row=>row.module==='unreciprocated')?.payload || null;
    },
    async profile(user,config){
      const tabId=await ownerTab(config);
      const response=await fetchProfile(tabId,user.handle,{refreshAvailability:true,returnUnavailable:true});
      await ownerTab(config,tabId);
      const unavailable=unavailableFromProfileResponse(response);
      if(response.status!==200 && !(response.status===404 && unavailable?.status==='not_found'))throw Object.assign(new Error(`账号核验失败（${response.status||'无响应'}），已停止本轮`),{status:response.status,code:'PROFILE_HTTP_ERROR'});
      const users=parseNetworkUsers(response.json);
      const target=users.find(item=>item.handle.toLowerCase()===user.handle.toLowerCase());
      if(!target?.id){
        const errors=response.json?.errors||[];
        if(errors.some(error=>error.code!==50))throw Object.assign(new Error('资料接口返回错误，无法确认账号状态'),{code:'PROFILE_HTTP_ERROR',status:response.status});
        const apiMissing=users.length===0 && (unavailable?.status==='not_found' || response.status===200 && response.json?.data && typeof response.json.data==='object');
        const page=apiMissing ? await checkMissingProfile(api,user,config.autoUnfollowAccount.handle,{sleep}) : null;
        await ownerTab(config,tabId);
        if(page?.status==='not_found'){
          await observeProfile(api,user.handle,page,'auto-unfollow-missing');
          throw Object.assign(profileUnavailableError({...page,handle:user.handle}),{confirmedMissing:true});
        }
        throw Object.assign(new Error('资料未返回目标账号，身份待核实'),{code:'AUTO_UNFOLLOW_TARGET_MISSING',expectedId:String(user.id||''),actualId:''});
      }
      if(user.id && String(user.id)!==String(target.id))throw Object.assign(new Error('目标账号 ID 与本地记录不一致，身份待核实'),{code:'AUTO_UNFOLLOW_TARGET_MISMATCH',expectedId:String(user.id),actualId:String(target.id)});
      return {...await inspectProfile(api,target,config.autoUnfollowAccount.handle,'read'),tabId};
    },
    async unfollow(user,config,checkpoint={}){await ownerTab(config,user.tabId);if(sendUnfollow){await checkpoint.beforeSubmit?.();return sendUnfollow(user.tabId,user.id);}return inspectProfile(api,user,config.autoUnfollowAccount.handle,'unfollow',{...actionOptions(user,config),...checkpoint});},
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
}
