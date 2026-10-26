import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePanelQuoteText} from '../src/features/grok/panel-quote-text.js';
import {appendQuoteTags} from '../src/features/grok/quote-tags.js';
import {tweetWeight} from '../src/features/grok/quote-text.js';

test('manual quote uses bound account tags exactly like the queue within the remaining budget', async () => {
  const settings={quoteTagsEnabled:true};
  const text='a'.repeat(234);
  const api={storage:{local:{get:async()=>({followQueueBinding:{activated:true,accountId:'123'}})}},runtime:{sendMessage:async message=>{
    assert.deepEqual(message,{cmd:'followQueueSettings',accountId:'123'});
    return {ok:true,settings};
  }}};
  const result=await preparePanelQuoteText(text,'en',true,api);
  assert.equal(result,appendQuoteTags(result,settings,'en'));
  assert.equal((result.match(/#/g)||[]).length,2);
  assert.ok(result.startsWith(text+'\n\n#'));
  assert.ok(tweetWeight(result)<=280);
});

test('manual quote respects disabled queue tags and fails on unavailable settings', async () => {
  const api={storage:{local:{get:async()=>({followQueueBinding:{activated:true,accountId:'123'}})}},runtime:{sendMessage:async()=>({ok:true,settings:{quoteTagsEnabled:false}})}};
  assert.equal(await preparePanelQuoteText('A complete observation.','en',true,api),'A complete observation.');
  api.runtime.sendMessage=async()=>({ok:false,error:'后台未响应'});
  await assert.rejects(preparePanelQuoteText('A complete observation.','en',false,api),/后台未响应/);
});

test('unbound legacy manual quote retains opt-in suffix behavior', async () => {
  const api={storage:{local:{get:async()=>({})}},runtime:{sendMessage:async()=>{throw Error('must not query an unbound account');}}};
  assert.equal(await preparePanelQuoteText('完整观点','zh',false,api),'完整观点');
  assert.match(await preparePanelQuoteText('完整观点','zh',true,api),/^完整观点/);
});
