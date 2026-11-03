<template>
  <Teleport to="body">
    <dialog v-if="isOpen" id="followReviewSettingsDialog" ref="dialog" class="follow-review-settings" aria-modal="true" aria-labelledby="followReviewSettingsTitle" @cancel.prevent="close" @keydown.esc.stop.prevent="close" @click="backdrop">
      <header><strong id="followReviewSettingsTitle">{{ t(scope==='fans' ? '粉丝初审与 AI 打标' : '关注队列审核与评论') }}</strong><PanelCloseButton :label="t('关闭审核设置')" :disabled="saving" @click="close" /></header>
      <div class="follow-review-body" :aria-busy="loading">
        <p v-if="loading" role="status">{{ t('正在读取审核设置…') }}</p>
        <div v-else-if="!loaded" class="follow-review-load-error"><p role="alert">{{ t(error) }}</p><button type="button" class="secondary" @click="load">{{ t('重新加载') }}</button></div>
        <template v-else>
          <div class="follow-review-switch">
            <label v-if="scope==='fans'" for="fan-initial-review"><input id="fan-initial-review" v-model="draft.initialReviewEnabled" type="checkbox" :disabled="saving">{{ t('待回关初审') }}</label>
            <label v-else for="queue-follow-back-skip"><input id="queue-follow-back-skip" v-model="draft.followBackSkipRules" type="checkbox" :disabled="saving">{{ t('跳过粉丝') }}</label>
            <InfoTip :text="scope==='fans' ? FOLLOW_REVIEW_TIPS.initialReviewEnabled : FOLLOW_REVIEW_TIPS.followBackSkipRules" :label="scope==='fans' ? '待回关初审说明' : '跳过粉丝说明'" />
          </div>
          <section v-if="scope==='fans'" class="follow-review-removal">
            <h3>{{ t('移除规则') }}</h3>
            <div class="follow-review-switch"><label for="fan-block-suggestive"><input id="fan-block-suggestive" v-model="draft.removalRules.blockSuggestive" type="checkbox" :disabled="saving">{{ t('拦截擦边') }}</label><InfoTip text="默认关闭。开启后，关键词与 AI 审核识别到有内容依据的色情低俗或性暗示引流时，加入自动移除队列。" /></div>
            <div class="follow-review-switch"><label for="fan-block-empty"><input id="fan-block-empty" v-model="draft.removalRules.blockEmpty" type="checkbox" :disabled="saving">{{ t('拦截空号') }}</label><InfoTip text="默认关闭。开启后，核实确认简介和帖子都为空时移除；关闭时按该项放行。抓取失败、限流或私密账号不视为空号。" /></div>
          </section>
          <section v-if="scope==='fans'" class="follow-review-automation">
            <div v-for="task in automationTasks" :key="task.key" class="automation-task">
              <label class="automation-toggle" :for="'fan-auto-'+task.key"><input :id="'fan-auto-'+task.key" v-model="draft.automation[task.key].enabled" type="checkbox" :disabled="saving">{{ t(task.label) }}</label>
              <InfoTip :text="task.tip" />
              <div class="follow-review-fields">
                <label :for="'fan-auto-'+task.key+'-interval'">{{ t('检查间隔（分钟）') }}<input :id="'fan-auto-'+task.key+'-interval'" v-model.number="draft.automation[task.key].intervalMinutes" type="number" min="1" max="60" :disabled="saving"></label>
                <label :for="'fan-auto-'+task.key+'-limit'">{{ t('每轮上限（人）') }}<input :id="'fan-auto-'+task.key+'-limit'" v-model.number="draft.automation[task.key].limit" type="number" min="1" max="50" :disabled="saving"></label>
                <label v-if="task.key==='verify'" for="fan-auto-verify-retry">{{ t('同一账号重试间隔（分钟）') }}<input id="fan-auto-verify-retry" v-model.number="draft.automation.verify.retryMinutes" type="number" min="5" max="1440" :disabled="saving"></label>
              </div>
              <p class="follow-review-note" role="status">{{ automationText(task.key) }}</p>
            </div>
          </section>
          <div v-if="scope==='queue'" class="follow-review-ratio"><label for="review-ratio-limit">{{ t('异常关注比例') }}</label><input id="review-ratio-limit" v-model.number="draft.ratioLimit" type="number" min="1" max="1000" step="1" :disabled="saving"><span>{{ t('倍') }}</span><InfoTip text="关注数超过粉丝数的此倍数时触发移除过滤；与优先权重评分分开。跳过粉丝生效时不执行此过滤。" label="异常比例过滤说明" /></div>
          <section v-for="role in visibleRoles" :key="role.key" class="follow-review-engine" :aria-labelledby="`review-${role.key}-title`">
            <h3 :id="`review-${role.key}-title`">{{ t(role.label) }} <span class="review-binding-badge" :data-state="bindingStatus(role.key).state" role="status">{{ t(bindingStatus(role.key).label) }}</span></h3>
            <p class="follow-review-note">{{ t(role.description) }}</p>
            <div class="follow-review-fields">
              <label :for="`review-${role.key}-provider`">{{ t('AI 引擎') }}<PanelSelect :id="`review-${role.key}-provider`" v-model="draft[role.key].provider" :disabled="saving" @change="providerChanged(role.key)"><option value="">{{ t('尚未配置') }}</option><option v-for="engine in FOLLOW_REVIEW_ENGINE_OPTIONS" :key="engine.value" :value="engine.value">{{ t(engine.label) }}</option></PanelSelect></label>
              <label :for="`review-${role.key}-session`">{{ t('独立会话') }}<PanelSelect :id="`review-${role.key}-session`" v-model="draft[role.key].botId" :disabled="saving || states[role.key].loading || !states[role.key].connected || !states[role.key].supported" :title="sessionTitle(role.key)"><option value="">{{ t('请选择会话') }}</option><option v-if="unavailableSelection(role.key)" :value="draft[role.key].botId" disabled>{{ t('已保存的会话不可用，请重新选择') }}</option><option v-for="session in states[role.key].sessions" :key="session.id" :value="session.id" :title="session.title">{{ session.name }}</option></PanelSelect></label>
            </div>
            <div class="follow-review-connection">
              <p :role="states[role.key].error ? 'alert' : 'status'" :class="{'follow-review-error':states[role.key].error}">{{ t(engineMessage(role.key)) }}</p>
              <div class="follow-review-connection-actions"><PanelIconButton :icon="Settings" :label="t('管理连接')" :disabled="saving" @click="configure(role.key)" /></div>
            </div>
            <p v-if="sessionTitle(role.key)" class="follow-review-session-title">{{ sessionTitle(role.key) }}</p>
            <div v-if="role.key!=='commentEngine'" class="follow-review-fields follow-review-batch">
              <label :for="`review-${role.key}-batch`"><span>{{ t('每批上限') }} <InfoTip v-if="role.key==='fanTagging'" text="初审与人工 AI 审核共用此上限。人工审核按完整提示词长度自动拆批，不截断原始资料；实际人数可能少于上限。通过自动入队，不通过执行移除，资料不足进入待核实。" /></span><input :id="`review-${role.key}-batch`" v-model.number="draft[role.key].batchSize" type="number" min="1" max="50" step="1" :disabled="saving"></label>
              <fieldset v-if="role.key==='fanTagging'" class="follow-review-interval"><legend>{{ t('批次间隔（秒）') }} <InfoTip text="收到本批结果后，在最短与最长间隔之间随机等待，再提交下一批；同一任务串行执行。两端相同为固定间隔，均为 0 时立即继续。停止等待会保留进度，继续时仍遵守原定时间。" /></legend><div><input :id="`review-${role.key}-interval`" v-model.number="draft[role.key].intervalSeconds" :aria-label="t('最短间隔')" type="number" min="0" max="300" step="1" :disabled="saving"><span aria-hidden="true">–</span><input :id="`review-${role.key}-interval-max`" v-model.number="draft[role.key].intervalMaxSeconds" :aria-label="t('最长间隔')" type="number" min="0" max="300" step="1" :disabled="saving"></div></fieldset>
              <label v-else :for="`review-${role.key}-interval`">{{ t('批次间隔（秒）') }}<input :id="`review-${role.key}-interval`" v-model.number="draft[role.key].intervalSeconds" type="number" min="0" max="300" step="1" :disabled="saving"></label>
            </div>
            <label class="follow-review-prompt" :for="`review-${role.key}-prompt`">{{ t(role.key==='commentEngine' ? '评论提示词' : '审核规则与提示词') }}<textarea :id="`review-${role.key}-prompt`" v-model="draft[role.key].prompt" rows="5" maxlength="6000" :disabled="saving" :placeholder="t('留空使用默认模板')"></textarea></label>
            <PanelIconButton :icon="RotateCcw" :label="t('恢复默认模板')" :disabled="saving || !draft[role.key].prompt" @click="restorePrompt(role.key)" />
            <p class="follow-review-note">{{ t('只保存本项引擎与会话，不改变系统默认引擎或其他任务配置。') }}</p>
          </section>
        </template>
        <p v-if="loaded && error" class="follow-review-error" role="alert">{{ t(error) }}</p>
        <p v-if="notice" class="follow-review-notice" role="status">{{ t(notice) }}</p>
      </div>
      <footer><span v-if="saving" role="status">{{ t(savePhase==='checking' ? '正在读取连接状态…' : '保存中…') }}</span><PanelIconButton id="saveFollowReviewSettings" :icon="Save" :label="t('保存设置')" :disabled="saving || !loaded" @click="save" /></footer>
    </dialog>
  </Teleport>
