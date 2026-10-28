import {grokBotRelay} from './grok-bot-relay.js';
import {grokLocal} from './grok-local.js';
export const GROK_PROVIDER_KEY='systemSettings:grokProvider';
export async function readGrokProvider(storage=globalThis.chrome?.storage?.local){const value=(await storage?.get(GROK_PROVIDER_KEY))?.[GROK_PROVIDER_KEY];return ['grok-bot','grok-local'].includes(value)?value:'grok';}
export async function selectGrokProvider(value,{storage=globalThis.chrome?.storage?.local,service=grokBotRelay,localService=grokLocal}={}){
  if(!['grok','grok-bot','grok-local'].includes(value))throw Error('未知 Grok 通道');
  if(value!=='grok'&&!(await (value==='grok-local'?localService:service).status()).enabled)return {connectionRequired:true};
  await storage.set({[GROK_PROVIDER_KEY]:value});return {provider:value};
}
export async function routeGrokRequest(primary,prompt,options={}){
  const {service=grokBotRelay,localService=grokLocal,readProvider=readGrokProvider,relayJobId,...generationOptions}=options;
  if(relayJobId)return relayJobId.startsWith('local:')?localService.resume(relayJobId):service.resume(relayJobId);
  const provider=await readProvider();if(generationOptions.expectedBot&&provider!=='grok-local')return {ok:false,reason:'知识增强固定 Bot 通道已变化，已停止提交'};return provider==='grok-local'?localService.generate(prompt,generationOptions):provider==='grok-bot'?service.generate(prompt,generationOptions):primary();
}
