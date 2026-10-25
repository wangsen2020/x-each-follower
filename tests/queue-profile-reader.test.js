import test from 'node:test';
import assert from 'node:assert/strict';
import {readQueueProfile} from '../src/features/follow-queue/profile-reader.js';
const lookup={status:200,json:{rest_id:'123',legacy:{screen_name:'Target',name:'Target',followers_count:10,friends_count:20,following:false,followed_by:true}}};
function fixture(extra={}) {
  let time=0,calls=0;
  return {args:{handle:'target',readDom:async()=>({pending:true,bio:'partial'}),
    readNetwork:async()=>{calls++;return lookup;},guard:async()=>{},deadline:60000,
    signal:new AbortController().signal,now:()=>time,wait:async ms=>{time+=ms;},...extra},calls:()=>calls};
}
test('loaded DOM avoids extra network request',async()=>{
  const f=fixture({readDom:async()=>({pending:false,status:'ok'})});
  assert.equal((await readQueueProfile(f.args)).lookup,null);assert.equal(f.calls(),0);
});
test('incomplete DOM falls back once and returns authoritative identity and relationship',async()=>{
  const f=fixture();const result=await readQueueProfile(f.args);
  assert.equal(f.calls(),1);assert.equal(result.lookup,lookup);
  assert.equal(result.profile.id,'123');assert.equal(result.profile.relationship.followedBy,true);
  assert.equal(result.profile.profileSource,'network-fallback');
});
test('cycle budget expiry does not call fallback or masquerade as profile timeout',async()=>{
  const f=fixture({deadline:1000});
  await assert.rejects(readQueueProfile(f.args),{code:'QUEUE_BUDGET_EXHAUSTED'});assert.equal(f.calls(),0);
});
test('wrong target and incomplete counts cannot authorize a follow',async()=>{
  for(const json of [{rest_id:'123',legacy:{screen_name:'other',name:'Other',followers_count:1,friends_count:2}},
    {rest_id:'123',legacy:{screen_name:'target',name:'Target'}}]){
    const f=fixture({readNetwork:async()=>({status:200,json})});
    await assert.rejects(readQueueProfile(f.args),{code:'X_PROFILE_READ_TIMEOUT'});
  }
});
test('read rate limit is reported distinctly and unavailable accounts stay terminal',async()=>{
  await assert.rejects(readQueueProfile(fixture({readNetwork:async()=>({status:429})}).args),{code:'X_PROFILE_READ_LIMIT'});
  const result=await readQueueProfile(fixture({readNetwork:async()=>({status:200,json:{errors:[{code:63}]}})}).args);
  assert.equal(result.profile.status,'suspended');
});
