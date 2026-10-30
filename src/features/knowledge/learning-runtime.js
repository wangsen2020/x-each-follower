import {computeKnowledgeFingerprint} from './knowledge-model.js';
import {createWisdomService} from './wisdom.js';
import {defaultLearningSettings,validateLearningSettings,nextLearningTime,buildExperiencePrompt,parseExperienceResult,nextWeeklyTime,DAY} from './learning-model.js';
import {saveMergeProposal,approveMerge} from './learning-library.js';

export function createLearningRuntime({repository,library,queue,sources,bot,owner,now=Date.now,uuid=()=>crypto.randomUUID()}){
  let running;
  const wisdom=createWisdomService({repository,library,bot,owner,now,uuid});
  const currentOwner=async()=>{const id=String(await owner()||'');if(!/^\d+$/.test(id))throw Error('无法核实当前 X 账号');return id;};
  const assertOwner=async id=>{if(await currentOwner()!==id)throw Error('X 账号已变化，本轮已暂停');};
  const settings=async id=>await repository.settings(id)||defaultLearningSettings(id);
  async function state(){
    const id=await currentOwner(),config=await settings(id),runs=(await repository.runs(id)).sort((a,b)=>b.at-a.at);
    const day=new Date(now()+8*3600000).toISOString().slice(0,10);
    const [dailyPage,weeklyPage]=await Promise.all([repository.historyPage(id,{scope:'daily'}),repository.historyPage(id,{scope:'weekly'})]);
    return {config,daily:dailyPage.items[0]||null,weekly:weeklyPage.items[0]||null,budgetUsed:[...runs,...await repository.drafts(id)].filter(r=>r.day===day&&r.dispatched).length,runs:runs.slice(0,10),uses:await repository.uses(id),botReady:(await bot.status(config.generationProvider||'grok-local')).enabled};
  }
  async function save(value){
    const id=await currentOwner(),old=await settings(id),next=validateLearningSettings(value,id);
    const needsBinding = next.enabled && !old.enabled || next.weeklyEnabled && !old.weeklyEnabled || (next.bot !== old.bot || next.generationProvider !== (old.generationProvider||'grok-local')) && Boolean(next.bot);
    if(needsBinding){const status=await bot.status(next.generationProvider||'grok-local',next.bot);if(!status.enabled||!next.bot||status.bot!==next.bot)throw Error('请先在系统设置连接并测试所选本地 Bot');next.botName=status.botName||next.bot;}
    await assertOwner(id);
    await repository.saveSettings({...next,nextAt:old.hour===next.hour&&old.nextAt?old.nextAt:nextLearningTime(now(),next.hour),nextMergeAt:old.weeklyEnabled&&old.weeklyDay===next.weeklyDay&&old.weeklyHour===next.weeklyHour&&old.nextMergeAt?old.nextMergeAt:nextWeeklyTime(now(),next.weeklyDay,next.weeklyHour)});
    return state();
  }
  async function prepare(id,config,manual){
    const runs=await repository.runs(id),pending=runs.find(r=>['prepared','submitted','result_saved','failed'].includes(r.status));
    if(pending)return pending;
    const today=new Date(now()+8*3600000).toISOString().slice(0,10);
    if([...runs,...await repository.drafts(id)].filter(r=>r.day===today&&r.dispatched).length>=config.dailyBudget){
      if(manual)throw Error('今日整理预算已用完，明日继续');
      const nextAt=nextLearningTime(now(),config.hour);await repository.saveSettings({...config,nextAt,nextMergeAt:Math.max(config.nextMergeAt,nextAt),lastMessage:'今日整理预算已用完，明日继续'});return null;
    }
    if(config.lastMessage)await repository.saveSettings({...config,lastMessage:''});
    const isMerge=manual==='merge';
    let run={id:uuid(),ownerId:id,kind:isMerge?'merge':'extract',at:now(),day:today,status:'prepared',bot:config.bot,provider:config.generationProvider||'grok-local'};
    if(isMerge){
      const rows=await library.listKnowledge(id);
      // Proposals are never fed back into summarization until reviewed.
      run.parents=rows.filter(r=>(r.status==='active'||r.status==='candidate'&&!r.mergeParents)).sort((a,b)=>a.updatedAt-b.updatedAt).slice(0,12);
      if(run.parents.length<2){await repository.saveSettings({...config,nextMergeAt:now()+7*DAY});return null;}
    }else{
      const available=await sources(id),samples=[];
      for(const sample of available){
        const seen=await repository.seen(id,sample.key);
        if(seen&&(seen.hash===sample.hash||now()-seen.at<7*DAY))continue;
        if(samples.length&&(sample.kind!==samples[0].kind||sample.purpose!==samples[0].purpose))continue;
        samples.push(sample);if(samples.length===6)break;
      }
      if(!samples.length){await repository.saveRun({...run,status:'skipped',finishedAt:now(),result:{knowledgeCreated:0,knowledgeReused:0,note:'没有新增可总结材料'}});await repository.saveSettings({...config,nextAt:nextLearningTime(now(),config.hour)});return null;}
      run={...run,samples,purpose:samples[0].purpose};
      const enqueued=await queue.enqueueAnalysis({ownerId:id,clientRequestId:run.id,producer:'scheduled-experience',sourceRefs:samples,analysisSpec:{version:'1',kind:'experience',channel:run.provider}});
      run.libraryJobId=enqueued.jobId;
      const job=await library.getJob(id,enqueued.jobId);
      await library.putJob({...job,inputManifest:{...job.inputManifest,frozen:true}});
    }
    run.prompt=buildExperiencePrompt(run);
    if(run.prompt.length>7800)throw Error('本轮材料超过本地 Bot 输入限制，请缩小样本');
    await repository.saveRun(run);return run;
  }
  async function execute(manual){
    const id=await currentOwner(),config=await settings(id);
    if(!config.enabled&&!manual)return;
    const existing=(await repository.runs(id)).find(r=>['prepared','submitted','result_saved','failed'].includes(r.status));
    if(!manual&&!existing&&config.nextAt>now())return;
    if(!existing?.relayJobId&&!existing?.raw){const info=await bot.status(existing?.provider||config.generationProvider||'grok-local',existing?.bot||config.bot);if(!(existing?.bot||config.bot)||!info.enabled||info.bot!==(existing?.bot||config.bot))throw Error('固定 Bot 尚未连接，或系统设置中的 Bot 已变化');}
    let run=await prepare(id,config,manual);if(!run)return {empty:true};
    if(run.status==='failed'&&!manual)return {blocked:true};
    if(run.status==='failed')throw Error(run.error||'上次整理结果无效，请先终止该任务');
    try{
      if(!run.raw){
        // Once dispatched, only query the persisted task. An absent receipt blocks replay.
        if(run.dispatched&&!run.relayJobId)throw Error('发送状态待确认，保留现场，请检查 Bot 后终止任务');
        let result;
        if(run.relayJobId)result=await bot.resume(run.relayJobId);
        else{
          const day=new Date(now()+8*3600000).toISOString().slice(0,10);
          if([...(await repository.runs(id)),...await repository.drafts(id)].filter(r=>r.day===day&&r.dispatched).length>=config.dailyBudget)throw Error('今日整理预算已用完，明日继续');
          run=await repository.claimDispatch('runs',{...run,day,dispatched:true,status:'submitted'},config.dailyBudget);
          result=await bot.generate(run.prompt,{requestKey:'knowledge:'+run.id,expectedBot:run.bot,botId:run.bot,provider:run.provider||'grok-local',onJobCreated:async job=>{run={...run,relayJobId:job.id};await repository.saveRun(run);}});
        }
        await assertOwner(id);
        if(!result?.ok){run={...run,status:'submitted',error:result?.reason||'等待原任务回复'};await repository.saveRun(run);return {pending:true};}
        run={...run,raw:result.text,status:'result_saved',error:''};await repository.saveRun(run);
      }
      const parsed=parseExperienceResult(run.raw,run);
      await assertOwner(id);
      let result;
      if(run.kind==='extract'){
        result=await queue.ingestAnalysisResult({ownerId:id,jobId:run.libraryJobId,producer:'scheduled-experience',inputEvidenceList:run.samples,candidates:parsed});
        const provenance=[];
        for(const candidate of parsed){
          const knowledge=await library.findKnowledgeByFingerprint(id,computeKnowledgeFingerprint(candidate.type,candidate.statement,candidate.scope));
          if(!knowledge)throw Error('经验尚未入库，未登记来源');
          for(const postId of candidate.evidencePostIds){const sample=run.samples.find(s=>s.postId===postId);provenance.push({ownerId:id,knowledgeId:knowledge.id,key:run.id+':'+sample.key,channel:({low:'low_analysis',high:'high_analysis',external:'leaderboard_analysis'})[sample.kind],postId,authorId:sample.authorId||'',handle:sample.handleAtCapture||'',url:sample.url||'',analysisId:run.id,capturedAt:sample.capturedAt,summarizedAt:now()});}
        }
        if(provenance.length)await repository.addSources(provenance);
      }
      else {for(let i=0;i<parsed.length;i++)await saveMergeProposal(library,run,parsed[i],i,now());result={proposals:parsed.length};}
      run={...run,status:'completed',finishedAt:now(),result};await repository.complete(run);
      const latest=await settings(id);
      await repository.saveSettings({...latest,...(run.kind==='merge'?{nextMergeAt:now()+7*DAY}:{nextAt:nextLearningTime(now(),latest.hour)})});
      return {ok:true,result};
    }catch(error){
      // Retain received bytes and the original job identifier for diagnosis and replay of ingestion.
      run={...run,status:run.raw?'failed':run.status,error:String(error.message||error)};await repository.saveRun(run);throw error;
    }
  }
  async function weekly(id,config){
    const next=async()=>{const latest=await settings(id);await repository.saveSettings({...latest,nextMergeAt:nextWeeklyTime(now(),latest.weeklyDay,latest.weeklyHour)});};
    let draft=(await repository.drafts(id)).find(d=>['prepared','submitted','result_saved','ready'].includes(d.status));
    if(draft&&draft.trigger!=='weekly'){
      await repository.saveDraft({id:uuid(),ownerId:id,trigger:'weekly',status:'skipped',at:now(),error:'有待处理的手动合入，本周未覆盖',selected:[]});await next();return {blocked:true};
    }
    try{
      if(draft?.requiresReview){await next();return {blocked:true};}
      if(draft){const result=await wisdom.handle({action:'wisdomQuery',id:draft.id});draft=result.draft;}
      else{
        const head=await repository.wisdom(id),rows=(await library.listKnowledge(id)).filter(row=>['candidate','active'].includes(row.status)&&!head?.experiences.some(e=>e.id===row.id&&e.revision===row.revision));
        if(!rows.length){await repository.saveDraft({id:uuid(),ownerId:id,trigger:'weekly',status:'completed',at:now(),finishedAt:now(),selected:[],result:{merged:0,note:'没有待合入的新经验'}});await next();return {empty:true};}
        const result=await wisdom.handle({action:'wisdomPreview',ids:rows.slice(0,10).map(r=>r.id),baseVersion:head?.version||0,trigger:'weekly',remainingCount:Math.max(0,rows.length-10)});draft=result.draft;
      }
      await assertOwner(id);
      if(draft.status!=='ready')return {pending:true};
      if(draft.conflicts?.length){await repository.saveDraft({...draft,requiresReview:true,error:'存在冲突，等待人工确认'});await next();return {blocked:true};}
      const result=await wisdom.handle({action:'wisdomCommit',id:draft.id});
      if(draft.remainingCount){const latest=await settings(id);await repository.saveSettings({...latest,nextMergeAt:now()+15*60000});}else await next();
      return {ok:true,version:result.head.version};
    }catch(error){
      const latest=(await repository.drafts(id)).find(d=>d.trigger==='weekly'&&['prepared','submitted','result_saved','ready'].includes(d.status));
      if(latest){await repository.saveDraft({...latest,error:error.message,...(latest.status==='ready'?{requiresReview:true}:{})});if(latest.status==='ready')await next();else if(latest.status==='prepared'&&!latest.dispatched){const saved=await settings(id);await repository.saveSettings({...saved,nextMergeAt:/预算/.test(error.message)?nextLearningTime(now(),saved.hour):nextWeeklyTime(now(),saved.weeklyDay,saved.weeklyHour)});}}
      else {await repository.saveDraft({id:uuid(),ownerId:id,trigger:'weekly',status:'failed',at:now(),selected:[],error:error.message});await next();}
      throw error;
    }
  }
  async function tick(manual){
    if(!manual&&repository.hasEnabledSettings&&!await repository.hasEnabledSettings())return;
    if(running)return {busy:true};
    running=(async()=>{const id=await currentOwner(),config=await settings(id);if(manual==='weekly')return weekly(id,config);if(!manual&&config.weeklyEnabled&&config.nextMergeAt<=now()){const failed=(await repository.runs(id)).some(r=>r.status==='failed');if(config.enabled&&config.nextAt<=now()&&!failed)return execute();return weekly(id,config);}return execute(manual);})();
    try{return await running;}finally{running=null;}
  }
  async function handle(message){
    if(message.action?.startsWith('wisdom'))return wisdom.handle(message);
    if(message.action==='history')return {ok:true,...await repository.historyPage(await currentOwner(),{page:message.page||1,pageSize:message.pageSize||10,scope:message.scope||'all'})};
    if(message.action==='weekly')return {ok:true,...await tick('weekly'),...await state()};
    if(message.action==='state')return {ok:true,...await state()};
    if(message.action==='save')return {ok:true,...await save(message.config)};
    if(message.action==='run'||message.action==='merge')return {ok:true,...await tick(message.action),...await state()};
    if(message.action==='approveMerge'){const id=await currentOwner();await approveMerge(library,{ownerId:id,id:message.id,revision:message.revision},now());return {ok:true};}
    if(message.action==='cancel'){
      if(running)throw Error('整理正在执行，请等待本次响应后再终止');
      const id=await currentOwner(),runs=await repository.runs(id),run=runs.find(r=>r.id===message.id);
      if(!run||run.status==='completed')throw Error('没有可终止的任务');
      await repository.saveRun({...run,status:'cancelled',finishedAt:now()});const config=await settings(id);await repository.saveSettings({...config,nextAt:nextLearningTime(now(),config.hour),nextMergeAt:run.kind==='merge'?now()+7*DAY:config.nextMergeAt});return {ok:true,...await state()};
    }
    throw Error('未知知识库操作');
  }
  return {tick,state,handle};
}
