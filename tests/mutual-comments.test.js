import test from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createMutualCommentStore} from '../src/features/mutual-comments/store.js';
import {createMutualCommentRuntime} from '../src/features/mutual-comments/runtime.js';
import {defaults,parseTags,makeTagBatch,validateConfig} from '../src/features/mutual-comments/model.js';
import {createHomeScanner,parseHomeTimeline} from '../src/features/mutual-comments/home-reader.js';
import {commentPriority} from '../src/features/mutual-comments/priority.js';
const account={accountId:'123',handle:'me'};
const post=id=>({postId:id,handle:'friend',text:'欢迎互关，一起交流产品',url:'https://x.com/friend/status/'+id});
const ranked=(id,following,replies=0)=>({...post(id),ownerId:'123',createdAt:Number(id),tag:'mutual',taggedAt:1,tagBatchId:'proof',status:'ready',following,replyCount:replies,repostCount:0,likeCount:0,bookmarkCount:0});

test('priority applies 1:3:3:3 remainder only to explicitly unfollowed classified pending posts',()=>{
  assert.equal(commentPriority({...ranked('1',false,1),repostCount:2,likeCount:3,bookmarkCount:4}).weight,1028);
  for(const [score,weight] of [[999,1999],[1000,1000],[1200,1200]])assert.equal(commentPriority(ranked('1',false,score)).weight,weight);
  for(const following of [true,null,undefined,'false'])assert.equal(commentPriority(ranked('1',following,999)).weight,0);
  for(const patch of [{tag:'pending'},{taggedAt:null},{tagBatchId:''},{status:'posted'},{decorationIssue:'blocked'}])assert.equal(commentPriority({...ranked('1',false,999),...patch}).weight,0);
  for(const value of [null,undefined,-1,Infinity,NaN])assert.deepEqual(commentPriority({...ranked('1',false),likeCount:value}),{weight:1000,engagementScore:null});
});

test('home observations preserve false and zero and treat missing or conflicting relationships as unknown',()=>{
  const json=timeline(['111']);const tweet=json.data.home.home_timeline_urt.instructions[0].entries[0].content.itemContent.tweet_results.result;
  Object.assign(tweet.legacy,{reply_count:0,retweet_count:2,favorite_count:3,bookmark_count:4});
  const author=tweet.core.user_results.result;author.relationship_perspectives={following:false};
  assert.equal(parseHomeTimeline(json).posts[0].following,false);assert.equal(parseHomeTimeline(json).posts[0].replyCount,0);
  author.legacy={following:true};assert.equal(parseHomeTimeline(json).posts[0].following,null);
  delete author.legacy;delete author.relationship_perspectives;assert.equal(parseHomeTimeline(json).posts[0].following,null);
});

test('list pagination and scheduler use the same priority across restarts, preserving cooldown gates',async t=>{
  const f=await fixture(t);await f.store.addPosts([ranked('111',true,999),ranked('112',false,1200),ranked('113',false,999),ranked('114',null,999)]);
  const state=await f.make().state(1,{status:'ready'});assert.deepEqual(state.items.map(r=>r.postId),['113','112','114','111']);
  await f.make().tick('comment');assert.equal((await f.store.get('123','113')).status,'posted');
  await f.store.updatePost({...ranked('112',false,1200),retryAt:9999999999999});
  f.advance(301000);await f.make().tick('comment');assert.equal((await f.store.get('123','114')).status,'posted');
});

test('rescanning refreshes ranking observations without resetting paid work or other owners',async t=>{
  const f=await fixture(t);await f.store.addPosts([{...ranked('111',false,999),authorId:'9',status:'posted',reply:'saved',publishedPostId:'900'},{...ranked('111',false,999),ownerId:'456'}]);
  await f.store.addPosts([{...ranked('111',true,1),authorId:'9',tag:'pending',status:'idle',createdAt:999}]);
  const row=await f.store.get('123','111');assert.equal(row.following,true);assert.equal(row.replyCount,1);assert.equal(row.status,'posted');assert.equal(row.tag,'mutual');assert.equal(row.reply,'saved');assert.equal(row.publishedPostId,'900');assert.equal(row.createdAt,111);
  assert.equal((await f.store.get('456','111')).following,false);
  await f.store.addPosts([{...ranked('111',false,999),authorId:'10'}]);assert.equal((await f.store.get('123','111')).following,true);
});

