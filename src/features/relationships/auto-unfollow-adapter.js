import {inspectOrActOnProfile} from '../../platform/x/guarded-relationship.js';
import {createAutoUnfollow,inUnfollowWindow} from './auto-unfollow.js';
import {networkGetUserProfile,parseNetworkUsers} from './network-api.js';
import {readSidebarViewerOnPage} from '../../platform/x/sidebar-identity.js';
import {appendExecutionLog} from '../../shared/execution-log.js';

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

export function createBackgroundAutoUnfollow({api,service,records,normalize,fetchProfile=networkGetUserProfile,sendUnfollow,inspectProfile=inspectOrActOnProfile,writeLog=appendExecutionLog,now=Date.now,sleep}) {
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
      const response=await fetchProfile(tabId,user.handle);
      await ownerTab(config,tabId);
      if(response.status!==200)throw Object.assign(new Error(`账号核验失败（${response.status||'无响应'}），已停止本轮`),{status:response.status,code:'PROFILE_HTTP_ERROR'});
      const target=parseNetworkUsers(response.json).find(item=>item.handle.toLowerCase()===user.handle.toLowerCase());
      if(!target?.id)throw Object.assign(new Error('资料未返回目标账号，身份待核实'),{code:'AUTO_UNFOLLOW_TARGET_MISSING',expectedId:String(user.id||''),actualId:''});
      if(user.id && String(user.id)!==String(target.id))throw Object.assign(new Error('目标账号 ID 与本地记录不一致，身份待核实'),{code:'AUTO_UNFOLLOW_TARGET_MISMATCH',expectedId:String(user.id),actualId:String(target.id)});
      return {...await inspectProfile(api,target,config.autoUnfollowAccount.handle,'read'),tabId};
    },
    async unfollow(user,config){await ownerTab(config,user.tabId);return sendUnfollow ? sendUnfollow(user.tabId,user.id) : inspectProfile(api,user,config.autoUnfollowAccount.handle,'unfollow',actionOptions(user,config));},
    async followback(user,config){return inspectProfile(api,user,config.autoUnfollowAccount.handle,'followback',actionOptions(user,config));},
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
