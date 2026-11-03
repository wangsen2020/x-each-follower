import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const folder='C:/jtmp/xf-ai-connection-state';await fs.mkdir(folder,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),plugins:[vue()],server:{host:'127.0.0.1',port:5188,strictPort:true}});await server.listen();
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5188/tests/fixtures/ai-connection-preview.html');await page.waitForSelector('.ai-connection-notice');
 const initial=await page.$eval('.ai-connection-actions span',e=>e.textContent);await new Promise(r=>setTimeout(r,1200));assert.notEqual(await page.$eval('.ai-connection-actions span',e=>e.textContent),initial);
 for(const[width,height,lang]of [[1280,900,'zh-CN'],[390,844,'zh-CN'],[640,450,'zh-CN'],[390,844,'en']]){
  await page.setViewport({width,height});await page.evaluate(l=>__aiFixture.locale(l),lang);await new Promise(r=>setTimeout(r,100));
  assert.ok(await page.$eval('.ai-connection-notice',e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
  await page.screenshot({path:`${folder}/notice-${width}-${lang}.png`});
 }
 await page.evaluate(()=>__aiFixture.locale('zh-CN'));await page.click('[aria-label="收起提醒"]');assert.equal(await page.$('.ai-connection-notice'),null);
 await page.focus('#settings');await page.waitForSelector('.ai-connection-notice');
 await page.focus('[aria-label="重试 AI 连接"]');await page.keyboard.press('Enter');await page.waitForFunction(()=>__aiFixture.retries===1);await page.waitForFunction(()=>!document.querySelector('.ai-connection-notice'));
 await page.waitForFunction(()=>document.querySelector('.review-config-status')?.dataset.state==='ready');
 assert.equal(await page.$('.ai-connection-dot'),null);assert.equal(await page.$('.review-config-status [aria-label="重新检测"]'),null);
 assert.deepEqual(errors,[]);await fs.writeFile(folder+'/ui.json',JSON.stringify({passed:true,widths:[1280,390,640],countdown:true,retryRecovery:true,statusPropagation:true,errors},null,2));console.log('PASS: countdown, retry, recovery propagation, dismiss/reopen, keyboard, narrow viewport and equivalent zoom');
}finally{await browser.close();await server.close();}
