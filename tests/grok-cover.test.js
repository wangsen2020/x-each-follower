import test from 'node:test';
import assert from 'node:assert/strict';
import {generateGrokCover,generateArticleCover,readGrokCoverStateOnPage} from '../src/features/publishing/grok-cover.js';

test('article artwork always tries Grok first even with a bound Cloudflare account',async()=>{
  let cf=0;const result=await generateArticleCover({title:'A title'}, {grok:async()=>({ok:true,cover:{provider:'x.com/grok'}}),cloudflare:{status:async()=>{cf++;return {connected:true};}}});
  assert.equal(result.cover.provider,'x.com/grok');assert.equal(cf,0);
});
test('Grok quota or failed output uses bound Cloudflare once and retains fallback provenance',async()=>{
  for(const reason of ['额度耗尽','等待超时','页面打开失败']){
    const calls=[];
    const result=await generateArticleCover({canGenerate:async()=>true},{grok:async()=>{calls.push('grok');if(reason==='页面打开失败')throw Error(reason);return {ok:false,reason};},cloudflare:{status:async()=>({connected:true}),generate:async()=>{calls.push('cloudflare');return {ok:true,cover:{provider:'cloudflare'}};}}});
    assert.deepEqual(calls,['grok','cloudflare']);assert.equal(result.cover.fallbackReason,reason);assert.equal(result.cover.fallbackFrom,'x.com/grok');
  }
});
test('account mismatch, cancelled work and missing fallback connection do not invoke Cloudflare',async()=>{
  for(const mode of ['blocked','cancelled','unbound']){
    let calls=0;
    const result=await generateArticleCover({canGenerate:async()=>mode!=='cancelled'},{grok:async()=>({ok:false,blocked:mode==='blocked',reason:'stopped'}),cloudflare:{status:async()=>({connected:false}),generate:async()=>{calls++;}}});
    assert.equal(result.ok,false);assert.equal(calls,0);
  }
});
test('Grok poster request includes article headline and typography even for older text-free prompts',async()=>{
  const h=harness([{viewer:'owner',sources:[]},{viewer:'owner',image:{src:'new'}}]);
  const execute=h.api.scripting.executeScript;let prompt;
  h.api.scripting.executeScript=async options=>{if(options.func.name==='driveGrokInput')prompt=options.args[0];return execute(options);};
  await generateGrokCover({owner:'owner',title:'Fixed rewards',prompt:'No text. A golden network.',api:h.api,sleep:async()=>{}});
  assert.match(prompt,/Fixed rewards/);assert.match(prompt,/legible headline/);assert.match(prompt,/override any earlier no-text/);
});

function harness(states){let submits=0,closed=0;return {get submits(){return submits;},get closed(){return closed;},api:{tabs:{create:async()=>({id:1}),get:async()=>({status:'complete'}),remove:async()=>{closed++;}},scripting:{executeScript:async({func})=>[{result:func.name==='readGrokCoverStateOnPage'?states.shift():func.name==='driveGrokInput'?(submits++,{ok:true}):func.name==='encodeGrokCoverOnPage'?{dataUrl:'data:image/png;base64,AAAA',width:1200,height:480,provider:'x.com/grok'}:{}}]}}};}
test('Grok cover submits once, ignores existing media and returns a normalized 5:2 asset',async()=>{
  const h=harness([{viewer:'owner',sources:['old']},{viewer:'owner',image:{src:'new'}}]);
  const result=await generateGrokCover({owner:'owner',prompt:'network diagram',api:h.api,sleep:async()=>{}});
  assert.equal(result.ok,true);assert.equal(result.cover.width/result.cover.height,2.5);assert.equal(h.submits,1);assert.equal(h.closed,1);
});
test('explicit image quota feedback stops without a second paid request or a publishing fallback',async()=>{
  const h=harness([{viewer:'owner',sources:[]},{viewer:'owner',quotaExhausted:true}]);
  const result=await generateGrokCover({owner:'owner',prompt:'cover',api:h.api,sleep:async()=>{}});
  assert.equal(result.ok,false);assert.equal(result.quotaExhausted,true);assert.equal(h.submits,1);assert.equal(h.closed,1);
});
test('account mismatch and revoked generation block before any model request',async()=>{
  for(const viewer of ['other','owner']){
    const h=harness([{viewer,sources:[]}]);
    const result=await generateGrokCover({owner:'owner',prompt:'cover',api:h.api,sleep:async()=>{},canGenerate:async()=>false});
    assert.equal(result.ok,false);assert.equal(h.submits,0);assert.equal(h.closed,1);
  }
});
test('page reader detects the actual quota response independently of a missing image',()=>{
  const doc=globalThis.document;
  globalThis.document={images:[],body:{innerText:'You have reached a Grok usage limit. Try again later.'},querySelector:()=>({getAttribute:()=>'/owner'})};
  try{assert.equal(readGrokCoverStateOnPage().quotaExhausted,true);}finally{globalThis.document=doc;}
});
