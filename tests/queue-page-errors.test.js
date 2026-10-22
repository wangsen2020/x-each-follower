import test from 'node:test';import assert from 'node:assert/strict';import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {createQueueDiagnostics,QUEUE_DIAGNOSTICS_KEY,QUEUE_NOTICE_GAP} from '../src/features/follow-queue/queue-diagnostics.js';
import {diagnosticUrl,capturePageFailure} from '../src/platform/page-failure.js';
globalThis.IDBKeyRange=IDBKeyRange;
function local(values={}){return {get:async k=>typeof k==='string'?{[k]:values[k]}:{...values},set:async p=>Object.assign(values,structuredClone(p))};}

test('context snapshots redact URL secrets, survive restarts and log every failure while suppressing duplicate notices',async()=>{
 let clock=100000;const values={},logs=[];const api={storage:{local:local(values)},tabs:{get:async()=>({url:'https://x.com/bad?token=SECRET#draft',status:'complete'})}};
 const make=()=>createQueueDiagnostics({api,now:()=>clock,writeLog:async l=>logs.push(l)});const err=new Error('Frame with ID 0 is showing error page https://x.com/bad?token=SECRET Bearer TOKEN');
 const context={stage:'read-posts',accountId:'1',handle:'bad',jobId:'job',requestedUrl:'https://user:pass@x.com/bad?cookie=SECRET',tabId:7};
 const a=await make().record(err,context);clock++;const b=await make().record(err,context);assert.equal(a.notify,true);assert.equal(b.notify,false);assert.equal(b.diagnostic.repeatCount,2);assert.equal(logs.length,2);assert.equal(b.diagnostic.stageLabel,'滚动读取帖子');assert.equal(b.diagnostic.actualUrl,'https://x.com/bad');assert.doesNotMatch(JSON.stringify(values),/SECRET|Bearer TOKEN|user:pass/);assert.equal(values[QUEUE_DIAGNOSTICS_KEY].recent.length,2);
 clock+=QUEUE_NOTICE_GAP;assert.equal((await make().record(err,context)).notify,true);assert.equal(diagnosticUrl('javascript:alert(1)'),'');
});

test('an error-page job settles for retry, logs its target and stage, and the next healthy job still completes',async()=>{
 const values={followQueueBinding:{accountId:'1',handle:'viewer',activated:true,sources:{mutual:true}}};let made=0;const removed=[];
 const api={storage:{local:local(values)},tabs:{query:async()=>[{id:1}],create:async()=>({id:++made+1}),get:async id=>({id,status:'complete',url:id===2?'https://x.com/bad':'https://x.com/healthy'}),remove:async id=>removed.push(id)},alarms:{clear:async()=>{},create:async()=>{},getAll:async()=>[]},
 scripting:{executeScript:async({target,func})=>{if(target.tabId===2)throw new Error('Frame with ID 0 is showing error page');return[{result:func.name==='readQueueViewerOnPage'?'viewer':{pending:false,name:'Healthy',posts:[]}}]}}};
 const store=createFollowQueueStore({indexedDB,IDBKeyRange,dbName:'page-error-'+crypto.randomUUID()});await store.saveSettings('1',{enabled:true,batchLimit:2,inspectLimit:2,grokEnabled:false});
 await store.enqueue({accountId:'1',handle:'bad',targetUserId:'20',sources:[{module:'mutual',enabled:true}]});await store.enqueue({accountId:'1',handle:'healthy',targetUserId:'21',sources:[{module:'mutual',enabled:true}]});
 const runtime=createFollowQueueRuntime({api,store,records:{metadata:async()=>({}),sourcePage:async()=>{throw new Error('Frame with ID 0 is showing error page')},lookupAll:async()=>[]},fetchProfile:async()=>({status:200,json:{rest_id:'21',legacy:{screen_name:'healthy',following:true}}})});const result=await runtime.run();const rows=await store.list({accountId:'1'}),bad=rows.find(r=>r.handle==='bad'),good=rows.find(r=>r.handle==='healthy');assert.equal(bad.state,'retry');assert.equal(bad.lastDiagnostic.handle,'bad');assert.equal(bad.lastDiagnostic.stage,'open-profile');assert.equal(bad.lastDiagnostic.requestedUrl,'https://x.com/bad');assert.equal(good.state,'followed');assert.equal(result.counters.inspected,2);assert.equal(result.counters.alreadyFollowing,1);assert.ok(removed.includes(2)&&removed.includes(3));assert.match(result.summary,/执行日志/);
});

test('outer-cycle failures are localized, persisted and rescheduled; concurrent runs do not corrupt the active context',async()=>{
 const values={followQueueBinding:{accountId:'1',handle:'viewer',activated:true,sources:{mutual:true}}};let release;const gate=new Promise(r=>{release=r});let alarms=0;
 const api={storage:{local:local(values)},tabs:{query:async()=>[{id:1}],get:async()=>({status:'complete',url:'https://x.com/home'})},scripting:{executeScript:async()=>[{result:'viewer'}]},alarms:{clear:async()=>{},getAll:async()=>[],create:async()=>{alarms++;}}};
 const runtime=createFollowQueueRuntime({api,store:{getSettings:async()=>({enabled:true,every:8,jitter:2}),claim:async()=>{await gate;throw new Error('Frame with ID 0 is showing error page')}},records:{metadata:async()=>({}),sourcePage:async()=>({records:[]})}});
 const a=runtime.run();await new Promise(r=>setTimeout(r,1));const busy=await runtime.run();assert.equal(busy.notify,false);release();const result=await a;assert.match(result.summary,/页面加载失败/);assert.equal(result.ok,false);assert.equal(values[QUEUE_DIAGNOSTICS_KEY].recent[0].stage,'run-queue');assert.equal(alarms,1);
});

