import {PROFILE_ACCESS_PREFIX} from '../../platform/x/profile-access.js';
import {FAN_PROFILE_STATE} from './fan-profile-collector.js';
import {fanJobBusy} from './fan-retention.js';
export const UNAVAILABLE_CLEANUP_ALARM='xef-unavailable-cleanup';
export const FAN_CLEANUP_STATUS='fanRetentionCleanupStatus';
const terminal=e=>['not_found','suspended'].includes(e?.status)&&Number.isFinite(e.checkedAt);

// Existing record journals and queue transactions own data writes. This adapter
// rechecks actual records on every run; an old completion flag is never proof.
export function createUnavailableCleanup({storage,queue,records,discardProfiles,isJobActive=()=>false,now=Date.now}) {
  let running;
  async function drain(){
    const keys=storage.getKeys?await storage.getKeys():null;
    const snapshot=await storage.get(keys?['followQueueBinding',FAN_PROFILE_STATE,...keys.filter(k=>k.startsWith(PROFILE_ACCESS_PREFIX))]:null),binding=snapshot.followQueueBinding;
    if(!binding?.accountId)return {deferred:true};
    const owner=binding.accountId,candidates=new Map();
    for(const[key,evidence]of Object.entries(snapshot))if(key.startsWith(PROFILE_ACCESS_PREFIX)&&terminal(evidence)){
      const handle=key.slice(PROFILE_ACCESS_PREFIX.length);if(/^[a-z0-9_]{1,15}$/.test(handle))candidates.set(handle,{handle,scope:'account',targetIds:[]});
    }
    const found=await records.handle({op:'fanCleanupCandidates',ownerId:owner});
    if(!found?.ok)throw Error(found?.error||'粉丝清理范围读取失败');
    for(const item of found.candidates||[])candidates.set(item.handle,item);
    const jobs=await queue.list({accountId:owner}),results=[];
    const profiles=snapshot[FAN_PROFILE_STATE]||{},profileItems=[...Object.values(profiles.pending||{}),...(profiles.history||[]),...(profiles.active?[profiles.active]:[])];
    // Completed exclusions only need another pass when dependent work remains.
    // Source candidates are always rechecked, regardless of an older marker.
    for(const[handle,item]of candidates)if(item.orphan&&!item.hasRecords&&!jobs.some(job=>String(job.handle).toLowerCase()===handle&&(item.scope==='account'||job.sources?.some(source=>source.module==='fans')||job.fanGrant||job.followBackCandidate))&&!profileItems.some(p=>p.accountId===owner&&p.handle===handle))candidates.delete(handle);
    const summary={stage:'running',accountId:owner,total:candidates.size,processed:0,accounts:0,records:0,jobs:0,detached:0,deferred:0,failed:0,updatedAt:now()};
    await storage.set({[FAN_CLEANUP_STATUS]:{...summary}});
    for(const candidate of candidates.values()){
      const {handle}=candidate;
      if((await storage.get('followQueueBinding')).followQueueBinding?.accountId!==owner){summary.stage='paused';break;}
      const matching=jobs.filter(job=>String(job.handle).toLowerCase()===handle&&(!candidate.targetIds?.length||!job.targetUserId||candidate.targetIds.includes(job.targetUserId)));
      if(matching.some(job=>fanJobBusy(job,now(),isJobActive(job)))){summary.deferred++;summary.processed++;results.push({handle,deferred:true});continue;}
      try{
        if((await discardProfiles?.({...candidate,ownerId:owner,checkOnly:true}))?.deferred){summary.deferred++;summary.processed++;results.push({handle,deferred:true});continue;}
        const response=await records.handle({op:'cleanupFanRecord',ownerId:owner,handle,targetIds:candidate.targetIds||[]});
        const result=response?.result;
        if(!response?.ok)throw Error(response?.error||'粉丝记录清理失败');
        if(result?.skipped){summary.processed++;results.push({handle,skipped:true});continue;}
        if((await discardProfiles?.({...candidate,ownerId:owner,targetIds:result.targetIds||[],checkOnly:false}))?.deferred)throw Error('资料采集正在执行，稍后继续清理');
        let removed=0,detached=0;
        for(const job of matching.filter(job=>!result.targetIds?.length||!job.targetUserId||result.targetIds.includes(job.targetUserId))){
          if(result.scope==='fans'&&!job.sources?.some(source=>source.module==='fans')&&!job.fanGrant&&!job.followBackCandidate&&!job.fanReview&&!job.followResult?.fanGrant&&!job.followResult?.fanReview)continue;
          if(result.scope==='fans'&&job.sources?.some(source=>source.module!=='fans')){
            const r=await queue.stripFanSource({accountId:owner,id:job.id});if(!r.ok&&r.reason!=='missing')throw Error(r.reason||'粉丝来源清理未完成');if(r.ok)detached++;
          }else{
            const r=await queue.deleteJob({accountId:owner,id:job.id,fanOnly:result.scope==='fans',preserveOutcome:true});
            if(!r.ok&&!/未找到/.test(r.reason||''))throw Error(r.reason||'队列清理未完成');removed+=r.deleted||0;
          }
        }
        if(result.scope==='account'&&!result.targetIds?.length&&matching.length)await queue.markDeletedHandle({accountId:owner,handle});
        if(result.deleted||removed||detached)summary.accounts++;
        summary.records+=result.deleted||0;summary.jobs+=removed;summary.detached+=detached;
        results.push({handle,scope:result.scope,records:result.deleted||0,jobs:removed,detached});
      }catch(error){summary.failed++;results.push({handle,deferred:true,error:String(error.message||error)});}
      summary.processed++;summary.updatedAt=now();
      if(summary.processed%10===0)await storage.set({[FAN_CLEANUP_STATUS]:{...summary}});
    }
    summary.stage=summary.stage==='paused'?'paused':summary.failed||summary.deferred?'pending':'completed';summary.updatedAt=now();
    await storage.set({[FAN_CLEANUP_STATUS]:{...summary}});
    // Replace the old misleading per-handle done cache with the verified report.
    await storage.remove?.('xefUnavailableCleanup');
    return {results,summary};
  }
  return {run(){if(!running)running=drain().finally(()=>{running=null});return running;},
    changed(changes){return Object.entries(changes).some(([key,c])=>key.startsWith(PROFILE_ACCESS_PREFIX)&&terminal(c.newValue)&&(!terminal(c.oldValue)||c.oldValue.checkedAt!==c.newValue.checkedAt));}};
}
