import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountState,ACCOUNT_STATE_KEY,ACCOUNT_STATE_ALARM} from '../src/platform/x/account-state.js';

function fixture(saved={}) {
 const data=structuredClone(saved),calls=[],listeners={},alarms=new Map();let probes=0,result={account:{id:'1',handle:'owner'}};
 const api={storage:{local:{get:async key=>({[key]:data[key]}),set:async patch=>Object.assign(data,structuredClone(patch))}},
  tabs:{query:async()=>[{id:10}],onUpdated:{addListener:fn=>{listeners.tab=fn;}}},
  scripting:{executeScript:async request=>{calls.push(request);return []; }},
  alarms:{get:async name=>alarms.get(name),create:async(name,value)=>alarms.set(name,value),onAlarm:{addListener:fn=>{listeners.alarm=fn;}}}};
 const probe={read:async()=>{probes++;return typeof result==='function'?await result():result;}};
 return {api,data,calls,listeners,alarms,probe,set:value=>{result=value;},count:()=>probes,create:()=>createAccountState({api,probe,now:()=>1000})};
}
test('all consumers read the same persistent account without probing pages or network',async()=>{
 const f=fixture(),service=f.create();await service.start();const writes=f.calls.length;
 const values=await Promise.all(Array.from({length:100},()=>service.read()));
 assert.ok(values.every(v=>v.account.id==='1'));assert.equal(f.count(),1);assert.equal(f.calls.length,writes);
 assert.deepEqual(f.alarms.get(ACCOUNT_STATE_ALARM),{periodInMinutes:1});
 assert.equal((await f.create().read()).account.id,'1');assert.equal(f.count(),1);
});
test('incomplete navigation and probe failures retain the last confirmed account; confirmed switch and logout replace it',async()=>{
 const f=fixture(),service=f.create();await service.start();
 for(const result of [{account:null},()=>{throw Error('page unavailable');}]){f.set(result);await service.refresh();assert.equal((await service.read()).account.id,'1');assert.equal((await service.read()).status,'retrying');}
 f.set({account:{id:'2',handle:'other'}});await service.refresh();assert.equal((await service.read()).account.id,'2');
 f.set({loggedOut:true});await service.refresh();assert.equal((await service.read()).account,null);assert.equal(f.data[ACCOUNT_STATE_KEY].status,'logged-out');
});
test('scheduled refresh coalesces concurrent requests and publishes snapshots to both execution worlds',async()=>{
 const f=fixture(),service=f.create();await service.start();let release;
 f.set(()=>new Promise(resolve=>{release=resolve;}));const a=service.refresh(),b=service.refresh();assert.equal(a,b);
 await new Promise(resolve=>setImmediate(resolve));release({account:{id:'2',handle:'other'}});await a;assert.equal(f.count(),2);
 assert.deepEqual(f.calls.slice(-2).map(c=>c.world),['ISOLATED','MAIN']);assert.ok(f.calls.slice(-2).every(c=>c.args[0].account.id==='2'));
 const before=f.count();f.listeners.tab(20,{status:'complete'},{url:'https://x.com/target'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.count(),before);assert.ok(f.calls.slice(-2).every(c=>c.target.tabId===20));
 f.set({account:{id:'3',handle:'third'}});f.listeners.alarm({name:ACCOUNT_STATE_ALARM});await new Promise(resolve=>setImmediate(resolve));assert.equal((await service.read()).account.id,'3');
});
test('matching persisted binding supplies an ID but never assigns it to a different account',async()=>{
 const f=fixture({followQueueBinding:{activated:true,accountId:'8',handle:'owner'}}),service=f.create();
 f.set({account:{handle:'owner'}});await service.refresh();assert.equal((await service.read()).account.id,'8');
 f.set({account:{handle:'other'}});await service.refresh();assert.equal((await service.read()).account.id,undefined);
});
