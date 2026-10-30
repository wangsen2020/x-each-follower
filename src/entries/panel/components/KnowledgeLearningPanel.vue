<template>
  <section class="learning-panel" aria-label="自动学习执行情况">
    <div class="learning-line"><strong>每日总结</strong><span>{{ state?.config.enabled ? '每日 '+String(state.config.hour).padStart(2,'0')+':00' : '未开启' }}</span><span class="learning-result">{{ resultLabel(state?.daily) }}</span><button type="button" class="secondary" :disabled="busy || pending?.status==='failed'" @click="act('run')">{{ busy ? '处理中…' : pending ? '查询原任务' : '立即总结' }}</button></div>
    <div class="learning-line"><strong>每周合并</strong><span>{{ state?.config.weeklyEnabled ? days[state.config.weeklyDay]+' '+String(state.config.weeklyHour).padStart(2,'0')+':00' : '未开启' }}</span><span class="learning-result">{{ resultLabel(state?.weekly) }}</span><button type="button" class="secondary" :disabled="busy" @click="act('weekly')">立即合并</button><button type="button" class="secondary" @click="openLogs">执行记录</button></div>
    <p v-if="error" role="alert" class="learning-error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <PanelModal ref="logsModal" title="知识库执行记录" @close="logsOpen=false">
      <template #actions><PanelPager :page="history.page" :page-size="history.pageSize" :total="history.total" :busy="historyBusy" label="执行记录分页" @page="page=>loadHistory(page)" @size="size=>loadHistory(1,size)" /></template>
      <div class="learning-line"><button v-for="tab in logTabs" :key="tab.key" type="button" class="secondary" :aria-pressed="scope===tab.key" @click="scope=tab.key;loadHistory(1)">{{ tab.label }}</button></div>
      <div class="learning-log-table"><table><thead><tr><th>时间</th><th>任务</th><th>状态</th><th>产出</th><th>详情</th></tr></thead><tbody><tr v-for="row in history.items" :key="row.id"><td>{{ date(row.at) }}</td><td>{{ row.kind==='daily'?'每日总结':row.kind==='weekly'?'每周合并':'手动合入' }}</td><td>{{ status(row.status) }}</td><td>{{ row.version ? '智慧 v'+row.version+' · 合入 '+row.inputCount+' 条' : row.result?.merged===0 ? '无需合并' : row.result ? '新增 '+(row.result.knowledgeCreated||0)+' / 复用 '+(row.result.knowledgeReused||0) : '—' }}</td><td><PanelIconButton :icon="Eye" label="查看执行过程" @click="selectedLog=row" /></td></tr></tbody></table></div>
      <p v-if="!history.total">暂无执行记录。</p>
      <section v-if="selectedLog" class="learning-process"><strong>执行过程 · {{ date(selectedLog.at) }}</strong><p>本次处理 {{ selectedLog.inputCount }} 条材料<span v-if="selectedLog.remainingCount">，剩余 {{ selectedLog.remainingCount }} 条待合入</span></p><p v-if="selectedLog.result?.note">{{ selectedLog.result.note }}</p><ol><li v-for="(step,index) in selectedLog.steps" :key="index">{{ date(step.at) }} · {{ stageLabel(step.stage,selectedLog.kind) }}<span v-if="step.detail"> · {{ step.detail }}</span></li></ol><p v-if="!selectedLog.steps.length">历史任务未记录分阶段过程。</p><p v-if="selectedLog.error" class="learning-error">{{ selectedLog.error }}</p><button v-if="pending?.id===selectedLog.id" type="button" class="secondary" :disabled="busy" @click="act('cancel',{id:selectedLog.id})">终止任务</button></section>
      <p v-if="historyError" class="learning-error" role="alert">{{ historyError }}</p>
    </PanelModal>
    <ActionSettingsDrawer ref="drawer" title="自动学习设置">
      <div class="learning-settings">
        <label><input v-model="draft.enabled" type="checkbox">每日总结<InfoTip text="只在有新增成熟样本时生成经验。浏览器关闭时暂停，恢复后合并检查。" /></label>
        <label>时间 <PanelSelect v-model.number="draft.hour" aria-label="每日总结时间"><option v-for="hour in 24" :key="hour" :value="hour-1">{{ String(hour-1).padStart(2,'0') }}:00</option></PanelSelect></label>
        <label><input v-model="draft.weeklyEnabled" type="checkbox">每周合并<InfoTip text="将待合入经验融合成新的Markdown写作Skill，自动保存并设为使用。可以随时在智慧版本弹窗选择其他版本。存在冲突时暂停，等待人工处理。" /></label>
        <label>时间 <PanelSelect v-model.number="draft.weeklyDay" aria-label="每周合并星期"><option v-for="(day,i) in days" :key="i" :value="i">{{ day }}</option></PanelSelect><PanelSelect v-model.number="draft.weeklyHour" aria-label="每周合并时间"><option v-for="hour in 24" :key="hour" :value="hour-1">{{ String(hour-1).padStart(2,'0') }}:00</option></PanelSelect></label>
        <label><input v-model="draft.writingKnowledgeEnabled" type="checkbox">生成时使用当前智慧<InfoTip text="开启后，面板评论与关注队列的引用/回复在生成时参考当前选中的智慧版本。文章、原创与测试连接不使用。经验需先合入智慧。" /></label>
        <p class="learning-hint">北京时间 · 下次总结 {{ draft.enabled ? date(state?.config.nextAt) : '未安排' }} · 下次合并 {{ draft.weeklyEnabled ? date(state?.config.nextMergeAt) : '未安排' }}</p>
        <label>每日预算 <PanelSelect v-model.number="draft.dailyBudget" aria-label="每日整理预算"><option v-for="n in 5" :key="n" :value="n">{{ n }} 次</option></PanelSelect><InfoTip text="经验总结和智慧融合共用预算。查询、选择智慧、手动编辑保存均不增加AI调用。" /></label>
        <label class="learning-engine">AI 引擎<PanelSelect v-model="draft.generationProvider" @change="changeEngine"><option v-for="item in LOCAL_AI_ENGINES" :key="item.provider" :value="item.provider">{{ item.label }}</option></PanelSelect></label><label class="learning-engine">生成会话<PanelSelect id="knowledge-session" class="ai-session-select" :title="localBots.find(item=>item.id===draft.bot)?.title||draft.botName" v-model="draft.bot" :disabled="!localBots.length" @change="draft.botName=localBots.find(item=>item.id===draft.bot)?.name||''"><option value="">请选择会话</option><option v-if="draft.bot&&!localBots.some(item=>item.id===draft.bot)" :value="draft.bot">{{ draft.botName||'已保存的会话' }}（待确认）</option><option v-for="item in localBots" :key="item.id" :value="item.id" :title="item.title||item.name">{{ item.name }}</option></PanelSelect></label><div class="learning-engine-actions"><button type="button" class="secondary" @click="configureEngine">管理连接</button><button type="button" class="secondary" @click="refreshEngine">重新检测</button></div>
        <p class="learning-hint">今日已用 {{ state?.budgetUsed || 0 }} / {{ state?.config.dailyBudget || 2 }} 次</p>
        <p v-if="settingsError" role="alert" class="learning-error">{{ settingsError }}</p>
      </div>
      <template #footer><button type="button" class="secondary" @click="drawer?.close()">取消</button><button type="button" :disabled="busy" @click="save">保存</button></template>
    </ActionSettingsDrawer>
  </section>
