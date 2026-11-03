import {fanScheduleLogEntry,createFanLogSink} from './fan-workflow-logs.js';
import {normalizeFanAutomation} from './fan-automation-settings.js';
export const FAN_AUTOMATION_ALARM='x-fan-automation';
export const FAN_AUTOMATION_PREFIX='fanAutomation:';
const verificationKey=item=>item.targetUserId||'handle:'+String(item.handle||'').toLowerCase();
// Chrome alarms wake the worker; persistent business checkpoints survive worker disposal.
// Existing review/verification executors own identity checks, idempotency and X budgets.
export function createFanAutomation({storage,alarms,binding,settings,list,reviewBatch,verify,manualVerificationBusy=async()=>false,sync=async()=>{},onLog=async()=>{},now=Date.now}={}) {
  let running;
  const log=createFanLogSink(onLog);
  const read=async id=>(await storage.get(FAN_AUTOMATION_PREFIX+id))[FAN_AUTOMATION_PREFIX+id]||{};
  const save=(id,state)=>storage.set({[FAN_AUTOMATION_PREFIX+id]:state});
  async function current(id,kind){const owner=await binding();if(!owner?.activated||owner.accountId!==id)return null;const config=normalizeFanAutomation((await settings(id)).automation)[kind];return config.enabled?config:null;}
  async function schedule(){const alarm=await alarms.get(FAN_AUTOMATION_ALARM);if(alarm?.periodInMinutes!==1)await alarms.create(FAN_AUTOMATION_ALARM,{periodInMinutes:1});}
  async function drain({force=false,only}={}) {
    const owner=await binding();if(!owner?.activated||!owner.accountId)return;
    const id=owner.accountId,state=await read(id);
    let reviewReady=false;
    for(const kind of ['review','verify'].filter(kind=>!only||only===kind)){
      const config=await current(id,kind);let previous=state[kind]||{};
      if(!config){state[kind]={...previous,stage:'disabled',updatedAt:now()};await save(id,state);await log(fanScheduleLogEntry(id,kind,previous,state[kind]));continue;}
      if(kind==='review'&&['running','waiting'].includes(previous.stage)&&previous.batchId){
        const completed=await reviewBatch.status(id);
        if(completed?.id===previous.batchId&&completed.stage==='completed'){
          const old=previous;
          previous={...previous,stage:'completed',failures:0,error:'',processed:completed.completed||0,total:completed.total||0,
            nextAt:Math.min(previous.nextAt||Infinity,(previous.lastAt||now())+config.intervalMinutes*60000),updatedAt:now()};
          state[kind]=previous;await save(id,state);await log(fanScheduleLogEntry(id,kind,old,previous));
        }else if(completed?.id===previous.batchId&&['paused','failed'].includes(completed.stage)){
          const old=previous;
          previous={...previous,stage:completed.userPaused||!completed.automatic?'manual':'waiting',error:completed.error||'',
            processed:completed.completed||0,total:completed.total||0,updatedAt:now()};
          state[kind]=previous;await save(id,state);await log(fanScheduleLogEntry(id,kind,old,previous));
        }
      }
      if(!force&&previous.nextAt>now())continue;
      let progress={...previous,stage:'checking',lastAt:now(),nextAt:now()+config.intervalMinutes*60000,error:'',processed:0,total:0,batchId:''};
      state[kind]=progress;await save(id,state);
      try{
        if(kind==='review'){
          const batch=await reviewBatch.status(id);
          if(batch&&batch.stage!=='completed'&&(batch.stage!=='failed'||batch.pendingRecovery)){
            if(batch.stage==='running'){progress.stage='running';progress.batchId=batch.id;progress.total=batch.total||0;continue;}
            if(!batch.automatic||batch.userPaused){progress.stage='manual';continue;}
            if(!await current(id,kind))continue;
            const resumed=await reviewBatch.resume(id)||await reviewBatch.status(id);
            progress.stage=resumed?.stage==='completed'?'completed':['paused','failed'].includes(resumed?.stage)?'waiting':'running';
            progress.batchId=batch.id;progress.total=resumed?.total||batch.total||0;progress.processed=resumed?.completed||0;
            progress.error=progress.stage==='waiting'?resumed?.error||batch.error||'':'';
            progress.failures=0;continue;
          }
          const items=(await list(id,kind)).filter(item=>!item.removalPending&&!(item.retryAt>now())).slice(0,config.limit);
          if(!items.length){progress.stage='idle';continue;}
          const configured=await settings(id);
          if(!configured.fanTagging?.provider||!configured.fanTagging?.botId){progress.stage='configuration';continue;}
          if(!await current(id,kind))continue;
          const started=await reviewBatch.start(id,{action:'analyze',automatic:true,handles:items.map(item=>item.handle),targets:items.map(item=>({handle:item.handle,targetUserId:item.targetUserId}))});
          progress.stage='running';progress.batchId=started.id;progress.total=items.length;
        }else{
          if(await manualVerificationBusy(id)){progress.stage='manual';continue;}
          const attempts={...(previous.attempts||{})};
          const items=(await list(id,kind)).filter(item=>!(item.retryAt>now())&&!(attempts[verificationKey(item)]>now())).slice(0,config.limit);
          progress.attempts=attempts;progress.total=items.length;progress.stage=items.length?'running':'idle';
          for(const item of items){
            const attemptKey=verificationKey(item);
            if(!await current(id,kind))break;
            // A crash can cost a cooldown, never cause a rapid replay of the same profile.
            attempts[attemptKey]=now()+config.retryMinutes*60000;progress.currentHandle=item.handle;await save(id,state);
            try{
              await log({scope:'fanVerify',source:'scheduled',accountId:id,handle:item.handle,targetUserId:item.targetUserId,result:'running'});
              const result=await verify(id,item);
              if(result?.waiting)attempts[attemptKey]=now()+config.intervalMinutes*60000;
              if(result?.retryAt)attempts[attemptKey]=result.retryAt;
              if(result?.removed||result?.skipped)delete attempts[attemptKey];
              if(result?.ready){state.review={...(state.review||{}),nextAt:0};reviewReady=true;await sync();}
              await log({scope:'fanVerify',source:'scheduled',accountId:id,handle:item.handle,targetUserId:item.targetUserId,result:result?.removed?'removed':result?.ready?'ready':result?.skipped?'skipped':'waiting',detail:result?.reason||'',nextAt:result?.removed||result?.ready||result?.skipped?0:attempts[attemptKey]||0});
              progress.processed++;
            }catch(error){
              progress.error=String(error.message||error);
              await log({scope:'fanVerify',source:'scheduled',accountId:id,handle:item.handle,result:'error',detail:progress.error,nextAt:error.retryAt||attempts[attemptKey]||0});
              if(error.retryAt){progress.nextAt=Math.max(progress.nextAt,error.retryAt);attempts[attemptKey]=error.retryAt;break;}
            }
          }
          progress.attempts=Object.fromEntries(Object.entries(attempts).filter(([,at])=>at>now()));
          progress.currentHandle='';progress.stage=progress.error?'waiting':'idle';
        }
        progress.failures=0;
      }catch(error){progress.stage='waiting';progress.error=String(error.message||error);progress.failures=(previous.failures||0)+1;
        progress.nextAt=Math.max(Number(error.retryAt)||0,now()+Math.min(30,2**Math.min(progress.failures,5))*60000);
      }finally{progress.updatedAt=now();await save(id,state);await log(fanScheduleLogEntry(id,kind,previous,progress));}
    }
    if(reviewReady)await drain({force:true,only:'review'});
    return state;
  }
  return {schedule,run(options){if(!running)running=drain(options).finally(()=>{running=null;});return running;},status:read};
}
