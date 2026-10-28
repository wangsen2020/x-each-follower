<template>
  <span class="wisdom-control">
    <PanelIconButton :icon="Brain" label="智慧" :tip="activeTip" :title="activeTip" @click="openDocument" />
    <button v-if="pending" type="button" class="secondary wisdom-pending" :disabled="busy" @click="resume">待处理合入</button>
    <PanelModal ref="documentModal" title="写作智慧 · Markdown Skill">
      <template #actions><button type="button" class="secondary" @click="openVersions">版本记录</button><button type="button" class="secondary" :disabled="!editText" @click="copy">复制 Markdown</button></template>
      <p class="wisdom-meta">{{ viewedVersion ? '查看 v'+viewedVersion : '新建智慧' }} · 当前使用 {{ state?.head ? 'v'+state.head.version : '未设置' }}</p>
      <textarea ref="editor" v-model="editText" class="wisdom-editor" aria-label="智慧Markdown文档" spellcheck="false" placeholder="# 写作智慧&#10;&#10;## 写作目标&#10;如何写出有信息价值、值得互动的帖子…" />
      <p class="wisdom-meta">{{ editText.length }} / 6000 字符。可复制给其他 AI 细化，再粘贴保存。保存会新增一份智慧，原文档保留。</p>
      <p v-if="error" class="wisdom-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
      <template #footer><button type="button" class="secondary" @click="documentModal?.close()">关闭</button><button type="button" :disabled="busy || !editText.trim()" @click="saveDocument">保存并使用</button></template>
    </PanelModal>
    <PanelModal ref="versionsModal" title="智慧版本">
      <template #actions><PanelPager :page="versionPage.page" :page-size="versionPage.pageSize" :total="versionPage.total" :busy="busy" label="智慧版本分页" @page="loadVersions" @size="size=>loadVersions(1,size)" /></template>
      <p class="wisdom-meta">勾选一份作为当前写作 Skill。切换不改内容，也不新增版本。</p>
      <div class="version-table-wrap"><table class="version-table"><thead><tr><th>使用</th><th>智慧</th><th>保存时间</th><th>来源</th><th>查看</th></tr></thead><tbody><tr v-for="version in versionPage.items" :key="version.version"><td><input type="radio" name="active-wisdom" :checked="version.version === state?.head?.version" :aria-label="'使用智慧 v'+version.version" :disabled="busy" @change="selectVersion(version.version)"></td><td>v{{ version.version }}</td><td>{{ date(version.createdAt) }}</td><td>{{ version.action==='edit'?'手动修改':version.trigger==='weekly'?'每周合并':'经验合入' }}</td><td><PanelIconButton :icon="Eye" :label="'查看智慧 v'+version.version" @click="viewVersion(version.version)" /></td></tr></tbody></table></div>
      <p v-if="!versionPage.total">暂无智慧，可先合入经验或新建 Markdown 文档。</p><p v-if="error" class="wisdom-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    </PanelModal>
    <ActionSettingsDrawer ref="previewDrawer" title="合入智慧">
      <template v-if="draft"><p>基于 {{ draft.baseVersion ? 'v'+draft.baseVersion : '空白智慧' }}，本次合入 {{ draft.selected.length }} 条经验。</p><p v-if="draft.status !== 'ready'" role="status">{{ draft.error || '正在生成合入结果，可稍后查询原任务。' }}</p><template v-else><div class="wisdom-compare"><section><h3>合入前</h3><pre>{{ draft.before?.content || '暂无智慧' }}</pre></section><section><h3>合入后</h3><pre>{{ draft.content }}</pre></section></div><p v-if="draft.conflicts?.length" class="wisdom-error">需核对：{{ draft.conflicts.join('；') }}</p></template><details><summary>本次经验与来源</summary><article v-for="item in draft.selected" :key="item.id" class="wisdom-source"><p>{{ item.statement }}</p><small>{{ item.sources?.length ? [...new Set(item.sources.map(s=>channels[s.channel]||'来源待核实'))].join('、') : item.scope?.sourceChannel==='manual'?'手动录入':'历史来源待核实' }}</small></article></details></template>
      <p v-if="error" class="wisdom-error" role="alert">{{ error }}</p>
      <template #footer><button type="button" class="secondary" :disabled="busy" @click="cancel">放弃本次合入</button><button v-if="draft?.status !== 'ready'" type="button" class="secondary" :disabled="busy" @click="resume">查询原任务</button><button v-else type="button" :disabled="busy" @click="commit">保存并使用</button></template>
    </ActionSettingsDrawer>
  </span>
