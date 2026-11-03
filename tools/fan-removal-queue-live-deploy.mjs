import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve('E:/WebstormProjects/x-each-follower'),source=path.resolve('scratch/build-tests/fan-removal-queue');
const targetVersion=JSON.parse(await fs.readFile(source+'/manifest.json')).version;
const dest=path.join(root,'dist'),stage=path.join(root,'scratch','fan-removal-queue-deploy-'+Date.now()),backup=path.join(root,'artifacts','dist-before-removal-queue-'+Date.now());
for(const file of [dest,stage,backup])assert.ok(file.startsWith(root+path.sep)&&file!==root);
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});let alarms=[],page;
try{
 page=(await browser.pages()).find(p=>p.url().endsWith('/panel.html')&&p.url().startsWith('chrome-extension://'));assert.ok(page);
 const before=await page.evaluate(async()=>{const q=await chrome.runtime.sendMessage({cmd:'followQueueList',limit:1}),m=await chrome.runtime.sendMessage({cmd:'mutualComments',action:'state'}),r=await chrome.runtime.sendMessage({cmd:'followQueueFanReviewStatus'}),v=await chrome.runtime.sendMessage({cmd:'followQueueFanBatchStatus'});
 return {version:chrome.runtime.getManifest().version,url:location.href,queue:!!q.summary?.running,review:r.batch?.stage,verify:v.batch?.stage,mutual:m.running,
  selection:document.querySelectorAll('#monitorList input:checked').length,editing:['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)};});
 console.log(JSON.stringify(before));assert.equal(before.queue,false);assert.notEqual(before.review,'running');assert.notEqual(before.verify,'running');assert.ok(!before.mutual?.comment&&!before.mutual?.scan);assert.equal(before.selection,0);assert.equal(before.editing,false);
 alarms=await page.evaluate(async()=>{const a=await chrome.alarms.getAll();for(const x of a)await chrome.alarms.clear(x.name);return a;});
 await fs.mkdir('C:/jtmp/xf-fan-removal-queue-deploy',{recursive:true});await fs.writeFile('C:/jtmp/xf-fan-removal-queue-deploy/held-alarms.json',JSON.stringify(alarms));
 await fs.mkdir(path.dirname(stage),{recursive:true});await fs.mkdir(path.dirname(backup),{recursive:true});
 assert.equal((await fs.lstat(dest)).isSymbolicLink(),false);await fs.cp(source,stage,{recursive:true,errorOnExist:true,force:false});
 let count=0;async function check(dir=''){for(const e of await fs.readdir(path.join(source,dir),{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await check(f);else{const hash=async base=>createHash('sha256').update(await fs.readFile(path.join(base,f))).digest('hex');assert.equal(await hash(source),await hash(stage));count++;}}}await check();
 await fs.rename(dest,backup);try{await fs.rename(stage,dest);}catch(e){await fs.rename(backup,dest);throw e;}
 await page.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),100);return true;});
 for(let i=0;i<60;i++){
  await new Promise(r=>setTimeout(r,150));const live=(await browser.pages()).find(p=>p.url()===before.url);
  if(live){try{await live.reload({waitUntil:'domcontentloaded',timeout:10000});if(await live.evaluate(()=>chrome.runtime.getManifest().version)===targetVersion){page=live;break;}}catch{}}
 }
 if(!page||page.isClosed()){const c=await browser.target().createCDPSession();await c.send('Target.createTarget',{url:before.url,background:true});
  for(let i=0;i<60;i++){page=(await browser.pages()).find(p=>p.url()===before.url);if(page)break;await new Promise(r=>setTimeout(r,150));}}
 assert.ok(page);const loaded=await page.evaluate(async()=>({version:chrome.runtime.getManifest().version,background:await chrome.runtime.sendMessage({cmd:'getBackgroundBuildVersion'})}));assert.equal(loaded.version,targetVersion);assert.equal(loaded.background.version,targetVersion);
 console.log(JSON.stringify({loaded,filesVerified:count,backup}));
}finally{
 if(alarms.length){if(!page||page.isClosed())page=(await browser.pages()).find(p=>p.url().includes('/panel.html'));if(page)await page.evaluate(async alarms=>{for(const a of alarms)if(!await chrome.alarms.get(a.name))await chrome.alarms.create(a.name,{when:Math.max(Date.now()+30000,a.scheduledTime),...(a.periodInMinutes?{periodInMinutes:a.periodInMinutes}:{})});},alarms);}
 browser.disconnect();
}
