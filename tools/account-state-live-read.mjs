import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
try{
 const page=(await browser.pages()).find(p=>p.url().endsWith('/panel.html')&&p.url().startsWith('chrome-extension://'));
 const result=await page.evaluate(async()=>{
  const state=await chrome.runtime.sendMessage({cmd:'accountState'}),alarm=await chrome.alarms.get('x-account-state');
  const binding=(await chrome.storage.local.get('followQueueBinding')).followQueueBinding;
  const raw=(await chrome.storage.local.get('followQueueFanReviewBatch:'+binding.accountId))['followQueueFanReviewBatch:'+binding.accountId];
  const config=await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'});const queue=await chrome.runtime.sendMessage({cmd:'followQueueSettings'}),unfollow=(await chrome.storage.local.get('unreciprocatedSettings')).unreciprocatedSettings;
  const repeated=await Promise.all(Array.from({length:20},()=>chrome.runtime.sendMessage({cmd:'accountState'})));
  return {version:chrome.runtime.getManifest().version,accountStatus:state.status,accountMatchesBinding:state.account?.id===binding.accountId,accountHasId:!!state.account?.id,accountLabel:document.querySelector('.sidebar-account')?.innerText,alarm:alarm&&{periodInMinutes:alarm.periodInMinutes},repeatedReadsSameCheck:repeated.every(r=>r.checkedAt===state.checkedAt),automation:config.settings.automation,queueEnabled:queue.settings.enabled,autoUnfollowEnabled:unfollow.autoUnfollow,
   review:raw&&{stage:raw.stage,automatic:raw.automatic,error:raw.error||'',total:raw.total,done:raw.completed,nextIndex:raw.nextIndex,inFlight:!!raw.inFlightRelayJobId,received:!!raw.receivedTagging,submitting:raw.inFlightStage==='submitting',receipts:Object.keys(raw.actionReceipts||{}).length,results:(raw.results||[]).reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{})},schedules:Object.fromEntries(Object.entries(config.automationStatus||{}).map(([key,value])=>[key,{stage:value.stage,error:value.error||'',processed:value.processed,total:value.total,nextAt:value.nextAt}]))};
 });
 await fs.writeFile('C:/jtmp/xf-account-state/live-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 await page.screenshot({path:'C:/jtmp/xf-account-state/live-panel.png'});
}finally{await browser.disconnect();}
