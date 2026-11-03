import test from 'node:test';
import {normalizeReviewSettings,mergeReviewSettingsPatch} from '../src/features/relationships/follow-review-engine.js';
import assert from 'node:assert/strict';
test('removal preferences default off in old settings and merge independently',()=>{
 const off={blockSuggestive:false,blockEmpty:false};
 assert.deepEqual(normalizeReviewSettings().removalRules,off);
 assert.deepEqual(normalizeFollowReviewSettings().removalRules,off);
 const current=normalizeReviewSettings({removalRules:{blockSuggestive:true,blockEmpty:true}});
 assert.deepEqual(mergeReviewSettingsPatch(current,{removalRules:{blockEmpty:false}}).removalRules,{blockSuggestive:true,blockEmpty:false});
 assert.deepEqual(mergeReviewSettingsPatch(current,{ratioLimit:20}).removalRules,current.removalRules);
});
import {readFile} from 'node:fs/promises';
import {parse, compileScript, compileTemplate} from '@vue/compiler-sfc';
import {FOLLOW_REVIEW_SETTINGS_EVENT, FOLLOW_REVIEW_TIPS, normalizeFollowReviewSettings, followReviewSettingsPatch,
  validateFollowReviewSettings, saveFollowReviewSettings, readFollowReviewSessions, openFollowReviewSettings} from '../src/entries/panel/follow-review-settings.js';

test('new controls default off and three roles have independent editable objects', () => {
  const first = normalizeFollowReviewSettings(), second = normalizeFollowReviewSettings();
  assert.equal(first.initialReviewEnabled, false);
  assert.equal(first.followBackSkipRules, false);
  assert.equal(first.ratioLimit, 10);
  first.fanTagging.provider = 'codex';first.fanTagging.botId = 'tags';first.fanTagging.batchSize = 5;
  assert.equal(first.queueTagging.provider, '');assert.equal(first.commentEngine.botId, '');
  assert.equal(second.fanTagging.batchSize, 10);
  assert.equal(first.queueTagging.intervalSeconds, 3);
});

test('scope patches cannot overwrite other independently configured roles', () => {
  const draft = normalizeFollowReviewSettings({initialReviewEnabled:true, followBackSkipRules:true,
    fanTagging:{provider:'codex',botId:'fan'},queueTagging:{provider:'codex',botId:'queue'},commentEngine:{provider:'antigravity',botId:'comment'}});
  const fanPatch = followReviewSettingsPatch(draft, 'fans'), queuePatch = followReviewSettingsPatch(draft, 'queue');
  assert.deepEqual(Object.keys(fanPatch), ['initialReviewEnabled','automation','removalRules','fanTagging']);
  assert.deepEqual(Object.keys(queuePatch), ['followBackSkipRules','ratioLimit','queueTagging','commentEngine']);
  fanPatch.fanTagging.botId = 'new';assert.equal(draft.fanTagging.botId, 'fan');
  assert.throws(()=>followReviewSettingsPatch(draft, 'invalid'), /无效/);
});

test('three configured roles require independent provider-session pairs', () => {
  const draft = normalizeFollowReviewSettings({fanTagging:{provider:'codex',botId:'shared'},queueTagging:{provider:'codex',botId:'shared'}});
  assert.throws(()=>validateFollowReviewSettings(draft), /各自独立/);
  draft.queueTagging.botId = 'queue';draft.commentEngine = {provider:'codex',botId:'shared',prompt:''};
  assert.throws(()=>validateFollowReviewSettings(draft), /各自独立/);
  draft.commentEngine.provider='antigravity';
  assert.equal(validateFollowReviewSettings(draft).commentEngine.botId, 'shared');
  assert.doesNotThrow(()=>validateFollowReviewSettings(normalizeFollowReviewSettings({initialReviewEnabled:true})));
});

test('nonisolated transports are explained and never accepted as dedicated engines', async () => {
  let statusReads=0;
  for(const provider of ['grok','grok-bot']){
    const state=await readFollowReviewSessions(provider,{webhook:{status:async()=>{statusReads++;return {enabled:true};}}});
    assert.equal(state.supported,false);assert.deepEqual(state.sessions,[]);assert.match(state.reason,/不支持/);
    const draft=normalizeFollowReviewSettings({fanTagging:{provider,botId:'fake'}});
    assert.throws(()=>validateFollowReviewSettings(draft),/不支持独立会话/);
  }
  assert.equal(statusReads,1);
});

