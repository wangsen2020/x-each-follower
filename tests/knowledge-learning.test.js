import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createLearningStore} from '../src/features/knowledge/learning-store.js';
import {createKnowledgeStore} from '../src/features/knowledge/knowledge-store.js';
import {createKnowledgeQueue} from '../src/features/knowledge/knowledge-queue.js';
import {createKnowledgeReviewService} from '../src/features/knowledge/knowledge-review.js';
import {createLearningRuntime} from '../src/features/knowledge/learning-runtime.js';
import {parseExperienceResult,selectExperienceContext,nextLearningTime,DAY,defaultLearningSettings} from '../src/features/knowledge/learning-model.js';
import {saveMergeProposal,approveMerge} from '../src/features/knowledge/learning-library.js';
import {loadExperienceContext} from '../src/features/knowledge/learning-context.js';
import {createLearningSources} from '../src/features/knowledge/learning-sources.js';

const wrap=value=>'【经验开始】'+JSON.stringify(value)+'【经验结束】';
async function fixture(t){
  const indexedDB=new IDBFactory();
  const repository=createLearningStore({name:'test-learning',dependencies:{indexedDB,IDBKeyRange}});
  const library=createKnowledgeStore({indexedDB,IDBKeyRange});
  const queue=createKnowledgeQueue({store:library});let at=Date.parse('2026-10-28T02:00:00Z'),account='123',serial=0,calls=0,queries=0,mode='ok';
  let samples=[{ownerId:'123',postId:'111',text:'具体讨论产品边界',key:'own:111',hash:'hash1',kind:'low',purpose:'comment',capturedAt:at,metrics:{impressions:10},metricStates:{impressions:'explicit'}}];
  const bot={status:async()=>({enabled:true,bot:'bot1',botName:'评论Bot'}),generate:async(prompt,options)=>{
    calls++;await options.onJobCreated({id:'local:1'});
    if(mode==='pending')return {ok:false,pending:true,reason:'等待'};
    const run=(await repository.runs('123')).at(-1);
    return {ok:true,text:mode==='invalid'?'bad':wrap({taskId:run.id,candidates:[{type:'pitfall',statement:'避免无信息量复述',conditions:'适用技术评论；缺少事实时只提问',evidencePostIds:['111'],reason:'样本只复述原帖，尚未证明流量因果'}]})};
  },resume:async()=>{queries++;const run=(await repository.runs('123')).at(-1);return {ok:true,text:wrap({taskId:run.id,candidates:[]})};}};
  const make=()=>createLearningRuntime({repository,library,queue,sources:async()=>samples,bot,owner:async()=>account,now:()=>at,uuid:()=>String(++serial)});
  await repository.saveSettings({...defaultLearningSettings('123'),enabled:true,bot:'bot1',botName:'评论Bot',writingKnowledgeEnabled:true,nextAt:0,nextMergeAt:at+7*DAY});
  t.after(async()=>{await library.close();await repository.db.close();});
  return {repository,library,queue,bot,runtime:make(),make,setTime:v=>at=v,setOwner:v=>account=v,setMode:v=>mode=v,setSamples:v=>samples=v,get calls(){return calls;},get queries(){return queries;},get at(){return at;}};
}

