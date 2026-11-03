import {isLocalAiProvider} from '../grok/grok-local.js';
import {makeTagBatch,parseTags} from './model.js';
import {commentCacheKey} from './cache.js';

export const TAG_MAX_ATTEMPTS=4; // Initial submission plus three retries, persisted per post.
export const TAG_RETRY_MS=5*60000;
export const unfinishedTag=row=>!row.tag||['pending','tagging','failed'].includes(row.tag);
export const blockingAiResult=result=>result?.blocking===true||/无法连接|接口|Token|未连接|服务|会话.*不存在|找不到本地任务/.test(result?.reason||'');

export function tagProgress(rows,run){
  if(!run)return null;
  const ids=new Set(run.postIds),selected=rows.filter(row=>ids.has(row.postId));
  const done=selected.filter(row=>!unfinishedTag(row)).length;
  const exhausted=selected.filter(row=>unfinishedTag(row)&&row.tag!=='tagging'&&(row.tagAttempts||0)>=TAG_MAX_ATTEMPTS).length;
  const removed=run.total-selected.length;
  return {id:run.id,status:run.status,total:run.total,done,exhausted,removed,remaining:selected.length-done-exhausted};
}

export function createTagRecovery({store,analyze,validateEngine,guard,reuseTags,now,uuid}){
  async function block(id,reason){
    const old=(await store.config(id))?.tagServiceIssue;
    await store.updateConfig(id,{tagServiceIssue:{reason,since:old?.since||now(),nextProbeAt:now()+TAG_RETRY_MS}});
  }
  async function ready(account,config){
    if(!config.tagServiceIssue)return true;
    if(config.tagServiceIssue.nextProbeAt>now())return false;
    try{
      await validateEngine({generationProvider:config.scanProvider,generationBotId:config.scanBotId});
      await guard(account,'scan');
      // Keep the warning until a real classification succeeds; a health check is not a label.
      await store.updateConfig(account.accountId,{tagServiceIssue:{...config.tagServiceIssue,nextProbeAt:0}});
      return true;
    }catch(error){await block(account.accountId,error.message);return false;}
  }
  async function work(account,config){
    const id=account.accountId;
    await guard(account,'scan');await reuseTags(account);
    let rows=await store.list(id),batches=await store.batches(id);
    const byId=new Map(batches.map(batch=>[batch.id,batch]));
    // Recover interrupted reservations without guessing that any comment was published.
    for(const row of rows.filter(r=>unfinishedTag(r))){
      const batch=byId.get(row.tagBatchId);
      if(row.tag==='tagging'&&!row.tagAttempts)await store.updatePost({...row,tagAttempts:1});
      if(!row.tag||row.tag==='tagging'&&(!batch||['failed','completed'].includes(batch.status))){
        await store.updatePost({...row,tag:'failed',tagReason:'打标任务中断，等待重试',tagAttempts:Math.max(1,row.tagAttempts||0)});
      }
    }
    for(const batch of batches)if(batch.status==='sending'){
      if(batch.relayJobId||batch.raw)await store.saveBatch({...batch,status:batch.raw?'raw_saved':'waiting'});
      else await store.failBatch(batch,'上次打标提交中断，等待重试',now()+TAG_RETRY_MS);
    }
    rows=await store.list(id);batches=await store.batches(id);
    const manual=config.manualTagRun?.status==='running'?new Set(config.manualTagRun.postIds):null;
    const inScope=row=>!manual||manual.has(row.postId);
    let batch=batches.filter(b=>['prepared','waiting','raw_saved'].includes(b.status)&&(!b.retryAt||b.retryAt<=now())&&b.postIds.some(pid=>rows.some(r=>r.postId===pid&&r.tagBatchId===b.id&&inScope(r)))).sort((a,b)=>(a.lastAttemptAt||0)-(b.lastAttemptAt||0))[0];
    if(batch?.error){
      const owned=rows.filter(r=>r.tagBatchId===batch.id);
      if(owned.every(r=>(r.tagAttempts||1)>=TAG_MAX_ATTEMPTS)){
        await store.failBatch(batch,batch.error);batch=null;
      }else{await store.retryBatch(batch);batch={...batch,error:'',retryAt:0};}
    }
    if(!batch){
      const pending=rows.filter(r=>inScope(r)&&['pending','failed'].includes(r.tag)&&(r.tagAttempts||0)<TAG_MAX_ATTEMPTS&&(!r.tagRetryAt||r.tagRetryAt<=now())).sort((a,b)=>(a.tagAttempts||0)-(b.tagAttempts||0)||a.createdAt-b.createdAt);
      if(!pending.length)return {idle:true};
      const seen=new Set(),unique=pending.filter(row=>{const key=commentCacheKey(row);if(!key)return true;if(seen.has(key))return false;seen.add(key);return true;});
      const batchId=uuid(),prepared=makeTagBatch(batchId,unique,manual?30:Math.min(30,config.batchSize));
      batch={id:batchId,ownerId:id,at:now(),status:'prepared',postIds:prepared.posts.map(p=>p.postId),prompt:prepared.prompt,provider:config.scanProvider,botId:config.scanBotId};
      await store.reserveBatch(batch);
    }
    try{
      if(!batch.raw){
        await guard(account,'scan');batch={...batch,status:'sending',lastAttemptAt:now()};await store.saveBatch(batch);
        const result=await analyze(batch.prompt,{provider:batch.provider,botId:isLocalAiProvider(batch.provider)?batch.botId:undefined,relayJobId:batch.relayJobId,requestKey:'mutual-tags:'+id+':'+batch.id,onJobCreated:async job=>{batch={...batch,relayJobId:job.id,status:'waiting'};await store.saveBatch(batch);}});
        if(!result?.ok){
          const reason=result?.reason||'AI 未返回结果';
          if(blockingAiResult(result))await block(id,reason);
          if(result?.pending&&batch.relayJobId&&!result.generationUnknown){
            const owned=(await store.list(id)).filter(row=>row.tagBatchId===batch.id);
            if(blockingAiResult(result)&&owned.every(row=>(row.tagAttempts||1)>=TAG_MAX_ATTEMPTS)){
              await store.failBatch(batch,reason);return {ok:false,error:reason};
            }
            // Healthy polling does not spend retry credit, but cannot wait forever either.
            const expired=now()-batch.at>30*60000;
            if(!expired||blockingAiResult(result)){
              await store.saveBatch({...batch,status:'waiting',retryAt:now()+TAG_RETRY_MS,error:blockingAiResult(result)?reason:'',pendingReason:reason});
              return {pending:true};
            }
          }
          throw Error(reason);
        }
        batch={...batch,raw:result.text,status:'raw_saved'};await store.saveBatch(batch);
      }
      await guard(account,'scan');const tags=parseTags(batch.raw,batch.id,batch.postIds);
      await store.finishBatch(batch,tags,now());await store.updateConfig(id,{tagServiceIssue:null});await reuseTags(account);
      return {ok:true,tagged:tags.length};
    }catch(error){
      // Saved AI results may be applied after resuming, but never after an account switch.
      try{await guard(account,'scan');}catch{return {paused:true};}
      if(error.blocking||blockingAiResult({reason:error.message}))await block(id,error.message);
      await store.failBatch(batch,error.message,now()+TAG_RETRY_MS);return {ok:false,error:error.message};
    }
  }
  async function settle(id){
    const config=await store.config(id),rows=await store.list(id),progress=tagProgress(rows,config?.manualTagRun);
    if(progress?.status==='running'&&progress.remaining===0)await store.updateConfig(id,{manualTagRun:{...config.manualTagRun,status:'completed',finishedAt:now()},collectionDeferred:false});
  }
  return {ready,work,settle};
}
