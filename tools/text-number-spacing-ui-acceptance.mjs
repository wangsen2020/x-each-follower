import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output='C:/jtmp/xf-spacing-4252';await fs.mkdir(output,{recursive:true});
const extension=path.join(output,'extension-'+Date.now());
await fs.cp(path.resolve('scratch/build-tests/text-number-spacing'),extension,{recursive:true});
await fs.writeFile(path.join(extension,'test-bootstrap.html'),'<!doctype html><title>Offline test bootstrap</title>');
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
 ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
const errors=[],checks=[];
try{
 const offline=await browser.newPage();await offline.setRequestInterception(true);
 offline.on('request',r=>{if(r.isNavigationRequest()&&r.url()==='https://x.com/home')void r.respond({status:200,contentType:'text/html',body:'<!doctype html><title>Offline fixture</title>'});else void r.abort();});await offline.goto('https://x.com/home');
 const control=await browser.target().createCDPSession();const {id}=await control.send('Extensions.loadUnpacked',{path:extension});
 const bootstrap=await browser.newPage();await bootstrap.goto(`chrome-extension://${id}/test-bootstrap.html`);
 const seeded=await bootstrap.evaluate(async()=>{
  const migration=await chrome.runtime.sendMessage({cmd:'recordData',op:'migrate'});if(!migration.ok)throw Error(migration.error);
  await chrome.storage.local.set({followQueueBinding:{activated:true,accountId:'1',handle:'offline_owner',sources:{}}});
  return chrome.runtime.sendMessage({cmd:'recordData',op:'batch',sourceKey:'monitor',changes:Array.from({length:26},(_,i)=>({accountId:'unassigned',sourceBucket:'users',handle:'sample_'+i,create:true,
   patch:{id:String(100+i),targetUserId:String(100+i),handle:'sample_'+i,name:'Sample '+i,bio:'Public profile description',followersText:'120',followingText:'100',
    relationship:{following:i>=22,followedBy:i<24},relationshipKnown:true,relationshipObservedAt:Date.now(),
    fanReview:{state:i<14?'approved':i<19?'review':i<22?'verify':'approved',decision:i<14?'pass':i<19?'review':'uncertain',source:i<19?'initial-ai-review':'initial-ai-unavailable',ownerAccountId:'1',targetUserId:String(100+i),decisionVersion:1,
      ...(i>=14&&i<19?{enrichmentCompletedAt:Date.now()}:{}),...(i>=19&&i<22?{reasonCode:'missing_biography'}:{})}}}))});
 });assert.equal(seeded.ok,true);
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1280,height:900});
 await page.goto(`chrome-extension://${id}/panel.html`);
 const wait=f=>page.waitForFunction(f,{polling:100,timeout:20000});const click=s=>page.$eval(s,e=>e.click());
 await wait(()=>document.querySelector('#followBackCount')?.textContent==='14');
 assert.equal(await page.$('[data-follower-tab="fanFollowing"]'),null);
 assert.equal(await page.$eval('[data-follower-tab].active',e=>e.dataset.followerTab),'fanPending');
 assert.match(await page.$eval('#monitorStatus',e=>e.textContent),/22/);
 assert.equal(await page.$eval('#fanReviewCount',e=>e.textContent),'5');assert.equal(await page.$eval('#fanUnknownCount',e=>e.textContent),'3');
 checks.push('default pending; no single-follow tab; 22 outstanding = 14 pending + 5 review + 3 verification; 2 mutual and 2 following excluded');
 for(const width of [1280,720,640]){await page.setViewport({width,height:900});await page.screenshot({path:output+`/fans-${width}.png`});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.setViewport({width:1280,height:900});await click('[data-follower-tab="fanUnknown"]');
 await wait(()=>document.querySelector('#monitorList')?.textContent.includes('sample_19'));
 await page.screenshot({path:output+'/verification.png'});
 await click('#listSelectAll');assert.equal(await page.$eval('#selectedCount',e=>e.textContent),'3');
 await click('[data-follower-tab="fanReview"]');await wait(()=>document.querySelector('#selectedCount')?.textContent==='0');
 await page.focus('.follower-tabs .info-tip');await wait(()=>document.querySelector('[role="tooltip"]')?.textContent.includes('10'));
 checks.push('verification rows selectable; category switch clears selection; keyboard tooltip describes one re-review');
 await page.reload();await wait(()=>document.querySelector('#followBackCount')?.textContent==='14');
 assert.equal(await page.$eval('[data-follower-tab].active',e=>e.dataset.followerTab),'fanPending');checks.push('reload preserves data and returns to pending default');
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('xfollower:operation-result',{detail:{id:'task:review:three-way',kind:'fan-review',title:'AI 审核 · 已完成',createdAt:Date.now(),progress:{stage:'completed',done:20,total:20,groups:[{label:'通过',count:8},{label:'不通过',count:4},{label:'资料不足',count:8}]},items:['@sample_0 · 通过 · 已加入关注队列','@sample_1 · 不通过 · 已移除','@sample_2 · 资料不足 · 已进入待核实']}})));
 await wait(()=>document.querySelector('.result-notice-card')?.textContent.includes('资料不足 8'));
 assert.doesNotMatch(await page.$eval('.result-notice-progress',e=>e.textContent),/成功|失败/);
 for(const width of [1280,640]){await page.setViewport({width,height:900});await page.screenshot({path:output+'/three-way-'+width+'.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 checks.push('three-way result card displays passed/rejected/insufficient, without success/failure confusion');
 await page.setViewport({width:1280,height:900});
 for(const language of ['zh-CN','en','pt-BR','es-419']){
  await page.evaluate(language=>{chrome.i18n.getUILanguage=()=>language;dispatchEvent(new Event('languagechange'));},language);
  await wait(()=>document.documentElement.lang!=='' );
  for(const [tab,badge] of [['monitor','#selectedCount'],['candidates','#mutualSelectedCount'],['comments','#commentSelectedCount'],['unreciprocated','#unreciprocatedSelectedCount']]){
   await click('[data-tab="'+tab+'"]');
   await page.waitForSelector(badge);
   const label=await page.$eval(badge,e=>e.parentElement.textContent);
   assert.match(label,/\s0\s*\//,language+' '+tab+' '+label);
   if(tab==='monitor'){
    await click('[data-follower-tab="fanUnknown"]');await wait(()=>document.querySelector('#totalVisibleCount')?.textContent==='3');
    await click('#listSelectAll');await wait(()=>document.querySelector('#selectedCount')?.textContent==='3');
    assert.match(await page.$eval(badge,e=>e.parentElement.textContent),/\s3\s*\//);
    await page.screenshot({path:output+'/selected-'+language+'.png'});
    await click('#listSelectAll');
    assert.match(await page.$eval(badge,e=>e.parentElement.textContent),/\s0\s*\//);
   }
  }
  await click('[data-tab="postTracking"]');
  const options=await page.$$eval('select option',nodes=>nodes.map(e=>e.textContent));
  if(language==='zh-CN'){assert.ok(options.includes('7 天'));assert.ok(options.includes('90 天'));}
  await page.screenshot({path:output+'/posts-'+language+'.png'});
 }
 checks.push('4 locales: 4 list badges, real selection 0 → 3 → 0, spaced time range options');
 await page.evaluate(()=>{chrome.i18n.getUILanguage=()=> 'zh-CN';dispatchEvent(new Event('languagechange'));});
 await click('[data-tab="monitor"]');
 for(const width of [1280,640]){await page.setViewport({width,height:900});await page.screenshot({path:output+'/spacing-'+width+'.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}

 assert.deepEqual(errors,[]);const result={version:await page.evaluate(()=>chrome.runtime.getManifest().version),checks,errors,output};
 await fs.writeFile(output+'/acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
