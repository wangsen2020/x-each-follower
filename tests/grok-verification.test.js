import test from 'node:test';
import assert from 'node:assert/strict';
import {detectGrokVerificationOnPage,assertGrokVerificationClear,assertPendingGrokVerificationClear,executeGrokScript,waitForGrokVerification,isGrokInputReadyOnPage} from '../grok-verification.js';

test('challenge detection does not flag normal Grok discussion about Cloudflare',()=>{
  const previous={document:globalThis.document,location:globalThis.location};
  try {
    globalThis.location={hostname:'grok.com',href:'https://grok.com/'};
    globalThis.document={title:'Grok',body:{innerText:'Cloudflare may ask you to verify you are human'},querySelector:selector=>selector.startsWith('textarea')?{}:null};
    assert.equal(detectGrokVerificationOnPage(),null);
    globalThis.document={title:'Just a moment...',body:{innerText:'Verify you are human'},querySelector:()=>null};
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


test('language-independent iframe and external Turnstile field are detected',()=>{
  const previous={document:globalThis.document,location:globalThis.location};
  try {
    globalThis.location={hostname:'grok.com',href:'https://grok.com/'};
    for(const marker of ['input[name="cf-turnstile-response"]']) {
      globalThis.document={title:'',body:{innerText:'Andere Sprache'},querySelector:s=>s.split(',').includes(marker)?{}:null};
      assert.equal(detectGrokVerificationOnPage().host,'grok.com');
    }
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

test('visible frames pause but hidden payment frames do not block a healthy chat',()=>{
 const previous={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle};
 try {
  globalThis.location={hostname:'grok.com',href:'https://grok.com/'};
  globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
  let size={width:884,height:1};
  globalThis.document={title:'Grok',body:{innerText:'Hello'},querySelector:()=>null,querySelectorAll:()=>[{getBoundingClientRect:()=>size}]};
  assert.equal(detectGrokVerificationOnPage(),null);
  size={width:300,height:65};assert.equal(detectGrokVerificationOnPage().host,'grok.com');
  globalThis.getComputedStyle=()=>({display:'none',visibility:'visible'});assert.equal(detectGrokVerificationOnPage(),null);
 } finally {Object.assign(globalThis,previous);}
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
