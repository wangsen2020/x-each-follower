import test from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createLearningStore} from '../src/features/knowledge/learning-store.js';
import {createKnowledgeStore} from '../src/features/knowledge/knowledge-store.js';
import {createKnowledgeReviewService} from '../src/features/knowledge/knowledge-review.js';
import {createWisdomService,parseWisdom} from '../src/features/knowledge/wisdom.js';
import {loadExperienceContext} from '../src/features/knowledge/learning-context.js';

async function fixture(t){
  const indexedDB=new IDBFactory(),repository=createLearningStore({name:'wisdom-test',dependencies:{indexedDB,IDBKeyRange}}),library=createKnowledgeStore({indexedDB,IDBKeyRange}),review=createKnowledgeReviewService({store:library});
  let account='123',count=0,calls=0,queries=0,mode='ok';
  await repository.saveSettings({ownerId:'123',bot:'bot1',dailyBudget:5,writingKnowledgeEnabled:true});
  for(const [id,statement] of [['a','补充具体的技术取舍'],['b','缺少原帖依据时不虚构数字']])await review.createCandidate({ownerId:'123',id,statement,scope:{sourceChannel:'manual'}});
  await repository.addSources([{ownerId:'123',knowledgeId:'a',key:'analysis-a:111',channel:'high_analysis',postId:'111',authorId:'123',analysisId:'analysis-a'}]);
  const result=async()=>{
    const draft=(await repository.drafts('123')).at(-1);
    return {ok:true,text:'【智慧开始】'+JSON.stringify({taskId:draft.id,baseVersion:draft.baseVersion,content:[draft.before?.content,...draft.selected.map(e=>e.statement)].filter(Boolean).join('；'),experienceIds:draft.selected.map(e=>e.id),conflicts:[]})+'【智慧结束】'};
  };
  const bot={status:async()=>({enabled:true,bot:'bot1',botName:'评论Bot'}),generate:async(p,o)=>{calls++;await o.onJobCreated({id:'local:job1'});if(mode==='pending')return {ok:false,pending:true};return result();},resume:async id=>{assert.equal(id,'local:job1');queries++;return result();}};
  const make=()=>createWisdomService({repository,library,bot,owner:async()=>account,now:()=>1000+count,uuid:()=>String(++count)});
  const service=make();
  t.after(async()=>{await repository.db.close();await library.close();});
  return {repository,library,review,bot,service,make,setOwner:v=>account=v,setMode:v=>mode=v,get calls(){return calls;},get queries(){return queries;}};
}
async function merge(f,ids,baseVersion){const p=await f.service.handle({action:'wisdomPreview',ids,baseVersion});return f.service.handle({action:'wisdomCommit',id:p.draft.id});}

