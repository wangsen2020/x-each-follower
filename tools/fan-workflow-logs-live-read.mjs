import puppeteer from 'puppeteer-core';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const folder='C:/jtmp/xf-fan-logs/live';await fs.mkdir(folder,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null,protocolTimeout:20000});let targetId,control;
try{
 const existing=(await browser.pages()).find(p=>p.url().endsWith('/panel.html'));if(!existing)throw Error('Panel unavailable');
 const base=existing.url(),url=base+'?fan-log-acceptance';control=await browser.target().createCDPSession();({targetId}=await control.send('Target.createTarget',{url,background:true}));
 const target=await browser.waitForTarget(t=>t.url()===url);const page=await target.page();
 await page.waitForFunction(()=>!!window.__executionLogsModalController,{polling:100,timeout:15000});
 const state=await page.evaluate(async()=>{
  const settings=await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'}),counts={};
  for(const scope of ['fanReview','fanVerify','fanSchedule']){const r=await chrome.runtime.sendMessage({cmd:'queryExecutionLogs',scope,limit:3});if(!r.ok)throw Error(r.error);counts[scope]={total:r.total,results:r.entries.map(e=>e.result)};}
  return {version:chrome.runtime.getManifest().version,background:(await chrome.runtime.sendMessage({cmd:'getBackgroundBuildVersion'})).version,automation:settings.settings.automation,counts};
 });
 const {original}=JSON.parse(await fs.readFile('C:/jtmp/xf-fan-logs/maintenance-settings.json','utf8'));assert.deepEqual(state.automation,original);assert.equal(state.version,'4.26.1');assert.equal(state.background,'4.26.1');
 await page.evaluate(()=>window.__executionLogsModalController.open('fans'));
 for(const [key,label]of [['review','审核日志'],['verify','核实日志'],['schedule','调度日志']]){
  await page.evaluate(key=>window.__executionLogsModalController.setFansSubTab(key),key);
  assert.ok(await page.$eval('#logsModalTitle',(e,label)=>e.textContent.includes(label),label));
 }
 await page.screenshot({path:folder+'/schedule.png',timeout:15000});
 await fs.writeFile(folder+'/acceptance.json',JSON.stringify(state,null,2));console.log(JSON.stringify(state));
}finally{if(targetId&&control)await control.send('Target.closeTarget',{targetId}).catch(()=>{});await browser.disconnect();}
