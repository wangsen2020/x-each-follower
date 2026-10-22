import {planBatch,batchVariables,finishBatch,MIN_BATCH_DELAY} from '../src/features/post-tracking/post-scanner.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {parseOwnAnalytics, mergePost, evaluatePost, selectPostPage, analyticsRange,dueReviewPosts} from '../src/features/post-tracking/post-model.js';
import {createPostStore} from '../src/features/post-tracking/post-store.js';
import {createPostRuntime} from '../src/features/post-tracking/post-runtime.js';

const NOW=Date.UTC(2026,9,21,8);
function payload({owner='123',id='2112818349029900798',text='具体正文',metrics=[{metric_type:'Impressions',metric_value:12},{metric_type:'Likes'}],createdAt=NOW-8*86400000}={}){
 return {data:{viewer_v2:{user_results:{result:{__typename:'User',rest_id:owner,core:{screen_name:'tester'},tweets_results:[{rest_id:id,result:{__typename:'Tweet',rest_id:id,details:{created_at_ms:createdAt,full_text:text},organic_metrics_total:metrics}}]}}}}};
}
function post(overrides={}){return {...parseOwnAnalytics(payload(),NOW).posts[0],...overrides};}
test('own analytics validates viewer, retains string IDs, and distinguishes omitted zero from missing data',()=>{
 const parsed=parseOwnAnalytics(payload(),NOW);assert.equal(parsed.owner.id,'123');assert.equal(parsed.posts[0].postId,'2112818349029900798');
 assert.equal(parsed.posts[0].metrics.likes,0);assert.equal(parsed.posts[0].metricStates.likes,'omitted-as-zero');assert.equal(parsed.posts[0].metrics.replies,null);
 assert.throws(()=>parseOwnAnalytics({errors:[{message:'access denied'}]}),/denied/);
 assert.throws(()=>parseOwnAnalytics({data:{}}),/不完整/);
});
test('empty metric groups and visibility wrappers cannot turn into zero-exposure posts',()=>{
 const p=payload({metrics:[]});p.data.viewer_v2.user_results.result.tweets_results.push({rest_id:'55',result:{__typename:'TweetWithVisibilityResults'}});
 const r=parseOwnAnalytics(p,NOW);assert.equal(r.coverage.unavailable,1);assert.equal(r.posts.length,1);assert.equal(r.posts[0].metrics.impressions,null);
 assert.deepEqual(r.unavailableIds,['55']);
});
test('latest thirty uses timestamps and exact Snowflake ordering instead of impression rankings',()=>{
 const rows=Array.from({length:35},(_,i)=>post({postId:String(2112818349029900798n+BigInt(i)),createdAt:NOW-i*1000,metrics:{impressions:i*100},deletion:null}));
 const page=selectPostPage(rows,{pageSize:100,sort:'impressions'},NOW);assert.equal(page.monitored,30);assert.equal(page.rows[0].postId,rows[34].postId);assert.equal(page.rows[0].monitored,false);
 assert.equal(selectPostPage(rows,{pageSize:100},NOW).rows[0].postId,rows[0].postId);
 assert.equal(selectPostPage(rows,{onlyMonitored:true,pageSize:100},NOW).total,30);
 const tied=[post({postId:'2112818349029900798'}),post({postId:'2112818349029900799'})];assert.equal(selectPostPage(tied,{},NOW).rows[0].postId,'2112818349029900799');
});
test('snapshot merging survives refresh while preserving protection, review, and deletion tombstones',()=>{
 const first=mergePost(null,post());first.protected=true;first.retained=true;first.grokReview={keep:true,score:8,reason:'具体价值'};first.review={score:8};first.deletion={status:'uncertain'};
 const second=mergePost(first,post({capturedAt:NOW+1000}));assert.equal(second.snapshots.length,1);assert.equal(second.review.score,8);assert.equal(second.protected,true);assert.equal(second.retained,true);assert.equal(second.grokReview.score,8);assert.equal(second.deletion.status,'uncertain');
 const changed=mergePost(second,post({text:'修改后的正文',capturedAt:NOW+3600000}));assert.equal(changed.review,null);assert.equal(changed.grokReview,null);assert.equal(changed.snapshots.length,2);
});
test('unavailable metrics cannot participate in low-value decisions and automatic sources are exact',()=>{
 const unknown=post({availability:'unavailable',review:{score:1,reason:'旧审核'}});
 assert.equal(evaluatePost(unknown,[unknown],NOW).low,false);assert.equal(evaluatePost(unknown,[unknown],NOW).deleteSuggested,false);
 const rows=[post({postId:'1',source:{kind:'auto-quote'}}),post({postId:'2',text:'普通手动帖 #互关'})];
 assert.equal(selectPostPage(rows,{type:'auto-quote'},NOW).total,1);
});
test('mature automatic quotes outside the latest thirty retain daily follow-up without touching protected posts',()=>{
 const due=post({capturedAt:NOW-2*86400000,source:{kind:'auto-quote'}});
 assert.equal(dueReviewPosts([due],new Set(),NOW).length,1);
 assert.equal(dueReviewPosts([due],new Set([due.postId]),NOW).length,0);
 assert.equal(dueReviewPosts([{...due,protected:true}],new Set(),NOW).length,0);
 assert.equal(dueReviewPosts([{...due,source:null}],new Set(),NOW).length,0);
});
test('metrics determine initial value while Grok advice stays advisory and human decisions prevail',()=>{
 const peers=Array.from({length:25},(_,i)=>post({postId:String(i+1),metrics:{impressions:100},metricStates:{impressions:'explicit'}}));
 const candidate=evaluatePost(post({metrics:{impressions:1}}),peers,NOW);
 assert.equal(candidate.low,true);assert.equal(candidate.contentScore,null);assert.equal(candidate.deleteSuggested,false);assert.match(candidate.reason,/指标匹配/);
 assert.equal(evaluatePost(post({review:{score:9,reason:'旧人工结论'},grokReview:{keep:true,score:9,reason:'值得保留'},metrics:{impressions:1}}),peers,NOW).low,true);
 assert.equal(evaluatePost(post({retained:true,metrics:{impressions:1}}),peers,NOW).low,false);
 assert.equal(evaluatePost(post({protected:true,review:{score:1}}),peers,NOW).low,false);
 assert.equal(evaluatePost(post({createdAt:NOW-3600000,review:{score:1}}),peers,NOW).low,false);
});
test('repeated text alone cannot change metrics-first classification',()=>{
 const p=post({text:'这是一条重复的具体内容 #互关'});const other=post({postId:'55',text:'这是一条重复的具体内容 #互粉'});
 const e=evaluatePost(p,[p,other],NOW);assert.equal(e.low,false);assert.equal(e.contentScore,null);assert.equal(e.deleteSuggested,false);
});
test('posting range uses UTC calendar boundaries and page filters keep unknown metrics at bottom',()=>{
 const r=analyticsRange(14,NOW);assert.equal(r.from_time,'2026-10-08T00:00:00.000Z');assert.equal(r.to_time,'2026-10-21T23:59:59.999Z');
 const rows=[post({postId:'1',metrics:{impressions:null}}),post({postId:'2',metrics:{impressions:0}})];assert.equal(selectPostPage(rows,{sort:'impressions',direction:'asc'},NOW).rows[1].postId,'1');
});
test('post store isolates accounts and persists across service reconstruction',async()=>{
 const name=crypto.randomUUID();const a=createPostStore({indexedDB,name});await a.put(post());await a.put(post({ownerId:'456',text:'另一个账号'}));
 await a.putIntent({id:'intent',status:'sending'});const b=createPostStore({indexedDB,name});assert.equal((await b.list('123')).length,1);assert.equal((await b.get('456','2112818349029900798')).text,'另一个账号');assert.equal((await b.intent('intent')).status,'sending');
});
function fixture(){
 const requests=[],alarms=[],tabs=[],sleeps=[];let failure=null,bootstrapMode='success',captureFresh=true;
 let clock=NOW;const settings={ownPostTracking:{ownerId:'123',owner:{id:'123',handle:'tester'},enabled:true},networkTemplates:{contentPageQuery:{at:NOW,headers:{'x-csrf-token':'fixture'}}}};let deletes=0;let live=payload();let detail={data:{}};let mutation={status:200,json:{data:{}}};
 const store=createPostStore({indexedDB,name:crypto.randomUUID()});
 const api={storage:{local:{get:async k=>({[k]:settings[k]}),set:async values=>Object.assign(settings,values)}},alarms:{create:async(name,info)=>alarms.push({name,...info}),clear:async name=>alarms.push({name,cleared:true})},tabs:{create:async options=>{tabs.push(options);const bootstrapUrl=new URL(options.url);if(bootstrapUrl.searchParams.has('xef_post_bootstrap')&&bootstrapMode!=='timeout')settings.postAnalyticsBootstrap={id:bootstrapUrl.searchParams.get('xef_post_bootstrap'),tabId:bootstrapMode==='wrong-tab'?999:5,json:live,...(bootstrapMode==='429'?{status:429,retryAfterSeconds:7200}:{})};if(captureFresh)settings.networkTemplates={contentPageQuery:{at:clock,headers:{'x-csrf-token':'fixture'}},TweetDetail:{at:clock,headers:{'x-csrf-token':'fixture'}}};return{id:5};},remove:async()=>{}}};
 const runtime=createPostRuntime({api,store,now:()=>clock,sleep:async ms=>{sleeps.push(ms);},fetchAnalytics:async(tabId,variables)=>{requests.push(variables);return failure||{status:200,json:live};},deletePost:async()=>{deletes++;return typeof mutation==='function'?mutation():mutation;},fetchDetail:async()=>({status:200,json:typeof detail==='function'?detail():detail})});
 return {api,runtime,store,settings,requests,alarms,tabs,sleeps,setCaptureFresh:value=>{captureFresh=value;},setBootstrapMode:value=>{bootstrapMode=value;},setFailure:value=>{failure=value;},setLive:v=>{live=v;},setDetail:v=>{detail=v;},setMutation:v=>{mutation=v;},advance:v=>{clock+=v;},deletes:()=>deletes};
}
test('sync follows the logged-in viewer automatically without applying the old account cursor',async()=>{
 const f=fixture();await f.runtime.sync();assert.equal((await f.runtime.handle({op:'page'})).total,1);
 const oldScanner=structuredClone((await f.store.meta('123')).scanner);f.advance(15*60000);f.setLive(payload({owner:'456'}));const changed=await f.runtime.sync();assert.equal(changed.accountUpdated,true);assert.equal(f.settings.ownPostTracking.ownerId,'456');assert.equal((await f.runtime.handle({op:'page'})).total,0);assert.equal((await f.store.list('123')).length,1);assert.deepEqual((await f.store.meta('123')).scanner,oldScanner);assert.equal(await f.store.meta('456'),undefined);
 f.advance(MIN_BATCH_DELAY);await f.runtime.sync();assert.equal((await f.runtime.handle({op:'page'})).total,1);assert.equal((await f.store.list('456')).length,1);
});
test('deletion requires a specific unexpired confirmation and protected posts cannot prepare deletion',async()=>{
 const f=fixture();await f.runtime.sync();const approval=await f.runtime.handle({op:'prepareDelete',postId:'2112818349029900798'});
 await assert.rejects(f.runtime.handle({op:'confirmDelete',approvalId:approval.approvalId}),/必须由用户确认/);assert.equal(f.deletes(),0);
 f.advance(121000);await assert.rejects(f.runtime.handle({op:'confirmDelete',approvalId:approval.approvalId,confirmed:true}),/过期/);
 await f.runtime.handle({op:'mark',postId:approval.postId,protected:true});await assert.rejects(f.runtime.handle({op:'prepareDelete',postId:approval.postId}),/受保护/);assert.equal(f.deletes(),0);
});
test('live author or text changes block the mutation even after explicit confirmation',async()=>{
 const f=fixture();await f.runtime.sync();const a=await f.runtime.handle({op:'prepareDelete',postId:'2112818349029900798'});f.setLive(payload({text:'changed'}));
 await assert.rejects(f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true}),/核验不通过/);assert.equal(f.deletes(),0);
});
test('switching away and back invalidates prepared approvals even for the same account',async()=>{
 const f=fixture();await f.runtime.sync();const a=await f.runtime.handle({op:'prepareDelete',postId:'2112818349029900798'});
 const oldIntent=await f.store.intent(a.approvalId);oldIntent.expiresAt=NOW+10*86400000;await f.store.putIntent(oldIntent);
 f.advance(15*60000);f.setLive(payload({owner:'456'}));await f.runtime.sync();f.advance(MIN_BATCH_DELAY);f.setLive(payload());await f.runtime.sync();assert.notEqual(f.settings.ownPostTracking.bindingNonce,oldIntent.bindingNonce);
 await assert.rejects(f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true}),/账号已切换/);assert.equal(f.deletes(),0);
});
test('stale review text cannot apply an old assessment to a changed post',async()=>{
 const f=fixture();await f.runtime.sync();await assert.rejects(f.runtime.handle({op:'mark',postId:'2112818349029900798',score:2,reason:'旧文本',expectedText:'不是当前正文'}),/正文已变更/);
 assert.equal((await f.store.get('123','2112818349029900798')).review, null);
});
test('HTTP 200 and missing post are not deletion proof; confirmation is never replayed',async()=>{
 const f=fixture();await f.runtime.sync();const a=await f.runtime.handle({op:'prepareDelete',postId:'2112818349029900798'});
 const result=await f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true});assert.equal(result.deletion.status,'uncertain');assert.equal(f.deletes(),1);
 await assert.rejects(f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true}),/已使用/);assert.equal(f.deletes(),1);
 assert.equal((await f.runtime.handle({op:'page'})).total,1);
});
test('a deleted reply cannot be mistaken for deletion of the focal post',async()=>{
 const f=fixture();await f.runtime.sync();const a=await f.runtime.handle({op:'prepareDelete',postId:'2112818349029900798'});
 f.setDetail({data:{entries:[{entryId:'tweet-99',content:{__typename:'TweetTombstone',text:'This Post was deleted'}}]}});
 const r=await f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true});assert.equal(r.deletion.status,'uncertain');
 f.setDetail({data:{entries:[{entryId:'tweet-2112818349029900798',content:{__typename:'TweetTombstone',text:'This Post was deleted'}}]}});
 await f.runtime.handle({op:'verify',postId:a.postId});assert.equal((await f.store.get('123',a.postId)).deletion.status,'verified');assert.equal((await f.runtime.handle({op:'page'})).total,0);
});
test('exact empty focal entry requires the matching mutation receipt and reconciles the durable intent',async()=>{
 const f=fixture();await f.runtime.sync();const id='2112818349029900798';const a=await f.runtime.handle({op:'prepareDelete',postId:id});
 f.setDetail({data:{entries:[{entryId:`tweet-${id}`,content:{itemContent:{__typename:'TimelineTweet',tweet_results:{}}}}]}});
 const unacknowledged=await f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true});assert.equal(unacknowledged.deletion.status,'uncertain');
 const p=await f.store.get('123',id);p.deletion.serverAcknowledged=true;p.deletion.acknowledgedPostId='different-id';await f.store.put(p);
 await f.runtime.handle({op:'verify',postId:id});assert.equal((await f.store.get('123',id)).deletion.status,'uncertain');
 p.deletion.acknowledgedPostId=id;await f.store.put(p);await f.runtime.handle({op:'verify',postId:id});
 assert.equal((await f.store.get('123',id)).deletion.verification,'acknowledged-focal-empty');assert.equal((await f.store.intent(a.approvalId)).status,'verified');assert.equal(f.deletes(),1);
});
test('acknowledged mutation does not count another post empty entry as deletion proof',async()=>{
 const f=fixture();await f.runtime.sync();const id='2112818349029900798';const a=await f.runtime.handle({op:'prepareDelete',postId:id});
 f.setMutation({status:200,json:{data:{delete_tweet:{tweet_results:{}}}}});
 f.setDetail({data:{entries:[{entryId:'tweet-99',content:{itemContent:{__typename:'TimelineTweet',tweet_results:{}}}}]}});
 const r=await f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true});assert.equal(r.deletion.serverAcknowledged,true);assert.equal(r.deletion.status,'uncertain');
});

