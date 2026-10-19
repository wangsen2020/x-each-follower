import test from 'node:test';
import assert from 'node:assert/strict';
import {detectGrokVerificationOnPage,assertGrokVerificationClear,assertPendingGrokVerificationClear,executeGrokScript,waitForGrokVerification,isGrokInputReadyOnPage} from '../grok-verification.js';

test('challenge detection does not flag normal Grok discussion about Cloudflare',()=>{
  const previous={document:globalThis.document,location:globalThis.location};
  try {
    globalThis.location={hostname:'grok.com',href:'https://grok.com/'};
    globalThis.document={title:'Grok',body:{innerText:'Cloudflare may ask you to verify you are human'},querySelector:selector=>selector.startsWith('textarea')?{}:null};
    assert.equal(detectGrokVerificationOnPage(),null);
    globalThis.document={title:'Just a moment...',body:{innerText:'Verify you are human. Cloudflare'},querySelector:()=>null};
    assert.equal(detectGrokVerificationOnPage().host,'grok.com');
    globalThis.location={hostname:'example.com'};
    assert.equal(detectGrokVerificationOnPage(),null);
  } finally {Object.assign(globalThis,previous);}
});

test('challenge stops task, notifies once, preserves window and clears after manual verification',async()=>{
  const prior=globalThis.chrome;let challenge=true,notifications=0,focused=0,removed=[],saved={};
  globalThis.chrome={runtime:{getURL:path=>'chrome-extension://test/'+path},
    scripting:{executeScript:async()=>[{result:challenge?{host:'grok.com',url:'https://grok.com/'}:null}]},
    storage:{local:{get:async()=>saved,set:async data=>Object.assign(saved,data),remove:async key=>delete saved[key]},session:{remove:async key=>removed.push(key)}},
    tabs:{get:async()=>({windowId:7}),update:async()=>{}},windows:{update:async()=>{focused++;}},
    notifications:{create:async()=>{notifications++;}}};
  try {
    await assert.rejects(assertGrokVerificationClear(8),error=>error.userActionRequired===true);
    await assert.rejects(assertGrokVerificationClear(8));
    assert.equal(notifications,1);assert.equal(focused,1);
    assert.equal(saved.grokVerification.tabId,8);

    assert.ok(removed.includes('xfTemporaryWindow:7'));

    challenge=false;await assertGrokVerificationClear(8);
    assert.equal(saved.grokVerification,undefined);
  } finally {globalThis.chrome=prior;}
});


