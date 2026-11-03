import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const folder='C:/jtmp/xf-content-policy/deploy';
const targetVersion=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const root='E:/WebstormProjects/x-each-follower',source=path.resolve(process.argv[3]||'scratch/build-tests/unified-verification');
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
let held=[],page;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await fs.mkdir(folder,{recursive:true});
try {
 page=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().endsWith('/panel.html'));
 if(!page)throw Error('No original panel target');
 const gate=await page.evaluate(async()=>{
  const rawSend=message=>chrome.runtime.sendMessage(message);
  const request=message=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('状态查询超时：'+message.cmd)),8000);rawSend(message).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
  const [r,i,m,q,data,a]=await Promise.all([request({cmd:'followQueueFanReviewStatus'}),request({cmd:'followQueueFanBatchStatus'}),request({cmd:'mutualComments',action:'state',page:1}),request({cmd:'followQueueList',limit:1}),chrome.storage.local.get(['autoUnfollowState','unreciprocatedSettings','fanProfileCollection:v1']),request({cmd:'followQueueReviewSettings'})]);
  const autoStates=Object.values(data.autoUnfollowState?.accounts||{});
  const runningAuto=autoStates.some(s=>s.scheduler?.phase==='running')&&(data.unreciprocatedSettings?.autoUnfollow!==false||autoStates.some(s=>s.pending));
  return {version:chrome.runtime.getManifest().version,monitorSelected:document.querySelectorAll('#monitorList input:checked').length,editing:['INPUT','TEXTAREA'].includes(document.activeElement?.tagName),uiBatch:document.querySelector('.fq-batch-feedback')?.innerText||'',uiRunning:!!document.querySelector('[data-batch-stop],.result-notice-card[data-task-stage="running"]'),dialog:!!document.querySelector('dialog[open]'),review:r.batch?.stage,inspection:i.batch?.stage,inspectionProgress:i.batch?{done:i.batch.nextIndex,total:i.batch.handles.length}:null,mutual:m.running,queue:!!q.summary?.running,collection:(data['fanProfileCollection:v1']?.activeUntil||0)>Date.now(),runningAuto,automationVerify:a.automationStatus?.verify?.stage,ok:r.ok&&i.ok&&m.ok&&q.ok};
 });
 const busy=['running','checking'].includes(gate.automationVerify)||!gate.ok||gate.monitorSelected>0||gate.editing||gate.uiRunning||gate.dialog||gate.review==='running'||gate.inspection==='running'||gate.queue||gate.collection||gate.runningAuto||gate.mutual?.scan||gate.mutual?.comment;
 console.log(JSON.stringify({busy,...gate}));
 if(process.argv[2]!=='apply'||busy)process.exitCode=busy?2:0;
 else {
  const original=await page.evaluate(async()=>({fanTab:document.querySelector('[data-follower-tab].active')?.dataset.followerTab,fanSearch:document.querySelector('#followerSearch')?.value||'',fanPageSize:document.querySelector('#followerPageSize')?.value,logs:window.__executionLogsModalController?.isOpen.value?{scope:window.__executionLogsModalController.currentScope.value,subTab:window.__executionLogsModalController.fansSubTab.value}:null,tab:await chrome.tabs.getCurrent(),base:chrome.runtime.getURL('panel.html'),active:[...document.querySelectorAll('[data-tab].active')].map(e=>e.dataset.tab)[0],queueFilter:document.querySelector('.fq-filter-tab.active')?.innerText,fields:[...document.querySelectorAll('#followQueueContent input[type=search],#followQueueContent select')].map(e=>({tag:e.tagName,type:e.type,value:e.value})),checkedHandles:[...document.querySelectorAll('#followQueueContent tbody tr')].filter(row=>row.querySelector('input[type=checkbox]')?.checked).map(row=>{const a=row.querySelector('a[href^="https://x.com/"]');return a?new URL(a.href).pathname.split('/')[1]:'';}).filter(Boolean),scroll:[...document.querySelectorAll('body,main,.table-wrap')].filter(e=>e.scrollTop).map(e=>({tag:e.tagName,class:e.className,top:e.scrollTop}))}));
  // Reserve the brief reload window without changing any user configuration.
  held=await page.evaluate(async()=>{const alarms=await chrome.alarms.getAll();for(const alarm of alarms)await chrome.alarms.clear(alarm.name);return alarms;});
  await fs.writeFile(folder+'/held-alarms.json',JSON.stringify(held,null,2));
  const snapshot=await page.evaluate(async()=>{
   const open=name=>new Promise((r,j)=>{const q=indexedDB.open(name);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
   const keys=async(name,store)=>{const db=await open(name);try{return await new Promise((r,j)=>{const values=[],q=db.transaction(store).objectStore(store).openKeyCursor();q.onsuccess=()=>{const c=q.result;if(!c)return r(values);values.push(c.primaryKey);c.continue();};q.onerror=()=>j(q.error);});}finally{db.close();}};
   const rows=async(name,store)=>{const db=await open(name);try{return await new Promise((r,j)=>{const q=db.transaction(store).objectStore(store).getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});}finally{db.close();}};
   return {at:new Date().toISOString(),storage:await chrome.storage.local.get(null),queueKeys:await keys('x-each-follower-follow-queue','jobs'),recordKeys:await keys('x-each-follower-records-dashboard','rows'),configs:{queue:await rows('x-each-follower-follow-queue','settings'),bot:await rows('xfollower-grok-bot','connections'),local:await rows('xfollower-grok-local','config'),image:await rows('xfollower-image-connections','connections')},review:await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'})};
  });
  await fs.writeFile(folder+'/before-private.json',JSON.stringify({original,snapshot}));
  const dest=path.resolve(root,'dist'),stage=path.resolve(root,'dist-verification-state-stage-'+targetVersion),backup=path.resolve(root,'artifacts','dist-before-content-policy-'+targetVersion+'-'+Date.now());
  // All recursive copy/move paths are resolved and checked against the named workspace.
  for(const target of [dest,stage,backup])assert.ok(target.startsWith(path.resolve(root)+path.sep)&&target!==path.resolve(root));
  assert.equal((await fs.lstat(dest)).isSymbolicLink(),false);assert.equal((await fs.lstat(source)).isSymbolicLink(),false);
  assert.equal(JSON.parse(await fs.readFile(source+'/manifest.json')).version,targetVersion);
  await fs.mkdir(path.dirname(backup),{recursive:true});await fs.cp(source,stage,{recursive:true,errorOnExist:true,force:false});
  let files=0;async function verify(rel=''){for(const entry of await fs.readdir(path.join(source,rel),{withFileTypes:true})){const name=path.join(rel,entry.name);if(entry.isDirectory())await verify(name);else{assert.equal(createHash('sha256').update(await fs.readFile(path.join(source,name))).digest('hex'),createHash('sha256').update(await fs.readFile(path.join(stage,name))).digest('hex'));files++;}}}await verify();
  await fs.rename(dest,backup);try{await fs.rename(stage,dest);}catch(error){await fs.rename(backup,dest);throw error;}
  await fs.writeFile(folder+'/deployment.json',JSON.stringify({at:new Date().toISOString(),source,dest,backup,files,original,version:targetVersion},null,2));
  await page.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),100);return true;});await sleep(1200);
  let live;
  for(let i=0;i<50;i++){live=(await browser.pages()).find(p=>p.url()===original.base);if(live){try{if(await live.evaluate(()=>chrome.runtime?.getManifest().version)===targetVersion)break;}catch{}}await sleep(100);}
  if(live){try{await live.reload({waitUntil:'domcontentloaded'});}catch{}}
  if(!live||await live.evaluate(()=>chrome.runtime?.getManifest().version).catch(()=>null)!==targetVersion){
   const cdp=await browser.target().createCDPSession();const restoredUrl=original.base+'?integration='+targetVersion+'-restored';await cdp.send('Target.createTarget',{url:restoredUrl,background:true});
   for(let i=0;i<50;i++){live=(await browser.pages()).find(p=>p.url()===restoredUrl);if(live)break;await sleep(100);}
  }else await live.reload({waitUntil:'domcontentloaded'});
  assert.ok(live);page=live;await live.evaluate(base=>history.replaceState(null,'',base),original.base);
  const tab=await live.evaluate(()=>chrome.tabs.getCurrent());
  if(tab.windowId!==original.tab.windowId)await live.evaluate(async({id,windowId,index})=>chrome.tabs.move(id,{windowId,index}),{id:tab.id,windowId:original.tab.windowId,index:original.tab.index});
  await live.evaluate(active=>document.querySelector(`[data-tab="${active}"]`)?.click(),original.active);
  for(let i=0;i<80;i++){if(await live.evaluate(()=>document.querySelectorAll('#followQueueContent tbody tr').length>0&&!document.querySelector('#followQueueLoad:not([hidden])')))break;await sleep(100);}
  if(original.active==='followQueue'){
   await live.evaluate(filter=>{[...document.querySelectorAll('.fq-filter-tab')].find(e=>e.innerText===filter)?.click();},original.queueFilter);await sleep(300);
   await live.evaluate(fields=>{const elements=[...document.querySelectorAll('#followQueueContent input[type=search],#followQueueContent select')];fields.forEach((field,i)=>{if(elements[i]&&elements[i].value!==field.value){elements[i].value=field.value;elements[i].dispatchEvent(new Event(elements[i].tagName==='SELECT'?'change':'input',{bubbles:true}));}});},original.fields);await sleep(400);
   for(const handle of original.checkedHandles)await live.evaluate(handle=>{const row=[...document.querySelectorAll('#followQueueContent tbody tr')].find(row=>[...row.querySelectorAll('a[href^="https://x.com/"]')].some(a=>new URL(a.href).pathname.toLowerCase()==='/'+handle.toLowerCase()));const input=row?.querySelector('input[type=checkbox]');if(input&&!input.checked){input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));}},handle);
  }
  if(original.active==='monitor')await live.evaluate(original=>{
    if(original.fanTab)document.querySelector('[data-follower-tab="'+original.fanTab+'"]')?.click();
    for(const [id,value]of [['followerSearch',original.fanSearch],['followerPageSize',original.fanPageSize]]){const e=document.getElementById(id);if(e&&value!=null&&e.value!==value){e.value=value;e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));}}
  },original);
  if(original.logs)await live.evaluate(async logs=>{const c=window.__executionLogsModalController;await c.open(logs.scope);if(['fans','monitor'].includes(logs.scope))await c.setFansSubTab(logs.subTab);},original.logs);
  await live.evaluate(async alarms=>{const existing=new Set((await chrome.alarms.getAll()).map(a=>a.name));for(const alarm of alarms)if(!existing.has(alarm.name))await chrome.alarms.create(alarm.name,{when:Math.max(Date.now()+30000,alarm.scheduledTime),...(alarm.periodInMinutes?{periodInMinutes:alarm.periodInMinutes}:{})});},held);held=[];
  const version=await live.evaluate(async()=>({manifest:chrome.runtime.getManifest().version,background:await chrome.runtime.sendMessage({cmd:'getBackgroundBuildVersion'}),tab:await chrome.tabs.getCurrent()}));assert.equal(version.manifest,targetVersion);assert.equal(version.background.version,targetVersion);
  await fs.writeFile(folder+'/loaded.json',JSON.stringify(version,null,2));console.log(JSON.stringify({loaded:version.manifest,background:version.background.version,filesVerified:files,backup,restoredSelections:original.checkedHandles.length}));
 }
}finally {
 if(held.length){try{if(!page||page.isClosed())page=(await browser.pages()).find(p=>p.url().includes('/panel.html'));if(page)await page.evaluate(async alarms=>{for(const alarm of alarms)if(!await chrome.alarms.get(alarm.name))await chrome.alarms.create(alarm.name,{when:Math.max(Date.now()+30000,alarm.scheduledTime),...(alarm.periodInMinutes?{periodInMinutes:alarm.periodInMinutes}:{})});},held);}catch(error){console.error('Alarm restoration needs attention:',error.message);}}
 await browser.disconnect();
}

