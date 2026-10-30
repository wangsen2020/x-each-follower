<template>
  <section class="ai-settings" aria-label="AI 引擎设置">
    <div class="ai-heading"><h3>AI 引擎</h3><a href="grok-local-guide.html" target="_blank" rel="noopener">接入教程</a><a href="https://github.com/wangsen2020/grok-bot-bridge/releases/latest" target="_blank" rel="noopener">下载 AgentRelay</a></div>
    <p class="ai-muted">Grok Bot、Codex 和 Antigravity 共用服务连接，各自保存生成会话。</p>
    <div class="ai-form">
      <label for="ai-url">服务地址<InfoTip text="填写 AgentRelay 首页显示的根地址。三个引擎自动使用对应接口前缀，无需填写 /grokbot、/codex 或 /antigravity。" /></label>
      <input id="ai-url" v-model.trim="baseUrl" type="url" spellcheck="false" :disabled="busy" placeholder="http://127.0.0.1:8787">
      <label for="ai-token">连接 Token</label><input id="ai-token" v-model.trim="token" type="password" autocomplete="new-password" :disabled="busy" placeholder="AgentRelay 访问凭证">
    </div>
    <nav class="ai-tabs" aria-label="引擎配置"><button v-for="item in LOCAL_AI_ENGINES" :key="item.provider" type="button" :disabled="busy" :aria-pressed="provider===item.provider" @click="switchEngine(item.provider)">{{ item.label }}</button></nav>
    <div class="ai-form">
      <label for="ai-session">生成会话</label><PanelSelect id="ai-session" v-model="session" :title="sessions.find(s=>s.id===session)?.title||sessions.find(s=>s.id===session)?.name" :disabled="busy||!sessions.length"><option value="">请选择会话</option><option v-for="item in sessions" :key="item.id" :value="item.id" :title="item.title||item.name">{{ sessionLabel(item.name,item.id) }}</option></PanelSelect>
      <span class="ai-label">连接状态</span><span class="ai-state" role="status">{{ saved.enabled ? '已验证 · '+sessionLabel(saved.botName,saved.bot) : '尚未验证' }}</span>
    </div>
    <div class="ai-actions"><button type="button" class="secondary" :disabled="busy||!token" @click="loadSessions">读取会话</button><button type="button" :disabled="busy||!session||!token" @click="test">{{ busy?'处理中…':'测试并保存' }}</button></div>
    <div v-if="provider!=='grok-local'" class="ai-create"><label for="ai-session-name">新会话</label><div class="ai-create-controls"><input id="ai-session-name" v-model.trim="sessionName" maxlength="100" :disabled="busy" placeholder="例如：XFollower 评论"><button type="button" class="secondary" :disabled="busy||!sessionName||!token" @click="createSession">创建会话</button></div></div>
    <p v-if="message" class="ai-feedback" role="status">{{ message }}</p><p v-if="error" class="ai-feedback ai-error" role="alert">{{ error }}</p>
    <p class="ai-muted">测试会发送一条验证消息，收到完整回复后保存。采集、评论和知识库可分别选择引擎与会话；切换配置不会重发已有任务。</p>
    <details class="ai-help"><summary>连接帮助</summary><p>运行 AgentRelay，并确认对应客户端已登录。如提示来源未授权，在 AgentRelay 中允许当前扩展来源：</p><code>{{ extensionOrigin }}</code><button type="button" class="secondary" @click="copyOrigin">复制扩展地址</button><p>配置和 Token 仅保存在本机扩展数据库。旧 Grok Bot 配置会自动读取，已有任务仍通过原连接查询。</p></details>
  </section>