</template>

<script setup>
import {AI_CONNECTION_KEY} from '../../../features/grok/ai-connection-state.js';
import {computed, nextTick, onMounted, onUnmounted, reactive, ref} from 'vue';
import {t} from '../../../shared/i18n.js';
import {Settings, RotateCcw, Save} from 'lucide';
import PanelIconButton from './PanelIconButton.vue';
import {requestBackground} from '../../../platform/background-request.js';
import {FOLLOW_REVIEW_ENGINE_OPTIONS, FOLLOW_REVIEW_SETTINGS_EVENT, FOLLOW_REVIEW_SETTINGS_UPDATED_EVENT, FOLLOW_REVIEW_TIPS,
  normalizeFollowReviewSettings, saveFollowReviewSettings, validateFollowReviewSettings, readFollowReviewSessions,awaitSettingsResponse,followReviewBindingStatus} from '../follow-review-settings.js';
import PanelCloseButton from './PanelCloseButton.vue';
import PanelSelect from './PanelSelect.vue';
import InfoTip from './InfoTip.vue';

const props=defineProps({request:{type:Function,default:requestBackground},inspect:{type:Function,default:readFollowReviewSessions},timeoutMs:{type:Number,default:8000}});
const dialog=ref(null),isOpen=ref(false),scope=ref('fans'),loading=ref(false),loaded=ref(false),saving=ref(false),error=ref(''),notice=ref('');
const draft=reactive(normalizeFollowReviewSettings());
const savedSettings=ref(normalizeFollowReviewSettings()),savePhase=ref(''),automationStatus=ref({});
const automationTasks=[{key:'review',label:'待审核自动审核',tip:'默认开启。按配置检查待审核账号，复用已有画像和帖子；通过自动加入待回关与关注队列，不通过移除关注者，资料不足进入待核实。'},
 {key:'verify',label:'待核实自动核实',tip:'默认开启。补充画像及前 10 条帖子，已有缓存优先复用；补采完成后回到待审核。遵守全局访问预算，资料仍不足时按重试间隔等待。'}];
