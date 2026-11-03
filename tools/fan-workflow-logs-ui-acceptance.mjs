import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output='C:/jtmp/xf-fan-logs-ui';await fs.mkdir(output,{recursive:true});
const extension=path.join(output,'extension-'+Date.now());await fs.cp(path.resolve('scratch/build-tests/fan-logs'),extension,{recursive:true});
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
const errors=[],checks=[];let confirmations=0;
try{
 const offline=await browser.newPage();await offline.setRequestInterception(true);
 offline.on('request',r=>{if(r.isNavigationRequest()&&r.url()==='https://x.com/home')void r.respond({status:200,contentType:'text/html',body:'<!doctype html><title>Offline log fixture</title>'});else void r.abort();});await offline.goto('https://x.com/home');
 const control=await browser.target().createCDPSession();const {id}=await control.send('Extensions.loadUnpacked',{path:extension});
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{confirmations++;return d.accept();});
 await page.setViewport({width:1280,height:900});await page.goto(`chrome-extension://${id}/panel.html`);
 await page.waitForFunction(()=>!!window.__executionLogsModalController);
 await page.evaluate(async()=>{
  await chrome.storage.local.set({autoFollowLogs:[],monitorLogs:[],unreciprocatedLogs:[]});
  for(const scope of ['fanReview','fanVerify','fanSchedule'])for(let n=0;n<35;n++){
   const result=await chrome.runtime.sendMessage({cmd:'appendExecutionLog',entry:{id:`fixture-${scope}-${n}`,scope,accountId:'fixture-owner',source:n%2?'scheduled':'manual',batchId:'fixture-batch',kind:'verify',
    ...(scope==='fanSchedule'?{total:5,completed:3,nextAt:Date.now()+120000}:{handle:'sample_'+n,tags:['AI/科技'],executionStatus:scope==='fanReview'&&n%3===1?'removed':''}),
    result:scope==='fanReview'?['pass','rejected','uncertain'][n%3]:scope==='fanVerify'?'ready':'manual',detail:scope==='fanSchedule'?'等待手动任务结束，下一次检查会继续处理。':'测试资料已处理；不会因技术异常直接判定账号不通过。',at:new Date(Date.now()+n).toISOString()}});if(!result.ok)throw Error(result.error);
  }
  // Exercise the real checkpoint listener without running any X/AI operations.
  await chrome.storage.local.set({'followQueueFanReviewBatch:fixture-owner':{id:'observer-test',accountId:'fixture-owner',automatic:true,stage:'completed',results:[{handle:'observed_account',status:'pass',reason:'由检查点写入的日志'}]}});
 });
 await page.click('#openFollowLogs');
 await page.waitForSelector('#logsModal:not([hidden])');
 assert.equal(await page.$$eval('#logsModal .logs-modal-subtabs .subtab-btn',es=>es.length),5);
 const click=id=>page.$eval(id,e=>e.click());
 await click('#subtabFansReview');await page.waitForFunction(()=>document.querySelector('#logsList')?.innerText.includes('observed_account'));
 assert.ok(await page.$eval('#logsList',e=>e.innerText.includes('审核通过')));checks.push('real persisted review checkpoint reaches indexed log tab');
 await click('#logsNextBtn');await page.waitForFunction(()=>!document.querySelector('#logsPrevBtn').disabled);
 assert.ok(await page.$eval('#logsList',e=>!e.innerText.includes('observed_account')));checks.push('category pagination displays the next page');
 await click('#subtabFansVerify');await page.waitForFunction(()=>document.querySelector('#logsList').innerText.includes('资料就绪'));
 assert.equal(await page.$eval('#logsPrevBtn',e=>e.disabled),true);checks.push('switching category resets page cursor');
 await click('#subtabFansSchedule');await page.waitForFunction(()=>document.querySelector('#logsList').innerText.includes('等待手动任务结束'));
 for(const width of [1280,640,390]){
  await page.setViewport({width,height:900});await page.screenshot({path:`${output}/schedule-${width}.png`});
  const layout=await page.evaluate(()=>{const modal=document.querySelector('#logsModal');return {overflow:modal.scrollWidth>modal.clientWidth+1,windowOverflow:document.documentElement.scrollWidth>innerWidth};});assert.deepEqual(layout,{overflow:false,windowOverflow:false});
 }
 checks.push('three viewport widths keep controls and cards within modal');
 await page.setViewport({width:1280,height:900});await click('#subtabFansReview');await page.waitForFunction(()=>document.querySelector('#logsList').innerText.includes('observed_account'));
 await page.screenshot({path:`output/review.png`.replace('output',output)});
 await click('#clearLogsBtn');await page.waitForFunction(()=>document.querySelector('#logsEmpty')?.hidden===false);
 assert.equal(await page.evaluate(async()=>(await chrome.runtime.sendMessage({cmd:'queryExecutionLogs',scope:'fanVerify'})).total),35);
 assert.equal(confirmations,1);checks.push('clearing review logs confirms once, preserves verification logs and renders empty state');
 assert.deepEqual(errors,[]);await fs.writeFile(output+'/acceptance.json',JSON.stringify({version:'4.26.1',checks,errors},null,2));console.log(JSON.stringify({checks,errors}));
}finally{await browser.close();}
