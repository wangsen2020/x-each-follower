import test from 'node:test';
import assert from 'node:assert/strict';
import {assessQueueProfile,createFollowQueueRuntime,QUEUE_ALARM} from '../src/features/follow-queue/follow-queue-runtime.js';

test('queue eligibility uses configured ratio instead of the legacy 80 percent veto',()=>{
  const profile={handle:'example',bio:'分享技术',followersText:'100',followingText:'70'};
  const settings={minFollowers:50,ratioThreshold:.6,onlyRecommended:true};
  assert.equal(assessQueueProfile(profile,settings),'');
  assert.match(assessQueueProfile(profile,{...settings,ratioThreshold:.8}),/80%/);
  assert.match(assessQueueProfile({...profile,followersText:''},settings),/未读全/);
  assert.equal(assessQueueProfile(profile,{...settings,ratioThreshold:.8},true),'');
  assert.match(assessQueueProfile({...profile,handle:'houthi_updates'},settings,true),/武装组织/);
});

test('armed-group profiles are skipped even when optional broad risk filtering is disabled',()=>{
  const settings={minFollowers:1,ratioThreshold:.1,onlyRecommended:false,skipRiskContent:false};
  const profile={handle:'houthi_updates',name:'资讯账号',bio:'分享动态',followersText:'100',followingText:'100'};
  assert.match(assessQueueProfile(profile,settings),/武装组织/);
  assert.match(assessQueueProfile({...profile,handle:'muslim_dev',name:'穆斯林开发者'},settings),/互动偏好跳过/);
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

test('fan reconciliation reopens only a verified ratio skip and clears stale follower labels',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const queueRow={payload:{id:'42',handle:'target_user',status:'pending',relationship:{followedBy:true,following:false}}};
  const job={id:'job-42',accountId:'123',targetUserId:'42',handle:'target_user',state:'skipped',
    followResult:{reason:'关注/粉丝比例低于 80%'}};
  const resolved=[], patches=[];
  const store={lookup:async()=>job,resolveJob:async payload=>{resolved.push(payload);job.state=payload.state;return {ok:true,job:{...job,...payload}};}};
  const records={lookupAll:async({sourceKey,bucket})=>sourceKey==='monitor'&&bucket==='queue'?[queueRow]:[],
    batch:async payload=>patches.push(payload)};
  let followedBy=true,following=false,remoteId='42';
  const api={storage:{local:{get:async()=>({followQueueBinding:binding}),set:async()=>{}}},
    tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const runtime=createFollowQueueRuntime({api,store,records,fetchUser:async()=>({id:remoteId,handle:'target_user',
    relationshipKnown:true,relationship:{followedBy,following}})});
  const reopened=await runtime.handle({cmd:'followQueueReconcileFan',accountId:'123',handle:'target_user'});
  assert.equal(reopened.jobState,'reopened');
  assert.equal(resolved[0].state,'pending');
  assert.equal(patches[0].changes[0].patch.status,'pending');

  job.state='skipped';job.followResult={reason:'命中高风险内容门禁'};
  const unsafe=await runtime.handle({cmd:'followQueueReconcileFan',accountId:'123',handle:'target_user'});
  assert.equal(unsafe.jobState,'unchanged');
  assert.equal(resolved.length,1);

  followedBy=false;
  const gone=await runtime.handle({cmd:'followQueueReconcileFan',accountId:'123',handle:'target_user'});
  assert.equal(gone.relationship.followedBy,false);
  assert.equal(patches.at(-1).changes[0].patch.status,'no_longer_following');
  assert.equal(resolved.length,1);

  following=true;
  const already=await runtime.handle({cmd:'followQueueReconcileFan',accountId:'123',handle:'target_user'});
  assert.equal(already.jobState,'already-following');
  assert.equal(resolved.at(-1).state,'followed');
  remoteId='43';
  const mismatch=await runtime.handle({cmd:'followQueueReconcileFan',accountId:'123',handle:'target_user'});
  assert.equal(mismatch.jobState,'identity-mismatch');
  assert.equal(patches.at(-1).changes[0].patch.status,'identity_mismatch');
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
      update:async()=>{},
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

test('followQueueRetryEvaluation refuses a risky account before generating or publishing',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true};
  const job={id:'123:id:42',accountId:'123',handle:'target_user',state:'followed',profile:{bio:'OnlyFans creator'},evaluations:[]};
  let removed=false;
  const api={
    storage:{local:{get:async key=>key==='followQueueBinding'?{followQueueBinding:binding}:{profileCache:{target_user:{posts:[{url:'https://x.com/target_user/status/999',text:'A useful technical post'}]}}}}},
    tabs:{create:async()=>({id:99}),remove:async()=>{removed=true;}},
    scripting:{executeScript:async()=>[{result:'viewer'}]}
  };
  const runtime=createFollowQueueRuntime({api,store:{list:async()=>[job]},sleep:async()=>{}});
  await assert.rejects(runtime.handle({cmd:'followQueueRetryEvaluation',accountId:'123',jobId:job.id,publish:true}),/高风险内容门禁/);
  assert.equal(removed,true);
});

test('quote publication risk block is a skipped result, not an uncertain external effect', async () => {
  const {quotePublicationState}=await import('../src/features/follow-queue/follow-queue-runtime.js');
  assert.equal(quotePublicationState({ok:false,riskBlocked:true,reason:'生成的引用评价涉政'}),'skipped');
  assert.equal(quotePublicationState({ok:false,stage:'composer'}),'failed');
  assert.equal(quotePublicationState({ok:false,reason:'网络响应不明'}),'uncertain');
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

test('activated queue reuses its stable account ID when the live viewer handle matches despite a changed display name',async()=>{
 const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
 let networkCalls=0,created=0;
 const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},tabs:{
  query:async()=>[{id:1,url:'https://x.com/home'}],create:async()=>{created++;return{id:2};}},
  scripting:{executeScript:async()=>[{result:'Viewer'}]}};
 const runtime=createFollowQueueRuntime({api,fetchIdentity:async()=>{networkCalls++;throw new Error('unneeded network lookup');}});
 const result=await runtime.handle({cmd:'followQueueIdentity'});
 assert.equal(result.accountId,'123');assert.equal(result.handle,'viewer');
 assert.equal(result.binding, binding);
 assert.equal(networkCalls,0);assert.equal(created,0);
});

test('activated queue returns from an owned X home tab without entering profile initialization',async()=>{
 const binding={accountId:'123',handle:'viewer',activated:true};
 const created=[],removed=[],updates=[];
 const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},tabs:{
  query:async()=>[],create:async options=>{created.push(options);return{id:2};},
  update:async(id,options)=>updates.push({id,options}),remove:async id=>removed.push(id)},
  scripting:{executeScript:async()=>[{result:'viewer'}]}};
 const runtime=createFollowQueueRuntime({api,fetchIdentity:async()=>{throw new Error('unneeded network lookup');}});
 const result=await runtime.handle({cmd:'followQueueIdentity'});
 assert.equal(result.accountId,'123');
 assert.deepEqual(created,[{url:'https://x.com/home',active:false}]);
 assert.deepEqual(removed,[2]);assert.deepEqual(updates,[]);
});

