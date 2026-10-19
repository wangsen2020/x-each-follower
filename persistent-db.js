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
let dbTabOwned = false;
let dbTabPromise;
let dbTabCloseTimer;
let dbOperationQueue = Promise.resolve();

export async function createStorageTab(chromeApi) {
  const tabs = await chromeApi.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
  const existing = tabs.find(tab => tab.id != null);
  if (existing) return {id:existing.id, owned:false};

  let win = await chromeApi.windows.getLastFocused({windowTypes:['normal']}).catch(() => null);
  if (!win?.id || win.type !== 'normal') {
    const windows = await chromeApi.windows.getAll({windowTypes:['normal']});
    win = windows.find(item => item.focused) || windows[0];
  }
  if (!win?.id) throw new Error('没有可用的浏览器窗口，无法创建 X 本地数据库标签页');

  const tab = await chromeApi.tabs.create({
    windowId:win.id,
    url:'https://x.com/home',
    active:false
  });
  if (!tab?.id) throw new Error('无法创建 X 本地数据库标签页');
  return {id:tab.id, owned:true};
}

export async function closeStorageTab(chromeApi, tabId) {
  if (tabId != null) await chromeApi.tabs.remove(tabId).catch(() => {});
}

async function storageTab() {
  if (dbTabPromise) return dbTabPromise;
  dbTabPromise = (async () => {
    if (dbTabId != null) {
      try { await chrome.tabs.get(dbTabId); return dbTabId; }
      catch { dbTabId = undefined; dbTabOwned = false; }
    }
    const tab = await createStorageTab(chrome);
    dbTabId = tab.id;
    dbTabOwned = tab.owned;
    try {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const current = await chrome.tabs.get(dbTabId).catch(() => null);
        if (!current) throw new Error('X 本地数据库标签页已关闭');
        if (current.status === 'complete') return dbTabId;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('等待 X 本地数据库标签页加载超时');
    } catch (error) {
      const failedTabId = dbTabId;
      const shouldClose = dbTabOwned;
      dbTabId = undefined;
      dbTabOwned = false;
      if (shouldClose) await closeStorageTab(chrome, failedTabId);
      throw error;
    }
  })();
  try { return await dbTabPromise; } finally { dbTabPromise = undefined; }
}

function scheduleOwnedTabClose(tabId) {
  if (!dbTabOwned || dbTabId !== tabId) return;
  clearTimeout(dbTabCloseTimer);
  dbTabCloseTimer = setTimeout(async () => {
    if (!dbTabOwned || dbTabId !== tabId) return;
    dbTabId = undefined;
    dbTabOwned = false;
    dbTabCloseTimer = undefined;
    await closeStorageTab(chrome, tabId);
  }, 500);
}

async function withStorageTab(operation) {
  const next = dbOperationQueue.then(async () => {
    clearTimeout(dbTabCloseTimer);
    dbTabCloseTimer = undefined;
    const tabId = await storageTab();
    try { return await operation(tabId); }
    finally { scheduleOwnedTabClose(tabId); }
  });
  dbOperationQueue = next.catch(() => {});
  return next;
}

export async function durableGet(key) {
  return withStorageTab(async tabId => {
    const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:dbPage, args:['get',key,null]});
    return result?.[0]?.result;
  });
}

export async function durableSet(key, value) {
  return withStorageTab(async tabId => {
    await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:dbPage, args:['set',key,value]});
  });
}