function automationText(key){const value=automationStatus.value?.[key];if(!draft.automation[key].enabled)return t('自动调度已关闭');if(!value)return t('保存后按计划执行');if(value.error)return value.error;const labels={disabled:'自动调度已关闭',configuration:'等待配置 AI 引擎',manual:'等待手动任务结束',running:'正在自动处理',checking:'正在检查待处理账号',idle:'等待下一次检查',waiting:'等待恢复'};return t(labels[value.stage]||'等待下一次检查')+(value.nextAt?' · '+t('下次检查')+' '+new Date(value.nextAt).toLocaleTimeString(): '');}
const roles=[{key:'fanTagging',label:'初审 AI 打标',description:'通过后自动入队；不通过移除关注者；资料不足进入待核实。已有简介或有效帖子即可审核。'},
  {key:'queueTagging',label:'队列 AI 打标',description:'在本地过滤通过后，分析主页资料和前 10 条帖子。与粉丝初审使用不同的会话。'},
  {key:'commentEngine',label:'评论引擎',description:'通过准入流程后生成评论或引用评价。使用专用会话，避免与打标上下文混淆。'}];
const visibleRoles=computed(()=>roles.filter(role=>scope.value==='fans' ? role.key==='fanTagging' : role.key!=='fanTagging'));
const emptyState=()=>({loading:false,connected:false,supported:true,sessions:[],reason:'',error:''});
const states=reactive(Object.fromEntries(roles.map(role=>[role.key,emptyState()])));
const roleRevision={fanTagging:0,queueTagging:0,commentEngine:0};
let generation=0,opener;

