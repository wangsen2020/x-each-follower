// Run against the isolated preview opened by knowledge-cdp.mjs. No user data or publishing.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const session=JSON.parse(fs.readFileSync(new URL('../knowledge-acceptance-session.json',import.meta.url)));
const target=(await fetch('http://127.0.0.1:9222/json/list').then(r=>r.json())).find(t=>t.url===session.url);
assert.ok(target,'Open the isolated knowledge preview first');
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r=>socket.onopen=r);
let serial=0;
const pending=new Map();
socket.onmessage=e=>{const result=JSON.parse(e.data);if(result.id)pending.get(result.id)?.(result);};
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},30000);pending.set(id,r=>{clearTimeout(timer);pending.delete(id);r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result);});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
const settle=`await acceptance.tick();`;
async function click(selector){await evaluate(`(async()=>{document.querySelector(${JSON.stringify(selector)}).click();${settle}})()`);}
async function button(text){await evaluate(`(async()=>{[...document.querySelectorAll('dialog[open] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click();${settle}})()`);}
async function waitFor(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw Error('UI did not settle: '+expression);}
async function close(){await evaluate(`(async()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());${settle}})()`);}
const reports=[];
async function geometry(name){
  const r=await evaluate(`(()=>{const d=document.querySelector('dialog[open]'),box=d?.getBoundingClientRect(),pager=d?.querySelector('.panel-pager'),label=pager?.querySelector('label'),select=label?.querySelector('select'),text=label?.querySelector('span'),cells=[...document.querySelectorAll('.experience-detail-col button,.experience-state-col .kb-status-badge')].filter(e=>e.getBoundingClientRect().width);return {name:${JSON.stringify(name)},width:innerWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth,dialog:box?{left:box.left,right:box.right,width:box.width}:null,bodyOverflow:d?d.querySelector('.modal-body')?.scrollWidth>d.querySelector('.modal-body')?.clientWidth:false,pagerDirection:label?getComputedStyle(label).flexDirection:null,pagerGap:select?select.getBoundingClientRect().left-text.getBoundingClientRect().right:null,pagerCenters:pager?[...pager.children,...label.children].map(e=>e.getBoundingClientRect().top+e.getBoundingClientRect().height/2):[],tableOverflow:d?.querySelector('.version-table')?d.querySelector('.version-table').scrollWidth>d.querySelector('.version-table-wrap').clientWidth:false,cellsFit:cells.every(e=>e.getBoundingClientRect().right<=e.closest('td').getBoundingClientRect().right+1)};})()`);
  assert.equal(r.pageOverflow,false,name+': page overflow');
  assert.equal(r.cellsFit,true,name+': experience cell overflow');
  if(r.dialog){assert.ok(r.dialog.left>=9&&r.dialog.right<=r.width-9,name+': dialog outside viewport');assert.equal(r.bodyOverflow,false,name+': dialog body overflow');}
  if(r.pagerDirection){assert.equal(r.pagerDirection,'row');assert.equal(r.pagerGap,10);assert.ok(Math.max(...r.pagerCenters)-Math.min(...r.pagerCenters)<1,name+': pager centers differ');}
  assert.equal(r.tableOverflow,false,name+': wisdom table overflow');reports.push(r);
}
try{
  await waitFor('!!window.acceptance');
  await evaluate(`(async()=>{const a=acceptance;const {createKnowledgeReviewService}=await import('/src/features/knowledge/knowledge-review.js');const review=createKnowledgeReviewService({store:a.library});if(!(await a.library.listKnowledge('123')).length)for(let i=0;i<23;i++)await review.createCandidate({ownerId:'123',statement:'验收经验'+i+'：说明技术取舍和适用条件，不编造指标。',scope:{sourceChannel:'manual'}});let head=await a.learningStore.wisdom('123');for(let i=head?.version||0;i<12;i++)await a.runtime.handle({action:'wisdomSave',baseVersion:i,content:'# 写作智慧\\n\\n## 互动经验\\n围绕具体事实讨论，保留适用条件。版本'+(i+1)});for(let i=0;i<23;i++)await a.learningStore.saveRun({id:'layout-run-'+i,ownerId:'123',kind:'extract',status:'completed',at:Date.now()-i*1000,samples:[],result:{knowledgeCreated:1,knowledgeReused:0}});document.querySelector('[aria-label="刷新经验"]').click();})()`);
  await waitFor('document.querySelectorAll(".experience-table tbody tr").length===20');
  for(const width of [1280,768,390,320]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
    await close();await geometry('experience-list');
    await click('[aria-label="智慧"]');await waitFor('!!document.querySelector("dialog[open] textarea")');await geometry('markdown');
    await button('版本记录');await waitFor('document.querySelectorAll("dialog[open] .version-table tbody tr").length===10');await geometry('wisdom-versions');
    await click('[aria-label="智慧版本分页下一页"]');await waitFor('document.querySelectorAll("dialog[open] .version-table tbody tr").length===2');await geometry('wisdom-next-page');
    await close();await click('[aria-label="知识库设置"]');await waitFor('!!document.querySelector("dialog[open] .learning-settings")');
    const settings=await evaluate(`(()=>{const rows=[...document.querySelectorAll('dialog[open] .learning-settings label')];return rows.map(e=>({direction:getComputedStyle(e).flexDirection,overflow:e.scrollWidth>e.clientWidth}));})()`);
    assert.ok(settings.every(r=>r.direction==='row'&&!r.overflow),'settings rows must remain inline');
    await close();await evaluate(`(async()=>{[...document.querySelectorAll('.learning-line button')].find(e=>e.textContent==='执行记录').click();${settle}})()`);await waitFor('document.querySelectorAll("dialog[open] .learning-log-table tbody tr").length===10');await geometry('execution-history');
    await click('[aria-label="执行记录分页下一页"]');await waitFor('document.querySelector("dialog[open] .panel-pager")?.textContent.includes("2 / ")');await geometry('execution-next-page');
    await close();await click('[aria-label="查看经验详情"]');await waitFor('!!document.querySelector("dialog[open] .kb-drawer-content")');
    const details=await evaluate(`(()=>{const d=document.querySelector('dialog[open]');return {width:d.clientWidth,scroll:d.querySelector('.action-drawer-body').scrollWidth,body:d.querySelector('.action-drawer-body').clientWidth};})()`);assert.ok(details.scroll<=details.body,'detail drawer overflows');
    await close();await click('[aria-label="新增经验"]');await waitFor('!!document.querySelector("dialog[open] .kb-drawer-form")');
    const form=await evaluate(`(()=>{const d=document.querySelector('dialog[open] .action-drawer-body');return {width:d.clientWidth,scroll:d.scrollWidth};})()`);assert.ok(form.scroll<=form.width,'create drawer overflows');
    await close();
  }
  await evaluate(`(()=>{const a=acceptance;a.originalHandle=a.runtime.handle;a.runtime.handle=async m=>m.action==='wisdomVersions'?{ok:true,items:[],total:0,page:1,pageSize:10}:a.originalHandle(m);})()`);
  for(const width of [1280,390]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
    await click('[aria-label="智慧"]');await waitFor('!!document.querySelector("dialog[open] textarea")');await button('版本记录');
    await waitFor('document.querySelector("dialog[open] .panel-pager")?.textContent.includes("0 条")');await geometry('empty-wisdom');
    const disabled=await evaluate(`[...document.querySelectorAll('dialog[open] .panel-pager button')].every(b=>b.disabled)`);assert.equal(disabled,true);await close();
  }
  await evaluate(`(()=>{acceptance.runtime.handle=acceptance.originalHandle;delete acceptance.originalHandle;})()`);
  fs.mkdirSync('scratch/knowledge-ui',{recursive:true});fs.writeFileSync('scratch/knowledge-ui/acceptance.json',JSON.stringify(reports,null,2));console.log(JSON.stringify({passed:reports.length,widths:[1280,768,390,320],settings:true,detail:true,create:true,empty:true}));
}finally{await close().catch(()=>{});socket.close();}
