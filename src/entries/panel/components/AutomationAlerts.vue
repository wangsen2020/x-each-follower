<template>
  <aside v-if="alerts.length" class="automation-alerts" aria-label="需要处理的异常">
    <div v-for="alert in alerts" :key="alert.id" class="automation-alert" role="alert">
      <div class="alert-line"><strong>⚠ {{ alert.title }}</strong><span>{{ alert.reason }}</span><button class="secondary" @click="expanded=expanded===alert.id?'':alert.id">{{ expanded===alert.id?'收起详情':'查看详情' }}</button><button class="secondary" @click="openLogs">查看日志</button></div>
      <div v-if="expanded===alert.id" class="alert-detail">
        <p>{{ alert.impact }} {{ alert.action }}</p><p>首次发现：{{ format(alert.since) }}<span v-if="alert.pending!=null"> · 待备份 {{ alert.pending }} 条</span> · 未恢复前会持续显示，每 30 分钟提醒一次。</p>
        <p v-if="notices[alert.id]?.error">{{ notices[alert.id].error }}</p>
        <button v-if="alert.id==='logs'" class="secondary" :disabled="busy" @click="retry">{{ busy?'正在核对并重试…':'重试备份' }}</button>
      </div>
    </div>
    <p v-if="feedback" role="status">{{ feedback }}</p>
  </aside>
</template>
<script setup>
import {ref,onMounted,onUnmounted} from 'vue';
import {HEALTH_KEY,HEALTH_NOTICE_KEY} from '../../../shared/automation-health.js';
const alerts=ref([]),notices=ref({}),expanded=ref(''),busy=ref(false),feedback=ref('');let timer,sequence=0;
const format=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
async function refresh(){const token=++sequence;try{const d=await chrome.storage.local.get([HEALTH_KEY,HEALTH_NOTICE_KEY]);if(token!==sequence)return;alerts.value=Object.values(d[HEALTH_KEY]?.alerts||{});notices.value=d[HEALTH_NOTICE_KEY]||{};}catch(error){feedback.value=`异常状态读取失败：${error.message}`;}}
const changed=(changes,area)=>{if(area==='local'&&(changes[HEALTH_KEY]||changes[HEALTH_NOTICE_KEY]))void refresh();};
onMounted(()=>{void refresh();chrome.storage.onChanged.addListener(changed);timer=setInterval(refresh,30000);});
onUnmounted(()=>{sequence++;clearInterval(timer);chrome.storage.onChanged.removeListener(changed);});
function openLogs(){document.dispatchEvent(new CustomEvent('open-execution-logs',{detail:{scope:'unreciprocated'}}));}
async function retry(){if(busy.value)return;busy.value=true;feedback.value='正在核对并重试备份，不会重新执行关注或取关。';try{const r=await chrome.runtime.sendMessage({cmd:'retryExecutionLogBackup'});if(!r?.ok||r.backup?.ok===false)throw Error(r?.error||r.backup?.error||'备份仍未恢复');await refresh();feedback.value='备份已恢复。';}catch(error){feedback.value=`尚未恢复：${error.message}`;}finally{busy.value=false;}}
</script>
<style scoped>
.automation-alerts{background:#fff2db;border:1px solid #dfaa55;border-radius:8px;padding:10px 12px;color:#70420b;font-size:12px;max-height:35vh;overflow:auto;box-sizing:border-box}
.automation-alert+.automation-alert{border-top:1px solid #e5c99c;margin-top:8px;padding-top:8px}.alert-line{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px}.alert-line>span{flex:1;min-width:150px;overflow-wrap:anywhere}.alert-line strong{font-size:13px}.alert-detail p,p{margin:6px 0;line-height:1.6;overflow-wrap:anywhere}button{font-size:12px;min-height:28px;white-space:nowrap}
</style>
