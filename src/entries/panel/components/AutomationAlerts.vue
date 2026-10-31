<template>
  <aside v-if="alerts.length" class="automation-alerts" :aria-label="t(&quot;需要处理的异常&quot;)">
    <div v-for="alert in alerts" :key="alert.id" class="automation-alert" role="alert">
      <div class="alert-line"><strong>⚠ {{ alert.title }}</strong><span>{{ alert.reason }}</span><button v-if="alert.retryPhase" class="secondary" :disabled="!!retrying" :aria-busy="retrying===alert.id" @click="retryConnection(alert)">{{ retrying===alert.id?'重试中…':'重试连接' }}</button><button class="secondary" :aria-expanded="expanded===alert.id" @click="expanded=expanded===alert.id?'':alert.id">{{ expanded===alert.id?'收起详情':'查看详情' }}</button><button v-if="alert.tab" class="secondary" @click="openTask(alert)">前往处理</button><button v-else class="secondary" @click="openLogs">查看日志</button></div>
      <p v-if="retryErrors[alert.id]" role="status">{{ retryErrors[alert.id] }}</p>
      <div v-if="expanded===alert.id" class="alert-detail">
        <p>{{ alert.impact }} {{ alert.action }}</p><p>首次发现：{{ format(alert.since) }}<span v-if="alert.pending!=null"> · 待备份 {{ alert.pending }} 条</span> · {{ /^mutual-(tags|comments)-/.test(alert.id)?'异常持续 2 分钟后才弹出桌面通知，同一账号的 AI 异常 30 分钟内最多提醒一次。':'未恢复前会持续显示，每 30 分钟提醒一次。' }}</p>
        <p v-if="notices[alert.id]?.error">{{ notices[alert.id].error }}</p>
        <button v-if="alert.id==='logs'" class="secondary" :disabled="busy" @click="retry">{{ busy?'正在核对并重试…':'重试备份' }}</button>
      </div>
    </div>
    <p v-if="feedback" role="status">{{ t(feedback) }}</p>
  </aside>
</template>
<script setup>
import {t,locale} from '../../../shared/i18n.js';

import {ref,onMounted,onUnmounted} from 'vue';
import {HEALTH_KEY,HEALTH_NOTICE_KEY} from '../../../shared/automation-health.js';
import {panelNavigationController} from '../composables/usePanelNavigation.js';
const alerts=ref([]),notices=ref({}),expanded=ref(''),busy=ref(false),feedback=ref(''),retrying=ref(''),retryErrors=ref({});let timer,sequence=0;
const format=value=>new Date(value).toLocaleString(locale.value,{hour12:false});
async function refresh(){const token=++sequence;try{const d=await chrome.storage.local.get([HEALTH_KEY,HEALTH_NOTICE_KEY]);if(token!==sequence)return;alerts.value=Object.values(d[HEALTH_KEY]?.alerts||{});notices.value=d[HEALTH_NOTICE_KEY]||{};}catch(error){feedback.value=`异常状态读取失败：${error.message}`;}}
const changed=(changes,area)=>{if(area==='local'&&(changes[HEALTH_KEY]||changes[HEALTH_NOTICE_KEY]))void refresh();};
onMounted(()=>{void refresh();chrome.storage.onChanged.addListener(changed);timer=setInterval(refresh,30000);});
onUnmounted(()=>{sequence++;clearInterval(timer);chrome.storage.onChanged.removeListener(changed);});
function openLogs(){document.dispatchEvent(new CustomEvent('open-execution-logs',{detail:{scope:'unreciprocated'}}));}
function openTask(alert){panelNavigationController.setTab(alert.tab);}
async function retryConnection(alert){
  if(retrying.value)return;retrying.value=alert.id;delete retryErrors.value[alert.id];
  try{
    const result=await chrome.runtime.sendMessage({cmd:'mutualComments',action:'retryConnection',ownerId:alert.ownerId,phase:alert.retryPhase});
    if(!result?.ok)throw Error(result?.error||'连接仍未恢复');
    await refresh();
  }catch(error){retryErrors.value[alert.id]=`重试未成功：${error.message}`;}
  finally{retrying.value='';}
}
async function retry(){if(busy.value)return;busy.value=true;feedback.value='正在核对并重试备份，不会重新执行关注或取关。';try{const r=await chrome.runtime.sendMessage({cmd:'retryExecutionLogBackup'});if(!r?.ok||r.backup?.ok===false)throw Error(r?.error||r.backup?.error||'备份仍未恢复');await refresh();feedback.value='备份已恢复。';}catch(error){feedback.value=`尚未恢复：${error.message}`;}finally{busy.value=false;}}
</script>
<style scoped>
.automation-alerts{background:#fee2e2;border:1px solid #dc2626;border-radius:8px;padding:10px 12px;color:#881b1b;font-size:12px;max-height:35vh;overflow:auto;box-sizing:border-box}
.automation-alert+.automation-alert{border-top:1px solid #e5c99c;margin-top:8px;padding-top:8px}.alert-line{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px}.alert-line>span{flex:1;min-width:150px;overflow-wrap:anywhere}.alert-line strong{font-size:13px}.alert-detail p,p{margin:6px 0;line-height:1.6;overflow-wrap:anywhere}button{font-size:12px;min-height:28px;white-space:nowrap}
</style>
