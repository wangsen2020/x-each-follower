<template>
  <div class="review-entry">
    <span>{{ t('待人工审核') }} {{ view.review.length }}</span><span v-if="view.skipped.length">{{ t('已跳过') }} {{ view.skipped.length }}</span>
    <PanelIconButton :icon="ClipboardList" :label="t('人工审核')" :tip="t('人工审核')" @click="reviewDrawer.open()" />
  </div>
  <ActionSettingsDrawer ref="reviewDrawer" :title="t('人工审核')" class="review-drawer">
    <div class="review-toolbar">
      <PanelSelect v-model="filter" :aria-label="t('审核状态')" :disabled="busy"><option value="review">{{ t('待人工审核') }}</option><option value="skipped">{{ t('已跳过') }}</option></PanelSelect>
      <input v-model="search" type="search" autocomplete="off" :aria-label="t('搜索审核账号')" :placeholder="t('搜索账号或原因…')" :disabled="busy">
      <span>{{ t('已选 \u007b\u007bv0\u007d\u007d 项',{v0:selected.length}) }}</span>
      <div class="review-actions">
        <PanelIconButton :icon="RotateCcw" :label="t('重试选中项')" :tip="t('重置选中项的核验次数，下次计划重新检查；待确认操作只核实已有结果')" :disabled="busy||!selected.length" @click="perform('retry',selectedItems)" />
        <PanelIconButton :icon="SkipForward" :label="t('跳过选中项')" :tip="t('保留去重标记，选中账号不再自动调度')" :disabled="busy||!selected.length||filter==='skipped'" @click="perform('skip',selectedItems)" />
        <PanelIconButton :icon="Trash2" :label="t('删除选中记录')" :tip="t('仅删除选中账号的本地记录，后续允许重新采集')" :disabled="busy||!selected.length" @click="askDelete(selectedItems)" />
      </div>
    </div>
    <label v-if="rows.length" class="review-select-page"><input type="checkbox" :checked="pageAllSelected" :indeterminate="pageSomeSelected&&!pageAllSelected" :disabled="busy" @change="selectPage($event.target.checked)">{{ t('选择当前页') }}</label>
    <ul class="review-list">
      <li v-for="item in pageRows" :key="key(item)">
        <input type="checkbox" :aria-label="t('选择 @\u007b\u007bv0\u007d\u007d',{v0:item.user.handle})" :checked="selected.includes(key(item))" :disabled="busy" @change="toggle(item,$event.target.checked)">
        <div class="review-account">
          <a :href="'https://x.com/'+encodeURIComponent(item.user.handle)" target="_blank" rel="noopener">@{{ item.user.handle }}</a>
          <span class="review-meta">{{ t('核验 \u007b\u007bv0\u007d\u007d 次',{v0:item.attempts}) }} · {{ date(item.updatedAt) }}</span>
          <p :class="{'reason-collapsed':longReason(item)&&!expandedReasons.includes(key(item))}">{{ t(item.reason) }}</p>
          <PanelIconButton v-if="longReason(item)" :icon="expandedReasons.includes(key(item))?ChevronUp:ChevronDown" :label="t(expandedReasons.includes(key(item))?'收起原因':'展开原因')" @click="toggleReason(item)" />
          <span v-if="item.pending" class="review-meta">{{ t('原操作结果待确认，重试时先核验，禁止直接重复提交') }}</span>
        </div>
        <div class="review-actions">
          <PanelIconButton :icon="RotateCcw" :label="t('重试')" :tip="t('重置核验次数，下次计划重新检查')" :disabled="busy" @click="perform('retry',[item])" />
          <PanelIconButton v-if="item.status!=='skipped'" :icon="SkipForward" :label="t('跳过')" :tip="t('保留去重标记，不再自动调度')" :disabled="busy" @click="perform('skip',[item])" />
          <PanelIconButton :icon="Trash2" :label="t('删除本地记录')" :tip="t('仅删除本地记录，后续允许重新采集')" :disabled="busy" @click="askDelete([item])" />
        </div>
      </li>
    </ul>
    <p v-if="!rows.length" class="review-empty">{{ t(filter==='review'?'暂无待人工审核账号':'暂无已跳过账号') }}</p>
    <div v-if="rows.length" class="review-pagination">
      <span>{{ t('第 \u007b\u007bv0\u007d\u007d / \u007b\u007bv1\u007d\u007d 页，共 \u007b\u007bv2\u007d\u007d 项',{v0:page,v1:pageCount,v2:rows.length}) }}</span>
      <PanelIconButton :icon="ChevronLeft" :label="t('上一页')" :disabled="busy||page<=1" @click="page--" />
      <PanelIconButton :icon="ChevronRight" :label="t('下一页')" :disabled="busy||page>=pageCount" @click="page++" />
    </div>
    <p v-if="feedback" role="status" aria-live="polite" class="review-feedback">{{ feedback }}</p>
    <details v-if="failures.length"><summary>{{ t('失败明细') }} {{ failures.length }}</summary><ul><li v-for="failure in failures" :key="failure">{{ failure }}</li></ul></details>
    <dialog ref="confirmation" class="review-confirm" aria-labelledby="review-delete-title" @cancel="cancelDelete" @close="deleteItems=[]">
      <h3 id="review-delete-title">{{ t('删除本地记录') }}</h3>
      <p>{{ t('将删除 \u007b\u007bv0\u007d\u007d 个账号的本地记录，不会操作 X 账号。以后重新采集时仍可能进入任务。',{v0:deleteItems.length}) }}</p>
      <div class="review-confirm-actions"><button type="button" class="secondary" :disabled="busy" @click="cancelDelete">{{ t('取消') }}</button><button type="button" :disabled="busy" @click="confirmDelete">{{ t('删除') }}</button></div>
    </dialog>
  </ActionSettingsDrawer>
