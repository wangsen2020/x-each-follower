import puppeteer from 'puppeteer-core';import fs from 'node:fs/promises';
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});const started=Date.now();let prior;
const panel=async()=>(await browser.pages()).find(p=>p.url().endsWith('/panel.html'));
try{
 const p=await panel();prior=await p.evaluate(async()=>{const data=await chrome.storage.local.get('unreciprocatedSettings'),settings=data.unreciprocatedSettings;await chrome.storage.local.set({unreciprocatedSettings:{...settings,autoUnfollow:false}});return settings.autoUnfollow;});
 await fs.writeFile('C:/jtmp/xf-account-state/unfollow-maintenance.json',JSON.stringify({started,prior}));
 console.log('Held new automatic unfollow submissions; existing checkpoints preserved.');
 for(let i=0;i<50;i++){const stat=await fs.stat('C:/jtmp/xf-account-state/deploy/loaded.json').catch(()=>null);if(stat?.mtimeMs>started){console.log('Final build loaded.');break;}if(i===49)throw Error('Reload did not finish');await new Promise(r=>setTimeout(r,5000));}
}finally{
 if(prior!==undefined){const p=await panel();const result=await p.evaluate(async prior=>{const data=await chrome.storage.local.get('unreciprocatedSettings');if(data.unreciprocatedSettings.autoUnfollow!==false)return {userChanged:true};await chrome.storage.local.set({unreciprocatedSettings:{...data.unreciprocatedSettings,autoUnfollow:prior}});return {restored:true};},prior);await fs.writeFile('C:/jtmp/xf-account-state/unfollow-restored.json',JSON.stringify(result));console.log(JSON.stringify(result));}
 await browser.disconnect();
}
