<template>
  <section class="local-bot">
    <div class="local-heading"><h3>Grok Bot</h3><a :href="tutorialUrl" target="_blank" rel="noopener">图解教程</a></div>
    <p class="local-muted">通过本机 Grok Bridge 调用已登录的 Grok Bot。</p>
    <nav class="local-steps" aria-label="本地接入步骤"><button v-for="(label,index) in steps" :key="label" type="button" :class="{selected:step===index+1}" :aria-current="step===index+1?'step':undefined" @click="step=index+1">{{ index+1 }} {{ label }}</button></nav>
    <div v-if="step===1">
      <h4>下载并运行 Grok Bridge</h4><p>先打开 Grok Bot 桌面端并登录，确认能正常对话。下载 Windows x64 正式版到固定文件夹，运行后保持 Grok Bot 与 Bridge 开启。</p>
      <div class="local-actions"><a class="local-link" href="https://github.com/wangsen2020/grok-bot-bridge/releases/download/v0.7.0/grok-bridge-0.7.0-win-x64.zip" target="_blank" rel="noopener">下载 Grok Bridge</a><a :href="tutorialUrl+'#download'" target="_blank" rel="noopener">查看下载步骤</a></div>
      <p class="local-muted">下载 0.7.0 Windows x64 完整 ZIP，完整解压后运行 grok-bridge.exe，无需另装 Node.js 或 CLI。保留配套服务 EXE 与三个 DLL，不下载 Source code。</p>
    </div>
    <div v-if="step===2">
      <h4>允许当前扩展连接</h4><p>在 Bridge「设置」点击「打开配置文件夹」，编辑 config.json。把下面地址加入 allowedOrigins 数组，保留已有地址；保存后在 Bridge 首页点击「重启服务」。</p>
      <code class="local-origin">{{ extensionOrigin }}</code><button type="button" @click="copyOrigin">复制扩展地址</button>
      <p class="local-muted">端口和 Token 保留原值。只允许自己的扩展，不填写通配符。<a :href="tutorialUrl+'#allow'" target="_blank" rel="noopener">查看配置示例</a></p>
    </div>
    <div v-show="step===3">
    <h4>连接并选择测试 Bot</h4><p>从 Bridge 首页「访问凭证」复制 Token，填写同一页面显示的端口，读取列表后选择具体 Bot。</p>
    <label for="localPort">端口号</label><input id="localPort" v-model.number="port" type="number" min="1" max="65535" :disabled="busy">
    <label for="localToken">连接 Token</label><input id="localToken" v-model="token" type="password" autocomplete="new-password" placeholder="粘贴服务 config.json 中的 token" :disabled="busy">
    <button type="button" :disabled="busy" @click="loadBots">读取 Bot 列表</button>
    <label for="localBot">测试 Bot</label><PanelSelect id="localBot" v-model="bot" :disabled="busy || !bots.length"><option value="">请选择 Bot</option><option v-for="item in bots" :key="item.id" :value="item.id">{{ item.id===state.bot && state.botName ? state.botName : item.name }}</option></PanelSelect>
    </div>
    <div v-if="step===4">
    <h4>验证生成与回复</h4><p>本次测试：端口 {{ port }} · {{ bots.find(item=>item.id===bot)?.name || '尚未选择 Bot' }}。<button type="button" class="secondary" @click="step=3">修改连接</button></p>
    <p>测试会向所选 Bot 发送一条消息。生成时使用的 Bot 请在创作配置中选择；同一连接下的测试不会切换生成 Bot。</p>
    <button type="button" :disabled="busy || !bot || !token" @click="test">{{ busy ? '处理中…' : '测试并启用' }}</button>
    <p v-if="state.enabled">已保存：端口 {{ state.port }} · {{ state.botName || state.bot }} <span class="info-tip" tabindex="0" role="note" data-tip="端口、Token 和 Bot 仅保存在本机扩展数据库。重新打开设置自动还原，Token 不进入业务备份。" aria-label="端口、Token 和 Bot 仅保存在本机扩展数据库。重新打开设置自动还原，Token 不进入业务备份。">?</span></p>
    <p v-if="state.enabled" class="local-muted">在创作配置中选择「Grok Bot」及生成 Bot 后使用。关闭设置会保留连接，关闭 Bridge 会暂停本地生成。</p>
    </div>
    <p v-if="message" role="status">{{ message }}</p><p v-if="error" role="alert" class="error">{{ error }}</p>
    <div class="local-actions local-navigation"><button v-if="step>1" type="button" class="secondary" :disabled="busy" @click="step--">上一步</button><button v-if="step<4" type="button" :disabled="busy || step===3 && (!bot || !token)" @click="step++">{{ step===3 ? '下一步：测试' : '下一步' }}</button></div>
  </section>
