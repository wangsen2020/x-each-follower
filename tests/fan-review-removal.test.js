import test from 'node:test';
import assert from 'node:assert/strict';
import {createFanReviewRemoval} from '../src/features/relationships/fan-review-removal.js';

const OWNER='123',TARGET='42',HANDLE='target';
const input={accountId:OWNER,targetUserId:TARGET,handle:HANDLE};
function fixture(options={}) {
  const data={},session={},tabs=new Map([[99,{id:99,url:'https://x.com/home'}]]),created=[],closed=[],submits=[];
  let id=100,submitted=false,profileReads=0,closeFails=options.closeFails||0;
  let binding={accountId:OWNER,handle:'owner',activated:true};
  const area=values=>({async get(keys){const list=Array.isArray(keys)?keys:[keys];return Object.fromEntries(list.filter(key=>Object.hasOwn(values,key)).map(key=>[key,structuredClone(values[key])]))},async set(patch){
    if(values===data&&options.failIntent&&Object.keys(patch).some(key=>key.startsWith('followQueueFanRemovalIntent:')))throw Error('intent write rejected');
    Object.assign(values,structuredClone(patch));
    if(values===data&&options.switchAfterCheckpoint&&Object.keys(patch).some(key=>key.startsWith('followQueueFanRemovalIntent:')))binding={accountId:'456',handle:'another',activated:true};
  }});
  const api={storage:{local:area(data),session:area(session)},tabs:{
    async create(config){const tab={...config,id:++id};tabs.set(tab.id,tab);created.push(tab);return tab;},
    async get(tabId){if(!tabs.has(tabId))throw Error('No tab with id');return {...tabs.get(tabId)};},
    async remove(tabId){if(closeFails-->0)throw Error('close failed');closed.push(tabId);tabs.delete(tabId);},
    async reload(){}
  },scripting:{async executeScript({func,args}){
    if(func.name==='profileRelationshipOnPage')return [{result:{ready:true,following:options.following===true,followedBy:options.followedBy===false?false:!submitted,ownerVerified:true,identityVerified:true}}];
    throw Error(`unexpected script ${func.name}`);
  }}};
  const dependencies={api,readBinding:async()=>({...binding}),wait:async()=>{},now:()=>1000,
    readViewer:async()=>options.badViewer?'other':'owner',
    fetchProfile:async(tabId,handle)=>{
      if(handle==='owner')return {status:200,json:{data:{user:{result:{rest_id:options.wrongOwnerId?'456':OWNER,legacy:{screen_name:'owner'}}}}}};
      profileReads++;return {status:200,json:{data:{user:{result:{rest_id:options.swapId&&profileReads>1?'77':TARGET,legacy:{screen_name:options.foreignHandle?'another':HANDLE,following:options.following===true,followed_by:options.followedBy===false?false:!submitted}}}}}};},
    sendRemoval:async(tabId,targetId)=>{
      const intent=data[`followQueueFanRemovalIntent:${OWNER}:${TARGET}`];assert.ok(intent?.attemptedAt,'intent must be durable before the network mutation');
      submits.push({tabId,targetId});submitted=true;if(options.lostResponse)throw Error('network response lost');return {status:200,attempted:true};
    },refreshPage:async()=>{}}
  return {api,data,session,tabs,created,closed,submits,dependencies,setBinding:value=>{binding=value},run:()=>createFanReviewRemoval(dependencies)(input)};
}

test('manual removal verifies live X identity/relationship, checkpoints before submit and returns a durable scoped receipt',async()=>{
  const f=fixture(),result=await f.run();
  assert.equal(result.removed,true);assert.equal(result.attempted,true);assert.equal(result.accountId,OWNER);assert.equal(result.targetUserId,TARGET);assert.equal(result.verifiedAt,1000);
  assert.equal(f.submits.length,1);assert.equal(f.submits[0].targetId,TARGET);
  assert.equal(f.created[0].active,false);assert.deepEqual(f.closed,[f.created[0].id]);assert.ok(f.tabs.has(99));
  assert.deepEqual(f.data[`followQueueFanRemovalIntent:${OWNER}:${TARGET}`],result);
});

test('lost response is reconciled automatically without replaying a successful removal',async()=>{
  const f=fixture({lostResponse:true}),remove=createFanReviewRemoval(f.dependencies);
  const [first,second]=await Promise.all([remove(input),remove(input)]);
  assert.equal(first.state,'unknown');assert.equal(second.state,'removed');assert.equal(first.attempted,true);assert.equal(f.submits.length,1);
  const third=await createFanReviewRemoval(f.dependencies)(input);assert.equal(third.state,'removed');assert.equal(f.submits.length,1);
  assert.equal(f.created.length,2);
});

test('confirmed receipt is reused without opening a tab or resubmitting',async()=>{
  const f=fixture();const first=await f.run(),second=await f.run();
  assert.equal(first.removed,true);assert.equal(second.removed,true);assert.equal(second.recovered,true);assert.equal(f.submits.length,1);assert.equal(f.created.length,1);
});

test('a restarted worker reads an unknown durable intent using fresh storage and lifecycle objects without resubmission',async()=>{
  const f=fixture({lostResponse:true});assert.equal((await f.run()).state,'unknown');
  const api={...f.api,storage:{local:{...f.api.storage.local},session:{...f.api.storage.session}}};
  const remove=createFanReviewRemoval({...f.dependencies,api,storage:api.storage.local});
  const result=await remove(input);assert.equal(result.state,'removed');assert.equal(f.submits.length,1);assert.equal(f.created.length,2);
});

