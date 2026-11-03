import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {createSystemExceptionStore, redactExceptionText, normalizeSystemException, reportSystemException, flushPendingExceptions, installExceptionCapture, EXCEPTION_PENDING} from '../src/shared/system-exceptions.js';

const makeStore = options => createSystemExceptionStore({name:crypto.randomUUID(),indexedDB,IDBKeyRange,...options});
function storageFixture(){const data={};return {data,get:async()=>structuredClone(data),set:async values=>Object.assign(data,structuredClone(values)),remove:async keys=>{for(const key of [keys].flat())delete data[key];}};}

test('redacts credentials and URL secrets without serializing arbitrary objects',()=>{
  const entry=normalizeSystemException({message:'Bearer TOPSECRET token="HIDDEN" api_key=PRIVATE cookie=sessionsecret https://grok.com/webhook/automation/SECRET?key=QUERY#fragment',stack:'at chrome-extension://id/panel.js?token=VALUE:1:2',payload:{token:'never-store'}});
  const text=JSON.stringify(entry);
  for(const secret of ['TOPSECRET','HIDDEN','PRIVATE','sessionsecret','SECRET','QUERY','VALUE','never-store'])assert.ok(!text.includes(secret),secret);
  assert.match(entry.stack,/panel.js/);assert.ok(!('payload' in entry));
  assert.equal(redactExceptionText('x'.repeat(20000),100).length,100);
});

test('Dexie serializes concurrent writers, limits retained rows and preserves records after reopen',async()=>{
  let now=Date.now();const name=crypto.randomUUID(),options={name,indexedDB,IDBKeyRange,now:()=>now,limit:5};
  const first=createSystemExceptionStore(options),second=createSystemExceptionStore(options);
  await Promise.all(Array.from({length:12},(_,i)=>(i%2?first:second).append({id:String(i),at:now+i,message:'error '+i,source:i%2?'panel':'background'})));
  assert.equal((await first.list()).length,5);first.close();second.close();
  const reopened=createSystemExceptionStore(options);assert.equal((await reopened.list()).length,5);
  now+=8*86400000;assert.equal((await reopened.list()).length,0);reopened.close();
});

test('pending fallback survives background/storage outage, replay is idempotent and clear is durable',async()=>{
  const storage=storageFixture(),store=makeStore();
  assert.equal(await reportSystemException({id:'pending',message:'token=private'},{store:{append:async()=>{throw Error('unavailable');}},storage}),true);
  assert.equal(Object.keys(storage.data).length,1);assert.ok(!JSON.stringify(storage.data).includes('private'));
  await flushPendingExceptions({store,storage});assert.equal((await store.list()).length,1);assert.equal(Object.keys(storage.data).length,0);
  await store.append({id:'pending',message:'same'});assert.equal((await store.list()).length,1);
  await store.clear();assert.equal((await store.list()).length,0);store.close();
  const broken={append:async()=>{throw Error('db');}};
  assert.equal(await reportSystemException({message:'error'},{store:broken,storage:{set:async()=>{throw Error('disk');}}}),false);
});

test('fallback retention cannot grow indefinitely and old entries are discarded',async()=>{
  const storage=storageFixture();for(let i=0;i<105;i++)storage.data[EXCEPTION_PENDING+i]={id:String(i),at:Date.now()-i};
  await reportSystemException({message:'latest'},{store:{append:async()=>{throw Error('offline');}},storage});
  assert.equal(Object.keys(storage.data).length,100);
  storage.data[EXCEPTION_PENDING+'old']={at:Date.now()-8*86400000};
  const store=makeStore();await flushPendingExceptions({store,storage});assert.equal((await store.list()).length,100);store.close();
});

test('capture catches errors, promises and warnings once, tolerates failed logger, and restores console',async()=>{
  const listeners=new Map(),calls=[],original=()=>{};const target={location:{href:'chrome-extension://id/panel.html'},console:{warn:original,error:original},addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)};
  const dispose=installExceptionCapture({source:'panel',target,report:entry=>{calls.push(entry);return Promise.reject(Error('logger failed'));}});
  assert.equal(installExceptionCapture({source:'panel',target}),dispose);
  listeners.get('error')({message:'boom',error:Error('boom')});listeners.get('unhandledrejection')({reason:Error('async')});target.console.warn('warn',{token:'must not log'},Error('detail'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,3);assert.equal(calls[2].level,'warning');assert.ok(!calls[2].message.includes('token'));
  dispose();assert.equal(target.console.warn,original);assert.equal(listeners.size,0);
});
