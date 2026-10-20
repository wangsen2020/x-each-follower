import {centeredAlertBounds} from './verification-alert-window.js';
const $=id=>document.getElementById(id);
const preview=new URLSearchParams(location.search).get('preview')==='1';
const previewTime=new Date().toISOString();

async function render() {
  const saved=await chrome.storage.local.get(['grokVerification','grokVerificationSelfMessage']);
  const notice=preview?{url:'https://x.com/i/grok',at:previewTime}:saved.grokVerification;
  const delivery=saved.grokVerificationSelfMessage;
  if(!notice) {
    $('helpTitle').textContent='主人，已经没事啦';
    $('helpLead').textContent='验证提醒已解除，等待中的任务将自动继续。';
    $('taskState').textContent='不再有待处理的验证提醒';
    $('siteLabel').textContent='';$('detectedAt').textContent='';
    $('instructions').textContent='这个小窗可以安心关闭了。';
    $('openVerification').textContent='返回 XFollower';
    $('deliveryStatus').textContent='';
    return;
  }
  $('helpTitle').textContent='主人，救救我…';
  $('helpLead').replaceChildren(document.createTextNode('我被安全验证拦住了，'),document.createElement('br'),document.createTextNode('这一步只有你能帮我完成。'));
  $('taskState').textContent='当前 Grok 任务已暂停';
  $('instructions').textContent='完成验证并恢复聊天输入框后，任务会自动继续。';
  if($('openVerification').textContent==='返回 XFollower')$('openVerification').textContent='去手动验证 ↗';
  try {$('siteLabel').textContent=new URL(notice.url).hostname;}catch{$('siteLabel').textContent='Grok 验证页面';}
  $('detectedAt').textContent=new Date(notice.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
  const related=delivery?.fingerprint?.endsWith(':'+notice.at);
  if(preview){
    document.querySelector('.attention').textContent='提醒效果预览';
    $('deliveryStatus').textContent='仅预览外观，不会发送私信或执行任务';
    return;
  }
  $('deliveryStatus').textContent=related?({sending:'也在给你的手机发私信提醒…',sent:'已向你的 X 本人会话发送私信提醒',uncertain:'手机私信结果待确认，请以这里的提醒为准',failed:'手机私信未能发送，请先在电脑完成验证'}[delivery.status] || '手机私信提醒正在准备中'):'手机私信提醒正在准备中';
}

$('openVerification')?.addEventListener('click',async()=>{
  if(preview){window.close();return;}
  $('openVerification').disabled=true;$('actionError').hidden=true;
  try {
    const {grokVerification:notice}=await chrome.storage.local.get('grokVerification');
    if(!notice)await chrome.tabs.create({url:chrome.runtime.getURL('panel.html'),active:true});
    else {
      const result=await chrome.runtime.sendMessage({cmd:'focusGrokVerificationPage'});
      if(!result?.ok)throw new Error(result?.error || '暂时打不开验证页，请返回面板查看。');
    }
    window.close();
  } catch(error){$('actionError').textContent=error.message;$('actionError').hidden=false;}
  finally{$('openVerification').disabled=false;}
});
$('dismissAlert')?.addEventListener('click',()=>window.close());
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes.grokVerification || changes.grokVerificationSelfMessage))render();});
const win=await chrome.windows.getCurrent();
await chrome.windows.update(win.id,centeredAlertBounds({left:screen.availLeft,top:screen.availTop,width:screen.availWidth,height:screen.availHeight}));
render();
