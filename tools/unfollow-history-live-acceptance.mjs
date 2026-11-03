// Read-only business acceptance. Only the test-owned panel is navigated/closed.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const folder='C:/jtmp/xf-unfollow-history';await fs.mkdir(folder,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
let page;
try{
 const original=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().endsWith('/panel.html'));assert.ok(original);
 const session=await browser.target().createCDPSession();const {targetId}=await session.send('Target.createTarget',{url:original.url(),background:true});await session.detach();
 const target=await browser.waitForTarget(t=>t._targetId===targetId);page=await target.page();
 await page.setViewport({width:1440,height:1000});await page.waitForSelector('.nav-tab[data-tab="unreciprocated"]');
 await page.waitForFunction(()=>document.querySelector('#recordMigration')?.hidden&&Number(document.querySelector('#unreciprocatedCount')?.textContent)>50,{polling:100});
 await page.evaluate(()=>document.querySelector('.nav-tab[data-tab="unreciprocated"]').click());
 await page.waitForFunction(()=>Number(document.querySelector('#tabUnfollowedCount')?.textContent)>22,{polling:100});
 await page.evaluate(()=>document.querySelector('[data-unreciprocated-tab="unfollowed"]').click());
 await page.waitForFunction(()=>document.querySelectorAll('#unreciprocatedResults tr').length>20,{polling:100});
 const history=await page.evaluate(async()=>{
  const summary=await chrome.runtime.sendMessage({cmd:'recordData',op:'summary',module:'unreciprocated'});
  let cursor=null;const handles=[];do{const p=await chrome.runtime.sendMessage({cmd:'recordData',op:'query',module:'unreciprocated',filter:{tab:'unfollowed'},limit:100,cursor});if(!p.ok)throw Error(JSON.stringify(p));handles.push(...p.page.records.map(r=>r.handle));cursor=p.page.nextCursor;}while(cursor);
  let logCursor=null;const logged=new Set();do{const p=await chrome.runtime.sendMessage({cmd:'queryExecutionLogs',scope:'unreciprocated',limit:50,cursor:logCursor});if(!p.ok)throw Error(JSON.stringify(p));for(const e of p.entries)if(e.result==='success')for(const h of e.unfollowedHandles||[])logged.add(String(h).replace(/^@/,'').toLowerCase());logCursor=p.nextCursor;}while(logCursor);
  return {version:chrome.runtime.getManifest().version,summary:summary.summary,historyCount:handles.length,unique:new Set(handles).size,logged:logged.size,missing:[...logged].filter(h=>!handles.includes(h)),text:document.querySelector('#unreciprocatedPageSummary')?.textContent};
 });
 assert.equal(history.version,'4.30.0');assert.equal(history.historyCount,history.unique);assert.equal(history.historyCount,history.summary.tabs.unfollowed);assert.equal(history.missing.length,0);
 await page.screenshot({path:folder+'/history-desktop.png',waitForFonts:false});
 const first=await page.$eval('#unreciprocatedResults',el=>el.innerText);
 await page.evaluate(()=>document.querySelector('#unreciprocatedNextPage').click());
 await page.waitForFunction(before=>document.querySelector('#unreciprocatedResults')?.innerText!==before,{polling:100},first);
 assert.equal(await page.$eval('#unreciprocatedPrevPage',el=>el.disabled),false);
 await page.screenshot({path:folder+'/history-page2.png',waitForFonts:false});
 await page.setViewport({width:700,height:1000});
 const narrow=await page.evaluate(()=>{const section=document.querySelector('#unreciprocatedSection');return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,buttons:[...section.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width>0).every(b=>b.getAttribute('aria-label')||b.textContent.trim())};});
 assert.equal(narrow.buttons,true);await page.screenshot({path:folder+'/history-narrow-700.png',waitForFonts:false});
 await page.setViewport({width:1440,height:1000});
 await page.evaluate(()=>document.querySelector('.nav-tab[data-tab="monitor"]').click());
 await page.screenshot({path:folder+'/fans-desktop.png',waitForFonts:false});
 const report={at:new Date().toISOString(),history,narrow};await fs.writeFile(folder+'/acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){if(page){await page.screenshot({path:folder+'/acceptance-error.png',waitForFonts:false});console.log(JSON.stringify(await page.evaluate(()=>({tab:document.querySelector('.nav-tab.active')?.dataset.tab,count:document.querySelector('#tabUnfollowedCount')?.textContent,text:document.querySelector('#unreciprocatedSection')?.innerText?.slice(0,1500)}))));}throw error;
}finally{if(page)await page.close();browser.disconnect();}

