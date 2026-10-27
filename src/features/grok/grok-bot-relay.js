import Dexie from 'dexie';

export const BOT_POLL_MS = 30000;
export const BOT_WAIT_MS = 300000;
const STATES = new Set(['dispatching','accepted','unknown','completed','failed']);
let database;
function db(){
  if(!database){database=new Dexie('xfollower-grok-bot');database.version(1).stores({connections:'id',jobs:'id,key,createdAt'});}
  return database;
}
const repository={
  connection:()=>db().table('connections').get('relay'),
  saveConnection:value=>db().table('connections').put({...value,id:'relay'}),
  disconnect:()=>db().table('connections').delete('relay'),
  jobs:()=>db().table('jobs').toArray(),
  saveJob:value=>db().transaction('rw',db().table('jobs'),async()=>{
    const current=await db().table('jobs').get(value.id);
    const final=current&&['completed','failed'].includes(current.status)&&!['completed','failed'].includes(value.status);
    const next={...value,...(final?{status:current.status,result:current.result,reason:current.reason}:{}),delivered:Boolean(value.delivered||current?.delivered)};
    await db().table('jobs').put(next);return next;
  }),
  reserveJob:candidate=>db().transaction('rw',db().table('jobs'),async()=>{
    const jobs=await db().table('jobs').where('key').equals(candidate.key).toArray();
    const existing=jobs.find(j=>!j.delivered&&j.origin===candidate.origin&&!(candidate.test&&j.status==='failed'));
    if(existing)return {job:existing,created:false};
    await db().table('jobs').put(candidate);return {job:candidate,created:true};
  })
};
export function relayOrigin(value){
  let url;try{url=new URL(String(value).trim());}catch{throw Error('请输入完整的 HTTPS Worker 地址');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('请仅填写 HTTPS 域名，不含路径、参数或账号');
  return url.origin;
}
async function hash(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
function publicJob(job){const {id,status,result,createdAt,updatedAt,reason,botName,test,requestTag}=job;return {id,status,result,createdAt,updatedAt,reason,botName,test,requestTag};}
export function createGrokBotRelay({store=repository,fetchImpl=globalThis.fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,uuid=()=>crypto.randomUUID()}={}){
  const inflight=new Map();
  async function api(connection,path,options={}){
    let response;
    try{response=await fetchImpl(connection.origin+path,{...options,redirect:'error',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json',authorization:`Bearer ${connection.token}`}});}
    catch{throw Error('无法连接备用接口；已保存的任务可稍后继续查询');}
    if(!response.ok){const error=Error(response.status===401?'连接 Token 无效，请重新绑定':response.status===404?'云端没有此任务，请检查是否更换了接口或数据库':response.status===409?'任务编号与已有内容冲突，请保留记录并检查配置':response.status===429?'备用接口暂时限流，请稍后查询原任务':`备用接口返回 ${response.status}`);error.status=response.status;throw error;}
    const text=await response.text();if(text.length>150000)throw Error('备用接口返回内容过大');
    let body;try{body=JSON.parse(text);}catch{throw Error('备用接口未返回有效 JSON');}
    return body;
  }
  async function status(){const c=await store.connection();return {connected:Boolean(c),enabled:Boolean(c?.enabled&&c?.testedAt),origin:c?.origin||'',botName:c?.botName||'',testedAt:c?.testedAt||null,pendingOrigin:c?.pending?.origin||''};}
  async function connect({origin,token}){
    const c={origin:relayOrigin(origin),token:String(token||'').trim(),enabled:false,testedAt:null,connectionKey:uuid()};
    if(c.token.length<32||c.token.length>256||/\s/.test(c.token))throw Error('请粘贴32至256位专用连接 Token');
    const info=await api(c,'/v1/health');
    if(info.protocolVersion!==1||info.provider!=='grok-bot')throw Error('接口协议不匹配，请部署教程中的 Grok Hook 中转');
    c.botName=String(info.botName||'Grok Hook').slice(0,80);const old=await store.connection();await store.saveConnection(old?.testedAt?{...old,pending:c}:c);return status();
  }
  async function updateJob(job,remote){
    if(!remote||remote.jobId!==job.id||!STATES.has(remote.status))throw Error('备用接口的任务状态无效');
    if(remote.status==='completed'&&(typeof remote.result!=='string'||!remote.result.trim()||remote.result.length>100000))throw Error('备用接口未返回有效结果');
    const next={...job,status:remote.status,result:remote.status==='completed'?remote.result:job.result||'',updatedAt:now(),reason:remote.reasonCode||''};
    await store.saveJob(next);return next;
  }
  async function query(id){
    const saved=await store.connection();if(!saved)throw Error('请先绑定 Grok Hook');
    const job=(await store.jobs()).find(j=>j.id===id);if(!job)throw Error('找不到本地任务');
    const c=saved.pending?.connectionKey===job.connectionKey?saved.pending:saved;
    if(job.origin!==c.origin)throw Error('此任务属于之前的接口，请重新绑定原接口查询');
    const next=await updateJob(job,await api(c,`/v1/jobs/${encodeURIComponent(id)}`));
    if(next.test&&next.status==='failed')await store.saveJob({...next,delivered:true});
    if(next.test&&next.status==='completed'&&next.connectionKey===c.connectionKey){await acceptTest(c);await store.saveJob({...next,delivered:true});}
    return publicJob(next);
  }
  async function generate(prompt,{requestKey=prompt,timeoutMs=BOT_WAIT_MS,test=false,requestTag='',onJobCreated}={}){
    const saved=await store.connection();const c=test&&saved?.pending?saved.pending:saved;
    if(!c||(!test&&(!c.enabled||!c.testedAt)))return {ok:false,connectionRequired:true,reason:'请先在系统设置中绑定并测试 Grok Hook 备用通道'};
    const key=await hash(c.origin+'\n'+(test?c.connectionKey+'\n':'')+requestKey);
    if(inflight.has(key))return inflight.get(key);
    const work=(async()=>{
      let job=(await store.jobs()).find(j=>j.key===key&&!j.delivered&&j.origin===c.origin&&!(test&&j.status==='failed'));
      let created=false;
      if(!job){
        if(typeof prompt!=='string'||!prompt.trim()||new TextEncoder().encode(prompt).length>100000)return {ok:false,reason:'备用任务正文为空或超过100KB，请减少本次输入'};
        job={id:uuid(),key,origin:c.origin,connectionKey:c.connectionKey,botName:c.botName,prompt,test,requestTag:/^[a-z0-9:-]{1,80}$/i.test(requestTag)?requestTag:'',status:'unknown',result:'',createdAt:now(),updatedAt:now(),delivered:false};
        // Persist before sending: an uncertain POST is never silently replayed.
        const reserved=store.reserveJob?await store.reserveJob(job):await store.saveJob(job).then(()=>({job,created:true}));
        job=reserved.job;created=reserved.created;
      }
      // The owning queue must retain this ID before the paid webhook can leave.
      if(onJobCreated)await onJobCreated(publicJob(job));
      if(created){
          try{job=await updateJob(job,await api(c,'/v1/jobs',{method:'POST',body:JSON.stringify({jobId:job.id,prompt})}));}
          catch(e){return {ok:false,pending:true,jobId:job.id,channel:'grok-bot',reason:e.message};}
      }
      const deadline=now()+timeoutMs;
      while(true){
        if(job.status==='completed'){
          await store.saveJob({...job,delivered:true});
          if(test)await acceptTest(c);
          return {ok:true,text:job.result,channel:'grok-bot',botName:job.botName,jobId:job.id};
        }
        if(job.status==='failed')return {ok:false,jobId:job.id,channel:'grok-bot',reason:'Bot 任务被明确拒绝，请检查任务配置与运行记录'};
        if(now()>=deadline)return {ok:false,pending:true,jobId:job.id,channel:'grok-bot',reason:'Bot 仍未返回结果，任务已保留，可在系统设置继续查询'};
        await sleep(BOT_POLL_MS);
        try{job=await updateJob(job,await api(c,`/v1/jobs/${encodeURIComponent(job.id)}`));}
        catch(e){return {ok:false,pending:true,jobId:job.id,channel:'grok-bot',reason:e.message};}
      }
    })();
    inflight.set(key,work);try{return await work;}finally{inflight.delete(key);}
  }
  async function enable(value){const c=await store.connection();if(!c)throw Error('请先绑定接口');if(value&&!c.testedAt)throw Error('请先完成一次生成测试');await store.saveConnection({...c,enabled:Boolean(value)});}
  async function acceptTest(c){const current=await store.connection();if(current?.pending?.connectionKey===c.connectionKey)await store.saveConnection({...c,testedAt:now(),enabled:true});else if(current?.connectionKey===c.connectionKey)await store.saveConnection({...current,testedAt:now(),enabled:true});}
  async function resume(id){
    try{const job=await query(id);if(job.status==='completed'){const saved=(await store.jobs()).find(j=>j.id===id);await store.saveJob({...saved,delivered:true});return {ok:true,text:job.result,jobId:id,channel:'grok-bot',botName:job.botName};}return {ok:false,pending:job.status!=='failed',jobId:id,channel:'grok-bot',reason:job.status==='failed'?'Bot 任务失败，请检查网页运行记录':'Bot 结果尚未返回，原任务已保留'};}
    catch(e){return {ok:false,pending:true,jobId:id,channel:'grok-bot',reason:e.message};}
  }
  return {status,connect,generate,query,resume,enable,disconnect:()=>store.disconnect(),jobs:async()=>(await store.jobs()).sort((a,b)=>b.createdAt-a.createdAt).map(publicJob)};
}
export const grokBotRelay=createGrokBotRelay();

export async function withGrokBotFallback(primary,prompt,options={}){
  if(!primary?.quotaExhausted||primary.channel!=='x.com'||primary.generationAttempted===true)return primary;
  const service=options.service||grokBotRelay;
  let state;try{state=await service.status();}catch{return {...primary,botSetupAvailable:true,reason:`${primary.reason||'X Grok 额度已耗尽'}；暂时无法读取 Bot 连接，请打开系统设置检查`};}
  if(!state.enabled)return {...primary,botSetupAvailable:true,reason:`${primary.reason||'X Grok 额度已耗尽'}；可在系统设置连接 Grok Hook 备用通道`};
  return service.generate(prompt,options);
}
