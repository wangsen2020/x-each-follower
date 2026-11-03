import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const folder='C:/jtmp/xf-local-id-repair';await fs.mkdir(folder,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
const owner='1485853007346827264',target='mzixioxio155612';
const expected={andysniper11:'',chongtaozhang:'',wayne_1175:'',zhng684890591:'1600027363982512131',mzixioxio155612:'1762674580253265920'};
let testPage;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(page,predicate){for(let i=0;i<150;i++){if(await page.evaluate(predicate))return;await wait(200);}throw Error('UI result timed out; no action repeated');}
try {
 const page=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().endsWith('/panel.html'));assert.ok(page);
 await page.bringToFront();
 const before=await page.evaluate(async owner=>({version:chrome.runtime.getManifest().version,
  state:(await chrome.storage.local.get(['autoUnfollowState'])).autoUnfollowState.accounts[owner],
  records:await chrome.runtime.sendMessage({cmd:'recordData',op:'lookupAll',handle:'mzixioxio155612'})}),owner);
 assert.equal(before.version,'4.29.1');
 for(const [handle,id] of Object.entries(expected))assert.equal(before.state.reviewItems.find(x=>x.user.handle.toLowerCase()===handle)?.user.id,id);
 assert.ok(before.records.records.some(x=>x.module!=='logs'));
 await fs.writeFile(folder+'/acceptance-before.json',JSON.stringify(before,null,2));
 await page.waitForSelector('.review-drawer[open]');
 const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
 await page.screenshot({path:folder+'/desktop-upgraded.png',waitForFonts:false});
 await page.focus('.review-toolbar input');
 await page.focus('.review-list button[aria-label="删除本地记录"]');
 await page.waitForSelector('#panel-info-tip-tooltip');
 const named=await page.$eval('.review-list button[aria-label="删除本地记录"]',el=>!!el.getAttribute('aria-describedby'));assert.equal(named,true);
 await page.screenshot({path:folder+'/keyboard-tip.png',waitForFonts:false});
 if(process.argv[2]==='confirm-local-delete'){
  const clicked=await page.evaluate(handle=>{const row=[...document.querySelectorAll('.review-list li')].find(li=>li.querySelector('a')?.textContent.toLowerCase()==='@'+handle);
   const button=row?.querySelector('button[aria-label="删除本地记录"]');if(!button||button.disabled)return false;button.click();return true;},target);assert.equal(clicked,true);
  await page.waitForSelector('.review-confirm[open]');
  assert.match(await page.$eval('.review-confirm',el=>el.innerText),/1 个账号的本地记录/);
  await page.screenshot({path:folder+'/confirmation-one-local-record.png',waitForFonts:false});
  await page.evaluate(()=>document.querySelector('.review-confirm button:last-child').click());
  await until(page,()=>document.querySelector('.review-feedback')?.innerText.includes('已完成 1 项，失败 0 项'));
  const after=await page.evaluate(async owner=>({state:(await chrome.storage.local.get(['autoUnfollowState'])).autoUnfollowState.accounts[owner],
   records:await chrome.runtime.sendMessage({cmd:'recordData',op:'lookupAll',handle:'mzixioxio155612'}),feedback:document.querySelector('.review-feedback')?.innerText}),owner);
  assert.equal(after.state.reviewItems.some(x=>x.user.handle.toLowerCase()===target),false);
  assert.equal(after.records.records.some(x=>x.module!=='logs'),false);
  for(const entry of before.state.reviewItems.filter(x=>x.user.handle.toLowerCase()!==target))assert.deepEqual(after.state.reviewItems.find(x=>x.user.handle.toLowerCase()===entry.user.handle.toLowerCase()),entry);
  assert.deepEqual(after.state.pendingItems,before.state.pendingItems);
  await fs.writeFile(folder+'/acceptance-after.json',JSON.stringify(after,null,2));
  await page.screenshot({path:folder+'/desktop-local-delete-success.png',waitForFonts:false});
 }
 const session=await browser.target().createCDPSession();
 const {targetId}=await session.send('Target.createTarget',{url:page.url(),background:true});await session.detach();
 for(let i=0;i<60;i++){const t=browser.targets().find(t=>t._targetId===targetId);if(t){testPage=await t.page();if(testPage)break;}await wait(100);}
 assert.ok(testPage);await testPage.setViewport({width:700,height:1000});
 await testPage.waitForSelector('.nav-tab[data-tab="unreciprocated"]');
 await testPage.evaluate(()=>document.querySelector('.nav-tab[data-tab="unreciprocated"]').click());
 await testPage.waitForSelector('[aria-label="人工审核"]');
 await testPage.evaluate(()=>document.querySelector('[aria-label="人工审核"]').click());await testPage.waitForSelector('.review-drawer[open]');
 const layout=await testPage.evaluate(()=>{const d=document.querySelector('.review-drawer'),r=d.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,scroll:d.scrollWidth,client:d.clientWidth,buttons:[...d.querySelectorAll('button')].every(x=>x.getAttribute('aria-label')||x.textContent.trim())};});
 assert.ok(layout.left>=0&&layout.right<=700);assert.ok(layout.scroll<=layout.client);assert.equal(layout.buttons,true);
 await testPage.screenshot({path:folder+'/narrow-700.png',waitForFonts:false});
 const report={at:new Date().toISOString(),version:before.version,viewport,narrow:layout,migratedReviews:5,localDeleted:process.argv[2]==='confirm-local-delete'?target:null,remainingReview:process.argv[2]==='confirm-local-delete'?4:5};
 await fs.writeFile(folder+'/acceptance-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(testPage)await testPage.close();browser.disconnect();}