test('one detection performs one bounded request and cooldown blocks repeated clicks and alarm delivery',async()=>{
 const f=fixture();await f.runtime.sync();assert.equal(f.requests.length,1);assert.equal(f.requests[0].max_results,100);assert.equal(f.requests[0].query_page_size,100);assert.equal(f.tabs[0].url,'https://x.com/home');
 await assert.rejects(f.runtime.sync(),/下批检测/);assert.equal((await f.runtime.sync({background:true})).skipped,true);assert.equal(f.requests.length,1);assert.equal(f.settings.ownPostTracking.nextBatchAt,NOW+15*60000);
 assert.equal(f.alarms.at(-1).when,NOW+15*60000);assert.equal(f.alarms.at(-1).periodInMinutes,undefined);
});

test('full and oversized responses split the saved window without ingesting partial results or immediate retry',async()=>{
 const f=fixture();const data=payload();const row=data.data.viewer_v2.user_results.result.tweets_results[0];data.data.viewer_v2.user_results.result.tweets_results=Array.from({length:131},()=>row);f.setLive(data);
 const first=await f.runtime.sync();assert.equal(first.split,true);assert.equal(first.received,0);assert.equal(f.requests.length,1);assert.equal((await f.store.list('123')).length,0);
 const meta=await f.store.meta('123');assert.equal(meta.scanner.lanes.recent.pending.length,2);assert.equal(meta.scanner.phase,0);
 f.advance(15*60000);f.setLive(payload());await f.runtime.sync();assert.equal(f.requests.length,2);assert.ok(Date.parse(f.requests[1].from_time)>Date.parse(f.requests[0].from_time));assert.equal(f.requests[1].to_time,f.requests[0].to_time);
 assert.equal((await f.store.meta('123')).scanner.lanes.recent.pending.length,1);
});

