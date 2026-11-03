import Dexie from 'dexie';
import {readMonitorFanRows,updateMonitorFanRows,recordRemovalTombstone,readReviewSettings} from './follow-review-engine.js';
import {disabledFanRemoval} from './fan-removal-rules.js';

export const FAN_REMOVAL_ALARM='x-fan-removal-queue';
const canonical=value=>String(value||'').replace(/^@/,'').toLowerCase();

// Producers persist work and return. This consumer has its own alarm and never
// waits for an AI review batch or the profile collection queue to finish.
export function createFanRemovalQueue({api,readBinding,records,removeFollower,store,onChanged,onLog=async()=>{},
  list=async()=>[],now=Date.now,name='xfollower-fan-removals',dependencies}={}) {
  const db=new Dexie(name,dependencies);db.version(1).stores({jobs:'&id,accountId,[accountId+state],createdAt'});
  const jobs=db.table('jobs');let running;
  const bound=async id=>{const b=await readBinding();return b?.activated&&b.accountId===id;};
  async function enqueue(input){
    const accountId=String(input.accountId||''),targetUserId=String(input.targetUserId||''),handle=canonical(input.handle);
    if(!/^\d+$/.test(accountId)||!/^\d+$/.test(targetUserId)||accountId===targetUserId||!/^[a-z0-9_]{1,15}$/.test(handle))throw Error('移除队列缺少明确的账号和用户 ID');
    if(!await bound(accountId))throw Error('移除任务所属账号已变化');
    const id=accountId+':'+targetUserId;
    const added=await db.transaction('rw',jobs,async()=>{const old=await jobs.get(id);if(old&&old.state!=='cancelled')return false;
      await jobs.put({id,accountId,targetUserId,handle,reason:input.reason||'',state:'pending',createdAt:now(),nextAt:input.retryAt||0,attempts:0});return true;});
    if(added)await api.alarms.create(FAN_REMOVAL_ALARM,{when:now()+1000,periodInMinutes:1});
    return {accountId,targetUserId,handle,attempted:false,removed:false,state:'queued',deferred:true,reason:'已进入自动移除队列'};
  }
  async function context(job){
    const rows=await readMonitorFanRows({records,storage:api.storage.local,...job});
    const review=rows.map(r=>r.payload.fanReview).filter(Boolean).sort((a,b)=>(b.decisionVersion||0)-(a.decisionVersion||0))[0];
    return {rows,review};
  }
  async function work(){
    const binding=await readBinding();if(!binding?.activated)return;
    // Recover historical rejections, including old removal receipts, without AI.
    for(const item of await list(binding.accountId))if(item.removalPending)await enqueue({...item,accountId:binding.accountId});
    const candidates=await jobs.where('accountId').equals(binding.accountId).toArray();
    const job=candidates.filter(j=>['pending','running'].includes(j.state)&&(j.nextAt||0)<=now()&&(!j.leaseUntil||j.leaseUntil<=now()))
      .sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))[0];
    if(!job)return;
    const {rows,review}=await context(job);
    const rules=(await readReviewSettings(api.storage.local,job.accountId)).removalRules;
    if(review?.state!=='removed'&&disabledFanRemoval(review,rules)){
      await updateMonitorFanRows({records,storage:api.storage.local,...job,expectedDecisionVersion:review.decisionVersion||0,
        patch:{fanReview:{...review,state:'review',decision:'review',reasonCode:'',source:'removal-rule-disabled',reason:'移除规则已关闭，返回审核',removalReceipt:null,
          decisionVersion:(review.decisionVersion||0)+1,updatedAt:now()}}});
      await jobs.update(job.id,{state:'cancelled',finishedAt:now(),reason:'移除规则已关闭'});await onChanged?.();return;
    }
    if(!rows.length||review?.state==='removed'||review?.source==='manual-approve'||review?.decision!=='remove'&&!['ai_rejected','keyword_rejected'].includes(review?.reasonCode)){
      await jobs.update(job.id,{state:review?.state==='removed'?'done':'cancelled',finishedAt:now()});return;
    }
    // Claim inside an IndexedDB transaction so overlapping alarm events or a
    // second runtime cannot submit the same target concurrently.
    const claimed=await db.transaction('rw',jobs,async()=>{const latest=await jobs.get(job.id);if(!latest||latest.leaseUntil>now()||!['pending','running'].includes(latest.state))return false;
      await jobs.update(job.id,{state:'running',leaseUntil:now()+180000,attempts:latest.attempts+1});return true;});
    if(!claimed)return;
    try{
      if(!await bound(job.accountId))throw Error('移除任务所属账号已变化');
      const followJob=await store?.lookup?.(job),follow=followJob?.followResult;
      if(follow?.attemptedAt&&follow.succeeded!==true&&follow.attempted!==false)throw Error('等待已有关注操作结果自动核实');
      const receipt=await removeFollower({...job,reason:review.reason||job.reason});
      if(!await bound(job.accountId))throw Error('移除任务所属账号已变化');
      const confirmed=receipt?.removed===true&&receipt.accountId===job.accountId&&receipt.targetUserId===job.targetUserId&&receipt.verifiedAt>0;
      const latest=await context(job);
      if(confirmed)await recordRemovalTombstone(api.storage.local,job.accountId,{...job,state:'removed',source:'ai-remove',reason:review.reason||job.reason,tags:review.tags||[]});
      if(latest.rows.length&&latest.review?.source!=='manual-approve'){
        const next={...latest.review,state:confirmed?'removed':'review',decision:'remove',source:review.source==='manual-remove'?'manual-remove':confirmed?'ai-remove':'ai-rejection',reasonCode:'ai_rejected',
          reason:review.reason||job.reason,removalReceipt:receipt,grant:null,retryAt:confirmed?0:Math.max(receipt?.retryAt||0,now()+60000),
          ownerAccountId:job.accountId,targetUserId:job.targetUserId,decisionVersion:(latest.review?.decisionVersion||0)+1,updatedAt:now()};
        await updateMonitorFanRows({records,storage:api.storage.local,...job,expectedDecisionVersion:latest.review?.decisionVersion||0,
          patch:{fanReview:next,fanGrant:null,followerRemoval:receipt,...(confirmed?{status:'removed',state:'removed_follower',autoFollowState:'excluded',
            relationship:{following:false,followedBy:false},relationshipKnown:true,followingObservedAt:receipt.verifiedAt,followedByObservedAt:receipt.verifiedAt,followerRemovedAt:new Date(receipt.verifiedAt).toISOString()}:{} )}});
      }
      const queueJob=await store?.lookup?.(job);
      if(queueJob&&queueJob.state!=='followed')await store.resolveJob({accountId:job.accountId,id:queueJob.id,state:confirmed?'excluded':'skipped',stage:'skipped',followResult:{...(queueJob.followResult||{}),followerRemoval:receipt,reason:review.reason||job.reason}});
      await jobs.update(job.id,{state:confirmed?'done':'pending',leaseUntil:0,nextAt:confirmed?0:Math.max(receipt?.retryAt||0,now()+60000),receipt,updatedAt:now()});
      await onLog({scope:'fanReview',source:'scheduled',accountId:job.accountId,handle:job.handle,result:confirmed?'removed':'waiting',detail:confirmed?'已自动移除关注者':receipt.reason||'移除队列等待重试'});
      await onChanged?.();
      return {handle:job.handle,removed:confirmed};
    }catch(error){await jobs.update(job.id,{state:'pending',leaseUntil:0,nextAt:Math.max(error.retryAt||0,now()+60000),error:error.message});
      await onLog({scope:'fanReview',source:'scheduled',accountId:job.accountId,handle:job.handle,result:'waiting',detail:error.message});}
  }
  return {enqueue,db,async schedule(){if(!await api.alarms.get(FAN_REMOVAL_ALARM))await api.alarms.create(FAN_REMOVAL_ALARM,{periodInMinutes:1});},
    run(){return running ||= work().finally(()=>{running=null;});},async status(accountId){return jobs.where('accountId').equals(accountId).toArray();}};
}
