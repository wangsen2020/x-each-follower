<template>
  <section class="exception-logs" aria-label="异常日志">
    <div class="exception-actions">
      <span class="exception-total">{{ filtered.length }} 条异常 <InfoTip text="本机保留近 7 天、最多 1,000 条异常。记录扩展运行异常与控制台警告，不含请求正文；敏感字段自动隐藏。复制和导出使用当前筛选。" /></span>
      <button type="button" class="secondary" :disabled="loading" @click="refresh">刷新</button>
      <button type="button" class="secondary" :disabled="!filtered.length || loading" @click="copy">复制</button>
      <button type="button" class="secondary" :disabled="!filtered.length || loading" @click="download">导出</button>
      <button type="button" class="secondary" :disabled="!entries.length || loading" @click="confirmClear=true">清空</button>
    </div>
    <div class="exception-filters">
      <select aria-label="异常来源" v-model="source" @change="page=1"><option value="all">全部来源</option><option value="background">后台</option><option value="panel">面板</option><option value="content">内容脚本</option></select>
      <select aria-label="异常级别" v-model="level" @change="page=1"><option value="all">全部级别</option><option value="error">错误</option><option value="warning">警告</option></select>
      <input v-model="query" type="search" aria-label="搜索异常日志" placeholder="搜索错误、堆栈或版本…" @input="page=1">
      <div class="exception-pager"><button type="button" class="secondary" :disabled="page===1" @click="page--">上一页</button><span>{{ page }} / {{ pages }}</span><button type="button" class="secondary" :disabled="page>=pages" @click="page++">下一页</button></div>
    </div>
    <div v-if="confirmClear" class="exception-clear" role="alert">清空本机全部异常日志？<button type="button" class="secondary" @click="clear">确认清空</button><button type="button" class="secondary" @click="confirmClear=false">取消</button></div>
    <p v-if="error" class="exception-error" role="alert">{{ error }} <button type="button" class="secondary" @click="refresh">重试</button></p>
    <p v-if="notice" role="status" class="exception-help">{{ notice }}</p>
    <p v-if="loading" role="status">正在读取异常日志…</p>
    <p v-else-if="!filtered.length && !error" class="exception-empty">{{ entries.length ? '没有符合筛选的异常。' : '暂无异常记录。' }}</p>
    <ol v-else class="exception-list" :aria-busy="loading">
      <li v-for="entry in visible" :key="entry.id">
        <details>
          <summary><span class="exception-meta"><strong :class="entry.level">{{ entry.level==='warning'?'警告':'错误' }}</strong><span>{{ sources[entry.source] }}</span><time>{{ date(entry.at) }}</time></span><span class="exception-message">{{ entry.message }}</span></summary>
          <div class="exception-details"><span>v{{ entry.version }} · {{ entry.kind }}</span><p v-if="entry.context">{{ entry.context }}</p><pre>{{ entry.stack || '无堆栈信息' }}</pre></div>
        </details>
      </li>
    </ol>
  </section>
</template>

<script setup>
import {ref, computed, onMounted, onBeforeUnmount} from 'vue';
import InfoTip from './InfoTip.vue';
import {systemExceptionStore, flushPendingExceptions} from '../../../shared/system-exceptions.js';
const entries=ref([]), source=ref('all'), level=ref('all'), query=ref(''), page=ref(1), loading=ref(false), error=ref(''), notice=ref(''), confirmClear=ref(false);
const sources={background:'后台',panel:'面板',content:'内容脚本'};
const filtered=computed(()=>entries.value.filter(entry=>(source.value==='all'||entry.source===source.value)&&(level.value==='all'||entry.level===level.value)&&`${entry.message} ${entry.stack} ${entry.context} ${entry.version} ${entry.kind}`.toLowerCase().includes(query.value.trim().toLowerCase())));
const pages=computed(()=>Math.max(1,Math.ceil(filtered.value.length/30)));
const visible=computed(()=>filtered.value.slice((page.value-1)*30,page.value*30));
const date=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
let disposed=false, generation=0;
async function refresh(){const ticket=++generation;loading.value=true;error.value='';try{await flushPendingExceptions();const rows=await systemExceptionStore().list();if(disposed||ticket!==generation)return;entries.value=rows;page.value=Math.min(page.value,pages.value);}catch(e){if(!disposed&&ticket===generation)error.value=`读取失败：${e.message}`;}finally{if(!disposed&&ticket===generation)loading.value=false;}}
const output=()=>JSON.stringify({exportedAt:new Date().toISOString(),entries:filtered.value},null,2);
async function copy(){error.value='';try{await navigator.clipboard.writeText(output());notice.value='已复制当前筛选的异常日志。';}catch(e){error.value=`复制失败：${e.message}`;}}
function download(){const url=URL.createObjectURL(new Blob([output()],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`xfollower-exceptions-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),40000);notice.value='已开始下载，请在浏览器下载记录中查看。';}
async function clear(){loading.value=true;error.value='';try{await flushPendingExceptions();await systemExceptionStore().clear();entries.value=[];page.value=1;confirmClear.value=false;notice.value='异常日志已清空。';}catch(e){error.value=`清空失败：${e.message}`;}finally{loading.value=false;}}
onMounted(refresh);
onBeforeUnmount(()=>{disposed=true;generation++;});
</script>

<style scoped>
.exception-logs{min-width:0;color:#263b32;font-size:13px}.exception-actions,.exception-filters,.exception-pager,.exception-meta,.exception-clear{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.exception-total{display:inline-flex;align-items:center;gap:6px;margin-right:auto;font-weight:600}.exception-help{font-size:12px;color:#61766c;line-height:1.7}.exception-filters{display:grid;grid-template-columns:auto auto minmax(100px,1fr) auto;gap:8px;margin:14px 0}.exception-filters select,.exception-filters input{height:32px;border:1px solid #cbd8d0;border-radius:6px;padding:4px 8px;background:#fff;min-width:0}.exception-filters input{width:100%;min-width:0}.exception-list{list-style:none;padding:0;margin:0}.exception-list li{border-top:1px solid #e0e8e2}.exception-list summary{cursor:pointer;padding:12px 0;overflow-wrap:anywhere}.exception-meta{font-size:11px;color:#61766c;margin-bottom:5px}.exception-meta time{margin-left:auto}.exception-meta strong.error,.exception-error{color:#b42318}.exception-meta strong.warning{color:#996010}.exception-message{white-space:pre-wrap;line-height:1.6}.exception-details{background:#f5f8f6;padding:12px;overflow-wrap:anywhere;border-radius:6px;margin-bottom:12px;font-size:12px}.exception-details pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.6;max-height:260px;overflow:auto}.exception-empty{padding:40px 0;text-align:center;color:#61766c}.exception-pager{justify-content:flex-end;flex-wrap:nowrap;gap:6px;white-space:nowrap}.exception-pager button{padding:5px 8px;min-height:30px}.exception-clear{padding:10px;background:#fff3df;margin:10px 0}.exception-error{overflow-wrap:anywhere}@media(max-width:560px){.exception-actions{gap:6px}.exception-actions button{padding:5px 8px;min-height:30px}.exception-filters{grid-template-columns:1fr 1fr}.exception-filters input{grid-column:1/-1}.exception-pager{grid-column:1/-1;justify-self:end}.exception-meta time{width:100%;margin-left:0}.exception-details{padding:8px}}
</style>