test('experience preview does not change wisdom; one batch creates exactly one version with source snapshots',async t=>{
  const f=await fixture(t),p=await f.service.handle({action:'wisdomPreview',ids:['a','b'],baseVersion:0});
  assert.equal(await f.repository.wisdom('123'),undefined);assert.equal(p.draft.status,'ready');
  const result=await f.service.handle({action:'wisdomCommit',id:p.draft.id});assert.equal(result.head.version,1);assert.equal(result.versions.length,1);assert.equal(result.head.experiences.length,2);assert.equal(result.head.experiences[0].sources[0].channel,'high_analysis');
  assert.equal((await f.library.getKnowledge('123','a')).status,'candidate');
});
test('subsequent merge creates one next version and retains prior experiences',async t=>{
  const f=await fixture(t);await merge(f,['a'],0);const result=await merge(f,['b'],1);assert.equal(result.head.version,2);assert.equal(result.head.experiences.length,2);assert.match(result.head.content,/不虚构数字/);assert.equal(result.versions.length,2);
  await assert.rejects(f.service.handle({action:'wisdomPreview',ids:['a'],baseVersion:2}),/已在当前智慧/);
});
test('selecting a stored wisdom changes only the active document and preserves history',async t=>{
  const f=await fixture(t);const first=(await merge(f,['a'],0)).head;await merge(f,['b'],1);
  const restored=await f.service.handle({action:'wisdomSelect',version:1,baseVersion:2});assert.equal(restored.head.version,1);assert.equal(restored.head.content,first.content);assert.equal(restored.head.experiences.length,1);assert.equal(restored.versions.length,2);
});
test('stale preview cannot overwrite a concurrent wisdom revision',async t=>{
  const f=await fixture(t);await merge(f,['a'],0);const preview=await f.service.handle({action:'wisdomPreview',ids:['b'],baseVersion:1});await f.service.handle({action:'wisdomSave',content:'# 写作智慧\n\n保留事实，提出具体问题。',baseVersion:1});
  await assert.rejects(f.service.handle({action:'wisdomCommit',id:preview.draft.id}),/智慧已更新/);assert.equal((await f.repository.wisdom('123')).version,2);
});
test('changing an experience invalidates its merge preview',async t=>{
  const f=await fixture(t),p=await f.service.handle({action:'wisdomPreview',ids:['a'],baseVersion:0});await f.review.reviewKnowledge({ownerId:'123',knowledgeId:'a',expectedRevision:1,action:'reject'});
  await assert.rejects(f.service.handle({action:'wisdomCommit',id:p.draft.id}),/经验已修改/);assert.equal(await f.repository.wisdom('123'),undefined);
});
test('interrupted wisdom preview resumes original Bot task after restart',async t=>{
  const f=await fixture(t);f.setMode('pending');const p=await f.service.handle({action:'wisdomPreview',ids:['a'],baseVersion:0});assert.equal(p.draft.status,'submitted');
  const result=await f.make().handle({action:'wisdomQuery',id:p.draft.id});assert.equal(result.draft.status,'ready');assert.equal(f.calls,1);assert.equal(f.queries,1);assert.equal(await f.repository.wisdom('123'),undefined);
});
test('source experiences and active cards do not enter generation until committed into wisdom',async t=>{
  const f=await fixture(t),deps={repository:f.repository,bot:f.bot};
  assert.equal((await loadExperienceContext({ownerId:'123'},deps)).text,'');await merge(f,['a'],0);
  const context=await loadExperienceContext({ownerId:'123',requestId:'gen'},deps);assert.match(context.text,/当前智慧 v1/);assert.equal(context.items.length,1);assert.equal(context.items[0].id,'wisdom');assert.equal((await f.repository.uses('123'))[0].wisdomVersion,1);
});
test('wisdom history remains isolated between accounts',async t=>{
  const f=await fixture(t);await merge(f,['a'],0);f.setOwner('456');assert.equal((await f.service.state()).head,null);assert.equal((await f.service.state()).versions.length,0);await assert.rejects(f.service.handle({action:'wisdomSelect',version:1,baseVersion:0}),/找不到/);
});
test('preview parser rejects missing or foreign selected experience references',()=>{
  const draft={id:'d',baseVersion:1,selected:[{id:'a'},{id:'b'}]};const wrap=v=>'【智慧开始】'+JSON.stringify(v)+'【智慧结束】';
  assert.throws(()=>parseWisdom(wrap({taskId:'d',baseVersion:1,content:'内容',experienceIds:['a'],conflicts:[]}),draft));assert.throws(()=>parseWisdom(wrap({taskId:'d',baseVersion:2,content:'内容',experienceIds:['a','b'],conflicts:[]}),draft));
});
test('real Bot Markdown literal newlines recover without relaxing identity or completion checks',()=>{
  const draft={id:'d',baseVersion:0,selected:[{id:'a'}]};
  const raw='【智慧开始】{"taskId":"d","baseVersion":0,"content":"# 写作智慧\n\n## 经验\n说明适用条件","experienceIds":["a"],"conflicts":[]}【智慧结束】';
  assert.equal(parseWisdom(raw,draft).content,'# 写作智慧\n\n## 经验\n说明适用条件');
  assert.throws(()=>parseWisdom(raw.replace('"taskId":"d"','"taskId":"foreign"'),draft));
  assert.throws(()=>parseWisdom(raw.replace('【智慧结束】',''),draft));
  assert.throws(()=>parseWisdom(raw.replace(',"experienceIds":["a"],"conflicts":[]}', ''),draft));
});

