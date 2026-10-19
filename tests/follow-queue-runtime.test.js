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

test('candidate synchronization stores a profile from one snapshot without enqueueing an unchanged source',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{mutual:true}};
  const source={module:'mutual',url:'',enabled:true};
  const gets=[];
  const enqueued=[];
  const api={storage:{local:{get:async keys=>{gets.push(keys);return {followQueueBinding:binding,mutualNetwork:{users:[{handle:'target',name:'Ada',bio:'简介'}]}};}}},
    tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const store={
    lookup:async()=>({handle:'target',state:'pending',sources:[source],profile:null}),
    enqueue:async item=>{enqueued.push(item);return item;},
    importOutcome:async()=>{throw new Error('no import');}
  };
  await createFollowQueueRuntime({api,store}).syncCandidates();
  assert.equal(gets.filter(key => key == null).length,1);
  assert.equal(enqueued.length,1);
  assert.equal(enqueued[0].profile.name,'Ada');
  assert.equal(enqueued[0].profile.bio,'简介');
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

test('followQueueVerify resolves uncertain job to followed or pending or excluded without blind re-follow',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{mutual:true}};
  const resolved=[];
  const store={
    list:async()=>[{id:'123:id:42',accountId:'123',targetUserId:'42',handle:'target_user',state:'uncertain'}],
    resolveJob:async payload=>{resolved.push(payload);return {ok:true,job:{...payload}};}
  };
  let remoteFollowing=true;
  const api={
    storage:{local:{get:async()=>({followQueueBinding:binding}),set:async()=>{}}},
    tabs:{query:async()=>[{id:1}]},
    scripting:{executeScript:async()=>[{result:'viewer'}]}
  };
  const runtime=createFollowQueueRuntime({
    api,
    store,
    fetchUser:async()=>({id:'42',handle:'target_user',relationship:{following:remoteFollowing}})
  });
  const res1=await runtime.handle({cmd:'followQueueVerify',accountId:'123',jobId:'123:id:42',mode:'check'});
  assert.equal(res1.ok,true);
  assert.equal(res1.resolvedState,'followed');
  assert.equal(resolved[0].state,'followed');

  remoteFollowing=false;
  const res2=await runtime.handle({cmd:'followQueueVerify',accountId:'123',jobId:'123:id:42',mode:'check'});
  assert.equal(res2.ok,true);
  assert.equal(res2.resolvedState,'pending');
  assert.equal(resolved[1].state,'pending');

  const res3=await runtime.handle({cmd:'followQueueVerify',accountId:'123',jobId:'123:id:42',mode:'exclude'});
  assert.equal(res3.ok,true);
  assert.equal(res3.resolvedState,'excluded');
  assert.equal(resolved[2].state,'excluded');
});

test('followQueueRetryEvaluation verifies uncertain evaluation on profile before publishing and reuses draft without re-following',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{comments:true}};
  const resolved=[];
  const job={
    id:'123:id:42',
    accountId:'123',
    targetUserId:'42',
    handle:'target_user',
    state:'followed',
    evaluations:[{
      taskId:'comments:https://x.com/target_user/status/999',
      originalPostUrl:'https://x.com/target_user/status/999',
      originalPostId:'999',
      originalAuthorHandle:'target_user',
      status:'uncertain',
      text:'这是一条很有启发性的技术见解',
      attempts:[{at:'2026-10-17T00:00:00.000Z',stage:'publish'}]
    }]
  };
  const store={
    list:async()=>[job],
    getSettings:async()=>({grokEnabled:true,autoPublish:false}),
    resolveJob:async payload=>{resolved.push(payload);return {ok:true,job:{...job,evaluations:payload.evaluations}};}
  };
  const api={
    storage:{local:{get:async()=>({followQueueBinding:binding}),set:async()=>{}}},
    tabs:{
      query:async()=>[{id:1}],
      create:async()=>({id:99,url:'https://x.com/viewer'}),
      get:async()=>({id:99,status:'complete',url:'https://x.com/viewer'}),
      remove:async()=>{}
    },
    scripting:{
      executeScript:async({func})=>{
        if(String(func).includes('findPublishedQueueQuoteOnPage')){
          return[{result:{id:'888888',url:'https://x.com/viewer/status/888888'}}];
        }
        return[{result:'viewer'}];
      }
    }
  };
  const runtime=createFollowQueueRuntime({api,store});
  const res=await runtime.handle({cmd:'followQueueRetryEvaluation',accountId:'123',jobId:job.id,taskId:job.evaluations[0].taskId,publish:true});
  assert.equal(res.ok,true);
  assert.equal(res.evaluation.status,'posted');
  assert.equal(res.evaluation.publishedPostId,'888888');
  assert.equal(resolved.length,1);
  assert.equal(resolved[0].evaluations[0].status,'posted');
});

