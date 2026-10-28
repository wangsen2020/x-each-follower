import test from 'node:test';
import assert from 'node:assert/strict';
import {assessQueueProfile,createFollowQueueRuntime,QUEUE_ALARM} from '../src/features/follow-queue/follow-queue-runtime.js';

test('interaction exclusions block the real Arabic case before follow even when follow-back bypass is enabled', () => {
  const settings={minFollowers:0,ratioThreshold:0,skipRiskContent:false,followBackAllowAll:true};
  for (const text of ['يا الله لك الحمد','赞美归于真主','صاروخ باليستي','انباء اوليه سقوط عدد من المرتزقه أسرى في جبهة كحلان','war in the region','戦争の報道']) {
    const profile={handle:'example',followersText:'200',followingText:'200',posts:[{text}]};
    assert.match(assessQueueProfile(profile,settings,true),/互动偏好跳过/,text);
  }
  const posts=Array.from({length:12},()=>({text:'日常产品更新'}));
  posts[11]={text:'يا الله لك الحمد'};
  assert.match(assessQueueProfile({handle:'example',posts},settings),/互动偏好跳过/);
});

test('read-only run check ignores legacy cooldown and still checks account identity',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true};
  let pause=new Date(Date.now()+3600000).toISOString(),currentViewer='viewer';
  const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},
    tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:currentViewer}]}};
  const runtime=createFollowQueueRuntime({api,store:{},records:{metadata:async()=>({pausedUntil:pause})}});
  const check=()=>runtime.handle({cmd:'followQueueRunCheck'});
  let result=await check();
  assert.equal(result.allowed,true);
  assert.equal(result.blockReason,null);
  pause=new Date(Date.now()-1000).toISOString();
  result=await check();
  assert.equal(result.allowed,true);
  assert.equal(result.blockReason,null);
  currentViewer='other';
  assert.equal((await check()).blockReason.code,'viewer-mismatch');
  currentViewer='';
  assert.equal((await check()).blockReason.code,'viewer-unavailable');
});

test('queue eligibility uses configured ratio instead of the legacy 80 percent veto',()=>{
  const profile={handle:'example',bio:'分享技术',followersText:'100',followingText:'70'};
  const settings={minFollowers:50,ratioThreshold:.6,onlyRecommended:true};
  assert.equal(assessQueueProfile(profile,settings),'');
  assert.match(assessQueueProfile(profile,{...settings,ratioThreshold:.8}),/80%/);
  assert.match(assessQueueProfile({...profile,followersText:''},settings),/未读全/);
  assert.equal(assessQueueProfile(profile,{...settings,ratioThreshold:.8},true),'');
  assert.match(assessQueueProfile({...profile,handle:'houthi_updates'},settings,true),/武装组织/);
});

test('removed recommendation switch cannot add a hidden intent veto after explicit thresholds pass',()=>{
  const settings={minFollowers:0,ratioThreshold:.8,onlyRecommended:true,skipRiskContent:false};
  assert.equal(assessQueueProfile({handle:'example',bio:'Software development',followersText:'0',followingText:'0'},settings),'');
  assert.match(assessQueueProfile({handle:'example',bio:'互关必回',followersText:'100',followingText:'70'},settings),/80%/);
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
  assert.deepEqual(creates,[['x-independent-comments',{periodInMinutes:1}]]);
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

test('candidate synchronization does not restore an old followed import after X verified not-following',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{mutual:true}};
  const source={module:'mutual',url:'',enabled:true};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding,mutualNetwork:{users:[{handle:'target',relationship:{following:true}}]}})}},
    tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  let imported=0, enqueued=0;
  const prior={handle:'target',state:'uncertain',sources:[source],followResult:{following:false,verifiedAt:Date.now()}};
  const store={lookup:async()=>prior,getSettings:async()=>({}),importOutcome:async()=>{imported++;},enqueue:async()=>{enqueued++;}};
  await createFollowQueueRuntime({api,store}).syncCandidates();
  assert.equal(imported,0);
  assert.equal(enqueued,0);
});

test('candidate sync does not repeatedly reopen a verified skipped fan', async () => {
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const source={module:'fans',url:'',enabled:true};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding,monitor:{users:[],queue:[{handle:'target',state:'follow_back',status:'pending',relationship:{following:false,followedBy:true}}]}})}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  let reopened=0;
  const prior={id:'job',handle:'target',state:'skipped',sources:[source],followResult:{relationshipDecision:{code:'follow-back'},verifiedAt:1}};
  const store={lookup:async()=>prior,getSettings:async()=>({followBackAllowAll:true}),resolveJob:async()=>{reopened++;},enqueue:async()=>{},importOutcome:async()=>{}};
  const runtime=createFollowQueueRuntime({api,store});
  await runtime.syncCandidates(); await runtime.syncCandidates();
  assert.equal(reopened,0);
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
    fetchUser:async()=>({id:'42',handle:'target_user',relationship:{following:remoteFollowing,followedBy:false}})
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

