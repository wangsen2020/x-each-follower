import {grokBotRelay} from './grok-bot-relay.js';
import {grokLocal,getLocalAiService,isLocalAiProvider} from './grok-local.js';
export const GROK_PROVIDER_KEY='systemSettings:grokProvider';
export async function readGrokProvider(storage=globalThis.chrome?.storage?.local){const value=(await storage?.get(GROK_PROVIDER_KEY))?.[GROK_PROVIDER_KEY];return value==='grok-bot'||isLocalAiProvider(value)?value:'grok';}
export async function selectGrokProvider(value,{storage=globalThis.chrome?.storage?.local,service=grokBotRelay,localService=grokLocal}={}){
  if(!['grok','grok-bot'].includes(value)&&!isLocalAiProvider(value))throw Error('未知 AI 引擎');
  if(value!=='grok'&&!(await (isLocalAiProvider(value)?value==='grok-local'?localService:getLocalAiService(value):service).status()).enabled)return {connectionRequired:true};
  await storage.set({[GROK_PROVIDER_KEY]:value});return {provider:value};
}
export async function routeGrokRequest(primary,prompt,options={}){
  const {service=grokBotRelay,localService=grokLocal,readProvider=readGrokProvider,provider:selectedProvider,relayJobId,...generationOptions}=options;
  if(relayJobId)return relayJobId.startsWith('local:')?localService.resume(relayJobId):service.resume(relayJobId);
  const provider=selectedProvider ?? await readProvider();if(!['grok','grok-bot'].includes(provider)&&!isLocalAiProvider(provider))throw Error('请选择 AI 引擎');if(generationOptions.expectedBot&&!isLocalAiProvider(provider))return {ok:false,reason:'固定 Bot 通道已变化，已停止提交'};return isLocalAiProvider(provider)?(provider==='grok-local'?localService:getLocalAiService(provider)).generate(prompt,generationOptions):provider==='grok-bot'?service.generate(prompt,generationOptions):primary();
}