test('backup reads evict cached error pages and use another tab; writes are not blindly replayed',async()=>{
 const before=globalThis.chrome,closed=[],calls=[];let failWrite=false;const values={};
 globalThis.chrome={storage:{local:local(values)},tabs:{query:async()=>calls.length?[{id:7,status:'complete',url:'https://x.com/bad'},{id:8,status:'complete',url:'https://x.com/home'}]:[{id:7,status:'complete',url:'https://x.com/bad'}],get:async id=>({id,status:'complete',url:'https://x.com/'+(id===7?'bad':'home')}),remove:async id=>closed.push(id)},scripting:{executeScript:async({target,args})=>{calls.push([target.tabId,args[0]]);if(args[0]==='set'&&failWrite||target.tabId===7)throw new Error('Frame with ID 0 is showing error page');return[{result:JSON.stringify({found:true,v:'saved'})}]}}};
 try{const db=await import('../src/platform/persistent-db.js?error-test='+crypto.randomUUID());assert.equal(await db.durableGetStrict('key'),'saved');assert.equal(calls.length,2);assert.deepEqual(calls.map(c=>c[0]),[7,8]);
 failWrite=true;await assert.rejects(db.durableSet('key',{secret:'not logged'}),/error page/);assert.equal(calls.filter(c=>c[1]==='set').length,1);assert.deepEqual(closed,[]);assert.equal(values.xStoragePageFailures[0].operation,'write-backup');assert.doesNotMatch(JSON.stringify(values),/not logged/);
 }finally{globalThis.chrome=before;}
});




test('a page failure after an external checkpoint never replays follow or loses a completed follow',async()=>{
 const {createFollowQueueScheduler}=await import('../src/features/follow-queue/follow-queue-scheduler.js');
 for(const succeeded of [false,true]){const store=createFollowQueueStore({indexedDB,dbName:'effect-'+crypto.randomUUID()});await store.saveSettings('1',{enabled:true,batchLimit:1,inspectLimit:1});const job=await store.enqueue({accountId:'1',handle:'target',targetUserId:'99',sources:[{module:'mutual',enabled:true}]});let calls=0;
 const scheduler=createFollowQueueScheduler({store,execute:async(j,s,c)=>{calls++;await c.checkpoint({stage:succeeded?'followed':'following',followResult:{attemptedAt:Date.now(),...(succeeded?{succeeded:true}:{})}});return{state:'retry',reason:'X页面不可用',diagnostic:{id:'diagnostic',stage:'verify-publication'}}}});await scheduler.run({accountId:'1'});const saved=await store.get(job.id);assert.equal(saved.state,succeeded?'followed':'uncertain');assert.equal(saved.lastDiagnostic.id,'diagnostic');assert.equal(calls,1);}
});

test('publication verification exits on a browser error page and does not reload or resubmit',async()=>{
 const {confirmPublishedQueueQuote}=await import('../src/features/follow-queue/follow-queue-runtime.js');let clock=0,reloads=0;
 const api={tabs:{update:async()=>{},get:async()=>({status:'complete'}),reload:async()=>{reloads++;}},scripting:{executeScript:async()=>{throw new Error('Frame with ID 0 is showing error page')}}};
 await assert.rejects(confirmPublishedQueueQuote({api,tabId:1,handle:'viewer',originalId:'99',text:'sample',after:1,wait:async ms=>{clock+=ms},now:()=>clock}),/error page/);assert.equal(clock,700);assert.equal(reloads,0);
});

test('nonexistent profiles are excluded immediately and source resync never reopens them',async()=>{
 const values={followQueueBinding:{accountId:'1',handle:'viewer',activated:true,sources:{mutual:true}}};let opened=0,closed=0;
 const api={storage:{local:local(values)},tabs:{query:async()=>[{id:1}],create:async()=>({id:++opened+1}),get:async()=>({status:'complete',url:'https://x.com/missing'}),remove:async()=>{closed++;}},alarms:{clear:async()=>{},create:async()=>{},getAll:async()=>[]},scripting:{executeScript:async({func})=>[{result:func.name==='readQueueViewerOnPage'?'viewer':{pending:false,status:'not_found',reason:'此账号不存在',posts:[]}}]}};
 const store=createFollowQueueStore({indexedDB,dbName:'missing-'+crypto.randomUUID()});await store.saveSettings('1',{enabled:true,batchLimit:1,inspectLimit:1,grokEnabled:false});
 const candidate={accountId:'1',handle:'missing',targetUserId:'20',sources:[{module:'mutual',enabled:true}]};await store.enqueue(candidate);
 const runtime=createFollowQueueRuntime({api,store,records:{metadata:async()=>({}),sourcePage:async()=>({records:[]}),lookupAll:async()=>[]},fetchProfile:async()=>assert.fail('must not fetch or follow unavailable account')});
 await runtime.run();const row=(await store.list({accountId:'1'}))[0];assert.equal(row.state,'excluded');assert.equal(row.followResult.availability,'not_found');assert.equal(opened,1);assert.equal(closed,1);
 await store.enqueue(candidate);await runtime.run();assert.equal(opened,1);assert.equal((await store.list({accountId:'1'}))[0].state,'excluded');
});