test('daily extraction freezes evidence, creates candidates and advances only after persistence',async t=>{
  const f=await fixture(t);await f.runtime.tick();assert.equal(f.calls,1);
  const rows=await f.library.listKnowledge('123');assert.equal(rows.length,1);assert.equal(rows[0].status,'candidate');
  const evidence=await f.library.listEvidenceForKnowledge('123',rows[0].id);assert.equal(evidence[0].text,'具体讨论产品边界');
  assert.equal((await f.repository.seen('123','own:111')).hash,'hash1');
  assert.equal((await f.repository.sources('123'))[0].channel,'low_analysis');
  await f.runtime.tick();assert.equal(f.calls,1);
  await f.runtime.tick('run');assert.equal(f.calls,1);
});
test('disabled scheduled learning makes no Bot call but manual extraction is available',async t=>{
  const f=await fixture(t);await f.repository.saveSettings({...await f.repository.settings('123'),enabled:false});await f.runtime.tick();assert.equal(f.calls,0);await f.runtime.tick('run');assert.equal(f.calls,1);
});
test('offline old Bot does not prevent disabling learning or changing wisdom usage',async t=>{
  const f=await fixture(t);f.bot.status=async()=>({enabled:false});
  const config=await f.repository.settings('123');
  await f.runtime.handle({action:'save',config:{...config,enabled:false,weeklyEnabled:false,writingKnowledgeEnabled:false}});
  assert.equal((await f.repository.settings('123')).writingKnowledgeEnabled,false);
  await assert.rejects(f.runtime.handle({action:'save',config:{...config,enabled:true}}),/连接并测试/);
});
test('pending result survives worker restart; resume does not send again',async t=>{
  const f=await fixture(t);f.setMode('pending');await f.runtime.tick();assert.equal(f.calls,1);assert.equal(await f.repository.seen('123','own:111'),undefined);
  await f.make().tick();assert.equal(f.calls,1);assert.equal(f.queries,1);assert.equal((await f.repository.runs('123'))[0].status,'completed');
});
test('invalid reply does not advance incremental checkpoint and requires explicit cancellation',async t=>{
  const f=await fixture(t);f.setMode('invalid');await assert.rejects(f.runtime.tick());assert.equal(await f.repository.seen('123','own:111'),undefined);await assert.rejects(f.make().tick('run'));assert.equal(f.calls,1);
  const run=(await f.repository.runs('123'))[0];await f.runtime.handle({action:'cancel',id:run.id});assert.equal((await f.repository.runs('123'))[0].status,'cancelled');
});
test('sending checkpoint without receipt blocks blind replay',async t=>{
  const f=await fixture(t);await f.repository.saveRun({id:'lost',ownerId:'123',status:'submitted',at:f.at,day:'2026-10-28',dispatched:true,bot:'bot1'});await assert.rejects(f.runtime.tick(),/发送状态待确认/);assert.equal(f.calls,0);assert.equal(f.queries,0);
});
test('daily request budget counts unknown dispatch and skips queries',async t=>{
  const f=await fixture(t);await f.repository.saveSettings({...await f.repository.settings('123'),dailyBudget:1});await f.runtime.tick('run');await assert.rejects(f.runtime.tick('run'),/预算/);assert.equal(f.calls,1);
});
test('same-account changed samples have a seven day cooldown',async t=>{
  const f=await fixture(t);await f.runtime.tick();const sample={...(await f.repository.runs('123'))[0].samples[0],hash:'hash2'};f.setSamples([sample]);f.setTime(f.at+DAY);await f.runtime.tick('run');assert.equal(f.calls,1);f.setTime(f.at+7*DAY);await f.runtime.tick('run');assert.equal(f.calls,2);
});
test('fixed Bot mismatch blocks dispatch and another owner cannot see history',async t=>{
  const f=await fixture(t);await f.runtime.tick();f.setOwner('456');assert.equal((await f.runtime.state()).runs.length,0);await assert.rejects(f.runtime.tick('run'),/固定 Bot/);assert.equal(f.calls,1);
});
test('scheduled time uses Beijing day boundaries and skips missed days',()=>{
  const now=Date.parse('2026-10-28T01:00:00Z');assert.equal(nextLearningTime(now,9),now+DAY);assert.equal(nextLearningTime(now-1,9),now);
});
test('parser rejects foreign evidence and downgrades external observations',()=>{
  const run={id:'x',kind:'extract',purpose:'all',samples:[{postId:'111',kind:'external'}]},candidate={type:'writing_principle',statement:'补充事实',conditions:'仅限已核实材料',evidencePostIds:['111'],reason:'外部观察'};
  assert.equal(parseExperienceResult(wrap({taskId:'x',candidates:[candidate]}),run)[0].type,'conditional_observation');
  assert.throws(()=>parseExperienceResult(wrap({taskId:'x',candidates:[{...candidate,evidencePostIds:['evil']}]}),run));
  assert.throws(()=>parseExperienceResult(wrap({taskId:'other',candidates:[]}),run));
});
test('context excludes candidates, other purposes, and preserves complete conditions within budget',()=>{
  const item={id:'a',status:'active',revision:2,type:'pitfall',statement:'避免空泛',scope:{purpose:'comment',conditions:'技术帖适用，缺少事实时例外'},updatedAt:1};
  const context=selectExperienceContext([item,{...item,id:'b',status:'candidate'},{...item,id:'c',scope:{purpose:'original'}}]);assert.equal(context.items.length,1);assert.match(context.text,/缺少事实时例外/);assert.equal(selectExperienceContext([item],{budget:50}).items.length,0);
});
test('approved merge atomically supersedes parents and preserves evidence and revisions',async t=>{
  const f=await fixture(t);await f.runtime.tick();const parent=(await f.library.listKnowledge('123'))[0],review=createKnowledgeReviewService({store:f.library});
  const second=await review.createCandidate({ownerId:'123',id:'second',statement:'避免只重复原帖观点',type:parent.type,scope:parent.scope});
  const group={parents:[parent,second.knowledge],statement:'评论避免复述，应有具体补充',reason:'两条结论相近，保持适用条件'};
  const proposal=await saveMergeProposal(f.library,{id:'merge1',ownerId:'123'},group,0,f.at);
  assert.equal((await f.library.getKnowledge('123',parent.id)).status,'candidate');
  assert.ok((await f.library.listEvidenceForKnowledge('123',proposal.id)).length);
  await approveMerge(f.library,{ownerId:'123',id:proposal.id,revision:1},f.at);
  assert.equal((await f.library.getKnowledge('123',parent.id)).status,'merged');assert.equal((await f.library.getKnowledge('123',proposal.id)).status,'active');assert.equal((await f.library.listRevisions('123',parent.id)).length,2);
});
test('stale merge refuses to overwrite a newer parent decision',async t=>{
  const f=await fixture(t);const review=createKnowledgeReviewService({store:f.library});
  const a=(await review.createCandidate({ownerId:'123',id:'a',statement:'先补信息'})).knowledge,b=(await review.createCandidate({ownerId:'123',id:'b',statement:'补充具体信息'})).knowledge;
  const row=await saveMergeProposal(f.library,{id:'merge',ownerId:'123'},{parents:[a,b],statement:'优先补充信息',reason:'重复'},0,f.at);
  await review.reviewKnowledge({ownerId:'123',knowledgeId:'a',action:'reject',expectedRevision:1});await assert.rejects(approveMerge(f.library,{ownerId:'123',id:row.id,revision:1},f.at),/已变化/);assert.equal((await f.library.getKnowledge('123','b')).status,'candidate');
});
test('merge parser prevents cross-scope and overlapping groups',()=>{
  const a={id:'a',type:'pitfall',scope:{purpose:'comment'}},b={id:'b',type:'pitfall',scope:{purpose:'original'}};
  assert.throws(()=>parseExperienceResult(wrap({taskId:'m',groups:[{parentIds:['a','b'],statement:'合并',reason:'相近'}]}),{id:'m',kind:'merge',parents:[a,b]}));
});
test('experience lookup checks binding and records exact revisions, without exposing connection token',async t=>{
  const f=await fixture(t);await f.runtime.tick();const row=(await f.library.listKnowledge('123'))[0];await createKnowledgeReviewService({store:f.library}).reviewKnowledge({ownerId:'123',knowledgeId:row.id,action:'approve',expectedRevision:1});
  await f.repository.commitWisdom({ownerId:'123',content:'只补充具体信息',experiences:[row],createdAt:f.at},0);
  const deps={repository:f.repository,library:f.library,bot:f.bot};const selected=await loadExperienceContext({ownerId:'123',requestId:'use1'},deps);assert.equal(selected.items[0].revision,1);assert.equal((await f.repository.uses('123'))[0].bot,'bot1');assert.equal((await loadExperienceContext({ownerId:'456'},deps)).items.length,0);
});
test('sources use mature own samples and only completed high external observations',async()=>{
  const at=Date.now(),sources=createLearningSources({now:()=>at,config:async()=>({}),posts:{list:async()=>[]},leaderboard:{listReports:async()=>[{date:new Date(at-DAY).toISOString().slice(0,10),status:'completed',samples:[{postId:'999',text:'原文',capturedAt:at}],items:[{postId:'999',quality:'high'}]}]}});
  const result=await sources('123');assert.equal(result.length,1);assert.equal(result[0].kind,'external');assert.equal(result[0].purpose,'all');
});
test('comment generation without a resolved writer does not read knowledge or provider settings',async()=>{
 const {requestGrokComment}=await import('../src/features/grok/grok-comment.js');
 const old=globalThis.chrome,reads=[];globalThis.chrome={storage:{local:{get:async key=>{reads.push(key);return {};}}}};
 try{const result=await requestGrokComment('author',[{url:'https://x.com/author/status/111',text:'批处理降低请求次数，但首次加载等待较长。'}],'作者',{askers:[async()=>({ok:true,reply:'可以进一步测试首屏分批返回的边界。',selectedIndex:1})]});assert.equal(result.ok,true);assert.equal(reads.includes('systemSettings:grokProvider'),false);assert.equal('knowledgeUsed' in result,false);}finally{globalThis.chrome=old;}
});