test('followQueueEnqueue enqueues single or batch candidates into queue store',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{comments:true}};
  const enqueued=[];
  const store={
    enqueue:async candidate=>{enqueued.push(candidate);return {id:'job_1',...candidate};},
    getSettings:async()=>({enabled:true,every:8,jitter:2})
  };
  const api={
    storage:{local:{get:async()=>({followQueueBinding:binding}),set:async()=>{}}},
    alarms:{clear:async()=>{},getAll:async()=>[],create:async()=>{}}
  };
  const runtime=createFollowQueueRuntime({api,store});
  const res=await runtime.handle({
    cmd:'followQueueEnqueue',
    candidates:[
      {handle:'user_a',url:'https://x.com/post/1'},
      {handle:'user_b',sources:[{module:'comments',url:'https://x.com/post/2',enabled:true}]}
    ]
  });
  assert.equal(res.ok,true);
  assert.equal(res.count,2);
  assert.equal(enqueued.length,2);
  assert.equal(enqueued[0].handle,'user_a');
  assert.equal(enqueued[0].sources[0].module,'comments');
  assert.equal(enqueued[1].handle,'user_b');
  assert.equal(enqueued[1].sources[0].url,'https://x.com/post/2');
});


test('fresh install bootstraps identity with an owned profile tab when old X tabs have no template',async()=>{
 const events=[];let captured=false;
 const api={storage:{local:{get:async()=>({})}},tabs:{
  query:async()=>[{id:1}],create:async opts=>{events.push(['create',opts]);return {id:2};},
  update:async(id,opts)=>{events.push(['update',id,opts]);captured=true;},remove:async id=>events.push(['remove',id])},
  scripting:{executeScript:async()=>[{result:'Viewer'}]}};
 const runtime=createFollowQueueRuntime({api,wait:async()=>{},fetchIdentity:async()=>captured?
  {status:200,json:{rest_id:'123',legacy:{screen_name:'viewer'}}}:{status:0,error:'未捕获 UserByScreenName 模板'}});
 const [a,b]=await Promise.all([runtime.handle({cmd:'followQueueIdentity'}),runtime.handle({cmd:'followQueueIdentity'})]);
 assert.equal(a.accountId,'123');assert.equal(b.accountId,'123');
 assert.equal(events.filter(e=>e[0]==='create').length,1);
 assert.equal(events[0][1].active,false);
 assert.deepEqual(events.at(-1),['remove',2]);
 assert.equal(events[1][2].url,'https://x.com/viewer');
});

test('identity bootstrap times out cleanly and closes only its own tab when logged out',async()=>{
 const removed=[];let waits=0;
 const api={storage:{local:{get:async()=>({})}},tabs:{query:async()=>[],create:async()=>({id:9}),remove:async id=>removed.push(id)},
 scripting:{executeScript:async()=>[{result:''}]}};
 const runtime=createFollowQueueRuntime({api,wait:async()=>{waits++;},fetchIdentity:async()=>assert.fail('no logged in viewer')});
 await assert.rejects(runtime.handle({cmd:'followQueueIdentity'}),/完成登录/);
 assert.deepEqual(removed,[9]);assert.equal(waits,40);
});

test('identity progress reports preparation and failure without requiring activation',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const api={storage:{local:{get:async()=>({})}},tabs:{query:async()=>{await pending;return [];},create:async()=>({id:9}),remove:async()=>{}},scripting:{executeScript:async()=>[{result:''}]}};
 const runtime=createFollowQueueRuntime({api,wait:async()=>{}});
 const identity=runtime.handle({cmd:'followQueueIdentity'});
 assert.equal((await runtime.handle({cmd:'followQueueIdentityStatus'})).stage,'checking');
 release();await assert.rejects(identity,/完成登录/);
 assert.equal((await runtime.handle({cmd:'followQueueIdentityStatus'})).stage,'failed');
});