function page({title='Grok',text='Hello',nodes=[],composer=null,composers=null,href='https://grok.com/'}={}){
  globalThis.location={hostname:'grok.com',href};
  const edits=composers||(composer?.tag==='editable'?[composer]:[]);
  const areas=composers?composers.filter(node=>node.tag==='textarea'):(composer?.tag==='textarea'?[composer]:[]);
  const all=selector=>{
    if(selector==='iframe')return nodes.filter(node=>node.tag==='iframe');
    if(selector==='textarea')return areas;
    if(selector.includes('contenteditable'))return edits;
    if(selector.includes('arkose'))return nodes.filter(node=>node.arkose);
    if(selector.includes('challenge')||selector.includes('cf-browser'))return nodes.filter(node=>node.challengeDom);
    return [];
  };
  globalThis.document={title,body:{innerText:text},querySelector:selector=>all(selector)[0]||null,querySelectorAll:all};
}
function frame(src,{width=300,height=65,hidden=false,parentElement=null,style=null}={}){
  return {tag:'iframe',src,hidden,parentElement,style,getAttribute:()=>src,getBoundingClientRect:()=>({width,height})};
}
test('ordinary frames, residual fields, spoof urls and mentions do not trigger',()=>{
  const previous={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle};
  globalThis.getComputedStyle=node=>node?.style||{display:'block',visibility:'visible',opacity:'1'};
  try {
    page({nodes:[frame('https://grok.com/pay/frame')]});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({nodes:[frame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/x',{style:{display:'none',visibility:'visible',opacity:'1'}})]});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({nodes:[frame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/x',{parentElement:{style:{display:'block',visibility:'visible',opacity:'0'}}})]});
    assert.equal(detectGrokVerificationOnPage(),null);
    for (const src of ['https://challenges.cloudflare.com.evil.test/cdn-cgi/challenge-platform/h/g/turnstile/x','https://evil.test/?next=https://challenges.cloudflare.com/cdn-cgi/challenge-platform/','https://notcloudflare.com/turnstile/','http://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/x','https://challenges.cloudflare.com/cdn-cgi/challenge-platform-evil/x','https://challenges.cloudflare.com/turnstile-evil']) {
      page({nodes:[frame(src)]});
      assert.equal(detectGrokVerificationOnPage(),null,src);
    }
    page({nodes:[{tag:'input',getBoundingClientRect:()=>({width:0,height:0}),hidden:true,value:''},{challengeDom:true,hidden:true,getBoundingClientRect:()=>({width:100,height:40}),value:'filled-token'}]});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({text:'Cloudflare may ask you to verify you are human',composer:{tag:'textarea'}});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({title:'Grok',text:'请完成安全验证只是回答里的一句话',composer:{tag:'editable'}});
    assert.equal(detectGrokVerificationOnPage(),null);
  } finally {Object.assign(globalThis,previous);}
});
test('active Cloudflare widget, whole-page challenges and Arkose return sanitized evidence',()=>{
  const previous={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle};
  globalThis.getComputedStyle=node=>node?.style||{display:'block',visibility:'visible',opacity:'1'};
  try {
    page({href:'https://grok.com/chat?token=secret',nodes:[frame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/abc?token=raw')]});
    const widget=detectGrokVerificationOnPage();
    assert.equal(widget.provider,'cloudflare');
    assert.deepEqual(widget.signals,['cf-challenge-iframe']);
    assert.equal(widget.url,'https://grok.com/chat');
    assert.equal(JSON.stringify(widget).includes('secret')||JSON.stringify(widget).includes('raw'),false);
    page({title:'Just a moment...',text:'Verify you are human'});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({title:'Just a moment...',text:'Verify you are human\nPerformance & security by Cloudflare'});
    assert.equal(detectGrokVerificationOnPage().signals[0],'cf-page-title');
    page({title:'请稍候…',text:'grok.com\n正在进行安全验证\n本网站使用安全服务防护恶意自动程序。在验证您不是自动程序期间，将显示此页面。\nRay ID: omit\n由 Cloudflare 提供的性能和安全服务\n隐私',nodes:[]});
    const zh=detectGrokVerificationOnPage();
    assert.equal(zh.provider,'cloudflare');
    assert.deepEqual(zh.signals,['cf-page-title']);
    assert.match(zh.reason,/Cloudflare/);
    page({title:'Grok',text:'Cloudflare may ask you to verify you are human'});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({title:'Grok',text:'Verify you are human',nodes:[{challengeDom:true,hidden:false,getBoundingClientRect:()=>({width:40,height:40})}]});
    const domOnly=detectGrokVerificationOnPage();
    assert.deepEqual(domOnly.signals,['cf-page-dom']);
    assert.equal(domOnly.signals.includes('cf-page-title'),false);
    page({nodes:[{challengeDom:true,hidden:false,getBoundingClientRect:()=>({width:40,height:40})}]});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({title:'请稍候…',text:'由 Cloudflare 提供的性能和安全服务',nodes:[{challengeDom:true,hidden:false,getBoundingClientRect:()=>({width:40,height:40})}]});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({title:'请稍候…',text:'正在进行安全验证\n由 Cloudflare 提供的性能和安全服务',nodes:[{challengeDom:true,hidden:false,getBoundingClientRect:()=>({width:40,height:40})}]});
    assert.ok(detectGrokVerificationOnPage().signals.includes('cf-page-dom'));
    page({title:'请稍候…',text:'Verify you are human\nCloudflare',composer:{tag:'textarea',getBoundingClientRect:()=>({width:240,height:40}),parentElement:{style:{display:'block',visibility:'visible',opacity:'0'}}}});
    assert.equal(detectGrokVerificationOnPage().signals[0],'cf-page-title');
    page({title:'Just a moment...',text:'Verify you are human',composers:[{tag:'editable',style:{display:'none',visibility:'visible',opacity:'1'},getBoundingClientRect:()=>({width:0,height:0})},{tag:'editable',getBoundingClientRect:()=>({width:240,height:40})}]});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({title:'Just a moment...',text:'Verify you are human',composer:{tag:'textarea',getBoundingClientRect:()=>({width:200,height:40})}});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({nodes:[frame('https://client-api.arkoselabs.com/fc/api/')]});
    const arkose=detectGrokVerificationOnPage();
    assert.equal(arkose.provider,'arkose');
    assert.equal(JSON.stringify(arkose).includes('cloudflare'),false);
    page({nodes:[{arkose:true,tag:'div',hidden:false,getBoundingClientRect:()=>({width:300,height:400})}]});
    assert.equal(detectGrokVerificationOnPage(),null);
    page({nodes:[{arkose:true,tag:'iframe',src:'https://client-api.arkoselabs.com/v2/frame',hidden:false,getAttribute:()=>'https://client-api.arkoselabs.com/v2/frame',getBoundingClientRect:()=>({width:300,height:400})}]});
    assert.ok(detectGrokVerificationOnPage().signals.includes('arkose-widget'));
    page({nodes:[{arkose:true,tag:'iframe',src:'https://evil.test/widget',hidden:false,getAttribute:()=>'https://evil.test/widget',getBoundingClientRect:()=>({width:300,height:400})}]});
    assert.equal(detectGrokVerificationOnPage(),null);
  } finally {Object.assign(globalThis,previous);}
});
test('pause before script, wait for editable input, resume once and clear notice',async()=>{
  const prior=globalThis.chrome;let challenge=true,ready=false,notifications=0,runs=0,saved={};
  globalThis.chrome={runtime:{getURL:p=>p},
    scripting:{executeScript:async o=>{
      if(o.func===detectGrokVerificationOnPage)return [{result:challenge?{host:'grok.com',url:'https://grok.com/'}:null}];
      if(o.func===isGrokInputReadyOnPage)return [{result:ready}];
      runs++;return [{result:'resumed'}];
    }},
    storage:{local:{get:async()=>saved,set:async d=>Object.assign(saved,d),remove:async k=>delete saved[k]},session:{remove:async()=>{}}},
    tabs:{get:async()=>({windowId:7}),update:async()=>{}},windows:{update:async()=>{}},
    notifications:{create:async()=>{notifications++;},clear:async()=>{}}};
  try {
    const waiter=waitForGrokVerification(8,{intervalMs:5,timeoutMs:200});
    const execution=executeGrokScript({target:{tabId:8},func:()=>{}});
    await new Promise(r=>setTimeout(r,20));assert.equal(runs,0);
    challenge=false;await new Promise(r=>setTimeout(r,20));assert.equal(runs,0);assert.ok(saved.grokVerification);
    ready=true;await waiter;assert.equal((await execution)[0].result,'resumed');
    assert.equal(runs,1);assert.equal(notifications,1);assert.equal(saved.grokVerification,undefined);
    challenge=true;
    await assert.rejects(waitForGrokVerification(8,{intervalMs:5,timeoutMs:20}),/超时/);
  } finally {globalThis.chrome=prior;}
});

test('a pending script result is held during verification without re-executing it',async()=>{
  const prior=globalThis.chrome;let challenge=false,ready=true,runs=0,saved={},finished=false;
  globalThis.chrome={runtime:{getURL:p=>p},scripting:{executeScript:async o=>{
    if(o.func===detectGrokVerificationOnPage)return [{result:challenge?{host:'grok.com'}:null}];
    if(o.func===isGrokInputReadyOnPage)return [{result:ready}];
    runs++;await new Promise(r=>setTimeout(r,1100));return [{result:'once'}];
  }},storage:{local:{get:async()=>saved,set:async d=>Object.assign(saved,d),remove:async k=>delete saved[k]},session:{remove:async()=>{}}},tabs:{get:async()=>({windowId:7}),update:async()=>{}},windows:{update:async()=>{}},notifications:{create:async()=>{},clear:async()=>{}}};
  try {
    const task=executeGrokScript({target:{tabId:8},func:()=>{}}).then(r=>{finished=true;return r;});
    await new Promise(r=>setTimeout(r,50));challenge=true;ready=false;
    await new Promise(r=>setTimeout(r,1200));assert.equal(finished,false);assert.equal(runs,1);
    challenge=false;ready=true;assert.equal((await task)[0].result,'once');assert.equal(runs,1);
  } finally {globalThis.chrome=prior;}
});

test('evidence is stored once and execution log is not repeated while the challenge remains',async()=>{
  const prior=globalThis.chrome;let saved={},logs=0;
  globalThis.chrome={runtime:{getURL:path=>'chrome-extension://test/'+path,sendMessage:()=>Promise.resolve()},
    scripting:{executeScript:async()=>[{result:{provider:'cloudflare',signals:['cf-challenge-iframe'],reason:'当前页是 Cloudflare 安全验证页且聊天输入框不可用，任务已暂停',host:'grok.com',url:'https://grok.com/'}}]},
    storage:{local:{get:async()=>saved,set:async data=>Object.assign(saved,data),remove:async key=>delete saved[key]},session:{remove:async()=>{}}},
    tabs:{get:async()=>({windowId:7}),update:async()=>{}},windows:{update:async()=>{}},
    notifications:{create:async()=>{}}};
  try {
    await assert.rejects(assertGrokVerificationClear(8));
    await assert.rejects(assertGrokVerificationClear(8));
    assert.equal(saved.grokVerification.provider,'cloudflare');
    assert.deepEqual(saved.grokVerification.signals,['cf-challenge-iframe']);
    assert.equal(saved.autoFollowLogs.length,1);
    assert.match(saved.autoFollowLogs[0].detail,/Cloudflare/);
    assert.match(saved.autoFollowLogs[0].detail,/cf-challenge-iframe/);
    assert.equal(saved.autoFollowLogs[0].scope,'verification');
    assert.equal(saved.autoFollowLogs[0].result,'paused');
    logs=saved.autoFollowLogs.length;
    await assert.rejects(assertGrokVerificationClear(8));
    assert.equal(saved.autoFollowLogs.length,logs);
  } finally {globalThis.chrome=prior;}
});

test('evidence changes keep the first notice time and do not alert again',async()=>{
  const prior=globalThis.chrome;const previous={location:globalThis.location,document:globalThis.document,window:globalThis.window};
  let saved={grokVerification:{tabId:8,windowId:7,at:'2026-10-01T00:00:00.000Z',provider:'cloudflare'}};
  let focused=0,signals=['cf-challenge-iframe'];
  const messages=[];
  globalThis.chrome={runtime:{getURL:path=>'chrome-extension://test/'+path,sendMessage:async message=>{messages.push(message);return {ok:true,logs:[]};}},
    scripting:{executeScript:async()=>[{result:{provider:'cloudflare',signals,reason:'当前页是 Cloudflare 安全验证页且聊天输入框不可用，任务已暂停',host:'grok.com',url:'https://grok.com/'}}]},
    storage:{local:{get:async()=>saved,set:async data=>Object.assign(saved,data),remove:async key=>delete saved[key]},session:{remove:async()=>{}}},
    tabs:{get:async()=>({windowId:7}),update:async()=>{}},windows:{update:async()=>{focused++;}},
    notifications:{create:async()=>{notices++;}}};
  try {
    await assert.rejects(assertGrokVerificationClear(8));
    assert.equal(saved.grokVerification.at,'2026-10-01T00:00:00.000Z');
    assert.equal(saved.autoFollowLogs.length,1);
    assert.match(saved.autoFollowLogs[0].detail,/cf-challenge-iframe Cloudflare 验证框/);
    assert.equal(messages.length,0);assert.equal(focused,0);
    signals=['cf-challenge-iframe','arkose-widget'];
    await assert.rejects(assertGrokVerificationClear(8));
    assert.equal(saved.grokVerification.at,'2026-10-01T00:00:00.000Z');
    assert.equal(saved.autoFollowLogs.length,1);
    assert.match(saved.autoFollowLogs[0].detail,/arkose-widget/);
    assert.equal(saved.autoFollowLogs[0].at,'2026-10-01T00:00:00.000Z');
    assert.equal(messages.length,0);assert.equal(focused,0);
    delete globalThis.window;delete globalThis.document;
    globalThis.location={protocol:'chrome-extension:',pathname:'/panel.html',href:'chrome-extension://test/panel.html'};
    globalThis.document={};
    globalThis.window={document:globalThis.document};
    const before=saved.autoFollowLogs.length;
    await assert.rejects(assertGrokVerificationClear(9));
    assert.equal(saved.autoFollowLogs.length,before);
    assert.equal(messages.filter(message=>message.cmd==='appendExecutionLog').length,1);
    assert.equal(messages.filter(message=>message.cmd==='notifyGrokVerificationSelf').length,1);
  } finally {globalThis.chrome=prior;Object.assign(globalThis,previous);if(previous.window===undefined)delete globalThis.window;}
});

test('concurrent detections log and alert once',async()=>{
  const prior=globalThis.chrome;let saved={},opened=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  globalThis.chrome={runtime:{getURL:()=>'icon128.png',sendMessage:async()=>{}},
    scripting:{executeScript:async()=>[{result:{provider:'cloudflare',signals:['cf-challenge-iframe'],reason:'当前页是 Cloudflare 安全验证页且聊天输入框不可用，任务已暂停',host:'grok.com',url:'https://grok.com/'}}]},
    storage:{local:{get:async()=>{await gate;return {...saved};},set:async data=>Object.assign(saved,data)},session:{remove:async()=>{}}},
    tabs:{get:async()=>({windowId:7}),update:async()=>{}},windows:{update:async()=>{opened++;}},
    notifications:{create:async()=>{opened++;}}};
  try {
    const both=Promise.allSettled([assertGrokVerificationClear(8),assertGrokVerificationClear(8)]);
    release();
    await both;
    assert.equal(saved.autoFollowLogs.length,1);
    assert.equal(opened,2);
  } finally {globalThis.chrome=prior;}
});

test('resume restores the owned window to its pool and refreshes its execution lease',async()=>{
 const {resumeTemporaryWindowAfterVerification}=await import('../temporary-windows.js');
 const prior=globalThis.chrome;const key='xfTemporaryWindow:7';const data={[key]:{windowId:7,tabId:8,kind:'verification',previousKind:'grok-pool',busyUntil:0}};
 globalThis.chrome={storage:{session:{get:async()=>data,set:async d=>Object.assign(data,d)},local:{set:async()=>{}}}};
 try {
  await resumeTemporaryWindowAfterVerification(7,9);assert.equal(data[key].kind,'verification');
  await resumeTemporaryWindowAfterVerification(7,8);assert.equal(data[key].kind,'grok-pool');assert.ok(data[key].busyUntil>Date.now());assert.equal(data[key].previousKind,undefined);
 }finally{globalThis.chrome=prior;}
});

test('full-page Cloudflare fails as timeout without waiting, focus, notifications or manual verification state',async()=>{
 const prior=globalThis.chrome;const saved={};let alerts=0,focus=0;
 globalThis.chrome={runtime:{getURL:p=>p,sendMessage:async()=>{alerts++;}},
  storage:{local:{get:async()=>saved,set:async v=>Object.assign(saved,v),remove:async k=>delete saved[k]}},
  scripting:{executeScript:async()=>[{result:{provider:'cloudflare',signals:['cf-page-title'],reason:'CF verification'}}]},
  windows:{update:async()=>{focus++;}},tabs:{update:async()=>{focus++;}},notifications:{create:async()=>{alerts++;}}};
 try {
  for(let i=0;i<2;i++)await assert.rejects(waitForGrokVerification(8),e=>e.grokVerificationTimeout===true&&!e.userActionRequired&&/超时失败/.test(e.message));
  assert.equal(saved.grokVerification,undefined);assert.equal(saved.grokVerificationFailure.provider,'cloudflare');
  assert.equal(saved.autoFollowLogs.length,1);assert.equal(saved.autoFollowLogs[0].result,'failed');
  assert.equal(alerts,0);assert.equal(focus,0);
 }finally{globalThis.chrome=prior;}
});

test('a stale full-page Cloudflare notice does not keep a cleared page waiting for manual verification',async()=>{
 const prior=globalThis.chrome;const saved={grokVerification:{tabId:8,provider:'cloudflare',signals:['cf-page-title']}};
 globalThis.chrome={storage:{local:{get:async()=>saved,remove:async k=>delete saved[k]}},scripting:{executeScript:async()=>[{result:null}]}};
 try {await waitForGrokVerification(8,{timeoutMs:1});assert.equal(saved.grokVerification,undefined);}finally{globalThis.chrome=prior;}
});