test('worker startup preserves the existing alarm deadline and restores an absent alarm',async()=>{
 const {ensureLearningAlarm}=await import('../src/features/knowledge/learning-model.js');let count=0,alarm={periodInMinutes:15,scheduledTime:123};const api={alarms:{get:async()=>alarm,create:async()=>count++}};await ensureLearningAlarm(api);assert.equal(count,0);alarm=null;await ensureLearningAlarm(api);assert.equal(count,1);
});

test('scheduled budget exhaustion postpones both due times instead of repeatedly dispatching',async t=>{
 const f=await fixture(t);await f.repository.saveSettings({...await f.repository.settings('123'),dailyBudget:1});await f.runtime.tick();await f.repository.saveSettings({...await f.repository.settings('123'),nextAt:0,nextMergeAt:0});await f.runtime.tick();const config=await f.repository.settings('123');assert.ok(config.nextAt>f.at);assert.ok(config.nextMergeAt>f.at);assert.equal((await f.runtime.state()).budgetUsed,1);assert.equal(f.calls,1);
});

test('repeated evidence appends clear source channels without creating wisdom',async t=>{
 const f=await fixture(t);await f.runtime.tick('run');const sample={...(await f.repository.runs('123'))[0].samples[0],kind:'high',hash:'high-hash'};f.setSamples([sample]);f.setTime(f.at+8*DAY);await f.runtime.tick('run');assert.deepEqual((await f.repository.sources('123')).map(s=>s.channel).sort(),['high_analysis','low_analysis']);assert.equal(await f.repository.wisdom('123'),undefined);
});

