import test from 'node:test';
import assert from 'node:assert/strict';
import {runVerificationItems,verificationRowState} from '../src/features/relationships/verification-workflow.js';

test('both storage adapters can use the same ordered runner, preserving per-item errors and progress',async()=>{
  for(const items of [['a','b','c'],[{id:'a'},{id:'b'},{id:'c'}]]){
    const seen=[],saved=[],failed=[],delays=[];let completed=0;
    const result=await runVerificationItems({items,accountId:'owner',readAccount:async()=> 'owner',shouldStop:()=>false,
      inspect:async item=>{const key=item.id||item;seen.push(key);if(key==='b')throw Error('资料不完整');return {ok:true,key};},
      onSuccess:r=>saved.push(r.key),onFailure:(_,item)=>failed.push(item.id||item),onAdvance:n=>completed=n,
      wait:async ms=>delays.push(ms),random:()=>0.5});
    assert.deepEqual(seen,['a','b','c']);assert.deepEqual(saved,['a','c']);assert.deepEqual(failed,['b']);assert.equal(completed,3);
    assert.equal(result.stage,'completed');assert.deepEqual(delays,[3500,3500]);
  }
});

test('explicit stop finishes the in-flight item, and resume starts at the saved next item',async()=>{
  let release,stop=false,index=0;const seen=[];
  const options={items:['a','b'],accountId:'owner',readAccount:async()=> 'owner',shouldStop:()=>stop,inspect:async key=>{seen.push(key);if(key==='a')await new Promise(r=>release=r);return {ok:true};},onSuccess(){},onFailure(){},onAdvance:n=>index=n,wait:async()=>{}};
  const first=runVerificationItems(options);while(!release)await new Promise(r=>setImmediate(r));stop=true;release();
  assert.equal((await first).stage,'paused');assert.equal(index,1);stop=false;await runVerificationItems({...options,startIndex:index});assert.deepEqual(seen,['a','b']);
});

test('rate limiting and account switches pause without consuming the unfinished item',async()=>{
  const options={items:['a'],accountId:'owner',readAccount:async()=> 'owner',shouldStop:()=>false,inspect:async()=>{throw Object.assign(Error('HTTP 429'),{status:429});},onSuccess(){},onFailure(){throw Error('global limits are not per-item failures');}};
  assert.equal((await runVerificationItems(options)).nextIndex,0);
  assert.match((await runVerificationItems({...options,readAccount:async()=> 'other'})).reason,/绑定账号/);
});

test('selection is a read-only frozen snapshot while either adapter is running',()=>{
  const batch={running:true,keys:['one']};assert.deepEqual(verificationRowState(batch,'one',false),{disabled:true,checked:true});
  assert.deepEqual(verificationRowState(batch,'other',true),{disabled:true,checked:false});
  assert.deepEqual(verificationRowState({running:false,keys:['one']},'other',true),{disabled:false,checked:true});
});

test('global collection cooldown pauses at the unfinished account without recording failure',async()=>{
 const failed=[],advanced=[];
 const result=await runVerificationItems({items:['a','b'],accountId:'owner',readAccount:async()=> 'owner',shouldStop:()=>false,
  inspect:async()=>{throw Object.assign(Error('cooldown'),{code:'X_ACCESS_DEFERRED'})},onSuccess(){},onFailure:e=>failed.push(e),onAdvance:n=>advanced.push(n)});
 assert.equal(result.stage,'paused');assert.equal(result.nextIndex,0);assert.equal(failed.length,0);assert.equal(advanced.length,0);
});
