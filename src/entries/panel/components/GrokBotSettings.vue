<template>
  <section class="bot-settings" aria-labelledby="botSettingsTitle">
    <div class="bot-heading"><h3 id="botSettingsTitle">Grok Webhook</h3><a :href="tutorialUrl" target="_blank" rel="noopener">图解教程</a></div>
    <p class="bot-muted">通过 Grok 自动化 Webhook 生成文本，不代表独立 Bot 额度。</p>
    <BotOnboardingWizard @completed="refresh" />
    <details class="bot-manual"><summary>已有接口 / 手动配置</summary>
    <nav class="bot-steps" aria-label="接入步骤"><button v-for="(label,index) in steps" :key="label" type="button" :class="{selected:step===index+1}" :aria-current="step===index+1?'step':undefined" @click="step=index+1">{{ index+1 }} {{ label }}</button></nav>
    <div v-if="step===1">
      <h4>准备 Webhook 任务</h4><p>在 Grok 网页端新建自动化，添加 Webhook 触发器。按教程粘贴 XFollower 指令，保存端点与签名密钥。</p>
      <div class="bot-actions"><a class="bot-link" href="https://grok.com/automations" target="_blank" rel="noopener">打开自动化任务</a><a :href="tutorialUrl+'#bot'" target="_blank" rel="noopener">查看配置步骤</a></div>
      <p class="bot-muted">在网页端完成配置。若没有 Webhook 选项，先查看账号可用功能与教程排错。</p>
    </div>
    <div v-if="step===2">
      <h4>部署中转</h4><p>打开 Cloudflare，跟随教程创建 Worker 与 D1，粘贴固定代码，配置自动化任务的 Webhook 和签名密钥，再生成专用连接 Token。</p>
      <div class="bot-actions"><a class="bot-link" href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noopener">打开 Cloudflare</a><a :href="tutorialUrl+'#cloudflare'" target="_blank" rel="noopener">复制代码与配置指令</a></div>
      <p class="bot-muted">签名密钥保存在 Worker 中。下一步只需部署地址与连接 Token，无需 Cloudflare 账号 API Token。</p>
    </div>
    <div v-if="step===3">
      <h4>{{ state.connected ? '管理连接' : '绑定接口' }}</h4>
      <label for="grokBotOrigin">接口地址</label><input id="grokBotOrigin" v-model="origin" type="url" placeholder="https://你的中转.workers.dev" autocomplete="off" :disabled="busy" />
      <label for="grokBotToken">连接 Token <span class="info-tip" tabindex="0" role="note" data-tip="填写 Worker 中的 CLIENT_TOKEN，不是 Grok 签名密钥，也不是 Cloudflare API Token。仅保存在本机扩展数据库，不进入业务备份。" aria-label="填写 Worker 中的 CLIENT_TOKEN，不是 Grok 签名密钥，也不是 Cloudflare API Token。仅保存在本机扩展数据库，不进入业务备份。">?</span></label><input id="grokBotToken" v-model="token" type="password" placeholder="粘贴 CLIENT_TOKEN" autocomplete="new-password" :disabled="busy" />
      <div class="bot-actions"><button type="button" :disabled="busy" @click="bind">检查并绑定</button><button v-if="state.connected" type="button" class="secondary" :disabled="busy" @click="disconnect">解绑</button></div>
      <p v-if="state.connected" class="bot-muted">当前连接：{{ state.origin }} · {{ state.botName }}<br>{{ state.testedAt ? '生成回传已验证' : '接口已连接，尚待生成测试' }}</p>
    </div>
    <div v-if="step===4">
      <h4>验证生成与回传</h4><p>发送一句测试文本，检查自动化任务是否运行并将结果送回。测试会消耗一次生成用量。</p>
      <p v-if="state.pendingOrigin" class="bot-muted">待验证：{{ state.pendingOrigin }}。测试通过后替换当前连接，期间继续保留原连接。</p>
      <button type="button" :disabled="busy || !state.connected || testPending" @click="test">{{ testPending ? '正在等待回传…' : '开始生成测试' }}</button>
      <label class="bot-toggle"><input type="checkbox" :checked="state.enabled" :disabled="busy || !state.testedAt" @change="toggle($event.target.checked)" />启用连接 <span class="info-tip" tabindex="0" role="note" data-tip="启用并通过生成测试后，可在 Grok 创作设置中选择 Grok Webhook。未知结果仅查询原任务。" aria-label="启用并通过生成测试后，可在 Grok 创作设置中选择 Grok Webhook。未知结果仅查询原任务。">?</span></label>
      <p class="bot-muted">每30秒查询一次。关闭面板不取消云端任务，重新打开可继续查询。结果保留在下方。</p>
    </div>
    <p v-if="message" role="status" class="bot-status">{{ message }}</p><p v-if="error" role="alert" class="bot-error">{{ error }}</p>
    <div class="bot-actions bot-navigation"><button v-if="step>1" type="button" class="secondary" @click="step--">上一步</button><button v-if="step<4" type="button" class="secondary" @click="step++">下一步</button></div>
    </details>
    <details v-if="jobs.length" class="bot-jobs" open><summary>备用任务 · {{ jobs.length }} <button type="button" class="secondary" :disabled="busy" @click.prevent="refreshJobs">刷新</button></summary><article v-for="job in jobs" :key="job.id"><div class="bot-job-heading"><strong>{{ labels[job.status] || job.status }}{{ job.test ? ' · 连接测试' : '' }}</strong><time>{{ new Date(job.createdAt).toLocaleString('zh-CN',{hour12:false}) }}</time></div><small>{{ job.id }}</small><p v-if="job.reason" class="bot-muted">{{ reasonText(job.reason) }}</p><button v-if="!['completed','failed'].includes(job.status)" type="button" class="secondary" :disabled="busy" @click="resume(job.id)">继续查询</button><pre v-if="job.result">{{ job.result }}</pre><button v-if="job.result" type="button" class="secondary" @click="copy(job.result)">复制结果</button></article></details>
  </section>
