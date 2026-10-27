import {runBotOnboardingPage,captureOwnedGrokWebhook} from './bot-onboarding-page.js';
import {buildGrokBotInstruction} from './grok-bot-instruction.js';
import {grokBotRelay} from './grok-bot-relay.js';
import {createCloudflareProvisioner,cloudflareTokenTemplate} from './cloudflare-provisioner.js';

export const SETUP_KEY='grokBotOnboarding';
export const SETUP_VAULT_KEY='grokBotOnboardingSecrets';
export const SETUP_ALARM='xfollower-grok-onboarding';
const SECRET_TTL=3600000;
const LIVE_STAGES=new Set(['cloudflare-login','cloudflare-token','deploying','workers-onboarding','grok','configuring','testing']);
const STAGE_LABELS={'cloudflare-login':'请登录 Cloudflare 并选择账号','cloudflare-token':'请在 Cloudflare 确认创建部署令牌',deploying:'正在创建数据库与中转服务','workers-onboarding':'请完成 Workers 首次开通',grok:'正在配置 Grok 网页自动化',configuring:'正在绑定接口',testing:'正在验证生成与回传',completed:'接入完成',cancelled:'已停止接入'};
function randomToken(){return Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');}

export function createBotOnboarding({api=globalThis.chrome,provisioner=createCloudflareProvisioner(),relay=grokBotRelay,workerSource='',schema='',now=Date.now}={}){
  let advancing,starting,cancelling=false;
  const local=api.storage.local,session=api.storage.session;
  const read=async()=> (await local.get(SETUP_KEY))[SETUP_KEY]||null;
  const write=async patch=>{const state={...await read(),...patch,updatedAt:now()};await local.set({[SETUP_KEY]:state});return state;};
  const vault=async()=>{
    const value=(await session.get(SETUP_VAULT_KEY))[SETUP_VAULT_KEY];
    if(!value||value.expiresAt<now()){await session.remove(SETUP_VAULT_KEY);const error=Error('临时授权已过期，请重新授权后继续；已创建资源会保留');error.code='AUTH_EXPIRED';throw error;}
    return value;
  };
  const setSecret=async patch=>{const old=(await session.get(SETUP_VAULT_KEY))[SETUP_VAULT_KEY]||{};await session.set({[SETUP_VAULT_KEY]:{...old,...patch,expiresAt:now()+SECRET_TTL}});};
  async function status(){const temporary=(await session.get(SETUP_VAULT_KEY))[SETUP_VAULT_KEY];if(temporary?.expiresAt<now())await session.remove(SETUP_VAULT_KEY);const s=await read();return s?{...s,message:s.error||s.message||STAGE_LABELS[s.stage]||'',busy:Boolean(advancing)}:{stage:'idle',message:''};}
  async function ownedTab(kind){
    const s=await read(),id=s?.[kind+'TabId'];if(!Number.isInteger(id))return null;
    const tab=await api.tabs.get(id).catch(()=>null);if(!tab)return null;
    const url=new URL(tab.url||'about:blank');const allowed=kind==='cloudflare'?'dash.cloudflare.com':'grok.com';
    if(url.protocol!=='https:'||url.hostname!==allowed)return null;
    return tab;
  }
  async function page(kind,input){
    const tab=await ownedTab(kind);if(!tab){const e=Error('接入页面已关闭或离开授权站点，请重新打开后继续');e.code='TAB_MISSING';throw e;}
    const capture=input.action==='capture-credential';
    const output=await api.scripting.executeScript({target:{tabId:tab.id},world:capture?'MAIN':'ISOLATED',func:capture?captureOwnedGrokWebhook:runBotOnboardingPage,args:[{...input,provider:kind==='cloudflare'?'cloudflare':'grok'}]});
    return output?.[0]?.result||{state:'loading'};
  }
  async function openTab(kind,url){
    const existing=await ownedTab(kind);const tab=existing?await api.tabs.update(existing.id,{url,active:true}):await api.tabs.create({url,active:true});
    await write({[kind+'TabId']:tab.id});return tab;
  }
  async function startOnce(){
    cancelling=false;
    const old=await read();if(old&&LIVE_STAGES.has(old.stage))return status();
    if(!session)throw Error('浏览器不支持安全会话存储，请升级浏览器');
    const setupId=crypto.randomUUID(),resourceName='xfollower-grok-'+setupId.replaceAll('-','').slice(0,12);
    await local.set({[SETUP_KEY]:{setupId,resourceName,botName:'XFollower 接入 '+setupId.slice(0,8),tokenName:'XFollower 接入部署 '+setupId.slice(0,8),stage:'cloudflare-login',createdAt:now(),updatedAt:now(),checkpoint:{},error:'',message:''}});
    await session.set({[SETUP_VAULT_KEY]:{setupId,clientToken:randomToken(),expiresAt:now()+SECRET_TTL}});
    await openTab('cloudflare','https://dash.cloudflare.com/');
    await api.alarms.create(SETUP_ALARM,{periodInMinutes:0.5});return status();
  }
  async function start(){if(starting){await starting;return status();}starting=startOnce();try{return await starting;}finally{starting=null;}}
  async function configure(){
    const s=await read(),v=await vault();
    await provisioner.configureWorker({token:v.cloudflareToken,accountId:s.accountId,resourceName:s.resourceName,setupId:s.setupId,databaseId:s.databaseId,origin:s.origin,workerSource,clientToken:v.clientToken,webhookUrl:v.webhookUrl,webhookSecret:v.webhookSecret});
    // Permission must be granted by the direct wizard click before this call.
    const granted=await api.permissions.contains({origins:[s.origin+'/*']});
    if(!granted)return write({stage:'configuring',needsWorkerPermission:true,message:'请允许插件访问刚部署的中转地址'});
    await relay.connect({origin:s.origin,token:v.clientToken});
    await write({stage:'testing',needsWorkerPermission:false,testIntent:true,message:''});
    const result=await relay.generate('请仅返回：XFollower Grok Hook 连接成功。',{test:true,requestKey:'onboarding-'+s.setupId,requestTag:'onboarding:'+s.setupId,timeoutMs:0});
    if(!result.jobId)throw Error('连接测试未能创建，请检查接口配置');
    await write({testJobId:result.jobId,testIntent:false,nextQueryAt:now()+30000});
  }
  async function advanceOnce(){
    let s=await read();if(!s||!LIVE_STAGES.has(s.stage)||s.error)return;
    if(s.stage!=='testing')await vault();
    if(s.stage==='cloudflare-login'){
      const scan=await page('cloudflare',{action:'account'});
      if(scan.state==='account'){
        await write({accountId:scan.accountId,stage:'cloudflare-token',message:''});
        await openTab('cloudflare',cloudflareTokenTemplate({accountId:scan.accountId,name:s.tokenName}));
      }else await write({message:scan.state==='verification'?'请完成 Cloudflare 安全验证':scan.state==='login'?'请登录 Cloudflare':'请在 Cloudflare 选择要授权的账号'});
    }else if(s.stage==='cloudflare-token'){
      const scan=await page('cloudflare',{action:'prepare-token',tokenName:s.tokenName});
      if(scan.state==='token'){
        await setSecret({cloudflareToken:scan.token});
        const info=await provisioner.inspect(scan.token,s.accountId);
        if(info.accountId!==s.accountId)throw Error('部署授权账号不一致，请重新授权');
        await write({stage:'deploying',message:''});
      }else if(['permission-mismatch','token-not-readable','wrong-page'].includes(scan.state))throw Error(scan.state==='permission-mismatch'?'令牌权限未正确预填，请重新打开授权页面':'无法识别本次新令牌，请保留当前页面并重试');
      else await write({message:scan.state==='verification'?'请完成 Cloudflare 安全验证':'请核对权限并在 Cloudflare 点击“创建令牌”，创建后将自动读取'});
    }else if(s.stage==='deploying'){
      const v=await vault();
      try{
        const resources=await provisioner.prepareResources({token:v.cloudflareToken,accountId:s.accountId,resourceName:s.resourceName,setupId:s.setupId,checkpoint:s.checkpoint,workerSource,schema,clientToken:v.clientToken,onCheckpoint:async checkpoint=>write({checkpoint:{...(await read()).checkpoint,...checkpoint}})});
        await write({...resources,stage:'grok',message:''});
        await openTab('grok','https://grok.com/automations');
      }catch(e){if(e.code==='WORKERS_ONBOARDING_REQUIRED'){await write({stage:'workers-onboarding',workersOnboardingShown:true,nextOnboardingCheck:now()+30000,message:'请在 Cloudflare 完成首次开通和子域选择，完成后会继续部署'});if(!s.workersOnboardingShown)await openTab('cloudflare',`https://dash.cloudflare.com/${s.accountId}/workers-and-pages`);}else throw e;}
    }else if(s.stage==='workers-onboarding'){
      // Prefill a first-use subdomain; the user confirms terms/authorization.
      const firstUse=await page('cloudflare',{action:'workers-onboarding',accountId:s.accountId,suggestedSubdomain:'xfollower-'+s.setupId.replaceAll('-','').slice(0,12)});
      await write({message:firstUse.subdomainReady?'已填入子域，请在 Cloudflare 确认首次开通授权':'请在 Cloudflare 完成首次开通授权，之后自动继续'});
      if(!(s.nextOnboardingCheck>now()))await write({stage:'deploying'});
    }else if(s.stage==='grok'){
      if(!await ownedTab('grok'))await openTab('grok','https://grok.com/automations');
      const v=await vault();
      const action=s.grokSaveIntent?'verify-save':v.webhookSecret?'save-webhook':s.grokSubmissionStarted?'inspect-created':'configure';
      const scan=await page('grok',{action,botName:s.botName,instruction:buildGrokBotInstruction(s.origin),created:s.grokCreated||s.grokCreateIntent,createIntent:s.grokCreateIntent,expectedWebhookUrl:v.webhookUrl||''});
      if(['loading','trigger-loading','fill-pending','save-pending','creation-pending','opening'].includes(scan.state)){
        const since=s.pageWaitStartedAt||now();if(now()-since>120000)throw Error('Grok 配置页面仍未就绪，请完成页面验证或检查 Webhook 功能后继续');
        await write({pageWaitStartedAt:since});
      }else if(s.pageWaitStartedAt)await write({pageWaitStartedAt:0});
      if(scan.state==='webhook-draft'||scan.state==='webhook'){
        await setSecret({webhookUrl:scan.webhookUrl,webhookSecret:scan.webhookSecret});
        await write({grokCreated:true,grokSaveIntent:scan.state==='webhook',message:'已读取本次 Webhook，正在保存配置'});
      }else if(scan.state==='secret-not-visible'&&s.grokCreateIntent){
        const credential=await page('grok',{action:'capture-credential',botName:s.botName,instruction:buildGrokBotInstruction(s.origin),createdHere:true});
        if(credential.state!=='webhook')throw Error('无法自动读取本次新密钥，请保留 Grok 配置页面后重试');
        await setSecret({webhookUrl:credential.webhookUrl,webhookSecret:credential.webhookSecret});
        await write({grokCreated:true,grokSaveIntent:true,message:'已接收本次签名密钥，正在确认保存'});
      }else if(scan.state==='ready-to-create'){
        await write({grokCreateIntent:true,grokSubmissionStarted:true,message:'正在创建本次 Grok 自动化'});
        const submitted=await page('grok',{action:'create',botName:s.botName,instruction:buildGrokBotInstruction(s.origin),created:true,createIntent:true});
        if(submitted.state==='save-pending')await write({grokSubmissionStarted:false});
      }else if(scan.state==='creating')await write({grokCreateIntent:true,message:'正在创建本次 Grok 自动化'});
      else if(scan.state==='saving')await write({grokSaveIntent:true,message:'正在确认 Grok 已保存本次配置'});
      else if(scan.state==='saved')await write({stage:'configuring',grokCreated:true,message:''});
      else if(['unsupported','wrong-task','secret-not-visible','task-not-visible','save-not-confirmed'].includes(scan.state))throw Error('Grok 页面结构或密钥显示状态发生变化，已停止自动操作，请保留页面并重试');
      else await write({message:scan.state==='verification'?'请完成 Grok 安全验证':scan.state==='login'?'请登录 Grok':'正在自动填写任务和 Webhook 配置'});
    }else if(s.stage==='configuring'){
      if(!s.needsWorkerPermission)await configure();
      else if(await api.permissions.contains({origins:[s.origin+'/*']})){await write({needsWorkerPermission:false});await configure();}
    }else if(s.stage==='testing'){
      if(!s.testJobId){
        // Recover the test created before a worker interruption, using its saved job.
        const jobs=await relay.jobs();const test=jobs.find(j=>j.test&&j.requestTag==='onboarding:'+s.setupId);
        if(test)await write({testJobId:test.id});else throw Error('测试提交结果待核查，请在 Bot 任务记录中确认，未重复提交');
      }else{
        if(s.nextQueryAt>now())return;
        await write({nextQueryAt:now()+30000});
        const job=await relay.query(s.testJobId);
        if(job.status==='completed'){
          await session.remove(SETUP_VAULT_KEY);
          await write({stage:'completed',result:job.result,message:'配置和真实回传验证通过',completedAt:now()});
          await api.alarms.clear(SETUP_ALARM);
          for(const kind of ['cloudflare','grok']){const tab=await ownedTab(kind);if(tab&&api.tabs.remove)await api.tabs.remove(tab.id).catch(()=>{});}
        }else if(job.status==='failed')throw Error('生成测试被明确拒绝，请核对 Grok 运行记录');
        else await write({message:'Bot 正在执行，按原任务继续查询，不重复提交'});
      }
    }
  }
  async function advance(){
    if(advancing||cancelling)return status();
    advancing=advanceOnce().catch(async e=>{
      const messages={AUTH_EXPIRED:'临时授权已过期，请重新授权后继续；已创建资源保留',TAB_MISSING:'接入页面已关闭或离开授权站点，请重新打开后继续'};
      await write({error:messages[e.code]||(e.name==='CloudflareProvisionError'?`Cloudflare 配置未完成${e.status?'（HTTP '+e.status+'）':''}，请核对授权权限后继续`:String(e.message||'自动接入失败').slice(0,200)),errorCode:e.code||'SETUP_FAILED'});
    });
    try{await advancing;}finally{advancing=null;}
    return status();
  }
  async function resume(){
    const s=await read();if(!s||s.stage==='completed')return status();
    if(s.stage==='testing'){await write({error:'',errorCode:''});await api.alarms.create(SETUP_ALARM,{periodInMinutes:0.5});return status();}
    const v=(await session.get(SETUP_VAULT_KEY))[SETUP_VAULT_KEY];
    if(!v||v.expiresAt<now()){
      // Existing clientToken is needed to safely resume an already deployed Worker.
      // Keep it in the private active/pending connection if one has been bound.
      await session.set({[SETUP_VAULT_KEY]:{setupId:s.setupId,clientToken:v?.clientToken||randomToken(),expiresAt:now()+SECRET_TTL}});
      await write({stage:'cloudflare-login',botName:'XFollower 接入 '+s.setupId.slice(0,8)+'-'+crypto.randomUUID().slice(0,4),grokCreated:false,grokCreateIntent:false,grokSubmissionStarted:false,grokSaveIntent:false,error:'',errorCode:'',message:''});await openTab('cloudflare','https://dash.cloudflare.com/');
    }else{
      await write({error:'',errorCode:'',message:''});
      if(!await ownedTab('cloudflare')&&s.stage.startsWith('cloudflare'))await openTab('cloudflare',s.stage==='cloudflare-token'?cloudflareTokenTemplate({accountId:s.accountId,name:s.tokenName}):'https://dash.cloudflare.com/');
      if(s.stage==='grok'&&!await ownedTab('grok'))await openTab('grok','https://grok.com/automations');
    }
    await api.alarms.create(SETUP_ALARM,{periodInMinutes:0.5});return status();
  }
  async function cancel(){
    cancelling=true;
    if(advancing)await advancing;
    await write({stage:'cancelled',error:'',message:'已停止，云端已创建的专用资源保留，可从教程查看撤销方法'});
    await session.remove(SETUP_VAULT_KEY);await api.alarms.clear(SETUP_ALARM);return status();
  }
  return {start,status,advance,resume,cancel};
}