test('fan inspection moves a verified former owner without merging its handle-only queue history', async () => {
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const current={accountId:'unassigned',userKey:'current',sourcePath:['monitor','users','new-id'],payload:{id:'new-id',handle:'old'}};
  const former={accountId:'unassigned',userKey:'former',sourcePath:['monitor','followingUsers','old-id'],payload:{id:'old-id',handle:'old'}};
  const renamed={accountId:'unassigned',userKey:'renamed',sourcePath:['monitor','users','old-id'],payload:{id:'old-id',handle:'new'}};
  const patches=[],resolved=[];
  const records={lookupAll:async r=>r.tweetId==='old-id'?[former,renamed]:r.bucket==='users'?[current]:r.bucket==='followingUsers'?[former]:[],batch:async p=>patches.push(p)};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding}),set:async()=>{}}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const runtime=createFollowQueueRuntime({api,records,store:{lookup:async()=>({id:'history',handle:'old',state:'followed',targetUserId:''}),resolveJob:async p=>resolved.push(p)},
    fetchUser:async(_tab,handle)=>({id:handle==='old'?'new-id':'old-id',handle,relationshipKnown:true,relationship:{following:true,followedBy:true}})});
  const result=await runtime.handle({cmd:'followQueueInspectFan',handle:'old'});
  assert.equal(result.ok,true);
  assert.equal(patches[0].changes[0].patch.legacyHandleIdentityConflict,true);
  assert.equal(patches[1].changes[0].patch.handle,'new');
  assert.deepEqual(patches[1].changes[0].patch.previousHandles,['old']);
  assert.equal(resolved.length,0);
});

test('fan inspection keeps mismatched records untouched when former owner cannot be verified', async () => {
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const rows=[{accountId:'unassigned',userKey:'current',sourcePath:['monitor','users','new'],payload:{id:'new',handle:'old'}},
    {accountId:'unassigned',userKey:'former',sourcePath:['monitor','followingUsers','old'],payload:{id:'old',handle:'old'}}];
  const patches=[];
  const api={storage:{local:{get:async()=>({followQueueBinding:binding}),set:async()=>{}}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const runtime=createFollowQueueRuntime({api,records:{lookupAll:async r=>r.tweetId?[]:rows.filter(row=>row.sourcePath[1]===r.bucket),batch:async p=>patches.push(p)},store:{lookup:async()=>null},
    fetchUser:async()=>({id:'new',handle:'old',relationshipKnown:true,relationship:{following:true,followedBy:true}})});
  const result=await runtime.handle({cmd:'followQueueInspectFan',handle:'old'});
  assert.equal(result.jobState,'identity-mismatch');
  assert.ok(patches.flatMap(p=>p.changes).every(change=>!change.patch.handle));
});

test('candidate sync leaves the former owner handle-only history untouched after reuse', async () => {
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const prior={id:'historical',handle:'old',targetUserId:'',state:'followed',sources:[],profile:{name:'former'}};
  const record={module:'fans',sourcePath:['monitor','queue','new'],payload:{id:'new',handle:'old',state:'follow_back',relationship:{following:false,followedBy:true}}};
  const directory={handle:'old',payload:{fanCategory:'pending',relationship:{following:false,followedBy:true},legacyHandleIdentityConflict:true}};
  const calls=[];
  const store={lookup:async()=>prior,getSettings:async()=>({followBackAllowAll:true}),resolveJob:async()=>calls.push('resolve'),enqueue:async()=>calls.push('enqueue'),importOutcome:async()=>calls.push('import')};
  const records={sourcePage:async({sourceKey})=>({records:sourceKey==='monitor'?[record]:[]}),profiles:async()=>[],lookupAll:async()=>[],fanDirectory:async()=>[directory]};
  await createFollowQueueRuntime({api,store,records}).syncCandidates();
  assert.deepEqual(calls,[]);
});

test('fan inspection updates all stored buckets without reopening skipped jobs or performing a follow', async () => {
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const rows=['users','queue','followingUsers'].map(bucket=>({sourcePath:['monitor',bucket,'42'],payload:{id:'42',handle:'target',relationship:{following:false,followedBy:true}}}));
  const patches=[],resolved=[];
  const job={id:'job',accountId:'123',handle:'target',state:'skipped',targetUserId:'42',followResult:{reason:'关注/粉丝比例低于 80%'}};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding}),set:async()=>{}}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  let following=false;
  const runtime=createFollowQueueRuntime({api,store:{lookup:async()=>job,resolveJob:async p=>{resolved.push(p);Object.assign(job,p);return {ok:true,job};}},
    records:{lookupAll:async({bucket})=>rows.filter(row=>row.sourcePath[1]===bucket),batch:async p=>patches.push(p)},
    fetchUser:async()=>({id:'42',handle:'target',relationshipKnown:true,relationship:{following,followedBy:true}}),
    performFollow:async()=>{throw new Error('inspection must never follow');}});
  await runtime.handle({cmd:'followQueueInspectFan',handle:'target'});
  assert.equal(resolved.length,0);
  assert.deepEqual(patches[0].changes.map(x=>x.sourceBucket),['users','queue','followingUsers']);
  following=true;
  await runtime.handle({cmd:'followQueueInspectFan',handle:'target'});
  assert.equal(resolved.at(-1).state,'followed');
  following=false;
  await runtime.handle({cmd:'followQueueInspectFan',handle:'target'});
  assert.equal(resolved.at(-1).state,'uncertain');
  assert.equal(resolved.at(-1).followResult.following,false);
});

