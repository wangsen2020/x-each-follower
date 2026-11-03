import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output='C:/jtmp/xf-account-state-ui';await fs.mkdir(output,{recursive:true});
const extension=path.join(output,'extension-'+Date.now());await fs.cp(path.resolve('scratch/build-tests/account-state'),extension,{recursive:true});
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
const checks=[],errors=[];
try{
 const x=await browser.newPage();await x.setRequestInterception(true);
 x.on('request',r=>{if(r.isNavigationRequest())void r.respond({status:200,contentType:'text/html',body:'<!doctype html><title>Account fixture</title><a data-testid="AppTabBar_Profile_Link" href="/owner">Owner</a>'});else void r.abort();});
 await x.goto('https://x.com/home');
 const control=await browser.target().createCDPSession();const {id}=await control.send('Extensions.loadUnpacked',{path:extension});
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1280,height:900});await page.goto(`chrome-extension://${id}/panel.html`);
 await page.waitForSelector('.sidebar-account-refresh');
 await page.evaluate(async()=>{
  await chrome.storage.local.set({followQueueBinding:{activated:true,accountId:'123',handle:'owner',sources:{}},'followQueueReviewSettings:123':{automation:{review:{enabled:false},verify:{enabled:false}}}});
  const result=await chrome.runtime.sendMessage({cmd:'accountState',force:true});if(result.account?.id!=='123')throw Error(JSON.stringify(result));
 });
 await page.waitForFunction(()=>document.querySelector('.sidebar-account')?.innerText.includes('owner'));
 const initial=await page.evaluate(async()=>({state:await chrome.runtime.sendMessage({cmd:'accountState'}),alarm:await chrome.alarms.get('x-account-state')}));
 assert.equal(initial.alarm.periodInMinutes,1);assert.equal(initial.state.account.id,'123');checks.push('account module publishes binding-matched ID and creates one-minute schedule');
 await x.evaluate(()=>document.querySelector('a').remove());
 const retained=await page.evaluate(()=>chrome.runtime.sendMessage({cmd:'accountState',force:true}));assert.equal(retained.account.id,'123');assert.equal(retained.status,'retrying');
 assert.ok(await page.$eval('.sidebar-account',e=>e.innerText.includes('owner')));checks.push('missing X sidebar retains confirmed account and visible account card');
 const before=retained.lastAttemptAt;
 const repeat=await page.evaluate(async()=>Promise.all(Array.from({length:20},()=>chrome.runtime.sendMessage({cmd:'accountState'}))));assert.ok(repeat.every(r=>r.lastAttemptAt===before));checks.push('twenty consumers read the same snapshot without refreshing');
 const worlds=await page.evaluate(async()=>{const tab=(await chrome.tabs.query({url:'https://x.com/*'}))[0];return await Promise.all(['ISOLATED','MAIN'].map(world=>chrome.scripting.executeScript({target:{tabId:tab.id},world,func:()=>globalThis.__xfAccountSnapshot?.account?.id})));});assert.ok(worlds.every(r=>r[0].result==='123'));checks.push('central snapshot reaches both page execution worlds');
 await page.evaluate(async()=>{
  await chrome.storage.local.set({'followQueueFanReviewBatch:123':{id:'account-state-fixture',accountId:'123',action:'analyze',stage:'paused',total:2,completed:2,nextIndex:2,items:[],results:[{handle:'changed_row',status:'skipped',reason:'该账号资料已更新或清理，本条跳过并继续处理其他账号',tags:[]},{handle:'remaining_row',status:'pass',reason:'审核通过并加入待回关',tags:['AI/科技']}],startedAt:Date.now(),updatedAt:Date.now()}});
 });
 await page.reload();await page.waitForSelector('.sidebar-account-refresh');
 await page.evaluate(()=>document.querySelector('[data-tab="monitor"]')?.click());
 await page.waitForFunction(()=>document.body.innerText.includes('AI 审核 · 已暂停'),{timeout:20000});
 await page.evaluate(async()=>{const key='followQueueFanReviewBatch:123',data=await chrome.storage.local.get(key);await chrome.storage.local.set({[key]:{...data[key],stage:'completed'}});document.dispatchEvent(new CustomEvent('xfollower:follow-review-settings-updated'));});
 await page.waitForFunction(()=>document.body.innerText.includes('AI 审核 · 已完成'),{timeout:20000});
 await page.evaluate(()=>document.querySelector('.result-notice-card details')?.setAttribute('open',''));
 for(const width of [1280,640]){
  await page.setViewport({width,height:900});await page.screenshot({path:`${output}/account-review-${width}.png`});
  const card=await page.$eval('.result-notice-card',e=>({text:e.innerText,overflow:e.scrollWidth>e.clientWidth+1}));
  assert.equal(card.overflow,false);assert.ok(!card.text.includes('身份'));assert.ok(card.text.includes('2/2')||card.text.includes('2 / 2'));
 }
 checks.push('completed review card displays progress and item results at desktop and narrow width');
 assert.deepEqual(errors,[]);await fs.writeFile(output+'/acceptance.json',JSON.stringify({version:'4.27.0',checks,errors},null,2));console.log(JSON.stringify({checks,errors}));
}finally{await browser.close();}
