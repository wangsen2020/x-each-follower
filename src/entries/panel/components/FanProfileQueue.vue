<template>
  <PanelIconButton id="openFanProfileQueue" :icon="ListVideo" :label="t('帖子补采队列')" :tip="t('查看帖子补采进度、限流与重试状态')" @click="open" />
  <Teleport to="body">
    <PanelModal ref="modal" class="fan-post-queue-modal" title="帖子补采队列" @close="closed">
      <template #actions><PanelIconButton :icon="RefreshCw" :label="t('刷新队列')" :disabled="loading" @click="load(true)" /></template>
      <div class="fan-post-queue" :aria-busy="loading">
        <p v-if="!data && loading" role="status">{{ t('正在读取补采队列…') }}</p>
        <p v-if="error" class="queue-error" role="alert">{{ error }}</p>
        <template v-if="data">
          <p v-if="data.requiresActivation">{{ t('请先确认队列账号') }}</p>
          <template v-else>
            <div class="queue-overview">
              <strong>@{{ data.handle || data.accountId }}</strong>
              <span>{{ t('待处理') }} <b>{{ data.summary.pending }}</b></span>
              <span>{{ t('已缓存') }} <b>{{ data.summary.loadingCache?'…':data.summary.succeeded }}</b></span>
              <span>{{ t('未完成') }} <b>{{ data.summary.loadingCache?'…':data.summary.failed }}</b></span>
              <InfoTip text="显示当前待处理任务和最近 200 条采集结果，包含档案中已有的帖子采集记录。已有记录按实际保存的状态与时间展示，不推断尝试次数。关闭窗口或刷新面板不影响后台调度。" label="补采进度说明" />
            </div>
            <div class="queue-progress" v-if="data.summary.total&&!data.summary.loadingCache">
              <progress :value="data.summary.finished" :max="data.summary.total" :aria-label="t('补采处理进度')"></progress>
              <span v-text="t('已结束 {{v0}} / {{v1}}',{v0:data.summary.finished,v1:data.summary.total})"></span>
            </div>
            <p class="queue-schedule" role="status" aria-live="polite">{{ scheduleText }}</p>
            <div class="queue-tools">
              <PanelSelect v-model="filter" :aria-label="t('补采状态筛选')" @change="changeFilter">
                <option value="all">{{ t('全部状态') }}</option><option value="pending">{{ t('待处理') }}</option>
                <option value="finished">{{ t('已结束') }}</option><option value="failed">{{ t('未完成') }}</option>
              </PanelSelect>
              <span v-text="t('共 {{v0}} 条',{v0:data.summary.loadingCache?data.total+'…':data.total})"></span>
              <div class="queue-pages"><PanelIconButton :icon="ChevronLeft" :label="t('上一页')" :disabled="loading || data.page<=1" @click="go(-1)" /><span>{{ data.page }} / {{ data.pages }}</span><PanelIconButton :icon="ChevronRight" :label="t('下一页')" :disabled="loading || data.page>=data.pages" @click="go(1)" /></div>
            </div>
            <p v-if="!data.items.length" class="queue-empty">{{ t(data.summary.loadingCache?'正在读取已有采集记录…':filter==='all'?'暂无补采任务；核验账号后，没有有效帖子缓存的账号会自动入队。':'没有符合筛选条件的任务') }}</p>
            <ol v-else class="queue-items">
              <li v-for="(item,index) in data.items" :key="`${item.targetUserId}:${item.finishedAt || 'pending'}:${index}`">
                <div class="queue-row-head"><strong>@{{ item.handle }}</strong><span class="queue-status" :data-status="item.status">{{ t(statusLabel(item)) }}</span></div>
                <div class="queue-meta"><span v-if="item.source==='profile-cache'">{{ t('已有采集记录') }}</span><span v-if="item.attempts!=null" v-text="t('已尝试 {{v0}} 次',{v0:item.attempts})"></span><span v-if="item.count!=null" v-text="t('已缓存 {{v0}} 帖',{v0:item.count})"></span><span v-if="item.finishedAt">{{ date(item.finishedAt) }}</span><span v-else-if="item.retryAt" v-text="t('可执行时间：{{v0}}',{v0:date(item.retryAt)})"></span></div>
                <p v-if="item.reason" class="queue-reason">{{ item.reason }}</p>
              </li>
            </ol>
          </template>
        </template>
      </div>
    </PanelModal>
  </Teleport>