test('priority is sorted before pagination and missing legacy observations remain neutral',async t=>{
  const f=await fixture(t);
  await f.store.addPosts([ranked('1',false,999),...Array.from({length:11},(_,i)=>ranked(String(200+i),true,999)),{...ranked('999',undefined),replyCount:undefined}]);
  const first=await f.runtime.state(1,{status:'ready',pageSize:10}),second=await f.runtime.state(2,{status:'ready',pageSize:10});
  assert.equal(first.items[0].postId,'1');assert.equal(first.total,13);assert.equal(second.items.length,3);
  assert.equal(new Set([...first.items,...second.items].map(r=>r.postId)).size,13);
  assert.equal(first.items.find(r=>r.postId==='999').priority.weight,0);
});
async function fixture(t){
 const store=createMutualCommentStore({dependencies:{indexedDB:new IDBFactory(),IDBKeyRange}});t.after(()=>store.db.close());let at=1793200000000,serial=0,scans=0,calls=0,sends=0,mode='ok',live=account;
 const posts=[post('111'),post('112')];
 await store.saveConfig({...defaults('123'),scanEnabled:true,commentEnabled:true,scanProvider:'grok-local',scanBotId:'test',commentProvider:'grok-local',commentBotId:'test'});
 const deps={store,owner:async()=>live,now:()=>at,uuid:()=>String(++serial),scan:async()=>{scans++;return {posts,anchor:{postIds:posts.map(p=>p.postId)},pages:1,duplicates:0};},knowledge:async()=>({text:'温和具体',wisdomVersion:2}),
 analyze:async(prompt,options)=>{calls++;if(mode==='pending'){await options.onJobCreated({id:'local:job'});return {ok:false,pending:true};}if(mode==='bad')return {ok:true,text:'bad'};if(mode==='switch')live={accountId:'456',handle:'other'};
 if(prompt.includes('帖子数据：')){const input=JSON.parse(prompt.split('帖子数据：')[1]),id=JSON.parse(prompt.split('包围的JSON：')[1].split('\n')[0]).batchId;return {ok:true,text:'【标签开始】'+JSON.stringify({batchId:id,items:input.map(p=>({postId:p.postId,tag:mode==='skip'?'not_mutual':'mutual',reason:'明确邀请互关'}))})+'【标签结束】'};}
 const p=JSON.parse(prompt.split('原帖：')[1].split('\n')[0]);return {ok:true,text:'【评论开始】'+JSON.stringify({postId:p.postId,reply:'很喜欢你分享的产品经验，期待交流，也欢迎关注！'})+'【评论结束】'};},
 publisher:{publish:async o=>{await o.canPublish();sends++;return mode==='uncertain'?{ok:false,attempted:true}:{ok:true,status:'posted',publishedPostId:'999',publishedPostUrl:'https://x.com/me/status/999'};},verify:async()=>({id:'999',url:'https://x.com/me/status/999'})}};
 return {store,posts,deps,runtime:createMutualCommentRuntime(deps),make:()=>createMutualCommentRuntime(deps),mode:v=>mode=v,advance:(ms=61000)=>at+=ms,get scans(){return scans;},get calls(){return calls;},get sends(){return sends;}};
}
test('batch classification persists all labels and never publishes; independent consumer uses existing publisher',async t=>{const f=await fixture(t);await f.runtime.tick('scan');assert.equal(f.calls,1);assert.equal(f.sends,0);assert.equal((await f.store.get('123','111')).tag,'mutual');await f.runtime.tick('comment');assert.equal(f.sends,1);assert.equal(f.scans,1);assert.equal((await f.store.get('123','111')).knowledge.wisdomVersion,2);});
test('comment scheduler does not scan, classify or consume uncommitted labels',async t=>{const f=await fixture(t);await f.store.addPosts([{...post('111'),ownerId:'123',createdAt:1,tag:'mutual',status:'ready'}]);await f.runtime.tick('comment');assert.equal(f.calls,0);assert.equal(f.scans,0);assert.equal(f.sends,0);});
test('scan deduplicates existing posts and preserves labels and publication history',async t=>{const f=await fixture(t);await f.runtime.tick('scan');await f.runtime.tick('comment');await f.store.updateConfig('123',{nextScanAt:0});await f.runtime.tick('scan');assert.equal(f.calls,2);assert.equal((await f.store.list('123')).length,2);assert.equal((await f.store.get('123','111')).status,'posted');});
test('negative labels never reach comment generation',async t=>{const f=await fixture(t);f.mode('skip');await f.runtime.tick('scan');await f.runtime.tick('comment');assert.equal(f.calls,1);assert.equal(f.sends,0);});
test('receipt and frozen batch survive worker restart without new AI task',async t=>{const f=await fixture(t);f.mode('pending');await f.runtime.tick('scan');const batch=(await f.store.batches('123'))[0];f.advance(301000);f.deps.analyze=async(prompt,options)=>{assert.equal(prompt,batch.prompt);assert.equal(options.relayJobId,'local:job');return {ok:false,pending:true};};await f.make().tick('scan');assert.equal((await f.store.batches('123')).length,1);});
test('invalid batch output applies no partial labels and is isolated',async t=>{const f=await fixture(t);f.mode('bad');await f.runtime.tick('scan');assert.ok((await f.store.list('123')).every(r=>r.tag==='failed'));f.posts.push(post('113'));f.mode('ok');await f.store.updateConfig('123',{nextScanAt:0});await f.runtime.tick('scan');assert.equal((await f.store.get('123','113')).tag,'mutual');});
test('unknown publication is not replayed and consumes daily quota',async t=>{const f=await fixture(t);await f.store.updateConfig('123',{dailyLimit:1});await f.runtime.tick('scan');f.mode('uncertain');await f.runtime.tick('comment');f.advance();await f.make().tick('comment');assert.equal(f.sends,1);assert.equal((await f.store.get('123','111')).status,'uncertain');await f.runtime.handle({action:'verify',postId:'111'});assert.equal((await f.store.get('123','111')).status,'posted');assert.equal(f.sends,1);});
test('comment per-run cap survives a crash between publication intent and run decrement',async t=>{const f=await fixture(t);await f.runtime.tick('scan');await f.store.updateConfig('123',{perRun:1,nextCommentAt:9999999999999,commentRun:{id:'r',remaining:1}});await f.store.put({...await f.store.get('123','111'),status:'publishing',publishAttemptedAt:1,commentRunId:'r'});await f.runtime.tick('comment');assert.equal(f.sends,0);assert.equal((await f.store.get('123','111')).status,'uncertain');});
test('schedule clocks are independent and unrelated settings preserve due times',async t=>{const f=await fixture(t);await f.store.updateConfig('123',{nextScanAt:123,nextCommentAt:456});const config=await f.store.config('123');await f.runtime.handle({action:'save',config:{...config,batchSize:12}});assert.equal((await f.store.config('123')).nextScanAt,123);assert.equal((await f.store.config('123')).nextCommentAt,456);await f.runtime.handle({action:'save',config:{...config,commentEnabled:false}});await f.runtime.tick('scan');await f.runtime.tick('comment');assert.equal(f.sends,0);assert.equal(f.calls,1);});
test('source account switch after AI generation fences publication',async t=>{const f=await fixture(t);await f.runtime.tick('scan');f.mode('switch');await f.runtime.tick('comment');assert.equal(f.sends,0);});
test('tag filters apply before pagination and headers can use zero totals',async t=>{const f=await fixture(t);await f.runtime.tick('scan');assert.equal((await f.runtime.state(1,{tag:'mutual',q:'FRIEND'})).total,2);assert.equal((await f.runtime.state(1,{tag:'not_mutual'})).total,0);});
test('batch parser requires exact task and post coverage; bounded input still batches short posts',()=>{const ids=['111','112'];const text=items=>'【标签开始】'+JSON.stringify({batchId:'b',items})+'【标签结束】';assert.throws(()=>parseTags(text([{postId:'111',tag:'mutual',reason:'x'},{postId:'111',tag:'mutual',reason:'x'}]),'b',ids));const batch=makeTagBatch('b',Array.from({length:20},(_,n)=>({...post(String(n)),text:'长'.repeat(5000)})),20);assert.ok(batch.posts.length>1);assert.ok(batch.prompt.length<7400);assert.match(batch.prompt,/"truncated":true/);assert.throws(()=>validateConfig({...defaults('123'),scanEnabled:true},'123'));});
test('Dexie migration preserves real history and disables both new schedules',async()=>{const dependencies={indexedDB:new IDBFactory(),IDBKeyRange};const old=new Dexie('migration',dependencies);old.version(1).stores({settings:'ownerId',posts:'[ownerId+postId],ownerId,[ownerId+createdAt]',scans:'id,ownerId'});await old.table('settings').put({ownerId:'123',enabled:true,generationProvider:'grok-local',generationBotId:'test'});await old.table('posts').put({...post('111'),ownerId:'123',createdAt:1,status:'posted',match:true,raw:'old-proof',publishedPostId:'999'});old.close();const next=createMutualCommentStore({name:'migration',dependencies});try{const config=await next.config('123');assert.equal(config.scanEnabled,false);assert.equal(config.commentEnabled,false);const row=await next.get('123','111');assert.equal(row.status,'posted');assert.equal(row.publishedPostId,'999');assert.equal(row.legacy.raw,'old-proof');}finally{next.db.close();}});
function timeline(ids,cursor=''){return {data:{home:{home_timeline_urt:{instructions:[{entries:[...ids.map(id=>({content:{itemContent:{tweet_results:{result:{rest_id:id,legacy:{full_text:'互关'},core:{user_results:{result:{rest_id:'9',core:{screen_name:'friend'}}}}}}}}})),{content:{cursorType:'Bottom',value:cursor}}]}]}}}};}
test('network scanner paginates with existing client, checkpoints anchor and always closes its own window',async()=>{let closed=0,queries=0,saved=0;const native={op:'HomeTimeline',json:timeline(['1'],'c1')};const scanner=createHomeScanner({api:{scripting:{executeScript:async()=>[{result:{home:true,viewer:'me',native}}]}},openPage:async()=>({tabId:7,close:async()=>closed++}),sleep:async()=>{},network:{query:async(tab,op,vars)=>{queries++;assert.equal(tab,7);assert.equal(vars.cursor,'c1');return {status:200,json:timeline(['2'],'c2')};}}});const result=await scanner(account,5,{anchor:{operation:'HomeTimeline',postIds:['2']},knownIds:['2'],checkpoint:async()=>saved++});assert.equal(queries,1);assert.equal(closed,1);assert.equal(saved,2);assert.equal(result.stopped,'anchor');assert.deepEqual(result.posts.map(p=>p.postId),['1','2']);});
test('network errors close owned window and do not claim successful empty scan',async()=>{let closed=false;const scan=createHomeScanner({api:{scripting:{executeScript:async()=>[{result:{home:true,viewer:'other',native:{}}}]}},openPage:async()=>({tabId:7,close:async()=>closed=true}),sleep:async()=>{}});await assert.rejects(scan(account,1),/账号/);assert.equal(closed,true);assert.throws(()=>parseHomeTimeline({data:{}}),/结构/);});

