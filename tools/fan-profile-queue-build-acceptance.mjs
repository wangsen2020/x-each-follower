import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const folder='C:/jtmp/xf-post-queue-acceptance';await fs.mkdir(folder,{recursive:true});
const version=JSON.parse(await fs.readFile('dist/manifest.json','utf8')).version;
// A new offline Chrome process loads the actual dist. No signed-in profile,
// live X requests, AI calls, or user storage are used.
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
  ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-gpu','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
try{
 const offlineX=await browser.newPage();await offlineX.setRequestInterception(true);
 offlineX.on('request',request=>{if(request.isNavigationRequest()&&request.url()==='https://x.com/home')void request.respond({status:200,contentType:'text/html',body:'<!doctype html><title>Offline storage fixture</title>'});else void request.abort();});
 await offlineX.goto('https://x.com/home');
 const session=await browser.target().createCDPSession();
 const {id}=await session.send('Extensions.loadUnpacked',{path:path.resolve('dist')});
 const page=await browser.newPage();await page.setViewport({width:1400,height:1000});await page.goto(`chrome-extension://${id}/panel.html`);
 await page.waitForSelector('#openFanProfileQueue');
 assert.equal(await page.evaluate(()=>chrome.runtime.getManifest().version),version);
 await page.$eval('#openFanProfileQueue',e=>e.click());
 await page.waitForFunction(()=>document.querySelector('dialog[open]')?.textContent.includes('请先确认'),{polling:100});
 await page.keyboard.press('Escape');await new Promise(r=>setTimeout(r,100));
 const migration=await page.evaluate(()=>chrome.runtime.sendMessage({cmd:'recordData',op:'migrate'}));assert.equal(migration.ok,true);
 const before=await page.evaluate(async()=>{
  const checkpoint={pending:{a:{accountId:'1',handle:'offline_sample',targetUserId:'42',token:'test-only',attempts:1,retryAt:Date.now()+3600000,status:'rate-limited',reason:'离线验收样本'}},nextRequestAt:Date.now()+3600000,history:[{accountId:'1',targetUserId:'43',handle:'completed_sample',status:'ready',count:10,attempts:1,finishedAt:Date.now()}]};
  await chrome.storage.local.set({followQueueBinding:{accountId:'1',handle:'offline_owner',activated:true,sources:{}},'fanProfileCollection:v1':checkpoint});
  return checkpoint;
 });
 await page.$eval('#openFanProfileQueue',e=>e.click());
 await page.waitForFunction(()=>document.querySelector('.queue-items')?.textContent.includes('offline_sample'),{polling:100});
 assert.match(await page.$eval('.queue-schedule',e=>e.textContent),/下次执行|Next run/);
 assert.match(await page.$eval('.queue-overview',e=>e.textContent),/offline_owner/);
 await page.screenshot({path:folder+'/built-extension.png'});
 await page.keyboard.press('Escape');await page.reload();
 await page.waitForSelector('#openFanProfileQueue');await page.$eval('#openFanProfileQueue',e=>e.click());
 await page.waitForFunction(()=>document.querySelector('.queue-items')?.textContent.includes('offline_sample'),{polling:100});
 const after=await page.evaluate(async()=> (await chrome.storage.local.get('fanProfileCollection:v1'))['fanProfileCollection:v1']);
 assert.deepEqual(after,before);
 await page.keyboard.press('Escape');await new Promise(r=>setTimeout(r,100));
 const saved=await page.evaluate(async()=>{
  await chrome.storage.local.set({'fanProfileCollection:v1':{pending:{}}});
  return chrome.runtime.sendMessage({cmd:'recordData',op:'batch',sourceKey:'profileCache',changes:[{handle:'legacy_cache',sourceBucket:'map',create:true,accountId:'unassigned',patch:{id:'44',targetUserId:'44',handle:'legacy_cache',fanInspectionTimeline:{ownerAccountId:'1',targetUserId:'44',status:'partial',count:10,fetchedAt:Date.now()-3600000,checkedAt:Date.now()-3600000}}}]});
 });assert.equal(saved.ok,true);
 await page.$eval('#openFanProfileQueue',e=>e.click());
 await page.waitForFunction(()=>document.querySelector('.queue-items')?.textContent.includes('legacy_cache'),{polling:100});
 assert.match(await page.$eval('.queue-meta',e=>e.textContent),/已有采集记录|Existing collection record/);
 assert.ok(!await page.$eval('.queue-meta',e=>/已尝试|Attempts:/.test(e.textContent)));
 await page.screenshot({path:folder+'/built-existing-cache.png'});
 console.log(JSON.stringify({version,checks:['built panel entry opens','unbound account message','real background status API','current account queue and history','panel refresh retains checkpoints','view never mutates queue','empty queue shows actual saved profile results without inventing attempt counts'],screenshot:folder+'/built-existing-cache.png'}));
}finally{await browser.close();}
