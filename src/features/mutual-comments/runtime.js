import {isLocalAiProvider} from '../grok/grok-local.js';
import {defaults,timingConfig,randomDue,validateConfig,beijingDay,commentPrompt,parseComment} from './model.js';
import {composeQueueFollowBack} from '../grok/grok-comment.js';
import {appendQuoteTags,normalizeQuoteTags} from '../grok/quote-tags.js';
import {resolveCommentLanguage} from '../grok/quote-text.js';
import {isPostSafeForComment} from '../relationships/content-risk.js';
import {isPendingComment,commentPriority,compareCommentPriority,compareCommentList} from './priority.js';
import {findTagCache,findReplyCache} from './cache.js';
import {createTagRecovery,tagProgress,unfinishedTag,blockingAiResult,TAG_MAX_ATTEMPTS} from './tag-recovery.js';

export function createMutualCommentRuntime({store,owner,scan,analyze,publisher,knowledge,validateEngine=async()=>{},reportHealth=async()=>{},now=Date.now,random=Math.random,uuid=()=>crypto.randomUUID()}){
  const running={scan:false,comment:false};
  let preparingTags=false;
  async function current(){const account=await owner();if(!/^\d+$/.test(account?.accountId||'')||!account.handle)throw Error('无法核实当前 X 账号');return account;}
  async function guard(account,phase){const live=await current();if(live.accountId!==account.accountId||live.handle.toLowerCase()!==account.handle.toLowerCase())throw Error('账号已变化，本轮停止');const config=await store.config(account.accountId);if(!config?.[phase+'Enabled']&&!(phase==='scan'&&config?.manualTagRun?.status==='running'))throw Error('调度已暂停');}
  async function state(page=1,filter={}){
    const account=await current(),all=(await store.list(account.accountId)).sort((a,b)=>compareCommentList(a,b,filter.sortOrder)).map(row=>({...row,priority:commentPriority(row)}));
    const pageSize=[10,20,50,100].includes(Number(filter.pageSize))?Number(filter.pageSize):20,counts={},tags={};
    for(const row of all){counts[row.status]=(counts[row.status]||0)+1;tags[row.tag]=(tags[row.tag]||0)+1;}
    const query=String(filter.q||'').trim().toLowerCase();
    const rows=all.filter(row=>(!filter.status||filter.status==='all'||row.status===filter.status)&&(!filter.tag||filter.tag==='all'||row.tag===filter.tag)&&(!query||[row.handle,row.text,row.reply,row.tagReason].some(value=>String(value||'').toLowerCase().includes(query))));
    page=Math.min(Math.max(1,Math.floor(Number(page)||1)),Math.max(1,Math.ceil(rows.length/pageSize)));
    const config=await store.config(account.accountId);
    return {ok:true,account,tagProgress:tagProgress(all,config?.manualTagRun),untagged:all.filter(unfinishedTag).length,tagExhausted:all.filter(r=>unfinishedTag(r)&&r.tag!=='tagging'&&(r.tagAttempts||0)>=TAG_MAX_ATTEMPTS).length,config:timingConfig({ownerId:account.accountId,...await store.config(account.accountId)}),items:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,allTotal:all.length,counts,tags,page,pageSize,scans:await store.scans(account.accountId),batches:(await store.batches(account.accountId)).sort((a,b)=>b.at-a.at).slice(0,10).map(({prompt,raw,...summary})=>summary),running:{...running}};
  }
  async function reuseTags(account){
    const rows=await store.list(account.accountId);
    for(const row of rows.filter(r=>r.tag==='pending')){
      const source=findTagCache(row,rows,now());if(!source)continue;
      await guard(account,'scan');
      await store.updatePost({...row,tag:source.tag,tagReason:source.tagReason,taggedAt:source.taggedAt,tagBatchId:source.tagBatchId,
        tagCache:{sourcePostId:source.postId,matchedAt:now()},status:row.status==='idle'?(source.tag==='mutual'?'ready':'skipped'):row.status});
    }
  }
  const tagRecovery=createTagRecovery({store,analyze,validateEngine,guard,reuseTags,now,uuid});
  async function refreshHealth(id){
    const config=await store.config(id),rows=await store.list(id),batches=await store.batches(id);
    const exhausted=rows.filter(r=>unfinishedTag(r)&&r.tag!=='tagging'&&(r.tagAttempts||0)>=TAG_MAX_ATTEMPTS).length;
    const recoveredAt=Math.max(config?.commentConnectionCheckedAt||0,...rows.filter(r=>['draft','publishing','posted'].includes(r.status)&&(r.raw||r.reply)).map(r=>r.finishedAt||r.lastAttemptAt||0));
    const commentFailures=rows.filter(r=>['generating','failed'].includes(r.status)&&(r.lastAttemptAt||0)>=recoveredAt&&blockingAiResult({reason:r.error}));
    await reportHealth({ownerId:id,tagIssue:config?.tagServiceIssue?.reason||batches.find(b=>b.status==='waiting'&&(b.lastAttemptAt||b.at||0)>=(config?.scanConnectionCheckedAt||0)&&blockingAiResult({reason:b.error}))?.error||'',scanError:config?.scanError||'',commentIssue:config?.commentError||commentFailures[0]?.error||'',exhausted,commentCount:commentFailures.length});
  }
  async function scanWork(account,config){
    const id=account.accountId;
    for(const old of await store.scans(id))if(old.status==='scanning')await store.saveScan({...old,status:'interrupted',finishedAt:now(),error:'采集中断，已保存的帖子和锚点保留'});
    if(!await tagRecovery.ready(account,config))return {blocked:true};
    const backlog=(await store.list(id)).filter(unfinishedTag).length;
    const collectPaused=config.manualTagRun?.status==='running'||backlog>=Math.max(90,Math.min(30,config.batchSize)*3);
    await store.updateConfig(id,{collectionDeferred:collectPaused});
    if(config.scanEnabled&&!collectPaused&&config.nextScanAt<=now()){
      const run={id:uuid(),ownerId:id,at:now(),status:'scanning',received:0};
      await store.updateConfig(id,{nextScanAt:randomDue(now(),config.scanIntervalMinutes,config.scanIntervalMaxMinutes,random),scanError:''});await store.saveScan(run);
      const known=await store.list(id);
      const checkpoint=async data=>{await guard(account,'scan');const posts=data.posts.filter(p=>p.handle.toLowerCase()!==account.handle.toLowerCase()).map(p=>({...p,ownerId:id,scanId:run.id,createdAt:now(),tag:'pending',status:'idle'}));await store.checkpoint(id,posts,data.anchor,{...run,pages:data.pages,received:data.posts.length,added:posts.filter(p=>!known.some(old=>old.postId===p.postId)).length,duplicates:data.duplicates,anchor:data.anchor});};
      try{const result=await scan(account,config.scrollRounds,{anchor:config.anchor,knownIds:known.map(r=>r.postId),retiredPostId:config.retiredPostId,checkpoint,canContinue:()=>guard(account,'scan')});await checkpoint(result);await store.saveScan({...run,...result,posts:undefined,status:'completed',received:result.posts.length,added:result.posts.filter(p=>p.handle.toLowerCase()!==account.handle.toLowerCase()&&!known.some(old=>old.postId===p.postId)).length,finishedAt:now()});}
      catch(error){await store.saveScan({...run,status:'failed',finishedAt:now(),error:error.message});await store.updateConfig(id,{scanError:error.message});}
    }
    return tagRecovery.work(account,config);
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
    let row=rows.filter(r=>isPendingComment(r)&&(!r.retryAt||r.retryAt<=now())).sort(compareCommentPriority)[0];
    if(!row){await store.updateConfig(id,{commentRun:null});return {idle:true};}
    try{
      await guard(account,'comment');
      if(!isPostSafeForComment(row).safe)throw Error('原帖未通过内容检查');
      if(row.status!=='draft'){
        if(!row.prompt){let context=await knowledge({ownerId:id,purpose:'reply',requestId:'mutual-comment:'+id+':'+row.postId});let prompt=commentPrompt(row,context);if(prompt.length>7400){context={text:'',wisdomVersion:null,warning:'输入超过上限，本次未引用智慧'};prompt=commentPrompt(row,context);}row={...row,prompt,knowledge:context,provider:config.commentProvider,botId:config.commentBotId};}
        row={...row,decorationSettings:row.decorationSettings||{...normalizeQuoteTags(config),followBackSuffixEnabled:config.followBackSuffixEnabled===true},status:'generating',error:'',lastAttemptAt:now()};await store.updatePost(row);
        const cached=!row.relayJobId&&!row.raw?findReplyCache(row,rows,row.knowledge||{}, {commentProvider:row.provider,commentBotId:row.botId},now()):null;
        if(cached)row={...row,replyCache:{sourcePostId:cached.postId,matchedAt:now()}};
        const result=cached?{ok:true,text:'【评论开始】'+JSON.stringify({postId:row.postId,reply:cached.baseReply})+'【评论结束】'}:await analyze(row.prompt,{provider:row.provider,botId:isLocalAiProvider(row.provider)?row.botId:undefined,relayJobId:row.relayJobId,requestKey:'mutual-comment:'+id+':'+row.postId+(row.aiGenerationRetries?':retry:'+row.aiGenerationRetries:''),onJobCreated:async job=>{row={...row,relayJobId:job.id};await store.updatePost(row);}});
        if(!result?.ok){
          if((result?.generationUnknown||result?.errorCode==='JOB_NOT_FOUND')&&!row.publishAttemptedAt&&!row.raw&&!row.reply){
            const retries=row.aiGenerationRetries||0;
            if(retries<3){
              await store.updatePost({...row,status:'ready',relayJobId:null,aiGenerationRetries:retries+1,aiErrorRetries:0,retryAt:now()+60000,
                aiTaskHistory:[...(row.aiTaskHistory||[]),{jobId:row.relayJobId,at:now(),reason:result.reason}].slice(-4),error:'旧 AI 任务未完成，将重新生成（'+(retries+1)+'/3）'});
              return {retrying:true};
            }
          }
          const retries=(row.aiErrorRetries||0)+(blockingAiResult(result)?1:0);row={...row,aiErrorRetries:retries};if(result?.pending&&row.relayJobId&&retries<4){await store.updatePost({...row,retryAt:now()+300000,error:result.reason});return {pending:true};}throw Error(result?.reason||'评论生成失败');}
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
    if(running[phase]||phase==='scan'&&preparingTags)return {busy:true};running[phase]=true;let account;
    try{if(!await store.enabled(phase))return {disabled:true};account=await current();const config=timingConfig(await store.config(account.accountId));if(!config?.[phase+'Enabled']&&!(phase==='scan'&&config?.manualTagRun?.status==='running'))return {disabled:true};validateConfig(config,account.accountId);return await (phase==='scan'?scanWork:commentWork)(account,config);}
    catch(error){if(account)await store.updateConfig(account.accountId,{[phase+'Error']:error.message});return {ok:false,error:error.message};}finally{try{if(account){if(phase==='scan')await tagRecovery.settle(account.accountId);await refreshHealth(account.accountId);}}finally{running[phase]=false;}}
  }
  async function handle(message){
    if(message.action==='state')return state(message.page,message);
    const account=await current(),id=account.accountId;
    if(message.action==='retryConnection'){
      const {phase}=message;
      if(!['scan','comment'].includes(phase))throw Error('重试参数无效');
      if(message.ownerId!==id)throw Error('账号已变化，请刷新后重试');
      if(running[phase]||phase==='scan'&&preparingTags)throw Error('当前任务正在执行，请稍后重试');
      running[phase]=true;let recovered=false;
      try{
        const config=await store.config(id),checkedAt=now();
        if(!config?.[phase+'Provider']||config[phase+'Provider']==='grok')throw Error('请在设置中检查此引擎的连接');
        await validateEngine({generationProvider:config[phase+'Provider'],generationBotId:config[phase+'BotId']});
        const live=await current(),latest=await store.config(id);
        if(live.accountId!==id||live.handle.toLowerCase()!==account.handle.toLowerCase())throw Error('账号已变化，请刷新后重试');
        if(latest[phase+'Provider']!==config[phase+'Provider']||latest[phase+'BotId']!==config[phase+'BotId'])throw Error('AI 配置已变化，请重新重试');
        const patch={[phase+'ConnectionCheckedAt']:checkedAt};
        if(blockingAiResult({reason:latest[phase+'Error']}))patch[phase+'Error']='';
        if(phase==='scan'){
          patch.tagServiceIssue=null;
          for(const batch of await store.batches(id))if(batch.status==='waiting'&&blockingAiResult({reason:batch.error}))await store.saveBatch({...batch,retryAt:0});
        }else{
          for(const row of await store.list(id))if(row.status==='generating'&&row.relayJobId&&!row.publishAttemptedAt&&blockingAiResult({reason:row.error}))await store.updatePost({...row,retryAt:0});
        }
        await store.updateConfig(id,patch);await refreshHealth(id);recovered=true;
        return {ok:true,notice:'连接已恢复，已开启的调度将继续处理待办'};
      }finally{
        running[phase]=false;
        if(recovered)void tick(phase).catch(()=>{});
      }
    }
    if(message.action==='setSchedule'){
      const {phase,enabled}=message;
      if(!['scan','comment'].includes(phase)||typeof enabled!=='boolean')throw Error('调度开关参数无效');
      if(message.ownerId!==id)throw Error('账号已变化，请刷新后重试');
      const old=timingConfig(await store.config(id));
      if(enabled){
        // Validate this scheduler without making its switch depend on the other scheduler.
        validateConfig({...old,[phase+'Enabled']:true,[phase==='scan'?'commentEnabled':'scanEnabled']:false},id);
        await validateEngine({generationProvider:old[phase+'Provider'],generationBotId:old[phase+'BotId']});
        const live=await current();if(live.accountId!==id||live.handle.toLowerCase()!==account.handle.toLowerCase())throw Error('账号已变化，请刷新后重试');
      }
      const latest=await store.config(id)||{};
      if(enabled&&(latest[phase+'Provider']!==old[phase+'Provider']||latest[phase+'BotId']!==old[phase+'BotId']))throw Error('AI 配置已变化，请刷新后重试');
      const patch={[phase+'Enabled']:enabled};
      if(enabled&&!latest[phase+'Enabled'])patch[phase==='scan'?'nextScanAt':'nextCommentAt']=randomDue(now(),old[phase+'IntervalMinutes'],old[phase+'IntervalMaxMinutes'],random);
      if(!enabled&&phase==='comment')patch.commentRun=null;
      if(phase==='scan'){
        if(!enabled)patch.collectionDeferred=false;
        if(latest.manualTagRun&&['running','paused'].includes(latest.manualTagRun.status))patch.manualTagRun={...latest.manualTagRun,status:enabled?'running':'paused'};
        if(enabled&&latest.tagServiceIssue)patch.tagServiceIssue={...latest.tagServiceIssue,nextProbeAt:0};
      }
      await store.updateConfig(id,patch);
      if((await store.config(id))?.[phase+'Enabled']!==enabled)throw Error('调度状态保存失败，请重试');
      return {...await state(),notice:(phase==='scan'?'采集与打标':'首页跟评')+(enabled?'定时调度已开启':'定时调度已关闭')};
    }
    if(message.action==='batchTag'){
      if(running.scan||preparingTags)throw Error('当前批次正在执行，请稍后开始批量打标');
      preparingTags=true;let run;
      try{
        const config=await store.config(id);if(!config?.scanProvider)throw Error('请先保存采集与打标的 AI 引擎和会话');
        await validateEngine({generationProvider:config.scanProvider,generationBotId:config.scanBotId});
        const live=await current();if(live.accountId!==id||live.handle.toLowerCase()!==account.handle.toLowerCase())throw Error('账号已变化，请刷新');
        run=await store.startManual(id,uuid(),now());
        await store.updateConfig(id,{tagServiceIssue:null});
      }catch(error){
        if(error.blocking||blockingAiResult({reason:error.message})){
          await store.updateConfig(id,{tagServiceIssue:{reason:error.message,since:now(),nextProbeAt:now()+300000}});
          await refreshHealth(id);
        }
        throw error;
      }finally{preparingTags=false;}
      void tick('scan').catch(()=>{});
      return {ok:true,notice:run.total?'已安排全部 '+run.total+' 条未打标记录，每批最多 30 条顺序执行':'没有需要打标的记录'};
    }
    if(message.action==='pauseTag'){
      const config=await store.config(id);if(config?.manualTagRun)await store.updateConfig(id,{manualTagRun:{...config.manualTagRun,status:'paused'},scanEnabled:false,collectionDeferred:false});
      return {ok:true,notice:'批量打标和自动采集已暂停，已返回的 AI 结果会保留'};
    }
    if(message.action==='detail'){const row=await store.get(id,message.postId);if(!row)throw Error('记录不存在');const batch=row.tagBatchId?await store.getBatch(row.tagBatchId):null;return {ok:true,row,tagBatch:batch?.ownerId===id?batch:null};}
    if(message.action==='save'){
      if(message.config?.ownerId!==id)throw Error('账号已变化，请刷新设置');const old=await store.config(id)||{},next=validateConfig(message.config,id);
      for(const phase of ['scan','comment']){if(next[phase+'Enabled']&&(!old[phase+'Enabled']||old[phase+'Provider']!==next[phase+'Provider']||old[phase+'BotId']!==next[phase+'BotId']))await validateEngine({generationProvider:next[phase+'Provider'],generationBotId:next[phase+'BotId']});const key=phase==='scan'?'nextScanAt':'nextCommentAt';next[key]=next[phase+'Enabled']&&old[phase+'Enabled']&&old[phase+'IntervalMinutes']===next[phase+'IntervalMinutes']&&timingConfig(old)[phase+'IntervalMaxMinutes']===next[phase+'IntervalMaxMinutes']?old[key]:randomDue(now(),next[phase+'IntervalMinutes'],next[phase+'IntervalMaxMinutes'],random);}
      await store.saveConfig({...old,...next,...(!next.commentEnabled?{commentRun:null}:{}),...(!next.scanEnabled&&old.scanEnabled&&old.manualTagRun?{manualTagRun:{...old.manualTagRun,status:'paused'}}:{})});const saved=await store.config(id);if(Object.entries(next).some(([key,value])=>JSON.stringify(saved?.[key])!==JSON.stringify(value)))throw Error('配置持久化校验失败，请重试');return state();
    }
    if(['runScan','runComments'].includes(message.action)){const phase=message.action==='runScan'?'scan':'comment';if(!(await store.config(id))?.[phase+'Enabled'])throw Error('请先开启并保存对应调度');if(running[phase])return {ok:true,queued:true};await store.updateConfig(id,{[phase==='scan'?'nextScanAt':'nextCommentAt']:now()});void tick(phase).catch(()=>{});return {ok:true,queued:true,notice:phase==='scan'?'已安排采集与批量打标':'已安排处理已打标的互关帖'};}
    if(message.action==='verify'){
      if(running.comment)throw Error('正在评论，请稍后核实');const row=await store.get(id,message.postId);if(!row||row.status!=='uncertain'||!row.publishAttemptedAt)throw Error('没有可核实的发布记录');const proof=await publisher.verify({owner:account.handle,sourcePostUrl:row.url,text:row.reply,after:row.publishAttemptedAt});if(proof?.id)await store.updatePost({...row,status:'posted',publishedPostId:proof.id,publishedPostUrl:proof.url,error:'',finishedAt:now()});return {...await state(),notice:proof?.id?'已核实评论发布':'尚未找到发布证据，保留待核实记录'};
    }
    throw Error('未知首页跟评操作');
  }
  return {tick,handle,state,async refreshHealth(){const account=await current();await refreshHealth(account.accountId);}};
}
