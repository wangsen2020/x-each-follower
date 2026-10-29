export const HEALTH_KEY='automationHealth';
export const HEALTH_NOTICE_KEY='automationHealthNotices';
export const HEALTH_ALARM='x-automation-health-check';
export const HEALTH_REMINDER_MS=30*60000;
let writes=Promise.resolve();

export function mutateAutomationHealth(storage,work){
  const task=async()=>{const state=(await storage.get(HEALTH_KEY))[HEALTH_KEY]||{alerts:{}};const next=work(structuredClone(state));if(JSON.stringify(next)!==JSON.stringify(state))await storage.set({[HEALTH_KEY]:next});return next;};
  const next=writes.then(()=>globalThis.navigator?.locks?.request ? navigator.locks.request('xf-automation-health',{mode:'exclusive'},task):task());
  writes=next.catch(()=>{});return next;
}
const mutate=mutateAutomationHealth;
// Retire the old API-status pause without changing task switches or histories.
export async function retireApiStatusPause(api){
  const saved=(await api.storage.local.get(HEALTH_KEY))[HEALTH_KEY]?.alerts?.['x-rate-limit'];
  for(const [i,name] of (saved?.deferredAlarms||[]).entries()){
    if(!await api.alarms.get(name))await api.alarms.create(name,{delayInMinutes:1+i*0.5});
  }
  const d=await api.storage.local.get('autoUnfollowState'),ledger=d.autoUnfollowState;
  let changed=false;
  for(const account of Object.values(ledger?.accounts||{})){
    if(/X 请求受限.*自动调度已暂停/.test(account.scheduler?.reason||'')){
      account.scheduler={...account.scheduler,phase:'waiting',reason:'等待下次执行',resume:'下次计划重新核验主页状态'};changed=true;
    }
  }
  if(changed)await api.storage.local.set({autoUnfollowState:ledger});
  await mutate(api.storage.local,state=>{
    if(state.alerts){delete state.alerts['x-rate-limit'];if(/X 请求受限.*自动调度已暂停/.test(state.alerts.unfollow?.reason||''))delete state.alerts.unfollow;}
    return state;
  });
  await api.notifications.clear('xf-health-x-rate-limit');
}
export function reportBackupHealth(status,storage=globalThis.chrome?.storage?.local,now=Date.now()){
  if(!storage)return Promise.resolve();
  return mutate(storage,state=>{
    state.alerts ||= {};
    const previous=state.alerts.logs;
    if(status.ok===false){
      state.alerts.logs={id:'logs',title:status.localFailure?'执行日志不可用':'执行日志备份异常',reason:status.error||'备份未完成',impact:status.localFailure?'尚未确认本地日志保存，相关自动任务可能停止。':'依赖日志的自动任务可能受影响；本地记录和待备份内容已保留。',action:'查看详情并重试备份；重试不会重新关注或取关。',since:previous?.since||now,updatedAt:now,pending:status.pending||0};
    }else if(previous && status.pending>0){state.alerts.logs={...previous,pending:status.pending,updatedAt:now};}
    else if(previous && status.ok===true && status.pending===0){delete state.alerts.logs;state.lastRecovery={id:'logs',title:'执行日志备份已恢复',at:now};}
    return state;
  });
}
export function reportUnfollowHealth(config,ledger,storage=globalThis.chrome?.storage?.local,now=Date.now()){
  if(!storage)return Promise.resolve();
  const scheduler=ledger?.accounts?.[String(config?.autoUnfollowAccount?.id||'')]?.scheduler;
  return mutate(storage,state=>{
    state.alerts ||= {};
    const previous=state.alerts.unfollow;
    if(config?.autoUnfollow && scheduler?.phase==='paused' && scheduler.reason!=='今日额度已用完'){
      state.alerts.unfollow={id:'unfollow',title:'自动取关已暂停',reason:scheduler.reason||'执行异常',impact:'本轮未继续处理后续账号。',action:scheduler.resume||'查看执行日志并核对账号状态。',since:previous?.since||now,updatedAt:now};
    }else if(previous && (!config?.autoUnfollow || scheduler?.phase==='waiting' || scheduler?.reason==='今日额度已用完')){
      delete state.alerts.unfollow;state.lastRecovery={id:'unfollow',title:config?.autoUnfollow?'自动取关异常已解除':'自动取关已关闭',at:now};
    }
    return state;
  });
}

export function createAutomationHealthRuntime({api,now=Date.now}){
  let queue=Promise.resolve();
  const sync=()=>{
    const run=queue.then(async()=>{
      const data=await api.storage.local.get([HEALTH_KEY,HEALTH_NOTICE_KEY]);
      const alerts=Object.values(data[HEALTH_KEY]?.alerts||{}),notices=data[HEALTH_NOTICE_KEY]||{};
      const allowed=await api.notifications.getPermissionLevel().catch(()=>'unknown');
      let changed=false;
      for(const alert of alerts){
        const previous=notices[alert.id],signature=`${alert.since}:${alert.reason}`;
        if(previous?.signature===signature && now()-previous.at<HEALTH_REMINDER_MS)continue;
        try{
          if(allowed==='denied')throw Error('桌面通知权限已关闭；面板异常提示仍会保留');
          const id=`xf-health-${alert.id}`;
          // Recreate one stable notification at the reminder boundary, never on every failure.
          await api.notifications.clear(id);
          await api.notifications.create(id,{type:'basic',iconUrl:api.runtime.getURL('icon128.png'),title:`XFollower · ${alert.title}`,message:`${alert.reason}\n异常未解除，点击查看处理入口。`,requireInteraction:true,priority:2});
          notices[alert.id]={signature,at:now(),error:''};
        }catch(error){notices[alert.id]={signature,at:now(),error:error.message};}
        changed=true;
      }
      for(const id of Object.keys(notices))if(!alerts.some(alert=>alert.id===id)){await api.notifications.clear(`xf-health-${id}`);delete notices[id];changed=true;}
      if(changed)await api.storage.local.set({[HEALTH_NOTICE_KEY]:notices});
      if(alerts.length)await api.alarms.create(HEALTH_ALARM,{periodInMinutes:5});
      else await api.alarms.clear(HEALTH_ALARM);
    });queue=run.catch(()=>{});return run;
  };
  async function checkUnfollow(){const d=await api.storage.local.get(['autoUnfollowState','unreciprocatedSettings']);await reportUnfollowHealth(d.unreciprocatedSettings,d.autoUnfollowState,api.storage.local,now());}
  return {sync,async start(){
    await retireApiStatusPause(api);
    api.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;if(changes[HEALTH_KEY])void sync();if(changes.autoUnfollowState||changes.unreciprocatedSettings)void checkUnfollow().catch(()=>{});});
    api.alarms.onAlarm.addListener(alarm=>{if(alarm.name===HEALTH_ALARM)void sync();});
    await checkUnfollow();await sync();
  }};
}
