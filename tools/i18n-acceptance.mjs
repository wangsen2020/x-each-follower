// Runs only against the isolated fixture; it never attaches to an X page.
import fs from 'node:fs';
const out='C:/jtmp/xfollower-i18n-for-agentrelay';fs.mkdirSync(out+'/screenshots',{recursive:true});
const targets=await fetch('http://127.0.0.1:9237/json/version').then(r=>r.json());
async function connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let id=0;const pending=new Map();ws.onmessage=e=>{const message=JSON.parse(e.data);if(pending.has(message.id)){const {resolve,reject,timer}=pending.get(message.id);clearTimeout(timer);pending.delete(message.id);message.error?reject(Error(JSON.stringify(message.error))):resolve(message.result);}};return {ws,call:(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error('Timeout: '+method));},20000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));})};}
const browser=await connect(targets.webSocketDebuggerUrl);let target;
const checks=[];const errors=[];
try{
 target=(await browser.call('Target.createTarget',{url:'http://127.0.0.1:5193/tests/fixtures/i18n-preview.html?lang=en',background:true})).targetId;
 const listing=await fetch('http://127.0.0.1:9237/json/list').then(r=>r.json());const page=await connect(listing.find(t=>t.id===target).webSocketDebuggerUrl);
 await page.call('Page.enable');await page.call('Page.bringToFront');await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
 const evaluate=async expression=>{const result=await page.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);return result.result.value;};
 const wait=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Not ready: '+expression);};
 await wait('!!window.preview&&!!document.querySelector(".ai-actions")');
 await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});
 const shot=async name=>{if(process.env.I18N_SETTINGS_ONLY==='1'&&!/-(01|02|04|05)-/.test(name))return;await new Promise(r=>setTimeout(r,150));const {data}=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(out+'/screenshots/'+name+'.png',Buffer.from(data,'base64'));};
 const check=async(name,expression)=>{const value=await evaluate(expression);checks.push({name,passed:Boolean(value),value});if(!value)errors.push(name);};
 await evaluate(`(()=>{const input=document.querySelector('#ai-session-name');input.value='Product feedback';input.dispatchEvent(new Event('input',{bubbles:true}));preview.setLanguage('pt-BR');})()`);
 await check('Switch preserves unsaved input',`document.querySelector('#ai-session-name').value==='Product feedback'&&preview.calls.test===0&&preview.calls.save===0`);
 await check('Browser language applied without saved override',`localStorage.getItem('xfollower.uiLanguage')===null&&document.documentElement.lang==='pt-BR'`);
 for(const lang of ['en','zh-CN','pt-BR','es-419']){console.log('Checking '+lang);
  await evaluate(`preview.setLanguage(${JSON.stringify(lang)});preview.mode('ai')`);await wait('!!document.querySelector(".ai-actions")');
  await evaluate(`document.querySelector('.ai-actions button').click()`);await wait('document.querySelector("#ai-session").options.length>=3');
  await shot(lang+'-01-connection-sessions');
  await evaluate(`document.querySelector('.ai-actions button:last-child').click()`);await wait('!!document.querySelector(".ai-feedback")&&!document.querySelector(".ai-actions button:last-child").disabled');
  await check(lang+' test save success',`preview.calls.test>0&&!document.querySelector('.ai-error')&&document.querySelector('.ai-feedback').textContent.length>10`);
  await shot(lang+'-02-connection-saved');
  await evaluate('preview.reopen()');await wait('!!document.querySelector("#ai-session")&&document.querySelector("#ai-session").value!==""');
  await check(lang+' connection survives reopen',`document.querySelector('#ai-session').value==='codex-example'`);
  await evaluate(`preview.mode('feed')`);await wait('document.querySelectorAll(".mc-table tbody tr").length===4');
  await shot(lang+'-03-feed-workspace');
  await evaluate(`document.querySelectorAll('.fq-header-actions button')[1].click()`);await wait('!!document.querySelector("dialog[open] .mc-form")&&document.querySelectorAll(".mc-engine-message").length===2');
  await wait(`document.querySelectorAll('.ai-session-select option').length>=6`);
  await check(lang+' dialog owns focus',`document.querySelector('dialog[open]').contains(document.activeElement)`);
  await shot(lang+'-04-two-stage-settings');
  await check(lang+' two engines retained',`document.querySelector('#mc-session-scan').value==='codex-example'&&document.querySelector('#mc-session-comment').value==='antigravity-example'`);
  await check(lang+' session text ellipsis reserves arrow space',`[...document.querySelectorAll('dialog[open] .ai-session-select')].every(select=>{const text=select.querySelector('selectedcontent'),style=getComputedStyle(select),r=select.getBoundingClientRect();return text&&getComputedStyle(text).textOverflow==='ellipsis'&&getComputedStyle(text).whiteSpace==='nowrap'&&text.getBoundingClientRect().right<=r.right-32&&style.paddingRight==='32px'&&style.backgroundPositionX==='calc(100% - 10px)'&&select.title===select.selectedOptions[0].textContent&&text.scrollWidth>text.clientWidth})`);
  await evaluate(`document.querySelector('dialog[open] .panel-close-button').click()`);
 }
 await check('Language did not save business settings',`preview.calls.save===0`);
 await evaluate(`document.querySelectorAll('.fq-header-actions button')[1].click()`);await wait('!!document.querySelector("dialog[open] .mc-form")');
 await evaluate(`(()=>{const input=document.querySelector('dialog[open] input[type=number]');input.value='12';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('dialog[open] .action-drawer-footer button').click()})()`);
 await wait('!!document.querySelector(".mc-save-result[open]")');
 await check('Settings save confirms persistence in mock service',`preview.calls.save===1&&preview.config.scanIntervalMinutes===12`);
 await evaluate(`document.querySelector('.mc-save-result[open] .panel-close-button').click();document.querySelectorAll('.fq-header-actions button')[1].click()`);await wait('!!document.querySelector("dialog[open] .mc-form")');
 await check('Saved settings survive close and reopen',`document.querySelector('dialog[open] input[type=number]').value==='12'`);
 await evaluate(`document.querySelector('dialog[open] .panel-close-button').click()`);
 await evaluate(`preview.setLanguage('pt-BR');document.querySelectorAll('.fq-header-actions button')[1].click()`);await wait('!!document.querySelector("dialog[open] .mc-form")');
 await page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
 await shot('pt-BR-05-narrow-settings');
 await check('Narrow drawer stays in viewport',`(()=>{const r=document.querySelector('dialog[open]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})()`);
 await evaluate(`(()=>{const body=document.querySelector('dialog[open] .action-drawer-body');body.scrollTop=body.scrollHeight})()`);
 await check('Narrow drawer scrolls to remaining settings',`document.querySelector('dialog[open] .action-drawer-body').scrollTop>0`);
 await evaluate(`document.querySelector('dialog[open] .panel-close-button').click();preview.empty(true);document.querySelectorAll('.fq-header-actions button')[0].click()`);await wait('!!document.querySelector(".mc-empty")');await shot('pt-BR-06-empty');
 await evaluate(`preview.failure(true);document.querySelectorAll('.fq-header-actions button')[0].click()`);await wait('!!document.querySelector(".fq-alert-error")');await shot('pt-BR-07-failure');
 await evaluate(`preview.failure(false);preview.mode('ai')`);await wait('!!document.querySelector(".ai-actions")');
 await evaluate(`document.querySelector('.ai-actions button').click()`);await wait('document.querySelector("#ai-session").options.length>=3');
 await evaluate(`(()=>{const select=document.querySelector('#ai-session');select.value='codex-long';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await check('Long session title remains readable in title attribute',`document.querySelector('#ai-session').title.includes('a long, readable session title')`);
 await evaluate(`document.querySelector('#ai-session').focus()`);
 const point=await evaluate(`(()=>{const r=document.querySelector('#ai-session').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
 await page.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await check('Native session select supports keyboard choice',`document.querySelector('#ai-session').value==='codex-example'`);
 console.log('Keyboard selection:',await evaluate(`({value:document.querySelector('#ai-session').value,active:document.activeElement?.id,focused:document.hasFocus()})`));
 await evaluate(`preview.setLanguage('es-419')`);
 await check('Browser language refresh applies',`document.documentElement.lang==='es-419'`);
 await page.call('Page.navigate',{url:'http://127.0.0.1:5193/tests/fixtures/i18n-preview.html?lang=es-419'});await wait('!!window.preview&&document.documentElement.lang==="es-419"&&!!document.querySelector(".ai-actions")');
 await check('Reopened page follows browser language',`preview.locale.value==='es-419'`);
 console.log(JSON.stringify({checks,errors},null,2));fs.writeFileSync(out+'/acceptance.json',JSON.stringify({checks,errors},null,2));
 page.ws.close();
}finally{if(target)await browser.call('Target.closeTarget',{targetId:target});browser.ws.close();}
if(errors.length)process.exitCode=1;




