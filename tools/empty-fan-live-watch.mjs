import puppeteer from 'puppeteer-core';import fs from 'node:fs/promises';
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
let previous='';
try{for(let i=0;i<60;i++){
 try{const page=(await browser.pages()).find(p=>p.url().startsWith('chrome-extension://')&&p.url().endsWith('/panel.html'));
 const result=await page.evaluate(async()=>{
  const handle='johansmithgeae',owner='1485853007346827264',id='2115720219578773504';
  const rows=await chrome.runtime.sendMessage({cmd:'recordData',op:'lookupAll',sourceKey:'monitor',handle});
  const key='followQueueFanRemovalIntent:'+owner+':'+id;
  const data=await chrome.storage.local.get([key,'fanAutomation:'+owner]);
  const logs=await chrome.runtime.sendMessage({cmd:'queryExecutionLogs',scope:'fanVerify',limit:100});
  return {version:chrome.runtime.getManifest().version,at:new Date().toISOString(),rows:rows.records?.map(row=>({handle:row.handle,state:row.payload.state,review:row.payload.fanReview,relationship:row.payload.relationship})),receipt:data[key],retryAt:data['fanAutomation:'+owner]?.verify?.attempts?.[id],logs:(logs.items||logs.logs||logs.entries||[]).filter(row=>row.handle===handle)};
 });
 await fs.writeFile('C:/jtmp/xf-empty-live-result.json',JSON.stringify(result,null,2));
 const summary=JSON.stringify({version:result.version,state:result.rows?.[0]?.review?.state,reason:result.rows?.[0]?.review?.reason,removed:result.receipt?.removed,retryAt:result.retryAt});if(summary!==previous){console.log(summary);previous=summary;}
 if(result.version==='4.28.3'&&result.rows?.some(row=>row.review?.state==='removed'))break;
 }catch(error){if(i%6===0)console.log('Awaiting live panel: '+error.message);}
 await new Promise(resolve=>setTimeout(resolve,10000));
}}finally{await browser.disconnect();}
