<template>
  <Teleport to="body">
    <div v-if="c.isOpen.value" class="cf-backdrop" @click.self="c.close()" @keydown.esc="c.close()">
      <section ref="dialog" class="cf-dialog" role="dialog" aria-modal="true" aria-labelledby="cloudflareImageTitle" :aria-busy="c.busy.value" tabindex="-1" @keydown.tab="trapFocus">
        <header><strong id="cloudflareImageTitle">Cloudflare 配图</strong><PanelCloseButton :disabled="c.busy.value" @click="c.close()" /></header>
        <ol class="cf-progress" aria-label="连接步骤">
          <li v-for="(label,index) in ['登录账号','填写账号','创建令牌','绑定完成']" :key="label" :class="{current:c.step.value===index+1,done:c.step.value>index+1}" :aria-current="c.step.value===index+1?'step':undefined"><span>{{ index+1 }}</span>{{ label }}</li>
        </ol>
        <div class="cf-body">
          <template v-if="c.step.value===1">
            <h3>登录你的 Cloudflare 账号</h3>
            <p>使用自己的 Workers AI 额度作为备用配图服务，无需域名或部署网站。</p>
            <p><strong>默认模型：FLUX.1 schnell</strong>。插件会自动调用，生成后整理为 5:2 文章封面。</p>
            <p class="cf-hint">无需在 Cloudflare 后台切换模型。Usage 是用量查看页；如需在 Playground 手动试图，选择 Text-to-Image 下的 flux-1-schnell。</p>
            <div class="cf-actions">
              <a href="https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/" target="_blank" rel="noopener noreferrer">查看模型说明</a>
              <a class="cf-link-button" :href="CLOUDFLARE_SETUP_URL" target="_blank" rel="noopener noreferrer">打开 Cloudflare</a>
            </div>
            <p>登录或注册后，选择要使用的账号，进入 <strong>Workers AI</strong>。准备好后点击“下一步”。</p>
          </template>
          <template v-else-if="c.step.value===2">
            <h3>复制 Account ID</h3>
            <p>在 Workers AI 页面打开 <strong>Use REST API</strong>，复制其中的 <strong>Account ID</strong>。</p>
            <label for="cloudflareAccountId">Account ID</label>
            <input id="cloudflareAccountId" v-model="c.accountId.value" type="text" autocomplete="off" spellcheck="false" :disabled="c.busy.value" placeholder="粘贴32位账号 ID" @keydown.enter.prevent="c.next()" />
            <a :href="CLOUDFLARE_SETUP_URL" target="_blank" rel="noopener noreferrer">返回 Workers AI 页面</a>
          </template>
          <template v-else-if="c.step.value===3">
            <h3>创建 Token 并测试出图</h3>
            <p>在刚才的页面点击 <strong>Create a Workers AI API Token</strong>，按专用模板创建，复制生成的 Token 到这里。</p>
            <p class="cf-hint">权限包含 Workers AI 的 Read 和 Edit，账号范围选择上一步的账号。请使用 API Token。</p>
            <label for="cloudflareImageToken">API Token</label>
            <input id="cloudflareImageToken" v-model="c.token.value" type="password" autocomplete="new-password" :disabled="c.busy.value" placeholder="粘贴 Workers AI 专用 Token" @keydown.enter.prevent="c.connect()" />
            <p class="cf-hint">Token 只保存在本机扩展中。点击“测试并绑定”会生成一张 5:2 测试封面，成功后保存连接。</p>
            <p class="cf-hint">测试与文章配图均使用 FLUX.1 schnell；Token 授予 Workers AI 访问权限，模型由插件在请求中指定。</p>
            <p class="cf-hint">测试占用账号额度。免费额度与该账号的其他 Workers AI 用量共用；Free 计划超额会停止，付费计划可能产生费用。</p>
          </template>
          <template v-else>
            <h3 class="cf-success">{{ c.preview.value?'绑定成功':'已绑定 Cloudflare' }}</h3>
            <p>已通过出图测试。优先使用 X.com Grok，无法出图时由此连接兜底。</p>
            <p class="cf-hint">配图模型：FLUX.1 schnell · 自动适配 5:2 封面</p>
            <p class="cf-account">Account ID：{{ c.boundAccountId.value }}</p>
            <figure v-if="c.preview.value"><img :src="c.preview.value" alt="Cloudflare 生成的5:2测试封面" /><figcaption>测试封面 · 5:2</figcaption></figure>
          </template>
          <p v-if="c.connected.value&&c.step.value<4" class="cf-hint">重新绑定成功后替换原连接；取消或测试失败时，原连接仍保留。</p>
          <p v-if="c.message.value&&!c.error.value" role="status">{{ c.message.value }}</p>
          <p v-if="c.error.value" class="cf-error" role="alert">{{ c.error.value }}</p>
        </div>
        <footer>
          <a href="https://developers.cloudflare.com/workers-ai/get-started/rest-api/" target="_blank" rel="noopener noreferrer">官方帮助</a>
          <div class="cf-actions">
            <template v-if="c.step.value<4">
              <button v-if="c.step.value>1" type="button" :disabled="c.busy.value" @click="c.back()">上一步</button>
              <button v-if="c.step.value<3" type="button" class="primary" :disabled="c.busy.value" @click="c.next()">下一步</button>
              <button v-else type="button" class="primary" :disabled="c.busy.value" @click="c.connect()">{{ c.busy.value?'正在测试出图…':'测试并绑定' }}</button>
            </template>
            <template v-else>
              <button type="button" :disabled="c.busy.value" @click="c.disconnect()">解绑</button>
              <button type="button" :disabled="c.busy.value" @click="c.rebind()">重新绑定</button>
              <button type="button" class="primary" :disabled="c.busy.value" @click="c.close()">完成</button>
            </template>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