</template>
<script setup>
import {ref,computed,watch,onBeforeUnmount} from 'vue';
import {Brain,Eye} from 'lucide';
import PanelIconButton from './PanelIconButton.vue';
import PanelModal from './PanelModal.vue';
import PanelPager from './PanelPager.vue';
import ActionSettingsDrawer from './ActionSettingsDrawer.vue';
import {EXPERIENCE_CHANNELS as channels} from '../../../features/knowledge/wisdom.js';
const props=defineProps({ownerId:{type:String,required:true}}),emit=defineEmits(['updated','state']);
const state=ref(null),draft=ref(null),busy=ref(false),error=ref(''),notice=ref(''),previewDrawer=ref(null),documentModal=ref(null),versionsModal=ref(null),editor=ref(null);
const editText=ref(''),editBaseVersion=ref(0),viewedVersion=ref(0),versionPage=ref({items:[],total:0,page:1,pageSize:10});
let sequence=0,versionSequence=0;
const pending=computed(()=>state.value?.drafts.find(d=>['prepared','submitted','result_saved','ready'].includes(d.status)));
const activeTip=computed(()=>state.value?.head?'当前使用智慧 v'+state.value.head.version+'，点击查看 Markdown Skill':'尚未选择智慧，点击新建或查看');
const date=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
async function request(action,extra={}){const r=await chrome.runtime.sendMessage({cmd:'knowledgeLearning',action,...extra});if(!r?.ok)throw Error(r?.error||'智慧操作失败');return r;}
function apply(result){state.value=result;emit('state',result);}
async function refresh(){const ticket=++sequence,id=props.ownerId;try{const r=await request('wisdomState');if(ticket===sequence&&id===props.ownerId)apply(r);}catch(e){if(ticket===sequence)error.value=e.message;}}
function showDocument(document){editText.value=document?.content||'';viewedVersion.value=document?.version||0;editBaseVersion.value=state.value?.head?.version||0;error.value='';notice.value='';documentModal.value?.open();}
async function openDocument(){await refresh();showDocument(state.value?.head);}
async function openVersions(){documentModal.value?.close();error.value='';notice.value='';await loadVersions(1);versionsModal.value?.open();}
async function loadVersions(page=1,pageSize=versionPage.value.pageSize){const ticket=++versionSequence,id=props.ownerId;try{const r=await request('wisdomVersions',{page,pageSize});if(ticket===versionSequence&&id===props.ownerId)versionPage.value=r;}catch(e){if(ticket===versionSequence)error.value=e.message;}}
async function viewVersion(version){const id=props.ownerId;try{const r=await request('wisdomVersion',{version});if(id!==props.ownerId)return;versionsModal.value?.close();showDocument(r.document);}catch(e){error.value=e.message;}}
async function selectVersion(version){busy.value=true;error.value='';const id=props.ownerId;try{const r=await request('wisdomSelect',{version,baseVersion:state.value?.head?.version||0});if(id!==props.ownerId)return;apply(r);notice.value='当前使用智慧 v'+version;emit('updated');}catch(e){error.value=e.message;}finally{busy.value=false;}}
async function saveDocument(){busy.value=true;error.value='';const id=props.ownerId;try{const r=await request('wisdomSave',{content:editText.value,sourceVersion:viewedVersion.value,baseVersion:editBaseVersion.value});if(id!==props.ownerId)return;apply(r);editBaseVersion.value=r.head.version;viewedVersion.value=r.head.version;notice.value='已保存并使用智慧 v'+r.head.version;emit('updated');}catch(e){error.value=e.message;}finally{busy.value=false;}}
async function copy(){try{await navigator.clipboard.writeText(editText.value);notice.value='已复制 Markdown';}catch{editor.value?.select();notice.value='已选中文档，请按 Ctrl+C 复制';}}
async function merge(ids){busy.value=true;error.value='';notice.value='';try{const id=props.ownerId;const r=await request('wisdomPreview',{ids,baseVersion:state.value?.head?.version||0});if(id!==props.ownerId)return;apply(r);draft.value=r.draft;previewDrawer.value?.open();}catch(e){error.value=e.message;await refresh();if(pending.value){draft.value=pending.value;previewDrawer.value?.open();}else{showDocument(state.value?.head);error.value=e.message;}}finally{busy.value=false;}}
async function resume(){if(!pending.value)return;busy.value=true;error.value='';try{const id=props.ownerId;const r=await request('wisdomQuery',{id:pending.value.id});if(id!==props.ownerId)return;apply(r);draft.value=r.draft;previewDrawer.value?.open();}catch(e){error.value=e.message;draft.value=pending.value;previewDrawer.value?.open();}finally{busy.value=false;}}
async function commit(){busy.value=true;error.value='';try{const id=props.ownerId;const r=await request('wisdomCommit',{id:draft.value.id});if(id!==props.ownerId)return;apply(r);previewDrawer.value?.close();emit('updated');}catch(e){error.value=e.message;}finally{busy.value=false;}}
async function cancel(){if(!draft.value)return;busy.value=true;try{apply(await request('wisdomCancel',{id:draft.value.id}));previewDrawer.value?.close();draft.value=null;}catch(e){error.value=e.message;}finally{busy.value=false;}}
watch(()=>props.ownerId,()=>{++sequence;++versionSequence;state.value=null;draft.value=null;error.value='';notice.value='';previewDrawer.value?.close();documentModal.value?.close();versionsModal.value?.close();if(props.ownerId)refresh();},{immediate:true});
const timer=setInterval(()=>{if(!busy.value&&props.ownerId)refresh();},15000);onBeforeUnmount(()=>{clearInterval(timer);++sequence;++versionSequence;});
defineExpose({merge,refresh});
</script>
<style scoped>
.wisdom-control{display:inline-flex;align-items:center;gap:10px;min-width:0;font-size:12px}.wisdom-editor{box-sizing:border-box;width:100%;height:min(48vh,420px);min-height:220px;resize:vertical;padding:10px;border:1px solid #c8dccb;border-radius:6px;font:12px/1.7 ui-monospace,Consolas,monospace;color:#213c30}.wisdom-meta{color:#64756e}.wisdom-error{color:#a52f2f}.version-table-wrap{overflow-x:auto}.version-table{width:100%;border-collapse:collapse;font-size:12px}.version-table th,.version-table td{padding:10px;border-bottom:1px solid #e4ece6;text-align:left;white-space:nowrap}.version-table th{background:#f8faf8}.wisdom-compare{display:grid;grid-template-columns:1fr 1fr;gap:10px}.wisdom-compare section{min-width:0;padding:10px;border:1px solid #dce6df;border-radius:6px;display:flex;flex-direction:column;gap:10px}.wisdom-compare pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 inherit}.wisdom-source{display:flex;flex-direction:column;gap:10px;padding:10px 0;border-bottom:1px solid #e8ede9}.wisdom-source p,.wisdom-compare h3{margin:0}.wisdom-control :deep(.action-drawer-body){display:flex;flex-direction:column;gap:10px}@media(max-width:600px){.wisdom-compare{grid-template-columns:1fr}}
.version-table{table-layout:fixed}
.version-table th,.version-table td{vertical-align:middle;white-space:normal;overflow-wrap:anywhere}
.version-table th{white-space:nowrap}
.version-table th:first-child,.version-table td:first-child{width:50px;min-width:0;max-width:none}
.version-table th:nth-child(2){width:70px}
.version-table th:nth-child(3){width:150px}
.version-table th:last-child{width:50px}
.version-table input[type="radio"]{display:block;width:16px;height:16px;margin:0;accent-color:#245b45}
@media(max-width:600px){.version-table th:first-child,.version-table td:first-child{width:46px}.version-table th:nth-child(2){width:48px}.version-table th:nth-child(3){width:86px}.version-table th:last-child{width:50px}}
</style>