</template>
<script setup>
import {ref,onMounted,onUnmounted} from 'vue';
import BotOnboardingWizard from './BotOnboardingWizard.vue';
import {grokBotRelay as service,relayOrigin,BOT_POLL_MS} from '../../../features/grok/grok-bot-relay.js';
import {grokProviderController} from '../composables/useGrokProvider.js';
const tutorialUrl=chrome.runtime.getURL('grok-bot-guide.html');
const steps=['Webhook','Cloudflare','绑定','测试'],labels={dispatching:'提交中',accepted:'生成中',unknown:'待确认',completed:'已完成',failed:'失败'};
const step=ref(1),state=ref({}),origin=ref(''),token=ref(''),busy=ref(false),message=ref(''),error=ref(''),jobs=ref([]),testPending=ref(false);
let timer,disposed=false;
async function refresh(){state.value=await service.status();if(!origin.value)origin.value=state.value.origin;await refreshJobs();if(state.value.enabled)await grokProviderController.complete();}
async function refreshJobs(){jobs.value=await service.jobs();testPending.value=jobs.value.some(j=>j.test&&!['completed','failed'].includes(j.status));}
async function task(work){if(busy.value)return;busy.value=true;error.value='';message.value='';try{await work();await refresh();}catch(e){error.value=e.message;}finally{busy.value=false;}}
function bind(){
  // Request precise origin permission in the direct click gesture, before network awaits.
  let value;try{value=relayOrigin(origin.value);}catch(e){error.value=e.message;return;}
  const permission=chrome.permissions.request({origins:[value+'/*']});
  void task(async()=>{if(!await permission)throw Error('请允许访问所填接口地址后重试');const result=await service.connect({origin:value,token:token.value});token.value='';message.value=result.pendingOrigin?'新接口已连接，测试通过后替换当前连接':'接口已绑定，请完成生成测试';step.value=4;});
}
const disconnect=()=>task(async()=>{await service.disconnect();await grokProviderController.select('grok');token.value='';origin.value='';message.value='已解绑。云端任务仍保留；撤销连接请在 Worker 更换 CLIENT_TOKEN。';});
const toggle=value=>task(async()=>{await service.enable(value);if(!value)await grokProviderController.select('grok');message.value=value?'备用通道已启用':'备用通道已暂停';});
const test=()=>task(async()=>{const result=await service.generate('请仅返回：XFollower Grok Webhook 连接成功。',{test:true,requestKey:'connection-test-'+(state.value.pendingOrigin||state.value.origin),timeoutMs:0});const job=(await service.jobs()).find(j=>j.id===result.jobId);message.value=result.ok?'测试通过，备用通道已启用':result.pending&&job?.status==='accepted'?'测试任务已接收，每30秒查询一次':result.reason;if(!result.ok&&!result.pending)throw Error(result.reason);});
const resume=id=>task(async()=>{const job=await service.query(id);message.value=job.status==='completed'?'结果已收到':`任务状态：${labels[job.status]}`;});
const copy=async text=>{try{await navigator.clipboard.writeText(text);message.value='已复制结果';}catch{error.value='复制失败，请选中结果复制';}};
async function poll(){
  if(disposed)return;
  try{if(!busy.value&&state.value.connected){const wasTested=Boolean(state.value.testedAt),hadPending=Boolean(state.value.pendingOrigin);const pending=(await service.jobs()).filter(j=>!['completed','failed'].includes(j.status)&&!(j.test&&j.requestTag?.startsWith('onboarding:')));for(const job of pending){if(disposed)break;try{await service.query(job.id);}catch(e){error.value=e.message;}}if(!disposed){await refresh();if((!wasTested||hadPending&&!state.value.pendingOrigin)&&state.value.testedAt)message.value='测试通过，备用通道已启用';}}}
  finally{if(!disposed)timer=setTimeout(poll,BOT_POLL_MS);}
}
onMounted(async()=>{try{await refresh();step.value=state.value.connected?4:1;}catch(e){error.value=e.message;}if(!disposed)timer=setTimeout(poll,BOT_POLL_MS);});
onUnmounted(()=>{disposed=true;clearTimeout(timer);token.value='';});
function reasonText(code){return code==='NOT_SENT_WORKERS_REDIRECT_UNSUPPORTED'?'此测试在提交前失败，记录已保留':code==='NETWORK_ERROR'||code==='TIMEOUT'?'提交结果待确认，请继续查询原任务':/^HTTP_40[13]$/.test(code)?'Grok 拒绝了请求，请检查端点和签名密钥':/^HTTP_429$/.test(code)?'Grok 暂时限流，请稍后检查任务记录':'请检查 Grok 任务运行记录与中转配置';}
</script>
<style scoped>
.bot-manual{margin-top:12px}.bot-manual>summary{cursor:pointer;color:#607c70;font-size:12px}.bot-settings{font-size:12px;color:#24483b}.bot-heading,.bot-actions,.bot-job-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.bot-heading{justify-content:space-between}.bot-settings h4{font-size:13px;margin:14px 0 8px}.bot-settings p{line-height:1.7;margin:8px 0;overflow-wrap:anywhere}.bot-muted{color:#607c70}.bot-steps{display:flex;gap:10px;margin:12px 0;flex-wrap:wrap}.bot-steps button{height:30px;padding:0 10px;font-size:12px;background:#eef3ef;color:#24594a;border:1px solid #dce6de}.bot-steps button.selected{background:#24594a;color:#fff}.bot-settings label:not(.bot-toggle){display:block;margin:10px 0 6px}.bot-settings input:not([type=checkbox]){width:100%;height:34px;box-sizing:border-box}.bot-actions{margin:10px 0}.bot-settings button,.bot-link{font-size:12px;min-height:30px}.bot-link{display:inline-flex;align-items:center;border:1px solid #bed2c4;border-radius:5px;padding:0 10px;text-decoration:none;color:#24594a;background:#eef3ef}.bot-toggle{display:flex;align-items:center;gap:8px;margin:14px 0}.bot-status{color:#24594a}.bot-error{color:#b42318}.bot-jobs{border-top:1px solid #dce6de;padding-top:12px}.bot-jobs summary{cursor:pointer}.bot-jobs summary button{margin-left:10px}.bot-jobs article{border-bottom:1px solid #dce6de;padding:12px 0}.bot-job-heading{justify-content:space-between}.bot-jobs small{display:block;overflow-wrap:anywhere;color:#607c70;margin:6px 0}.bot-jobs pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;background:#f4f7f5;padding:10px;line-height:1.7}.bot-jobs time{color:#607c70;font-size:11px}
</style>
