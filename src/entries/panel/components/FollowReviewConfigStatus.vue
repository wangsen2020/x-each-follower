<template>
  <div class="review-config-status" :data-state="status.state" role="status" aria-live="polite">
    <div class="review-config-status-head"><span class="review-config-state">{{ t(status.label) }}</span><PanelIconButton :icon="Settings" :label="t('管理连接')" @click="configure" /></div>
    <p v-if="loaded && providerName">{{ t(providerName) }}<span v-if="sessionName"> · {{ sessionName }}</span><span v-else-if="config.botId"> · {{ t('独立会话已保存') }}</span></p>
    <p v-if="error" class="review-config-error">{{ t(error) }}</p>
    <p v-else-if="status.state==='unconfigured'">{{ t('AI 审核前请先配置引擎和独立会话。') }}</p>
  </div>
</template>
<script setup>
import {Settings} from 'lucide';
import PanelIconButton from './PanelIconButton.vue';
import {AI_CONNECTION_KEY} from '../../../features/grok/ai-connection-state.js';
import {computed,onMounted,onUnmounted,ref} from 'vue';
import {t} from '../../../shared/i18n.js';
import {requestBackground} from '../../../platform/background-request.js';
import {awaitSettingsResponse,FOLLOW_REVIEW_SETTINGS_UPDATED_EVENT,FOLLOW_REVIEW_ENGINE_OPTIONS,readFollowReviewSessions,followReviewBindingStatus} from '../follow-review-settings.js';
const props=defineProps({role:{type:String,default:'fanTagging'},request:{type:Function,default:requestBackground},inspect:{type:Function,default:readFollowReviewSessions},timeoutMs:{type:Number,default:8000}});
const config=ref({}),connection=ref({}),checking=ref(false),error=ref(''),loaded=ref(false);
let revision=0,disposed=false;
const status=computed(()=>!loaded.value ? {state:error.value?'error':'checking',label:error.value?'配置状态读取失败':'正在读取配置状态…'} : followReviewBindingStatus(config.value,connection.value));
const providerName=computed(()=>FOLLOW_REVIEW_ENGINE_OPTIONS.find(engine=>engine.value===config.value.provider)?.label||'');
const sessionName=computed(()=>connection.value.sessions?.find(session=>session.id===config.value.botId)?.name||'');
async function refresh(){
  const ticket=++revision;checking.value=true;error.value='';loaded.value=false;
  try{
    const result=await awaitSettingsResponse(()=>props.request({cmd:'followQueueReviewSettings'}),{timeoutMs:props.timeoutMs});
    if(disposed||ticket!==revision)return;
    if(!result?.ok)throw Error(result?.error||'审核设置读取失败');
    config.value=result.settings?.[props.role]||{};connection.value={loading:Boolean(config.value.provider&&config.value.botId)};loaded.value=true;
    if(!config.value.provider||!config.value.botId)return;
    const inspection=await awaitSettingsResponse(()=>props.inspect(config.value.provider),{timeoutMs:props.timeoutMs,message:'统一连接状态读取超时，请打开系统设置'});
    if(disposed||ticket!==revision)return;
    connection.value=inspection;error.value=inspection.error||inspection.reason||'';
  }catch(failure){if(!disposed&&ticket===revision){error.value=failure.message;connection.value={error:failure.message};}}
  finally{if(!disposed&&ticket===revision)checking.value=false;}
}
function configure(){document.dispatchEvent(new CustomEvent('xfollower:bind-grok-local',{detail:{provider:config.value.provider||'grok-local'}}));}
function connectionChanged(changes,area){if(area==='local'&&changes[AI_CONNECTION_KEY])void refresh();}
onMounted(()=>{globalThis.chrome?.storage?.onChanged?.addListener(connectionChanged);void refresh();document.addEventListener(FOLLOW_REVIEW_SETTINGS_UPDATED_EVENT,refresh);});
onUnmounted(()=>{globalThis.chrome?.storage?.onChanged?.removeListener(connectionChanged);disposed=true;revision++;document.removeEventListener(FOLLOW_REVIEW_SETTINGS_UPDATED_EVENT,refresh);});
</script>
<style scoped>
.review-config-status{font-size:12px;line-height:1.6;margin-top:8px;padding:8px 10px;border:1px solid #d8e3da;border-radius:6px;background:#f5f8f5;overflow-wrap:anywhere}.review-config-status-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.review-config-status-head button{font-size:12px;padding:3px 8px;flex-shrink:0}.review-config-state{font-weight:600}.review-config-status p{margin:3px 0 0;color:#62776b}.review-config-status[data-state="ready"] .review-config-state{color:#187349}.review-config-status[data-state="error"] .review-config-state,.review-config-error{color:#b42318!important}.review-config-status[data-state="saved"] .review-config-state,.review-config-status[data-state="checking"] .review-config-state{color:#96610c}
</style>
