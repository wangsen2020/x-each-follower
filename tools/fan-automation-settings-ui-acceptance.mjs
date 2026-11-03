import {createServer} from 'vite';import vue from '@vitejs/plugin-vue';import puppeteer from 'puppeteer-core';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const folder='C:/jtmp/xf-auto-4260';await fs.mkdir(folder,{recursive:true});
const server=await createServer({configFile:false,optimizeDeps:{entries:['tests/fixtures/fan-review-settings-preview.html']},root:process.cwd(),plugins:[vue()],server:{host:'127.0.0.1',port:5188,strictPort:true}});await server.listen();
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});
const checks=[],errors=[];
try{const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1280,height:900});await page.goto('http://127.0.0.1:5188/tests/fixtures/fan-review-settings-preview.html');await page.waitForFunction(()=>globalThis.__reviewFixture?.ready);
 const open=async()=>{await page.click('#open-fans');await page.waitForSelector('#fan-auto-review');};
 await open();assert.equal(await page.$eval('#fan-auto-review',e=>e.checked),true);assert.equal(await page.$eval('#fan-auto-verify',e=>e.checked),true);
 assert.equal(await page.$eval('#fan-auto-review-interval',e=>e.value),'1');assert.equal(await page.$eval('#fan-auto-verify-interval',e=>e.value),'2');checks.push('legacy settings default both schedules on');
 await page.click('#fan-auto-review');await page.$eval('#fan-auto-verify-limit',e=>{e.value='7';e.dispatchEvent(new Event('input',{bubbles:true}));});await page.click('#saveFollowReviewSettings');await page.waitForFunction(()=>__reviewFixture.settings.automation?.verify.limit===7);
 await page.keyboard.press('Escape');await open();assert.equal(await page.$eval('#fan-auto-review',e=>e.checked),false);assert.equal(await page.$eval('#fan-auto-verify',e=>e.checked),true);checks.push('switches and parameters persist independently');
 await page.$eval('#fan-auto-review-interval',e=>{e.value='0';e.dispatchEvent(new Event('input',{bubbles:true}));});await page.click('#saveFollowReviewSettings');await page.waitForFunction(()=>document.querySelector('.follow-review-error')?.textContent.includes('参数'));assert.equal(await page.evaluate(()=>__reviewFixture.settings.automation.review.intervalMinutes),1);checks.push('invalid input stays editable and cannot overwrite saved settings');
 await page.$eval('#fan-auto-review-interval',e=>{e.value='1';e.dispatchEvent(new Event('input',{bubbles:true}));});
 for(const [width,height,language,name]of [[1280,900,'zh-CN','settings-desktop'],[390,844,'zh-CN','settings-narrow'],[640,450,'zh-CN','settings-zoom'],[390,844,'en','settings-en'],[390,844,'pt-BR','settings-pt'],[390,844,'es-419','settings-es']]){
  await page.setViewport({width,height});await page.evaluate(language=>__reviewFixture.locale(language),language);await page.$eval('.follow-review-body',e=>e.scrollTop=0);
  assert.equal(await page.evaluate(()=>{const r=document.querySelector('dialog[open]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;}),true);
  await page.screenshot({path:folder+'/'+name+'.png'});
 }checks.push('four languages, 390 px width and 640 × 450 equivalent zoom');
 await page.keyboard.press('Escape');await page.evaluate(()=>{__reviewFixture.locale('zh-CN');__reviewFixture.settings.fanTagging={provider:'codex',botId:'fixture-initial',prompt:'',batchSize:10,intervalSeconds:3};__reviewFixture.disconnect=true;});await open();await page.click('#fan-auto-verify');await page.click('#saveFollowReviewSettings');await page.waitForFunction(()=>__reviewFixture.settings.automation.verify.enabled===false);checks.push('schedules can be disabled while unchanged AI engine is disconnected');
 assert.deepEqual(errors,[]);await fs.writeFile(folder+'/settings-ui.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors}));
}finally{await browser.close();await server.close();}
