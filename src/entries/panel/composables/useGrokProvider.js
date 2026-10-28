import {ref} from 'vue';
import {readGrokProvider,selectGrokProvider} from '../../../features/grok/grok-provider.js';
const provider=ref('grok'),pending=ref(false);
async function refresh(){provider.value=await readGrokProvider();}
async function select(value){const result=await selectGrokProvider(value);if(result.connectionRequired){pending.value=value;document.dispatchEvent(new CustomEvent(value==='grok-local'?'xfollower:bind-grok-local':'xfollower:bind-grok-bot'));}else{pending.value=false;await refresh();}return result;}
async function complete(value='grok-bot'){if(pending.value===value)await select(value);}
export const grokProviderController={provider,pending,refresh,select,complete,cancel:()=>{pending.value=false;}};
