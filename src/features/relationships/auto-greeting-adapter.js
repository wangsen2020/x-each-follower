import {createAutoGreeting} from './auto-greeting.js';
import {sendGreetingViaChat} from './greeting-chat.js';
import {networkGetUserProfile,parseNetworkUsers} from './network-api.js';
import {readSidebarViewerOnPage} from '../../platform/x/sidebar-identity.js';
import {detectAccountLanguage} from './scoring.js';
import {appendExecutionLog} from '../../shared/execution-log.js';
export function createBackgroundAutoGreeting({api,service,records,ledger}){
 async function tabFor(account){
  for(const tab of await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']})){
   if(tab.discarded)continue;
   const result=await api.scripting.executeScript({target:{tabId:tab.id},func:readSidebarViewerOnPage}).catch(()=>[]);
   if(result[0]?.result?.handle?.toLowerCase()===account.handle.toLowerCase())return tab.id;
  }
  throw new Error('请保留绑定账号的已登录 X 页面');
 }
 async function lookup(tabId,handle){
  const response=await networkGetUserProfile(tabId,handle);
  if(response.status!==200)throw Object.assign(new Error(`账号核验失败（${response.status||'无响应'}）`),{status:response.status,code:'PROFILE_HTTP_ERROR'});
  const user=parseNetworkUsers(response.json).find(u=>u.handle.toLowerCase()===handle.toLowerCase());
  if(!user?.id)throw new Error('无法核验账号身份');return user;
 }
 return createAutoGreeting({storage:api.storage.local,alarms:api.alarms,ledger,
  async candidates(){
   await records.ready();let cursor=null;const users=[];
   do{const page=await service.query({module:'unreciprocated',limit:100,cursor});users.push(...page.records.map(r=>r.payload));cursor=page.nextCursor;}while(cursor);
   return users.sort((a,b)=>Date.parse(a.followedAt)-Date.parse(b.followedAt));
  },
  async refresh(user){
   const rows=[...await service.lookupAll({sourceKey:'unreciprocatedTracker',handle:user.handle}),...await service.lookupAll({sourceKey:'derived:tracker',handle:user.handle})];
   return rows.find(r=>r.module==='unreciprocated')?.payload||null;
  },
  async owner(account){const tab=await tabFor(account),live=await lookup(tab,account.handle);await tabFor(account);if(live.id!==account.id)throw new Error('绑定账号身份不匹配');return account;},
  async profile(user,account){const tab=await tabFor(account),live=await lookup(tab,user.handle);await tabFor(account);if(user.id && String(user.id)!==live.id)throw new Error('收件人身份已变化');return live;},
  send:(user,target,account,cfg,beforeSubmit)=>sendGreetingViaChat({ownerHandle:account.handle,ownerId:account.id,targetHandle:target.handle,targetId:target.id,text:detectAccountLanguage(user)==='zh'?cfg.greetingText:cfg.greetingTextEn,beforeSubmit,api,focused:false}),
  log:entry=>appendExecutionLog({...entry,scope:'unreciprocated',origin:'autoGreeting',at:new Date().toISOString()})
 });
}
