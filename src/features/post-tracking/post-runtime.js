import {normalizeLowRules,validateLowRules} from './post-rules.js';
import {analyticsRange, parseOwnAnalytics, mergePost, selectPostPage} from './post-model.js';
import {planBatch,batchVariables,finishBatch,monitorInterval,batchLimit,reviewInterval,MIN_BATCH_DELAY} from './post-scanner.js';
import {createPostLearning} from './post-learning.js';
import {createPostStore} from './post-store.js';
import {networkFetchOwnPostAnalytics, networkDeleteOwnPost, networkFetch} from '../relationships/network-api.js';
import {createFollowQueueStore} from '../follow-queue/follow-queue-store.js';

export const POST_ALARM='xef-own-post-monitor';
export const POST_CONFIG='ownPostTracking';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(v=>v.toString(16).padStart(2,'0')).join('');

export function createPostRuntime({api=chrome, store=createPostStore(), fetchAnalytics=networkFetchOwnPostAnalytics, deletePost=networkDeleteOwnPost, fetchDetail=networkFetch, sleep=wait, now=()=>Date.now(), publishedSources, askGrok}={}) {
  let task=null, publishedStore;
  const learning=createPostLearning({api,store,ask:askGrok,now});
  const config=async()=> (await api.storage.local.get(POST_CONFIG))[POST_CONFIG] || {};
  const readPublished=publishedSources || (async ownerId=>{
    const {followQueueBinding}=await api.storage.local.get('followQueueBinding');
    if(followQueueBinding?.accountId!==ownerId)return new Map();
    const jobs=await (publishedStore ||= createFollowQueueStore()).list({accountId:ownerId});const result=new Map();
    for(const job of jobs)for(const ev of job.evaluations || [])if(ev.status==='posted'&&ev.publishedPostId)result.set(ev.publishedPostId,{kind:'auto-quote',originalPostId:ev.originalPostId,originalPostUrl:/^\d+$/.test(ev.originalPostId||'')?`https://x.com/i/status/${ev.originalPostId}`:null,originalPostText:ev.originalPostText});
    return result;
  });
  async function exclusive(fn) {
    if (task) throw new Error('帖子任务正在执行，请稍后重试');
    task=Promise.resolve().then(fn);try{return await task;}finally{task=null;}
  }
  async function withPage(url,op,fn,{cached=false,reuse=false}={}) {
    let tab;
    if(reuse&&cached&&api.tabs.query){const candidates=await api.tabs.query({url:['https://x.com/*']});tab=candidates.filter(t=>t.status==='complete'&&/^https:\/\/x\.com\//.test(t.url||'')).sort((a,b)=>Number(new URL(b.url).pathname==='/home')-Number(new URL(a.url).pathname==='/home')||Number(a.active)-Number(b.active))[0];}
    const owned=!tab;
    if(!tab)tab=await api.tabs.create({url,active:false});
    try {
      const started=now();let ready=false;
      for(let attempt=0;attempt<50;attempt++) {
        const {networkTemplates={}}=await api.storage.local.get('networkTemplates');
        const loaded=!cached||!api.tabs.get||(await api.tabs.get(tab.id)).status==='complete';
        if(loaded && (cached||networkTemplates[op]?.at >= started-1000) && networkTemplates[op]?.headers?.['x-csrf-token']){ready=true;break;}
        await sleep(500);
      }
      if(!ready)throw new Error('未取得当前 X 分析请求，请检查登录、订阅权限或网络后重试');
      return await fn(tab.id);
    } finally {if(owned)await api.tabs.remove(tab.id).catch(()=>{});}
  }
  async function bootstrapRead(variables){
    const id=crypto.randomUUID();
    const url=new URL('https://x.com/i/account_analytics/content?type=all&sort=date&dir=desc&days=14');
    for(const [key,value] of Object.entries({xef_post_bootstrap:id,xef_limit:variables.max_results,xef_from:Date.parse(variables.from_time),xef_to:Date.parse(variables.to_time)}))url.searchParams.set(key,String(value));
    const tab=await api.tabs.create({url:url.href,active:false});
    try{for(let n=0;n<60;n++){
      const {postAnalyticsBootstrap:value}=await api.storage.local.get('postAnalyticsBootstrap');
      if(value?.id===id&&value.tabId===tab.id&&value.json){
        const status=value.status||200;
        if(status!==200||value.json?.errors?.some(e=>e.code===88)){const error=new Error(`首次分析失败 HTTP ${status===200?429:status}，请检查登录、权限或限流状态`);error.status=status===200?429:status;error.retryAfterSeconds=value.retryAfterSeconds;throw error;}
        return parseOwnAnalytics(value.json,now());
      }
      await sleep(500);
    }throw new Error('首次分析未完成，请检查 X 登录与账号分析访问权限，再点击立即更新');}
    finally{const {postAnalyticsBootstrap:value}=await api.storage.local.get('postAnalyticsBootstrap');if(value?.id===id)await api.storage.local.set({postAnalyticsBootstrap:null});await api.tabs.remove(tab.id).catch(()=>{});}
  }
  async function read(tabId,variables) {
    const result=await fetchAnalytics(tabId,variables);
    if(result.status !== 200 || result.error) {
      const error=new Error(result.error || `分析请求失败 HTTP ${result.status}`);error.status=result.status;error.retryAfterSeconds=result.retryAfterSeconds;throw error;
    }
    return parseOwnAnalytics(result.json,now());
  }
  async function sync({days,background=false,history=false}={}) {
    return exclusive(async()=> {
      const cfg=await config(),started=now();
      if(history&&background)throw new Error('历史补齐仅支持手动执行');
      if(history){const {networkTemplates={}}=await api.storage.local.get('networkTemplates');if(!cfg.ownerId||!networkTemplates.contentPageQuery)throw new Error('请先立即更新一次，识别当前账号后再补齐历史');}
      if(background&&(!cfg.enabled||!cfg.ownerId))return {skipped:true};
      const blockedUntil=Math.max(cfg.retryAfter||0,background?cfg.nextBatchAt||0:cfg.lastAttemptAt?cfg.lastAttemptAt+MIN_BATCH_DELAY:0);
      if(blockedUntil>started){await schedule();if(background)return {skipped:true,nextBatchAt:blockedUntil};throw new Error(`下批检测时间：${new Date(blockedUntil).toLocaleString('zh-CN')}`);}
      const expected=cfg.ownerId;
      const selected=history?90:[7,14,28,90].includes(Number(days??cfg.days))?Number(days??cfg.days):14;
      // Persist the guard before opening a tab, including across service-worker restarts.
      const guarded={...cfg,lastAttemptAt:started,nextBatchAt:started+MIN_BATCH_DELAY};
      await api.storage.local.set({[POST_CONFIG]:guarded});
      await schedule();
      try {
        const {networkTemplates={}}=await api.storage.local.get('networkTemplates');
        const previous=expected?await store.list(expected):[];
        const oldMeta=expected?await store.meta(expected):null;
        const plan=history?{window:{from:started-90*86400000,to:started},limit:1000}:planBatch(oldMeta?.scanner,previous,selected,started,cfg);
        const commit=async result=>{
          if(expected&&result.owner.id!==expected){
            // The API viewer is the logged-in account. Never apply another
            // account's time cursor or pending deletion authorization to it.
            await api.storage.local.set({[POST_CONFIG]:{...guarded,ownerId:result.owner.id,owner:result.owner,bindingNonce:crypto.randomUUID(),lastError:'',retryAfter:0,failures:0,nextBatchAt:now()+MIN_BATCH_DELAY}});
            await schedule();
            return {owner:result.owner,received:0,accountUpdated:true};
          }
          // A pending old-account cursor must never become a new account's scan.
          const scanner=history?oldMeta?.scanner:finishBatch(plan,result.coverage.received,now());
          const split=history?false:scanner.last.split;
          if(!split){
            const sources=await readPublished(result.owner.id);
            // Grok finishes outside the scan lock. Merge against the latest row
            // in one transaction so a network wait cannot erase a new review.
            for(const p of result.posts)await store.update(result.owner.id,p.postId,current=>mergePost(current,{...p,...(sources.has(p.postId)?{source:sources.get(p.postId)}:{})}));
            for(const id of result.unavailableIds)await store.update(result.owner.id,id,current=>current?{...current,availability:'unavailable'}:null);
          }
          const historyComplete=history&&result.coverage.received<plan.limit;
          const meta={...oldMeta,ownerId:result.owner.id,owner:result.owner,updatedAt:now(),scanner,coverage:{...result.coverage,days:selected,batch:!history,split},...(history?{historyImport:{...plan.window,at:now(),received:result.coverage.received,complete:historyComplete}}:{}),error:''};
          await store.setMeta(meta);
          await api.storage.local.set({[POST_CONFIG]:{...guarded,bindingNonce:cfg.bindingNonce||crypto.randomUUID(),ownerId:result.owner.id,owner:result.owner,days:selected,enabled:cfg.enabled!==false,intervalMinutes:monitorInterval(cfg.intervalMinutes),lastError:'',retryAfter:0,failures:0,nextBatchAt:now()+monitorInterval(cfg.intervalMinutes)*60000}});
          await schedule();
          return {owner:result.owner,received:split?0:result.posts.length,split,...(history?{historyComplete}:{}),coverage:meta.coverage};
        };
        const variables=batchVariables(plan.window,plan.limit);
        if(!networkTemplates.contentPageQuery)return await commit(await bootstrapRead(variables));
        return await withPage('https://x.com/home','contentPageQuery',async tabId=>commit(await read(tabId,variables)),{cached:true});
      }catch(error){
        if(cfg.ownerId)await store.setMeta({...await store.meta(cfg.ownerId),ownerId:cfg.ownerId,error:error.message});
        const failures=(cfg.failures||0)+1;
        const delay=Math.max(Math.min(6*3600000,15*60000*2**Math.min(failures-1,5)),[401,403,429].includes(error.status)?3600000:0,(error.retryAfterSeconds||0)*1000);
        await api.storage.local.set({[POST_CONFIG]:{...guarded,failures,lastError:error.message,retryAfter:now()+delay,nextBatchAt:now()+delay}});
        await schedule();throw error;
      }
    });
  }
  async function schedule() {
    const cfg=await config();
    if(!cfg.enabled||!cfg.ownerId){await api.alarms.clear(POST_ALARM);return;}
    if(!cfg.nextBatchAt){cfg.nextBatchAt=now()+monitorInterval(cfg.intervalMinutes)*60000;await api.storage.local.set({[POST_CONFIG]:cfg});}
    const when=Math.max(now()+1000,cfg.nextBatchAt,cfg.retryAfter||0);
    await api.alarms.create(POST_ALARM,{when});
  }
  async function page(options={}) {
    const cfg=await config();
    if(!cfg.ownerId)return {rows:[],counts:{latest:0,low:0,high:0},total:0,page:1,pages:1,monitored:0,selectedPostIds:[],config:cfg,meta:{error:cfg.lastError||''}};
    const posts=await store.list(cfg.ownerId);
    const requested=Array.isArray(options.selectedPostIds)?options.selectedPostIds:[];
    const selectedPostIds=posts.filter(post=>requested.includes(post.postId)&&post.text&&!post.protected&&(!post.deletion||post.deletion.status==='failed')).map(post=>post.postId);
    return {...selectPostPage(posts,options,now(),cfg.lowRules),selectedPostIds,config:cfg,meta:await store.meta(cfg.ownerId),learning:await learning.state(cfg.ownerId)};
  }
  async function getPost(postId) {
    const cfg=await config();if(!cfg.ownerId)throw new Error('请先同步帖子');
    const post=await store.get(cfg.ownerId,postId);if(!post)throw new Error('帖子不存在');return post;
  }
  async function mark({postId,protected:protect,retained,score,reason,valuableDiscussion,expectedText}) {
    return exclusive(async()=>{
      const post=await getPost(postId);
      if(expectedText!=null&&expectedText!==post.text)throw new Error('正文已变更，请重新打开帖子再审核');
      if(post.deletion&&post.deletion.status!=='failed')throw new Error('删除中的帖子不能修改审核结论');
      if(typeof protect==='boolean')post.protected=protect;
      if(typeof retained==='boolean')post.retained=retained;
      if(score!=null) {
        if(!Number.isInteger(score)||score<0||score>10||!String(reason||'').trim())throw new Error('请填写0–10分和具体审核依据');
        post.review={score,reason:String(reason).slice(0,1000),valuableDiscussion:valuableDiscussion===true,at:now(),source:'manual'};
      }
      await store.put(post);return {ok:true};
    });
  }
  async function prepareDelete({postId}) {
    return exclusive(async()=>{
      const post=await getPost(postId);
      if(post.protected||post.deletion&&post.deletion.status!=='failed')throw new Error('帖子受保护或已有删除任务');
      const intent={id:crypto.randomUUID(),ownerId:post.ownerId,bindingNonce:(await config()).bindingNonce,postId,textHash:await hash(post.text),text:post.text,url:post.url,createdAt:now(),expiresAt:now()+120000,status:'prepared'};
      await store.putIntent(intent);return {approvalId:intent.id,postId,text:intent.text,url:intent.url,owner: (await config()).owner,expiresAt:intent.expiresAt};
    });
  }
  async function confirmDelete(request) { return exclusive(()=>deleteConfirmed(request)); }
  async function deleteConfirmed({approvalId,confirmed},reuseTabId) {
    const operationStarted=now();
    if(confirmed!==true)throw new Error('删除前必须由用户确认具体帖子');
    {
      const intent=await store.intent(approvalId);const cfg=await config();
      if(!intent||!/^\d+$/.test(intent.postId||'')||intent.status!=='prepared'||intent.expiresAt<now()||intent.ownerId!==cfg.ownerId||intent.bindingNonce!==cfg.bindingNonce)throw new Error('删除确认已过期、已使用或账号已切换');
      const post=await getPost(intent.postId);
      if(post.protected||post.deletion&&post.deletion.status!=='failed'||await hash(post.text)!==intent.textHash)throw new Error('帖子已变更或受保护，请重新审核');
      // Use a loaded X execution page and the captured request shape. Fresh
      // account/text checks come from read(), not a new native analytics event.
      const execute=async tabId=>{
        const pageReadyAt=now();
        const range=analyticsRange(1,post.createdAt);
        const fresh=await read(tabId,range);
        const current=fresh.posts.find(p=>p.postId===post.postId);
        if(fresh.owner.id!==intent.ownerId || !current || await hash(current.text)!==intent.textHash)throw new Error('实时账号或帖文核验不通过，未发送删除');
        if(intent.expiresAt<now())throw new Error('删除确认已过期，请重新确认');
        // Consume and persist BEFORE sending. A restart must never replay an uncertain write.
        intent.status='sending';intent.sentAt=now();await store.putIntent(intent);
        post.deletion={approvalId,status:'sending',at:now()};await store.put(post);
        const mutationStarted=now();let response;
        try{response=await deletePost(tabId,post.postId);}catch(error){response={status:0,error:error.message};}
        const mutationFinished=now();
        const serverAcknowledged=response.status===200&&!response.error&&!response.json?.errors?.length&&response.json?.data?.delete_tweet?.tweet_results!=null;
        post.deletion={...post.deletion,status:response.attempted===false?'failed':'uncertain',httpStatus:response.status,error:response.error||'',serverAcknowledged,acknowledgedPostId:serverAcknowledged?post.postId:null,at:now()};
        intent.status=post.deletion.status;await store.putIntent(intent);await store.put(post);
        // A successful HTTP response alone does not establish that the post disappeared.
        if(response.status===200&&!response.error&&!response.json?.errors?.length){
          // X may briefly serve the pre-delete detail after acknowledging the write.
          // Retry only the read, with a small bounded delay; never resend deletion.
          for(const delay of [0,2000,5000]){
            if(delay)await sleep(delay);
            let checked;try{checked=await verify(post,tabId);}catch{break;}
            if((await store.get(post.ownerId,post.postId)).deletion?.status==='verified'||checked?.httpStatus!==200)break;
          }
        }
        const timings={pageReadyMs:pageReadyAt-operationStarted,preflightMs:mutationStarted-pageReadyAt,mutationMs:mutationFinished-mutationStarted,verifyMs:now()-mutationFinished,totalMs:now()-operationStarted,...(response.timings?{transport:response.timings}:{})};
        await store.update(post.ownerId,post.postId,p=>({...p,deletion:{...p.deletion,timings}}));
        return {ok:true,deletion:(await store.get(post.ownerId,post.postId)).deletion};
      };
      return reuseTabId==null?withPage('https://x.com/home','contentPageQuery',execute,{cached:true,reuse:true}):execute(reuseTabId);
    }
  }
  async function prepareBatchDelete({postIds}) {
    return exclusive(async()=>{
      if(!Array.isArray(postIds)||!postIds.length||postIds.length>20||postIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id))||new Set(postIds).size!==postIds.length)throw new Error('请选择1至20条不同的帖子');
      const cfg=await config(),posts=[];
      for(const id of postIds){const post=await getPost(id);if(post.protected||post.deletion&&post.deletion.status!=='failed')throw new Error('所选帖子受保护或已有删除任务，请取消勾选后重试');posts.push(post);}
      const expiresAt=now()+600000,items=[];
      for(const post of posts){const intent={id:crypto.randomUUID(),ownerId:cfg.ownerId,bindingNonce:cfg.bindingNonce,postId:post.postId,textHash:await hash(post.text),text:post.text,url:post.url,createdAt:now(),expiresAt,status:'prepared'};await store.putIntent(intent);items.push({approvalId:intent.id,postId:post.postId,text:post.text,url:post.url});}
      const batch={id:crypto.randomUUID(),kind:'batch-delete',ownerId:cfg.ownerId,bindingNonce:cfg.bindingNonce,createdAt:now(),expiresAt,status:'prepared',items,results:[]};await store.putIntent(batch);
      return {ok:true,batchApprovalId:batch.id,owner:cfg.owner,items,expiresAt};
    });
  }
  async function confirmBatchDelete({batchApprovalId,confirmed}) {
    if(confirmed!==true)throw new Error('批量删除前必须由用户确认具体帖子');
    return exclusive(async()=>{
      const batch=await store.intent(batchApprovalId),cfg=await config();
      if(!batch||batch.kind!=='batch-delete'||batch.status!=='prepared'||batch.expiresAt<now()||batch.ownerId!==cfg.ownerId||batch.bindingNonce!==cfg.bindingNonce)throw new Error('批量删除确认已过期、已使用或账号已切换');
      // Recheck the entire approved set before sending the first mutation.
      for(const item of batch.items){const post=await getPost(item.postId),intent=await store.intent(item.approvalId);if(!intent||intent.status!=='prepared'||post.protected||post.deletion&&post.deletion.status!=='failed'||await hash(post.text)!==intent.textHash)throw new Error('所选帖子已变更或受保护，请重新确认');}
      batch.status='running';batch.startedAt=now();await store.putIntent(batch);
      const pageStarted=now();
      try{await withPage('https://x.com/home','contentPageQuery',async tabId=>{
        batch.pageReadyMs=now()-pageStarted;let lastStarted=null;
        for(const item of batch.items){
          if(lastStarted!==null){const delay=Math.max(0,3000-(now()-lastStarted));if(delay)await sleep(delay);}
          lastStarted=now();let result;
          try{const response=await deleteConfirmed({approvalId:item.approvalId,confirmed:true},tabId);result={postId:item.postId,status:response.deletion.status,error:response.deletion.error||'',timings:response.deletion.timings};}
          catch(error){const post=await store.get(batch.ownerId,item.postId);result={postId:item.postId,status:post?.deletion?.status||'not-sent',error:error.message};}
          batch.results.push(result);await store.putIntent(batch);
          if(result.status!=='verified')break;
        }
      },{cached:true,reuse:true});}catch(error){if(!batch.results.length)batch.results.push({postId:batch.items[0].postId,status:'not-sent',error:error.message});else batch.error=error.message;}
      batch.status=batch.results.length===batch.items.length&&batch.results.every(r=>r.status==='verified')?'completed':'stopped';batch.finishedAt=now();await store.putIntent(batch);
      return {ok:true,status:batch.status,results:batch.results,remaining:batch.items.length-batch.results.length};
    });
  }
  async function verify(post,reuseTabId) {
    const execute=async tabId=> {
      const response=await fetchDetail(tabId,'TweetDetail',{focalTweetId:post.postId});
      if(response.status!==200||response.error||response.json?.errors?.length)return {httpStatus:response.status,error:response.error};
      let present=false,deleted=false,focalEmpty=false;
      function walk(value,focal=false){if(!value||typeof value!=='object')return;if(value.rest_id===post.postId&&value.__typename==='Tweet')present=true;
        const belongs=focal || value.entryId===`tweet-${post.postId}` || value.rest_id===post.postId;
        // Current X returns an exact focal TimelineTweet with empty results after deletion.
        // This is proof only together with this ID's successful mutation receipt.
        const item=value.content?.itemContent;
        if(value.entryId===`tweet-${post.postId}`&&item?.__typename==='TimelineTweet'&&item.tweet_results&&Object.keys(item.tweet_results).length===0)focalEmpty=true;
        if(belongs && value.__typename==='TweetTombstone' && /this (post|tweet) was deleted|此(帖子|推文)已被删除|这条(帖子|推文)已(被)?删除/i.test(JSON.stringify(value)))deleted=true;
        for(const child of Object.values(value))walk(child,belongs);}
      walk(response.json);
      const acknowledgedEmpty=focalEmpty&&post.deletion?.serverAcknowledged===true&&post.deletion?.acknowledgedPostId===post.postId;
      if(!present&&(deleted||acknowledgedEmpty)){
        post.deletion={...post.deletion,status:'verified',verifiedAt:now(),verification:deleted?'explicit-tombstone':'acknowledged-focal-empty'};await store.put(post);
        const intent=await store.intent(post.deletion.approvalId);
        if(intent)await store.putIntent({...intent,status:'verified',verifiedAt:post.deletion.verifiedAt,verification:post.deletion.verification});
      }
      return {httpStatus:200};
    };
    const {networkTemplates={}}=await api.storage.local.get('networkTemplates');
    return reuseTabId!=null&&networkTemplates.TweetDetail?.headers?.['x-csrf-token']?execute(reuseTabId):withPage(post.url,'TweetDetail',execute,{cached:true});
  }
  async function handle(request) {
    switch(request.op) {
      case 'page':return page(request.options);
      case 'learn':return exclusive(async()=>{const cfg=await config();if(!cfg.ownerId||request.ownerId!==cfg.ownerId)throw new Error('当前账号已更新，请刷新后重试');return learning.start({ownerId:cfg.ownerId,kind:request.kind,postIds:request.postIds});});
      case 'saveMemory':return exclusive(async()=>{const cfg=await config();if(!cfg.ownerId||request.ownerId!==cfg.ownerId)throw new Error('当前账号已更新，请刷新后重试');return learning.save(cfg.ownerId,request);});
      case 'sync':return sync(request);
      case 'mark':return mark(request);
      case 'prepareDelete':return prepareDelete(request);
      case 'confirmDelete':return confirmDelete(request);
      case 'prepareBatchDelete':return prepareBatchDelete(request);
      case 'confirmBatchDelete':return confirmBatchDelete(request);
      case 'verify':return exclusive(async()=>{const p=await getPost(request.postId);if(!p.deletion)throw new Error('没有删除任务');await verify(p);return {ok:true};});
      case 'settings':return exclusive(async()=>{
        const cfg=await config();const enabled=request.enabled==null?cfg.enabled===true:request.enabled===true;
        const intervalMinutes=monitorInterval(request.intervalMinutes??cfg.intervalMinutes);
        const lowRules=request.lowRules===undefined?normalizeLowRules(cfg.lowRules):validateLowRules(request.lowRules);
        const days=[7,14,28,90].includes(Number(request.days))?Number(request.days):cfg.days||14;
        if(request.batchLimit!=null&&(!Number.isInteger(Number(request.batchLimit))||Number(request.batchLimit)<10||Number(request.batchLimit)>1000))throw new Error('每批上限需为10–1000的整数');
        if(request.reviewIntervalHours!=null&&![12,24,48].includes(Number(request.reviewIntervalHours)))throw new Error('复查周期需为12、24或48小时');
        await api.storage.local.set({[POST_CONFIG]:{...cfg,enabled,intervalMinutes,days,lowRules,batchLimit:batchLimit(request.batchLimit??cfg.batchLimit),reviewIntervalHours:reviewInterval(request.reviewIntervalHours??cfg.reviewIntervalHours),nextBatchAt:Math.max(cfg.nextBatchAt||0,now()+MIN_BATCH_DELAY)}});await schedule();return {ok:true};
      });
      default:throw new Error('未知帖子操作');
    }
  }
  return {handle,sync,schedule};
}
