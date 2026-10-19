import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {setGrokFrameFallbackOnPage} from '../grok-comment.js';
function harness(){
 let seq=0;const frames=new Map(),timers=new Map();
 const window={requestAnimationFrame:fn=>{const id=++seq;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)};
 const original=window.requestAnimationFrame;
 const context=vm.createContext({window,performance:{now:()=>1234},setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
 const install=()=>vm.runInContext('('+setGrokFrameFallbackOnPage.toString()+')(true)',context);
 const tick=()=>{const entry=[...timers.entries()].find(([,t])=>t.ms===80);if(entry){timers.delete(entry[0]);entry[1].fn();}};
 install();return {window,frames,timers,original,install,tick};
}
test('Grok occluded frames progress without visibility or focus APIs and deliver once',()=>{
 const h=harness(),values=[];const id=h.window.requestAnimationFrame(t=>values.push(t));const native=h.frames.get(id);
 h.tick();native(2000);assert.deepEqual(values,[1234]);assert.equal(h.frames.size,0);
 h.window.__xfollowerGrokFrames.restore();assert.equal(h.timers.size,0);assert.equal(h.window.requestAnimationFrame,h.original);
});
test('Grok native frame wins and cancellation suppresses timer callbacks',()=>{
 const h=harness();let count=0;let id=h.window.requestAnimationFrame(()=>count++);
 h.frames.get(id)(10);h.tick();assert.equal(count,1);
 id=h.window.requestAnimationFrame(()=>count++);h.window.cancelAnimationFrame(id);h.tick();assert.equal(count,1);
 h.window.__xfollowerGrokFrames.restore();
});
test('Grok frame installation is idempotent and expiry restores outstanding work',()=>{
 const h=harness(),wrapped=h.window.requestAnimationFrame;h.install();assert.equal(h.window.requestAnimationFrame,wrapped);
 const cb=()=>{};h.window.requestAnimationFrame(cb);
 [...h.timers.values()].find(t=>t.ms===180000).fn();assert.equal(h.window.requestAnimationFrame,h.original);
 assert.ok([...h.frames.values()].includes(cb));assert.equal(h.window.__xfollowerGrokFrames,undefined);assert.equal(h.timers.size,0);
});
