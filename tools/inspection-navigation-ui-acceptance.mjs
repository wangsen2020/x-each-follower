import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output='C:/jtmp/xf-inspection-navigation-acceptance';await fs.mkdir(output,{recursive:true});
const extension=path.join(output,'extension-'+Date.now());await fs.cp(path.resolve('dist'),extension,{recursive:true});
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
  return chrome.runtime.sendMessage({cmd:'recordData',op:'batch',sourceKey:'monitor',changes:Array.from({length:24},(_,i)=>({accountId:'unassigned',handle:'fixture_'+i,sourceBucket:'users',create:true,patch:{accountId:'unassigned',id:String(100+i),targetUserId:String(100+i),handle:'fixture_'+i,name:'Fixture '+i,bio:'Isolated verification fixture',followersText:'100',followingText:'120',status:'followed',state:'following',relationshipKnown:true,relationshipVerifiedAt:new Date().toISOString(),relationship:{following:true,followedBy:false}}}))});
 });assert.equal(seed.ok,true);
 page=await browser.newPage();await page.setViewport({width:1400,height:1000});
 // Only this isolated tab replaces task messages. The actual built panel,
 // navigation, record service and buttons run normally; X/AI are never called.
 await page.evaluateOnNewDocument(()=>{
  const original=chrome.runtime.sendMessage.bind(chrome.runtime),state={batch:null,calls:[]};window.inspectionFixture=state;
  chrome.runtime.sendMessage=(m,...args)=>{
   if(m.cmd?.startsWith('followQueueFanBatch')){
    state.calls.push(structuredClone(m));
    if(m.cmd==='followQueueFanBatchStart')state.batch={id:'isolated-batch',stage:'running',scope:m.scope,handles:m.handles,nextIndex:0,results:[],currentHandle:m.handles[0],reason:''};
    if(m.cmd==='followQueueFanBatchStop')state.batch={...state.batch,stage:'paused',nextIndex:1,currentHandle:'',reason:'已停止后续核验'};
    if(m.cmd==='followQueueFanBatchResume')state.batch={...state.batch,stage:'running',currentHandle:state.batch.handles[1],reason:''};
    return Promise.resolve({ok:true,batch:state.batch?structuredClone(state.batch):null});
   }
   return original(m,...args);
  };
 });
 await page.goto(`chrome-extension://${id}/panel.html`);const wait=f=>page.waitForFunction(f,{polling:100,timeout:15000});
 const click=s=>page.$eval(s,e=>e.click());
 await wait(()=>document.querySelectorAll('#monitorList input[data-fan-handle]').length>2);
 await wait(()=>!document.querySelector('#monitorList input[data-fan-handle]').disabled);
 const selected=await page.$$eval('#monitorList input[data-fan-handle]',inputs=>inputs.slice(0,3).map(i=>i.dataset.fanHandle));
 for(const handle of selected)await page.click(`#monitorList input[data-fan-handle="${handle}"]`);
 await wait(()=>!document.querySelector('#batchInspectFans').disabled);await click('#batchInspectFans');
 await wait(()=>!document.querySelector('#stopFanInspection').hidden);const frozen=await page.evaluate(()=>inspectionFixture.batch.handles);
 assert.equal(frozen.length,3);checks.push('real built selection freezes three accounts');
 await click('[data-follower-tab="fanPending"]');await page.type('#followerSearch','different-view');await click('#followerSearchBtn');
 await page.select('#followerPageSize','50');await click('[data-tab="candidates"]');
 assert.deepEqual(await page.evaluate(()=>inspectionFixture.batch.handles),frozen);
 assert.equal(await page.evaluate(()=>inspectionFixture.calls.some(m=>m.cmd==='followQueueFanBatchCancel')),false);
 assert.equal(await page.$eval('#stopFanInspection',e=>e.checkVisibility()),true);checks.push('category, search, pagination size and module changes keep batch and global stop');
 await page.focus('#stopFanInspection');await wait(()=>document.querySelector('[role="tooltip"]')?.textContent.includes('当前账号'));
 await page.screenshot({path:output+'/global-stop-desktop.png'});checks.push('keyboard-readable stop explanation');
 await page.setViewport({width:400,height:800});await page.screenshot({path:output+'/global-stop-narrow.png'});
 assert.ok(await page.$eval('#stopFanInspection',e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
 await page.setViewport({width:700,height:500});await page.screenshot({path:output+'/global-stop-equivalent-200.png'});checks.push('400px and equivalent 200% global progress layouts');
 await click('#stopFanInspection');await wait(()=>!document.querySelector('#resumeFanInspection').hidden);assert.equal(await page.evaluate(()=>inspectionFixture.batch.nextIndex),1);
 await click('#resumeFanInspection');await wait(()=>!document.querySelector('#stopFanInspection').hidden);assert.deepEqual(await page.evaluate(()=>inspectionFixture.batch.handles),frozen);checks.push('explicit stop and resume preserve frozen targets and progress');
 await page.evaluate(()=>{inspectionFixture.batch.stage='completed';inspectionFixture.batch.nextIndex=3;inspectionFixture.batch.currentHandle='';});
 await wait(()=>document.querySelector('#fanInspectionProgress').hidden);checks.push('completion removes global progress without blank header');
 console.log(JSON.stringify({checks,version:await page.evaluate(()=>chrome.runtime.getManifest().version),output},null,2));
 await fs.writeFile(output+'/checks.json',JSON.stringify({checks},null,2));
}catch(error){if(page){console.log((await page.evaluate(()=>document.body.innerText)).slice(0,1400));await page.screenshot({path:output+'/failure.png'});}throw error;}finally{await browser.close();}
