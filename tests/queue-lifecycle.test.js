import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueueTabs,startQueueActivity} from '../src/features/follow-queue/queue-lifecycle.js';

function fixture() {
  const data={}, tabs=new Map(), removed=[];
  let id=0, failRemove=false;
  const api={storage:{session:{get:async()=>structuredClone(data),set:async patch=>Object.assign(data,structuredClone(patch))}},
    tabs:{get:async id=>tabs.get(id),remove:async id=>{if(failRemove)throw Error('cannot close');removed.push(id);tabs.delete(id);}}};
  const create=async()=>{const tab={id:++id,url:'https://x.com/target'};tabs.set(id,tab);return tab;};
  return {api,tabs,removed,create,setFail:value=>{failRemove=value;}};
}
test('worker restart closes only registered task tabs and release is idempotent',async()=>{
  const f=fixture(),first=createQueueTabs(f.api);
  f.tabs.set(999,{id:999,url:'https://x.com/target'});
  const tab=await first.acquire('job',f.create);
  await createQueueTabs(f.api).recover();
  assert.deepEqual(f.removed,[tab.id]);assert.ok(f.tabs.has(999));
  await first.release('job');assert.equal(f.removed.length,1);
});
test('close failure retains ownership and prevents duplicate creation',async()=>{
  const f=fixture(),manager=createQueueTabs(f.api);
  await manager.acquire('job',f.create);f.setFail(true);
  await assert.rejects(manager.acquire('job',f.create),/cannot close/);
  assert.equal(f.tabs.size,1);
  f.setFail(false);await createQueueTabs(f.api).recover();assert.equal(f.tabs.size,0);
});
test('transient tab lookup errors retain registration instead of leaking a duplicate',async()=>{
  const f=fixture(),manager=createQueueTabs(f.api);
  await manager.acquire('job',f.create);
  f.api.tabs.get=async()=>{throw Error('browser busy');};
  await assert.rejects(manager.acquire('job',f.create),/browser busy/);
  assert.equal(f.tabs.size,1);
});
test('a tab navigated by its user is relinquished without closing',async()=>{
  const f=fixture(),manager=createQueueTabs(f.api),tab=await manager.acquire('job',f.create);
  f.tabs.get(tab.id).url='https://x.com/home';
  await manager.recover();assert.equal(f.removed.length,0);assert.equal(f.tabs.size,1);
});
test('still-loading owned tabs are closed using pending URL',async()=>{
  const f=fixture(),manager=createQueueTabs(f.api),tab=await manager.acquire('job',f.create);
  Object.assign(f.tabs.get(tab.id),{url:'about:blank',pendingUrl:tab.url});
  await manager.release('job');assert.equal(f.tabs.size,0);
});
test('session registration failure closes the newly created tab',async()=>{
  const f=fixture();f.api.storage.session.set=async()=>{throw Error('storage unavailable');};
  await assert.rejects(createQueueTabs(f.api).acquire('job',f.create),/storage unavailable/);
  assert.equal(f.tabs.size,0);
});
test('active work resets the Chrome idle timer and stops when finished',async()=>{
  let tick,cleared,calls=0;
  const stop=startQueueActivity({runtime:{getPlatformInfo:async()=>{calls++;}}},
    {setInterval:(fn,ms)=>{tick=fn;assert.equal(ms,20000);return 7;},clearInterval:id=>{cleared=id;}});
  assert.equal(calls,1);tick();assert.equal(calls,2);stop();assert.equal(cleared,7);
});
