import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const folder='C:/jtmp/xf-retry-review-integration',output=path.resolve('artifacts/retry-review-integration/live');await fs.mkdir(output,{recursive:true});
const before=JSON.parse(await fs.readFile(folder+'/before-private.json','utf8'));
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
let ownTab,panel,heldAuto,namespace;const checks=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(page,fn,...args){for(let i=0;i<100;i++){if(await page.evaluate(fn,...args))return;await sleep(100);}throw Error('Live condition timed out: '+fn);}
async function click(page,selector){await page.evaluate(selector=>{const e=document.querySelector(selector);if(!e||e.disabled)throw Error('Missing or disabled control '+selector);e.click();},selector);}
async function setValue(page,selector,value){await page.evaluate(({selector,value})=>{const e=document.querySelector(selector);if(!e)throw Error('Missing field '+selector);e.value=value;e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));},{selector,value});}
try {
 panel=(await browser.pages()).find(p=>p.url()===before.original.base);assert.ok(panel);
 const preserved=await panel.evaluate(async previous=>{
  const open=name=>new Promise((r,j)=>{const q=indexedDB.open(name);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
  const read=async(name,store,keys=false)=>{const db=await open(name);try{return await new Promise((r,j)=>{const q=keys?db.transaction(store).objectStore(store).getAllKeys():db.transaction(store).objectStore(store).getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});}finally{db.close();}};
  const queue=await read('x-each-follower-follow-queue','jobs',true),records=await read('x-each-follower-records-dashboard','rows',true);
  const configs={queue:await read('x-each-follower-follow-queue','settings'),bot:await read('xfollower-grok-bot','connections'),local:await read('xfollower-grok-local','config'),image:await read('xfollower-image-connections','connections')};
  const queueSet=new Set(queue.map(JSON.stringify)),recordSet=new Set(records.map(JSON.stringify));
  const configKeys=['unreciprocatedSettings','followQueueBinding','grokSettings','autoFollowSettings'];const local=await chrome.storage.local.get(configKeys);
  return {version:chrome.runtime.getManifest().version,background:await chrome.runtime.sendMessage({cmd:'getBackgroundBuildVersion'}),missingQueue:previous.queueKeys.filter(key=>!queueSet.has(JSON.stringify(key))).length,missingRecords:previous.recordKeys.filter(key=>!recordSet.has(JSON.stringify(key))).length,queueCount:queue.length,recordCount:records.length,configs,local,review:(await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'})).settings,active:[...document.querySelectorAll('[data-tab].active')].map(e=>e.dataset.tab)[0]};
 },before.snapshot);
 assert.equal(preserved.version,'4.20.0');assert.equal(preserved.background.version,'4.20.0');assert.equal(preserved.missingQueue,0);assert.equal(preserved.missingRecords,0);assert.ok(JSON.stringify(preserved.configs)===JSON.stringify(before.snapshot.configs),'private config stores differ');assert.ok(JSON.stringify(preserved.review)===JSON.stringify(before.snapshot.review.settings),'review settings differ');
 for(const key of Object.keys(preserved.local))assert.ok(JSON.stringify(preserved.local[key])===JSON.stringify(before.snapshot.storage[key]),'root settings differ: '+key);
 if(preserved.active!==before.original.active){await panel.evaluate(tab=>document.querySelector(`[data-tab="${tab}"]`)?.click(),before.original.active);await wait(panel,tab=>document.querySelector(`[data-tab="${tab}"]`)?.classList.contains('active'),before.original.active);}
 await fs.writeFile(folder+'/preservation.json',JSON.stringify({version:preserved.version,background:preserved.background.version,oldQueueCount:before.snapshot.queueKeys.length,queueCount:preserved.queueCount,oldRecordCount:before.snapshot.recordKeys.length,recordCount:preserved.recordCount,missingQueue:0,missingRecords:0,configsPreserved:true,reviewSettingsPreserved:true,rootSettingsPreserved:true,activeTabRestored:before.original.active},null,2));checks.push('old task and record identities, four config stores, review and root settings preserved');
 namespace='qa42_'+Date.now().toString(36).slice(-5);
 heldAuto=await panel.evaluate(async()=>{const alarm=await chrome.alarms.get('x-auto-unfollow');await chrome.alarms.clear('x-auto-unfollow');return alarm;});
 await wait(panel,async()=>{const ledger=(await chrome.storage.local.get('autoUnfollowState')).autoUnfollowState;return !Object.values(ledger?.accounts||{}).some(s=>s.scheduler?.phase==='running'&&Date.now()-s.scheduler.updatedAt<120000);});
 const owner=await panel.evaluate(async namespace=>{
  const values=await chrome.storage.local.get(['autoUnfollowState','unreciprocatedSettings']),account=String(values.unreciprocatedSettings.autoUnfollowAccount.id);const ledger=values.autoUnfollowState;const state=ledger.accounts[account];
  const added=Array.from({length:24},(_,i)=>({user:{id:`fixture:${namespace}:${i}`,handle:`${namespace}_${i}`,name:'隔离验收'},status:'review',attempts:3,reason:i===1?'用于验证长核验说明在真实扩展中的换行和展开。'.repeat(12):'隔离验收：不对应真实 X 用户',updatedAt:Date.now()-i*1000}));
  state.reviewItems=[...(state.reviewItems||[]),...added];await chrome.storage.local.set({autoUnfollowState:ledger});return {account,handles:added.map(x=>x.user.handle)};
 },namespace);
 ownTab=await panel.evaluate(base=>chrome.tabs.create({url:base+'?acceptance=retry4200',active:false}),before.original.base);
 await panel.evaluate(tabId=>chrome.windows.create({tabId,type:'normal',focused:false,width:1440,height:1040}),ownTab.id);
 let page;for(let i=0;i<50;i++){page=(await browser.pages()).find(p=>p.url().endsWith('?acceptance=retry4200'));if(page)break;await sleep(100);}assert.ok(page);
 await wait(page,()=>Boolean(document.querySelector('[data-tab="unreciprocated"]')));await click(page,'[data-tab="unreciprocated"]');await wait(page,()=>Boolean(document.querySelector('.review-entry button')));
 await click(page,'[aria-label="人工审核"]');await wait(page,()=>Boolean(document.querySelector('.review-drawer[open]')));await setValue(page,'.review-toolbar input',namespace);await wait(page,()=>document.querySelectorAll('.review-list li').length===10);
 const cdp=await page.createCDPSession();
 async function screenshot(name,width=1440){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await sleep(150);const r=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});await fs.writeFile(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
 await screenshot('desktop');checks.push('loaded real extension review drawer shows isolated data');
 await click(page,'.review-select-page input');await wait(page,()=>document.querySelector('.review-toolbar').innerText.includes('已选 10 项'));await click(page,'.review-drawer [aria-label="下一页"]');await wait(page,handle=>document.querySelector('.review-list li')?.innerText.includes(handle),owner.handles[10]);await click(page,'.review-list li input');await wait(page,()=>document.querySelector('.review-toolbar').innerText.includes('已选 11 项'));assert.match(await page.evaluate(()=>document.querySelector('.review-toolbar').innerText),/已选 11 项/);checks.push('real cross-page selection is consistent');
 await setValue(page,'.review-toolbar select','skipped');await wait(page,()=>Boolean(document.querySelector('.review-empty')));assert.match(await page.evaluate(()=>document.querySelector('.review-toolbar').innerText),/已选 0 项/);
 await setValue(page,'.review-toolbar select','review');await page.evaluate(()=>{const e=document.querySelector('.review-list [aria-label="重试"]');e.focus();e.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));});await wait(page,()=>Boolean(document.querySelector('#panel-info-tip-tooltip')));checks.push('real native dialog focus-in tooltip handler and accessible description work; focus event supplied explicitly for occluded Chrome');await screenshot('keyboard-tip');
 await click(page,'.review-list [aria-label="跳过"]');await wait(page,()=>document.querySelectorAll('.review-list li').length===10);await setValue(page,'.review-toolbar select','skipped');await wait(page,()=>document.querySelectorAll('.review-list li').length===1);
 await page.reload({waitUntil:'domcontentloaded'});await wait(page,()=>Boolean(document.querySelector('[data-tab="unreciprocated"]')));await click(page,'[data-tab="unreciprocated"]');await click(page,'[aria-label="人工审核"]');await setValue(page,'.review-toolbar input',namespace);await setValue(page,'.review-toolbar select','skipped');await wait(page,()=>document.querySelectorAll('.review-list li').length===1);checks.push('skip survives reopening the actual extension page');
 await click(page,'.review-list [aria-label="重试"]');await wait(page,()=>Boolean(document.querySelector('.review-empty')));checks.push('real retry returns the isolated item to scheduling eligibility without an X action');
 await setValue(page,'.review-toolbar select','review');await wait(page,()=>document.querySelectorAll('.review-list li').length===10);
 await click(page,'.review-list li:nth-child(1) input');await click(page,'.review-list li:nth-child(2) input');await click(page,'.review-drawer [aria-label="删除选中记录"]');await wait(page,()=>Boolean(document.querySelector('.review-confirm[open]')));await screenshot('delete-confirm');await click(page,'.review-confirm button:last-child');await wait(page,()=>document.querySelector('.review-feedback')?.innerText.includes('已完成 2 项，失败 0 项'));checks.push('real batch delete service succeeds for isolated records');
 await screenshot('narrow',700);const box=await page.evaluate(()=>{const r=document.querySelector('.review-drawer').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};});assert.ok(box.left>=0&&box.right<=box.width);await screenshot('mobile',390);
 await setValue(page,'.review-toolbar input',namespace+'_absent');await wait(page,()=>Boolean(document.querySelector('.review-empty')));checks.push('real empty state and narrow layouts verified');
 const fake=await panel.evaluate(async namespace=>{const l=(await chrome.storage.local.get('autoUnfollowState')).autoUnfollowState;return Object.values(l.accounts).flatMap(s=>(s.reviewItems||[]).filter(x=>x.user.id?.startsWith('fixture:'+namespace)));},namespace);assert.equal(fake.length,21);
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({checks,namespace,owner:owner.account,version:'4.20.0',testRowsRemainingBeforeCleanup:fake.length},null,2));console.log(JSON.stringify({checks,version:'4.20.0',preservedJobs:before.snapshot.queueKeys.length,preservedRecords:before.snapshot.recordKeys.length,output}));
}finally {
 if(panel&&!panel.isClosed()){
  if(namespace)await panel.evaluate(async namespace=>{const l=(await chrome.storage.local.get('autoUnfollowState')).autoUnfollowState;for(const state of Object.values(l.accounts||{}))state.reviewItems=(state.reviewItems||[]).filter(x=>!x.user.id?.startsWith('fixture:'+namespace));await chrome.storage.local.set({autoUnfollowState:l});},namespace);
  if(heldAuto)await panel.evaluate(async a=>{if(!await chrome.alarms.get(a.name))await chrome.alarms.create(a.name,{when:Math.max(Date.now()+30000,a.scheduledTime),...(a.periodInMinutes?{periodInMinutes:a.periodInMinutes}:{})});},heldAuto);
  if(ownTab)await panel.evaluate(id=>chrome.tabs.remove(id),ownTab.id).catch(()=>{});
 }
 await browser.disconnect();
}
