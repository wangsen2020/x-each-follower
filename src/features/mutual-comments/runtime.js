import {isLocalAiProvider} from '../grok/grok-local.js';
import {defaults,timingConfig,randomDue,validateConfig,beijingDay,makeTagBatch,parseTags,commentPrompt,parseComment} from './model.js';
import {composeQueueFollowBack} from '../grok/grok-comment.js';
import {appendQuoteTags,normalizeQuoteTags} from '../grok/quote-tags.js';
import {resolveCommentLanguage} from '../grok/quote-text.js';
import {isPostSafeForComment} from '../relationships/content-risk.js';

export function createMutualCommentRuntime({store,owner,scan,analyze,publisher,knowledge,validateEngine=async()=>{},now=Date.now,random=Math.random,uuid=()=>crypto.randomUUID()}){
  const running={scan:false,comment:false};
  async function current(){const account=await owner();if(!/^\d+$/.test(account?.accountId||'')||!account.handle)throw Error('无法核实当前 X 账号');return account;}
  async function guard(account,phase){const live=await current();if(live.accountId!==account.accountId||live.handle.toLowerCase()!==account.handle.toLowerCase())throw Error('账号已变化，本轮停止');if(!(await store.config(account.accountId))?.[phase+'Enabled'])throw Error('调度已暂停');}
  async function state(page=1,filter={}){
    const account=await current(),all=(await store.list(account.accountId)).sort((a,b)=>b.createdAt-a.createdAt);
    const pageSize=[10,20,50,100].includes(Number(filter.pageSize))?Number(filter.pageSize):20,counts={},tags={};
    for(const row of all){counts[row.status]=(counts[row.status]||0)+1;tags[row.tag]=(tags[row.tag]||0)+1;}
    const query=String(filter.q||'').trim().toLowerCase();
    const rows=all.filter(row=>(!filter.status||filter.status==='all'||row.status===filter.status)&&(!filter.tag||filter.tag==='all'||row.tag===filter.tag)&&(!query||[row.handle,row.text,row.reply,row.tagReason].some(value=>String(value||'').toLowerCase().includes(query))));
    page=Math.min(Math.max(1,Math.floor(Number(page)||1)),Math.max(1,Math.ceil(rows.length/pageSize)));
    return {ok:true,account,config:timingConfig({ownerId:account.accountId,...await store.config(account.accountId)}),items:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,allTotal:all.length,counts,tags,page,pageSize,scans:await store.scans(account.accountId),batches:(await store.batches(account.accountId)).sort((a,b)=>b.at-a.at).slice(0,10).map(({prompt,raw,...summary})=>summary),running:{...running}};
  }
  async function scanWork(account,config){
    const id=account.accountId;
    for(const old of await store.scans(id))if(old.status==='scanning')await store.saveScan({...old,status:'interrupted',finishedAt:now(),error:'采集中断，已保存的帖子和锚点保留'});
    if(config.nextScanAt<=now()){
      const run={id:uuid(),ownerId:id,at:now(),status:'scanning',received:0};
      await store.updateConfig(id,{nextScanAt:randomDue(now(),config.scanIntervalMinutes,config.scanIntervalMaxMinutes,random),scanError:''});await store.saveScan(run);
      const known=await store.list(id);
      const checkpoint=async data=>{await guard(account,'scan');const posts=data.posts.filter(p=>p.handle.toLowerCase()!==account.handle.toLowerCase()).map(p=>({...p,ownerId:id,scanId:run.id,createdAt:now(),tag:'pending',status:'idle'}));await store.checkpoint(id,posts,data.anchor,{...run,pages:data.pages,received:data.posts.length,added:posts.length,duplicates:data.duplicates,anchor:data.anchor});};
      try{const result=await scan(account,config.scrollRounds,{anchor:config.anchor,knownIds:known.map(r=>r.postId),retiredPostId:config.retiredPostId,checkpoint,canContinue:()=>guard(account,'scan')});await checkpoint(result);await store.saveScan({...run,...result,posts:undefined,status:'completed',received:result.posts.length,added:result.posts.filter(p=>p.handle.toLowerCase()!==account.handle.toLowerCase()).length,finishedAt:now()});}
      catch(error){await store.saveScan({...run,status:'failed',finishedAt:now(),error:error.message});await store.updateConfig(id,{scanError:error.message});}
    }
    await guard(account,'scan');
    const batches=await store.batches(id);
    for(const batch of batches)if(batch.status==='sending'&&!batch.relayJobId&&!batch.raw)await store.failBatch(batch,'上次提交中断且无回执，未自动重发');
    let batch=batches.filter(b=>['prepared','waiting','raw_saved'].includes(b.status)&&(!b.retryAt||b.retryAt<=now())).sort((a,b)=>(a.lastAttemptAt||0)-(b.lastAttemptAt||0))[0];
    if(!batch){
      const pending=(await store.list(id)).filter(r=>r.tag==='pending').sort((a,b)=>b.createdAt-a.createdAt);
      if(!pending.length)return {idle:true};
      const batchId=uuid(),prepared=makeTagBatch(batchId,pending,config.batchSize);
      batch={id:batchId,ownerId:id,at:now(),status:'prepared',postIds:prepared.posts.map(p=>p.postId),prompt:prepared.prompt,provider:config.scanProvider,botId:config.scanBotId};
      await store.reserveBatch(batch);
    }
    try{
      if(!batch.raw){
        await guard(account,'scan');batch={...batch,status:'sending',lastAttemptAt:now()};await store.saveBatch(batch);
        const result=await analyze(batch.prompt,{provider:batch.provider,botId:isLocalAiProvider(batch.provider)?batch.botId:undefined,relayJobId:batch.relayJobId,requestKey:'mutual-tags:'+id+':'+batch.id,onJobCreated:async job=>{batch={...batch,relayJobId:job.id,status:'waiting'};await store.saveBatch(batch);}});
        if(!result?.ok){if(result?.pending&&batch.relayJobId){await store.saveBatch({...batch,status:'waiting',retryAt:now()+300000,error:result.reason});return {pending:true};}throw Error(result?.reason||'AI 未返回结果');}
        batch={...batch,raw:result.text,status:'raw_saved'};await store.saveBatch(batch);
      }
      await guard(account,'scan');const tags=parseTags(batch.raw,batch.id,batch.postIds);
      await store.finishBatch(batch,tags,now());return {ok:true,tagged:tags.length};
    }catch(error){if(batch.raw&&!(await store.config(id))?.scanEnabled)return {paused:true};await store.failBatch(batch,error.message);return {ok:false,error:error.message};}
  }
  async function commentWork(account,config){
    const id=account.accountId;let rows=await store.list(id);
    for(const row of rows)if(row.status==='publishing'||row.status==='generating'&&!row.relayJobId){row.status='uncertain';row.error='上次执行中断，保留结果待核实';await store.updatePost(row);}
    let run=config.commentRun;
    if(!run||run.remaining<=0){
      if(config.nextCommentAt>now())return {waiting:true};
      run={id:uuid(),remaining:config.perRun,at:now()};
      await store.updateConfig(id,{commentRun:run,nextCommentAt:randomDue(now(),config.commentIntervalMinutes,config.commentIntervalMaxMinutes,random),commentError:''});
    }
    const attempts=rows.filter(r=>r.publishAttemptedAt);
    if(attempts.filter(r=>r.commentRunId===run.id).length>=config.perRun){await store.updateConfig(id,{commentRun:null});return {limited:true};}
    if(attempts.filter(r=>beijingDay(r.publishAttemptedAt)===beijingDay(now())).length>=config.dailyLimit){await store.updateConfig(id,{commentRun:null});return {limited:true};}
    if((config.nextItemAt||0)>now()||attempts.some(r=>now()-r.publishAttemptedAt<60000))return {waiting:true};
    // This consumer never fetches or classifies posts. Only committed AI labels qualify.
    let row=rows.filter(r=>!r.decorationIssue&&r.tag==='mutual'&&r.taggedAt&&r.tagBatchId&&['ready','generating','draft'].includes(r.status)&&(!r.retryAt||r.retryAt<=now())).sort((a,b)=>(a.lastAttemptAt||0)-(b.lastAttemptAt||0)||b.createdAt-a.createdAt)[0];
    if(!row){await store.updateConfig(id,{commentRun:null});return {idle:true};}
    try{
      await guard(account,'comment');
      if(!isPostSafeForComment(row).safe)throw Error('原帖未通过内容检查');
      if(row.status!=='draft'){
        if(!row.prompt){let context=await knowledge({ownerId:id,purpose:'reply',requestId:'mutual-comment:'+id+':'+row.postId});let prompt=commentPrompt(row,context);if(prompt.length>7400){context={text:'',wisdomVersion:null,warning:'输入超过上限，本次未引用智慧'};prompt=commentPrompt(row,context);}row={...row,prompt,knowledge:context,provider:config.commentProvider,botId:config.commentBotId};}
        row={...row,decorationSettings:row.decorationSettings||{...normalizeQuoteTags(config),followBackSuffixEnabled:config.followBackSuffixEnabled===true},status:'generating',lastAttemptAt:now()};await store.updatePost(row);
        const result=await analyze(row.prompt,{provider:row.provider,botId:isLocalAiProvider(row.provider)?row.botId:undefined,relayJobId:row.relayJobId,requestKey:'mutual-comment:'+id+':'+row.postId,onJobCreated:async job=>{row={...row,relayJobId:job.id};await store.updatePost(row);}});
        if(!result?.ok){if(result?.pending&&row.relayJobId){await store.updatePost({...row,retryAt:now()+300000,error:result.reason});return {pending:true};}throw Error(result?.reason||'评论生成失败');}
        row={...row,raw:result.text};await store.updatePost(row);const reply=parseComment(result.text,row.postId);if(!isPostSafeForComment(reply).safe)throw Error('评论未通过内容检查');const language=resolveCommentLanguage(reply),ending=composeQueueFollowBack(reply,language,row.decorationSettings.followBackSuffixEnabled);
        if(ending.issue){await store.updatePost({...row,baseReply:reply,reply,status:'draft',decorationIssue:ending.issue,error:ending.issue});return {blocked:true};}
        const decorated=appendQuoteTags(ending.text,row.decorationSettings,language,{random});row={...row,baseReply:reply,language,reply:decorated,status:'draft',error:''};await store.updatePost(row);
      }
      await guard(account,'comment');if(!await store.get(id,row.postId))return {expired:true};
      row={...row,status:'publishing',publishAttemptedAt:now(),commentRunId:run.id};await store.updatePost(row);
      await store.updateConfig(id,{commentRun:{...run,remaining:run.remaining-1},nextItemAt:randomDue(now(),1,3,random)});
      const result=await publisher.publish({owner:account.handle,sourcePostUrl:row.url,text:row.reply,canPublish:async()=>{await guard(account,'comment');return Boolean(await store.get(id,row.postId));}});
      const posted=result?.ok&&result.status==='posted'&&/^\d+$/.test(result.publishedPostId||'');
      await store.updatePost({...row,status:posted?'posted':result?.attempted===false?'failed':'uncertain',error:posted?'':result?.reason||'发布结果待核实',publishedPostId:posted?result.publishedPostId:null,publishedPostUrl:posted?result.publishedPostUrl:null,finishedAt:now()});return {ok:posted};
    }catch(error){await store.updatePost({...row,status:row.status==='publishing'?'uncertain':row.status==='draft'?'draft':'failed',error:error.message});return {ok:false,error:error.message};}
  }
  async function tick(phase){
    if(!['scan','comment'].includes(phase))throw Error('请指定采集或评论调度');
    if(running[phase])return {busy:true};if(!await store.enabled(phase))return {disabled:true};running[phase]=true;let account;
    try{account=await current();const config=timingConfig(await store.config(account.accountId));if(!config?.[phase+'Enabled'])return {disabled:true};validateConfig(config,account.accountId);return await (phase==='scan'?scanWork:commentWork)(account,config);}
    catch(error){if(account)await store.updateConfig(account.accountId,{[phase+'Error']:error.message});return {ok:false,error:error.message};}finally{running[phase]=false;}
  }
  async function handle(message){
    if(message.action==='state')return state(message.page,message);
    const account=await current(),id=account.accountId;
    if(message.action==='detail'){const row=await store.get(id,message.postId);if(!row)throw Error('记录不存在');const batch=row.tagBatchId?await store.getBatch(row.tagBatchId):null;return {ok:true,row,tagBatch:batch?.ownerId===id?batch:null};}
    if(message.action==='save'){
      if(message.config?.ownerId!==id)throw Error('账号已变化，请刷新设置');const old=await store.config(id)||{},next=validateConfig(message.config,id);
      for(const phase of ['scan','comment']){if(next[phase+'Enabled']&&(!old[phase+'Enabled']||old[phase+'Provider']!==next[phase+'Provider']||old[phase+'BotId']!==next[phase+'BotId']))await validateEngine({generationProvider:next[phase+'Provider'],generationBotId:next[phase+'BotId']});const key=phase==='scan'?'nextScanAt':'nextCommentAt';next[key]=next[phase+'Enabled']&&old[phase+'Enabled']&&old[phase+'IntervalMinutes']===next[phase+'IntervalMinutes']&&timingConfig(old)[phase+'IntervalMaxMinutes']===next[phase+'IntervalMaxMinutes']?old[key]:randomDue(now(),next[phase+'IntervalMinutes'],next[phase+'IntervalMaxMinutes'],random);}
      await store.saveConfig({...old,...next,...(!next.commentEnabled?{commentRun:null}:{})});const saved=await store.config(id);if(Object.entries(next).some(([key,value])=>JSON.stringify(saved?.[key])!==JSON.stringify(value)))throw Error('配置持久化校验失败，请重试');return state();
    }
    if(['runScan','runComments'].includes(message.action)){const phase=message.action==='runScan'?'scan':'comment';if(!(await store.config(id))?.[phase+'Enabled'])throw Error('请先开启并保存对应调度');if(running[phase])return {ok:true,queued:true};await store.updateConfig(id,{[phase==='scan'?'nextScanAt':'nextCommentAt']:now()});void tick(phase).catch(()=>{});return {ok:true,queued:true,notice:phase==='scan'?'已安排采集与批量打标':'已安排处理已打标的互关帖'};}
    if(message.action==='verify'){
      if(running.comment)throw Error('正在评论，请稍后核实');const row=await store.get(id,message.postId);if(!row||row.status!=='uncertain'||!row.publishAttemptedAt)throw Error('没有可核实的发布记录');const proof=await publisher.verify({owner:account.handle,sourcePostUrl:row.url,text:row.reply,after:row.publishAttemptedAt});if(proof?.id)await store.updatePost({...row,status:'posted',publishedPostId:proof.id,publishedPostUrl:proof.url,error:'',finishedAt:now()});return {...await state(),notice:proof?.id?'已核实评论发布':'尚未找到发布证据，保留待核实记录'};
    }
    throw Error('未知互粉评论操作');
  }
  return {tick,handle,state};
}
