import {evaluatePost} from '../post-tracking/post-model.js';
import {learningHash,DAY} from './learning-model.js';

export function createLearningSources({posts,leaderboard,config=async()=>({}),now=Date.now}){
  return async ownerId=>{
    const own=await posts.list(ownerId),settings=await config(),samples=[];
    const snapshot=(p,kind,purpose,key)=>{
      if(!p.text||!/^\d+$/.test(p.postId)||!Number.isFinite(p.capturedAt))return;
      const sample={ownerId,postId:p.postId,authorId:p.authorId||'',handleAtCapture:p.handle||p.handleAtCapture||'',text:p.text.slice(0,650),truncated:Boolean(p.truncated)||p.text.length>650,metrics:p.metrics||null,metricStates:p.metricStates||null,capturedAt:p.capturedAt,url:p.url||`https://x.com/i/status/${p.postId}`,originalPostText:p.source?.originalPostText?.slice(0,300)||null,kind,purpose,key,availability:'available'};
      sample.hash=learningHash(sample);samples.push(sample);
    };
    for(const p of own.sort((a,b)=>a.createdAt-b.createdAt)){
      if(p.ownerId!==ownerId||p.availability==='unavailable'||p.deletion&&p.deletion.status!=='failed'||now()-p.createdAt>90*DAY)continue;
      const evaluation=evaluatePost(p,own,now(),undefined,settings.lowRules);
      if(!evaluation.low&&!evaluation.high||now()-p.createdAt<Math.max(24,settings.lowRules?.matureHours||0)*3600000)continue;
      snapshot({...p,authorId:ownerId},evaluation.low?'low':'high',p.type==='reply'||p.source?.kind==='auto-quote'?'comment':'original',`own:${p.postId}`);
    }
    const reports=(await leaderboard.listReports(ownerId)).filter(r=>r.status==='completed').sort((a,b)=>a.date.localeCompare(b.date));
    for(const report of reports){
      if(now()-Date.parse(report.date)>30*DAY)continue;
      const job=report.samples?report:await leaderboard.getJob(ownerId,report.date);
      for(const item of job?.items||[]){if(item.quality!=='high')continue;const p=job.samples?.find(p=>p.postId===item.postId);if(p)snapshot(p,'external','all',`external:${p.postId}`);}
    }
    return samples;
  };
}