test('record source synchronization ignores conflicting fans and preserves completed jobs across repeated syncs', async () => {
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const source={module:'fans',url:'',enabled:true};
  const prior={id:'done',handle:'done',state:'followed',sources:[source],followBackCandidate:false,followResult:{following:true,succeeded:true}};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  let enqueued=0,resolved=0;
  const records={sourcePage:async({sourceKey})=>({records:sourceKey==='monitor'?['done','conflict'].map(handle=>({module:'fans',sourcePath:['monitor','queue',handle],payload:{handle,state:'follow_back',relationship:{following:false,followedBy:true}}})):[]}),
    profiles:async()=>[],lookupAll:async()=>[],fanDirectory:async()=>[{handle:'done',payload:{fanCategory:'mutual',relationship:{following:true,followedBy:true}}},{handle:'conflict',payload:{fanCategory:'unknown',relationship:{following:null,followedBy:true}}}]};
  const store={lookup:async({handle})=>handle==='done'?prior:null,getSettings:async()=>({followBackAllowAll:true}),enqueue:async()=>{enqueued++;},resolveJob:async()=>{resolved++;},importOutcome:async()=>{throw new Error('must not replace completion');}};
  const runtime=createFollowQueueRuntime({api,records,store});
  await runtime.syncCandidates();await runtime.syncCandidates();
  assert.equal(prior.state,'followed');assert.equal(enqueued,0);assert.equal(resolved,0);
});

test('fan inspection excludes former followers only for fan-only pending tasks',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const row={sourcePath:['monitor','queue','target'],payload:{handle:'target',id:'42'}};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const job={id:'job',handle:'target',state:'pending',targetUserId:'42',sources:[{module:'fans',enabled:true}]};const resolutions=[];
  const runtime=createFollowQueueRuntime({api,store:{lookup:async()=>job,resolveJob:async p=>{resolutions.push(p);return {ok:true}}},
    records:{lookupAll:async({bucket})=>bucket==='queue'?[row]:[],batch:async()=>{}},
    fetchUser:async()=>({id:'42',relationshipKnown:true,relationship:{following:false,followedBy:false}})});
  await runtime.handle({cmd:'followQueueInspectFan',handle:'target'});
  assert.equal(resolutions[0].state,'excluded');
  job.sources.push({module:'comments',enabled:true});
  await runtime.handle({cmd:'followQueueInspectFan',handle:'target'});assert.equal(resolutions.length,1);
});

test('incomplete live relationship clears stale pending labels and holds an unattempted queue job',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const patches=[],resolutions=[];
  const job={id:'job',handle:'target',state:'pending',targetUserId:'42'};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  const runtime=createFollowQueueRuntime({api,store:{lookup:async()=>job,resolveJob:async p=>{resolutions.push(p);return {ok:true}}},
    records:{lookupAll:async({bucket})=>bucket==='queue'?[{sourcePath:['monitor','queue','target'],payload:{id:'42'}}]:[],batch:async p=>patches.push(p)},
    fetchUser:async()=>({id:'42',relationshipKnown:false,relationship:{following:false,followedBy:null}})});
  await assert.rejects(runtime.handle({cmd:'followQueueInspectFan',handle:'target'}),/完整关注关系/);
  assert.equal(resolutions[0].state,'uncertain');assert.equal(patches[0].changes[0].patch.state,'unknown');
  assert.deepEqual(patches[0].changes[0].patch.relationship,{following:null,followedBy:null});
});

test('cancelled fan inspection cannot write a late profile response to records or jobs',async()=>{
  const binding={accountId:'123',handle:'viewer',activated:true,sources:{fans:true}};
  const api={storage:{local:{get:async()=>({followQueueBinding:binding})}},tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:'viewer'}]}};
  let release,began,writes=0;const entered=new Promise(r=>began=r);
  const runtime=createFollowQueueRuntime({api,store:{lookup:async()=>null,enqueue:async()=>{writes++;}},
    records:{lookupAll:async({bucket})=>bucket==='queue'?[{sourcePath:['monitor','queue','target'],payload:{id:'42'}}]:[],batch:async()=>{writes++;}},
    fetchUser:async()=>{began();return new Promise(r=>release=r)}});
  const controller=new AbortController();
  const request=runtime.handle({cmd:'followQueueInspectFan',handle:'target',signal:controller.signal});await entered;
  controller.abort();release({id:'42',relationshipKnown:true,relationship:{following:true,followedBy:true}});
  await assert.rejects(request,{name:'AbortError'});assert.equal(writes,0);
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
  assert.equal(quotePublicationState({ok:false,attempted:false,reason:'X disabled send'}),'draft');
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
