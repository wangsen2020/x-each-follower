import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
const folder='C:/jtmp/xf-auto-4260/live';await fs.mkdir(folder,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null,protocolTimeout:15000});
try{
 const page=(await browser.pages()).find(page=>page.url().includes('/panel.html'));
 if(!page)throw Error('XFollower panel unavailable');
 const state=await page.evaluate(async()=>{
  const settings=await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'});
  const review=await chrome.runtime.sendMessage({cmd:'followQueueFanReviewStatus'});
  return {version:chrome.runtime.getManifest().version,automation:settings.settings?.automation,status:settings.automationStatus,
   alarm:await chrome.alarms.get('x-fan-automation'),removed:document.querySelector('#fanRemovedCount')?.innerText,
   review:review.batch?{stage:review.batch.stage,automatic:review.batch.automatic,nextIndex:review.batch.nextIndex,total:review.batch.handles?.length}:null};
 });
 await fs.writeFile(folder+'/state.json',JSON.stringify(state,null,2));console.log(JSON.stringify(state));
 if(process.argv.includes('--ui')){
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('xfollower:follow-review-settings',{detail:{scope:'fans'}})));
  await page.waitForSelector('#fan-auto-review',{timeout:15000});
  await page.screenshot({path:folder+'/settings.png',timeout:15000});
  console.log(JSON.stringify(await page.evaluate(()=>({review:document.querySelector('#fan-auto-review').checked,verify:document.querySelector('#fan-auto-verify').checked,overflow:document.documentElement.scrollWidth>innerWidth}))));
  await page.evaluate(()=>document.querySelector('#followReviewSettingsDialog').dispatchEvent(new Event('cancel',{cancelable:true})));
 }
}finally{browser.disconnect();}
