<template>
  <section class="local-bot">
    <h3>Grok Bot 本地连接</h3>
    <p><a href="https://github.com/wangsen2020/gbot-local-service/releases/tag/v0.2.1" target="_blank" rel="noopener">下载 Windows 本地服务</a>。安装 Node.js 22.19+，登录 Grok Bot 桌面端后运行 EXE。服务已包含兼容的 CLI。</p>
    <details :open="!state.configured"><summary>连接步骤</summary><p>打开 EXE 同目录的 config.json，把 allowedOrigins 设置为 <code>["{{ extensionOrigin }}"]</code>，保存并重启服务。将其中的 token 粘贴到下方；端口与文件中的 port 一致。</p></details>
    <label for="localPort">端口号</label><input id="localPort" v-model.number="port" type="number" min="1" max="65535" :disabled="busy">
    <label for="localToken">连接 Token</label><input id="localToken" v-model="token" type="password" autocomplete="new-password" placeholder="粘贴服务 config.json 中的 token" :disabled="busy">
    <button type="button" :disabled="busy" @click="loadBots">读取 Bot 列表</button>
    <label for="localBot">Bot</label><select id="localBot" v-model="bot" :disabled="busy || !bots.length"><option value="">请选择 Bot</option><option v-for="item in bots" :key="item.id" :value="item.id">{{ item.id===state.bot && state.botName ? state.botName : item.name }}</option></select>
    <p>测试会向所选 Bot 发送一条消息，收到完整回复后启用。更换端口、Token 或 Bot 需重新测试。</p>
    <button type="button" :disabled="busy || !bot || !token" @click="test">{{ busy ? '处理中…' : '测试并启用' }}</button>
    <p v-if="state.enabled">已保存：端口 {{ state.port }} · {{ state.botName || state.bot }} <span class="info-tip" tabindex="0" role="note" data-tip="端口、Token 和 Bot 仅保存在本机扩展数据库。重新打开设置自动还原，Token 不进入业务备份。" aria-label="端口、Token 和 Bot 仅保存在本机扩展数据库。重新打开设置自动还原，Token 不进入业务备份。">?</span></p>
    <p v-if="message" role="status">{{ message }}</p><p v-if="error" role="alert" class="error">{{ error }}</p>
  </section>
</template>
<script setup>
import {ref,onMounted,watch} from 'vue';
import {grokLocal} from '../../../features/grok/grok-local.js';
import {grokProviderController} from '../composables/useGrokProvider.js';
const extensionOrigin=`chrome-extension://${chrome.runtime.id}`;
const port=ref(8787),token=ref(''),bot=ref(''),bots=ref([]),busy=ref(false),message=ref(''),error=ref(''),state=ref({});
let restoring=true;
watch([port,token],()=>{if(!restoring){bots.value=[];bot.value='';message.value='';error.value='';}},{flush:'sync'});
onMounted(async()=>{try{const saved=await grokLocal.configuration();state.value=await grokLocal.status();port.value=saved?.port||8787;token.value=saved?.token||'';bots.value=saved?.bot?[{id:saved.bot,name:saved.botName||saved.bot}]:[];bot.value=saved?.bot||'';}catch(e){error.value=e.message;}finally{restoring=false;}});
function loadBots(){const permission=chrome.permissions.request({origins:['http://127.0.0.1/*']});void run(async()=>{if(!await permission)throw Error('请允许访问本地服务');bots.value=await grokLocal.list({port:port.value,token:token.value});bot.value=bots.value.some(b=>b.id===state.value.bot)?state.value.bot:'';message.value=bots.value.length?'请选择 Bot':'未找到可用 Bot';});}
function test(){void run(async()=>{await grokLocal.test({port:port.value,token:token.value,bot:bot.value});state.value=await grokLocal.status();message.value='测试通过，配置已保存';await grokProviderController.complete('grok-local');});}
async function run(work){if(busy.value)return;busy.value=true;error.value='';message.value='';try{await work();}catch(e){error.value=e.message;}finally{busy.value=false;}}
</script>
<style scoped>
.local-bot{font-size:12px;color:#24483b}.local-bot p{line-height:1.6}.local-bot label{display:block;margin:10px 0 6px}.local-bot input,.local-bot select{display:block;width:100%;height:34px;box-sizing:border-box}.local-bot button{margin-top:10px;font-size:12px;min-height:30px}.local-bot code{overflow-wrap:anywhere}.error{color:#b42318}
</style>