test('scan lanes preserve inclusive coverage on split, rotate priorities, and cycle history',()=>{
 const p=planBatch(null,[],14,NOW);const original={...p.window};const split=finishBatch(p,100,NOW);const [upper,lower]=split.lanes.recent.pending;assert.equal(lower.from,original.from);assert.equal(upper.to,original.to);assert.equal(lower.to+1,upper.from);
 const next=planBatch(JSON.parse(JSON.stringify(split)),[],14,NOW+900000);assert.deepEqual(next.window,upper);const resumed=finishBatch(next,5,NOW+900000);assert.equal(resumed.phase,1);
 const h=planBatch(resumed,[],14,NOW+1800000);assert.equal(h.lane,'history');assert.equal(batchVariables(h.window).max_results,100);
 const historical=finishBatch(h,0,NOW+1800000);const recentAgain=planBatch(historical,[],14,NOW+2700000);assert.equal(recentAgain.lane,'history');
 const afterHistory=finishBatch(recentAgain,0,NOW+2700000);const head=planBatch(afterHistory,[],14,NOW+3600000);assert.equal(head.lane,'head');const afterHead=finishBatch(head,0,NOW+3600000);assert.equal(planBatch(afterHead,[],14,NOW+4500000).lane,'recent');
});

test('stale automatic and low-review posts receive a dedicated review lane without scanning all history',()=>{
 const due=post({source:{kind:'auto-quote'},capturedAt:NOW-2*86400000});const p=planBatch({version:1,phase:1,lanes:{},batches:0},[due],14,NOW);assert.equal(p.lane,'review');assert.ok(p.window.from<=due.createdAt&&p.window.to>=due.createdAt);assert.ok(p.window.to-p.window.from<6*3600000);
 const protectedPlan=planBatch({version:1,phase:1,lanes:{},batches:0},[{...due,protected:true}],14,NOW);assert.equal(protectedPlan.lane,'history');
});