test('prepared batch resumes after worker restart and storage failure rolls back anchor with page',async t=>{
 const f=await fixture(t);await f.store.addPosts([{...post('111'),ownerId:'123',createdAt:1,tag:'pending',status:'idle'}]);const prepared=makeTagBatch('reserved',[post('111')],10);await f.store.reserveBatch({id:'reserved',ownerId:'123',at:1,status:'prepared',postIds:['111'],prompt:prepared.prompt,provider:'grok',botId:''});await f.store.updateConfig('123',{nextScanAt:9999999999999});await f.make().tick('scan');assert.equal((await f.store.get('123','111')).tag,'mutual');assert.equal((await f.store.batches('123')).length,1);
 await assert.rejects(f.store.checkpoint('123',[{ownerId:'123'}],{postIds:['bad']},{id:'bad',ownerId:'123'}));assert.equal((await f.store.config('123')).anchor,undefined);
});

test('retention caps each owner at 5000, cleans orphan history and keeps anchor and latest records',async t=>{
 const f=await fixture(t);const rows=Array.from({length:5005},(_,i)=>({...post(String(10000+i)),ownerId:'123',createdAt:i,tag:'pending',status:'idle',tagBatchId:i===0?'expired':i===5004?'keep':undefined}));
 await f.store.addPosts([{...post('99999'),ownerId:'456',createdAt:1,tag:'pending',status:'idle'}]);
 await f.store.saveBatch({id:'expired',ownerId:'123',postIds:['10000']});await f.store.saveBatch({id:'keep',ownerId:'123',postIds:['15004']});
 await f.store.checkpoint('123',rows,{postIds:['15004'],cursor:'anchor'},{id:'scan',ownerId:'123',at:1});
 const retained=await f.store.list('123');assert.equal(retained.length,5000);assert.equal(await f.store.get('123','10004'),undefined);assert.ok(await f.store.get('123','10005'));assert.ok(await f.store.get('123','15004'));assert.equal((await f.store.list('456')).length,1);assert.equal(await f.store.getBatch('expired'),undefined);assert.ok(await f.store.getBatch('keep'));assert.equal((await f.store.config('123')).anchor.cursor,'anchor');
 await f.store.addPosts([rows[0]]);assert.equal(await f.store.get('123','10000'),undefined);await f.store.updatePost({...rows[0],status:'posted'});assert.equal(await f.store.get('123','10000'),undefined);
});

