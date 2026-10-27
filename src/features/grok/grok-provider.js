import {grokBotRelay} from './grok-bot-relay.js';
export const GROK_PROVIDER_KEY='systemSettings:grokProvider';
export async function readGrokProvider(storage=globalThis.chrome?.storage?.local){return (await storage?.get(GROK_PROVIDER_KEY))?.[GROK_PROVIDER_KEY]==='grok-bot'?'grok-bot':'grok';}
export async function selectGrokProvider(value,{storage=globalThis.chrome?.storage?.local,service=grokBotRelay}={}){
  if(!['grok','grok-bot'].includes(value))throw Error('未知 Grok 通道');
  if(value==='grok-bot'&&!(await service.status()).enabled)return {connectionRequired:true};
  await storage.set({[GROK_PROVIDER_KEY]:value});return {provider:value};
}
export async function routeGrokRequest(primary,prompt,options={}){
  const {service=grokBotRelay,readProvider=readGrokProvider,relayJobId,...generationOptions}=options;
  if(relayJobId)return service.resume(relayJobId);
  return await readProvider()==='grok-bot'?service.generate(prompt,generationOptions):primary();
}