test('retry-after survives failure, skips network while cooling, and leaves cursor unadvanced',async()=>{
 const f=fixture();f.setFailure({status:429,error:'limited',retryAfterSeconds:7200});await assert.rejects(f.runtime.sync(),/limited/);assert.equal(f.settings.ownPostTracking.retryAfter,NOW+7200000);assert.equal(f.requests.length,1);assert.equal((await f.store.meta('123')).scanner,undefined);
 f.advance(3600000);assert.equal((await f.runtime.sync({background:true})).skipped,true);assert.equal(f.requests.length,1);f.advance(3600000);f.setFailure(null);await f.runtime.sync();assert.equal(f.requests.length,2);assert.equal(f.settings.ownPostTracking.failures,0);
});

test('schedule restoration keeps its persisted deadline and pause clears alarm without deleting progress',async()=>{
 const f=fixture();await f.runtime.schedule();const deadline=f.settings.ownPostTracking.nextBatchAt;f.advance(1000);await f.runtime.schedule();assert.equal(f.settings.ownPostTracking.nextBatchAt,deadline);
 await f.runtime.handle({op:'settings',enabled:false,intervalMinutes:30});assert.equal(f.alarms.at(-1).cleared,true);assert.equal((await f.runtime.sync({background:true})).skipped,true);assert.equal(f.requests.length,0);
 await f.runtime.handle({op:'settings',enabled:true,intervalMinutes:30});assert.equal(f.settings.ownPostTracking.intervalMinutes,30);assert.ok(f.alarms.at(-1).when>=NOW+MIN_BATCH_DELAY);
});

test('changing history scope preserves cooldown and takes effect on the next planned batch',async()=>{
 const f=fixture();await f.runtime.sync();const before=f.settings.ownPostTracking.nextBatchAt;await f.runtime.handle({op:'settings',days:90});assert.equal(f.settings.ownPostTracking.days,90);assert.equal(f.settings.ownPostTracking.nextBatchAt,before);assert.equal(f.requests.length,1);f.advance(15*60000);await f.runtime.sync({background:true});const meta=await f.store.meta('123');assert.equal(meta.scanner.lanes.history.days,90);assert.ok(Date.parse(f.requests[1].from_time)>NOW-86400000);
});

test('configured batch size reaches both request limits and survives later settings updates',async()=>{
 const f=fixture();await f.runtime.handle({op:'settings',batchLimit:50,reviewIntervalHours:12});f.advance(MIN_BATCH_DELAY);await f.runtime.sync();assert.equal(f.requests[0].max_results,50);assert.equal(f.requests[0].query_page_size,50);assert.equal((await f.store.meta('123')).scanner.last.limit,50);
 await f.runtime.handle({op:'settings',intervalMinutes:30});assert.equal(f.settings.ownPostTracking.batchLimit,50);assert.equal(f.settings.ownPostTracking.reviewIntervalHours,12);
});

