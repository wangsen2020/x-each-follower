import './grok-bot-guide.css';
import './grok-local-guide.css';

const screenshots=import.meta.glob('../../assets/grok-local-tutorial/*.png',{eager:true,query:'?url',import:'default'});
const names={home:'02-bridge-home.png',settings:'03-bridge-settings.png',connect:'04-plugin-connect.png',test:'05-plugin-test.png',provider:'06-provider.png'};
for(const figure of document.querySelectorAll('[data-image]')){
  const url=screenshots['../../assets/grok-local-tutorial/'+names[figure.dataset.image]];
  if(!url)throw Error('Missing tutorial screenshot: '+figure.dataset.image);
  const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';link.title='打开原图';
  const img=new Image();img.src=url;img.alt=figure.querySelector('figcaption').textContent;img.loading='lazy';link.append(img);figure.prepend(link);
}
const input=document.querySelector('#extensionOrigin'),config=document.querySelector('#originConfig');
const id=globalThis.chrome?.runtime?.id;
const origin=id?`chrome-extension://${id}`:'chrome-extension://你的扩展ID';
input.value=origin;
config.textContent='"allowedOrigins": [\n  "'+origin+'"\n]';
document.querySelector('#originHint').textContent=id?'已读取当前扩展地址。保留已有地址，把这一项加入数组。':'请从插件「系统设置 → AI 引擎 → 连接帮助」复制实际地址，替换示例。';
const status=document.querySelector('#copyStatus');let timer;
async function copy(text){
  try{await navigator.clipboard.writeText(text);status.textContent='已复制';}
  catch{
    let dialog=document.querySelector('#guideCopyFallback');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='guideCopyFallback';dialog.setAttribute('aria-label','手动复制');const p=document.createElement('p');p.textContent='自动复制未完成。内容已选中，按 Ctrl+C 复制。';const area=document.createElement('textarea');area.readOnly=true;area.setAttribute('aria-label','待复制内容');const close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=()=>dialog.close();dialog.append(p,area,close);document.body.append(dialog);}
    const area=dialog.querySelector('textarea');area.value=text;dialog.showModal();area.focus();area.select();status.textContent='请手动复制选中内容';
  }
  clearTimeout(timer);timer=setTimeout(()=>{status.textContent='';},4000);
}
document.querySelector('#copyOrigin').disabled=!id;
document.querySelector('#copyConfig').disabled=!id;
document.querySelector('#copyOrigin').addEventListener('click',()=>copy(origin));
document.querySelector('#copyConfig').addEventListener('click',()=>copy(config.textContent));
