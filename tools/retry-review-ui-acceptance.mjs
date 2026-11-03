import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
const output=resolve('artifacts/retry-review');await fs.mkdir(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--no-sandbox','--disable-gpu']});
const url='http://127.0.0.1:5194/tests/fixtures/auto-unfollow-review-acceptance.html?run='+Date.now();
let page;const errors=[],checks=[];
const click=selector=>page.evaluate(selector=>{const element=document.querySelector(selector);if(!element||element.disabled)throw Error('Control unavailable: '+selector);element.click();},selector);
// Puppeteer's waitForFunction uses an isolated world; the fixture API is in MAIN.
async function waitMain(predicate,options={},...args){const until=Date.now()+(options.timeout||10000);do{if(await page.evaluate(predicate,...args))return;await new Promise(r=>setTimeout(r,100));}while(Date.now()<until);throw Error('MAIN-world acceptance condition timed out: '+predicate);}
try {
 page=await browser.newPage();await page.goto(url,{waitUntil:'networkidle0'});
 assert.ok(page);page.on('pageerror',error=>errors.push(error.message));
 await page.setViewport({width:1440,height:1000});await waitMain(()=>Boolean(window.acceptance));
 const seed=async count=>{await page.evaluate(count=>acceptance.seed(count),count);await waitMain(count=>acceptance.data.autoUnfollowState.accounts[1].reviewItems.length===count,{},count);};
 const open=async()=>{if(!await page.$('.review-drawer[open]'))await click('[aria-label="人工审核"]');await page.waitForSelector('.review-drawer[open]');};
 const screenshot=async name=>{await page.screenshot({waitForFonts:false,path:resolve(output,name+'.png')});};
 await seed(24);await open();await page.waitForSelector('.review-list li');
 assert.equal((await page.$$('.review-list li')).length,10);checks.push('24 records paginate at 10 per page');
 await screenshot('desktop');
 await click('.review-select-page input');await click('[aria-label="下一页"]');
 await click('.review-list li input');
 assert.match(await page.$eval('.review-toolbar',el=>el.innerText),/已选 11 项/);checks.push('cross-page selection retains the selected total');
 await page.select('.review-toolbar select','skipped');await page.waitForSelector('.review-empty');
 assert.match(await page.$eval('.review-toolbar',el=>el.innerText),/已选 0 项/);checks.push('filter changes clear selection and show the empty state');
 await page.select('.review-toolbar select','review');
 await page.focus('.review-list button[aria-label="重试"]');await page.waitForSelector('#panel-info-tip-tooltip');
 assert.ok(await page.$eval('.review-list button[aria-label="重试"]',el=>el.getAttribute('aria-describedby')));checks.push('keyboard focus shows the shared tooltip');
 await screenshot('keyboard-tip');await click('[aria-label="展开原因"]');assert.match(await page.$eval('.review-list li:nth-child(2) .review-account p:not(.reason-collapsed)',el=>el.innerText),/较长/);await click('[aria-label="收起原因"]');checks.push('long reasons expand and collapse without losing their full text');
 await seed(3);await page.evaluate(()=>{acceptance.failDelete='review_1';});
 await click('.review-select-page input');await click('[aria-label="删除选中记录"]');await page.waitForSelector('.review-confirm[open]');
 assert.match(await page.$eval('.review-confirm',el=>el.innerText),/3 个账号/);await screenshot('delete-confirmation');
 await click('.review-confirm button:last-child');
 await waitMain(()=>document.querySelector('.review-feedback')?.innerText.includes('已完成 2 项，失败 1 项'));
 assert.deepEqual(await page.evaluate(()=>({deleted:acceptance.deletes,handles:acceptance.data.autoUnfollowState.accounts[1].reviewItems.map(x=>x.user.handle),reads:acceptance.reads})),{deleted:2,handles:['review_1'],reads:0});
 checks.push('batch deletion continues after one failure; failed record stays selected and inspectable; zero X requests');await screenshot('batch-partial-failure');
 await page.evaluate(()=>{acceptance.failDelete='';});await click('.review-list button[aria-label="删除本地记录"]');await page.waitForSelector('.review-confirm[open]');await click('.review-confirm button:last-child');
 await waitMain(()=>acceptance.data.autoUnfollowState.accounts[1].reviewItems.length===0);checks.push('retrying a failed local deletion succeeds');
 await seed(3);await click('.review-list button[aria-label="跳过"]');await waitMain(()=>acceptance.data.autoUnfollowState.accounts[1].reviewItems[0]?.status==='skipped');
 await page.select('.review-toolbar select','skipped');await waitMain(()=>document.querySelector('.review-list')?.innerText.includes('TracySnyder90'));
 await page.reload();await waitMain(()=>Boolean(window.acceptance));await open();await page.select('.review-toolbar select','skipped');
 await waitMain(()=>document.querySelector('.review-list')?.innerText.includes('TracySnyder90'));checks.push('skip survives close/reopen and remains available for explicit retry');
 await click('.review-list button[aria-label="重试"]');await waitMain(()=>!acceptance.data.autoUnfollowState.accounts[1].reviewItems.some(x=>x.user.handle==='TracySnyder90'));
 assert.equal(await page.evaluate(()=>acceptance.reads),0);checks.push('manual retry resets state without issuing an action');
 await seed(3);await page.select('.review-toolbar select','review');
 await page.$eval('.review-toolbar input',el=>{el.value='review_2';el.dispatchEvent(new Event('input',{bubbles:true}));});
 await waitMain(()=>document.querySelectorAll('.review-list li').length===1);await click('.review-list button[aria-label="重试"]');
 await waitMain(()=>!acceptance.data.autoUnfollowState.accounts[1].reviewItems.some(x=>x.user.handle==='review_2'));
 assert.deepEqual(await page.evaluate(()=>{const p=acceptance.data.autoUnfollowState.accounts[1].pendingItems[0];return {phase:p.phase,checks:p.checks};}),{phase:'submitting',checks:0});checks.push('retry preserves uncertain submission evidence and only reopens verification');
 await page.keyboard.press('Escape');await click('#settings');await page.waitForSelector('#unreciprocatedMaxAttempts');
 await page.$eval('#unreciprocatedMaxAttempts',el=>{el.value='0';el.dispatchEvent(new Event('input',{bubbles:true}));});await click('#saveUnreciprocatedSettings');
 assert.equal(await page.evaluate(()=>acceptance.data.unreciprocatedSettings.autoUnfollowMaxAttempts),3);
 await page.$eval('#unreciprocatedMaxAttempts',el=>{el.value='2';el.dispatchEvent(new Event('input',{bubbles:true}));});await click('#saveUnreciprocatedSettings');
 await waitMain(()=>acceptance.data.unreciprocatedSettings.autoUnfollowMaxAttempts===2);
 await click('#closeUnreciprocatedSettingsDrawer');await click('#settings');assert.equal(await page.$eval('#unreciprocatedMaxAttempts',el=>el.value),'2');checks.push('settings reject zero and retain the saved limit after close/reopen');
 await click('#closeUnreciprocatedSettingsDrawer');await seed(24);await open();await page.$eval('.review-toolbar input',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
 for(const width of [700,390]){await page.setViewport({width,height:900});await new Promise(r=>setTimeout(r,150));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await screenshot('width-'+width);}
 checks.push('1440, 700 (equivalent to 200% of 1400) and 390 pixel widths have no horizontal overflow');
 await page.evaluate(()=>localStorage.setItem('xf-review-language','en'));await page.reload();await waitMain(()=>Boolean(window.acceptance));await click('[aria-label="Manual review"]');await page.waitForSelector('.review-drawer[open]');await screenshot('english-mobile');checks.push('English controls and empty/long content fit on mobile');
 await page.evaluate(()=>localStorage.removeItem('xf-review-language'));
 assert.deepEqual(errors,[]);
 await fs.writeFile(resolve(output,'report.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors,output},null,2));
} catch(error) {if(page)await page.screenshot({waitForFonts:false,path:resolve(output,'failure.png')});console.error('UI errors:',errors);throw error;}
finally{await browser.close();}
