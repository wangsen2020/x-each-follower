import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output='C:/jtmp/xf-fan-removal-queue-ui';await fs.mkdir(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
 ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
try{
 const offline=await browser.newPage();await offline.setRequestInterception(true);offline.on('request',r=>{if(r.isNavigationRequest())void r.respond({status:200,contentType:'text/html',body:'<!doctype html><title>Offline fixture</title>'});else void r.abort();});await offline.goto('https://x.com/home');
 const control=await browser.target().createCDPSession();const {id}=await control.send('Extensions.loadUnpacked',{path:path.resolve('scratch/build-tests/fan-removal-queue')});
 const page=await browser.newPage();await page.setViewport({width:1280,height:900});await page.goto(`chrome-extension://${id}/panel.html`);
 await page.evaluate(async()=>{
  await chrome.runtime.sendMessage({cmd:'recordData',op:'migrate'});
  await chrome.storage.local.set({followQueueBinding:{activated:true,accountId:'1',handle:'fixture',confirmedAt:Date.now(),sources:{}}});
  const r=await chrome.runtime.sendMessage({cmd:'recordData',op:'batch',sourceKey:'monitor',changes:[{accountId:'unassigned',sourceBucket:'users',handle:'queued_fan',create:true,
   patch:{id:'100',targetUserId:'100',handle:'queued_fan',name:'Queued example',bio:'Fixture profile',relationship:{following:false,followedBy:true},relationshipKnown:true,relationshipObservedAt:Date.now(),
    fanReview:{state:'review',decision:'remove',source:'ai-rejection',ownerAccountId:'1',targetUserId:'100',decisionVersion:1,reason:'审核不通过，已进入自动移除队列',removalReceipt:{state:'queued',attempted:false,removed:false}}}}]});if(!r.ok)throw Error(r.error);
  await chrome.alarms.clearAll();
 });
 await page.reload();await page.waitForFunction(()=>document.querySelector('#fanReviewCount')?.textContent==='1').catch(async e=>{console.log(await page.evaluate(()=>document.body.innerText.slice(0,2200)));throw e;});await page.$eval('[data-follower-tab="fanReview"]',e=>e.click());
 await page.waitForFunction(()=>document.querySelector('#monitorList')?.innerText.includes('queued_fan')).catch(async e=>{console.log(await page.evaluate(()=>document.body.innerText.slice(0,2200)));throw e;});
 for(const width of [1280,640]){
  await page.setViewport({width,height:900});const state=await page.$eval('#monitorList',e=>({text:e.innerText,summaries:[...e.querySelectorAll('summary')].map(s=>s.innerText)}));
  assert.ok(state.summaries.includes('不通过 · 等待移除'));assert.doesNotMatch(state.text,/移除待确认/);
  await page.screenshot({path:`${output}/queue-${width}.png`});
 }
 console.log(JSON.stringify({version:'4.29.0',widths:[1280,640],states:['不通过 · 等待移除'],output}));
}finally{await browser.close();}
