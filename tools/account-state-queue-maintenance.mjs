import puppeteer from 'puppeteer-core';import fs from 'node:fs/promises';
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});const started=Date.now();let enabled;
const panel=async()=>(await browser.pages()).find(p=>p.url().endsWith('/panel.html'));
try{
 const p=await panel();enabled=await p.evaluate(async()=>{const r=await chrome.runtime.sendMessage({cmd:'followQueueSettings'});if(!r.ok)throw Error(r.error);return r.settings.enabled;});
 await fs.writeFile('C:/jtmp/xf-account-state/queue-maintenance.json',JSON.stringify({started,enabled}));
 const paused=await p.evaluate(()=>chrome.runtime.sendMessage({cmd:'followQueuePause'}));if(!paused.ok)throw Error(paused.error);console.log('Queue paused through its checkpoint-aware controller.');
 for(let i=0;i<48;i++){const stat=await fs.stat('C:/jtmp/xf-account-state/deploy/loaded.json').catch(()=>null);if(stat?.mtimeMs>started){console.log('Final build loaded.');break;}if(i===47)throw Error('Reload did not finish');await new Promise(r=>setTimeout(r,5000));}
}finally{
 if(enabled!==undefined){const p=await panel();const result=await p.evaluate(async enabled=>{const r=await chrome.runtime.sendMessage({cmd:'followQueueSettings'});if(r.settings.enabled!==false)return {userChanged:true};const saved=await chrome.runtime.sendMessage({cmd:'followQueueSaveSettings',settings:{enabled}});return {restored:saved.ok};},enabled);await fs.writeFile('C:/jtmp/xf-account-state/queue-restored.json',JSON.stringify(result));console.log(JSON.stringify(result));}await browser.disconnect();
}
