<template>
  <div class="auto-unfollow-status" aria-label="自动取关调度">
    <div role="status" aria-live="polite" class="schedule-summary">
      <strong>自动取关 · {{ view.label }}</strong>
      <span>排队 {{ view.queue.length }} 人</span>
      <span>待确认 {{ view.pending.length }} 人</span>
      <span>今日 {{ view.used }} / {{ view.limit }}</span>
    </div>
    <p>{{ error || view.reason }}<template v-if="view.config.autoUnfollow"> · 下次检查：{{ view.nextText }}</template></p>
    <details v-if="view.pending.length">
      <summary>待确认账号（不影响其他账号）</summary>
      <ul>
        <li v-for="item in view.pending" :key="String(item.user?.id || item.user?.handle)">
          <a :href="'https://x.com/' + encodeURIComponent(item.user?.handle || '')" target="_blank" rel="noopener">@{{ item.user?.handle || '未知账号' }}</a>
          <span>{{ item.reason || '上次操作结果待确认' }} · 自动核验，符合条件后恢复排队</span>
          <button class="secondary" :disabled="Boolean(checking)" @click="review(item.user?.handle)" title="仅核验已有结果，不发送取关或回关请求">{{ checking === item.user?.handle ? '核验中…' : '核验' }}</button>
          <button class="secondary" :disabled="Boolean(checking)" @click="review(item.user?.handle,true)" title="距原操作至少 10 分钟，接口与主页均确认仍关注且符合条件时恢复排队；下一轮重新核验后取关">核验并恢复</button>
        </li>
      </ul>
    </details>
    <p v-if="feedback" role="status">{{ feedback }}</p>
  </div>
</template>
<script setup>
import {onMounted,onUnmounted,ref,watch} from 'vue';
import {autoUnfollowStatusController} from '../composables/useAutoUnfollowStatus.js';
const {view,error,refresh,start}=autoUnfollowStatusController;
const checking=ref(''),feedback=ref('');
watch(()=>JSON.stringify(view.value.pending),()=>{feedback.value='';});
let stop;
onMounted(()=>{stop=start();});
onUnmounted(()=>stop?.());
async function review(handle,retryConfirmed=false){
  if(!handle||checking.value)return;
  checking.value=handle;feedback.value='';
  try{
    const result=await chrome.runtime.sendMessage({cmd:'reviewAutoUnfollowPending',handle,retryConfirmed});
    if(result?.error)throw new Error(result.error);
    await refresh();
    feedback.value=result?.skipped==='running'?'当前轮次正在执行，请稍后核验':view.value.pending.some(item=>item.user?.handle===handle)?'关系仍待确认，继续隔离该账号；其他账号不受影响。':retryConfirmed?'核验完成，已解除待确认；符合条件的账号已恢复排队。':'核验完成，已解除该账号的待确认状态。';
  }catch(failure){feedback.value=`核验未完成：${failure.message}`;}
  finally{checking.value='';}
}
</script>
<style scoped>
.auto-unfollow-status{padding:10px 12px;border:1px solid #d8e5dd;border-radius:8px;background:#f4f8f5;font-size:12px;color:#264b3c;overflow-wrap:anywhere;flex-shrink:0;max-height:40vh;overflow:auto}
.schedule-summary{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
p{margin:6px 0 0;line-height:1.6}
details{margin-top:6px}summary{cursor:pointer}ul{list-style:none;padding:0;margin:6px 0 0}
li{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:5px 0}li span{flex:1;min-width:160px}
button{font-size:12px;min-height:28px}
</style>