</template>
<script setup>
import PanelSelect from "./PanelSelect.vue";
import InfoTip from './InfoTip.vue';
import {computed,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {Eye} from 'lucide';
import ActionSettingsDrawer from './ActionSettingsDrawer.vue';
import PanelModal from './PanelModal.vue';
import PanelPager from './PanelPager.vue';
import PanelIconButton from './PanelIconButton.vue';
import {getLocalAiService,LOCAL_AI_ENGINES} from '../../../features/grok/grok-local.js';
const props=defineProps({ownerId:{type:String,required:true}}),emit=defineEmits(['updated']);
const state=ref(null),error=ref(''),notice=ref(''),settingsError=ref(''),busy=ref(false),drawer=ref(null),localBot=ref(null),localBots=ref([]),draft=reactive({});
const logsModal=ref(null),logsOpen=ref(false),history=ref({items:[],page:1,pageSize:10,total:0}),historyBusy=ref(false),historyError=ref(''),scope=ref('all'),selectedLog=ref(null);
const days=['周日','周一','周二','周三','周四','周五','周六'],logTabs=[{key:'all',label:'全部'},{key:'daily',label:'每日总结'},{key:'weekly',label:'每周合并'}];
let sequence=0,historySequence=0;
const pending=computed(()=>state.value?.runs.find(r=>['prepared','submitted','result_saved','failed'].includes(r.status)));
const date=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'暂无';
const status=value=>({prepared:'准备中',submitted:'等待AI回复',result_saved:'结果已接收',ready:'待保存',committed:'已保存智慧',completed:'已完成',failed:'需处理',skipped:'已跳过',cancelled:'已终止'}[value]||value);
const stageLabel=(value,kind)=>({prepared:kind==='daily'?'准备分析样本':'准备智慧与经验',submitted:'提交AI任务',result_saved:'接收AI完整结果',ready:'校验合并结果',committed:'保存智慧并设为使用',completed:kind==='weekly'?'本周检查完成':'经验与来源入库',failed:'执行异常',cancelled:'任务已终止'}[value]||status(value));
const resultLabel=row=>!row?'暂无执行':date(row.at)+' · '+status(row.status)+(row.version?' v'+row.version+' · 合入 '+row.inputCount+' 条':row.result?.merged===0?' · 无需合并':row.result?.knowledgeCreated!=null?' · 新增 '+row.result.knowledgeCreated+' 条':'');
async function request(action,extra={}){const r=await chrome.runtime.sendMessage({cmd:'knowledgeLearning',action,...extra});if(!r?.ok)throw Error(r?.error||'无法读取自动学习状态');return r;}
async function refresh(){const ticket=++sequence,id=props.ownerId;try{const result=await request('state');if(ticket===sequence&&id===props.ownerId&&result.config.ownerId===id){const before=state.value?.runs.map(r=>r.id+':'+r.status).join('|');state.value=result;if(before&&before!==result.runs.map(r=>r.id+':'+r.status).join('|'))emit('updated');}}catch(e){if(ticket===sequence)error.value=e.message;}}
async function loadHistory(page=1,pageSize=history.value.pageSize,reset=true){const ticket=++historySequence,id=props.ownerId;historyBusy.value=true;historyError.value='';try{const r=await request('history',{page,pageSize,scope:scope.value});if(ticket===historySequence&&id===props.ownerId){history.value=r;selectedLog.value=reset?null:r.items.find(i=>i.id===selectedLog.value?.id)||null;}}catch(e){if(ticket===historySequence)historyError.value=e.message;}finally{if(ticket===historySequence)historyBusy.value=false;}}
async function openLogs(){logsOpen.value=true;await loadHistory(1);logsModal.value?.open();}
async function act(action,extra={}){busy.value=true;error.value='';notice.value='';try{const id=props.ownerId;const result=await request(action,extra);if(id!==props.ownerId)return;state.value=result;notice.value=result.empty?'没有新的可处理材料':result.pending?'原任务已保留，稍后继续查询':result.blocked?'有待处理事项，请查看执行记录':'本次执行完成';emit('updated');}catch(e){error.value=e.message;}finally{busy.value=false;await refresh();if(logsOpen.value)await loadHistory(history.value.page,history.value.pageSize,false);}}
async function open(){await refresh();Object.assign(draft,{weeklyEnabled:false,weeklyDay:0,weeklyHour:22,generationProvider:'grok-local'},state.value?.config||{});settingsError.value='';await refreshEngine();drawer.value?.open();}
let engineRevision=0;
async function refreshEngine(){const ticket=++engineRevision;localBots.value=[];try{const service=getLocalAiService(draft.generationProvider),status=await service.status();const rows=status.enabled?await service.list(await service.configuration()):[];if(ticket!==engineRevision)return;localBot.value=status;localBots.value=rows;if(!status.enabled)settingsError.value='请先连接并测试所选 AI 引擎';else settingsError.value='';}catch(e){if(ticket===engineRevision)settingsError.value=e.message;}}
async function changeEngine(){draft.bot='';draft.botName='';await refreshEngine();}
function configureEngine(){document.dispatchEvent(new CustomEvent('xfollower:bind-grok-local',{detail:{provider:draft.generationProvider}}));}
async function save(){busy.value=true;try{state.value=await request('save',{config:{...draft}});drawer.value?.close();notice.value='自动学习设置已保存';}catch(e){settingsError.value=e.message;}finally{busy.value=false;}}
watch(()=>props.ownerId,()=>{++sequence;++historySequence;state.value=null;error.value='';drawer.value?.close();logsModal.value?.close();history.value={items:[],page:1,pageSize:10,total:0};selectedLog.value=null;if(props.ownerId)refresh();},{immediate:true});
const timer=setInterval(async()=>{if(!busy.value&&props.ownerId){await refresh();if(logsOpen.value)await loadHistory(history.value.page,history.value.pageSize,false);}},15000);
onBeforeUnmount(()=>{clearInterval(timer);++sequence;++historySequence;});
defineExpose({open});
</script>
<style scoped>
.learning-panel{display:flex;flex-direction:column;gap:10px;min-width:0;font-size:12px}.learning-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.learning-panel p{margin:0;overflow-wrap:anywhere}.learning-result,.learning-hint{color:#64766c}.learning-error{color:#a52f2f}.learning-settings{display:grid;gap:10px}.learning-settings label{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.learning-log-table{overflow-x:auto}.learning-log-table table{width:100%;border-collapse:collapse;font-size:12px}.learning-log-table th,.learning-log-table td{padding:10px;border-bottom:1px solid #e4ece6;text-align:left;white-space:nowrap}.learning-log-table th{background:#f8faf8}.learning-line button[aria-pressed=true]{background:#285d49;color:white}.learning-process{display:flex;flex-direction:column;gap:10px;padding:10px;border:1px solid #dce6df;border-radius:6px}.learning-process p,.learning-process ol{margin:0}.learning-process ol{padding-left:20px}.learning-process li+li{margin-top:10px}
.learning-settings label{flex-direction:row;line-height:1.5}
.learning-settings label > input[type="checkbox"]{width:16px;height:16px;margin:0;flex:none}
.learning-settings label > select{width:auto;min-width:70px;max-width:100%;margin:0;padding-right:10px;padding-left:10px;flex:none}
.learning-log-table td{vertical-align:middle}
.learning-log-table td:first-child{min-width:0;max-width:none}
.learning-settings .learning-engine{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px}.learning-settings .learning-engine>select{width:100%;min-width:0}
.learning-engine-actions{display:flex;justify-content:flex-end;gap:10px}
</style>
