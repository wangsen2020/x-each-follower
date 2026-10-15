// Stores durable extension data in the x.com origin. Unlike chrome.storage.local,
// this database survives uninstall/reinstall of this extension (until x.com site data is cleared).
const dbPage = async (operation, key, value) => {
  const request = indexedDB.open('x-each-follower', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('records');
  const db = await new Promise((resolve, reject) => { request.onsuccess=() => resolve(request.result); request.onerror=() => reject(request.error); });
  if (operation === 'get') return await new Promise((resolve, reject) => { const tx=db.transaction('records','readonly'); const r=tx.objectStore('records').get(key); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
  await new Promise((resolve, reject) => { const tx=db.transaction('records','readwrite'); const r=tx.objectStore('records').put(value,key); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); });
  return true;
};

let dbTabId;
let dbTabPromise;
async function storageTab() {
  if (dbTabPromise) return dbTabPromise;
  dbTabPromise = (async () => {
  if (dbTabId) { try { await chrome.tabs.get(dbTabId); return dbTabId; } catch { dbTabId = undefined; } }
  const tabs = await chrome.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
  const usable = tabs.find(tab => tab.status === 'complete');
  if (usable) { dbTabId = usable.id; return dbTabId; }
  const win = await chrome.windows.create({url:'https://x.com/home', type:'popup', state:'minimized', focused:false});
  dbTabId = win.tabs?.[0]?.id;
  if (!dbTabId) throw new Error('无法打开 X 本地数据库页面');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const tab = await chrome.tabs.get(dbTabId); if (tab.status === 'complete') break; await new Promise(resolve => setTimeout(resolve, 500)); }
  return dbTabId;
  })();
  try { return await dbTabPromise; } finally { dbTabPromise = undefined; }
}

export async function durableGet(key) {
  const tabId = await storageTab();
  const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:dbPage, args:['get',key,null]});
  return result?.[0]?.result;
}

export async function durableSet(key, value) {
  const tabId = await storageTab();
  await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:dbPage, args:['set',key,value]});
}
