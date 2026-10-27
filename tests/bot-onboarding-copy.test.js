import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {captureOwnedGrokWebhook} from '../src/features/grok/bot-onboarding-page.js';

function fixture({name='owned',url='https://grok.com/automations',instruction='fixed',fail=false}={}){
  const endpoint='https://grok.com/webhook/automation/11111111-2222-3333-4444-555555555555',secret='whsec_'+'x'.repeat(44),writes=[];
  const clipboard={writeText:async value=>{writes.push(value);}};const original=clipboard.writeText;
  const visible={getClientRects:()=>[{}],closest:()=>null};
  const dialog={...visible,querySelector:selector=>selector.startsWith('input[')?{value:name}:{isContentEditable:true,innerText:instruction},querySelectorAll:()=>labels};
  function label(text,value){const button={...visible,getAttribute:()=> '复制到剪贴板',click(){if(fail)throw Error('copy unavailable');void clipboard.writeText(value);}};const row={parentElement:dialog,querySelectorAll:()=>[button]};return {children:[],textContent:text,parentElement:row};}
  const labels=[label('端点',endpoint),label('签名密钥',secret)];
  const context={URL,location:{href:url},document:{querySelectorAll:()=>[dialog]},navigator:{clipboard},setTimeout:resolve=>resolve()};
  const run=vm.runInNewContext('('+captureOwnedGrokWebhook.toString()+')',context);
  return {run,clipboard,original,writes,endpoint,secret};
}

test('new task copy controls return credential directly without touching system clipboard and always restore the native method',async()=>{
  const f=fixture();const result=await f.run({createdHere:true,botName:'owned',instruction:'fixed'});
  assert.equal(result.webhookUrl,f.endpoint);assert.equal(result.webhookSecret,f.secret);assert.equal(result.state,'webhook');
  assert.equal(f.writes.length,0);assert.equal(f.clipboard.writeText,f.original);
});
test('copy failures restore the clipboard method and never return partial credentials',async()=>{
  const f=fixture({fail:true});const result=await f.run({createdHere:true,botName:'owned',instruction:'fixed'});
  assert.equal(result.state,'credential-unavailable');assert.equal(result.webhookSecret,undefined);assert.equal(f.clipboard.writeText,f.original);
});
test('existing or mismatched task cannot expose a credential',async()=>{
  for(const input of [{createdHere:false,botName:'owned',instruction:'fixed'},{createdHere:true,botName:'other',instruction:'fixed'},{createdHere:true,botName:'owned',instruction:'different'}]){
    const f=fixture();const result=await f.run(input);assert.notEqual(result.state,'webhook');assert.equal(f.clipboard.writeText,f.original);assert.equal(f.writes.length,0);
  }
  const f=fixture({url:'https://grok.com.evil.example/automations'});assert.equal((await f.run({createdHere:true,botName:'owned',instruction:'fixed'})).state,'wrong-page');
});
