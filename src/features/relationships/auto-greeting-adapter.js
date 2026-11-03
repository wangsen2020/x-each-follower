import {createAutoGreeting} from './auto-greeting.js';
import {sendGreetingViaChat} from './greeting-chat.js';
import {networkGetUserProfile,parseNetworkUsers} from './network-api.js';
import {readAccountSnapshotOnPage} from '../../platform/x/account-state.js';
import {detectAccountLanguage} from './scoring.js';
import {appendExecutionLog} from '../../shared/execution-log.js';
export function createBackgroundAutoGreeting({api,service,records,ledger,readAccount}){
 async function tabFor(account){
  if(readAccount){const current=await readAccount();if(String(current?.id)!==String(account.id))throw Error('账号模块尚未确认私信账号');const tabs=await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']});const tab=tabs.find(t=>!t.discarded);if(!tab)throw Error('请打开 X 页面');return tab.id;}
  for(const tab of await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']})){
   if(tab.discarded)continue;
   const result=await api.scripting.executeScript({target:{tabId:tab.id},func:readAccountSnapshotOnPage}).catch(()=>[]);
   if(result[0]?.result?.handle?.toLowerCase()===account.handle.toLowerCase())return tab.id;
  }
  throw new Error('请保留绑定账号的已登录 X 页面');
 }
 async function lookup(tabId,handle){
  const response=await networkGetUserProfile(tabId,handle);
  if(response.status!==200)throw Object.assign(new Error(`账号核验失败（${response.status||'无响应'}）`),{status:response.status,code:'PROFILE_HTTP_ERROR'});
  const user=parseNetworkUsers(response.json).find(u=>u.handle.toLowerCase()===handle.toLowerCase());
  if(!user?.id)throw new Error('无法核验账号信息');return user;
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
  async owner(account){await tabFor(account);if(readAccount)return account;const tab=await tabFor(account),live=await lookup(tab,account.handle);if(live.id!==account.id)throw new Error('绑定账号不匹配');return account;},
  async profile(user,account){const tab=await tabFor(account),live=await lookup(tab,user.handle);await tabFor(account);if(user.id && String(user.id)!==live.id)throw new Error('收件人账号已变化');return live;},
  send:(user,target,account,cfg,beforeSubmit)=>sendGreetingViaChat({ownerHandle:account.handle,ownerId:account.id,targetHandle:target.handle,targetId:target.id,text:detectAccountLanguage(user)==='zh'?cfg.greetingText:cfg.greetingTextEn,beforeSubmit,api,focused:false}),
  log:entry=>appendExecutionLog({...entry,scope:'unreciprocated',origin:'autoGreeting',at:new Date().toISOString()})
 });
}