test('custom full-batch threshold splits the window and does not ingest an oversized response',async()=>{
 const f=fixture();await f.runtime.handle({op:'settings',batchLimit:20});f.advance(MIN_BATCH_DELAY);const data=payload(),row=data.data.viewer_v2.user_results.result.tweets_results[0];data.data.viewer_v2.user_results.result.tweets_results=Array.from({length:30},()=>row);f.setLive(data);const result=await f.runtime.sync();assert.equal(result.split,true);assert.equal(result.received,0);assert.equal(f.requests.length,1);assert.equal(f.requests[0].max_results,20);assert.equal((await f.store.list('123')).length,0);assert.equal((await f.store.meta('123')).scanner.lanes.recent.pending.length,2);
});

test('invalid batch sizes and review periods never overwrite persisted settings',async()=>{
 const f=fixture();await f.runtime.handle({op:'settings',batchLimit:50});const original=structuredClone(f.settings.ownPostTracking);
 for(const value of [0,9,1001,10000,20.5,'bad'])await assert.rejects(f.runtime.handle({op:'settings',batchLimit:value}),/10–1000/);
 await assert.rejects(f.runtime.handle({op:'settings',reviewIntervalHours:1}),/12、24或48/);assert.deepEqual(f.settings.ownPostTracking,original);
});

test('review period controls eligibility without changing the fixed recent thirty monitoring set',()=>{
 const due=post({source:{kind:'auto-quote'},capturedAt:NOW-18*3600000});const state={version:1,phase:1,lanes:{},batches:0};assert.equal(planBatch(state,[due],14,NOW,{reviewIntervalHours:12}).lane,'review');assert.equal(planBatch(state,[due],14,NOW,{reviewIntervalHours:24}).lane,'history');assert.equal(selectPostPage([due],{},NOW).monitored,1);
});

test('first synchronization bootstraps a bounded native analysis request without needing a preexisting template',async()=>{
 const f=fixture();f.settings.ownPostTracking={batchLimit:50};f.settings.networkTemplates={};const result=await f.runtime.sync();assert.equal(result.received,1);assert.equal(f.requests.length,0);assert.equal(f.tabs.length,1);const u=new URL(f.tabs[0].url);assert.equal(u.searchParams.get('xef_limit'),'50');assert.ok(u.searchParams.get('xef_post_bootstrap'));assert.ok(Number(u.searchParams.get('xef_to'))-Number(u.searchParams.get('xef_from'))<=6*3600000);assert.equal(f.settings.ownPostTracking.ownerId,'123');assert.equal((await f.runtime.handle({op:'page'})).total,1);assert.equal(f.settings.postAnalyticsBootstrap,null);
});

test('bootstrap does not accept another tab receipt and persists actionable first-use failure',async()=>{
 const f=fixture();f.settings.ownPostTracking={};f.settings.networkTemplates={};f.setBootstrapMode('wrong-tab');await assert.rejects(f.runtime.sync(),/首次分析未完成/);assert.equal(f.settings.ownPostTracking.ownerId,undefined);const page=await f.runtime.handle({op:'page'});assert.match(page.meta.error,/登录/);const count=f.tabs.length;await f.runtime.handle({op:'page'});assert.equal(f.tabs.length,count);assert.equal(f.requests.length,0);
});

test('manual refresh can run after the minimum gap while a later periodic alarm still waits',async()=>{
 const f=fixture();await f.runtime.sync();f.advance(MIN_BATCH_DELAY);assert.equal((await f.runtime.sync({background:true})).skipped,true);assert.equal(f.requests.length,1);await f.runtime.sync();assert.equal(f.requests.length,2);await assert.rejects(f.runtime.sync(),/下批检测/);
});

test('first-use rate limits preserve Retry-After and become visible without an established account',async()=>{
 const f=fixture();f.settings.ownPostTracking={};f.settings.networkTemplates={};f.setBootstrapMode('429');await assert.rejects(f.runtime.sync(),/429/);assert.equal(f.settings.ownPostTracking.retryAfter,NOW+7200000);assert.match((await f.runtime.handle({op:'page'})).meta.error,/429/);assert.equal(f.requests.length,0);
});

test('low rules change maturity and relative exposure gates without manual scoring',()=>{
 const peers=Array.from({length:25},(_,i)=>post({postId:String(i+1),metrics:{impressions:100}}));
 const young=post({createdAt:NOW-48*3600000,metrics:{impressions:1}}),youngPeers=peers.map(p=>({...p,createdAt:young.createdAt}));
 assert.equal(evaluatePost(young,youngPeers,NOW).low,false);
 assert.equal(evaluatePost(young,youngPeers,NOW,undefined,{matureHours:24}).low,true);
 assert.equal(evaluatePost(post({review:{score:9},metrics:{impressions:1}}),peers,NOW).low,true);
 assert.equal(evaluatePost(post({metrics:{impressions:1}}),peers,NOW,undefined,{sampleMin:30}).low,false);
 assert.equal(evaluatePost(post({metrics:{impressions:20}}),peers,NOW,undefined,{medianPercent:10}).performance,'normal');
 const varied=peers.map((p,i)=>({...p,metrics:{impressions:i<4?0:100}}));
 assert.equal(evaluatePost(post({metrics:{impressions:1}}),varied,NOW,undefined,{lowPercentile:10}).low,false);
 assert.equal(evaluatePost(post({metrics:{impressions:101}}),peers,NOW,undefined,{sampleMin:30}).high,true);
});

test('configurable stagnation is a metric signal and never authorizes deletion',()=>{
 const p=post({metrics:{impressions:10},snapshots:[{at:NOW-24*3600000,metrics:{impressions:4},states:{impressions:'explicit'}}]});
 const rules={stagnantHours:24,stagnantAbsolute:6,stagnantPercent:0};
 assert.equal(evaluatePost(p,[],NOW).stagnant,false);
 assert.equal(evaluatePost(p,[],NOW,undefined,rules).stagnant,true);
 assert.equal(evaluatePost(p,[],NOW,undefined,{...rules,stagnantAbsolute:5}).stagnant,false);
 assert.equal(evaluatePost(p,[],NOW,undefined,{...rules,stagnantAbsolute:0,stagnantPercent:100}).stagnant,false);
 assert.equal(evaluatePost({...p,metrics:{impressions:8}},[],NOW,undefined,{...rules,stagnantAbsolute:0,stagnantPercent:100}).stagnant,true);
 assert.equal(evaluatePost({...p,snapshots:[]},[],NOW,undefined,rules).stagnant,false);
 assert.equal(evaluatePost(p,[],NOW,undefined,rules).deleteSuggested,false);
});

