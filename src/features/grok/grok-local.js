import {createAgentRelayClient, LOCAL_AI_ENGINES} from './agent-relay-client.js';
import {requestAiConnection, readAiSessions} from './ai-connection-state.js';
export {LOCAL_AI_ENGINES,isLocalAiProvider,connectionUrl} from './agent-relay-client.js';
export const createGrokLocal=options=>createAgentRelayClient(options);
function sharedClient({provider,engine}) {
 const raw=createAgentRelayClient({engine,sessionSource:()=>readAiSessions(provider)});
 return {...raw,
  status:async()=>({...await raw.status(),...await requestAiConnection({provider})}),
  list:()=>readAiSessions(provider),
  health:()=>requestAiConnection({provider}),
  test:(input,options)=>requestAiConnection({op:'test',provider,input,options}),
  selectBot:bot=>requestAiConnection({op:'selectBot',provider,bot}),
  createSession:(input,name)=>requestAiConnection({op:'createSession',provider,input,name}),
  async generate(prompt,options){
   try {await readAiSessions(provider);return await raw.generate(prompt,options);}
   catch(error){return {ok:false,blocking:true,transient:true,reason:error.message,errorCode:error.code};}
  }
 };
}
const services=Object.fromEntries(LOCAL_AI_ENGINES.map(item=>[item.provider,sharedClient(item)]));
export const grokLocal=services['grok-local'],codexLocal=services.codex,antigravityLocal=services.antigravity;
export const getLocalAiService=provider=>services[provider];
