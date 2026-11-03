import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiConnectionMonitor,AI_CONNECTION_KEY,AI_CONNECTION_ALARM,installAiConnectionMonitor,readAiSessions} from '../src/features/grok/ai-connection-state.js';

function fixture() {
 let time=100000,fail=false,health={ok:true},release;
 const stored={},alarms=new Map(),listeners=[],calls={health:0,list:0};
 let config={testedAt:1,bot:'session',token:'private-test-value'};
 const client={configuration:async()=>structuredClone(config),status:async()=>({enabled:Boolean(config.testedAt),bot:config.bot}),health:async()=>{calls.health++;if(release)await release;if(fail)throw Error('offline');return health;},list:async()=>{calls.list++;return [{id:'session',name:'Review'}];}};
 const disabled={configuration:async()=>null,status:async()=>({enabled:false}),health:async()=>{throw Error('unconfigured probed');}};
 const api={storage:{local:{get:async key=>({[key]:stored[key]}),set:async value=>Object.assign(stored,structuredClone(value))}},alarms:{get:async name=>alarms.get(name),create:async(name,value)=>alarms.set(name,value),onAlarm:{addListener:fn=>listeners.push(fn)}}};
 const make=()=>createAiConnectionMonitor({clients:{'grok-local':client,codex:disabled,antigravity:disabled},api,now:()=>time});
 return {make,calls,stored,alarms,listeners,client,setTime:v=>time=v,setFail:v=>fail=v,setHealth:v=>health=v,setConfig:v=>config=v,hold:()=>{let done;release=new Promise(r=>done=r);return ()=>{done();release=null;};}};
}
test('concurrent checks share one probe; business reads never probe; no credentials persisted',async()=>{
 const f=fixture(),m=f.make(),done=f.hold();
 const a=m.check('grok-local'),b=m.check('grok-local');assert.equal(a,b);done();await a;
 installAiConnectionMonitor(m);
 for(let i=0;i<10;i++)assert.equal((await readAiSessions('grok-local'))[0].id,'session');
 assert.deepEqual(f.calls,{health:1,list:1});assert.ok(!JSON.stringify(f.stored).includes('private-test-value'));
});
test('central alarm retries outage after one minute, then returns to five minute checks',async()=>{
 const f=fixture(),m=f.make();f.setFail(true);await m.start();
 assert.equal(f.alarms.get(AI_CONNECTION_ALARM).periodInMinutes,1);
 assert.equal((await m.read('grok-local')).state,'offline');assert.equal((await m.read('codex')).state,'unconfigured');
 f.setTime(159999);f.setFail(false);await m.tick();assert.equal(f.calls.health,1);
 f.setTime(160000);await m.tick();const s=await m.read('grok-local');assert.equal(s.state,'ready');assert.equal(s.nextAt,460000);
 assert.equal(f.calls.health,2);await m.start();assert.equal(f.listeners.length,1);
});
test('HTTP success with unavailable engine is offline, not healthy',async()=>{
 const f=fixture(),m=f.make();f.setHealth({ok:false,status:'unavailable'});await m.check('grok-local');
 assert.equal((await m.read('grok-local')).connected,false);assert.equal(f.calls.list,0);
});
test('connection edit during a probe cannot publish old ready state',async()=>{
 const f=fixture(),m=f.make(),done=f.hold(),job=m.check('grok-local');
 while(!f.calls.health)await new Promise(r=>setImmediate(r));
 f.setConfig({testedAt:2,bot:'new',token:'new-private'});done();await job;
 assert.equal((await m.read('grok-local')).connected,false);
});
test('worker restart recovers a persisted checking state and recreates alarm',async()=>{
 const f=fixture();f.stored[AI_CONNECTION_KEY]={'grok-local':{state:'checking',connected:false,nextAt:999999}};
 const m=f.make();await m.start();assert.equal((await m.read('grok-local')).state,'ready');assert.equal(f.alarms.size,1);
});
test('startup admission waits for the shared check without probing again or falsely failing',async()=>{
 const f=fixture(),m=f.make(),done=f.hold();const starting=m.start();
 const waiting=m.request({op:'admission',provider:'grok-local'});done();await starting;
 assert.equal((await waiting).connected,true);assert.equal(f.calls.health,1);
});
