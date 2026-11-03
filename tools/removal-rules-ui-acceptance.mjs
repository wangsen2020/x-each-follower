import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const dir='C:/jtmp/xf-removal-rules';await fs.mkdir(dir,{recursive:true});
const server=await createServer({configFile:false,optimizeDeps:{entries:['tests/fixtures/fan-review-settings-preview.html']},root:process.cwd(),plugins:[vue()],server:{host:'127.0.0.1',port:5188,strictPort:true}});await server.listen();
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5188/tests/fixtures/fan-review-settings-preview.html');
 await page.waitForFunction(()=>globalThis.__reviewFixture?.ready);
 const open=async()=>{await page.click('#open-fans');await page.waitForSelector('#fan-block-empty');};await open();
 for(const id of ['fan-block-suggestive','fan-block-empty'])assert.equal(await page.$eval('#'+id,e=>e.checked),false);
 await page.click('#fan-block-suggestive');await page.click('#saveFollowReviewSettings');
 await page.waitForFunction(()=>__reviewFixture.settings.removalRules?.blockSuggestive===true);
 await page.keyboard.press('Escape');await open();assert.equal(await page.$eval('#fan-block-suggestive',e=>e.checked),true);assert.equal(await page.$eval('#fan-block-empty',e=>e.checked),false);
 await page.focus('#fan-block-empty');await page.keyboard.press('Space');await page.click('#saveFollowReviewSettings');await page.waitForFunction(()=>__reviewFixture.settings.removalRules?.blockEmpty===true);
 await page.keyboard.press('Escape');await open();assert.equal(await page.$eval('#fan-block-empty',e=>e.checked),true);
 for(const [width,height,lang]of [[1280,900,'zh-CN'],[390,844,'zh-CN'],[640,450,'zh-CN'],[390,844,'en']]){
  await page.setViewport({width,height});await page.evaluate(l=>__reviewFixture.locale(l),lang);await page.$eval('.follow-review-body',e=>e.scrollTop=0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${dir}/settings-${lang}-${width}.png`});
 }
 assert.deepEqual(errors,[]);console.log('PASS: defaults off, independent save/reopen, keyboard toggle, 1280/390/640 widths and English');
}finally{await browser.close();await server.close();}
