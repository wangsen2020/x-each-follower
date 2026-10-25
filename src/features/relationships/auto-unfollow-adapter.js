import {createAutoUnfollow} from './auto-unfollow.js';
import {networkGetUserProfile,networkUnfollow,parseNetworkUsers} from './network-api.js';
import {readSidebarViewerOnPage} from '../../platform/x/sidebar-identity.js';
import {appendExecutionLog} from '../../shared/execution-log.js';

export function createBackgroundAutoUnfollow({api,service,records,normalize,fetchProfile=networkGetUserProfile,sendUnfollow=networkUnfollow,writeLog=appendExecutionLog,now=Date.now,sleep}) {
  async function ownerTab(config, preferred) {
    const tabs=preferred?[{id:preferred}] : await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
    for(const tab of tabs){
      if(!tab.id||tab.discarded)continue;
      const result=await api.scripting.executeScript({target:{tabId:tab.id},func:readSidebarViewerOnPage}).catch(()=>[]);
      if(result[0]?.result?.handle?.toLowerCase()===config.autoUnfollowAccount.handle.toLowerCase())return tab.id;
    }
    throw new Error('请保留绑定账号的已登录 X 页面；账号不一致时不会取关');
  }
  return createAutoUnfollow({
    storage:api.storage.local,alarms:api.alarms,normalize,now,sleep,
    async candidates(){
      await records.ready();const users=[];let cursor=null;
      do{const page=await service.query({module:'unreciprocated',limit:100,cursor,filter:{tab:'all'}});users.push(...page.records.map(row=>({...row.payload})));cursor=page.nextCursor;}while(cursor);
      return users;
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
      if(!target?.id || (user.id && String(user.id)!==String(target.id)))throw new Error('目标账号身份无法确认，已停止本轮');
      return {...target,tabId};
    },
    async unfollow(user,config){await ownerTab(config,user.tabId);return sendUnfollow(user.tabId,user.id);},
    async reconcile(user,live){
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
