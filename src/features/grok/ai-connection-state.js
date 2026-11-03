import {LOCAL_AI_ENGINES} from './agent-relay-client.js';

export const AI_CONNECTION_KEY = 'xfollowerAiConnectionState';
export const AI_CONNECTION_ALARM = 'x-ai-connection-monitor';
const providers = LOCAL_AI_ENGINES.map(item => item.provider);
const sameConfig = (a,b) => JSON.stringify(a) === JSON.stringify(b);

// Account/settings owns connectivity. Consumers only read this snapshot; they never probe.
export function createAiConnectionMonitor({clients, api=globalThis.chrome, now=Date.now}={}) {
  let states={}, loaded, started=false, starting, writes=Promise.resolve();
  const pending=new Map();
  const load=()=>loaded ||= api.storage.local.get(AI_CONNECTION_KEY).then(value=>{states=value[AI_CONNECTION_KEY]||{};});
  const save=()=>{const value=structuredClone(states);writes=writes.catch(()=>{}).then(()=>api.storage.local.set({[AI_CONNECTION_KEY]:value}));return writes;};
  async function read(provider) {await load();return structuredClone(provider ? states[provider]||{provider,state:'checking',connected:false,sessions:[]} : states);}
  function check(provider) {
    if (!providers.includes(provider)) return Promise.reject(Error('未知 AI 引擎'));
    if(pending.has(provider))return pending.get(provider);
    const work=(async()=>{
      await load();
      const client=clients[provider], config=await client.configuration(), status=await client.status();
      const previous=states[provider]||{};
      if(!status.enabled){states[provider]={...status,provider,state:'unconfigured',connected:false,sessions:[],checkedAt:now(),nextAt:now()+300000,reason:'请先在系统设置连接并测试所选 AI 引擎'};await save();return read(provider);}
      states[provider]={...previous,...status,provider,state:'checking',connected:previous.connected===true,sessions:previous.sessions||[],nextAt:now()+60000};
      await save();
      try {
        const health=await client.health(config);
        if(health?.ok===false||health?.available===false||health?.status==='unavailable')throw Error('AI 客户端未连接，请在 AgentRelay 检查登录状态');
        const sessions=await client.list(config);
        // Settings can change while a request is in flight. Never publish an old connection as ready.
        if(!sameConfig(config,await client.configuration()))throw Error('连接配置已更新，等待统一检测');
        states[provider]={...status,provider,state:'ready',connected:true,sessions,checkedAt:now(),nextAt:now()+300000,reason:''};
      } catch(error) {
        states[provider]={...status,provider,state:'offline',connected:false,sessions:[],checkedAt:now(),nextAt:now()+60000,reason:String(error.message||'AI 连接暂不可用').slice(0,300)};
      }
      await save();return read(provider);
    })().finally(()=>pending.delete(provider));
    pending.set(provider,work);return work;
  }
  async function tick(force=false) {
    await load();
    await Promise.all(providers.filter(provider=>force||!states[provider]?.nextAt||states[provider].nextAt<=now()).map(check));
    return read();
  }
  function start() {
    if(started)return starting;started=true;
    api.alarms.onAlarm.addListener(alarm=>{if(alarm.name===AI_CONNECTION_ALARM)void tick().catch(()=>{});});
    starting=(async()=>{
      if(!await api.alarms.get(AI_CONNECTION_ALARM))await api.alarms.create(AI_CONNECTION_ALARM,{periodInMinutes:1});
      await tick(true);
    })();
    return starting;
  }
  async function request({op='read',provider,input,name,bot,options}={}) {
    if(op==='read')return read(provider);
    if(op==='admission'){await starting;await pending.get(provider);return read(provider);}
    if(op==='retry')return provider?check(provider):tick(true);
    if(!providers.includes(provider))throw Error('未知 AI 引擎');
    const client=clients[provider];
    // Only the account settings UI uses these explicit setup actions (possibly unsaved credentials).
    if(op==='list'){await client.health(input);return client.list(input);}
    if(op==='test'){const result=await client.test(input,options);await tick(true);return result;}
    if(op==='createSession'){const result=await client.createSession(input,name);await check(provider);return result;}
    if(op==='selectBot'){const result=await client.selectBot(bot);await check(provider);return result;}
    throw Error('未知 AI 连接操作');
  }
  return {read,check,tick,start,request};
}

let owner;
export function installAiConnectionMonitor(monitor){owner=monitor;}
export async function requestAiConnection(payload={}) {
  if(owner)return owner.request(payload);
  const response=await globalThis.chrome.runtime.sendMessage({cmd:'aiConnection',...payload});
  if(!response?.ok)throw Error(response?.error||'无法读取统一 AI 连接状态');
  return response.result;
}
export async function readAiSessions(provider) {
  const state=await requestAiConnection({op:'admission',provider});
  if(!state.connected)throw Object.assign(Error(state.reason||'AI 连接正在由系统设置检测，请稍后重试'),{code:'AI_CONNECTION_UNAVAILABLE',transient:true});
  return state.sessions||[];
}