async function weeklyFixture(t,{pending=false,conflict=false}={}){
 const f=await fixture(t);await createKnowledgeReviewService({store:f.library}).createCandidate({ownerId:'123',id:'weekly-source',statement:'具体说明一个取舍，并提出值得回答的问题'});await f.repository.saveSettings({...await f.repository.settings('123'),enabled:false,weeklyEnabled:true,weeklyDay:0,weeklyHour:22,nextMergeAt:0});let calls=0,queries=0;
 const reply=async()=>{const draft=(await f.repository.drafts('123')).find(d=>d.trigger==='weekly'&&d.status!=='committed');return {ok:true,text:'【智慧开始】'+JSON.stringify({taskId:draft.id,baseVersion:draft.baseVersion,content:'# 写作智慧\n\n## 互动\n具体说明一个取舍，并提出值得回答的问题。',experienceIds:draft.selected.map(e=>e.id),conflicts:conflict?['不同场景需要核对']:[]})+'【智慧结束】'};};
 f.bot.generate=async(prompt,options)=>{calls++;await options.onJobCreated({id:'local:weekly'});return pending?{ok:false,pending:true}:reply();};f.bot.resume=async id=>{assert.equal(id,'local:weekly');queries++;return reply();};return {...f,runtime:f.make(),counts:()=>({calls,queries})};
}

