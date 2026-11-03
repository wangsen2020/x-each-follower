import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const expectedVersion=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const output='C:/jtmp/xf-unified-verification-live-acceptance';await fs.mkdir(output,{recursive:true});
const before=JSON.parse(await fs.readFile('C:/jtmp/xf-unified-verification-deploy/before-private.json','utf8')).snapshot;
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});let control,targetId;
try{
 const userPanel=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().includes('/panel.html'));
 const base=await userPanel.evaluate(()=>chrome.runtime.getURL('panel.html'));
 control=await browser.target().createCDPSession();const created=await control.send('Target.createTarget',{url:base+'?acceptance=unified-'+expectedVersion,background:true});targetId=created.targetId;
 const page=await(await browser.waitForTarget(t=>t._targetId===targetId)).page();const session=await page.createCDPSession();await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});
 await page.setViewport({width:1440,height:1000});await page.waitForSelector('#openFanProfileQueue');
 const state=await page.evaluate(async()=>{
  const open=name=>new Promise((resolve,reject)=>{const q=indexedDB.open(name);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const keys=async(name,store)=>{const db=await open(name);try{return await new Promise((resolve,reject)=>{const q=db.transaction(store).objectStore(store).getAllKeys();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}finally{db.close();}};
  const rows=async(name,store)=>{const db=await open(name);try{return await new Promise((resolve,reject)=>{const q=db.transaction(store).objectStore(store).getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}finally{db.close();}};
  return {manifest:chrome.runtime.getManifest().version,background:await chrome.runtime.sendMessage({cmd:'getBackgroundBuildVersion'}),storage:await chrome.storage.local.get(null),
    queueKeys:await keys('x-each-follower-follow-queue','jobs'),recordKeys:await keys('x-each-follower-records-dashboard','rows'),
    retention:(await chrome.runtime.sendMessage({cmd:'recordData',op:'metadata',key:'monitor'})).metadata?.fanRetentionExclusions||{},
    configs:{queue:await rows('x-each-follower-follow-queue','settings'),bot:await rows('xfollower-grok-bot','connections'),local:await rows('xfollower-grok-local','config'),image:await rows('xfollower-image-connections','connections')}};
 });
 assert.equal(state.manifest,expectedVersion);assert.equal(state.background.version,expectedVersion);
 const key=before.storage['fanInspectionHead:'+before.storage.followQueueBinding.accountId];
 const batchKey='fanInspection:'+before.storage.followQueueBinding.accountId+':'+key;
 for(const field of ['id','stage','nextIndex','handles','results'])assert.deepEqual(state.storage[batchKey]?.[field],before.storage[batchKey]?.[field]);
 assert.deepEqual(state.configs,before.configs);
 for(const key of Object.keys(before.storage).filter(k=>k==='followQueueBinding'||/Settings/.test(k)))assert.deepEqual(state.storage[key],before.storage[key],key);
 const currentQueueKeys=new Set(state.queueKeys.map(k=>JSON.stringify(k))),currentRecordKeys=new Set(state.recordKeys.map(k=>JSON.stringify(k)));
 const changedDuringBackgroundCleanup={removedQueueKeys:before.queueKeys.filter(k=>!currentQueueKeys.has(JSON.stringify(k))).length,removedRecordKeys:before.recordKeys.filter(k=>!currentRecordKeys.has(JSON.stringify(k))).length};
 await page.$eval('#openFanProfileQueue',e=>e.click());
 await page.waitForFunction(()=>document.querySelectorAll('.queue-items li').length>0,{timeout:30000,polling:100});
 await page.screenshot({path:output+'/live-post-queue-reading.png'});
 await page.waitForFunction(()=>document.querySelector('.queue-overview')&&!document.querySelector('.queue-overview').textContent.includes('…'),{timeout:240000,polling:1000});
 const queue=await page.evaluate(()=>chrome.runtime.sendMessage({cmd:'followQueueFanProfileStatus'}));assert.equal(queue.ok,true);assert.ok(queue.total>0);
 const sample=[];
 for(let pageNumber=1;pageNumber<=queue.pages&&sample.length<3;pageNumber++){
  const result=pageNumber===1?queue:await page.evaluate(page=>chrome.runtime.sendMessage({cmd:'followQueueFanProfileStatus',page}),pageNumber);
  sample.push(...result.items.filter(i=>i.source==='profile-cache').slice(0,3-sample.length));
 }
 assert.ok(sample.length>0);assert.ok(sample.every(i=>i.attempts===null));
 const profiles=await page.evaluate(handles=>chrome.runtime.sendMessage({cmd:'recordData',op:'profiles',handles}),sample.map(i=>i.handle));
 for(const item of sample){const profile=profiles.profiles.find(p=>p.handle===item.handle).payload;assert.equal(item.count,profile.fanInspectionTimeline.count??profile.fanInspectionTimeline.posts?.length??0);assert.equal(item.status,profile.fanInspectionTimeline.status);}
 await page.screenshot({path:output+'/live-post-queue.png'});
 await page.keyboard.press('Escape');await page.reload();await page.waitForSelector('#openFanProfileQueue');await page.$eval('#openFanProfileQueue',e=>e.click());
 await page.waitForFunction(()=>document.querySelectorAll('.queue-items li').length>0,{timeout:30000,polling:100});
 const reopened=await page.evaluate(()=>chrome.runtime.sendMessage({cmd:'followQueueFanProfileStatus'}));assert.ok(reopened.total>0);
 const result={version:state.manifest,background:state.background.version,owner:queue.handle,total:queue.total,summary:queue.summary,
   samples:sample.map(i=>({handle:i.handle,status:i.status,count:i.count})),pausedBatch:{stage:state.storage[batchKey].stage,processed:state.storage[batchKey].nextIndex,total:state.storage[batchKey].handles.length},
   preserved:{queueRecords:before.queueKeys.length,recordRowsCompared:before.recordKeys.length,concurrentCleanup:changedDuringBackgroundCleanup,settings:true,aiConnections:true},refreshReopen:true};
 await fs.writeFile(output+'/live-checks.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(targetId)await control.send('Target.closeTarget',{targetId});browser.disconnect();}
