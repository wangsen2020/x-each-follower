import {ref} from 'vue';
import {readGrokProvider,selectGrokProvider} from '../../../features/grok/grok-provider.js';
const provider=ref('grok'),pending=ref(false);
async function refresh(){provider.value=await readGrokProvider();}
async function select(value){const result=await selectGrokProvider(value);if(result.connectionRequired){pending.value=true;document.dispatchEvent(new CustomEvent('xfollower:bind-grok-bot'));}else{pending.value=false;await refresh();}return result;}
async function complete(){if(pending.value)await select('grok-bot');}
export const grokProviderController={provider,pending,refresh,select,complete,cancel:()=>{pending.value=false;}};
