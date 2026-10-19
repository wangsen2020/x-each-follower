const KEY='grokVerificationAlertWindow';
let work=Promise.resolve();

export function centeredAlertBounds(area={}) {
  const availableWidth=Math.max(320,Number(area.width)||1280);
  const availableHeight=Math.max(360,Number(area.height)||800);
  const width=Math.min(580,availableWidth),height=Math.min(740,availableHeight);
  return {width,height,left:Math.round((Number(area.left)||0)+(availableWidth-width)/2),top:Math.round((Number(area.top)||0)+(availableHeight-height)/2)};
}

export function readVerificationScreenOnPage() {
  return {left:screen.availLeft || 0,top:screen.availTop || 0,width:screen.availWidth,height:screen.availHeight};
}

export function showVerificationAlert({api=chrome,force=false}={}) {
  const next=work.then(async()=>{
    const {grokVerification:notice}=await api.storage.local.get('grokVerification');
    if(!notice)return {shown:false};
    const saved=(await api.storage.session.get(KEY))[KEY];
    if(saved?.at===notice.at && saved.dismissed && !force)return {shown:false,dismissed:true};
    if(saved?.windowId) {
      const existing=await api.windows.get(saved.windowId).catch(()=>null);
      if(existing) {
        await api.storage.session.set({[KEY]:{windowId:existing.id,at:notice.at,dismissed:false}});
        await api.windows.update(existing.id,{focused:true,state:'normal'});
        return {shown:true,windowId:existing.id,reused:true};
      }
    }
    let area;
    try {area=(await api.scripting.executeScript({target:{tabId:notice.tabId},func:readVerificationScreenOnPage}))?.[0]?.result;} catch {}
    if(!area){const win=await api.windows.getLastFocused();area={left:win.left,top:win.top,width:win.width,height:win.height};}
    const win=await api.windows.create({url:api.runtime.getURL('verification-alert.html'),type:'popup',focused:true,...centeredAlertBounds(area)});
    await api.storage.session.set({[KEY]:{windowId:win.id,at:notice.at,dismissed:false}});
    await api.windows.update(win.id,{focused:true});
    return {shown:true,windowId:win.id};
  });
  work=next.catch(()=>{});
  return next;
}

export async function markVerificationAlertClosed(windowId,api=chrome) {
  const record=(await api.storage.session.get(KEY))[KEY];
  if(record?.windowId===windowId)await api.storage.session.set({[KEY]:{...record,dismissed:true}});
}

export async function focusVerificationPage(api=chrome) {
  const {grokVerification:notice}=await api.storage.local.get('grokVerification');
  if(!notice)throw new Error('验证已解除，可以返回面板重试任务。');
  const tab=await api.tabs.get(notice.tabId).catch(()=>null);
  if(!tab || !/^https:\/\/(x\.com|twitter\.com|grok\.com)\//.test(tab.url || ''))throw new Error('验证页已关闭，请返回面板重试任务。');
  await api.windows.update(tab.windowId,{focused:true,state:'normal'});
  await api.tabs.update(tab.id,{active:true});
  return {ok:true};
}

export function closeVerificationAlert(at,api=chrome) {
  const next=work.then(async()=>{
    const record=(await api.storage.session.get?.(KEY) || {})[KEY];
    if(!record || record.at!==at)return;
    if(record.windowId) {
      const win=await api.windows.get(record.windowId,{populate:true}).catch(()=>null);
      if(win?.tabs?.length===1 && win.tabs[0].url?.startsWith(api.runtime.getURL('verification-alert.html')))await api.windows.remove(win.id);
    }
    await api.storage.session.remove(KEY);
  });
  work=next.catch(()=>{});return next;
}