test('weekly schedule automatically saves and selects a new Markdown skill exactly once',async t=>{
 const f=await weeklyFixture(t);await f.runtime.tick();const head=await f.repository.wisdom('123');assert.equal(head.version,1);assert.match(head.content,/^# 写作智慧/);assert.equal(head.trigger,'weekly');await f.runtime.tick();assert.equal(f.counts().calls,1);const logs=await f.repository.historyPage('123',{scope:'weekly'});assert.equal(logs.items[0].status,'committed');assert.ok(logs.items[0].steps.some(s=>s.stage==='committed'));
});

test('weekly interrupted replies resume their original task without another generation',async t=>{
 const f=await weeklyFixture(t,{pending:true});await f.runtime.tick();assert.equal(await f.repository.wisdom('123'),undefined);await f.make().tick();assert.equal((await f.repository.wisdom('123')).version,1);assert.deepEqual(f.counts(),{calls:1,queries:1});
});

test('weekly conflicts retain the current skill and record the need for review',async t=>{
 const f=await weeklyFixture(t,{conflict:true});await f.runtime.tick();assert.equal(await f.repository.wisdom('123'),undefined);const draft=(await f.repository.drafts('123'))[0];assert.equal(draft.requiresReview,true);assert.match(draft.error,/冲突/);
});

test('next weekly time uses Beijing day and hour',async()=>{
 const {nextWeeklyTime}=await import('../src/features/knowledge/learning-model.js');const sunday=Date.parse('2026-11-01T13:00:00Z');assert.equal(nextWeeklyTime(sunday,0,22),Date.parse('2026-11-01T14:00:00Z'));assert.equal(nextWeeklyTime(sunday+3600000,0,22),Date.parse('2026-11-08T14:00:00Z'));
});

test('weekly backlog continues in bounded batches until all experience is merged',async t=>{
 const f=await weeklyFixture(t),review=createKnowledgeReviewService({store:f.library});for(let i=0;i<12;i++)await review.createCandidate({ownerId:'123',id:'extra-'+i,statement:'额外经验 '+i});await f.runtime.tick();assert.equal((await f.repository.wisdom('123')).experiences.length,10);assert.equal((await f.repository.historyPage('123',{scope:'weekly'})).items[0].remainingCount,3);f.setTime(f.at+16*60000);await f.runtime.tick();assert.equal((await f.repository.wisdom('123')).experiences.length,13);assert.equal(f.counts().calls,2);
});

test('learning binds a chosen engine and resumes an existing receipt after engine settings change',async t=>{
 const f=await fixture(t);const providers=[];f.bot.status=async provider=>{providers.push(provider);return {enabled:true,bot:'bot1'};};
 await f.runtime.handle({action:'save',config:{...await f.repository.settings('123'),generationProvider:'codex'}});assert.ok(providers.includes('codex'));
 f.setMode('pending');const generate=f.bot.generate;f.bot.generate=async(prompt,options)=>{assert.equal(options.provider,'codex');return generate(prompt,options);};await f.runtime.tick('run');const run=(await f.repository.runs('123'))[0];assert.equal(run.provider,'codex');
 await f.repository.saveSettings({...await f.repository.settings('123'),generationProvider:'antigravity',bot:'different'});f.bot.status=async()=>({enabled:false});await f.make().tick();assert.equal(f.calls,1);assert.equal(f.queries,1);assert.equal((await f.repository.runs('123'))[0].status,'completed');
});
