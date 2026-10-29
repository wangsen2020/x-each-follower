import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueueAlarmPlan,QUEUE_PLAN_KEY} from '../src/features/follow-queue/queue-alarm-plan.js';

function fixture() {
  let clock=1000000, alarm=null;
  const data={}, created=[];
  const api={storage:{local:{get:async key=>({[key]:data[key]}),set:async patch=>Object.assign(data,patch)}},
    alarms:{getAll:async()=>alarm?[alarm]:[],clear:async()=>{alarm=null;},
      create:async(name,options)=>{created.push(options);alarm={name,scheduledTime:options.when};}}};
  const make=()=>createQueueAlarmPlan({api,name:'queue',now:()=>clock,delay:()=>20});
  return {make,data,created,tick:ms=>{clock+=ms;},remove:()=>{alarm=null;},alarm:()=>alarm};
}
const settings={enabled:true,every:20,jitter:3};

test('enqueue and unrelated settings saves cannot keep postponing a queued deadline',async()=>{
  const f=fixture(),plan=f.make();
  await plan.schedule('account',settings);
  const deadline=f.alarm().scheduledTime;
  for(let i=0;i<5;i++){
    f.tick(60000);
    await plan.schedule('account',settings,{reason:'enqueue'});
    await plan.schedule('account',{...settings,batchLimit:8},{reason:'settings-saved'});
  }
  assert.equal(f.alarm().scheduledTime,deadline);
  assert.equal(f.created.length,1);
});

test('worker restart restores a missing overdue alarm at the saved deadline, without another full interval',async()=>{
  const f=fixture();
  await f.make().schedule('account',settings);
  const deadline=f.alarm().scheduledTime;
  f.remove();f.tick(25*60000);
  await f.make().schedule('account',settings);
  assert.equal(f.alarm().scheduledTime,deadline);
  assert.ok(deadline<1000000+25*60000);
});

test('legacy existing alarm is adopted and explicit timing changes start a new interval',async()=>{
  const f=fixture(),plan=f.make();
  await plan.schedule('account',settings);
  const deadline=f.alarm().scheduledTime;
  delete f.data[QUEUE_PLAN_KEY];f.tick(60000);
  await f.make().schedule('account',settings);
  assert.equal(f.alarm().scheduledTime,deadline);
  await plan.schedule('account',settings,{reset:true,reason:'timing-changed'});
  assert.equal(f.alarm().scheduledTime,deadline+60000);
});

test('disable clears the due time and concurrent recovery does not create duplicate plans',async()=>{
  const f=fixture(),plan=f.make();
  await Promise.all([plan.schedule('account',settings),plan.schedule('account',settings)]);
  assert.equal(f.created.length,1);
  await plan.record('account',{lastStage:'sync-candidates'});
  await plan.schedule('account',{...settings,enabled:false});
  assert.equal(f.alarm(),null);
  assert.equal((await plan.read('account')).nextRunAt,null);
  assert.equal((await plan.read('other')).nextRunAt,undefined);
});
