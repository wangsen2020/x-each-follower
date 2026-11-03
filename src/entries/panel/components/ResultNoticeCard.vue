<template>
  <article class="result-notice-card" :data-created-at="notice.createdAt" :data-result-key="notice.resultKey" :data-expanded="expanded" :data-task-stage="notice.progress?.stage">
    <header>
      <button type="button" class="result-notice-title" :aria-expanded="expanded" @click="override=!expanded">{{ notice.title }}</button>
      <time :datetime="new Date(notice.createdAt).toISOString()" :title="dateTime">{{ time }}</time>
      <PanelIconButton v-for="action in progressActions" :key="action.action" :icon="action.action==='view-task'?Eye:action.action==='stop'?CircleStop:Play" :label="t(action.label)" :disabled="action.disabled" @click="act(action)" />
      <PanelIconButton v-if="notice.progress?.stage!=='running'" class="result-notice-close" :icon="X" :label="t('关闭结果')" @click="close" />
    </header>
    <div v-if="notice.progress" class="result-notice-progress" role="status" aria-live="polite">
      <progress :max="Math.max(1,notice.progress.total||0)" :value="notice.progress.done||0" :aria-label="t('任务进度')"></progress>
      <div><span v-text="t('已处理 {{done}}/{{total}}',{done:notice.progress.done||0,total:notice.progress.total||0})"></span><template v-if="notice.progress.groups"><span v-for="group in notice.progress.groups" :key="group.label">{{ t(group.label) }} {{ group.count }}</span></template><template v-else><span v-text="t('成功 {{count}}',{count:notice.progress.success||0})"></span><span v-text="t('失败 {{count}}',{count:notice.progress.failed||0})"></span></template></div>
    </div>
    <div v-if="expanded" class="result-notice-body">
      <p v-if="notice.note" class="result-notice-note">{{ notice.note }}</p>
      <details v-if="notice.items?.length" :open="notice.items.length<=3">
        <summary>{{ resultSummary }}</summary>
        <ul><li v-for="(item,index) in notice.items" :key="index">{{ item }}</li></ul>
      </details>
      <div v-if="otherActions.length" class="result-notice-actions">
        <button v-for="action in otherActions" :key="action.action" type="button" class="secondary" @click="act(action)">{{ t(action.label) }}</button>
      </div>
    </div>
  </article>
</template>
<script setup>
import {computed,inject,ref} from 'vue';
import {t,locale} from '../../../shared/i18n.js';
import {PANEL_RESULT_ACTION_EVENT} from '../result-notices.js';
import PanelIconButton from './PanelIconButton.vue';
import {CircleStop,Play,Eye,X} from 'lucide';
const props=defineProps({notice:{type:Object,required:true}});
const context=inject('panel-result-context');
const override=ref(null),expanded=computed(()=>override.value??(props.notice.progress?.stage==='running'||context.latestId.value===props.notice.id));
const progressActions=computed(()=>(props.notice.actions||[]).filter(a=>['stop','resume','view-task'].includes(a.action)));
const otherActions=computed(()=>(props.notice.actions||[]).filter(a=>!['stop','resume','view-task'].includes(a.action)));
const resultSummary=computed(()=>t('查看结果 {{v0}} 条',{v0:props.notice.items?.length||0}));
const time=computed(()=>new Intl.DateTimeFormat(locale.value,{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(props.notice.createdAt));
const dateTime=computed(()=>new Intl.DateTimeFormat(locale.value,{dateStyle:'medium',timeStyle:'medium'}).format(props.notice.createdAt));
function act(action){document.dispatchEvent(new CustomEvent(PANEL_RESULT_ACTION_EVENT,{detail:{kind:props.notice.kind,batchId:props.notice.batchId,action:action.action}}));}
function close(){act({action:'close'});context.dismiss(props.notice.id);}
</script>
<style scoped>
.result-notice-card{width:100%;border:1px solid #cbdcd2;border-radius:7px;background:#fff;color:#18302e;box-shadow:none;overflow:hidden;pointer-events:auto;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.result-notice-card header{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;min-height:36px;background:#f5f8f5}
.result-notice-title{flex:1;min-width:0;padding:0;border:0;background:transparent;text-align:start;font-size:13px;font-weight:600;color:inherit;line-height:1.5;cursor:pointer}
.result-notice-card time{font-size:11px;color:#64776d;white-space:nowrap}.result-notice-close{flex-shrink:0;width:30px;height:30px}
.result-notice-progress{padding:4px 12px 6px}.result-notice-progress progress{width:100%;height:7px;accent-color:#2c7754}.result-notice-progress>div{display:flex;gap:12px;flex-wrap:wrap;font-variant-numeric:tabular-nums}.result-notice-card header :deep(.panel-icon-button){flex-shrink:0}
.result-notice-close:hover{background:#e7eee7}.result-notice-card button:focus-visible{outline:2px solid #286b53;outline-offset:1px}
.result-notice-body{padding:8px 12px 10px;max-height:min(240px,40vh);overflow:auto;overscroll-behavior:contain}.result-notice-note{margin:0 0 6px}.result-notice-body summary{cursor:pointer;min-height:24px}.result-notice-body ul{margin:5px 0 0;padding-left:18px;max-height:170px;overflow:auto}.result-notice-body li+li{margin-top:5px}.result-notice-actions{display:flex;gap:8px;margin-top:8px}.result-notice-actions button{font-size:12px;padding:4px 10px}
</style>