test('saved low rules immediately affect pages, survive reconstruction and reach scheduled review',async()=>{
 const f=fixture();await f.runtime.sync();const p=await f.store.get('123','2112818349029900798');p.review={score:1};p.metrics.impressions=1;p.createdAt=NOW-48*3600000;p.source={kind:'auto-quote'};await f.store.putMany([p,...Array.from({length:25},(_,i)=>post({postId:String(i+1000),createdAt:p.createdAt,metrics:{impressions:100}}))]);
 assert.equal((await f.runtime.handle({op:'page',options:{view:'low'}})).total,0);
 const {normalizeLowRules}=await import('../src/features/post-tracking/post-rules.js');
 const rules=normalizeLowRules({matureHours:24});
 await f.runtime.handle({op:'settings',lowRules:rules});
 assert.equal((await f.runtime.handle({op:'page',options:{view:'low'}})).total,1);
 await f.runtime.handle({op:'settings',intervalMinutes:30});assert.deepEqual(f.settings.ownPostTracking.lowRules,rules);
 const restored=createPostRuntime({api:{storage:{local:{get:async()=>({ownPostTracking:f.settings.ownPostTracking})}}},store:f.store,now:()=>NOW});
 assert.equal((await restored.handle({op:'page',options:{view:'low'}})).total,1);
 const due={...p,createdAt:NOW-48*3600000,capturedAt:NOW-25*3600000};
 assert.equal(planBatch({version:1,phase:1,lanes:{},batches:0},[due],14,NOW,{lowRules:rules}).lane,'review');
 assert.equal(planBatch({version:1,phase:1,lanes:{},batches:0},[due],14,NOW).lane,'history');
 const count=f.requests.length;assert.equal('scoreMax' in rules,false);assert.equal('deleteAgeDays' in rules,false);
 await assert.rejects(f.runtime.handle({op:'settings',lowRules:{...rules,stagnantHours:0}}),/停滞观察/);
 await assert.rejects(f.runtime.handle({op:'settings',lowRules:{...rules,sampleMin:20.5}}),/同龄样本/);
 await assert.rejects(f.runtime.handle({op:'settings',lowRules:{...rules,matureHours:''}}),/观察时长/);
 assert.deepEqual(f.settings.ownPostTracking.lowRules,rules);assert.equal(f.requests.length,count);assert.equal(f.deletes(),0);
});

async function deleteBatchFixture(){
 const f=fixture();await f.runtime.sync();const id1='2112818349029900798',id2='2112818349029900799';
 const live=payload(),second=payload({id:id2,text:'第二条待核对帖子'}).data.viewer_v2.user_results.result.tweets_results[0];live.data.viewer_v2.user_results.result.tweets_results.push(second);f.setLive(live);await f.store.putMany(parseOwnAnalytics(live,NOW).posts);
 f.setMutation({status:200,json:{data:{delete_tweet:{tweet_results:{}}}}});f.setDetail({data:{entries:[id1,id2].map(id=>({entryId:`tweet-${id}`,content:{__typename:'TweetTombstone',text:'This Post was deleted'}}))}});
 return {...f,ids:[id1,id2]};
}
test('page reconciles batch selections across filters and removes protected or deleted posts',async()=>{
 const f=await deleteBatchFixture();
 const first=await f.runtime.handle({op:'page',options:{view:'low',selectedPostIds:f.ids}});
 assert.deepEqual(first.selectedPostIds,f.ids);
 const protectedPost=await f.store.get('123',f.ids[0]);protectedPost.protected=true;await f.store.put(protectedPost);
 const deletedPost=await f.store.get('123',f.ids[1]);deletedPost.deletion={status:'verified'};await f.store.put(deletedPost);
 const next=await f.runtime.handle({op:'page',options:{view:'low',selectedPostIds:f.ids}});
 assert.deepEqual(next.selectedPostIds,[]);
 assert.equal(next.total,0);
 assert.equal(f.deletes(),0);
});
test('batch deletion binds exact approved posts, is serial and durable, and refuses replay',async()=>{
 const f=await deleteBatchFixture();const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids});assert.equal(a.items.length,2);assert.equal(f.deletes(),0);assert.equal(a.owner.handle,'tester');
 await assert.rejects(f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId}),/用户确认/);assert.equal(f.deletes(),0);
 const r=await f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true});assert.equal(r.status,'completed');assert.equal(r.results.length,2);assert.ok(r.results.every(p=>p.status==='verified'));assert.equal(r.remaining,0);assert.equal(f.deletes(),2);
 assert.equal((await f.store.intent(a.batchApprovalId)).status,'completed');assert.equal((await f.runtime.handle({op:'page'})).total,0);
 await assert.rejects(f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true}),/已使用/);assert.equal(f.deletes(),2);
});
test('batch preparation rejects invalid sets, foreign, protected and pending posts without deleting',async()=>{
 const f=await deleteBatchFixture();
 for(const postIds of [[],[f.ids[0],f.ids[0]],Array.from({length:21},(_,i)=>String(i)),[1],[null]])await assert.rejects(f.runtime.handle({op:'prepareBatchDelete',postIds}),/1至20/);
 await f.store.put(post({ownerId:'other',postId:'99'}));await assert.rejects(f.runtime.handle({op:'prepareBatchDelete',postIds:['99']}),/不存在/);
 const p=await f.store.get('123',f.ids[1]);p.protected=true;await f.store.put(p);await assert.rejects(f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids}),/受保护/);
 p.protected=false;p.deletion={status:'uncertain'};await f.store.put(p);await assert.rejects(f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids}),/删除任务/);assert.equal(f.deletes(),0);
});
test('batch validates the whole set before first delete and rejects account changes and expired approvals',async()=>{
 const f=await deleteBatchFixture();const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids});const p=await f.store.get('123',f.ids[1]);p.text='正文已变更';await f.store.put(p);
 await assert.rejects(f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true}),/已变更/);assert.equal(f.deletes(),0);
 const b=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids});const old=f.settings.ownPostTracking.bindingNonce;f.settings.ownPostTracking.bindingNonce='different';
 await assert.rejects(f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:b.batchApprovalId,confirmed:true}),/账号已切换/);f.settings.ownPostTracking.bindingNonce=old;f.advance(600001);
 await assert.rejects(f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:b.batchApprovalId,confirmed:true}),/过期/);assert.equal(f.deletes(),0);
});
test('an uncertain or unsent first deletion stops the batch and leaves other posts intact',async()=>{
 for(const mutation of [{status:429,error:'rate limit'},{status:0,attempted:false,error:'not sent'}]){
 const f=await deleteBatchFixture();f.setMutation(mutation);const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids});const r=await f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true});assert.equal(r.status,'stopped');assert.equal(r.results.length,1);assert.equal(r.remaining,1);assert.equal(f.deletes(),1);assert.equal((await f.store.get('123',f.ids[1])).deletion,undefined);
 await assert.rejects(f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true}),/已使用/);assert.equal(f.deletes(),1);
 }
});
test('live identity or text mismatch stops a batch without sending any deletion',async()=>{
 const f=await deleteBatchFixture();const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids});f.setLive(payload({owner:'456'}));const r=await f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true});assert.equal(r.status,'stopped');assert.equal(r.remaining,1);assert.equal(r.results[0].status,'not-sent');assert.equal(f.deletes(),0);
});