function close(){if(saving.value)return;generation++;for(const role of roles)roleRevision[role.key]++;dialog.value?.close();isOpen.value=false;opener?.focus?.();}
function backdrop(event){if(event.target!==dialog.value)return;const r=dialog.value.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}
async function open(event){if(saving.value)return;scope.value=event?.detail?.scope==='queue'?'queue':'fans';opener=document.activeElement;isOpen.value=true;notice.value='';error.value='';await nextTick();if(!isOpen.value||!dialog.value)return;if(!dialog.value.open)dialog.value.showModal();await load();}
async function load(){const ticket=++generation;loading.value=true;loaded.value=false;error.value='';try{const result=await awaitSettingsResponse(()=>props.request({cmd:'followQueueReviewSettings'}),{timeoutMs:props.timeoutMs});if(ticket!==generation||!isOpen.value)return;if(!result?.ok)throw Error(result?.error||'审核设置读取失败');Object.assign(draft,normalizeFollowReviewSettings(result.settings));automationStatus.value=result.automationStatus||{};savedSettings.value=normalizeFollowReviewSettings(result.settings);for(const role of roles)Object.assign(states[role.key],emptyState());loaded.value=true;void Promise.all(visibleRoles.value.map(role=>refreshRole(role.key)));}catch(e){if(ticket===generation)error.value=e.message;}finally{if(ticket===generation)loading.value=false;}}
async function refreshRole(key){const ticket=++roleRevision[key],epoch=generation,provider=draft[key].provider;Object.assign(states[key],emptyState(),{loading:true});try{const result=await awaitSettingsResponse(()=>props.inspect(provider),{timeoutMs:props.timeoutMs,message:'统一连接状态读取超时，请打开系统设置'});if(ticket!==roleRevision[key]||epoch!==generation||provider!==draft[key].provider)return;Object.assign(states[key],result);}catch(e){if(ticket===roleRevision[key]&&epoch===generation)states[key].error=e.message;}finally{if(ticket===roleRevision[key]&&epoch===generation)states[key].loading=false;}}
function providerChanged(key){draft[key].botId='';error.value='';notice.value='';void refreshRole(key);}
function restorePrompt(key){draft[key].prompt='';error.value='';notice.value='已恢复默认模板，保存后生效';}
function sessionTitle(key){return states[key].sessions.find(row=>row.id===draft[key].botId)?.title||'';}
function unavailableSelection(key){return !states[key].loading && draft[key].botId && !states[key].sessions.some(row=>row.id===draft[key].botId);}
function engineMessage(key){const state=states[key];if(state.loading)return '正在读取连接状态…';if(state.error)return state.error;if(!draft[key].provider)return '尚未配置；需要此引擎的任务会等待配置。';return state.reason||(state.connected ? state.sessions.some(session=>session.id===draft[key].botId) ? '当前独立会话可用' : '连接可用，请选择独立会话':'尚未连接');}
function bindingStatus(key){return followReviewBindingStatus(savedSettings.value[key],states[key],JSON.stringify(draft[key])!==JSON.stringify(savedSettings.value[key]));}
function configure(key){const provider=draft[key].provider;if(provider==='grok-bot')document.dispatchEvent(new CustomEvent('xfollower:bind-grok-bot'));else document.dispatchEvent(new CustomEvent('xfollower:bind-grok-local',{detail:{provider:['grok-local','codex','antigravity'].includes(provider)?provider:'grok-local'}}));}
async function save(){if(saving.value)return;saving.value=true;savePhase.value='checking';error.value='';notice.value='';try{const settings=validateFollowReviewSettings(draft);const configured=visibleRoles.value.filter(role=>settings[role.key].provider&&JSON.stringify(settings[role.key])!==JSON.stringify(savedSettings.value[role.key]));await Promise.all(configured.map(role=>refreshRole(role.key)));for(const role of configured){const state=states[role.key];if(state.error)throw Error(state.error);if(!state.supported)throw Error(state.reason);if(!state.connected)throw Error('请先在系统设置连接并测试所选 AI 引擎');if(!state.sessions.some(row=>row.id===settings[role.key].botId))throw Error('所选会话不可用，请在系统设置刷新会话');}savePhase.value='saving';const result=await saveFollowReviewSettings(settings,scope.value,props.request,{timeoutMs:props.timeoutMs});if(result.settings)Object.assign(draft,normalizeFollowReviewSettings(result.settings));savedSettings.value=normalizeFollowReviewSettings(result.settings||settings);notice.value='设置已保存';document.dispatchEvent(new CustomEvent(FOLLOW_REVIEW_SETTINGS_UPDATED_EVENT,{detail:{scope:scope.value}}));}catch(e){error.value=e.message;}finally{saving.value=false;savePhase.value='';}}
function connectionChanged(changes,area){if(isOpen.value&&area==='local'&&changes[AI_CONNECTION_KEY])void Promise.all(visibleRoles.value.map(role=>refreshRole(role.key)));}
onMounted(()=>{document.addEventListener(FOLLOW_REVIEW_SETTINGS_EVENT,open);globalThis.chrome?.storage?.onChanged?.addListener(connectionChanged);});
onUnmounted(()=>{globalThis.chrome?.storage?.onChanged?.removeListener(connectionChanged);document.removeEventListener(FOLLOW_REVIEW_SETTINGS_EVENT,open);generation++;for(const role of roles)roleRevision[role.key]++;});
defineExpose({open:entry=>open({detail:{scope:entry}}),close});
</script>

