import {FAN_PROFILE_ALARM,FAN_PROFILE_STATE,FAN_PROFILE_HISTORY_LIMIT} from './fan-profile-collector.js';
import {sameProfile} from './fan-profile-evidence.js';

// Reuse the record service's indexed source paging. Only keep small, verified
// timeline metadata, never the biographies or post bodies. Polls share a scan.
export function createFanProfileCacheReader({records,storage,now=Date.now}){
  let cached=null,inFlight=null,failed=null;
  async function scan(accountId,onProgress){
    let cursor=null,items=[];
    function collect(row){
      const p=row.payload||row,t=p.fanInspectionTimeline;
      const finishedAt=t?.checkedAt||t?.fetchedAt;
      if(t?.ownerAccountId!==accountId||!sameProfile(p,{handle:p.handle,targetUserId:t.targetUserId})||
        !['ready','partial','empty','unavailable','failed','rate-limited'].includes(t.status)||!Number.isFinite(finishedAt)||finishedAt<=0||finishedAt>now())return;
      const previous=items.findIndex(item=>item.targetUserId===t.targetUserId);
      if(previous>=0){if(items[previous].finishedAt>=finishedAt)return;items.splice(previous,1);}
      items.push({handle:p.handle,targetUserId:t.targetUserId,status:t.status,count:t.count??t.posts?.length??0,
        finishedAt,attempts:null,reason:t.reason||'',source:'profile-cache'});
    }
    if(records){
      do{
        const page=await records.sourcePage({sourceKey:'profileCache',limit:100,cursor});
        for(const row of page.records||[])collect(row);
        items.sort((a,b)=>b.finishedAt-a.finishedAt);items.length=Math.min(items.length,FAN_PROFILE_HISTORY_LIMIT);
        onProgress?.([...items]);
        cursor=page.nextCursor;
      }while(cursor);
    }else{
      const {profileCache={}}=await storage.get('profileCache');for(const p of Object.values(profileCache))collect(p);
    }
    return items.sort((a,b)=>b.finishedAt-a.finishedAt).slice(0,FAN_PROFILE_HISTORY_LIMIT);
  }
  const read=async(accountId,{refresh=false,maxWaitMs=Infinity}={})=>{
    if(!refresh&&cached?.accountId===accountId&&now()-cached.at<30000)return cached.items;
    if(!refresh&&failed?.accountId===accountId&&now()-failed.at<30000)throw failed.error;
    let job=inFlight?.accountId===accountId?inFlight:null;
    if(!job){
      job={accountId,items:cached?.accountId===accountId?cached.items:[]};failed=null;
      const promise=scan(accountId,items=>job.items=items).then(items=>{if(inFlight===job){cached={accountId,at:now(),items};inFlight=null;}return items;},error=>{if(inFlight===job){inFlight=null;failed={accountId,at:now(),error};}throw error;});
      job.promise=promise;inFlight=job;
    }
    if(!Number.isFinite(maxWaitMs))return job.promise;
    let timer;
    try{return await Promise.race([job.promise,new Promise(resolve=>timer=setTimeout(()=>resolve([...job.items]),Math.max(0,maxWaitMs)))]);}
    finally{clearTimeout(timer);}
  };
  read.loading=accountId=>inFlight?.accountId===accountId;
  return read;
}

// A read-only projection of durable checkpoints. Viewing never wakes a collector
// or probes X, and only returns the currently bound owner's jobs.
export async function readFanProfileQueue({storage,alarms,binding,readCachedResults,now=Date.now},request={}){
  const owner=await binding();
  if(!owner?.activated)return {requiresActivation:true,accountId:null,items:[],summary:null,total:0,page:1,pages:1};
  const cached=await readCachedResults?.(owner.accountId,{refresh:request.refreshCache===true,maxWaitMs:100})||[];
  const loadingCache=!!readCachedResults?.loading?.(owner.accountId);
  const saved=(await storage.get(FAN_PROFILE_STATE))[FAN_PROFILE_STATE]||{};
  const at=now(),pending=Object.values(saved.pending||{}).filter(item=>item.accountId===owner.accountId);
  const active=saved.activeUntil>at&&saved.active?.accountId===owner.accountId&&pending.some(item=>item.token&&item.token===saved.active.token)?saved.active:null;
  const isActive=item=>!!active&&item.token===active.token;
  const recent=(saved.history||[]).filter(item=>item.accountId===owner.accountId);
  const tracked=new Set([...pending,...recent].map(item=>item.targetUserId));
  const history=[...recent,...cached.filter(item=>!tracked.has(item.targetUserId))].sort((a,b)=>(b.finishedAt||0)-(a.finishedAt||0)).slice(0,FAN_PROFILE_HISTORY_LIMIT);
  const due=item=>Math.max(item.retryAt||0,saved.nextRequestAt||0,saved.activeUntil||0);
  const alarm=await alarms?.get?.(FAN_PROFILE_ALARM);
  const pendingRows=pending.sort((a,b)=>Number(isActive(b))-Number(isActive(a))||due(a)-due(b)).map(item=>({
    handle:item.handle,targetUserId:item.targetUserId,status:isActive(item)?'running':item.status||'pending',
    attempts:(item.attempts||0)+(isActive(item)?1:0),retryAt:isActive(item)?null:due(item),reason:item.reason||'',finished:false
  }));
  const finishedRows=history.map(item=>({handle:item.handle,targetUserId:item.targetUserId,status:item.status,count:item.count||0,
    attempts:item.source==='profile-cache'?null:item.attempts||0,source:item.source||'queue',reason:item.reason||'',finishedAt:item.finishedAt,finished:true}));
  const current=await binding();
  if(!current?.activated||current.accountId!==owner.accountId)throw Error('资料采集绑定账号已变化');
  const failed=item=>['failed','unavailable','rate-limited'].includes(item.status);
  const filter=['pending','finished','failed'].includes(request.filter)?request.filter:'all';
  const rows=filter==='pending'?pendingRows:filter==='finished'?finishedRows:filter==='failed'?finishedRows.filter(failed):[...pendingRows,...finishedRows];
  const limit=30,pages=Math.max(1,Math.ceil(rows.length/limit)),page=Math.min(pages,Math.max(1,Math.floor(Number(request.page)||1)));
  return {accountId:owner.accountId,handle:owner.handle,observedAt:at,page,pages,total:rows.length,items:rows.slice((page-1)*limit,page*limit),
    summary:{pending:pending.length,finished:history.length,total:pending.length+history.length,
      succeeded:history.filter(item=>!failed(item)).length,failed:history.filter(failed).length,
      running:active?.handle||'',recovering:!active&&saved.activeUntil>at&&pending.length>0,
      nextRunAt:pending.length?Math.max(at,Math.min(...pending.map(due)),alarm?.scheduledTime||0):null,
      scheduled:!!alarm,historyLimit:FAN_PROFILE_HISTORY_LIMIT,loadingCache}};
}