test('three deletes succeed with cached templates and no repeated native analytics capture',async()=>{
 const f=await deleteBatchFixture(),third='2112818349029900800';f.ids.push(third);const live=payload();live.data.viewer_v2.user_results.result.tweets_results.push(...[f.ids[1],third].map(id=>payload({id,text:`目标帖子 ${id}`}).data.viewer_v2.user_results.result.tweets_results[0]));f.setLive(live);await f.store.putMany(parseOwnAnalytics(live,NOW).posts);f.setDetail({data:{entries:f.ids.map(id=>({entryId:`tweet-${id}`,content:{__typename:'TweetTombstone',text:'This Post was deleted'}}))}});
 for(const value of Object.values(f.settings.networkTemplates))value.at=NOW-86400000;f.setCaptureFresh(false);
 const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids}),r=await f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true});
 assert.equal(r.status,'completed');assert.equal(r.results.length,3);assert.equal(f.deletes(),3);assert.ok(r.results.every(p=>p.status==='verified'));
 assert.equal(f.tabs.filter(t=>t.url.includes('/i/account_analytics/')).length,0);assert.equal(f.requests.length,4);
});
test('cached request shape never bypasses live account checks or permits missing templates',async()=>{
 const f=await deleteBatchFixture();f.setCaptureFresh(false);f.settings.networkTemplates={};const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids});const r=await f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true});assert.equal(r.status,'stopped');assert.equal(f.deletes(),0);assert.match(r.results[0].error,/未取得/);
});

test('acknowledged deletion rechecks delayed visibility without resending mutation',async()=>{
 const f=await deleteBatchFixture();const id=f.ids[0];let calls=0;f.setDetail(()=>++calls===1?{data:{rest_id:id,__typename:'Tweet'}}:{data:{entries:[{entryId:`tweet-${id}`,content:{itemContent:{__typename:'TimelineTweet',tweet_results:{}}}}]}});
 const a=await f.runtime.handle({op:'prepareDelete',postId:id}),r=await f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true});assert.equal(r.deletion.status,'verified');assert.equal(f.deletes(),1);assert.equal(calls,2);
});
test('detail rechecks are bounded and keep unresolved deletion uncertain',async()=>{
 const f=await deleteBatchFixture();let calls=0;f.setDetail(()=>{calls++;return {data:{}};});const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids}),r=await f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true});assert.equal(r.status,'stopped');assert.equal(f.deletes(),1);assert.equal(calls,3);assert.equal(r.results[0].status,'uncertain');
});

test('one batch reuses one execution page for all preflights, mutations and detail checks',async()=>{
 const f=await deleteBatchFixture(),before=f.tabs.length;const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids}),r=await f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true});assert.equal(r.status,'completed');assert.equal(f.tabs.length-before,1);assert.equal(f.requests.length,3);assert.equal(f.deletes(),2);assert.ok(r.results.every(p=>Number.isFinite(p.timings.totalMs)));assert.equal(f.sleeps.filter(x=>x===3000).length,1);
});
test('batch pacing counts time spent processing instead of adding three seconds after every item',async()=>{
 const f=await deleteBatchFixture();f.setMutation(()=>{f.advance(3500);return {status:200,json:{data:{delete_tweet:{tweet_results:{}}}}};});const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids}),r=await f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true});assert.equal(r.status,'completed');assert.equal(f.sleeps.includes(3000),false);assert.equal(r.results[0].timings.mutationMs,3500);assert.equal((await f.store.get('123',f.ids[0])).deletion.timings.mutationMs,3500);
});

