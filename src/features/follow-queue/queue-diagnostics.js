import {APP_VERSION} from '../../shared/version.js';
import {appendExecutionLog} from '../../shared/execution-log.js';
import {capturePageFailure,pageFailureMessage} from '../../platform/page-failure.js';

export const QUEUE_DIAGNOSTICS_KEY='followQueueDiagnostics';
export const QUEUE_NOTICE_GAP=10*60*1000;
// All failures stay in the execution log; a bounded local ring survives restarts
// even if the log backup fails. Notification throttling never throttles logging.
export function createQueueDiagnostics({api,writeLog=entry=>appendExecutionLog(entry,api.storage.local),now=()=>Date.now()}={}) {
  let writes=Promise.resolve();
  function record(error,context={}) {
    const next=writes.then(async()=>{
      const diagnostic={...await capturePageFailure(api,error,context),version:APP_VERSION};
      try{diagnostic.recentStorageFailures=((await api.storage.local.get('xStoragePageFailures')).xStoragePageFailures||[]).slice(0,5);}catch{}
      const message=pageFailureMessage(error),time=now();
      let notify=true;
      try {
        const saved=(await api.storage.local.get(QUEUE_DIAGNOSTICS_KEY))[QUEUE_DIAGNOSTICS_KEY]||{};
        const key=['target-v2',diagnostic.accountId,diagnostic.targetUserId || diagnostic.handle.toLowerCase(),diagnostic.code,diagnostic.stage,diagnostic.rawError].join(':');
        const prior=(saved.groups||[]).find(g=>g.key===key);
        notify=!prior?.notifiedAt||time-prior.notifiedAt>=QUEUE_NOTICE_GAP;
        const group={key,count:(prior?.count||0)+1,firstAt:prior?.firstAt||time,lastAt:time,notifiedAt:notify?time:prior.notifiedAt};
        diagnostic.repeatCount=group.count;
        diagnostic.repeatScope='target-error';
        await api.storage.local.set({[QUEUE_DIAGNOSTICS_KEY]:{groups:[group,...(saved.groups||[]).filter(g=>g.key!==key)].slice(0,40),recent:[diagnostic,...(saved.recent||[])].slice(0,50)}});
      } catch { /* Never turn a logging failure into a failed queue item. */ }
      const detail=`${message} 阶段：${diagnostic.stageLabel}；账号：${diagnostic.handle?'@'+diagnostic.handle:'批次级'}；诊断编号：${diagnostic.id}`;
      if (!context.deferLog) await writeLog({scope:'queue',type:'queue-page-error',result:'failed',source:diagnostic.trigger,accountId:diagnostic.accountId,handle:diagnostic.handle,jobId:diagnostic.jobId,runId:diagnostic.runId,detail,diagnostic,at:diagnostic.at}).catch(()=>{});
      return {diagnostic,message,notify};
    });
    writes=next.catch(()=>{});return next;
  }
  return {record};
}