<style scoped>
.follow-review-settings{width:min(700px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:calc(100dvh - 32px);margin:auto;padding:0;box-sizing:border-box;border:1px solid #dce6de;border-radius:10px;background:#fff;color:#18302e;overflow:hidden;font-size:12px;line-height:1.6;box-shadow:0 16px 50px #18302e30}.follow-review-settings[open]{display:flex;flex-direction:column}.follow-review-settings::backdrop{background:#0e1c1673}.follow-review-settings header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;border-bottom:1px solid #dce6de;flex-shrink:0}.follow-review-settings header strong{font-size:14px;min-width:0;overflow-wrap:anywhere}.follow-review-body{overflow:auto;min-height:0;padding:14px 16px}.follow-review-body p{margin:0;overflow-wrap:anywhere}.follow-review-switch,.follow-review-switch label,.follow-review-ratio{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.follow-review-switch label{cursor:pointer}.follow-review-switch input{margin:0}.follow-review-ratio{margin-top:12px}.follow-review-ratio input{width:76px;min-width:0}.follow-review-engine{border-top:1px solid #e4ece6;margin-top:16px;padding-top:12px}.follow-review-engine h3{margin:0 0 4px;font-size:13px;color:#24594a}.follow-review-note{color:#60756b}.follow-review-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:12px}.follow-review-fields label,.follow-review-prompt{display:flex;flex-direction:column;gap:4px;min-width:0}.follow-review-fields select,.follow-review-fields input,.follow-review-prompt textarea{box-sizing:border-box;width:100%;min-width:0;font:inherit}.follow-review-fields select{height:32px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.follow-review-fields input,.follow-review-ratio input{height:32px;box-sizing:border-box;font:inherit}.follow-review-prompt{margin:12px 0 6px}.follow-review-prompt textarea{padding:8px;resize:vertical;min-height:90px;max-height:300px;line-height:1.6}.follow-review-connection{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:8px}.follow-review-connection>p{flex:1;min-width:180px;color:#60756b}.follow-review-connection-actions{display:flex;gap:8px;flex-wrap:wrap}.follow-review-session-title{margin-top:6px!important;word-break:break-word;color:#365e4d}.follow-review-error{color:#b42318!important;margin-top:10px!important}.follow-review-notice{color:#256047;margin-top:10px!important}.follow-review-settings footer{display:flex;justify-content:flex-end;gap:10px;padding:12px 16px;border-top:1px solid #dce6de;flex-shrink:0}.follow-review-load-error{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.follow-review-settings :is(input,select,textarea,button):focus-visible{outline:2px solid #14744c;outline-offset:2px}@media(max-width:520px){.follow-review-settings{max-height:calc(100dvh - 20px);width:calc(100vw - 16px);max-width:calc(100vw - 16px)}.follow-review-fields{grid-template-columns:minmax(0,1fr)}.follow-review-batch{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.follow-review-body{padding:12px}.follow-review-settings header,.follow-review-settings footer{padding:10px 12px}.follow-review-connection>p{min-width:100%}.follow-review-settings footer{align-items:center}}@media(pointer:coarse){.follow-review-settings button,.follow-review-fields select,.follow-review-fields input,.follow-review-ratio input{min-height:40px}}
.follow-review-automation{margin-top:14px}.automation-task{border-top:1px solid #e4ece6;padding:12px 0}.automation-toggle{display:inline-flex;gap:8px;align-items:center;font-weight:600}.automation-task .follow-review-note{margin-top:8px}
</style>
<style scoped>
.follow-review-switch label{flex-direction:row}
.follow-review-removal{margin-top:14px;padding-top:12px;border-top:1px solid #e4ece6}.follow-review-removal h3{margin:0 0 8px;font-size:13px;color:#24594a}.follow-review-removal .follow-review-switch+.follow-review-switch{margin-top:8px}
.follow-review-fields select{padding-top:4px;padding-bottom:4px;line-height:normal}
.review-binding-badge{display:inline-block;margin-left:8px;font-size:12px;font-weight:400;color:#62776b}.review-binding-badge[data-state="ready"]{color:#187349}.review-binding-badge[data-state="error"]{color:#b42318}.review-binding-badge[data-state="unsaved"],.review-binding-badge[data-state="checking"],.review-binding-badge[data-state="saved"]{color:#96610c}
.follow-review-interval{border:0;margin:0;padding:0;min-width:0}.follow-review-interval legend{padding:0;margin-bottom:4px}.follow-review-interval>div{display:flex;align-items:center;gap:6px}.follow-review-interval input{min-width:0;flex:1}.follow-review-batch{align-items:end}
</style>