for(const [label,options] of [['wrong viewer',{badViewer:true}],['wrong owner stable ID',{wrongOwnerId:true}],['changed stable ID',{swapId:true}],['foreign handle',{foreignHandle:true}],['already following',{following:true}]]) {
  test(`${label} never authorizes a real removal`,async()=>{
    const f=fixture(options),result=await f.run();assert.equal(result.removed,false);assert.equal(result.attempted,false);assert.equal(f.submits.length,0);assert.equal(f.data[`followQueueFanRemovalIntent:${OWNER}:${TARGET}`],undefined);
    assert.ok(f.tabs.has(99));assert.deepEqual(f.closed,f.created.map(tab=>tab.id));
  });
}

test('owner changes after the durable checkpoint stop submission and retain an unknown intent',async()=>{
  const f=fixture({switchAfterCheckpoint:true}),result=await f.run();assert.equal(result.state,'unknown');assert.equal(result.attempted,true);assert.equal(f.submits.length,0);
  f.setBinding({accountId:OWNER,handle:'owner',activated:true});const again=await f.run();assert.equal(again.state,'deferred');assert.equal(f.submits.length,0);
});

test('a different bound owner and invalid/numeric IDs fail closed before creating tabs',async()=>{
  const f=fixture(),remove=createFanReviewRemoval(f.dependencies);
  for(const bad of [{...input,targetUserId:42},{...input,accountId:123},{...input,handle:'bad/path'}])assert.equal((await remove(bad)).state,'failed');
  f.setBinding({accountId:'456',handle:'owner',activated:true});assert.equal((await remove(input)).state,'failed');
  assert.equal(f.created.length,0);assert.equal(f.submits.length,0);
});

test('checkpoint persistence failure prevents the irreversible request',async()=>{
  const f=fixture({failIntent:true}),result=await f.run();assert.equal(result.state,'failed');assert.equal(result.attempted,false);assert.equal(f.submits.length,0);assert.match(result.reason,/intent write rejected/);
});

test('close failure retains only the manual-removal registration and the next call retries cleanup without replay',async()=>{
  const f=fixture({closeFails:1});f.session.followQueueOwnedTabs={existing:{id:99,url:'https://x.com/home'}};
  const first=await f.run();assert.equal(first.removed,true);assert.ok(f.session.fanReviewRemovalOwnedTabs[`fan-remove:${OWNER}:${TARGET}`]);
  assert.deepEqual(f.session.followQueueOwnedTabs,{existing:{id:99,url:'https://x.com/home'}});
  const second=await f.run();assert.equal(second.removed,true);assert.equal(f.submits.length,1);
  assert.deepEqual(f.session.fanReviewRemovalOwnedTabs,{});assert.ok(f.tabs.has(99));assert.deepEqual(f.closed,[f.created[0].id]);
});

test('worker recovery closes only registered manual tabs with the original URL, never another queue tab',async()=>{
  const f=fixture();f.tabs.set(88,{id:88,url:'https://x.com/target'});f.tabs.set(87,{id:87,url:'https://x.com/home'});
  f.session.fanReviewRemovalOwnedTabs={orphan:{id:88,url:'https://x.com/target'},navigated:{id:87,url:'https://x.com/target'}};
  f.session.followQueueOwnedTabs={queue:{id:99,url:'https://x.com/home'}};
  const result=await f.run();assert.equal(result.removed,true);assert.ok(f.closed.includes(88));assert.ok(!f.closed.includes(87));assert.ok(!f.closed.includes(99));
  assert.deepEqual(f.session.followQueueOwnedTabs,{queue:{id:99,url:'https://x.com/home'}});
});

test('shared cooldown returns a deferred removal without a write intent or X submission',async()=>{
 const f=fixture(),retryAt=Date.now()+900000;f.api.accessBudget={reserve:async()=>({allowed:false,retryAt})};
 const result=await f.run();assert.equal(result.state,'deferred');assert.equal(result.attempted,false);assert.equal(result.removed,false);
 assert.equal(result.retryAt,retryAt);assert.equal(f.created.length,0);assert.equal(f.submits.length,0);
 assert.equal(Object.keys(f.data).some(k=>k.startsWith('followQueueFanRemovalIntent:')),false);
});

test('central account snapshot removes repeated viewer and owner-profile probes',async()=>{
 const f=fixture();f.dependencies.readAccount=async()=>({id:OWNER,handle:'owner'});
 f.dependencies.readViewer=()=>assert.fail('no per-module viewer probe');
 const original=f.dependencies.fetchProfile;f.dependencies.fetchProfile=(tab,handle)=>{assert.notEqual(handle,'owner');return original(tab,handle);};
 assert.equal((await f.run()).removed,true);assert.equal(f.submits.length,1);
});

test('an already absent follower finishes the removal queue without submitting a mutation',async()=>{
 const f=fixture({followedBy:false});const receipt=await f.run();
 assert.equal(receipt.removed,true);assert.equal(receipt.attempted,false);assert.equal(f.submits.length,0);assert.ok(receipt.verifiedAt);
});

test('stale unknown intent is rechecked and an actual remaining follower is removed automatically',async()=>{
 const f=fixture();f.data['followQueueFanRemovalIntent:123:42']={...input,attempted:true,attemptedAt:100,removed:false,state:'unknown'};
 f.dependencies.now=()=>100000;const receipt=await f.run();
 assert.equal(receipt.removed,true);assert.equal(f.submits.length,1);assert.equal(receipt.previousAttempts[0].attemptedAt,100);
});