test('random schedule samples each cycle within bounds and preserves due time until a range changes',async t=>{
 const {randomDue}=await import('../src/features/mutual-comments/model.js');assert.equal(randomDue(0,10,20,()=>0),600000);assert.equal(randomDue(0,10,20,()=>1),1200000);
 const f=await fixture(t);f.deps.random=()=>0.25;const runtime=f.make();const config=await f.store.config('123');await runtime.handle({action:'save',config:{...config,scanIntervalMinutes:10,scanIntervalMaxMinutes:20}});const first=await f.store.config('123');assert.equal(first.nextScanAt-1793200000000,750000);await runtime.handle({action:'save',config:{...first,batchSize:15}});assert.equal((await f.store.config('123')).nextScanAt,first.nextScanAt);f.deps.random=()=>0.75;await f.make().handle({action:'save',config:{...first,scanIntervalMaxMinutes:30}});assert.equal((await f.store.config('123')).nextScanAt-1793200000000,1500000);
 assert.throws(()=>validateConfig({...config,scanIntervalMinutes:10,scanIntervalMaxMinutes:10},'123'),/最长间隔/);
});

test('settings persist both engines, random ranges and switches across runtime recreation',async t=>{
 const f=await fixture(t);const before=await f.store.config('123'),draft={...before,scanEnabled:false,commentEnabled:false,scanBotId:'classifier',commentBotId:'writer',scanIntervalMinutes:10,scanIntervalMaxMinutes:18,commentIntervalMinutes:15,commentIntervalMaxMinutes:25,scrollRounds:7};await f.runtime.handle({action:'save',config:draft});const reopened=await f.make().state();for(const key of ['scanEnabled','commentEnabled','scanBotId','commentBotId','scanIntervalMinutes','scanIntervalMaxMinutes','commentIntervalMinutes','commentIntervalMaxMinutes','scrollRounds'])assert.equal(reopened.config[key],draft[key]);
});

