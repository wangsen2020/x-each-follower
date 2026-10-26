import {createProfileTab,readProfileOnTab,assertProfileAvailable,profileUnavailableError} from '../../platform/x/profile-access.js';
import {createXNetworkClient} from '../../platform/x/network-client.js';
import {parsePublicProfile,parsePublicTimeline} from '../../platform/x/public-data.js';
import {shanghaiDay,previousDay,dayWindow,rankMembers,selectDigestPosts} from './leaderboard-model.js';
import {splitDigestBatches,buildDigestBatchPrompt,parseDigestBatch,buildDigestSummaryPrompt,parseDigestSummary} from './leaderboard-digest.js';
import {requestGrokText} from '../grok/grok-comment.js';
import {LEADERBOARD_CONFIG_KEY,normalizeLeaderboardConfig,validateLeaderboardConfig} from './leaderboard-config.js';

export const LEADERBOARD_ALARM='xef-leaderboard-scan';
const HOUR=3600000,MINUTE=60000;
const HANDLE_RE=/^[A-Za-z0-9_]{1,15}$/;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function createLeaderboardRuntime({api=globalThis.chrome,store,owner,client=createXNetworkClient(api),ask=requestGrokText,now=()=>Date.now()}={}){
  if(!store||typeof owner!=='function')throw new Error('榜单存储或账号解析未配置');
  let running=null;
  const membershipLookups=new Map();
  const membershipLookupTimes=[];
  const guard=async fn=>{if(running)throw new Error('榜单任务正在运行');running=Promise.resolve().then(fn);try{return await running}finally{running=null}};
  const currentOwner=async()=>{
    const identity=await owner();
    if(!/^\d+$/.test(String(identity?.accountId||'')))throw new Error('无法确认当前登录 X 账号');
    return identity;
  };
  const confirmOwner=async accountId=>{
    if((await currentOwner()).accountId!==accountId)throw new Error('X 登录账号已切换，已停止榜单写入');
  };
  const templates=async()=> (await api.storage.local.get('networkTemplates')).networkTemplates||{};
  const configFor=async accountId=>{
    const stored=(await api.storage.local.get(LEADERBOARD_CONFIG_KEY))[LEADERBOARD_CONFIG_KEY]||{};
    return normalizeLeaderboardConfig(stored[accountId]);
  };
  async function saveConfig(config){
    const {accountId}=await currentOwner();
    const checked=validateLeaderboardConfig(config);
    const stored=(await api.storage.local.get(LEADERBOARD_CONFIG_KEY))[LEADERBOARD_CONFIG_KEY]||{};
    await confirmOwner(accountId);
    await api.storage.local.set({[LEADERBOARD_CONFIG_KEY]:{...stored,[accountId]:checked}});
    await schedule({reset:true});
    return checked;
  }
  async function withPage(handle,operation,fn){
    await assertProfileAvailable(api,handle,'leaderboard:'+operation);
    const existing=(await api.tabs.query({url:['https://x.com/*','https://twitter.com/*']})).find(tab=>tab.status==='complete'&&/^https:\/\/x\.com\//.test(tab.url||''));
    const ready=(await templates())[operation];
    let tab=ready&&existing,owned=false;
    if(!tab){tab=await createProfileTab(api,{url:`https://x.com/${encodeURIComponent(handle)}${operation==='UserRepliesTimeline'?'/with_replies':''}`,active:false},'leaderboard');owned=true;}
    try{
      for(let i=0;i<30;i++){
        const current=await api.tabs.get(tab.id).catch(()=>null);
        const template=(await templates())[operation];
        if(owned&&current?.status==='complete'){const page=await readProfileOnTab(api,tab.id,handle,0,'leaderboard:'+operation).catch(()=>null);if(['not_found','suspended'].includes(page?.status))throw profileUnavailableError({...page,handle});}
        if(current?.status==='complete'&&template?.queryId&&template?.headers?.authorization&&template?.headers?.['x-csrf-token'])return await fn(tab.id);
        await sleep(500);
      }
      throw new Error(`尚未取得 ${operation} 的 X 请求模板`);
    }finally{if(owned)await api.tabs.remove(tab.id).catch(()=>{});}
  }
  async function profile(handle){
    const clean=String(handle||'').replace(/^@/,'');
    if(!HANDLE_RE.test(clean))throw new Error('账号名无效');
    return withPage(clean,'UserByScreenName',async tabId=>{
      const result=await client.profile(tabId,clean,{preferPageResponse:true});
      if(result.status!==200||result.error)throw networkError(result,'账号资料读取失败');
      const parsed=parsePublicProfile(result.json,now());
      if(parsed.handle.toLowerCase()!==clean.toLowerCase())throw new Error('返回资料与目标账号不符');
      return parsed;
    });
  }
  function networkError(response,fallback){
    const error=new Error(response?.error||fallback);error.status=response?.status||0;error.retryAfterSeconds=response?.retryAfterSeconds||0;return error;
  }
  async function membership({handle}){
    const {accountId}=await currentOwner();
    const clean=String(handle||'').replace(/^@/,'');
    if(!HANDLE_RE.test(clean))throw new Error('账号名无效');
    const members=await store.listMembers(accountId);
    if(!members.some(row=>row.active!==false))return {member:false};
    const key=`${accountId}:${clean.toLowerCase()}`,cached=membershipLookups.get(key);
    if(cached&&now()-cached.at<5*MINUTE)return cached.result;
    while(membershipLookupTimes.length&&membershipLookupTimes[0]<now()-MINUTE)membershipLookupTimes.shift();
    if(membershipLookupTimes.length>=30)throw new Error('榜单成员身份查询已达本分钟上限，请稍后重试');
    membershipLookupTimes.push(now());
    const person=await profile(clean);
    await confirmOwner(accountId);
    const matched=members.find(row=>row.active!==false&&row.creatorId===person.id);
    if(matched&&matched.handle!==person.handle)await store.upsertMember({...matched,handle:person.handle,name:person.name,avatarUrl:person.avatarUrl});
    const result={member:Boolean(matched),creatorId:person.id};
    membershipLookups.set(key,{at:now(),result});
    return result;
  }
  async function add({handle,tweetId,url}){
    const match=String(url||'').match(/^https:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:[/?#]|$)/i);
    if(!match||match[1].toLowerCase()!==String(handle||'').replace(/^@/,'').toLowerCase()||match[2]!==String(tweetId||''))throw new Error('帖子作者与链接不一致');
    const {accountId}=await currentOwner();
    const person=await profile(handle);
    await confirmOwner(accountId);
    await store.upsertMember({ownerId:accountId,creatorId:person.id,handle:person.handle,name:person.name,avatarUrl:person.avatarUrl,active:true,addedAt:now(),lastCapturedAt:person.capturedAt,followers:person.followers,followersState:person.followersState});
    for(const key of membershipLookups.keys())if(key.startsWith(`${accountId}:`))membershipLookups.delete(key);
    if(person.followers!==null)await store.appendSnapshot({ownerId:accountId,creatorId:person.id,at:person.capturedAt,followers:person.followers});
    await schedule();return {member:true,creatorId:person.id};
  }
  async function remove({handle}){
    const {accountId}=await currentOwner();
    const person=await profile(handle);
    await confirmOwner(accountId);
    const member=await store.getMember(accountId,person.id);
    if(member)await store.upsertMember({...member,active:false,removedAt:now(),handle:person.handle});
    for(const key of membershipLookups.keys())if(key.startsWith(`${accountId}:`))membershipLookups.delete(key);
    await schedule();return {member:false,creatorId:person.id};
  }
  async function readTimeline(person,operation,{from,maxPages=5}={}){
    return withPage(person.handle,operation,async tabId=>{
      const resultPosts=new Map();let cursor='',complete=false,unavailable=0,pages=0;
      for(let page=0;page<maxPages;page++){
        const variables={userId:person.creatorId,count:40,includePromotedContent:false,...(cursor?{cursor}:{})};
        const response=await client.query(tabId,operation,variables);
        if(response.status!==200||response.error)throw networkError(response,'公开帖子读取失败');
        const parsed=parsePublicTimeline(response.json,{creatorId:person.creatorId,capturedAt:now(),source:operation});
        pages++;unavailable+=parsed.unavailable;
        for(const post of parsed.posts)resultPosts.set(post.postId,post);
        const oldest=parsed.posts.at(-1)?.createdAt;
        if(!parsed.cursor){complete=true;break}
        if(Number.isFinite(from)&&Number.isFinite(oldest)&&oldest<from){complete=true;break}
        if(parsed.cursor===cursor)break;
        cursor=parsed.cursor;
      }
      return {posts:[...resultPosts.values()],complete,pages,unavailable,operation,capturedAt:now()};
    });
  }
  async function scanOne(accountId,member,{withPosts=true}={}){
    const person=await profile(member.handle);
    await confirmOwner(accountId);
    if(person.id!==member.creatorId)throw new Error(`@${member.handle} 的稳定用户 ID 已变化，暂停采集`);
    await store.upsertMember({...member,handle:person.handle,name:person.name,avatarUrl:person.avatarUrl,lastCapturedAt:person.capturedAt,followers:person.followers,followersState:person.followersState,lastError:''});
    if(person.followers!==null)await store.appendSnapshot({ownerId:accountId,creatorId:person.id,at:person.capturedAt,followers:person.followers});
    if(!withPosts)return {creatorId:person.id,followers:person.followers};
    const current={...member,handle:person.handle};
    const originals=await readTimeline(current,'UserOriginalsTimeline',{maxPages:1});
    await confirmOwner(accountId);
    for(const post of originals.posts)await store.putPost({...post,ownerId:accountId,creatorId:person.id});
    return {creatorId:person.id,followers:person.followers,posts:originals.posts.length};
  }
  async function state(){
    const {accountId,handle:ownerHandle}=await currentOwner();
    const members=await store.listMembers(accountId),snapshots=new Map();
    for(const member of members)snapshots.set(member.creatorId,await store.listSnapshots(accountId,member.creatorId));
    const yesterday=previousDay(shanghaiDay(now())),{from,to}=dayWindow(yesterday);
    const ranked=rankMembers(members,snapshots,shanghaiDay(now()));
    const digestJob=await store.getJob(accountId,yesterday);
    const rows=[];
    for(const member of ranked){
      const posts=await store.listPosts(accountId,member.creatorId,{from,to});
      const original=posts.filter(post=>post.kind==='post'||post.kind==='quote');
      const views=original.map(post=>post.metrics?.views).filter(Number.isFinite);
      const coverage=digestJob?.coverage?.find(item=>item.creatorId===member.creatorId);
      const sevenDayPosts=await store.listPosts(accountId,member.creatorId,{from:to-7*24*HOUR,to});
      const maxPost7d=sevenDayPosts.filter(post=>post.kind!=='reply'&&post.kind!=='repost'&&Number.isFinite(post.metrics?.views)).sort((a,b)=>b.metrics.views-a.metrics.views)[0]||null;
      rows.push({...member,postCount:coverage?.originalComplete?original.length:null,replyCount:coverage?.repliesComplete?posts.filter(post=>post.kind==='reply').length:null,observedPostCount:original.length,observedReplyCount:posts.filter(post=>post.kind==='reply').length,viewsTotal:views.length?views.reduce((a,b)=>a+b,0):null,maxPost:maxPost7d,maxPost7d,postCoverage:coverage?coverage.originalComplete&&coverage.repliesComplete?'complete':'partial':'unknown'});
    }
    const reports=await store.listReports(accountId);
    return {ownerId:accountId,ownerHandle,members:rows,reports,config:await configFor(accountId),scanStatus:{nextAt:(await api.alarms.get(LEADERBOARD_ALARM))?.scheduledTime||null}};
  }
  async function scan({automatic=false}={}){return guard(async()=>{
    const cooldown=(await api.storage.local.get('xefLeaderboardCooldown')).xefLeaderboardCooldown||0;
    if(cooldown>now())throw new Error(`X 请求冷却至 ${new Date(cooldown).toLocaleString('zh-CN')}`);
    const {accountId}=await currentOwner(),members=(await store.listMembers(accountId)).filter(member=>member.active!==false).sort((a,b)=>(a.lastCapturedAt||0)-(b.lastCapturedAt||0));
    const batch=automatic?members.slice(0,(await configFor(accountId)).scanBatchSize):members.slice(0,10),results=[];
    for(const member of batch){
      try{results.push({ok:true,...await scanOne(accountId,member)});}catch(error){
        if(error.message==='X 登录账号已切换，已停止榜单写入')throw error;
        await store.upsertMember({...member,lastError:error.message,lastErrorAt:now()});results.push({ok:false,creatorId:member.creatorId,error:error.message});
        if([401,403,429].includes(error.status)){await api.storage.local.set({xefLeaderboardCooldown:now()+Math.max(HOUR,(error.retryAfterSeconds||0)*1000)});break}
      }
    }
    await schedule({reset:true});return {results,scanned:results.filter(row=>row.ok).length};
  })}
  async function prepareDigest(accountId,date){
    const all=await store.listMembers(accountId),snapshots=new Map();
    for(const member of all)snapshots.set(member.creatorId,await store.listSnapshots(accountId,member.creatorId));
    const members=rankMembers(all,snapshots,shanghaiDay(dayWindow(date).to)).filter(member=>member.deltaStatus==='valid').slice(0,10);
    if(!members.length)return {ownerId:accountId,date,status:'baseline_missing',members:[],samples:[],batches:[],items:[],createdAt:now()};
    const job={id:crypto.randomUUID(),ownerId:accountId,date,status:'collecting',members:members.map(member=>({creatorId:member.creatorId,handle:member.handle,delta:member.delta,deltaEvidence:member.deltaEvidence})),samples:[],batches:[],items:[],coverage:[],createdAt:now(),version:1};
    await store.putJob(job);return job;
  }
  async function collectNextAuthor(accountId,job){
    const member=job.members[job.coverage.length];
    if(!member)return job;
    const {from,to}=dayWindow(job.date);
    let original,replies;
    try{
      original=await readTimeline(member,'UserOriginalsTimeline',{from,maxPages:5});
      replies=await readTimeline(member,'UserRepliesTimeline',{from,maxPages:5}).catch(error=>{
        if([401,403,429].includes(error.status))throw error;
        return {posts:[],complete:false,error:error.message};
      });
    }catch(error){
      if([401,403,429].includes(error.status)){
        await api.storage.local.set({xefLeaderboardCooldown:now()+Math.max(HOUR,(error.retryAfterSeconds||0)*1000)});
        await schedule();return job;
      }
      original={posts:[],complete:false,error:error.message};replies={posts:[],complete:false};
    }
    await confirmOwner(accountId);
    for(const post of [...original.posts,...replies.posts])await store.putPost({...post,ownerId:accountId,creatorId:member.creatorId});
    const chosen=selectDigestPosts(original.posts,job.date,30);
    const coverage={creatorId:member.creatorId,originalComplete:original.complete,repliesComplete:replies.complete===true,postCount:original.posts.filter(post=>post.createdAt>=from&&post.createdAt<to).length,replyCount:replies.posts.filter(post=>post.kind==='reply'&&post.createdAt>=from&&post.createdAt<to).length,sampled:chosen.length,error:original.error||replies.error||''};
    const stored=await store.getMember(accountId,member.creatorId);
    if(stored)await store.upsertMember({...stored,postCoverage:original.complete&&replies.complete?'complete':'partial',lastPostCapturedAt:now()});
    const samples=[...job.samples,...chosen],done=job.coverage.length+1>=job.members.length;
    const next={...job,samples,coverage:[...job.coverage,coverage],status:done?(samples.length?'running':'completed'):'collecting',batches:done?splitDigestBatches(samples).map((batch,index)=>({index,postIds:batch.map(post=>post.postId),status:'pending'})):[],updatedAt:now()};
    await store.putJob(next);
    if(done&&!samples.length)await store.putReport(next);
    await schedule();return next;
  }
  async function analyze(){return guard(async()=>{
    const {accountId}=await currentOwner(),date=previousDay(shanghaiDay(now()));
    let job=await store.getJob(accountId,date);
    if(!job)job=await prepareDigest(accountId,date);
    if(job.status==='baseline_missing'||job.status==='completed')return {report:job};
    if(job.status==='collecting')return {report:await collectNextAuthor(accountId,job)};
    const batch=job.batches.find(item=>item.status==='pending');
    if(batch){
      const samples=job.samples.filter(post=>batch.postIds.includes(post.postId));
      job={...job,batches:job.batches.map(item=>item.index===batch.index?{...item,status:'running'}:item)};await store.putJob(job);
      try{
        const response=await ask(buildDigestBatchPrompt({jobId:job.id,date,batchIndex:batch.index,samples}),{timeoutMs:120000});
        await confirmOwner(accountId);
        if(!response?.ok)throw new Error(response?.reason||'Grok 分析失败');
        const items=parseDigestBatch(response.text,{jobId:job.id,batchIndex:batch.index,postIds:batch.postIds}).map(item=>({...item,authorId:samples.find(post=>post.postId===item.postId)?.authorId,handle:samples.find(post=>post.postId===item.postId)?.handle}));
        job={...job,items:[...job.items,...items],batches:job.batches.map(item=>item.index===batch.index?{...item,status:'completed',completedAt:now(),channel:response.channel}:item),updatedAt:now()};
      }catch(error){
        if(error.message==='X 登录账号已切换，已停止榜单写入')throw error;
        job={...job,status:'partial',error:error.message,batches:job.batches.map(item=>item.index===batch.index?{...item,status:'failed',error:error.message}:item),updatedAt:now()};
      }
      await store.putJob(job);await schedule();return {report:job};
    }
    if(!job.summary&&!job.summaryAttempted){
      try{
        const response=await ask(buildDigestSummaryPrompt({jobId:job.id,date,items:job.items}),{timeoutMs:120000});
        await confirmOwner(accountId);
        if(!response?.ok)throw new Error(response?.reason||'Grok 日报归并失败');
        job={...job,summary:parseDigestSummary(response.text,{jobId:job.id,postIds:job.items.map(item=>item.postId)}),summaryAttempted:true,status:job.batches.every(batch=>batch.status==='completed')&&job.coverage.every(row=>row.originalComplete&&row.repliesComplete)?'completed':'partial',completedAt:now()};
      }catch(error){
        if(error.message==='X 登录账号已切换，已停止榜单写入')throw error;
        job={...job,status:'partial',summaryAttempted:true,error:error.message,updatedAt:now()};
      }
    }
    await store.putJob(job);await store.putReport(job);await schedule();return {report:job};
  })}
  async function report(date){
    const {accountId}=await currentOwner();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||'')))throw new Error('日报日期无效');
    const saved=await store.getReport(accountId,date)||await store.getJob(accountId,date);
    if(saved)return {report:saved};
    if(date!==previousDay(shanghaiDay(now())))return {report:null};
    const members=await store.listMembers(accountId),snapshots=new Map();
    for(const member of members)snapshots.set(member.creatorId,await store.listSnapshots(accountId,member.creatorId));
    const valid=rankMembers(members,snapshots,shanghaiDay(dayWindow(date).to)).some(row=>row.deltaStatus==='valid');
    return {report:valid?null:{ownerId:accountId,date,status:'baseline_missing',members:[],samples:[],items:[],coverage:[]}};
  }
  async function schedule({reset=false}={}){
    const {accountId}=await currentOwner(),members=(await store.listMembers(accountId)).filter(row=>row.active!==false),config=await configFor(accountId);
    if(!members.length||!config.enabled){await api.alarms.clear(LEADERBOARD_ALARM);return}
    const date=previousDay(shanghaiDay(now())),job=await store.getJob(accountId,date),cooldown=(await api.storage.local.get('xefLeaderboardCooldown')).xefLeaderboardCooldown||0;
    const due=config.autoAnalyze&&job&&['collecting','running','partial'].includes(job.status)&&(job.status==='collecting'||job.batches?.some(batch=>batch.status==='pending')||!job.summaryAttempted)?now()+MINUTE:now()+config.scanIntervalMinutes*MINUTE;
    const scheduledTime=Math.max(due,cooldown,now()+1000);
    const existing=await api.alarms.get(LEADERBOARD_ALARM);
    if(!reset&&existing?.scheduledTime>now()&&existing.scheduledTime<=scheduledTime)return;
    await api.alarms.create(LEADERBOARD_ALARM,{when:scheduledTime});
  }
  async function alarm(){
    const {accountId}=await currentOwner();
    const config=await configFor(accountId);
    if(!config.enabled){await api.alarms.clear(LEADERBOARD_ALARM);return {skipped:true,disabled:true}}
    const cooldown=(await api.storage.local.get('xefLeaderboardCooldown')).xefLeaderboardCooldown||0;
    if(cooldown>now()){await schedule();return {skipped:true,cooldown}}
    const result=await scan({automatic:true});
    const updatedCooldown=(await api.storage.local.get('xefLeaderboardCooldown')).xefLeaderboardCooldown||0;
    if(updatedCooldown>now())return {...result,cooldown:updatedCooldown};
    if(config.autoAnalyze)try{await analyze()}catch(error){return {...result,analysisError:error.message}}
    return result;
  }
  async function handle(message){
    switch(message.action){
      case 'membership':return {ok:true,...await membership(message)};
      case 'add':return {ok:true,...await add(message)};
      case 'remove':return {ok:true,...await remove(message)};
      case 'state':return {ok:true,...await state()};
      case 'settings':return {ok:true,config:await saveConfig(message.config)};
      case 'scan':return {ok:true,...await scan()};
      case 'analyze':return {ok:true,...await analyze()};
      case 'report':return {ok:true,...await report(message.date)};
      default:throw new Error('未知榜单操作');
    }
  }
  return {handle,alarm,schedule,state,scan,analyze};
}
