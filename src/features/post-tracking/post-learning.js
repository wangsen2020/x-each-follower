import {requestGrokText} from '../grok/grok-comment.js';
import {memoryKey,learningKey,readWritingMemory,buildLearningPrompt,parsePostAnalysis} from './writing-memory.js';

export function createPostLearning({api,store,ask=requestGrokText,now=()=>Date.now()}){
  let running=null;
  const setJob=job=>api.storage.local.set({[learningKey(job.ownerId)]:job});
  async function state(ownerId){
    let job=(await api.storage.local.get(learningKey(ownerId)))[learningKey(ownerId)]||null;
    if(job?.status==='running'&&!running&&now()-job.startedAt>240000){job={...job,status:'interrupted',error:'分析等待已结束；未自动重试，请检查后重新选择分析。'};await setJob(job);}
    return {job,memory:await readWritingMemory(api,ownerId)};
  }
  async function execute(job){
    try{
      const response=await ask(buildLearningPrompt(job),{timeoutMs:120000});
      if(!response?.ok)throw new Error(response?.reason||'Grok 分析失败');
      const analysis=parsePostAnalysis(response.text,job),memory=await readWritingMemory(api,job.ownerId);
      const currentJob=(await api.storage.local.get(learningKey(job.ownerId)))[learningKey(job.ownerId)];
      if(currentJob?.id!==job.id)throw new Error('分析任务已变更，忽略迟到结果');
      const validIds=new Set();let retained=0,reviewed=0,skipped=0;
      for(const review of analysis.reviews){const sample=job.samples.find(p=>p.postId===review.postId);const applied=await store.update(job.ownerId,review.postId,current=>{
        if(!current||current.text!==sample.text||current.deletion&&current.deletion.status!=='failed')return null;
        return {...current,grokReview:{...review,source:'grok',analysisId:job.id,analyzedAt:now()}};
      });if(applied){validIds.add(review.postId);reviewed++;if(review.keep)retained++;}else skipped++;}
      const rules=analysis.rules.map(rule=>({...rule,evidencePostIds:rule.evidencePostIds.filter(id=>validIds.has(id))})).filter(rule=>rule.evidencePostIds.length);
      const updated=[...memory.rules];let added=0,memorySkipped=0;
      for(const rule of rules){const key=rule.text.replace(/\s+/g,'').toLowerCase();const existing=updated.find(r=>r.kind===job.kind&&r.text.replace(/\s+/g,'').toLowerCase()===key);
        if(existing){existing.evidencePostIds=[...new Set([...existing.evidencePostIds,...rule.evidencePostIds])].slice(-20);continue;}
        if(updated.filter(r=>r.kind===job.kind).length>=20){memorySkipped++;continue;}
        updated.push({...rule,id:crypto.randomUUID(),kind:job.kind,enabled:false,createdAt:now(),analysisId:job.id,source:'grok'});added++;
      }
      await api.storage.local.set({[memoryKey(job.ownerId)]:{...memory,revision:memory.revision+1,rules:updated,updatedAt:now()}});
      await setJob({...job,status:'completed',finishedAt:now(),added,total:rules.length,reviewed,retained,skipped,memorySkipped});
    }catch(error){const current=(await api.storage.local.get(learningKey(job.ownerId)))[learningKey(job.ownerId)];if(current?.id===job.id)await setJob({...job,status:'failed',finishedAt:now(),error:String(error?.message||error)});}
    finally{running=null;}
  }
  async function start({ownerId,kind,postIds}){
    if(!['high','low'].includes(kind)||!Array.isArray(postIds)||postIds.length<1||postIds.length>20||new Set(postIds).size!==postIds.length)throw new Error('请选择1–20条自己的帖子并指定分析类型');
    const {job:old}=await state(ownerId);if(running||old?.status==='running')throw new Error('已有 Grok 分析正在进行，请勿重复提交');
    const samples=[];for(const id of postIds){const p=await store.get(ownerId,id);if(!p||p.ownerId!==ownerId||!p.text||p.deletion&&p.deletion.status!=='failed')throw new Error('所选帖子已失效，请重新选择');samples.push({postId:p.postId,text:p.text,createdAt:p.createdAt,metrics:p.metrics,metricStates:p.metricStates,capturedAt:p.capturedAt,originalPostText:p.source?.originalPostText||null,});}
    const job={id:crypto.randomUUID(),schemaVersion:2,ownerId,kind,samples,status:'running',startedAt:now()};await setJob(job);
    running=execute(job);return {jobId:job.id};
  }
  async function save(ownerId,{revision,rules}){
    const current=await state(ownerId);if(running||current.job?.status==='running')throw new Error('请等待本轮分析结束再编辑特点');
    const memory=current.memory;if(revision!==memory.revision)throw new Error('写作记忆已更新，请重新打开后编辑');
    if(!Array.isArray(rules)||rules.length>40||new Set(rules.map(r=>r.id)).size!==rules.length)throw new Error('写作特点格式无效');
    const previous=new Map(memory.rules.map(r=>[r.id,r]));
    const next=rules.map(r=>{const old=previous.get(r.id);if(!old||typeof r.text!=='string'||!r.text.trim()||r.text.length>240||typeof r.enabled!=='boolean')throw new Error('特点应为1–240字');return {...old,text:r.text.trim(),enabled:r.enabled,...(old.text!==r.text.trim()?{source:'edited',originalText:old.originalText||old.text}:{})};});
    await api.storage.local.set({[memoryKey(ownerId)]:{...memory,revision:memory.revision+1,rules:next,updatedAt:now()}});return {ok:true};
  }
  return {state,start,save};
}
