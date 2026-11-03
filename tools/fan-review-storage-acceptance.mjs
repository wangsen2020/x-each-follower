import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import assert from 'node:assert/strict';

// Restores a read-only live snapshot only into a new test-owned Chrome profile.
// Source snapshot files and the authenticated CDP profile are never modified.
const root=path.resolve(import.meta.dirname,'..');
const snapshot=path.resolve(process.argv[2]||'C:/jtmp/xf-fan-review-implementation/live-data-before');
const output=path.join(root,'artifacts/fan-review-storage-acceptance');
const fixtureDist=path.join(output,'extension');
await fs.mkdir(fixtureDist,{recursive:true});
await fs.cp(path.join(root,'dist'),fixtureDist,{recursive:true});
await fs.writeFile(path.join(fixtureDist,'acceptance-bootstrap.html'),'<title>Isolated extension data acceptance</title>');
const schema=JSON.parse(await fs.readFile(path.join(snapshot,'schemas.json'),'utf8'));
const manifest=JSON.parse(await fs.readFile(path.join(snapshot,'manifest.json'),'utf8'));
const browser=await puppeteer.launch({
  executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless:true,userDataDir:path.join(output,'profile-'+Date.now()),
  ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-gpu',
    '--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']
});
assert.ok(browser.process(),'Storage acceptance must own its isolated browser process');
const session=await browser.target().createCDPSession();
const records=[],beforeKeys=new Set(),sourceKeys=new Set(),successfulJobs=new Map();
let bootstrap;
async function message(page,payload){return page.evaluate(payload=>chrome.runtime.sendMessage(payload),payload);}
async function readRows(file,consume){
  const reader=createInterface({input:createReadStream(file),crlfDelay:Infinity});
  let chunk=[];
  for await(const line of reader){if(!line.trim())continue;chunk.push(JSON.parse(line));if(chunk.length===50){await consume(chunk);chunk=[];}}
  if(chunk.length)await consume(chunk);
}
async function storeValues(page,name,store){
  return page.evaluate(async(name,store)=>{
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(name);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    try{return await new Promise((resolve,reject)=>{const q=db.transaction(store,'readonly').objectStore(store).getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}
    finally{db.close();}
  },name,store);
}
try{
  // The project's durable journal is stored under the X origin. Supply an
  // entirely offline, test-owned origin document so the real storage bridge
  // works while every external request remains blocked and no login exists.
  const offlineX=await browser.newPage();
  await offlineX.setRequestInterception(true);
  offlineX.on('request',request=>{
    if(request.isNavigationRequest() && request.url()==='https://x.com/home') {
      void request.respond({status:200,contentType:'text/html',body:'<!doctype html><title>Offline storage acceptance fixture</title><p>Test-owned X-origin storage only.</p>'});
    }else void request.abort();
  });
  await offlineX.goto('https://x.com/home');
  const loaded=await session.send('Extensions.loadUnpacked',{path:fixtureDist});
  const origin='chrome-extension://'+loaded.id;
  bootstrap=await browser.newPage();await bootstrap.goto(origin+'/acceptance-bootstrap.html');
  const workerControl=await bootstrap.createCDPSession();
  await workerControl.send('ServiceWorker.enable');
  assert.equal(await bootstrap.evaluate(()=>chrome.runtime.id),loaded.id);
  await bootstrap.evaluate(async(binding)=>{
    await chrome.storage.local.set({followQueueBinding:{...binding,activated:false,sources:{comments:false,fans:false,mutual:false}}});
    await chrome.alarms.clearAll();
  },manifest.binding);
  for(const [name,descriptor]of Object.entries(schema)){
    await bootstrap.evaluate(async(name,descriptor)=>{
      const db=await new Promise((resolve,reject)=>{
        const q=indexedDB.open(name,descriptor.version);
        q.onupgradeneeded=()=>{for(const [table,spec]of Object.entries(descriptor.stores)){
          if(q.result.objectStoreNames.contains(table))continue;
          const store=q.result.createObjectStore(table,{keyPath:spec.keyPath,autoIncrement:spec.autoIncrement});
          for(const index of spec.indexes)store.createIndex(index.name,index.keyPath,{unique:index.unique,multiEntry:index.multiEntry});
        }};
        q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
      });
      db.close();
    },name,descriptor);
    for(const store of Object.keys(descriptor.stores)){
      const file=path.join(snapshot,name+'--'+store+'.jsonl');
      if(!await fs.stat(file).catch(()=>null))continue;
      let count=0;
      await readRows(file,async rows=>{
        for(const row of rows){
          if(store==='rows'&&row.sourceKey==='monitor')beforeKeys.add(JSON.stringify([row.accountId,row.module,row.userKey]));
          if(store==='rows'&&!String(row.sourceKey).startsWith('derived:'))sourceKeys.add(JSON.stringify([row.accountId,row.module,row.userKey]));
          if(store==='jobs'&&row.followResult?.succeeded)successfulJobs.set(row.id,JSON.stringify(row.followResult));
          // Keep every record/history; disable only test-profile automation controls.
          if(store==='settings')row.enabled=false;
          if(store==='state'&&row.metadata)for(const key of ['monitor','mutualNetwork','commentTracking','unreciprocatedTracker']){
            const value=row.metadata[key];if(value){value.enabled=false;if(value.autoFollow)value.autoFollow.enabled=false;if(value.config)value.config.enabled=false;}
          }
        }
        await bootstrap.evaluate(async(name,store,rows)=>{
          const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(name);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
          try{await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');for(const row of rows)tx.objectStore(store).put(row);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
          finally{db.close();}
        },name,store,rows);
        count+=rows.length;
      });
      records.push({name,store,restored:count});console.log(JSON.stringify({restored:store,count}));
    }
  }
  // Activate only the identity binding; all test scheduling stays disabled.
  await bootstrap.evaluate(async(binding)=>{
    await chrome.storage.local.set({followQueueBinding:{...binding,activated:true,sources:{comments:false,fans:false,mutual:false}}});
    await chrome.alarms.clearAll();
  },manifest.binding);
  // Restart only this test profile's workers; runtime.reload can disable a CDP-loaded
  // unpacked extension instead of re-enabling it in a headless browser.
  await workerControl.send('ServiceWorker.stopAllWorkers');
  const page=await browser.newPage();
  const uiErrors=[];page.on('pageerror',error=>uiErrors.push(error.message));
  await page.goto(origin+'/panel.html?tab=monitor');
  let status;
  for(let i=0;i<120;i++){
    status=await message(page,{cmd:'recordData',op:'status'}).catch(()=>null);
    if(status?.ok&&status.status?.cutover)break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(status?.status?.cutover,true,'Restored records must remain available');
  const review=await message(page,{cmd:'followQueueReviewSettings'});
  assert.equal(review?.ok,true,review?.error);
  assert.equal(review.settings.initialReviewEnabled,false);
  assert.equal(review.settings.followBackSkipRules,false,'Legacy allow-all must not enable the new bypass');
  const migrationStarted=Date.now();console.log(JSON.stringify({phase:'native-review-migration-start'}));
  const reviewStatus=await message(page,{cmd:'followQueueFanReviewStatus'});
  const migrationElapsedMs=Date.now()-migrationStarted;console.log(JSON.stringify({phase:'native-review-migration-complete',elapsedMs:migrationElapsedMs}));
  assert.equal(reviewStatus.ok,true,reviewStatus.error);
  const projectionState=(await storeValues(page,'x-each-follower-records-dashboard','state'))[0];
  assert.equal(projectionState.fanReviewMigrationVersion,3,'Real background must finish the review migration');
  const directory=await message(page,{cmd:'recordData',op:'query',module:'fans',filter:{tab:'fanReview'},limit:1});
  assert.equal(directory.ok,true,directory.error);
  const fanCounts=directory.page.summary.tabs;
  for(let i=0;i<180;i++){
    const ui=await page.evaluate(()=>({ready:document.getElementById('monitorLoad')?.hidden===true,
      failed:document.getElementById('monitorLoadError')?.hidden===false,
      count:document.getElementById('followBackCount')?.textContent,review:document.getElementById('fanReviewCount')?.textContent}));
    if(ui.failed)throw Error('Native fan page reported a load failure');
    if(ui.ready && ui.count===String(fanCounts.fanPending||0) && ui.review===String(fanCounts.fanReview||0))break;
    if(i===179)throw Error('Native fan page never finished rendering migrated records');
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const rows=await storeValues(page,'x-each-follower-records-dashboard','rows');
  const remaining=new Set(rows.filter(row=>row.sourceKey==='monitor').map(row=>JSON.stringify([row.accountId,row.module,row.userKey])));
  for(const key of beforeKeys)assert.ok(remaining.has(key),'Migration must retain original source record '+key);
  const allSources=new Set(rows.filter(row=>!String(row.sourceKey).startsWith('derived:')).map(row=>JSON.stringify([row.accountId,row.module,row.userKey])));
  for(const key of sourceKeys)assert.ok(allSources.has(key),'Migration must preserve unrelated source records');
  const jobs=await storeValues(page,'x-each-follower-follow-queue','jobs');
  const byId=new Map(jobs.map(job=>[job.id,job]));
  for(const [id,result]of successfulJobs)assert.equal(JSON.stringify(byId.get(id)?.followResult),result,'Successful historical action receipt changed');
  await page.setViewport({width:1440,height:1000});
  await page.screenshot({path:path.join(output,'restored-panel.png')});
  await page.$eval('[data-follower-tab="fanReview"]',node=>node.click());
  await page.waitForFunction(()=>!document.getElementById('approveSelectedFans')?.hidden && document.querySelectorAll('#monitorList .monitor-item').length>0);
  await page.$eval('#monitorList input[type="checkbox"]',node=>node.click());
  assert.equal(await page.$eval('#reviewSelectedFans',node=>node.disabled),false);
  assert.equal(await page.$eval('#approveSelectedFans',node=>node.disabled),false);
  assert.equal(await page.$eval('#removeSelectedFans',node=>node.disabled),false);
  await page.screenshot({path:path.join(output,'native-review-list.png')});
  await page.$eval('#selectAllFilteredFans',node=>node.click());
  await page.waitForFunction(expected=>document.getElementById('fanReviewSelection')?.textContent.includes(String(expected)),{},fanCounts.fanReview);
  await page.$eval('#selectAllFilteredFans',node=>node.click());
  await page.$eval('#openSettingsDrawer',node=>node.click());
  await page.evaluate(()=>{
    const original=chrome.runtime.sendMessage.bind(chrome.runtime);window.__settingsSaveMessages=[];
    chrome.runtime.sendMessage=(message,...rest)=>{window.__settingsSaveMessages.push({cmd:message?.cmd,op:message?.op,key:message?.key,fields:Object.keys(message?.fields||{})});return original(message,...rest);};
  });
  await page.waitForFunction(()=>document.querySelector('.review-config-status')?.dataset.state==='unconfigured');
  await page.$eval('#saveSettingsDrawer',node=>node.click());
  await page.waitForFunction(()=>document.getElementById('saveSettingsDrawer')?.textContent.includes('已保存'));
  const monitorWrites=await page.evaluate(()=>__settingsSaveMessages.filter(message=>message.cmd==='recordData'&&message.op==='mergeRoot'&&message.key==='monitor'));
  assert.equal(monitorWrites.length,1,'One native save click must produce one settings write');
  assert.deepEqual(monitorWrites[0].fields.sort(),['autoEnqueue','enabled','every','filterDanger','followerBatch','followingBatch','jitter'].sort());
  assert.equal(await page.evaluate(()=>__settingsSaveMessages.filter(message=>message.cmd==='recordData'&&message.op==='batch').length),0,'Settings saving must not rewrite source records');
  await page.screenshot({path:path.join(output,'native-monitor-save-status.png')});
  await page.waitForSelector('#openFanReviewSettings',{visible:true});
  await page.$eval('#openFanReviewSettings',node=>node.click());
  await page.waitForSelector('#followReviewSettingsDialog[open]');
  await page.waitForFunction(()=>!document.getElementById('saveFollowReviewSettings')?.disabled);
  assert.equal(await page.$eval('#fan-initial-review',node=>node.checked),false);
  await page.$eval('#saveFollowReviewSettings',node=>node.click());
  await page.waitForFunction(()=>document.querySelector('.follow-review-notice')?.textContent.includes('保存'));
  await page.screenshot({path:path.join(output,'native-fan-settings.png')});
  await page.keyboard.press('Escape');
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('xfollower:follow-review-settings',{detail:{scope:'queue'}})));
  await page.waitForSelector('#queue-follow-back-skip');
  await page.waitForFunction(()=>!document.getElementById('saveFollowReviewSettings')?.disabled);
  assert.equal(await page.$eval('#queue-follow-back-skip',node=>node.checked),false);
  await page.$eval('#queue-follow-back-skip',node=>node.click());
  await page.$eval('#saveFollowReviewSettings',node=>node.click());
  await page.waitForFunction(()=>document.querySelector('.follow-review-notice')?.textContent.includes('保存'));
  const saved=await message(page,{cmd:'followQueueReviewSettings'});
  assert.equal(saved.settings.followBackSkipRules,true);assert.equal(saved.settings.initialReviewEnabled,false);
  await page.$eval('#queue-follow-back-skip',node=>node.click());
  await page.$eval('#saveFollowReviewSettings',node=>node.click());
  for(let i=0;i<100;i++){
    if((await message(page,{cmd:'followQueueReviewSettings'})).settings.followBackSkipRules===false)break;
    if(i===99)throw Error('Native queue setting restoration failed');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  // Exercise the real background admission callback without any network/AI:
  // initial review is off and queue scheduling remains disabled in this profile.
  const fixtureHandle='xf_fixture',fixtureId='9999999999999999999';
  const fixtureRecord=await message(page,{cmd:'recordData',op:'batch',sourceKey:'monitor',changes:[{
    accountId:manifest.binding.accountId,sourceBucket:'queue',handle:fixtureHandle,create:true,
    patch:{handle:fixtureHandle,id:fixtureId,ownerAccountId:manifest.binding.accountId,
      bio:'Offline native acceptance fixture',relationship:{following:false,followedBy:true}}
  }]});
  assert.equal(fixtureRecord.ok,true,fixtureRecord.error);
  let admissionTimer;
  const admitted=await Promise.race([message(page,{cmd:'followQueueEnqueue',candidate:{module:'fans',handle:fixtureHandle,targetUserId:fixtureId}}),
    new Promise((_,reject)=>{admissionTimer=setTimeout(()=>reject(Error('Initial admission recursively blocked background source sync')),10000);})
  ]).finally(()=>clearTimeout(admissionTimer));
  assert.equal(admitted.ok,true,admitted.error);assert.equal(admitted.count,1);
  assert.equal(admitted.jobs[0].fanGrant.ownerAccountId,manifest.binding.accountId);
  assert.equal(admitted.jobs[0].fanGrant.targetUserId,fixtureId);
  assert.equal(admitted.jobs[0].fanGrant.source,'initial-review-disabled');
  assert.deepEqual(uiErrors,[],'Actual extension UI must not raise uncaught errors');
  const result={sourceVersion:manifest.version,testVersion:await page.evaluate(()=>chrome.runtime.getManifest().version),records,
    originalMonitorSources:beforeKeys.size,retainedMonitorSources:remaining.size,preservedSourceRows:sourceKeys.size,preservedSuccessfulReceipts:successfulJobs.size,
    reviewDefaults:{initialReviewEnabled:review.settings.initialReviewEnabled,followBackSkipRules:review.settings.followBackSkipRules},
    migrationVersion:projectionState.fanReviewMigrationVersion,migrationElapsedMs,fanCounts,nativeSettingsSavePassed:true,
    nativeReviewSelectionPassed:true,allFilteredSelectionCount:fanCounts.fanReview,nativeAdmissionPassed:true,
    monitorSettingsWriteCount:monitorWrites.length,monitorSettingsSourceRewrites:0,uiErrors,
    note:'Actual unpacked extension in isolated native Chrome with cloned public records/history and scheduling disabled. No authenticated X profile or real AI transport used.'};
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
