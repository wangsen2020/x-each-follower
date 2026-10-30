import './grok-bot-guide.css';
import {buildGrokBotInstruction} from '../../features/grok/grok-bot-instruction.js';
import workerSource from '../../../deploy/grok-bot-relay/worker.js?raw';
import schema from '../../../deploy/grok-bot-relay/schema.sql?raw';
import config from '../../../deploy/grok-bot-relay/wrangler.jsonc?raw';
import packageSource from '../../../deploy/grok-bot-relay/package.json?raw';
import bundledWorker from '../../assets/grok-bot-relay-worker.txt?raw';
import workerTests from '../../../deploy/grok-bot-relay/test/worker.test.js?raw';
import runtimeTests from '../../../deploy/grok-bot-relay/test/runtime.test.js?raw';
import d1TestAdapter from '../../../deploy/grok-bot-relay/test/d1-mock.js?raw';
import notices from '../../../THIRD_PARTY_NOTICES.txt?raw';
import ignoreSource from '../../../deploy/grok-bot-relay/.gitignore?raw';

const images=import.meta.glob('../../assets/grok-bot-tutorial/*.png',{eager:true,query:'?url',import:'default'});
const imageNames={usage:'01-usage.png',webhook:'02-webhook.png',cloudflareCreate:'03-cloudflare-create.png',cloudflareEditor:'04-cloudflare-editor.png',d1:'05-d1.png',secrets:'06-secrets.png',instruction:'07-instruction.png',pluginBind:'08-plugin-bind.png',pluginTest:'09-plugin-test.png',run:'10-run.png',provider:'11-provider-switch.png',onboarding:'12-onboarding.png',onboardingDone:'13-onboarding-complete.png'};
for(const figure of document.querySelectorAll('[data-image]')){
  const filename=imageNames[figure.dataset.image];const url=images['../../assets/grok-bot-tutorial/'+filename];
  if(!url){figure.hidden=true;continue;}
  const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener';a.title='打开原图';
  const img=new Image();img.src=url;img.alt=figure.querySelector('figcaption').textContent;img.loading='lazy';a.append(img);figure.prepend(a);
}
const files=[['Worker 源码 · worker.js','worker.js',workerSource],['可直接粘贴的 Worker · 已包含签名库','worker-bundle.js',bundledWorker],['数据库 SQL · schema.sql','schema.sql',schema],['Wrangler 配置 · wrangler.jsonc','wrangler.jsonc',config],['依赖与命令 · package.json','package.json',packageSource],['单元测试 · 使用公开假密钥','test/worker.test.js',workerTests],['Workers 运行时测试','test/runtime.test.js',runtimeTests],['测试用 D1 适配器','test/d1-mock.js',d1TestAdapter],['私密文件忽略规则','.gitignore',ignoreSource],['第三方许可说明','THIRD_PARTY_NOTICES.txt',notices]];
const status=document.querySelector('#copyStatus');let statusTimer;
function notify(message){status.textContent=message;clearTimeout(statusTimer);statusTimer=setTimeout(()=>{status.textContent=''},4000);}
async function copy(text){
  let timer;
  try{await Promise.race([navigator.clipboard.writeText(text),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Clipboard unavailable')),1500);})]);notify('已复制');}
  catch{
    let dialog=document.querySelector('#guideCopyFallback');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='guideCopyFallback';dialog.setAttribute('aria-label','复制实施内容');const title=document.createElement('p');title.textContent='浏览器未完成自动复制。内容已全部选中，按 Ctrl+C（Mac 按 ⌘C）复制。';const input=document.createElement('textarea');input.readOnly=true;input.setAttribute('aria-label','完整可复制内容');const close=document.createElement('button');close.type='button';close.textContent='关闭';close.addEventListener('click',()=>dialog.close());dialog.append(title,input,close);document.body.append(dialog);}
    const input=dialog.querySelector('textarea');input.value=text;if(!dialog.open)dialog.showModal();input.focus();input.select();notify('已准备完整内容，可按快捷键复制');
  }finally{clearTimeout(timer);}
}
files.forEach(([title,name,content])=>{
  const details=document.createElement('details');details.className='source-file';
  const summary=document.createElement('summary');summary.textContent=title;details.append(summary);
  const actions=document.createElement('div');actions.className='code-actions';
  const copyButton=document.createElement('button');copyButton.type='button';copyButton.textContent='复制代码';copyButton.addEventListener('click',()=>copy(content));
  const download=document.createElement('button');download.type='button';download.textContent='下载文件';download.addEventListener('click',()=>{
    const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name.replaceAll('/','-');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });actions.append(copyButton,download);details.append(actions);const pre=document.createElement('pre');pre.textContent=content;details.append(pre);document.querySelector('#sourceFiles').append(details);
});
let currentOrigin='https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev';
function updateInstruction(){
  const input=document.querySelector('#callbackOrigin');
  if(input.value){try{const url=new URL(input.value.trim());if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error();currentOrigin=url.origin;input.setCustomValidity('');}catch{input.setCustomValidity('请填写 HTTPS 域名，不带路径、参数或账号');return;}}
  document.querySelector('#botInstruction').textContent=buildGrokBotInstruction(currentOrigin);
}
document.querySelector('#callbackOrigin').addEventListener('input',updateInstruction);updateInstruction();
document.querySelector('[data-copy=botInstruction]').addEventListener('click',()=>{
  if(!document.querySelector('#callbackOrigin').value||!document.querySelector('#callbackOrigin').reportValidity()){notify('请先填写实际 Worker 地址');return;}
  void copy(document.querySelector('#botInstruction').textContent);
});
document.querySelector('#createToken').addEventListener('click',()=>{const bytes=crypto.getRandomValues(new Uint8Array(24));document.querySelector('#generatedToken').value=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');notify('已在本页生成，请复制并妥善保管');});
document.querySelector('#copyToken').addEventListener('click',()=>{const token=document.querySelector('#generatedToken').value;if(token)void copy(token);else notify('请先生成连接 Token');});
document.querySelector('#copyAll').addEventListener('click',()=>{
  const instruction=document.querySelector('#botInstruction').textContent;
  const body=document.querySelector('#agentPrompt').textContent;
  const content='# XFollower 云端事件 Cloud Event 备用通道实施包\n\n'+body+'\n\n## 配置教程\n'+[...document.querySelectorAll('main>section')].filter(s=>!['agent','code'].includes(s.id)).map(s=>s.innerText).join('\n\n')+'\n\n## Grok 固定指令\n'+instruction+'\n\n'+files.map(([,name,source])=>'## '+name+'\n```\n'+source+'\n```').join('\n\n');
  void copy(content);
});