test('a different live handle requires the X account ID and cannot inherit the old queue binding',async()=>{
 const binding={accountId:'123',handle:'viewer',activated:true};
 let lookups=0;
 const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},tabs:{query:async()=>[{id:1}]},
  scripting:{executeScript:async()=>[{result:'other'}]}};
 const runtime=createFollowQueueRuntime({api,fetchIdentity:async()=>{lookups++;return{status:200,json:{rest_id:'456',legacy:{screen_name:'other'}}};}});
 const result=await runtime.handle({cmd:'followQueueIdentity'});
 assert.equal(result.accountId,'456');assert.equal(result.binding.accountId,'123');assert.equal(lookups,1);
});

test('a changed X handle updates the binding only after the same stable account ID is confirmed',async()=>{
 let binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
 const api={storage:{local:{get:async()=>({followQueueBinding:binding}),set:async patch=>{binding=patch.followQueueBinding;}}},
  tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'new_viewer'}]}};
 const runtime=createFollowQueueRuntime({api,fetchIdentity:async()=>({status:200,json:{rest_id:'123',legacy:{screen_name:'new_viewer'}}})});
 const result=await runtime.handle({cmd:'followQueueIdentity'});
 assert.equal(result.accountId,'123');assert.equal(result.handle,'new_viewer');
 assert.equal(binding.handle,'new_viewer');assert.deepEqual(binding.sources,{fans:true});
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

test('queue quote confirmation waits for profile load and refreshes a stale timeline without publishing twice',async()=>{
 const {confirmPublishedQueueQuote}=await import('../src/features/follow-queue/follow-queue-runtime.js');let clock=0,reloads=0,checks=0,prepared=0;
 const api={tabs:{update:async()=>{},get:async()=>({status:clock<2100?'loading':'complete'}),reload:async()=>{reloads++;}},
  scripting:{executeScript:async({func})=>{if(func.name==='setQuoteFrameFallbackOnPage'){prepared++;return [];}checks++;return [{result:reloads?{id:'posted',url:'https://x.com/viewer/status/posted'}:null}];}}};
 const proof=await confirmPublishedQueueQuote({api,tabId:7,handle:'viewer',originalId:'original',text:'quote',after:1,wait:async ms=>{clock+=ms;},now:()=>clock});
 assert.equal(proof.id,'posted');assert.equal(reloads,1);assert.equal(prepared,2);assert.ok(checks>1);assert.ok(clock>=15000);
});

test('queue quote confirmation keeps an unverified result uncertain and honours cancellation',async()=>{
 const {confirmPublishedQueueQuote}=await import('../src/features/follow-queue/follow-queue-runtime.js');let clock=0,reloads=0;
 const api={tabs:{update:async()=>{},get:async()=>({status:'complete'}),reload:async()=>{reloads++;}},scripting:{executeScript:async()=>[]}};
 const args={api,tabId:7,handle:'viewer',originalId:'original',text:'quote',after:1,wait:async ms=>{clock+=ms;},now:()=>clock};
 assert.equal(await confirmPublishedQueueQuote({...args,timeoutMs:20000}),null);assert.equal(reloads,1);
 assert.equal(await confirmPublishedQueueQuote({...args,canContinue:()=>false}),null);
});
