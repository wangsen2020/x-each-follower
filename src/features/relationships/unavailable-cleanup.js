import {PROFILE_ACCESS_PREFIX} from '../../platform/x/profile-access.js';
export const UNAVAILABLE_CLEANUP_ALARM='xef-unavailable-cleanup';
const DONE='xefUnavailableCleanup';
const terminal=e=>['not_found','suspended'].includes(e?.status)&&Number.isFinite(e.checkedAt);
// Business coordinator only: existing record and queue services own deletion and backups.
export function createUnavailableCleanup({storage,queue,records,now=Date.now}) {
  let running;
  async function drain(){
    const snapshot=await storage.get(null),binding=snapshot.followQueueBinding;
    if(!binding?.accountId)return {deferred:true};
    const done={...(snapshot[DONE]||{})},results=[];
    for(const [key,evidence] of Object.entries(snapshot)){
      if(!key.startsWith(PROFILE_ACCESS_PREFIX)||!terminal(evidence))continue;
      const handle=key.slice(PROFILE_ACCESS_PREFIX.length),mark=binding.accountId+':'+handle;
      if(!/^[a-z0-9_]{1,15}$/.test(handle)||done[mark]==='v2:'+evidence.checkedAt)continue;
      const jobs=(await queue.list({accountId:binding.accountId})).filter(j=>String(j.handle).toLowerCase()===handle);
      if(jobs.some(j=>j.state==='running'||j.lease?.expiresAt>now()||j.evaluations?.some(e=>['processing','publishing'].includes(e.status)))){results.push({handle,deferred:true});continue;}
      const fresh=(await storage.get(key))[key];
      if(!terminal(fresh)||fresh.checkedAt!==evidence.checkedAt)continue;
      try {
        const result=await records.handle({op:'deleteUnavailableAccount',handle,automatic:true});
        if(!result?.ok||result.result?.skipped){results.push({handle,skipped:true});continue;}
        const latest=(await storage.get(key))[key];
        if(!terminal(latest)||latest.checkedAt!==evidence.checkedAt)continue;
        let deleted=0;
        for(const job of jobs){const r=await queue.deleteJob({accountId:job.accountId,id:job.id});if(!r.ok)throw Error(r.reason||'队列清理未完成');deleted+=r.deleted||0;}
        await queue.markDeletedHandle({accountId:binding.accountId,handle});
        done[mark]='v2:'+evidence.checkedAt;await storage.set({[DONE]:{...done}});
        results.push({handle,records:result.result.deleted,jobs:deleted});
      }catch(error){results.push({handle,deferred:true,error:String(error.message||error)});}
    }
    return {results};
  }
  return {run(){if(!running)running=drain().finally(()=>{running=null});return running;},
    changed(changes){return Object.entries(changes).some(([key,c])=>key.startsWith(PROFILE_ACCESS_PREFIX)&&terminal(c.newValue)&&(!terminal(c.oldValue)||c.oldValue.checkedAt!==c.newValue.checkedAt));}};
}
