import test from 'node:test';
import assert from 'node:assert/strict';
import {requestBackground} from '../src/platform/background-request.js';
import {createPanelScanListener, finishScheduledPanel} from '../src/platform/panel-scan-messages.js';
import {enqueuePendingFans, fanEnqueueSummary} from '../src/features/relationships/fan-auto-enqueue.js';

const noReceiver='Could not establish connection. Receiving end does not exist.';
const closed='A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';
test('only proven undelivered messages retry, closed channels never repeat a possibly completed write',async()=>{
  for(const text of [noReceiver,closed,'Extension context invalidated.']){
    let calls=0,logs=0;await assert.rejects(requestBackground({cmd:'followQueueEnqueue'},{api:{runtime:{sendMessage:async()=>{calls++;throw Error(text);}}},report:async()=>{logs++;},minTimeout:1}),new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.equal(calls,text===noReceiver?3:1);assert.equal(logs,1);
  }
  let calls=0;assert.deepEqual(await requestBackground({cmd:'recordData'},{api:{runtime:{sendMessage:async()=>{if(!calls++)throw Error(noReceiver);return {ok:true};}}},minTimeout:1}),{ok:true});assert.equal(calls,2);
});

test('scan listeners reply on mismatch and lookup failure, dispatch only the target, isolate rejected scans',async()=>{
  for(const mode of ['other','missing','target']){
    let calls=0;const responses=[],errors=[];
    const listener=createPanelScanListener({api:{tabs:{getCurrent:async()=>{if(mode==='missing')throw Error('gone');return {id:mode==='other'?2:1};}}},scan:async()=>{calls++;throw Error('scan failed');},report:error=>errors.push(error.message)});
    assert.equal(listener({cmd:'unrelated'},{},()=>assert.fail()),false);
    assert.equal(listener({cmd:'runFollowersScanTick',targetPanelTabId:1},{},r=>responses.push(r)),true);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(responses.length,1);assert.equal(calls,mode==='target'?1:0);assert.equal(responses[0].ok,mode==='target');assert.equal(errors.length,mode==='other'?0:1);
  }
});

test('invalidated context and a broken diagnostics callback cannot leave an unhandled listener rejection',async()=>{
  const replies=[];
  const listener=createPanelScanListener({api:{tabs:{getCurrent(){throw Error('Extension context invalidated');}}},scan:()=>assert.fail(),report:async()=>{throw Error('logger unavailable');}});
  assert.equal(listener({cmd:'runFollowersScanTick'},{},reply=>replies.push(reply)),true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(replies.length,1);assert.equal(replies[0].ok,false);
});

test('scheduled tab acknowledges before removal and rejects forged/non-scheduled requests',async()=>{
  const events=[],api={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p},tabs:{remove:async id=>events.push(['remove',id])}};
  const sender={id:'test',tab:{id:4,url:'chrome-extension://test/panel.html?scheduledFollowers=abc'}};
  assert.equal(finishScheduledPanel({token:'abc'},sender,r=>events.push(['reply',r.ok]),api),false);
  assert.deepEqual(events,[['reply',true]]);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(events,[['reply',true],['remove',4]]);
  for(const invalid of [{...sender,id:'other'},{...sender,tab:{...sender.tab,url:'chrome-extension://test/panel.html?scheduledFollowers=other'}},{...sender,tab:{...sender.tab,url:'chrome-extension://test/panel.html'}}]){
    assert.equal(finishScheduledPanel({token:'abc'},invalid,r=>assert.equal(r.ok,false),api),false);
  }
  assert.equal(events.length,2);
});

test('fan enqueue feedback distinguishes disabled, empty, confirmed, refused and uncertain results',async()=>{
  const users=[{handle:'a',id:'123'},{handle:'b'}],report=async()=>{};
  for(const [request,status] of [[async()=>({ok:true,count:0,jobs:[]}),'confirmed'],[async()=>({ok:false,error:'source disabled'}),'failed'],[async()=>undefined,'uncertain'],[async()=>{throw Error(noReceiver);},'failed'],[async()=>{throw Error(closed);},'uncertain']]){
    const result=await enqueuePendingFans(users,{request,report});assert.equal(result.status,status);assert.equal(result.count,0);assert.ok(!fanEnqueueSummary(result).includes('已在关注队列中'));
  }
  assert.equal((await enqueuePendingFans(users,{enabled:false})).status,'disabled');assert.equal((await enqueuePendingFans([])).status,'empty');
  const success=await enqueuePendingFans(users,{request:async message=>{assert.equal(message.candidates[0].targetUserId,'123');return {ok:true,count:1,jobs:[{handle:'a'}]};}});assert.deepEqual(success.handles,['a']);assert.equal(success.count,1);assert.match(fanEnqueueSummary(success),/已确认 1/);
});
