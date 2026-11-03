export const PANEL_RESULT_EVENT='xfollower:operation-result';
export const PANEL_RESULT_ACTION_EVENT='xfollower:operation-result-action';

export function publishPanelResult(notice,target=globalThis.document){
  if(!target?.dispatchEvent)return false;
  target.dispatchEvent(new CustomEvent(PANEL_RESULT_EVENT,{detail:structuredClone(notice)}));
  return true;
}

// Business-result deduplication only; stacking, focus and dismissal belong to Vue Sonner.
export function createResultReporter({publish=publishPanelResult,now=Date.now}={}){
  const seen=new Map();let sequence=0;
  return (notice,{force=false}={})=>{
    if(!notice?.id||!notice.title)throw Error('结果通知缺少标识或标题');
    const signature=JSON.stringify(notice);
    if(!force&&seen.get(notice.id)===signature)return false;
    seen.set(notice.id,signature);const createdAt=now();publish(structuredClone({...notice,resultKey:notice.id,id:`${notice.id}:${createdAt}:${++sequence}`,createdAt}));return true;
  };
}

export function createBatchResultReporter({publish=publishPanelResult}={}){
  const report=createResultReporter({publish}),observed=new Map();
  return (batch,notice,{explicit=false}={})=>{
    if(!batch?.id)return false;
    const key=notice.id,previous=observed.get(key);observed.set(key,batch.stage);
    if(!['completed','paused','failed','cancelled'].includes(batch.stage))return false;
    if(!explicit&&previous!=='running'&&!['paused','failed'].includes(batch.stage))return false;
    return report(notice,{force:explicit});
  };
}

// One stable card per task: polls update it in place. Terminal cards have no
// timeout and a dismissed, unchanged result is not recreated by later polls.
export function createTaskProgressReporter({publish=publishPanelResult,now=Date.now}={}){
  const seen=new Map();
  return (batch,notice,{explicit=false}={})=>{
    if(!batch?.id||!notice?.id)return false;
    const previous=seen.get(notice.id);
    if(!explicit&&!previous&&['completed','cancelled'].includes(batch.stage))return false;
    const signature=JSON.stringify(notice);
    if(!explicit&&previous?.signature===signature)return false;
    const createdAt=previous?.createdAt||now();seen.set(notice.id,{signature,createdAt});
    publish(structuredClone({...notice,id:`task:${notice.id}`,resultKey:notice.id,createdAt}));return true;
  };
}
