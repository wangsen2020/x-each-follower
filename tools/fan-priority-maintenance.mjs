import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),folder='C:/jtmp/xf-fan-priority';await fs.mkdir(folder,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
const panel=async()=>(await browser.pages()).find(p=>p.url().endsWith('/panel.html'));
let original,held;
try{
 const page=await panel();original=await page.evaluate(async()=>({automation:(await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'})).settings.automation,
  queue:(await chrome.runtime.sendMessage({cmd:'followQueueSettings'})).settings.enabled,unfollow:(await chrome.storage.local.get('unreciprocatedSettings')).unreciprocatedSettings.autoUnfollow}));
 held=structuredClone(original.automation);held.review.enabled=false;held.verify.enabled=false;await fs.writeFile(folder+'/maintenance-original.json',JSON.stringify(original,null,2));
 await page.evaluate(async held=>{
  const settings=(await chrome.storage.local.get('unreciprocatedSettings')).unreciprocatedSettings;await chrome.storage.local.set({unreciprocatedSettings:{...settings,autoUnfollow:false}});
  const queue=await chrome.runtime.sendMessage({cmd:'followQueueList',limit:1});
  if(!queue.summary.running){const paused=await chrome.runtime.sendMessage({cmd:'followQueueSaveSettings',settings:{enabled:false}});if(!paused.ok)throw Error(paused.error);}
  const saved=await chrome.runtime.sendMessage({cmd:'followQueueSaveReviewSettings',settings:{automation:held}});if(!saved.ok)throw Error(saved.error);
 },held);
 for(let i=0;i<48;i++){
  const current=await panel();const idle=await current.evaluate(async()=>{const q=await chrome.runtime.sendMessage({cmd:'followQueueList',limit:1});if(q.summary.running)return false;const r=await chrome.runtime.sendMessage({cmd:'followQueueSaveSettings',settings:{enabled:false}});if(!r.ok)throw Error(r.error);return true;});
  if(!idle){if(i===0)console.log('Waiting for the active follow round to finish without interruption.');await new Promise(r=>setTimeout(r,10000));continue;}
  try{const {stdout}=await exec(process.execPath,['tools/fan-priority-live-deploy.mjs','apply','scratch/build-tests/fan-priority'],{cwd:process.cwd(),timeout:60000});console.log(stdout.trim());break;}
  catch(error){if(!error.stdout?.includes('"busy":true')||i===47)throw error;if(i===0)console.log('Waiting for current work to finish its checkpoint.');}
  await new Promise(resolve=>setTimeout(resolve,10000));
 }
}finally{
 if(original){const page=await panel();const result=await page.evaluate(async({original,held})=>{
  const output={};const settings=(await chrome.storage.local.get('unreciprocatedSettings')).unreciprocatedSettings;
  if(settings.autoUnfollow===false){await chrome.storage.local.set({unreciprocatedSettings:{...settings,autoUnfollow:original.unfollow}});output.unfollow=true;}
  const queue=await chrome.runtime.sendMessage({cmd:'followQueueSettings'});if(queue.settings.enabled===false)output.queue=(await chrome.runtime.sendMessage({cmd:'followQueueSaveSettings',settings:{enabled:original.queue}})).ok;
  const current=await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'});if(JSON.stringify(current.settings.automation)===JSON.stringify(held))output.automation=(await chrome.runtime.sendMessage({cmd:'followQueueSaveReviewSettings',settings:{automation:original.automation}})).ok;
  return output;
 },{original,held});await fs.writeFile(folder+'/maintenance-restored.json',JSON.stringify(result));console.log(JSON.stringify({restored:result}));}
 await browser.disconnect();
}
