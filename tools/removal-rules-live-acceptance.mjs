import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const dir='C:/jtmp/xf-removal-rules';await fs.mkdir(dir,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});let page;
try{
 const original=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().includes('/panel.html'));
 const session=await browser.target().createCDPSession();const {targetId}=await session.send('Target.createTarget',{url:new URL('panel.html?tab=monitor',original.url()).href,background:true});await session.detach();
 page=await(await browser.waitForTarget(t=>t._targetId===targetId)).page();await page.setViewport({width:1280,height:900});
 await page.waitForFunction(()=>document.querySelector('#recordMigration')?.hidden,{polling:100});
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('xfollower:follow-review-settings',{detail:{scope:'fans'}})));
 await page.waitForSelector('#fan-block-empty');
 const result=await page.evaluate(async()=>({version:chrome.runtime.getManifest().version,background:await chrome.runtime.sendMessage({cmd:'getBackgroundBuildVersion'}),
  rules:(await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'})).settings.removalRules,
  fields:['fan-block-suggestive','fan-block-empty'].map(id=>({id,checked:document.getElementById(id).checked,label:document.querySelector('label[for="'+id+'"]').textContent})),
  alarms:(await chrome.alarms.getAll()).map(a=>a.name)}));
 assert.equal(result.version,'4.31.0');assert.equal(result.background.version,'4.31.0');
 assert.deepEqual(result.rules,{blockSuggestive:false,blockEmpty:false});assert.ok(result.fields.every(f=>!f.checked));
 await page.screenshot({path:dir+'/live-settings-1280.png',waitForFonts:false});
 await page.setViewport({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:dir+'/live-settings-390.png',waitForFonts:false});
 await fs.writeFile(dir+'/live-acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(page)await page.close();browser.disconnect();}
