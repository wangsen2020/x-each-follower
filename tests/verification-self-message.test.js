import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVerificationSelfMessage,operateSelfMessageOnPage,sendVerificationSelfMessage} from '../verification-self-message.js';

const identity={accountId:'123',handle:'alice'};
const notice={url:'https://grok.com/',at:'2026-10-18T10:00:00Z',windowId:99};
test('verification message identifies the account and desktop action without exposing a conversation URL',()=>{
  const text=buildVerificationSelfMessage({...notice,url:'https://grok.com/c/private-conversation'},identity);
  assert.match(text,/@alice/);assert.match(text,/回到运行扩展的电脑/);assert.match(text,/提醒编号：XFV-/);
  assert.equal(text.includes('private-conversation'),false);
  assert.throws(()=>buildVerificationSelfMessage({...notice,url:'https://example.com'},identity));
});

test('page sender refuses another account or a conversation with another recipient',()=>{
  const prior={document:globalThis.document,location:globalThis.location};
  try {
    globalThis.document={querySelector:()=>({getAttribute:()=>'/bob'})};
    globalThis.location={hostname:'x.com',pathname:'/i/chat/123-123'};
    assert.equal(operateSelfMessageOnPage({...identity,action:'send'}).blocked,true);
    globalThis.document={querySelector:()=>({getAttribute:()=>'/alice'})};
    globalThis.location.pathname='/i/chat/123-456';
    assert.equal(operateSelfMessageOnPage({...identity,action:'send'}).blocked,true);
  } finally {Object.assign(globalThis,prior);}
});

test('receipt uses unique reminder marker because X rewrites displayed links',()=>{
  const prior={document:globalThis.document,location:globalThis.location};
  try {
    const message=buildVerificationSelfMessage(notice,identity);
    const marker=message.match(/提醒编号：(XFV-[a-z0-9]+)/)[1];
    const row={textContent:'你 18:24 附件 grok.com 提醒编号：'+marker,getAttribute:key=>key==='data-send-status'?'sent':'server-message-id'};
    const root={querySelector:()=>null,querySelectorAll:()=>[row]};
    globalThis.document={querySelector:selector=>selector.includes('AppTabBar')?{getAttribute:()=>'/alice'}:{shadowRoot:root}};
    globalThis.location={hostname:'x.com',pathname:'/i/chat/123-123'};
    const result=operateSelfMessageOnPage({...identity,message,action:'receipt'});
    assert.equal(result.sent,true);assert.equal(result.messageId,'server-message-id');
  } finally {Object.assign(globalThis,prior);}
});

function fixture({receipt=true}={}) {
  let saved={},calls=[],clicks=0;
  const api={storage:{local:{get:async()=>saved,set:async value=>Object.assign(saved,structuredClone(value))}},
    windows:{create:async value=>{calls.push(value.url);return {id:7,tabs:[{id:8}]};},remove:async id=>calls.push(['close',id]),update:async()=>{}},
    scripting:{executeScript:async({args:[args]})=>{
      assert.equal(args.accountId,'123');assert.equal(args.handle,'alice');
      if(args.action==='fill')return [{result:{prepared:true}}];
      if(args.action==='send'){clicks++;return [{result:{submitted:true}}];}
      return [{result:receipt?{sent:true,messageId:'message-1'}:{pending:true}}];
    }}};
  return {api,get saved(){return saved;},get clicks(){return clicks;},calls};
}
test('self notification clicks send once, confirms receipt, closes only its popup and deduplicates',async()=>{
  const f=fixture();const options={identity,notice,api:f.api,wait:async()=>{},now:()=>1000};
  assert.equal((await sendVerificationSelfMessage(options)).ok,true);
  assert.equal(f.saved.grokVerificationSelfMessage.status,'sent');
  assert.equal(f.clicks,1);assert.ok(f.calls.includes('https://x.com/i/chat/123-123'));
  assert.deepEqual(f.calls.filter(Array.isArray),[['close',7]]);
  assert.equal((await sendVerificationSelfMessage(options)).deduplicated,true);
  assert.equal(f.clicks,1);
});
test('unconfirmed DM is recorded as uncertain and never resent automatically',async()=>{
  const f=fixture({receipt:false});const options={identity,notice,api:f.api,wait:async()=>{},now:()=>1000};
  assert.equal((await sendVerificationSelfMessage(options)).ok,false);
  assert.equal(f.saved.grokVerificationSelfMessage.status,'uncertain');
  assert.equal(f.clicks,1);
  assert.equal((await sendVerificationSelfMessage(options)).deduplicated,true);
  assert.equal(f.clicks,1);
});
