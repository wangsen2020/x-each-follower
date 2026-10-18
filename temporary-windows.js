export const TEMP_WINDOW_ALARM = 'x-temporary-window-cleanup';
const PREFIX = 'xfTemporaryWindow:';
export const TEMP_WINDOW_TTL = 15 * 60 * 1000;
const supported = url => {try{return ['x.com','twitter.com','grok.com'].includes(new URL(url).hostname);}catch{return false;}};

// Per-window keys avoid read/modify/write races between panel and worker tasks.
// session storage survives worker suspension, but not a browser restart with reused IDs.
export async function createTemporaryWindow(options, kind = 'grok', lifetime = TEMP_WINDOW_TTL) {
  const win = await chrome.windows.create(options);
  try {
    const tabs = win.tabs || await chrome.tabs.query({windowId:win.id});
    if (tabs.length !== 1 || !tabs[0]?.id) throw new Error('临时窗口标签页异常');
    await chrome.storage.session.set({[PREFIX+win.id]:{windowId:win.id,tabId:tabs[0].id,kind,createdAt:Date.now(),expiresAt:Date.now()+Math.max(TEMP_WINDOW_TTL,lifetime)}});
    return win;
  } catch(error) {
    await chrome.windows.remove(win.id).catch(()=>{});
    throw error;
  }
}
export async function closeTemporaryWindow(windowId) {
  await chrome.windows.remove(windowId);
  await chrome.storage.session.remove(PREFIX+windowId);
}
async function scanWindows(now = Date.now()) {
  const records=await chrome.storage.session.get(null);
  const windows=new Map((await chrome.windows.getAll({populate:true})).map(w=>[w.id,w]));
  const result={closed:[],retained:[],released:[],failed:[]};
  for(const [key,record] of Object.entries(records)) {
    if(!key.startsWith(PREFIX))continue;
    const w=windows.get(record.windowId);
    if(!w){await chrome.storage.session.remove(key);continue;}
    // A user-added tab, moved/replaced tab or unrelated navigation relinquishes ownership.
    if(w.type!=='popup'||w.tabs?.length!==1||w.tabs[0].id!==record.tabId||!supported(w.tabs[0].pendingUrl||w.tabs[0].url)) {
      await chrome.storage.session.remove(key);result.released.push(w.id);continue;
    }
    if(record.kind==='grok-pool' && w.focused && !record.busyUntil) {
      await chrome.storage.session.set({[key]:{...record,lastUsedAt:now,expiresAt:now+GROK_IDLE_TTL}});
    }
    if(now < record.expiresAt || w.focused){result.retained.push(w.id);continue;}
    try {await closeTemporaryWindow(w.id);result.closed.push(w.id);}catch {result.failed.push(w.id);}
  }
  if(result.closed.length||result.failed.length)await chrome.storage.session.set({xfTemporaryWindowLastCleanup:{at:now,...result}});
  return result;
}
export async function ensureTemporaryWindowCleanup() {
  await chrome.alarms.create(TEMP_WINDOW_ALARM,{periodInMinutes:1});
  return scanTemporaryWindows();
}

export const GROK_IDLE_TTL = 8 * 60 * 1000;
let poolWork = Promise.resolve();
function exclusive(fn) {
  const work = poolWork.then(fn, fn);
  poolWork = work.catch(()=>{});
  return work;
}
export function scanTemporaryWindows(now = Date.now()) { return exclusive(()=>scanWindows(now)); }
const owns = (w,r) => w?.type==='popup' && w.tabs?.length===1 && w.tabs[0].id===r.tabId && supported(w.tabs[0].pendingUrl||w.tabs[0].url);
export function handleGrokWindowPool(message) {
  return exclusive(async()=>{
    const now=Date.now();
    if(message.action==='acquire') {
      const url=message.url;
      if(!['https://x.com/i/grok','https://grok.com/'].includes(url))throw new Error('不支持的 Grok 地址');
      const origin=new URL(url).origin;
      const lifetime=Math.max(TEMP_WINDOW_TTL,Number(message.lifetime)||0);
      const records=await chrome.storage.session.get(null);
      const windows=await chrome.windows.getAll({populate:true});
      let win,record;
      for(const r of Object.values(records)) {
        if(r?.kind!=='grok-pool'||r.origin!==origin||r.busyUntil)continue;
        const w=windows.find(w=>w.id===r.windowId);
        if(!owns(w,r)||w.focused)continue;
        win=w;record=r;break;
      }
      if(!win) {
        win=await createTemporaryWindow({url,type:'popup',focused:false,width:800,height:600},'grok-pool',lifetime);
        record=(await chrome.storage.session.get(PREFIX+win.id))[PREFIX+win.id];
      }
      await chrome.storage.session.set({[PREFIX+win.id]:{...record,origin,lastUsedAt:now,busyUntil:now+lifetime,expiresAt:now+lifetime}});
      try {
        // Fresh conversation in the same window prevents old answers/context leaking.
        await chrome.tabs.update(record.tabId,{url});
        return win;
      } catch(error) {await closeTemporaryWindow(win.id).catch(()=>{});throw error;}
    }
    const key=PREFIX+message.windowId;
    const record=(await chrome.storage.session.get(key))[key];
    if(!record||record.kind!=='grok-pool')return;
    if(message.action==='release' || (message.action==='touch' && !record.busyUntil))await chrome.storage.session.set({[key]:{...record,busyUntil:0,lastUsedAt:now,expiresAt:now+GROK_IDLE_TTL}});
  });
}
async function poolRequest(message) {
  if(typeof document==='undefined')return handleGrokWindowPool(message);
  const response=await chrome.runtime.sendMessage({cmd:'grokWindowPool',...message});
  if(!response?.ok)throw new Error(response?.error||'Grok 窗口管理不可用');
  return response.value;
}
export const acquireGrokWindow=(url,lifetime)=>poolRequest({action:'acquire',url,lifetime});
export const releaseGrokWindow=windowId=>poolRequest({action:'release',windowId});
