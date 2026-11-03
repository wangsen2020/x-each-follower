import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),folder='C:/jtmp/xf-account-state';await fs.mkdir(folder,{recursive:true});
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
const panel=async()=>(await browser.pages()).find(p=>p.url().includes('/panel.html'));
let original,held,restored=false;
try{
 const page=await panel();if(!page)throw Error('No panel');
 original=await page.evaluate(async()=>(await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'})).settings.automation);
 held=structuredClone(original);held.review.enabled=false;held.verify.enabled=false;
 await fs.writeFile(folder+'/maintenance-settings.json',JSON.stringify({original,held},null,2));
 const disabled=await page.evaluate(settings=>chrome.runtime.sendMessage({cmd:'followQueueSaveReviewSettings',settings:{automation:settings}}),held);
 if(!disabled.ok)throw Error(disabled.error);
 console.log('Temporarily holding new automatic review/verification work; in-flight requests and queue remain intact.');
 for(let n=0;n<17;n++){
  try{
   const {stdout}=await exec(process.execPath,['tools/account-state-live-deploy.mjs','apply','scratch/build-tests/account-state'],{cwd:process.cwd(),timeout:60000});
   console.log(stdout.trim());if(stdout.includes('"loaded":"4.27.0"'))break;
  }catch(error){if(!error.stdout?.includes('"busy":true'))throw error;console.log('Waiting for current tasks to reach an idle checkpoint.');}
  if(n===16)throw Error('No safe reload window within 8 minutes; original automation will be restored.');
  await new Promise(r=>setTimeout(r,30000));
 }
}finally{
 if(original){
  const page=await panel();if(!page)throw Error('Restore required: see maintenance-settings.json');
  const outcome=await page.evaluate(async({original,held})=>{
   const result=await chrome.runtime.sendMessage({cmd:'followQueueReviewSettings'});
   if(JSON.stringify(result.settings.automation)!==JSON.stringify(held))return {restored:false,userChanged:true};
   const saved=await chrome.runtime.sendMessage({cmd:'followQueueSaveReviewSettings',settings:{automation:original}});
   return {restored:saved.ok,error:saved.error};
  },{original,held});restored=outcome.restored;
  await fs.writeFile(folder+'/maintenance-restored.json',JSON.stringify(outcome));console.log(JSON.stringify(outcome));
 }
 await browser.disconnect();
}
