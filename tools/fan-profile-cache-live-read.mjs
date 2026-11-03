import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createFanProfileCacheReader,readFanProfileQueue} from '../src/features/relationships/fan-profile-queue-view.js';
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
try{
 const page=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().includes('/panel.html'));
 assert.ok(page);
 const before=await page.evaluate(async()=>({checkpoint:(await chrome.storage.local.get('fanProfileCollection:v1'))['fanProfileCollection:v1']}));
 const storage={get:keys=>page.evaluate(keys=>chrome.storage.local.get(keys),keys)};
 const binding=async()=> (await storage.get('followQueueBinding')).followQueueBinding;
 const records={sourcePage:async request=>{const result=await page.evaluate(request=>chrome.runtime.sendMessage({cmd:'recordData',op:'sourcePage',...request}),request);assert.equal(result.ok,true);return result.page;}};
 const readCachedResults=createFanProfileCacheReader({records,storage});
 const result=await readFanProfileQueue({storage,binding,readCachedResults,alarms:{get:name=>page.evaluate(name=>chrome.alarms.get(name),name)}});
 const after=await storage.get('fanProfileCollection:v1');
 await fs.mkdir('C:/jtmp/xf-post-queue-acceptance',{recursive:true});await fs.writeFile('C:/jtmp/xf-post-queue-acceptance/live-cache-summary.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({account:result.handle,total:result.total,summary:result.summary,first:result.items.slice(0,4),readOnlyAdapters:true,concurrentBackgroundChanges:JSON.stringify(after['fanProfileCollection:v1'])!==JSON.stringify(before.checkpoint)}));
}finally{browser.disconnect();}
