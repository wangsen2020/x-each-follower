export const ACCOUNT_STATE_KEY='xAccountState:v1';
export const ACCOUNT_STATE_ALARM='x-account-state';
export function readAccountSnapshotOnPage(){return globalThis.__xfAccountSnapshot?.account||null;}
// Only this module refreshes the signed-in account. Consumers read the last
// confirmed snapshot; an incomplete page never invalidates a known account.
export function createAccountState({api,probe,now=Date.now}){
 let state=null,pending=null,loading=null,started=false;
 async function load(){if(!loading)loading=api.storage.local.get(ACCOUNT_STATE_KEY).then(data=>{state=data[ACCOUNT_STATE_KEY]||{account:null,status:'checking'};});await loading;return state;}
 async function publish(tabId){
  await load();const snapshot={account:state.account,status:state.status,checkedAt:state.checkedAt||0};
  const tabs=tabId?[{id:tabId}]:(await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']})).filter(tab=>!tab.discarded);
  await Promise.all(tabs.flatMap(tab=>['ISOLATED','MAIN'].map(world=>api.scripting.executeScript({target:{tabId:tab.id},world,
   func:value=>{globalThis.__xfAccountSnapshot=value;},args:[snapshot]}).catch(()=>{}))));
 }
 async function run(){
  await load();let result;
  try{result=await probe.read()||{};}catch(error){result={error:error.message};}
  if(result.loggedOut)state={account:null,status:'logged-out',checkedAt:now()};
  else if(result.account?.handle){
   const next={...result.account},binding=(await api.storage.local.get('followQueueBinding')).followQueueBinding;
   const same=state.account?.handle?.toLowerCase()===next.handle.toLowerCase();
   if(!next.id&&same)next.id=state.account.id;
   if(!next.id&&binding?.activated&&binding.handle?.toLowerCase()===next.handle.toLowerCase())next.id=binding.accountId;
   state={account:next,status:'ready',checkedAt:now()};
  }else state={...state,status:state.account?'retrying':'checking',lastAttemptAt:now(),error:result.error||'账号信息等待刷新'};
  await api.storage.local.set({[ACCOUNT_STATE_KEY]:state});await publish();return {ok:true,...state};
 }
 const refresh=()=>{if(!pending)pending=run().finally(()=>{pending=null;});return pending;};
 return {refresh,publish,async read(){await load();return {ok:true,...state};},async start(){
  if(started)return pending||this.read();started=true;
  // Register synchronously so an alarm waking the MV3 worker cannot be lost.
  api.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ACCOUNT_STATE_ALARM)void refresh().catch(console.warn);});
  api.tabs.onUpdated?.addListener((id,change,tab)=>{if(change.status==='complete'&&/^https:\/\/(?:x|twitter)\.com\//.test(tab?.url||''))void publish(id).catch(console.warn);});
  await load();if(!await api.alarms.get?.(ACCOUNT_STATE_ALARM))await api.alarms.create(ACCOUNT_STATE_ALARM,{periodInMinutes:1});
  return refresh();
 }};
}
