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
export async function scanTemporaryWindows(now = Date.now()) {
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
