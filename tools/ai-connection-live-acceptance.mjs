import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const folder='C:/jtmp/xf-ai-connection-state';await fs.mkdir(folder,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
try {
 const page=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().includes('/panel.html'));assert.ok(page);
 const result=await page.evaluate(async()=>{
  const before=await chrome.runtime.sendMessage({cmd:'aiConnection'});
  const reads=await Promise.all(Array.from({length:12},()=>chrome.runtime.sendMessage({cmd:'aiConnection'})));
  const after=await chrome.runtime.sendMessage({cmd:'aiConnection'});
  return {version:chrome.runtime.getManifest().version,before:Object.fromEntries(Object.entries(before.result).map(([p,s])=>[p,{state:s.state,checkedAt:s.checkedAt,nextAt:s.nextAt,sessions:s.sessions.length}])),after:Object.fromEntries(Object.entries(after.result).map(([p,s])=>[p,s.checkedAt])),readsOk:reads.every(r=>r.ok),alarms:(await chrome.alarms.getAll()).map(a=>({name:a.name,scheduledTime:a.scheduledTime,periodInMinutes:a.periodInMinutes}))};
 });
 assert.equal(result.version,'4.32.0');assert.equal(result.readsOk,true);
 for(const[p,s]of Object.entries(result.before)){assert.equal(s.state,'ready');assert.equal(s.checkedAt,result.after[p]);}
 assert.equal(result.alarms.find(a=>a.name==='x-ai-connection-monitor').periodInMinutes,1);
 assert.equal(await page.$('.ai-connection-notice'),null);
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('xfollower:bind-grok-local',{detail:{provider:'grok-local'}})));
 await page.waitForSelector('#systemSettingsDrawer[open]');await page.waitForFunction(()=>document.querySelector('.ai-state')?.textContent.includes('连接正常'),{polling:200});
 const controls=await page.evaluate(()=>({retry:!!document.querySelector('.ai-actions [aria-label="重试连接"]'),tokenMasked:document.querySelector('#ai-token')?.type==='password',sessions:document.querySelector('#ai-session')?.options?.length}));
 assert.equal(controls.retry,true);assert.equal(controls.tokenMasked,true);assert.ok(controls.sessions>1);
 await page.$eval('.ai-actions [aria-label="重试连接"]',el=>el.click());
 await page.waitForFunction(async old=>{const r=await chrome.runtime.sendMessage({cmd:'aiConnection',provider:'grok-local'});return r.result?.connected&&r.result?.state==='ready'&&r.result.checkedAt>old;},{polling:200,timeout:60000},result.before['grok-local'].checkedAt);
 controls.manualRetryPassed=true;
 for(const[width,height]of [[1280,900],[390,844]]){await page.setViewport({width,height});const cdp=await page.createCDPSession();const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(`${folder}/live-settings-${width}.png`,Buffer.from(shot.data,'base64'));await cdp.detach();assert.ok(await page.$eval('#systemSettingsDrawer',e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));}
 await page.keyboard.press('Escape');await page.setViewport({width:1280,height:900});
 await fs.writeFile(folder+'/live.json',JSON.stringify({...result,controls},null,2));console.log(JSON.stringify({version:result.version,states:result.before,readsDidNotProbe:true,alarmCount:result.alarms.length,controls}));
}finally{browser.disconnect();}