test('session inspection reads actual titles without changing global engine or default bot', async () => {
  const calls=[];const connection={testedAt:1,bot:'system-default'};
  const state=await readFollowReviewSessions('codex',{getService:provider=>{
    assert.equal(provider,'codex');return {
      status:async()=>{calls.push('status');return {enabled:true};},
      configuration:async()=>{calls.push('configuration');return connection;},
      list:async c=>{assert.equal(c,connection);calls.push('list');return [{id:'123',name:'审查简名',title:'真实的审查会话完整标题'}, {id:'456',name:'\u202e坏方向\n标题'}, {id:'789',name:''}];},
      selectBot:()=>assert.fail('must not change default bot'),generate:()=>assert.fail('must not generate')
    };
  }});
  assert.deepEqual(calls,['status','configuration','list']);assert.equal(connection.bot,'system-default');
  assert.equal(state.sessions[0].title,'真实的审查会话完整标题');assert.equal(state.sessions[1].title,'坏方向 标题');
  assert.equal(state.sessions[2].name,'未命名会话');assert.ok(!state.sessions[2].name.includes('789'));
});

test('disconnected and empty-session states cannot masquerade as ready selections', async () => {
  let reads=0;
  const disconnected=await readFollowReviewSessions('antigravity',{getService:()=>({status:async()=>({enabled:false}),configuration:()=>{reads++;}})});
  assert.equal(disconnected.connected,false);assert.deepEqual(disconnected.sessions,[]);assert.equal(reads,0);
  const empty=await readFollowReviewSessions('grok-local',{getService:()=>({status:async()=>({enabled:true}),configuration:async()=>({}),list:async()=>[]})});
  assert.equal(empty.connected,true);assert.match(empty.reason,/没有可用会话/);
  await assert.rejects(readFollowReviewSessions('codex',{getService:()=>({status:async()=>{throw Error('network down');}})}),/network down/);
});

test('save sends only scoped fields and leaves drafts intact after a rejected or lost response', async () => {
  const draft=normalizeFollowReviewSettings({fanTagging:{provider:'codex',botId:'fan',prompt:'自定义审核规则'},commentEngine:{provider:'codex',botId:'comment'}});
  const original=structuredClone(draft),sent=[];
  await assert.rejects(saveFollowReviewSettings(draft,'fans',async message=>{sent.push(message);return {ok:false,error:'disk full'};}),/disk full/);
  assert.deepEqual(draft,original);assert.equal(sent[0].cmd,'followQueueSaveReviewSettings');assert.ok(!('commentEngine' in sent[0].settings));
  await assert.rejects(saveFollowReviewSettings(draft,'queue',async()=>{throw Error('response lost');}),/response lost/);
  assert.deepEqual(draft,original);
  const result=await saveFollowReviewSettings(draft,'queue',async message=>({ok:true,settings:{...original,...message.settings}}));
  assert.equal(result.settings.fanTagging.botId,'fan');assert.equal(result.settings.commentEngine.botId,'comment');
});

test('invalid numeric input and oversized prompts are reported rather than silently truncated on save', () => {
  const draft=normalizeFollowReviewSettings();draft.ratioLimit='';assert.throws(()=>validateFollowReviewSettings(draft),/异常关注比例/);
  draft.ratioLimit=10;draft.fanTagging.batchSize=51;assert.throws(()=>validateFollowReviewSettings(draft),/每批人数/);
  draft.fanTagging.batchSize=10;draft.fanTagging.prompt='x'.repeat(6001);assert.throws(()=>validateFollowReviewSettings(draft),/6000/);
});

test('opening an entry dispatches a scoped presentation event without touching storage', () => {
  const target=new EventTarget();const values=[];
  target.addEventListener(FOLLOW_REVIEW_SETTINGS_EVENT,event=>values.push(event.detail.scope));
  assert.equal(openFollowReviewSettings('fans',target),true);openFollowReviewSettings('queue',target);
  assert.deepEqual(values,['fans','queue']);assert.equal(openFollowReviewSettings('fans',null),false);
  assert.throws(()=>openFollowReviewSettings('other',target),/无效/);
  assert.match(FOLLOW_REVIEW_TIPS.initialReviewEnabled,/默认关闭/);assert.match(FOLLOW_REVIEW_TIPS.followBackSkipRules,/跳过重复过滤与 AI 审核/);
});

test('Vue settings dialog compiles with real component bindings and scope controls', async () => {
  const filename=new URL('../src/entries/panel/components/FollowReviewSettingsDialog.vue',import.meta.url);
  const source=await readFile(filename,'utf8');const parsed=parse(source,{filename:filename.pathname});assert.deepEqual(parsed.errors,[]);
  const script=compileScript(parsed.descriptor,{id:'follow-review-test'});
  const template=compileTemplate({source:parsed.descriptor.template.content,filename:filename.pathname,id:'follow-review-test',compilerOptions:{bindingMetadata:script.bindings}});
  assert.deepEqual(template.errors,[]);
});
