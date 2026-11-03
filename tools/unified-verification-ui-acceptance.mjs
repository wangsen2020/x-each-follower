import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output='C:/jtmp/xf-unified-verification-acceptance';await fs.mkdir(output,{recursive:true});
const extension=path.join(output,'extension-'+Date.now());await fs.cp(path.resolve(process.argv[2]||'scratch/build-tests/unified-verification'),extension,{recursive:true});
await fs.writeFile(path.join(extension,'test-bootstrap.html'),'<!doctype html><title>Offline test bootstrap</title>');
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
 ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-gpu','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
let page;const checks=[];
try{
 const offline=await browser.newPage();await offline.setRequestInterception(true);offline.on('request',r=>{if(r.isNavigationRequest()&&r.url()==='https://x.com/home')void r.respond({status:200,contentType:'text/html',body:'<!doctype html><title>Offline fixture</title>'});else void r.abort();});await offline.goto('https://x.com/home');
 const control=await browser.target().createCDPSession();const {id}=await control.send('Extensions.loadUnpacked',{path:extension});
 const bootstrap=await browser.newPage();await bootstrap.goto(`chrome-extension://${id}/test-bootstrap.html`);
 const seed=await bootstrap.evaluate(async()=>{
  const migrate=await chrome.runtime.sendMessage({cmd:'recordData',op:'migrate'});if(!migrate.ok)throw Error(migrate.error);
  await chrome.storage.local.set({followQueueBinding:{activated:true,accountId:'1',handle:'offline_owner',sources:{}}});
  return chrome.runtime.sendMessage({cmd:'recordData',op:'batch',sourceKey:'monitor',changes:Array.from({length:24},(_,i)=>({accountId:'unassigned',handle:'fixture_'+i,sourceBucket:'users',create:true,patch:{accountId:'unassigned',id:String(100+i),targetUserId:String(100+i),handle:'fixture_'+i,name:'Fixture '+i,bio:'Isolated verification fixture',followersText:'100',followingText:'120',status:i<12?'unknown':'followed',state:i<12?'unknown':'following',relationshipKnown:i>=12,...(i>=12?{relationshipVerifiedAt:new Date().toISOString(),relationship:{following:true,followedBy:false}}:{})}}))});
 });assert.equal(seed.ok,true);
 page=await browser.newPage();await page.setViewport({width:1400,height:1000});
 // Only this isolated tab replaces task messages. The actual built panel,
 // navigation, record service and buttons run normally; X/AI are never called.
 await page.evaluateOnNewDocument(()=>{
  const original=chrome.runtime.sendMessage.bind(chrome.runtime),state={batch:null,calls:[],jobs:Array.from({length:3},(_,i)=>({id:'q'+i,handle:'queue_'+i,state:'uncertain',sources:[]})),pending:null};window.inspectionFixture=state;
  globalThis.confirm=()=>true;
  state.completeOne=()=>{const p=state.pending;if(!p)throw Error('No pending test request');state.pending=null;const failed=p.message.jobId==='q1';if(!failed)state.jobs=state.jobs.map(j=>j.id===p.message.jobId?{...j,state:'followed'}:j);p.resolve(failed?{ok:false,error:'无法读取关系'}:{ok:true});};
  chrome.runtime.sendMessage=(m,...args)=>{
   if(m.cmd==='followQueueFanProfileStatus'&&state.slowCache)return Promise.resolve({ok:true,accountId:'1',handle:'offline_owner',page:1,pages:1,total:0,items:[],summary:{pending:0,succeeded:0,failed:0,total:0,loadingCache:true}});
   if(m.cmd==='followQueueIdentity')return Promise.resolve({ok:true,accountId:'1',handle:'offline_owner',binding:{activated:true,accountId:'1',sources:{}}});
   if(m.cmd==='followQueueSettings')return Promise.resolve({ok:true,settings:{enabled:false}});
   if(m.cmd==='followQueueList')return Promise.resolve({ok:true,jobs:structuredClone(state.jobs),summary:{running:false,isPaused:true}});
   if(m.cmd==='followQueueVerify'){state.calls.push(structuredClone(m));return new Promise(resolve=>state.pending={message:m,resolve});}

   if(m.cmd?.startsWith('followQueueFanBatch')){
    state.calls.push(structuredClone(m));
    if(m.cmd==='followQueueFanBatchStart')state.batch={id:'isolated-batch',stage:'running',scope:m.scope,handles:m.handles,nextIndex:0,results:[],currentHandle:m.handles[0],reason:''};
    if(m.cmd==='followQueueFanBatchStop')state.batch={...state.batch,stage:'paused',nextIndex:1,results:[{handle:state.batch.handles[0],status:'verified'}],currentHandle:'',reason:'已停止后续核验'};
    if(m.cmd==='followQueueFanBatchResume')state.batch={...state.batch,stage:'running',currentHandle:state.batch.handles[1],reason:''};
    return Promise.resolve({ok:true,batch:state.batch?structuredClone(state.batch):null});
   }
   return original(m,...args);
  };
 });
 await page.goto(`chrome-extension://${id}/panel.html`);const wait=f=>page.waitForFunction(f,{polling:100,timeout:15000});
 const click=s=>page.$eval(s,e=>e.click());
 await wait(()=>document.querySelectorAll('#monitorList input[data-fan-handle]').length>2);
 await page.evaluate(()=>inspectionFixture.slowCache=true);await click('#openFanProfileQueue');
 await wait(()=>document.querySelector('.queue-schedule')?.textContent.includes('正在读取已有采集记录'));
 assert.match(await page.$eval('.queue-overview',e=>e.textContent),/…/);assert.ok(!await page.$('.queue-progress'));
 assert.ok(!await page.$eval('.queue-empty',e=>e.textContent.includes('暂无补采任务')));
 await page.screenshot({path:output+'/post-queue-reading-history.png'});await page.keyboard.press('Escape');await page.evaluate(()=>inspectionFixture.slowCache=false);
 checks.push('slow archive loading is visible and never masquerades as zero jobs or completed progress');
 const fanCard='.result-notice-card[data-result-key="inspection:isolated-batch"]';
 await click('[data-follower-tab="fanUnknown"]');await wait(()=>document.querySelectorAll('#monitorList input[data-fan-handle]').length>2&&[...document.querySelectorAll('#monitorList input[data-fan-handle]')].every(i=>Number(i.dataset.fanHandle.split('_')[1])<12));
 await wait(()=>!document.querySelector('#monitorList input[data-fan-handle]').disabled);
 const selected=await page.$$eval('#monitorList input[data-fan-handle]',inputs=>inputs.slice(0,3).map(i=>i.dataset.fanHandle));
 for(const handle of selected)await page.click('#monitorList input[data-fan-handle="'+handle+'"]');
 await click('#batchInspectFans');await page.waitForSelector(fanCard);
 await wait(()=>document.querySelectorAll('#monitorList input:checked').length===3);
 assert.ok(await page.$$eval('#monitorList input',inputs=>inputs.every(i=>i.disabled)));checks.push('fan pending-verification selection remains checked and disabled during verification');
 assert.ok(await page.$$eval('#monitorList [data-fan-inspect-handle]',buttons=>buttons.length>0&&buttons.every(b=>b.disabled)));
 await page.screenshot({path:output+'/fans-unknown-running.png'});
 const frozen=await page.evaluate(()=>inspectionFixture.batch.handles);assert.equal(frozen.length,3);
 await click('[data-follower-tab="fanPending"]');await page.type('#followerSearch','different-view');await click('#followerSearchBtn');await page.select('#followerPageSize','50');await click('[data-tab="candidates"]');
 assert.deepEqual(await page.evaluate(()=>inspectionFixture.batch.handles),frozen);assert.equal(await page.evaluate(()=>inspectionFixture.calls.some(m=>m.cmd==='followQueueFanBatchCancel')),false);
 await page.focus(fanCard+' [aria-label="停止后续"]');await wait(()=>!!document.querySelector('[role="tooltip"]'));
 await page.screenshot({path:output+'/fans-running-desktop.png'});checks.push('frozen fan batch and shared floating stop remain available across views');
 await click(fanCard+' [aria-label="停止后续"]');await page.waitForSelector(fanCard+'[data-task-stage="paused"]');
 await click(fanCard+' [aria-label="继续核验"]');await page.waitForSelector(fanCard+'[data-task-stage="running"]');
 await page.evaluate(()=>{const b=inspectionFixture.batch;b.stage='completed';b.nextIndex=3;b.currentHandle='';b.results=b.handles.map(handle=>({handle,status:'verified'}));});
 await page.waitForSelector(fanCard+'[data-task-stage="completed"]');await new Promise(r=>setTimeout(r,3300));assert.ok(await page.$(fanCard));
 assert.equal(await page.$$eval(fanCard,c=>c.length),1);await click(fanCard+' [aria-label="关闭结果"]');await wait(()=>!document.querySelector('.result-notice-card'));checks.push('one live fan card updates in place, pauses/resumes, and persists after completion until closed');
 await click('[data-tab="followQueue"]');await wait(()=>document.querySelectorAll('#followQueueContent .fq-filter-tab').length>0);
 await page.$$eval('#followQueueContent .fq-filter-tab',buttons=>buttons.find(b=>b.textContent==='待核实').click());
 await page.click('#followQueueContent thead input');
 await page.$$eval('#followQueueContent button',buttons=>buttons.find(b=>b.getAttribute('aria-label')==='批量核对').click());await wait(()=>!!inspectionFixture.pending);
 const queueCard='.result-notice-card[data-result-key^="queue-verification:"]';await page.waitForSelector(queueCard);
 assert.ok(await page.$$eval('#followQueueContent tbody input',inputs=>inputs.length===3&&inputs.every(i=>i.checked&&i.disabled)));
 assert.equal(await page.$('.fq-batch-toast'),null);checks.push('queue uses the same card and read-only frozen checkboxes');
 await page.screenshot({path:output+'/queue-running-desktop.png'});
 await page.setViewport({width:400,height:800});await page.screenshot({path:output+'/queue-running-narrow.png'});
 assert.ok(await page.$eval(queueCard,e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
 await page.setViewport({width:700,height:500});await page.screenshot({path:output+'/queue-running-equivalent-200.png'});checks.push('shared card layout fits narrow and equivalent 200% width');
 await click('[data-tab="monitor"]');await click('[data-tab="followQueue"]');await wait(()=>!!document.querySelector('#followQueueContent tbody'));
 assert.ok(await page.evaluate(()=>!!inspectionFixture.pending));assert.equal(await page.evaluate(()=>inspectionFixture.calls.filter(m=>m.cmd==='followQueueVerify').length),1);
 await page.$$eval('#followQueueContent .fq-filter-tab',buttons=>buttons.find(b=>b.textContent==='等待重试').click());
 await page.$$eval('#followQueueContent .fq-filter-tab',buttons=>buttons.find(b=>b.textContent==='待核实').click());
 assert.ok(await page.$$eval('#followQueueContent tbody input',inputs=>inputs.length===3&&inputs.every(i=>i.checked&&i.disabled)));checks.push('module re-entry and queue filter changes preserve the same in-flight request');
 await click(queueCard+' [aria-label="停止后续"]');await page.evaluate(()=>inspectionFixture.completeOne());await page.waitForSelector(queueCard+'[data-task-stage="paused"]');
 assert.equal(await page.evaluate(()=>inspectionFixture.calls.filter(m=>m.cmd==='followQueueVerify').length),1);
 await click(queueCard+' [aria-label="继续核验"]');
 for(let i=0;i<2;i++){await wait(()=>!!inspectionFixture.pending);await page.evaluate(()=>inspectionFixture.completeOne());}
 await page.waitForSelector(queueCard+'[data-task-stage="completed"]');
 assert.match(await page.$eval(queueCard,e=>e.textContent),/成功 2/);assert.match(await page.$eval(queueCard,e=>e.textContent),/失败 1/);
 await page.setViewport({width:1400,height:1000});await page.screenshot({path:output+'/queue-completed.png'});
 await new Promise(r=>setTimeout(r,3300));assert.ok(await page.$(queueCard));await click(queueCard+' [aria-label="关闭结果"]');await wait(()=>!document.querySelector('.result-notice-card'));
 checks.push('queue stop/resume continues remaining records, contains failures, and ends in a manually closed result card');
 console.log(JSON.stringify({checks,version:await page.evaluate(()=>chrome.runtime.getManifest().version),output},null,2));
 await fs.writeFile(output+'/checks.json',JSON.stringify({checks},null,2));
}catch(error){if(page){console.log((await page.evaluate(()=>document.body.innerText)).slice(0,1400));await page.screenshot({path:output+'/failure.png'});}throw error;}finally{await browser.close();}
