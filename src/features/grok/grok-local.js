import {createAgentRelayClient} from './agent-relay-client.js';
export {LOCAL_AI_ENGINES,isLocalAiProvider,connectionUrl,createRelayRepository} from './agent-relay-client.js';
// Historical imports and IndexedDB name remain compatible with installed versions.
export const createGrokLocal=options=>createAgentRelayClient(options);
export const grokLocal=createAgentRelayClient();
export const codexLocal=createAgentRelayClient({engine:'codex'});
export const antigravityLocal=createAgentRelayClient({engine:'antigravity'});
export const getLocalAiService=provider=>({'grok-local':grokLocal,codex:codexLocal,antigravity:antigravityLocal})[provider];
