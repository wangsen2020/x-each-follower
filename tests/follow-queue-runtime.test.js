import test from 'node:test';
import assert from 'node:assert/strict';
import {assessQueueProfile,createFollowQueueRuntime,QUEUE_ALARM} from '../follow-queue-runtime.js';

test('queue eligibility uses configured ratio instead of the legacy 80 percent veto',()=>{
  const profile={handle:'example',bio:'分享技术',followersText:'100',followingText:'70'};
  const settings={minFollowers:50,ratioThreshold:.6,onlyRecommended:true};
  assert.equal(assessQueueProfile(profile,settings),'');
  assert.match(assessQueueProfile(profile,{...settings,ratioThreshold:.8}),/80%/);
  assert.match(assessQueueProfile({...profile,followersText:''},settings),/未读全/);
});

test('worker recovery preserves queued alarm deadline and clears only old follow schedules',async()=>{
  const clears=[], creates=[];
  const api={storage:{local:{get:async()=>({followQueueBinding:{accountId:'123',activated:true}})}},
    alarms:{clear:async n=>clears.push(n),getAll:async()=>[{name:QUEUE_ALARM,scheduledTime:12345}],create:async(...a)=>creates.push(a)}};
  const runtime=createFollowQueueRuntime({api,store:{getSettings:async()=>({enabled:true,every:8,jitter:2})}});
  await runtime.schedule({preserve:true});
  assert.deepEqual(clears,['x-mutual-auto-follow','x-comment-auto-follow']);
  assert.deepEqual(creates,[]);
});

test('queue does not open tabs, create a database or migrate before explicit activation',async()=>{
  const api={storage:{local:{get:async()=>({})}},alarms:{clear:async()=>assert.fail('no activation')},tabs:{create:async()=>assert.fail('no startup tab')}};
  const runtime=createFollowQueueRuntime({api});
  await runtime.schedule({preserve:true});
  await assert.rejects(runtime.handle({cmd:'followQueueActivate',confirmed:false}),/确认/);
  await assert.rejects(runtime.handle({cmd:'followQueueRun',accountId:'123'}),/确认队列账号/);
});

test('candidate synchronization preserves an active successful follow against stale skipped data',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{mutual:true}};
  const source={module:'mutual',url:'',enabled:true};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding,mutualNetwork:{users:[{handle:'target',autoFollowState:'skipped'}]}})}},
    tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  let imports=0;
  const store={list:async()=>[{handle:'target',state:'running',followResult:{succeeded:true},sources:[source]}],
    importOutcome:async()=>{imports++;},enqueue:async()=>{}};
  await createFollowQueueRuntime({api,store}).syncCandidates();
  assert.equal(imports,0);
});