</template>
<script setup>
import {computed,onUnmounted,ref} from 'vue';
import {ListVideo,RefreshCw,ChevronLeft,ChevronRight} from 'lucide';
import {t} from '../../../shared/i18n.js';
import {requestBackground} from '../../../platform/background-request.js';
import {awaitSettingsResponse} from '../settings-response.js';
import PanelIconButton from './PanelIconButton.vue';
import PanelModal from './PanelModal.vue';
import PanelSelect from './PanelSelect.vue';
import InfoTip from './InfoTip.vue';
const props=defineProps({request:{type:Function,default:requestBackground},timeoutMs:{type:Number,default:8000}});
const modal=ref(null),data=ref(null),error=ref(''),loading=ref(false),filter=ref('all');
let visible=false,timer,epoch=0,page=1,opener;
const date=value=>new Date(value).toLocaleString();
const scheduleText=computed(()=>{
  const s=data.value?.summary;if(!s)return '';
  if(s.running)return t('正在采集 @{{v0}}',{v0:s.running});
  if(s.loadingCache)return t('正在读取已有采集记录…');
  if(!s.pending)return t('当前没有待处理任务');
  if(s.recovering)return t('上次采集已中断，等待保护期结束后恢复');
  if(!s.scheduled)return t('未检测到调度计划，请查看异常日志');
  return t('下次执行：{{v0}}',{v0:date(s.nextRunAt)});
});
function statusLabel(item){
  if(!item.finished&&item.status==='failed')return '等待重试';
  return {pending:'待补采',running:'采集中',ready:'已缓存',partial:'已缓存部分',empty:'暂无可用原创帖',unavailable:'无法读取',failed:'补采失败','rate-limited':item.finished?'重试已结束':'限流等待'}[item.status]||'待核实';
}
async function load(refreshCache=false){
  clearTimeout(timer);const ticket=++epoch;loading.value=true;
  try{
    const result=await awaitSettingsResponse(()=>props.request({cmd:'followQueueFanProfileStatus',page,filter:filter.value,refreshCache:refreshCache===true}),{timeoutMs:props.timeoutMs,message:t('读取补采队列超时，请稍后重试')});
    if(ticket!==epoch||!visible)return;
    if(!result?.ok)throw Error(result?.error||t('补采队列读取失败'));
    data.value=result;page=result.page;error.value='';
  }catch(e){if(ticket===epoch&&visible)error.value=t(e.message);}
  finally{if(ticket===epoch){loading.value=false;if(visible)timer=setTimeout(load,2000);}}
}
function open(event){opener=event?.currentTarget||document.activeElement;visible=true;data.value=null;error.value='';page=1;filter.value='all';modal.value.open();load(true);}
function closed(event){if(event?.target?.open)return;visible=false;epoch++;clearTimeout(timer);loading.value=false;opener?.focus?.();}
function changeFilter(){page=1;load();}
function go(delta){page+=delta;load();}
function bindingChanged(changes,area){if(area==='local'&&changes.followQueueBinding&&visible){data.value=null;page=1;load();}}
globalThis.chrome?.storage?.onChanged?.addListener(bindingChanged);
onUnmounted(()=>{visible=false;epoch++;clearTimeout(timer);globalThis.chrome?.storage?.onChanged?.removeListener(bindingChanged);});
</script>
<style scoped>
.fan-post-queue-modal :deep(header){grid-template-columns:minmax(0,1fr) auto 30px}.fan-post-queue-modal :deep(.modal-actions){grid-row:1;grid-column:2}
.fan-post-queue{display:grid;gap:12px;min-width:0}.fan-post-queue p{margin:0}.queue-overview{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.queue-overview b,.queue-pages,.queue-meta{font-variant-numeric:tabular-nums}.queue-progress{display:flex;align-items:center;gap:10px}.queue-progress progress{flex:1;min-width:40px;height:8px;accent-color:#2a7755}.queue-progress span{white-space:nowrap}.queue-schedule{color:#446354;overflow-wrap:anywhere}.queue-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.queue-pages{display:flex;align-items:center;gap:8px;margin-left:auto}.queue-items{padding:0;margin:0;list-style:none;display:grid;gap:0}.queue-items li{padding:12px 0;border-top:1px solid #e2eae4;min-width:0}.queue-row-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.queue-row-head strong{overflow-wrap:anywhere;min-width:0}.queue-status{padding:2px 6px;border-radius:4px;background:#edf3ee;color:#315d45;white-space:nowrap}.queue-status[data-status=running]{background:#e8f1fc;color:#28538c}.queue-status[data-status=failed],.queue-status[data-status=rate-limited],.queue-status[data-status=unavailable]{background:#fff1e3;color:#87440e}.queue-meta{display:flex;gap:6px 14px;flex-wrap:wrap;color:#596e60;margin-top:5px;font-size:11px}.queue-reason{margin-top:6px!important;white-space:pre-wrap;overflow-wrap:anywhere;color:#87440e;max-height:90px;overflow:auto}.queue-error{color:#a12f2f;overflow-wrap:anywhere}.queue-empty{padding:24px 0;color:#596e60;text-align:center}
@media(max-width:480px){.queue-overview{gap:8px}.queue-tools{gap:6px}.queue-row-head{align-items:flex-start}.queue-meta{gap:4px 10px}}
</style>
