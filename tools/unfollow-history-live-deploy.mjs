// Deploy a verified isolated artifact during an idle window. No business data
// writes: versioned application startup owns the historical repair.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve('E:/WebstormProjects/x-each-follower');
const source=path.resolve(process.argv[3]||'scratch/build-tests/unfollow-history');
const version=JSON.parse(await fs.readFile(path.join(source,'manifest.json'))).version;
const folder='C:/jtmp/xf-unfollow-history';await fs.mkdir(folder,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let page,held=[],original;
try {
 page=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().endsWith('/panel.html'));assert.ok(page);
 const gate=await page.evaluate(async()=>{
  const [queue,review,verify,mutual,saved,removals]=await Promise.all([
   chrome.runtime.sendMessage({cmd:'followQueueList',limit:1}),chrome.runtime.sendMessage({cmd:'followQueueFanReviewStatus'}),
   chrome.runtime.sendMessage({cmd:'followQueueFanBatchStatus'}),chrome.runtime.sendMessage({cmd:'mutualComments',action:'state'}),
   chrome.storage.local.get(['autoUnfollowState','fanProfileCollection:v1']),chrome.runtime.sendMessage({cmd:'fanRemovalQueueStatus'})]);
  return {ok:queue.ok&&review.ok&&verify.ok&&mutual.ok,version:chrome.runtime.getManifest().version,url:location.href,queue:!!queue.summary?.running,
   review:review.batch?.stage,verify:verify.batch?.stage,mutual:mutual.running,
   removal:!removals.ok||(removals.jobs||[]).some(j=>j.state==='running'),auto:Object.values(saved.autoUnfollowState?.accounts||{}).some(s=>s.scheduler?.phase==='running'&&Date.now()-s.scheduler.updatedAt<120000),
   collection:(saved['fanProfileCollection:v1']?.activeUntil||0)>Date.now(),
   selected:document.querySelectorAll('#monitorList input:checked,.review-list input:checked').length,
   editing:['INPUT','TEXTAREA'].includes(document.activeElement?.tagName),
   dialog:!!document.querySelector('dialog[open]:not(.review-drawer)'),
   reviewDrawer:!!document.querySelector('.review-drawer[open]'),reviewFilter:document.querySelector('.review-toolbar select')?.value,
   reviewSearch:document.querySelector('.review-toolbar input')?.value||'',
   tab:document.querySelector('.nav-tab.active')?.dataset.tab||''};
 });
 const busy=!gate.ok||gate.queue||gate.removal||gate.auto||gate.collection||['running','checking'].includes(gate.review)||['running','checking'].includes(gate.verify)
  ||gate.mutual?.scan||gate.mutual?.comment||gate.selected||gate.editing||gate.dialog;
 console.log(JSON.stringify({busy,...gate}));
 if(process.argv[2]!=='apply'||busy){process.exitCode=busy?2:0;}
 else {
  original=gate;
  const before=await page.evaluate(async()=>{
   const keys=['autoUnfollowState','unreciprocatedSettings','followQueueBinding','xAccountState:v1'];
   const saved=await chrome.storage.local.get(keys);
   return {saved,at:new Date().toISOString(),version:chrome.runtime.getManifest().version};
  });
  await fs.writeFile(folder+'/before.json',JSON.stringify(before,null,2));
  held=await page.evaluate(async()=>{const values=await chrome.alarms.getAll();for(const a of values)await chrome.alarms.clear(a.name);return values;});
  await fs.writeFile(folder+'/held-alarms.json',JSON.stringify(held,null,2));
  const dest=path.join(root,'dist'),stage=path.join(root,'scratch','unfollow-history-stage-'+Date.now()),backup=path.join(root,'artifacts','dist-before-unfollow-history-'+Date.now());
  for(const p of [dest,stage,backup])assert.ok(p.startsWith(root+path.sep)&&p!==root);
  assert.equal((await fs.lstat(dest)).isSymbolicLink(),false);assert.equal((await fs.lstat(source)).isSymbolicLink(),false);
  await fs.mkdir(path.dirname(backup),{recursive:true});await fs.cp(source,stage,{recursive:true,errorOnExist:true,force:false});
  let files=0;async function verify(rel='') {for(const e of await fs.readdir(path.join(source,rel),{withFileTypes:true})){
   const file=path.join(rel,e.name);if(e.isDirectory())await verify(file);else {
    const hash=async base=>createHash('sha256').update(await fs.readFile(path.join(base,file))).digest('hex');assert.equal(await hash(source),await hash(stage));files++;
   }
  }}await verify();
  await fs.rename(dest,backup);try{await fs.rename(stage,dest);}catch(error){await fs.rename(backup,dest);throw error;}
  await fs.writeFile(folder+'/deployment.json',JSON.stringify({version,source,dest,backup,files,original},null,2));
  await page.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),100);return true;});
  await sleep(1200);
  page=(await browser.pages()).find(p=>p.url()===original.url);
  if(!page){const session=await browser.target().createCDPSession();await session.send('Target.createTarget',{url:original.url,background:true});await session.detach();}
  for(let i=0;i<80;i++){
   page=(await browser.pages()).find(p=>p.url()===original.url);
   if(page){try{await page.reload({waitUntil:'domcontentloaded',timeout:10000});if(await page.evaluate(()=>chrome.runtime.getManifest().version)===version)break;}catch{}}
   await sleep(250);
  }
  assert.ok(page);
  const loaded=await page.evaluate(async()=>({manifest:chrome.runtime.getManifest().version,background:await chrome.runtime.sendMessage({cmd:'getBackgroundBuildVersion'}),
   records:await chrome.runtime.sendMessage({cmd:'recordData',op:'status'})}));
  assert.equal(loaded.manifest,version);assert.equal(loaded.background.version,version);assert.equal(loaded.records.status.dataUpgrades.replyUserIdRepair.status,'done');
  if(original.tab)await page.evaluate(tab=>[...document.querySelectorAll('.nav-tab')].find(el=>el.dataset.tab===tab)?.click(),original.tab);
  if(original.reviewDrawer){
   await page.waitForSelector('[aria-label="人工审核"]',{timeout:15000});
   await page.evaluate(()=>document.querySelector('[aria-label="人工审核"]').click());
   await page.waitForSelector('.review-drawer[open]');
   await page.evaluate(({reviewFilter,reviewSearch})=>{const s=document.querySelector('.review-toolbar select');if(s){s.value=reviewFilter;s.dispatchEvent(new Event('change',{bubbles:true}));}
    const input=document.querySelector('.review-toolbar input');if(input){input.value=reviewSearch;input.dispatchEvent(new Event('input',{bubbles:true}));}},original);
  }
  const after=await page.evaluate(async()=>({saved:await chrome.storage.local.get(['autoUnfollowState','unreciprocatedSettings','followQueueBinding']),at:new Date().toISOString()}));
  assert.deepEqual(after.saved.unreciprocatedSettings,before.saved.unreciprocatedSettings);assert.deepEqual(after.saved.followQueueBinding,before.saved.followQueueBinding);
  await fs.writeFile(folder+'/after.json',JSON.stringify({loaded,...after},null,2));
  console.log(JSON.stringify({loaded,files,backup}));
 }
} finally {
 if(held.length){page=(await browser.pages()).find(p=>p.url().endsWith('/panel.html')&&p.url().startsWith('chrome-extension://'));
  if(page)await page.evaluate(async alarms=>{for(const a of alarms)if(!await chrome.alarms.get(a.name))await chrome.alarms.create(a.name,{when:Math.max(Date.now()+30000,a.scheduledTime),...(a.periodInMinutes?{periodInMinutes:a.periodInMinutes}:{})});},held);
 }
 browser.disconnect();
}