test('saving existing enabled schedules does not depend on a new Bot connection probe',async t=>{const f=await fixture(t);f.deps.validateEngine=async()=>{throw Error('offline');};const config=await f.store.config('123');assert.equal((await f.make().handle({action:'save',config:{...config,batchSize:12}})).ok,true);await assert.rejects(f.make().handle({action:'save',config:{...config,scanBotId:'changed'}}),/offline/);});

test('user config of 30 posts and 300 comments is valid; errors name the offending field',async t=>{
 const f=await fixture(t),config=await f.store.config('123'),draft={...config,scanIntervalMinutes:10,scanIntervalMaxMinutes:15,batchSize:30,commentIntervalMinutes:3,commentIntervalMaxMinutes:8,perRun:1,dailyLimit:300};await f.runtime.handle({action:'save',config:draft});const loaded=await f.make().state();assert.equal(loaded.config.batchSize,30);assert.equal(loaded.config.dailyLimit,300);assert.throws(()=>validateConfig({...draft,batchSize:101},'123'),/每批打标帖子数须为 1～100/);assert.throws(()=>validateConfig({...draft,dailyLimit:1001},'123'),/每日评论上限须为 1～1000/);
});

test('mutual comments reuse queue tags and follow-back ending, persisting the final text before publication',async t=>{
 const f=await fixture(t);await f.store.updateConfig('123',{quoteTagsEnabled:true,quoteSelectedTags:['互关','蓝V互关'],quoteCustomTags:[],followBackSuffixEnabled:true});f.deps.random=()=>0;await f.runtime.tick('scan');await f.make().tick('comment');const row=(await f.store.list('123')).find(r=>r.status==='posted');assert.ok(row);assert.match(row.reply,/关注我，必回关！🤝/);assert.match(row.reply,/#互关/);assert.match(row.reply,/#蓝V互关/);assert.equal(row.decorationSettings.followBackSuffixEnabled,true);assert.equal(row.baseReply.includes('#'),false);
 const config=await f.store.config('123');const result=await f.runtime.handle({action:'save',config});assert.equal(result.ok,true);assert.deepEqual(result.config.quoteSelectedTags,['互关','蓝V互关']);
});
test('in-flight comment freezes original tag and ending choices across settings changes',async t=>{
 const f=await fixture(t);f.posts.splice(1);await f.store.updateConfig('123',{quoteTagsEnabled:true,quoteSelectedTags:['互关'],followBackSuffixEnabled:true});await f.runtime.tick('scan');f.mode('pending');await f.runtime.tick('comment');await f.store.updateConfig('123',{quoteTagsEnabled:false,followBackSuffixEnabled:false});f.mode('ok');f.advance(301000);await f.make().tick('comment');const row=await f.store.get('123','111');assert.equal(row.status,'posted');assert.match(row.reply,/关注我，必回关/);assert.match(row.reply,/#互关/);
});
test('overlength invitation preserves the base draft and never silently publishes without the requested ending',async t=>{
 const f=await fixture(t);f.posts.splice(1);await f.store.updateConfig('123',{followBackSuffixEnabled:true});await f.runtime.tick('scan');f.deps.analyze=async()=>({ok:true,text:'【评论开始】'+JSON.stringify({postId:'111',reply:'好'.repeat(137)})+'【评论结束】'});await f.make().tick('comment');const row=await f.store.get('123','111');assert.equal(row.status,'draft');assert.match(row.decorationIssue,/正文过长/);assert.equal(row.reply,'好'.repeat(137));f.advance(301000);await f.make().tick('comment');assert.equal(f.sends,0);
});


test('retention removes newer non-mutual posts before older mutual posts and preserves active work',async t=>{
 const f=await fixture(t);const rows=Array.from({length:5000},(_,i)=>({...post(String(10000+i)),ownerId:'123',createdAt:i+100,tag:'not_mutual',status:'skipped'}));
 await f.store.addPosts(rows);
 await f.store.addPosts([{...post('111'),ownerId:'123',createdAt:1,tag:'mutual',status:'posted',reply:'paid reply',publishedPostId:'900'},{...post('112'),ownerId:'123',createdAt:2,tag:'tagging',status:'idle',tagBatchId:'in-flight'}]);
 assert.equal((await f.store.list('123')).length,5000);assert.equal((await f.store.get('123','111')).reply,'paid reply');assert.ok(await f.store.get('123','112'));assert.equal(await f.store.get('123','10000'),undefined);assert.equal(await f.store.get('123','10001'),undefined);
});
test('scanner pins native template and reports page, operation and HTTP status on pagination failure',async()=>{
 const template={op:'HomeLatestTimeline',queryId:'native'},native={op:'HomeLatestTimeline',template,json:timeline(['1'],'next')};let closed=0;
 const scanner=createHomeScanner({api:{scripting:{executeScript:async()=>[{result:{home:true,viewer:'me',native}}]}},openPage:async()=>({tabId:7,close:async()=>closed++}),sleep:async()=>{},network:{query:async(tab,op,vars,options)=>{assert.equal(options.template,template);assert.equal(vars.cursor,'next');return {status:400,error:'must be defined'};}}});
 await assert.rejects(scanner(account,1),/第 2 页.*HomeLatestTimeline.*HTTP 400.*must be defined/);assert.equal(closed,1);
});

test('weight direction sorts before pagination; scheduler remains descending',async t=>{
 const f=await fixture(t);await f.store.addPosts(Array.from({length:12},(_,i)=>ranked(String(300+i),false,i*50)));
 const asc=await f.runtime.state(1,{status:'ready',pageSize:10,sortOrder:'asc'}),desc=await f.runtime.state(1,{status:'ready',pageSize:10});
 assert.equal(asc.items[0].postId,'300');assert.equal(asc.items.at(-1).postId,'309');assert.equal(desc.items[0].postId,'311');
 await f.runtime.tick('comment');assert.equal((await f.store.get('123','311')).status,'posted');
});

test('same-author duplicate batch tags once and reuses reply with current decoration without an AI call',async t=>{
 const f=await fixture(t);f.posts[0]={...post('111'),authorId:'9',text:'@person1 麻烦回关下，一起加油，谢谢！'};f.posts[1]={...post('112'),authorId:'9',text:'@person2 麻烦回关下，一起加油，谢谢。'};
 await f.runtime.tick('scan');assert.equal(f.calls,1);const tagged=await f.store.list('123');assert.equal(tagged.filter(r=>r.tagCache).length,1);assert.ok(tagged.every(r=>r.tag==='mutual'));
 await f.runtime.tick('comment');assert.equal(f.calls,2);await f.store.updateConfig('123',{followBackSuffixEnabled:true});f.advance(301000);
 await f.make().tick('comment');assert.equal(f.calls,2);assert.equal(f.sends,2);const reused=(await f.store.list('123')).find(r=>r.replyCache);assert.ok(reused);assert.equal(reused.status,'posted');assert.match(reused.reply,/关注我，必回关/);assert.equal(reused.replyCache.sourcePostId==='111'||reused.replyCache.sourcePostId==='112',true);
});

test('reply cache respects owner, author, context, provider, expiry and content changes',async()=>{
 const {findReplyCache,findTagCache,COMMENT_CACHE_TTL}=await import('../src/features/mutual-comments/cache.js');
 const at=1793200000000,target={...ranked('2',false),authorId:'9',text:'@new 欢迎互相关注，一起交流。'};
 const source={...target,postId:'1',text:'@old 欢迎互相关注，一起交流！',taggedAt:at-1,baseReply:'一起交流吧',status:'posted',provider:'grok-local',botId:'test',knowledge:{text:'ctx',wisdomVersion:1}};
 const context={text:'ctx',wisdomVersion:1},config={commentProvider:'grok-local',commentBotId:'test'};
 assert.equal(findReplyCache(target,[source],context,config,at),source);assert.equal(findTagCache(target,[source],at),source);
 for(const patch of [{ownerId:'456'},{authorId:'10'},{authorId:undefined},{text:'欢迎互相关注，不要交流。'}])assert.equal(findReplyCache({...target,...patch},[source],context,config,at),undefined);
 for(const patch of [{taggedAt:at-COMMENT_CACHE_TTL-1},{baseReply:'@old 一起交流'},{status:'uncertain'},{provider:'codex'},{knowledge:{text:'changed',wisdomVersion:1}}])assert.equal(findReplyCache(target,[{...source,...patch}],context,config,at),undefined);
 assert.equal(findReplyCache(target,[source],{...context,wisdomVersion:2},config,at),undefined);
});

test('a resumed AI receipt is not replaced by a matching reply cache',async t=>{
 const f=await fixture(t);await f.store.addPosts([{...ranked('111',false),authorId:'9',taggedAt:1793200000000,status:'generating',relayJobId:'existing',provider:'grok-local',botId:'test',prompt:'existing prompt',knowledge:{text:''}}, {...ranked('112',false),authorId:'9',taggedAt:1793200000000,status:'posted',baseReply:'cached',provider:'grok-local',botId:'test',knowledge:{text:''}}]);
 let resumed=false;f.deps.analyze=async(prompt,o)=>{resumed=o.relayJobId==='existing';return {pending:true,ok:false};};await f.make().tick('comment');assert.equal(resumed,true);assert.equal((await f.store.get('123','111')).replyCache,undefined);
});
