import test from 'node:test';
import assert from 'node:assert/strict';
import {readGrokProvider,selectGrokProvider,routeGrokRequest,GROK_PROVIDER_KEY} from '../src/features/grok/grok-provider.js';
import {grokProviderController as controller} from '../src/entries/panel/composables/useGrokProvider.js';
function storage(){let values={};return {get:async key=>({[key]:values[key]}),set:async value=>Object.assign(values,value)};}
test('provider defaults to Grok; unbound and untested Bot never replace persisted selection',async()=>{const local=storage();assert.equal(await readGrokProvider(local),'grok');assert.deepEqual(await selectGrokProvider('grok-bot',{storage:local,service:{status:async()=>({enabled:false})}}),{connectionRequired:true});assert.equal(await readGrokProvider(local),'grok');await selectGrokProvider('grok-bot',{storage:local,service:{status:async()=>({enabled:true})}});assert.equal(await readGrokProvider(local),'grok-bot');await selectGrokProvider('grok',{storage:local});assert.equal(await readGrokProvider(local),'grok');});
test('explicit Grok calls only X, explicit Bot calls only relay, resumption keeps original job after switching',async()=>{let calls=[];const primary=async()=>{calls.push('x');return {ok:false,quotaExhausted:true};};const service={generate:async(prompt)=>{calls.push(prompt);return {ok:true,text:'bot'};},resume:async id=>{calls.push(id);return {pending:true};}};await routeGrokRequest(primary,'prompt',{service,readProvider:async()=>'grok'});assert.deepEqual(calls,['x']);calls=[];await routeGrokRequest(primary,'prompt',{service,readProvider:async()=>'grok-bot'});assert.deepEqual(calls,['prompt']);calls=[];await routeGrokRequest(primary,'prompt',{service,readProvider:async()=>'grok',relayJobId:'existing-job'});assert.deepEqual(calls,['existing-job']);});
test('cancelling a pending binding leaves Grok selected and prevents automatic switching',async()=>{const savedChrome=globalThis.chrome,savedDocument=globalThis.document;try{const local=storage();globalThis.chrome={storage:{local}};let opened=0;globalThis.document={dispatchEvent:()=>opened++};await controller.select('grok');
assert.equal(controller.provider.value,'grok');controller.pending.value=true;controller.cancel();assert.equal(controller.pending.value,false);await controller.complete();assert.equal(await readGrokProvider(local),'grok');assert.equal(opened,0);}finally{globalThis.chrome=savedChrome;globalThis.document=savedDocument;}});

test('generic text Bot wait is five minutes regardless of the X page timeout',async()=>{
  const {grokBotRelay,BOT_WAIT_MS}=await import('../src/features/grok/grok-bot-relay.js');
  const {requestGrokText}=await import('../src/features/grok/grok-comment.js');
  const previousChrome=globalThis.chrome,previousGenerate=grokBotRelay.generate;
  try{
    globalThis.chrome={storage:{local:{get:async()=>({[GROK_PROVIDER_KEY]:'grok-bot'})}}};
    grokBotRelay.generate=async(_prompt,options)=>{assert.equal(options.timeoutMs,300000);assert.equal(options.timeoutMs,BOT_WAIT_MS);return {ok:true,text:'done'};};
    assert.equal((await requestGrokText('text',{timeoutMs:1000})).text,'done');
  }finally{globalThis.chrome=previousChrome;grokBotRelay.generate=previousGenerate;}
});