</template>
<script setup>
import PanelSelect from "./PanelSelect.vue";
import {ref,onMounted,watch} from 'vue';
import {grokLocal} from '../../../features/grok/grok-local.js';
import {grokProviderController} from '../composables/useGrokProvider.js';
const extensionOrigin=`chrome-extension://${chrome.runtime.id}`;
const tutorialUrl=chrome.runtime.getURL('grok-local-guide.html');
const steps=['下载','授权','连接','测试'],step=ref(1);
async function copyOrigin(){try{await navigator.clipboard.writeText(extensionOrigin);message.value='扩展地址已复制';}catch{error.value='复制失败，请选中上方扩展地址手动复制';}}
const port=ref(8787),token=ref(''),bot=ref(''),bots=ref([]),busy=ref(false),message=ref(''),error=ref(''),state=ref({});
let restoring=true;
watch([port,token],()=>{if(!restoring){bots.value=[];bot.value='';message.value='';error.value='';}},{flush:'sync'});
onMounted(async()=>{try{const saved=await grokLocal.configuration();state.value=await grokLocal.status();port.value=saved?.port||8787;token.value=saved?.token||'';bots.value=saved?.bot?[{id:saved.bot,name:saved.botName||saved.bot}]:[];bot.value=saved?.bot||'';step.value=state.value.enabled?4:saved?3:1;}catch(e){error.value=e.message;}finally{restoring=false;}});
function loadBots(){const permission=chrome.permissions.request({origins:['http://127.0.0.1/*']});void run(async()=>{if(!await permission)throw Error('请允许访问本地服务');bots.value=await grokLocal.list({port:port.value,token:token.value});bot.value=bots.value.some(b=>b.id===state.value.bot)?state.value.bot:'';message.value=bots.value.length?'请选择 Bot':'未找到可用 Bot';});}
function test(){void run(async()=>{await grokLocal.test({port:port.value,token:token.value,bot:bot.value},{preserveBot:true});state.value=await grokLocal.status();message.value='测试通过，配置已保存';await grokProviderController.complete('grok-local');});}
async function run(work){if(busy.value)return;busy.value=true;error.value='';message.value='';try{await work();}catch(e){error.value=e.message;}finally{busy.value=false;}}
</script>
<style scoped>
.local-bot{font-size:12px;color:#24483b}.local-bot p{line-height:1.6}.local-bot label{display:block;margin:10px 0 6px}.local-bot input,.local-bot select{display:block;width:100%;height:34px;box-sizing:border-box}.local-bot button{margin-top:10px;font-size:12px;min-height:30px}.local-bot code{overflow-wrap:anywhere}.error{color:#b42318}
.local-heading,.local-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.local-heading h3{margin:0}.local-muted{color:#607c70}.local-bot h4{font-size:13px;margin:16px 0 8px}.local-steps{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.local-steps button{margin:0;background:#eef3ef;color:#24594a;border:1px solid #dce6de;padding:0 10px}.local-steps button.selected{background:#24594a;color:#fff}.local-origin{display:block;user-select:all;background:#f0f5f1;padding:10px;border-radius:6px}.local-link{display:inline-flex;align-items:center;min-height:32px;padding:0 10px;background:#eef3ef;border:1px solid #bed2c4;border-radius:5px;color:#24594a;text-decoration:none}.local-actions{justify-content:flex-start;margin-top:12px}.local-navigation{border-top:1px solid #dce6de;padding-top:6px;margin-top:16px}.local-bot button.secondary{background:#eef3ef;color:#24594a}
</style>