</template>
<script setup>
import {ref,onMounted,watch} from 'vue';
import PanelSelect from './PanelSelect.vue';
import {sessionLabel} from '../../../features/grok/agent-relay-client.js';
import InfoTip from './InfoTip.vue';
import {LOCAL_AI_ENGINES,getLocalAiService,isLocalAiProvider,connectionUrl} from '../../../features/grok/grok-local.js';
import {grokProviderController} from '../composables/useGrokProvider.js';
// Keep the internal component/event names for existing entry points.
const props=defineProps({initialProvider:{type:String,default:'grok-local'}});
const provider=ref(isLocalAiProvider(props.initialProvider)?props.initialProvider:'grok-local'),baseUrl=ref('http://127.0.0.1:8787'),token=ref(''),session=ref(''),sessions=ref([]),saved=ref({}),busy=ref(false),message=ref(''),error=ref(''),sessionName=ref('');
const extensionOrigin=`chrome-extension://${chrome.runtime.id}`;
let initialized=false,restoreRevision=0;
const service=()=>getLocalAiService(provider.value);
const input=()=>({baseUrl:baseUrl.value,token:token.value,bot:session.value,engine:LOCAL_AI_ENGINES.find(e=>e.provider===provider.value).engine,protocol:'unified'});
async function restore(connection=false){
  const ticket=++restoreRevision,client=service();
  const [config,status]=await Promise.all([client.configuration(),client.status()]);
  if(ticket!==restoreRevision)return;
  if(connection){baseUrl.value=config?connectionUrl(config):baseUrl.value;token.value=config?.token||'';}
  const same=config&&connectionUrl(config)===connectionUrl(input())&&config.token===token.value;
  saved.value=same?status:{};
  session.value=same?config.bot||'':'';
  sessions.value=same&&config.bot?[{id:config.bot,name:config.botName||config.bot}]:[];
}
async function run(work){if(busy.value)return;busy.value=true;error.value='';message.value='';try{await work();}catch(e){error.value=e.message;}finally{busy.value=false;}}
async function switchEngine(value){if(busy.value)return;provider.value=value;message.value='';error.value='';sessionName.value='';try{await restore();}catch(e){error.value=e.message;}}
onMounted(async()=>{try{await restore(true);}catch(e){error.value=e.message;}finally{initialized=true;}});
watch(()=>props.initialProvider,value=>{if(isLocalAiProvider(value))void switchEngine(value);});
watch([baseUrl,token],()=>{if(initialized){sessions.value=[];session.value='';saved.value={};message.value='';}});
function withAccess(work){let permission;try{permission=chrome.permissions.request({origins:[connectionUrl(input())+'/*']});}catch(e){error.value=e.message;return;}void run(async()=>{if(!await permission)throw Error('请允许访问 AI 服务');await work();});}
function loadSessions(){withAccess(async()=>{await service().health(input());const previous=session.value;sessions.value=await service().list(input());session.value=sessions.value.some(s=>s.id===previous)?previous:'';message.value=sessions.value.length?'连接正常，请选择会话并测试保存':'连接正常，暂无可用会话';});}
function test(){withAccess(async()=>{await service().test(input(),{preserveBot:false});saved.value=await service().status();message.value='测试通过，连接和会话已保存';await grokProviderController.complete(provider.value);});}
function createSession(){withAccess(async()=>{const result=await service().createSession(input(),sessionName.value);sessions.value=await service().list(input());session.value=result.session?.id||result.id||'';sessionName.value='';message.value='会话已创建，请测试并保存';});}
async function copyOrigin(){try{await navigator.clipboard.writeText(extensionOrigin);message.value='扩展地址已复制';}catch{error.value='复制失败，请手动复制上方扩展地址';}}
</script>
<style scoped>
.ai-settings{display:flex;flex-direction:column;gap:10px;min-width:0;font-size:12px;color:#24483b}.ai-settings p,.ai-settings h3{margin:0;line-height:1.6}.ai-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.ai-heading h3{font-size:14px}.ai-form{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px;align-items:center}.ai-form label,.ai-label{display:flex;flex-direction:row;flex-wrap:nowrap;justify-content:flex-start;text-align:start;align-items:center;gap:10px;min-height:30px;font-weight:600;margin:0}.ai-form label > .info-tip{flex:0 0 auto;margin:0}.ai-settings input,.ai-settings select{box-sizing:border-box;width:100%;min-width:0;height:30px;margin:0;padding:0 10px;border:1px solid #c8d8ce;border-radius:6px;font:inherit;color:inherit}.ai-settings button{min-height:30px;margin:0;padding:0 10px;font:inherit;white-space:nowrap}.ai-tabs,.ai-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.ai-tabs{border-top:1px solid #dce6de;padding-top:10px}.ai-tabs button{background:#eef3ef;color:#24594a;border:1px solid #dce6de;border-radius:6px}.ai-tabs button[aria-pressed=true]{background:#24594a;border-color:#24594a;color:white}.ai-actions{justify-content:flex-end}.ai-state,.ai-muted{color:#60776a;min-width:0;overflow-wrap:anywhere}.ai-settings select{color-scheme:light;background:#fff;color:#24483b}.ai-settings select option{color:#24483b;background:#fff}.ai-create{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px;align-items:center;padding-top:10px;border-top:1px solid #dce6de}.ai-create>label{font-weight:600}.ai-create-controls{display:flex;gap:10px;align-items:center;min-width:0}.ai-feedback{padding:10px;border:1px solid #c8d8ce;background:#f3f8f4;border-radius:6px;overflow-wrap:anywhere}.ai-error{color:#a52f2f;border-color:#f2cccc;background:#fff6f5}.ai-help{border-top:1px solid #dce6de;padding-top:10px}.ai-help summary{cursor:pointer}.ai-help p,.ai-help code,.ai-help button{margin-top:10px}.ai-help code{display:block;padding:10px;background:#f3f6f3;border-radius:6px;overflow-wrap:anywhere;user-select:all}@media(max-width:440px){.ai-form,.ai-create{grid-template-columns:80px minmax(0,1fr)}.ai-create-controls{flex-wrap:wrap}}
</style>
