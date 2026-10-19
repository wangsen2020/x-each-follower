import test from 'node:test';import assert from 'node:assert/strict';
import {createTemporaryWindow,closeTemporaryWindow,scanTemporaryWindows,TEMP_WINDOW_TTL,ensureTemporaryWindowCleanup,TEMP_WINDOW_ALARM,handleGrokWindowPool,GROK_IDLE_TTL} from '../temporary-windows.js';
function fixture(){let seq=0;const records={},windows=new Map(),removed=[],alarms=[];
 globalThis.chrome={storage:{session:{get:async()=>structuredClone(records),set:async data=>Object.assign(records,data),remove:async key=>delete records[key]}},windows:{create:async()=>{const w={id:++seq,type:'popup',focused:false,tabs:[{id:seq*10,url:'https://x.com/i/grok'}]};windows.set(w.id,w);return w;},getAll:async()=>[...windows.values()],remove:async id=>{removed.push(id);windows.delete(id);}},tabs:{update:async()=>{}},alarms:{create:async(...a)=>alarms.push(a)}};
 return {records,windows,removed,alarms};}
test('expired owned popup closes, fresh and unrelated windows remain',async()=>{const f=fixture();const old=await createTemporaryWindow({},'grok'),fresh=await createTemporaryWindow({},'quote');f.records['xfTemporaryWindow:'+old.id].expiresAt=0;f.windows.set(999,{id:999,type:'popup',focused:false,tabs:[{id:9990,url:'https://grok.com/'}]});const result=await scanTemporaryWindows();assert.deepEqual(result.closed,[old.id]);assert.ok(f.windows.has(fresh.id));assert.ok(f.windows.has(999));assert.equal(f.records['xfTemporaryWindow:'+old.id],undefined);});
test('user-modified and focused windows are protected; missing records cleaned',async()=>{const f=fixture();for(let i=0;i<5;i++)await createTemporaryWindow({});for(const r of Object.values(f.records))r.expiresAt=0;f.windows.get(1).tabs.push({id:99,url:'https://x.com/home'});f.windows.get(2).tabs[0].url='https://example.com/';f.windows.get(3).tabs[0].id=999;f.windows.get(4).focused=true;f.windows.delete(5);const result=await scanTemporaryWindows();assert.deepEqual(result.released,[1,2,3]);assert.deepEqual(result.retained,[4]);assert.deepEqual(f.removed,[]);assert.equal(f.records['xfTemporaryWindow:5'],undefined);});
test('registration failure closes new window; failed removal retains record for retry',async()=>{const f=fixture();const w=await createTemporaryWindow({});f.records['xfTemporaryWindow:'+w.id].expiresAt=0;const remove=chrome.windows.remove;chrome.windows.remove=async()=>{throw Error('temporary failure')};assert.deepEqual((await scanTemporaryWindows()).failed,[w.id]);assert.ok(f.records['xfTemporaryWindow:'+w.id]);chrome.windows.remove=remove;await closeTemporaryWindow(w.id);assert.equal(f.records['xfTemporaryWindow:'+w.id],undefined);chrome.storage.session.set=async()=>{throw Error('storage failed')};await assert.rejects(createTemporaryWindow({}),/storage failed/);assert.equal(f.windows.size,0);});
test('watchdog registers minute alarm and retains explicit longer operation budgets',async()=>{const f=fixture();const before=Date.now();const w=await createTemporaryWindow({},'analysis',TEMP_WINDOW_TTL*2);assert.ok(f.records['xfTemporaryWindow:'+w.id].expiresAt>=before+TEMP_WINDOW_TTL*2);await ensureTemporaryWindowCleanup();assert.deepEqual(f.alarms,[[TEMP_WINDOW_ALARM,{periodInMinutes:1}]]);});

test('Grok releases to eight minute idle lease, reuses window and isolates concurrent jobs',async()=>{
 const f=fixture(),url='https://x.com/i/grok';const a=await handleGrokWindowPool({action:'acquire',url});
 const b=await handleGrokWindowPool({action:'acquire',url});assert.notEqual(a.id,b.id);
 await handleGrokWindowPool({action:'release',windowId:a.id});const r=f.records['xfTemporaryWindow:'+a.id];
 assert.equal(r.expiresAt-r.lastUsedAt,GROK_IDLE_TTL);assert.ok(f.windows.has(a.id));
 const again=await handleGrokWindowPool({action:'acquire',url});assert.equal(again.id,a.id);
 await handleGrokWindowPool({action:'release',windowId:again.id});const expiry=f.records['xfTemporaryWindow:'+a.id].expiresAt;
 assert.deepEqual((await scanTemporaryWindows(expiry-1)).closed,[]);
 assert.deepEqual((await scanTemporaryWindows(expiry+1)).closed,[a.id]);assert.ok(f.windows.has(b.id));
});
test('Grok channels and focused windows do not get reused; focused idle lease renews',async()=>{
 const f=fixture();const a=await handleGrokWindowPool({action:'acquire',url:'https://x.com/i/grok'});
 await handleGrokWindowPool({action:'release',windowId:a.id});f.windows.get(a.id).focused=true;
 const b=await handleGrokWindowPool({action:'acquire',url:'https://x.com/i/grok'});assert.notEqual(a.id,b.id);
 const c=await handleGrokWindowPool({action:'acquire',url:'https://grok.com/'});assert.notEqual(c.id,b.id);
 const now=Date.now()+GROK_IDLE_TTL+100;await scanTemporaryWindows(now);
 assert.equal(f.records['xfTemporaryWindow:'+a.id].expiresAt,now+GROK_IDLE_TTL);
});

test('new Grok popup navigates once; only a reused window gets a fresh navigation',async()=>{
 const f=fixture();let updates=0;chrome.tabs.update=async()=>{updates++;};
 const first=await handleGrokWindowPool({action:'acquire',url:'https://x.com/i/grok'});
 assert.equal(updates,0);
 await handleGrokWindowPool({action:'release',windowId:first.id});
 const second=await handleGrokWindowPool({action:'acquire',url:'https://x.com/i/grok'});
 assert.equal(second.id,first.id);assert.equal(updates,1);
});
