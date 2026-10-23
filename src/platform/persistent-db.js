import {isPageFailure,diagnosticUrl,diagnosticText} from './page-failure.js';
// Stores durable extension data in the x.com origin. Unlike chrome.storage.local,
// this database survives uninstall/reinstall of this extension (until x.com site data is cleared).
const dbPage = async (operation, key, value) => {
  const request = indexedDB.open('x-each-follower', 1);
  const db = await new Promise((resolve, reject) => {
    let settled = false, blockedTimer;
    const fail = error => { if (settled) return; settled = true; clearTimeout(blockedTimer); reject(error); };
    request.onblocked = () => {
      if (!settled && !blockedTimer) blockedTimer = setTimeout(() => fail(new Error('X 本地数据库升级被旧连接阻塞，请关闭旧看板后重试')), 5000);
    };
    request.onupgradeneeded = () => {
      if (settled) { request.transaction.abort(); return; }
      clearTimeout(blockedTimer); blockedTimer = undefined;
      request.result.createObjectStore('records');
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(blockedTimer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => fail(request.error || new Error('X 本地数据库打开失败'));
  });
  // Keep the bridge pending until commit/abort, not merely request success.
  // A failed write is never retried here; the queue can advance after abort.
  const transaction = (mode, work) => new Promise((resolve, reject) => {
    const tx = db.transaction('records', mode);
    let result, failure;
    const abort = error => {
      failure ||= error || new Error('X 本地数据库操作失败');
      try { tx.abort(); } catch { /* already aborting; onabort settles the operation */ }
    };
    tx.oncomplete = () => failure ? reject(failure) : resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('X 本地数据库事务已中止'));
    tx.onerror = () => { failure ||= tx.error || new Error('X 本地数据库事务失败'); };
    try { work(tx, value => { result = value; }, abort); } catch (error) { abort(error); }
  });
  try {
  if (operation === 'get') {
    const stored = await transaction('readonly', (tx, resolve, reject) => { const r=tx.objectStore('records').get(key); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
    if (stored === undefined) return JSON.stringify({found: false});
    return JSON.stringify({found: true, v: stored});
  }
  if (operation === 'keys') {
    const keyRange = typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : (globalThis.IDBKeyRange || (typeof self !== 'undefined' ? self.IDBKeyRange : undefined));
    const keys = await transaction('readonly', (tx, resolve, reject) => {
      const store = tx.objectStore('records');
      const range = key && keyRange ? keyRange.bound(key, key + '\uffff') : null;
      const r = store.getAllKeys(range);
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    return JSON.stringify({found: true, v: keys});
  }
  if (operation === 'appendIncremental') {
    const keyRange = typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : (globalThis.IDBKeyRange || (typeof self !== 'undefined' ? self.IDBKeyRange : undefined));
    const entry = JSON.parse(value);
    const result = await transaction('readwrite', (tx, resolve, reject) => {
      const store = tx.objectStore('records');
      const seqPrefix = 'recordIncremental:v1:seq:';
      const headKey = 'recordIncremental:v1:head';
      const opPrefix = 'recordIncremental:v1:op:';

      const headReq = store.get(headKey);
      headReq.onerror = () => reject(headReq.error);
      headReq.onsuccess = () => {
        const head = headReq.result || {seq: 0};
        const headSeq = head.seq || 0;

        const seqRange = keyRange ? keyRange.bound(seqPrefix, seqPrefix + '\uffff') : null;
        const keysReq = store.getAllKeys(seqRange);
        keysReq.onerror = () => reject(keysReq.error);
        keysReq.onsuccess = () => {
          const allSeqKeys = keysReq.result || [];
          let maxContinuousSeq = 0;
          for (let i = 0; i < allSeqKeys.length; i++) {
            const num = parseInt(allSeqKeys[i].slice(seqPrefix.length), 10);
            if (num === maxContinuousSeq + 1) {
              maxContinuousSeq = num;
            } else if (num > maxContinuousSeq + 1) {
              tx.abort();
              return reject(new Error('incremental sequence gap detected: expected ' + (maxContinuousSeq + 1) + ', found ' + num));
            }
          }

          const opIndexKey = entry.operationId ? `${opPrefix}${entry.operationId}` : null;
          const opReq = opIndexKey ? store.get(opIndexKey) : null;

          const checkHistoricalIndex = () => {
            if (opReq && opReq.result && opReq.result.seq) {
              const matchedSeq = opReq.result.seq;
              const matchedKey = seqPrefix + String(matchedSeq).padStart(8, '0');
              const entryReq = store.get(matchedKey);
              entryReq.onerror = () => reject(entryReq.error);
              entryReq.onsuccess = () => {
                const existing = entryReq.result;
                if (existing) {
                  if (maxContinuousSeq > headSeq) {
                    store.put({seq: maxContinuousSeq, operationId: existing.operationId}, headKey);
                  }
                  resolve({ok: true, entry: existing, duplicate: true});
                  return;
                }
                // If index pointed to missing record, fallback to tail scan
                scanTail();
              };
              return;
            }
            scanTail();
          };

          const scanTail = () => {
            const checkStart = Math.max(1, maxContinuousSeq - 100);
            const tailRange = (maxContinuousSeq > 0 && keyRange) ? keyRange.bound(seqPrefix + String(checkStart).padStart(8, '0'), seqPrefix + String(maxContinuousSeq).padStart(8, '0')) : null;
            const tailReq = tailRange ? store.getAll(tailRange) : null;

            const onTailReady = tailEntries => {
              const existingMatch = tailEntries.find(item => item && item.operationId === entry.operationId);
              if (existingMatch) {
                if (maxContinuousSeq > headSeq) {
                  store.put({seq: maxContinuousSeq, operationId: existingMatch.operationId}, headKey);
                }
                if (opIndexKey) {
                  store.put({seq: existingMatch.seq, operationId: existingMatch.operationId}, opIndexKey);
                }
                resolve({ok: true, entry: existingMatch, duplicate: true});
                return;
              }

              const nextSeq = maxContinuousSeq + 1;
              const nextKey = seqPrefix + String(nextSeq).padStart(8, '0');
              const storedBody = {...entry, seq: nextSeq, status: 'stored'};
              store.put(storedBody, nextKey);
              if (opIndexKey) {
                store.put({seq: nextSeq, operationId: entry.operationId}, opIndexKey);
              }
              store.put({seq: nextSeq, operationId: entry.operationId}, headKey);
              resolve({ok: true, entry: storedBody, duplicate: false});
            };

            if (tailReq) {
              tailReq.onerror = () => reject(tailReq.error);
              tailReq.onsuccess = () => onTailReady(tailReq.result || []);
            } else {
              onTailReady([]);
            }
          };

          if (opReq) {
            opReq.onerror = () => reject(opReq.error);
            opReq.onsuccess = () => checkHistoricalIndex();
          } else {
            scanTail();
          }
        };
      };
    });
    return JSON.stringify({found: true, v: result});
  }
  const parsed = JSON.parse(value);
  await transaction('readwrite', (tx, resolve, reject) => { const r=tx.objectStore('records').put(parsed.v,key); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); });
  return JSON.stringify({ok: true});
  } finally { db.close(); }
};

function decodeDurableResult(raw) {
  if (typeof raw !== 'string') return raw;
  const envelope = JSON.parse(raw);
  if (!envelope || envelope.found !== true) return undefined;
  return envelope.v;
}

let dbTabId;
let dbTabOwned = false;
let dbTabPromise;
let dbTabCloseTimer;
let dbOperationQueue = Promise.resolve();

const rejectedStorageTabs=new Map();
export async function createStorageTab(chromeApi) {
  if (!chromeApi?.tabs?.query) throw new Error('没有可用的标签页接口，无法创建 X 本地数据库标签页');
  const tabs = await chromeApi.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
  const existing = tabs.filter(tab=>tab.id!=null&&(!rejectedStorageTabs.has(tab.id)||rejectedStorageTabs.get(tab.id)<Date.now())&&!tab.discarded).sort((a,b)=>Number(b.status==='complete')-Number(a.status==='complete')||Number((b.url||'').endsWith('/home'))-Number((a.url||'').endsWith('/home')))[0];
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
  if (tabId != null && chromeApi?.tabs?.remove) await chromeApi.tabs.remove(tabId).catch(() => {});
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

async function withStorageTab(operation,context={}) {
  const next = dbOperationQueue.then(async () => {
    for(let attempt=0;attempt<2;attempt++){
      clearTimeout(dbTabCloseTimer);dbTabCloseTimer=undefined;
      const tabId=await storageTab();
      try{return await operation(tabId);}
      catch(error){
        const tab=await chrome.tabs.get(tabId).catch(()=>null);
        error.pageContext={stage:'x-storage',operation:context.operation||'',tabId,requestedUrl:diagnosticUrl(tab?.url),...error.pageContext};
        if(isPageFailure(error)){
          try{if(chrome.storage?.local){const key='xStoragePageFailures',old=(await chrome.storage.local.get(key))[key]||[];await chrome.storage.local.set({[key]:[{...error.pageContext,at:new Date().toISOString(),rawError:diagnosticText(error.message),readRetry:attempt===0&&context.readOnly===true},...old].slice(0,20)});}}catch{}
          // A browser error document is still status=complete. Forget this
          // borrowed page; never reload or close a page owned by the user.
          rejectedStorageTabs.set(tabId,Date.now()+5*60*1000);
          if(rejectedStorageTabs.size>40)rejectedStorageTabs.delete(rejectedStorageTabs.keys().next().value);
          const owned=dbTabOwned;dbTabId=undefined;dbTabOwned=false;
          if(owned)await closeStorageTab(chrome,tabId);
          if(attempt===0&&context.readOnly)continue;
        }
        throw error;
      }finally{scheduleOwnedTabClose(tabId);}
    }
  });
  dbOperationQueue=next.catch(()=>{});return next;
}

export async function durableGetStrict(key) {
  return withStorageTab(async tabId => {
    const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:dbPage, args:['get',key,null]});
    return decodeDurableResult(result?.[0]?.result);
  },{operation:'read-backup',readOnly:true});
}

export async function durableGet(key) {
  try {
    return await durableGetStrict(key);
  } catch {
    return undefined;
  }
}

export async function durableSet(key, value) {
  return withStorageTab(async tabId => {
    await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:dbPage, args:['set',key,JSON.stringify({v: value})]});
  },{operation:'write-backup'});
}

export async function durableKeysStrict(prefix = '') {
  return withStorageTab(async tabId => {
    const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:dbPage, args:['keys',prefix,null]});
    const keys = decodeDurableResult(result?.[0]?.result);
    if (!Array.isArray(keys)) throw new Error('durableKeysStrict 未返回有效数组');
    return keys;
  },{operation:'list-backups',readOnly:true});
}

export async function durableKeys(prefix = '') {
  try {
    return await durableKeysStrict(prefix);
  } catch {
    return [];
  }
}

export async function durableAppendIncremental(entry) {
  return withStorageTab(async tabId => {
    const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:dbPage, args:['appendIncremental',null,JSON.stringify(entry)]});
    const res = decodeDurableResult(result?.[0]?.result);
    if (!res || !res.ok) throw new Error(res?.error || '增量日志原子写入失败');
    return res.entry;
  },{operation:'append-backup'});
}
