import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const dir='C:/jtmp/xf-relay-recovery';await fs.mkdir(dir,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
let page;
try{
 const original=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().includes('/panel.html'));
 const cdp=await browser.target().createCDPSession();const {targetId}=await cdp.send('Target.createTarget',{url:new URL('panel.html?tab=monitor',original.url()).href,background:true});await cdp.detach();
 page=await (await browser.waitForTarget(t=>t._targetId===targetId)).page();
 await page.setViewport({width:1440,height:1000});
 await page.waitForFunction(()=>document.querySelector('#recordMigration')?.hidden&&Number(document.querySelector('#unreciprocatedCount')?.textContent)>0,{polling:100});
 await page.evaluate(()=>document.querySelector('[data-follower-tab="fanReview"]').click());
 const state=await page.evaluate(async()=>({version:chrome.runtime.getManifest().version,batch:(await chrome.runtime.sendMessage({cmd:'followQueueFanReviewStatus'})).batch,
  automation:(await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'})).automationStatus,alarms:(await chrome.alarms.getAll()).filter(a=>a.name==='x-fan-automation'||a.name==='x-fan-review-recovery')}));
 assert.equal(state.version,'4.30.2');assert.ok(state.alarms.length===2);
 await page.waitForFunction(()=>document.body.innerText.includes('AI 审核'),{polling:100});
 if(state.batch?.pendingRecovery){
  const card=`[data-result-key="review:${state.batch.id}"]`;
  await page.waitForSelector(card);
  await page.$eval(card,el=>el.querySelector('[aria-label="关闭结果"]').click());
  // Intercept starts in this test-owned page: reopening must be read-only.
  await page.evaluate(()=>{const original=chrome.runtime.sendMessage.bind(chrome.runtime);globalThis.__testStartCalls=0;
   chrome.runtime.sendMessage=(message,...rest)=>{if(message?.cmd==='followQueueFanReviewStart'){globalThis.__testStartCalls++;return Promise.resolve({ok:false,error:'TEST: unexpected new task'});}return original(message,...rest);};});
  await page.$eval('#monitorList input[data-fan-handle]',el=>el.click());
  await page.$eval('#reviewSelectedFans',el=>el.click());
  await page.waitForSelector(card+' [aria-label="查询原任务"]');
  assert.equal(await page.evaluate(()=>globalThis.__testStartCalls),0);
  await page.$eval(card,el=>el.querySelector('[aria-label="关闭结果"]').click());
  // Render a transient error card without touching persisted task data.
  await page.evaluate(batchId=>document.dispatchEvent(new CustomEvent('xfollower:operation-result',{detail:{
   id:'acceptance-original-task',resultKey:'acceptance-original-task',createdAt:Date.now(),kind:'fan-review',batchId,
   title:'操作未完成',note:'原 AI 任务尚未确认，请继续原审核任务',actions:[{action:'view-task',label:'查看原任务'}]}})),state.batch.id);
  await page.waitForSelector('[aria-label="查看原任务"]');
  await page.focus('[aria-label="查看原任务"]');
  await page.screenshot({path:dir+'/original-task-action.png',waitForFonts:false});
  await page.keyboard.press('Enter');
  await page.waitForSelector(card+' [aria-label="查询原任务"]');
  assert.equal(await page.evaluate(()=>globalThis.__testStartCalls),0);
  await page.$eval('[data-result-key="acceptance-original-task"]',el=>el.querySelector('[aria-label="关闭结果"]').click());
 }
 await page.screenshot({path:dir+'/review-desktop.png',waitForFonts:false});
 await page.setViewport({width:700,height:1000});
 const narrow=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('button')].filter(el=>el.getBoundingClientRect().width>0).every(el=>el.textContent.trim()||el.getAttribute('aria-label'))}));
 assert.equal(narrow.documentWidth,700);assert.equal(narrow.buttons,true);
 await page.screenshot({path:dir+'/review-narrow-700.png',waitForFonts:false});
 const report={at:new Date().toISOString(),...state,narrow};await fs.writeFile(dir+'/ui-acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(page)await page.close();browser.disconnect();}
