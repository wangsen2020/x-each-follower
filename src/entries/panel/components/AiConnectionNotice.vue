<template>
  <span ref="anchor" class="ai-connection-anchor"><span v-if="issues.length" class="ai-connection-dot" aria-hidden="true"></span></span>
  <Teleport to="body">
  <section v-if="issues.length && !dismissed" ref="notice" :style="position" class="ai-connection-notice" :aria-label="t('AI 连接提醒')" role="status" aria-live="polite">
    <header><strong>{{ t('AI 连接异常') }}</strong><PanelIconButton :icon="X" :label="t('收起提醒')" @click="dismissed=true" /></header>
    <div v-for="issue in issues" :key="issue.provider" class="ai-connection-issue">
      <strong>{{ label(issue.provider) }}</strong><p>{{ t(issue.reason || '连接暂不可用') }}</p>
      <div class="ai-connection-actions"><span>{{ countdown(issue) }}</span><PanelIconButton :icon="RefreshCw" :label="t('重试 AI 连接')" :disabled="busy || issue.state==='checking'" @click="retry(issue.provider)" /><PanelIconButton :icon="Settings" :label="t('管理连接')" @click="$emit('configure',issue.provider)" /></div>
    </div>
    <p v-if="error" class="ai-connection-error">{{ t(error) }}</p>
  </section>
  </Teleport>
</template>
<script setup>
import {computed,nextTick,onMounted,onUnmounted,ref,watch} from 'vue';
import {RefreshCw,Settings,X} from 'lucide';
import PanelIconButton from './PanelIconButton.vue';
import {t} from '../../../shared/i18n.js';
import {LOCAL_AI_ENGINES} from '../../../features/grok/agent-relay-client.js';
import {AI_CONNECTION_KEY,requestAiConnection} from '../../../features/grok/ai-connection-state.js';
const props=defineProps({request:{type:Function,default:requestAiConnection}});
defineEmits(['configure']);
const anchor=ref(null),notice=ref(null),position=ref({});
const states=ref({}),clock=ref(Date.now()),busy=ref(false),error=ref(''),dismissed=ref(false);
const issues=computed(()=>Object.values(states.value).filter(s=>s.state==='offline'||s.state==='checking'&&s.reason));
const label=provider=>LOCAL_AI_ENGINES.find(item=>item.provider===provider)?.label||provider;
const seconds=value=>Math.max(0,Math.ceil((Number(value)-clock.value)/1000));
const countdown=issue=>issue.state==='checking'?t('正在重试…'):seconds(issue.nextAt)>0?t('自动重试：{{v0}} 秒',{v0:seconds(issue.nextAt)}):t('等待自动重试…');
function update(value){const old=issues.value.map(s=>s.provider).join();states.value=value||{};if(old!==issues.value.map(s=>s.provider).join())dismissed.value=false;}
function changed(changes,area){if(area==='local'&&changes[AI_CONNECTION_KEY])update(changes[AI_CONNECTION_KEY].newValue);}
async function retry(provider){busy.value=true;error.value='';try{const value=await props.request({op:'retry',provider});update({...states.value,[provider]:value});}catch(e){error.value=e.message;}finally{busy.value=false;}}
function place(){const rect=anchor.value?.parentElement?.getBoundingClientRect();if(!rect)return;const height=notice.value?.offsetHeight||180,width=Math.min(310,innerWidth-32);position.value={left:Math.max(16,Math.min(rect.left,innerWidth-width-16))+'px',top:Math.max(8,Math.min(rect.top-height-10>8?rect.top-height-10:rect.bottom+10,innerHeight-height-8))+'px'};}
watch([issues,dismissed],()=>void nextTick(place));
let timer;
onMounted(()=>{window.addEventListener('resize',place);window.addEventListener('scroll',place,true);void props.request().then(update).catch(e=>{error.value=e.message;});globalThis.chrome?.storage?.onChanged?.addListener(changed);timer=setInterval(()=>{clock.value=Date.now();},1000);});
onUnmounted(()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);clearInterval(timer);globalThis.chrome?.storage?.onChanged?.removeListener(changed);});
defineExpose({show:()=>{dismissed.value=false;}});
</script>
<style scoped>
.ai-connection-anchor{position:absolute;inset:0;pointer-events:none}.ai-connection-dot{position:absolute;right:1px;top:1px;width:7px;height:7px;border-radius:50%;background:#d64335;pointer-events:none}
.ai-connection-notice{position:fixed;width:min(310px,calc(100vw - 32px));box-sizing:border-box;background:#fffaf4;border:1px solid #e2c6a5;border-radius:8px;padding:10px 12px;color:#513e28;font-size:12px;line-height:1.5;z-index:10020;text-align:left;max-height:60vh;overflow:auto}
.ai-connection-notice header,.ai-connection-actions{display:flex;align-items:center;gap:8px}.ai-connection-notice header{justify-content:space-between}.ai-connection-issue{margin-top:8px}.ai-connection-issue+.ai-connection-issue{padding-top:8px;border-top:1px solid #eadac7}.ai-connection-issue p{margin:4px 0;overflow-wrap:anywhere}.ai-connection-actions span{flex:1;font-variant-numeric:tabular-nums}.ai-connection-error{color:#b42318}.ai-connection-notice :deep(button){flex-shrink:0;width:28px;height:28px;padding:0}
</style>
