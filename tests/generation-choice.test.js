import test from 'node:test';
import assert from 'node:assert/strict';
import {GENERATION_ENGINES,inspectGenerationEngine,saveGenerationChoice} from '../src/entries/panel/generation-choice.js';

test('engine order and labels keep webhook last without changing persisted routing IDs',()=>{
  assert.deepEqual(GENERATION_ENGINES.map(e=>[e.value,e.label]),[['grok','X Grok'],['grok-local','Grok Bot'],['codex','Codex'],['antigravity','Antigravity'],['grok-bot','Grok Webhook']]);
});
test('detect local readiness by listing bots without generating content',async()=>{
  const config={testedAt:1,bot:'one'};
  const local={configuration:async()=>config,list:async c=>{assert.equal(c,config);return [{id:'one',name:'One'}];}};
  assert.deepEqual(await inspectGenerationEngine('grok-local',local),{ready:true,bots:[{id:'one',name:'One'}],bot:'one'});
  assert.deepEqual(await inspectGenerationEngine('grok-local',{configuration:async()=>null}),{ready:false,bots:[]});
});
test('disabled generation preserves the configured engine and never contacts bots',async()=>{
  const response={ok:true};
  assert.equal(await saveGenerationChoice({grokEnabled:false,generationProvider:'grok-local'},async()=>response,{}),response);
});
test('save validates the selected bot before activating or saving account settings',async()=>{
  let saved=false,selected=false;
  await assert.rejects(saveGenerationChoice({grokEnabled:true,generationProvider:'grok-local',generationBotId:'missing'},async()=>{saved=true;},{local:{selectBot:async()=>{throw Error('不可用');}},selectProvider:async()=>{selected=true;}}),/不可用/);
  assert.equal(saved,false);assert.equal(selected,false);
});
test('a definite account save rejection restores the previous engine',async()=>{
  const selections=[];
  const response=await saveGenerationChoice({grokEnabled:true,generationProvider:'grok-bot'},async()=>({ok:false}),{readProvider:async()=>'grok',selectProvider:async value=>{selections.push(value);return {provider:value};}});
  assert.equal(response.ok,false);assert.deepEqual(selections,['grok-bot','grok']);
});
test('an unconfigured engine cannot enable generation',async()=>{
  let saved=false;
  await assert.rejects(saveGenerationChoice({grokEnabled:true,generationProvider:'grok-bot'},async()=>{saved=true;},{readProvider:async()=>'grok',selectProvider:async()=>({connectionRequired:true})}),/配置/);
  assert.equal(saved,false);
});
test('rejected settings save restores the previous generation bot',async()=>{
  const bots=[];
  await saveGenerationChoice({grokEnabled:true,generationProvider:'grok-local',generationBotId:'new'},async()=>({ok:false}),{local:{configuration:async()=>({bot:'old'}),selectBot:async id=>bots.push(id)},readProvider:async()=>'grok-local',selectProvider:async()=>({provider:'grok-local'})});
  assert.deepEqual(bots,['new','old']);
});
