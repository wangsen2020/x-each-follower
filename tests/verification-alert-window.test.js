import test from 'node:test';
import assert from 'node:assert/strict';
import {centeredAlertBounds,showVerificationAlert,markVerificationAlertClosed,focusVerificationPage,closeVerificationAlert} from '../src/entries/verification/verification-alert-window.js';

test('alert centers on its monitor including negative coordinates and small work areas',()=>{
  assert.deepEqual(centeredAlertBounds({left:0,top:0,width:1920,height:1040}),{left:670,top:150,width:580,height:740});
  assert.deepEqual(centeredAlertBounds({left:-1920,top:0,width:1920,height:1040}),{left:-1250,top:150,width:580,height:740});
  assert.deepEqual(centeredAlertBounds({left:0,top:0,width:360,height:600}),{left:0,top:0,width:360,height:600});
});

test('one focused popup is reused; explicit dismissal prevents later automatic reopening',async()=>{
  let session={},created=[],focused=[],exists=true;
  const notice={tabId:8,at:'2026-10-18T10:00:00Z'};
  const api={runtime:{getURL:p=>'chrome-extension://test/'+p},
    storage:{local:{get:async()=>({grokVerification:notice})},session:{get:async()=>session,set:async data=>Object.assign(session,data)}},
    scripting:{executeScript:async()=>[{result:{left:0,top:0,width:1920,height:1040}}]},
    windows:{create:async options=>{created.push(options);return {id:7};},update:async(id,options)=>focused.push([id,options]),get:async()=>{if(!exists)throw Error('closed');return {id:7};}}};
  assert.equal((await showVerificationAlert({api})).shown,true);
  assert.equal(created[0].focused,true);assert.equal(created[0].left,670);assert.equal(created[0].top,150);
  assert.equal((await showVerificationAlert({api})).reused,true);
  assert.equal(created.length,1);
  await markVerificationAlertClosed(7,api);exists=false;
  assert.equal((await showVerificationAlert({api})).dismissed,true);
  assert.equal(created.length,1);
  assert.equal((await showVerificationAlert({api,force:true})).shown,true);
  assert.equal(created.length,2);
});

test('verification action focuses the exact saved X tab and refuses unrelated navigation',async()=>{
  const calls=[];let url='https://x.com/i/grok';
  const api={storage:{local:{get:async()=>({grokVerification:{tabId:8}})}},tabs:{get:async()=>({id:8,windowId:7,url}),update:async id=>calls.push(id)},windows:{update:async id=>calls.push(id)}};
  assert.equal((await focusVerificationPage(api)).ok,true);assert.deepEqual(calls,[7,8]);
  url='https://example.com';await assert.rejects(focusVerificationPage(api));assert.deepEqual(calls,[7,8]);
});

test('resumption closes only the matching owned alert and drops its record',async()=>{
 let saved={grokVerificationAlertWindow:{at:'current',windowId:7}},closed=[];
 const api={runtime:{getURL:p=>'chrome-extension://test/'+p},storage:{session:{get:async()=>saved,remove:async k=>delete saved[k]}},windows:{get:async()=>({id:7,tabs:[{url:'chrome-extension://test/verification-alert.html'}]}),remove:async id=>closed.push(id)}};
 await closeVerificationAlert('old',api);assert.deepEqual(closed,[]);
 await closeVerificationAlert('current',api);assert.deepEqual(closed,[7]);assert.equal(saved.grokVerificationAlertWindow,undefined);
});
