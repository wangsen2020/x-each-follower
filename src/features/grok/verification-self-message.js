const STATUS_KEY = 'grokVerificationSelfMessage';
const COOLDOWN = 10 * 60 * 1000;

export function buildVerificationSelfMessage(notice, identity) {
  const host = new URL(notice.url).hostname;
  if (!['x.com','twitter.com','grok.com'].includes(host)) throw new Error('验证页面地址无效');
  const at = new Date(notice.at);
  if (!Number.isFinite(at.getTime())) throw new Error('验证时间无效');
  const marker = 'XFV-' + at.getTime().toString(36);
  return `${notice.test === true ? '【XFollower 测试提醒】' : '【XFollower 手动验证提醒】'}\n账号：@${identity.handle}\nGrok 遇到人机或安全验证，当前任务已结束等待。\n页面：${host === 'grok.com' ? 'https://grok.com/' : 'https://x.com/i/grok'}\n时间：${at.toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false})}\n请回到运行扩展的电脑完成验证，再返回扩展重试任务。\n提醒编号：${marker}`;
}

// Serialized into X's page. Inspect the real chat DOM; never call private React handlers.
export function operateSelfMessageOnPage({accountId,handle,message,action}) {
  if (location.hostname !== 'x.com') return {blocked:true,reason:'不是 X 页面'};
  const viewer = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.split('/')[1];
  if (!viewer) return {ready:false};
  if (viewer.toLowerCase() !== handle.toLowerCase()) return {blocked:true,reason:'X 登录账号发生变化，已停止私信提醒'};
  const expected = `/i/chat/${accountId}-${accountId}`;
  if (location.pathname !== expected) return {blocked:true,reason:'当前会话不是本人会话，已停止发送'};
  const host = document.querySelector('[data-testid="xchatEmbedRoute"]');
  const root = host?.shadowRoot;
  if (!root) return {ready:false};
  if (root.querySelector('input[type="password"],input[autocomplete="one-time-code"]')) return {blocked:true,reason:'X 聊天需要手动解锁，无法发送手机提醒'};
  const marker=message.match(/提醒编号：(XFV-[a-z0-9]+)/)?.[1];
  const receipt = marker && [...root.querySelectorAll('[data-dm-message-row]')].find(row=>row.textContent.includes(marker));
  if (receipt) {
    const status=receipt.getAttribute('data-send-status');
    return {sent:status==='sent',failed:status==='failed',pending:status!=='sent',messageId:receipt.getAttribute('data-dm-message-row'),status};
  }
  const input=root.querySelector('[data-testid="dm-composer-textarea"]');
  if (!input || input.disabled) return {ready:false};
  if (action==='fill') {
    if(input.value && input.value!==message)return {blocked:true,reason:'私信输入框已有草稿，未覆盖'};
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,message);
    input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    return {prepared:true};
  }
  const button=root.querySelector('[data-testid="dm-composer-send-button"]');
  if (action==='send') {
    if(input.value!==message)return {blocked:true,reason:'提醒正文未正确写入，已停止发送'};
    if(!button || button.disabled)return {ready:false};
    button.click();
    return {submitted:true};
  }
  return {ready:true,sendReady:!!button&&!button.disabled};
}

let work = Promise.resolve();
export function sendVerificationSelfMessage(options) {
  const run=work.then(()=>send(options),()=>send(options));
  work=run.catch(()=>{});
  return run;
}

async function send({identity,notice,api=chrome,wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}) {
  if(!/^\d+$/.test(identity?.accountId || '') || !/^[\w]{1,15}$/.test(identity?.handle || '')) throw new Error('无法确认当前 X 账号');
  const fingerprint=`${identity.accountId}:${notice.at}`;
  const host=new URL(notice.url).hostname;
  const key=`${identity.accountId}:${host}`;
  const {grokVerificationSelfMessage:prior} = await api.storage.local.get(STATUS_KEY);
  if(prior?.fingerprint===fingerprint || (prior?.key===key && Boolean(prior.test)===Boolean(notice.test) && now()-prior.at<COOLDOWN)) return {ok:false,deduplicated:true,status:prior.status};
  const message=buildVerificationSelfMessage(notice,identity);
  const status={fingerprint,key,at:now(),accountId:identity.accountId,handle:identity.handle,test:notice.test===true,status:'sending'};
  // Persist before clicking Send. Unknown delivery must never cause automatic resends.
  await api.storage.local.set({[STATUS_KEY]:status});
  let win,submitted=false;
  try {
    win=await api.windows.create({url:`https://x.com/i/chat/${identity.accountId}-${identity.accountId}`,type:'popup',focused:false,width:1000,height:760});
    const tabId=win.tabs?.[0]?.id;
    if(!tabId)throw new Error('无法打开本人聊天页');
    const execute=async action=>{
      const results=await api.scripting.executeScript({target:{tabId},world:'MAIN',func:operateSelfMessageOnPage,args:[{accountId:identity.accountId,handle:identity.handle,message,action}]});
      return results?.[0]?.result || {ready:false};
    };
    let prepared=false,focused=false;
    for(let step=0;step<45;step++) {
      const result=await execute(submitted?'receipt':prepared?'send':'fill').catch(error=>{
        if(step<5)return {ready:false};throw error;
      });
      if(result.blocked || result.failed)throw new Error(result.reason || 'X 报告私信发送失败');
      if(result.sent) {
        await api.storage.local.set({[STATUS_KEY]:{...status,status:'sent',messageId:result.messageId,completedAt:now()}});
        return {ok:true,messageId:result.messageId};
      }
      if(result.prepared)prepared=true;
      if(result.submitted)submitted=true;
      // X Chat animations can stall in unfocused windows. Focus only this owned popup.
      if(!focused && step>=5) {await api.windows.update(win.id,{focused:true,state:'normal'});focused=true;}
      await wait(700);
    }
    throw new Error(submitted?'私信已提交，但未能确认送达；请查看本人会话，未自动重发':'聊天页未准备好，未发送私信');
  } catch(error) {
    const reason=String(error?.message || error);
    await api.storage.local.set({[STATUS_KEY]:{...status,status:submitted?'uncertain':'failed',reason,completedAt:now()}});
    return {ok:false,reason};
  } finally {
    if(win?.id)await api.windows.remove(win.id).catch(()=>{});
    if(notice.windowId)await api.windows.update(notice.windowId,{focused:true,state:'normal'}).catch(()=>{});
  }
}
