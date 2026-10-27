<template>
  <section class="bot-onboarding" aria-labelledby="onboardingTitle">
    <div class="onboarding-head"><h4 id="onboardingTitle">自动接入</h4><span v-if="state.stage==='completed'" class="onboarding-done">已连接</span></div>
    <template v-if="!state.stage || ['idle','cancelled','completed'].includes(state.stage)">
      <p>自动创建 Cloudflare 中转、填写 Grok 任务，并把接口绑定到插件。登录、验证码和授权确认由你完成。</p>
      <p class="onboarding-muted">将创建专用 Worker 和 D1 数据库，不覆盖已有服务。部署令牌只在当前浏览器会话中暂存；接入完成后清除。</p>
      <button id="startBotOnboarding" type="button" :disabled="busy" @click="start">{{ state.stage==='completed'?'配置新连接':'开始接入' }}</button>
    </template>
    <template v-else>
      <ol class="onboarding-progress" aria-label="接入进度"><li v-for="item in stages" :key="item.key" :class="{current:group===item.key,done:completedGroup(item.key)}"><span>{{ item.label }}</span></li></ol>
      <p v-if="!state.error" role="status" aria-live="polite">{{ state.message || '正在准备接入…' }}</p>
      <p v-if="state.resourceName" class="onboarding-muted">专用资源：{{ state.resourceName }}</p>
      <p v-if="state.error" class="onboarding-error" role="alert">{{ state.error }}</p>
      <div class="onboarding-actions">
        <button v-if="state.needsWorkerPermission" id="allowOnboardingWorker" type="button" :disabled="busy" @click="allowWorker">允许访问中转</button>
        <button v-if="state.error" type="button" :disabled="busy" @click="resume">继续接入</button>
        <button v-if="pageTabId" type="button" class="secondary" @click="showPage">打开配置页面</button>
        <button type="button" class="secondary" :disabled="busy" @click="cancel">停止接入</button>
      </div>
      <p class="onboarding-muted">可以关闭面板，重开后继续。停止只结束本次配置，已创建的云端资源保留。</p>
    </template>
    <div v-if="state.stage==='completed'" class="onboarding-result"><p>{{ state.result }}</p><small>{{ state.origin }}</small><p class="onboarding-muted">临时部署凭据已清除。可在 Cloudflare 的 API 令牌页撤销本次部署授权。</p></div>
    <p v-if="error" class="onboarding-error" role="alert">{{ error }}</p>
  </section>
</template>
<script setup>
import {ref,computed,onMounted,onUnmounted} from 'vue';
const emit=defineEmits(['completed']);
const state=ref({stage:'idle'}),busy=ref(false),error=ref('');
const stages=[{key:'cloudflare',label:'登录与授权'},{key:'deploy',label:'创建中转'},{key:'grok',label:'配置 Grok'},{key:'test',label:'绑定与测试'}];
const group=computed(()=>state.value.stage.startsWith('cloudflare')?'cloudflare':['deploying','workers-onboarding'].includes(state.value.stage)?'deploy':state.value.stage==='grok'?'grok':'test');
const pageTabId=computed(()=>group.value==='grok'?state.value.grokTabId:group.value==='test'?null:state.value.cloudflareTabId);
const completedGroup=key=>stages.findIndex(s=>s.key===key)<stages.findIndex(s=>s.key===group.value);
let timer,disposed=false,emitted=false;
async function request(action){const result=await chrome.runtime.sendMessage({cmd:'grokBotSetup',action});if(!result?.ok)throw Error(result?.error||'无法读取接入进度');state.value=result.state;if(state.value.stage==='completed'&&!emitted){emitted=true;emit('completed');}return result.state;}
async function task(work){if(busy.value)return;busy.value=true;error.value='';try{await work();}catch(e){error.value=e.message;}finally{busy.value=false;}}
function start(){
  const permission=chrome.permissions.request({origins:['https://dash.cloudflare.com/*','https://api.cloudflare.com/*']});
  void task(async()=>{if(!await permission)throw Error('请允许访问 Cloudflare 控制台和接口后继续');emitted=false;await request('start');});
}
function allowWorker(){
  const origin=state.value.origin;if(!origin)return;
  const permission=chrome.permissions.request({origins:[origin+'/*']});
  void task(async()=>{if(!await permission)throw Error('请允许访问此中转地址后继续');await request('advance');});
}
const resume=()=>task(()=>request('resume'));
const cancel=()=>task(()=>request('cancel'));
const showPage=()=>chrome.tabs.update(pageTabId.value,{active:true}).catch(()=>{error.value='配置页面已关闭，请点击继续接入';});
async function poll(){if(disposed)return;try{if(!busy.value){await request('status');if(!['idle','completed','cancelled'].includes(state.value.stage)&&!state.value.error)await request('advance');}}catch(e){if(!disposed)error.value=e.message;}finally{if(!disposed)timer=setTimeout(poll,2500);}}
onMounted(poll);onUnmounted(()=>{disposed=true;clearTimeout(timer);});
</script>
<style scoped>
.bot-onboarding{border:1px solid #cbded0;border-radius:8px;background:#f5f9f5;padding:12px;font-size:12px;color:#24483b}.onboarding-head,.onboarding-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.onboarding-head{justify-content:space-between}.onboarding-head h4{font-size:13px;margin:0}.bot-onboarding p{line-height:1.7;overflow-wrap:anywhere;margin:8px 0}.onboarding-muted{color:#607c70}.onboarding-error{color:#b42318}.onboarding-progress{list-style:none;display:flex;flex-wrap:wrap;gap:10px;padding:0;margin:10px 0}.onboarding-progress li{color:#789184;border-bottom:2px solid #dce6de;padding:4px 0}.onboarding-progress li.current{color:#24594a;border-color:#24594a;font-weight:600}.onboarding-progress li.done{color:#24594a}.onboarding-actions{margin:10px 0}.onboarding-done{color:#24594a}.onboarding-result small{overflow-wrap:anywhere}.bot-onboarding button{font-size:12px;min-height:30px}
</style>
