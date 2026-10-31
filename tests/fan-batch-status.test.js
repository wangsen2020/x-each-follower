import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createFollowQueueRuntime} from '../src/features/follow-queue/follow-queue-runtime.js';

test('passive batch status before activation returns an empty state without opening a store or doing work',async()=>{
  for(const binding of [undefined,{accountId:'owner',activated:false}]){
    const reads=[];
    const api={storage:{local:{get:async key=>{reads.push(key);return {followQueueBinding:binding};},set:async()=>assert.fail('no writes')}},tabs:{create:async()=>assert.fail('no tab')},alarms:{create:async()=>assert.fail('no scheduling')}};
    const store=new Proxy({}, {get:()=>assert.fail('no queue database')});
    const runtime=createFollowQueueRuntime({api,store});
    assert.deepEqual(await runtime.handle({cmd:'followQueueFanBatchStatus'}),{ok:true,batch:null,requiresActivation:true});
    assert.deepEqual(reads,['followQueueBinding']);
    for(const cmd of ['followQueueFanBatchStart','followQueueFanBatchResume','followQueueFanBatchStop','followQueueFanBatchCancel','followQueueEnqueue','followQueueRun']){
      await assert.rejects(runtime.handle({cmd}),/请先确认队列账号/);
    }
  }
});

test('activated status reads only its bound account and rejects an explicitly mismatched account',async()=>{
  const batch={id:'batch-one',accountId:'owner',stage:'paused',handles:['example'],nextIndex:0,results:[]};
  const data={followQueueBinding:{accountId:'owner',activated:true},'fanInspectionHead:owner':batch.id,'fanInspection:owner:batch-one':batch};
  const reads=[];
  const api={storage:{local:{get:async key=>{reads.push(key);return {[key]:structuredClone(data[key])};},set:async()=>assert.fail('no changes to paused result')}}};
  const runtime=createFollowQueueRuntime({api,store:{}});
  const result=await runtime.handle({cmd:'followQueueFanBatchStatus',accountId:'owner'});
  assert.equal(result.ok,true);assert.equal(result.batch.id,'batch-one');assert.equal(result.batch.stopping,false);
  assert.deepEqual(reads,['followQueueBinding','fanInspectionHead:owner','fanInspection:owner:batch-one']);
  reads.length=0;
  await assert.rejects(runtime.handle({cmd:'followQueueFanBatchStatus',accountId:'other'}),/请先确认队列账号/);
  assert.deepEqual(reads,['followQueueBinding']);
});

test('storage failures still reject rather than being disguised as an unconfigured queue',async()=>{
  const runtime=createFollowQueueRuntime({api:{storage:{local:{get:async()=>{throw Error('disk read failed');}}}},store:{}});
  await assert.rejects(runtime.handle({cmd:'followQueueFanBatchStatus'}),/disk read failed/);
});

test('unconfigured status clears stale batch error, hides the old progress and stops polling',async()=>{
  const source=readFileSync(new URL('../src/entries/panel/panel.js',import.meta.url),'utf8');
  const start=source.indexOf('async function refreshFanBatchStatus()');
  const end=source.indexOf('\nasync function fanBatchAction(',start);
  const timers=[],renders=[];
  const context=vm.createContext({fanBatchTimer:1,fanViewEpoch:2,fanBatchError:'请先确认队列账号',fanBatchState:{id:'old',stage:'running'},recordPages:null,
    clearTimeout(){},setTimeout:(...args)=>timers.push(args),renderFanBatch:()=>renders.push('batch'),clearFollowerSelection:()=>assert.fail('no completed batch'),
    chrome:{runtime:{sendMessage:async()=>({ok:true,batch:null,requiresActivation:true})}}
  });
  await vm.runInContext(source.slice(start,end)+'\nrefreshFanBatchStatus();',context);
  assert.equal(context.fanBatchState,null);assert.equal(context.fanBatchError,'');assert.equal(timers.length,0);assert.equal(renders.length,1);
});