</template>
<script setup>
import {computed,nextTick,ref,watch} from 'vue';
import {RotateCcw,SkipForward,Trash2,ChevronLeft,ChevronRight,ClipboardList,ChevronDown,ChevronUp} from 'lucide';
import {t} from '../../../shared/i18n.js';
import PanelIconButton from './PanelIconButton.vue';
import PanelSelect from './PanelSelect.vue';
import ActionSettingsDrawer from './ActionSettingsDrawer.vue';
const props=defineProps({view:{type:Object,required:true},refresh:{type:Function,required:true}});
const reviewDrawer=ref(null),filter=ref('review'),search=ref(''),page=ref(1),selected=ref([]),busy=ref(false),feedback=ref(''),confirmation=ref(null),deleteItems=ref([]),failures=ref([]);
const expandedReasons=ref([]);
const key=item=>String(item.user.id||item.user.handle).toLowerCase();
const longReason=item=>String(t(item.reason)||'').length>120;
const rows=computed(()=>props.view[filter.value==='review'?'review':'skipped'].filter(item=>`${item.user.handle} ${item.reason}`.toLowerCase().includes(search.value.toLowerCase())));
const pageCount=computed(()=>Math.max(1,Math.ceil(rows.value.length/10)));
const pageRows=computed(()=>rows.value.slice((page.value-1)*10,page.value*10));
const selectedItems=computed(()=>rows.value.filter(item=>selected.value.includes(key(item))));
const pageAllSelected=computed(()=>pageRows.value.length>0&&pageRows.value.every(item=>selected.value.includes(key(item))));
const pageSomeSelected=computed(()=>pageRows.value.some(item=>selected.value.includes(key(item))));
const date=value=>new Date(value).toLocaleString(undefined,{hour12:false});
watch([filter,search],()=>{selected.value=[];page.value=1;feedback.value='';});
watch(()=>props.view.config.autoUnfollowAccount?.id,()=>{selected.value=[];feedback.value='';cancelDelete();});
watch(rows,()=>{page.value=Math.min(page.value,pageCount.value);selected.value=selected.value.filter(id=>rows.value.some(item=>key(item)===id));});
function toggle(item,checked){selected.value=checked?[...new Set([...selected.value,key(item)])]:selected.value.filter(id=>id!==key(item));}
function selectPage(checked){for(const item of pageRows.value)toggle(item,checked);}
function toggleReason(item){const id=key(item);expandedReasons.value=expandedReasons.value.includes(id)?expandedReasons.value.filter(key=>key!==id):[...expandedReasons.value,id];}
async function askDelete(items){if(busy.value||!items.length)return;deleteItems.value=items.map(item=>({...item,user:{id:item.user.id,handle:item.user.handle}}));await nextTick();confirmation.value.showModal();}
function cancelDelete(){if(!busy.value)confirmation.value?.close();}
async function confirmDelete(){const items=[...deleteItems.value];confirmation.value.close();await perform('delete',items);}
async function perform(action,items){
  if(busy.value||!items.length)return;
  const accountId=String(props.view.config.autoUnfollowAccount?.id||'');
  busy.value=true;feedback.value=t('处理中…');failures.value=[];let succeeded=0;
  try{
    for(const item of [...items]){
      try{
        const response=await request({cmd:'resolveAutoUnfollowReview',action,accountId,handle:item.user.handle,targetId:item.user.id||'',updatedAt:item.updatedAt});
        if(response?.skipped==='running')throw new Error(t('当前轮次正在执行，请稍后重试'));
        if(!response?.ok)throw new Error(response?.error||t('操作未完成'));
        succeeded++;selected.value=selected.value.filter(id=>id!==key(item));
      }catch(error){failures.value.push(`@${item.user.handle}: ${t(error.message)}`);}
    }
    await props.refresh();
    feedback.value=t('已完成 \u007b\u007bv0\u007d\u007d 项，失败 \u007b\u007bv1\u007d\u007d 项',{v0:succeeded,v1:failures.value.length});
  }finally{busy.value=false;}
}
async function request(message){let timer;try{return await Promise.race([chrome.runtime.sendMessage(message),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(t('操作结果待确认，请刷新审核状态后再试'))),30000);})]);}finally{clearTimeout(timer);}}
</script>
<style scoped>
.review-entry{display:flex;align-items:center;gap:10px;margin-top:8px}.review-drawer{width:760px;max-width:100vw}.review-drawer :deep(.action-drawer-body){padding:12px 16px}.review-drawer :deep(summary){cursor:pointer}
.review-toolbar,.review-actions,.review-pagination,.review-confirm-actions{display:flex;align-items:center;gap:6px}.review-toolbar{flex-wrap:wrap;margin:10px 0}.review-toolbar input{flex:1;min-width:130px;max-width:260px}.review-select-page{display:flex;align-items:center;gap:6px;margin:8px 0}
.review-list{list-style:none;padding:0;margin:0}.review-list li{display:flex;align-items:flex-start;gap:8px;padding:10px 0;border-top:1px solid #dde5df}.review-list li>input{margin-top:5px;flex-shrink:0}.review-account{flex:1;min-width:0;overflow-wrap:anywhere}.review-account a{display:inline-block;margin-right:8px}.review-account p{margin:4px 0;line-height:1.5}.review-meta{font-size:11px;color:#52675a}.review-actions{flex-shrink:0}.review-pagination{justify-content:flex-end;margin-top:8px;font-variant-numeric:tabular-nums}.review-pagination span{margin-right:auto}.review-empty,.review-feedback{line-height:1.6;margin:8px 0;overflow-wrap:anywhere}
.review-confirm{max-width:min(420px,calc(100vw - 32px));border:1px solid #b9c9bd;border-radius:8px;padding:20px;color:#264b3c}.review-confirm::backdrop{background:#0006}.review-confirm h3{margin:0 0 12px}.review-confirm p{line-height:1.6}.review-confirm-actions{justify-content:flex-end;margin-top:16px}
.reason-collapsed{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
@media(max-width:560px){.review-list li{flex-wrap:wrap}.review-account{flex-basis:calc(100% - 30px)}.review-list li>.review-actions{margin-left:24px}.review-toolbar input{max-width:none}.review-meta{display:block}}
</style>