test('single and batch deletion borrow a loaded X page without navigation or closing user tabs',async()=>{
 for(const batch of [false,true]){const f=await deleteBatchFixture(),before=f.tabs.length,removed=[];f.api.tabs.query=async()=>[{id:42,url:'https://x.com/home',status:'complete',active:false}];f.api.tabs.get=async()=>({status:'complete'});f.api.tabs.remove=async id=>removed.push(id);
 if(batch){const a=await f.runtime.handle({op:'prepareBatchDelete',postIds:f.ids}),r=await f.runtime.handle({op:'confirmBatchDelete',batchApprovalId:a.batchApprovalId,confirmed:true});assert.equal(r.status,'completed');}else{const a=await f.runtime.handle({op:'prepareDelete',postId:f.ids[0]}),r=await f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true});assert.equal(r.deletion.status,'verified');}
 assert.equal(f.tabs.length,before);assert.deepEqual(removed,[]);}
});
test('borrowed pages are preserved on validation failure and no deletion is sent',async()=>{
 const f=await deleteBatchFixture(),removed=[];f.api.tabs.query=async()=>[{id:42,url:'https://x.com/home',status:'complete',active:false}];f.api.tabs.get=async()=>({status:'complete'});f.api.tabs.remove=async id=>removed.push(id);f.setLive(payload({owner:'999'}));const a=await f.runtime.handle({op:'prepareDelete',postId:f.ids[0]});await assert.rejects(f.runtime.handle({op:'confirmDelete',approvalId:a.approvalId,confirmed:true}),/核验不通过/);assert.equal(f.deletes(),0);assert.deepEqual(removed,[]);
});

test('configured 300 and 1000 limits persist and reach actual batch request variables',async()=>{
 for(const limit of [300,1000]){const f=fixture();await f.runtime.handle({op:'settings',batchLimit:limit});f.advance(MIN_BATCH_DELAY);await f.runtime.sync();assert.equal(f.settings.ownPostTracking.batchLimit,limit);assert.equal(f.requests[0].max_results,limit);assert.equal(f.requests[0].query_page_size,limit);assert.equal((await f.store.meta('123')).scanner.last.limit,limit);assert.equal((await f.runtime.handle({op:'page'})).config.batchLimit,limit);}
});
test('1000 batch limit also survives first-use bootstrap without a request template',async()=>{
 const f=fixture();f.settings.ownPostTracking={batchLimit:1000};f.settings.networkTemplates={};await f.runtime.sync();assert.equal(new URL(f.tabs[0].url).searchParams.get('xef_limit'),'1000');assert.equal(f.settings.ownPostTracking.batchLimit,1000);
});

test('manual history imports a 90-day window with 1000 rows without advancing periodic lanes or changing batch size',async()=>{
 const f=fixture();await f.runtime.sync();const scanner=structuredClone((await f.store.meta('123')).scanner);
 const original=await f.store.get('123','2112818349029900798');original.protected=true;original.retained=true;original.grokReview={keep:true,score:8,reason:'具体观点'};await f.store.put(original);
 f.advance(MIN_BATCH_DELAY);const result=await f.runtime.handle({op:'sync',history:true});const variables=f.requests.at(-1);
 assert.equal(Date.parse(variables.to_time)-Date.parse(variables.from_time),90*86400000);assert.equal(variables.max_results,1000);assert.equal(variables.query_page_size,1000);assert.equal(result.historyComplete,true);
 const meta=await f.store.meta('123');assert.deepEqual(meta.scanner,scanner);assert.equal(meta.historyImport.complete,true);assert.equal(f.settings.ownPostTracking.days,90);assert.notEqual(f.settings.ownPostTracking.batchLimit,1000);
 const retained=await f.store.get('123',original.postId);assert.equal(retained.protected,true);assert.equal(retained.retained,true);assert.deepEqual(retained.grokReview,original.grokReview);assert.equal(f.deletes(),0);
 await assert.rejects(f.runtime.sync({history:true}),/下批检测/);
});

test('history import refuses native six-hour bootstrap and cannot run as a background scan',async()=>{
 const f=fixture();f.settings.networkTemplates={};await assert.rejects(f.runtime.sync({history:true}),/先立即更新/);assert.equal(f.tabs.length,0);assert.equal(f.settings.ownPostTracking.lastAttemptAt,undefined);
 await assert.rejects(f.runtime.sync({history:true,background:true}),/仅支持手动/);assert.equal(f.requests.length,0);
});

test('a review arriving during an analytics request survives both periodic and history imports',async()=>{
 for(const history of [false,true]){
  const f=fixture();await f.runtime.sync();f.advance(MIN_BATCH_DELAY);
  const review={keep:true,score:8,reason:'请求等待时完成的二审'};
  const sources=async()=>{await f.store.update('123','2112818349029900798',p=>({...p,grokReview:review,retained:true,protected:true}));return new Map();};
  const runtime=createPostRuntime({api:f.api,store:f.store,now:()=>NOW+MIN_BATCH_DELAY,sleep:async()=>{},fetchAnalytics:async()=>({status:200,json:payload()}),publishedSources:sources});
  await runtime.sync({history});const saved=await f.store.get('123','2112818349029900798');assert.deepEqual(saved.grokReview,review);assert.equal(saved.retained,true);assert.equal(saved.protected,true);
 }
});

test('history import reaching 1000 reports incomplete coverage and keeps deleted records hidden',async()=>{
 const f=fixture();await f.runtime.sync();const original=await f.store.get('123','2112818349029900798');original.deletion={status:'verified'};await f.store.put(original);f.advance(MIN_BATCH_DELAY);
 const json=payload(),rows=json.data.viewer_v2.user_results.result.tweets_results;for(let i=1;i<1000;i++)rows.push(payload({id:String(10000+i)}).data.viewer_v2.user_results.result.tweets_results[0]);f.setLive(json);
 const result=await f.runtime.sync({history:true});assert.equal(result.received,1000);assert.equal(result.historyComplete,false);assert.equal((await f.store.meta('123')).historyImport.complete,false);assert.equal((await f.runtime.handle({op:'page',options:{days:90}})).total,999);assert.equal((await f.store.get('123',original.postId)).deletion.status,'verified');
});