<script setup>
import {ref,watch,nextTick} from 'vue';
import PanelCloseButton from './PanelCloseButton.vue';
import {cloudflareImagesController as c} from '../composables/useCloudflareImages.js';
import {CLOUDFLARE_SETUP_URL} from '../../../features/publishing/cloudflare-cover.js';
const dialog=ref(null);let previousFocus;
watch(()=>c.isOpen.value,async open=>{if(open){previousFocus=document.activeElement;await nextTick();dialog.value?.focus();}else previousFocus?.focus?.();});
watch(()=>c.step.value,async()=>{await nextTick();(dialog.value?.querySelector('input')||dialog.value)?.focus();});
function trapFocus(event){const items=[...dialog.value.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled)')];if(!items.length){event.preventDefault();return;}const first=items[0],last=items.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.value)){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
</script>
<style scoped>
.cf-backdrop{position:fixed;inset:0;z-index:10020;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;padding:20px}.cf-dialog{width:580px;max-width:100%;max-height:90vh;overflow:auto;background:var(--panel-bg,#fff);color:var(--text-color,#243d36);border-radius:14px;box-shadow:0 20px 70px #0003;outline:none}.cf-dialog header,.cf-dialog footer{padding:18px 22px;display:flex;align-items:center;justify-content:space-between;gap:12px}.cf-dialog header{border-bottom:1px solid #e3ebe6}.cf-progress{display:flex;list-style:none;padding:18px 22px 0;margin:0;gap:12px;justify-content:space-between}.cf-progress li{font-size:12px;color:#687970;display:flex;align-items:center;gap:6px}.cf-progress span{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#eef3ef}.cf-progress .current{color:#205b45;font-weight:700}.cf-progress .current span,.cf-progress .done span{background:#205b45;color:white}.cf-body{padding:12px 22px;line-height:1.7}.cf-body h3{font-size:18px;margin:12px 0}.cf-body p{margin:12px 0}.cf-hint{font-size:12px;color:#63746b}.cf-body label{display:block;font-weight:600;margin:14px 0 6px}.cf-body input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #bbccc1;border-radius:7px;margin-bottom:12px;font:inherit}.cf-dialog a{color:#205b45}.cf-link-button{display:inline-block;border:1px solid #bbccc1;border-radius:7px;padding:8px 16px;text-decoration:none}.cf-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.cf-dialog footer{border-top:1px solid #e3ebe6;font-size:12px}.cf-actions button{padding:9px 14px;border:1px solid #bbccc1;border-radius:7px;background:#fff;color:#205b45;cursor:pointer}.cf-actions .primary{background:#205b45;color:#fff;border-color:#205b45}.cf-actions button:disabled{opacity:.55;cursor:wait}.cf-error{color:#b42318}.cf-success{color:#205b45}.cf-account{font-size:12px;overflow-wrap:anywhere}.cf-body figure{margin:12px 0}.cf-body img{width:100%;height:auto;border-radius:8px}.cf-body figcaption{text-align:center;font-size:12px;color:#63746b}@media(max-width:480px){.cf-backdrop{padding:8px}.cf-progress{gap:5px}.cf-progress li{flex-direction:column}.cf-dialog footer{flex-wrap:wrap}}
</style>
