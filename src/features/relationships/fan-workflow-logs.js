// Audit persisted checkpoints, not prompts or engine connection payloads.
export const FAN_LOG_SCOPES={review:'fanReview',verify:'fanVerify',schedule:'fanSchedule'};
const text=value=>String(value||'').slice(0,3000);
const stages={running:'执行中',completed:'已完成',paused:'已暂停',failed:'技术异常',cancelled:'已取消',checking:'检查中',idle:'等待下次检查',manual:'等待手动任务结束',configuration:'等待配置 AI 引擎',disabled:'调度已关闭',waiting:'等待恢复',pending:'等待 AI 结果',submitting:'正在提交 AI',prepared:'准备审核',reserved:'准备审核',applying:'正在保存结果',received:'AI 结果已收到'};
export const fanLogResultLabel=result=>({pass:'审核通过',approved:'审核通过',rejected:'审核不通过',removed:'已移除关注者',uncertain:'资料不足',review:'待人工审核',error:'技术异常',failed:'技术异常',verified:'核实完成',ready:'资料就绪，待复审',waiting:'等待补采或重试',skipped:'已跳过',deferred:'等待执行',returned:'已退回审核','identity-mismatch':'账号记录不一致',...stages}[result]||'状态更新');
const base=(scope,batch)=>({scope,accountId:batch.accountId||'',batchId:batch.id||'',source:batch.automatic?'scheduled':'manual',action:batch.action||'',total:batch.total??batch.handles?.length??batch.items?.length??0});
export function fanBatchLogEntries(scope,previous,next,{recovered=false}={}) {
 if(!next?.id)return [];
 const prior=previous?.id===next.id?previous:null,common={...base(scope,next),recovered},out=[];
 const phaseOf=batch=>['paused','failed'].includes(batch.stage)?batch.stage:batch.inFlightStage||batch.stage;
 const phase=phaseOf(next);
 if(!prior||phase!==phaseOf(prior)||next.error!==prior.error||next.reason!==prior.reason){
  out.push({...common,id:`${scope}:${next.id}:stage:${phase}:${next.updatedAt||next.completed||0}`,result:phase,
   completed:next.nextIndex||0,detail:text(next.error||next.reason),requestSize:next.inFlightItems?.length||0});
 }
 const old=new Map((prior?.results||[]).map(row=>[row.handle,JSON.stringify(row)]));
 for(const row of next.results||[])if(old.get(row.handle)!==JSON.stringify(row))out.push({...common,id:`${scope}:${next.id}:item:${row.handle}`,
  handle:row.handle,result:row.reviewTransition?.removalPending?'rejected':row.reviewTransition?.ready?'returned':row.reasonCode==='identity_unverified'?'identity-mismatch':row.status||'verified',detail:text(row.reviewTransition?.reason||row.reason||row.error),tags:(row.tags||[]).map(text).slice(0,10),
  executionStatus:row.executionStatus||'',technicalError:!!row.technicalError,relationship:row.relationship||null,jobState:row.jobState||''});
 return out;
}
export function fanCheckpointLogEntries(changes) {
 const entries=[];
 for(const [key,{oldValue,newValue}]of Object.entries(changes||{})){
  if(key.startsWith('followQueueFanReviewBatch:'))entries.push(...fanBatchLogEntries('fanReview',oldValue,newValue));
  else if(/^fanInspection:[^:]+:/.test(key))entries.push(...fanBatchLogEntries('fanVerify',oldValue,newValue));
  else if(key.startsWith('followQueueFanInitialReview:')){
   for(const [id,batch]of Object.entries(newValue?.batches||{})){
    const prior=oldValue?.batches?.[id];
    if(prior?.phase===batch.phase&&prior?.error===batch.error)continue;
    entries.push({scope:'fanReview',accountId:batch.accountId||key.split(':')[1],batchId:id,source:'scheduled',
     id:`fanReview:${id}:${batch.phase}:${batch.updatedAt||0}`,result:batch.phase,total:batch.items?.length||0,detail:text(batch.error)});
   }
  }
 }
 return entries;
}
export function fanScheduleLogEntry(accountId,kind,previous={},next={}) {
 const signature=value=>JSON.stringify([value.stage,value.error||'',value.total||0,value.batchId||'',value.processed||0]);
 if(signature(previous)===signature(next)&&Math.floor((previous.lastAt||0)/1800000)===Math.floor((next.lastAt||0)/1800000))return null;
 return {scope:'fanSchedule',source:'scheduled',accountId,kind,result:next.stage||'idle',total:next.total||0,completed:next.processed||0,
  batchId:next.batchId||'',nextAt:next.nextAt||0,detail:text(next.error),id:`fanSchedule:${accountId}:${kind}:${next.lastAt||next.updatedAt}:${next.stage}`};
}
export function createFanLogSink(append) {
 const failed=error=>console.warn('粉丝日志保存失败',error?.message||error);
 // The existing indexed writer owns serialization and durable backup. A slow
 // backup must not hold an AI or verification task at a logging await.
 return async entry=>{if(!entry)return;try{Promise.resolve(append(entry)).catch(failed);}catch(error){failed(error);}};
}