test('shared request budget is claimed atomically by extraction and wisdom drafts',async t=>{
  const f=await fixture(t);const rows=[{id:'r',ownerId:'123',day:'today',dispatched:true},{id:'d',ownerId:'123',day:'today',dispatched:true}];
  const results=await Promise.allSettled([f.repository.claimDispatch('runs',rows[0],1),f.repository.claimDispatch('wisdomDrafts',rows[1],1)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('Dexie upgrade keeps version-one settings and runs without auto-creating wisdom',async()=>{
  const indexedDB=new IDBFactory(),dependencies={indexedDB,IDBKeyRange};const old=new Dexie('upgrade-test',dependencies);old.version(1).stores({settings:'ownerId',runs:'id,ownerId,[ownerId+status]',seen:'[ownerId+key]',uses:'id,ownerId'});await old.settings.put({ownerId:'123',enabled:true});await old.runs.put({id:'old',ownerId:'123',status:'completed'});old.close();
  const upgraded=createLearningStore({name:'upgrade-test',dependencies});assert.equal((await upgraded.settings('123')).enabled,true);assert.equal((await upgraded.runs('123')).length,1);assert.equal(await upgraded.wisdom('123'),undefined);upgraded.db.close();
});

test('repeating the same commit never creates another wisdom version',async t=>{const f=await fixture(t);const preview=await f.service.handle({action:'wisdomPreview',ids:['a','b'],baseVersion:0});await f.service.handle({action:'wisdomCommit',id:preview.draft.id});await assert.rejects(f.service.handle({action:'wisdomCommit',id:preview.draft.id}));assert.equal((await f.repository.versions('123')).length,1);});

test('editing a historical Markdown skill creates the next unused number after selection',async t=>{
 const f=await fixture(t);await merge(f,['a'],0);await merge(f,['b'],1);await f.service.handle({action:'wisdomSelect',version:1,baseVersion:2});const result=await f.service.handle({action:'wisdomSave',content:'# 写作智慧\n\n## 互动\n提出值得回答的具体问题。',sourceVersion:1,baseVersion:1});assert.equal(result.head.version,3);assert.equal(result.head.experiences.length,1);assert.match(result.head.content,/^# 写作智慧/);assert.equal((await f.repository.version('123',2)).experiences.length,2);
});

test('wisdom versions and execution records return bounded pages',async t=>{
 const f=await fixture(t);for(let i=0;i<23;i++){await f.service.handle({action:'wisdomSave',content:'# 写作智慧 '+i,baseVersion:i});await f.repository.saveRun({ownerId:'123',id:'r'+i,at:1000+i,kind:'extract',status:'completed'});}
 const one=await f.service.handle({action:'wisdomVersions',page:1,pageSize:10}),two=await f.service.handle({action:'wisdomVersions',page:2,pageSize:10});assert.equal(one.total,23);assert.equal(one.items.length,10);assert.equal(one.items[0].version,23);assert.equal(two.items[0].version,13);assert.equal('content' in one.items[0],false);
 const logs=await f.repository.historyPage('123',{page:3,pageSize:10});assert.equal(logs.items.length,3);assert.equal(logs.total,23);assert.equal(logs.items[0].at,1002);
});

test('wisdom receipt is queried with its original task after switching the selected engine',async t=>{
 const f=await fixture(t);await f.repository.saveSettings({...await f.repository.settings('123'),generationProvider:'antigravity'});f.setMode('pending');const generate=f.bot.generate;f.bot.generate=async(prompt,options)=>{assert.equal(options.provider,'antigravity');return generate(prompt,options);};
 const result=await f.service.handle({action:'wisdomPreview',ids:['a'],baseVersion:0});assert.equal(result.draft.provider,'antigravity');
 await f.repository.saveSettings({...await f.repository.settings('123'),generationProvider:'codex',bot:'another-session'});f.bot.status=async()=>{throw Error('new engine is offline');};
 const resumed=await f.make().handle({action:'wisdomQuery',id:result.draft.id});assert.equal(resumed.draft.status,'ready');assert.equal(f.calls,1);assert.equal(f.queries,1);
});
