import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output='C:/jtmp/xf-verification-state-ui';await fs.mkdir(output,{recursive:true});
const extension=path.join(output,'extension-'+Date.now());await fs.cp(path.resolve('scratch/build-tests/verification-state'),extension,{recursive:true});
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
const errors=[];
try{
 const offline=await browser.newPage();await offline.setRequestInterception(true);offline.on('request',r=>{if(r.isNavigationRequest())void r.respond({status:200,contentType:'text/html',body:'<!doctype html><title>Offline fixture</title>'});else void r.abort();});await offline.goto('https://x.com/home');
 const control=await browser.target().createCDPSession();const {id}=await control.send('Extensions.loadUnpacked',{path:extension});
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 // Only the read-only status transport is mocked; the real panel renderer,
 // progress reporter and result components process both lifecycle states.
 await page.evaluateOnNewDocument(()=>{
  if(location.protocol!=='chrome-extension:')return;
  const send=chrome.runtime.sendMessage.bind(chrome.runtime);let reads=0;
  chrome.runtime.sendMessage=(message,...args)=>{
   if(message.cmd!=='followQueueFanBatchStatus')return send(message,...args);
   reads++;globalThis.__fixtureReads=reads;return Promise.resolve({ok:true,batch:{id:'verification-ui',accountId:'fixture',stage:reads===1?'running':'completed',nextIndex:reads===1?0:2,handles:['ready_user','waiting_user'],results:reads===1?[]:[
    {handle:'ready_user',status:'verified',relationship:{following:false,followedBy:true},profileCollection:{profile:'saved',posts:'cached'},reviewTransition:{state:'review',ready:true,reason:'资料已就绪'}},
    {handle:'waiting_user',status:'verified',relationship:{following:false,followedBy:true},profileCollection:{profile:'saved',posts:'pending'},reviewTransition:{state:'verify',ready:false,reason:'帖子待补采'}}]}});
  };
 });
 await page.setViewport({width:1280,height:900});await page.goto(`chrome-extension://${id}/panel.html`);
 await page.waitForFunction(()=>document.querySelector('.result-notice-card')?.innerText.includes('粉丝核验 · 已完成'),{timeout:7000}).catch(async error=>{console.log(JSON.stringify({errors,state:await page.evaluate(()=>({reads:globalThis.__fixtureReads,text:document.body.innerText.slice(-1600)}))}));throw error;});
 await page.evaluate(()=>document.querySelector('.result-notice-card details')?.setAttribute('open',''));
 for(const width of [1280,640]){
  await page.setViewport({width,height:900});await page.screenshot({path:`${output}/verification-${width}.png`});
  const result=await page.$eval('.result-notice-card',e=>({text:e.innerText,overflow:e.scrollWidth>e.clientWidth+1}));
  assert.match(result.text,/已退回待审核/);assert.match(result.text,/仍待核实/);assert.match(result.text,/帖子待补采/);assert.equal(result.overflow,false);
 }
 assert.deepEqual(errors,[]);await fs.writeFile(output+'/acceptance.json',JSON.stringify({version:'4.27.1',transport:'read-only fixture',widths:[1280,640],errors}));console.log('Verification transition UI passed at 1280 and 640 pixels.');
}finally{await browser.close();}
