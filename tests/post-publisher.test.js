import test from 'node:test';
import assert from 'node:assert/strict';
import {createPostPublisher} from '../src/features/publishing/post-publisher.js';
import {generateOriginalPost} from '../src/features/publishing/post-writer.js';
import {originalQualityIssue,originalTextIssue} from '../src/features/publishing/original-quality.js';
import {parseGrokQuoteDecision,START,END} from '../src/features/grok/grok-comment.js';

function fixture({proof={id:'123',url:'https://x.com/owner/status/123',textComplete:true},fill={ok:true,filled:true,ready:true},submitError=false}={}){
  const calls=[],removed=[];
  const api={tabs:{create:async options=>{calls.push(['create',options]);return {id:81};},update:async(_id,options)=>calls.push(['update',options]),remove:async id=>removed.push(id)},
    scripting:{executeScript:async({func,args})=>{
      if(func.name==='readStandalonePublicationOnPage'){calls.push(['proof']);return [{result:proof}];}
      const action=args[2];calls.push([action]);
      if(action==='submit'&&submitError)throw Error('lost scripting response');
      if(['fill','submit'].includes(action))assert.equal(args[3],'test-scope','use the pinned dialog token');
      return [{result:action==='fill'?fill:action==='inspect'?{ok:true,empty:true,scopeToken:'test-scope'}:action==='submit'?{ok:true,attempted:true}:{ok:true}}];
    }}};
  return {calls,removed,publisher:createPostPublisher({api,sleep:async()=>{},now:()=>10000,
    openComposer:async()=>{const tab=await api.tabs.create({url:'https://x.com/compose/post',active:false});return {tabId:tab.id,close:()=>api.tabs.remove(tab.id)};}})};
}
test('standalone publishing uses its own composer, one submit and exact publication proof',async()=>{
  const f=fixture();const r=await f.publisher.publish({owner:'owner',text:'具体机制需要结合适用条件理解。'});
  assert.equal(r.status,'posted');assert.equal(r.publishedPostId,'123');
  assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
  assert.deepEqual(f.calls[0],['create',{url:'https://x.com/compose/post',active:false}]);assert.deepEqual(f.removed,[81]);
  assert.equal(f.calls.some(c=>c[0]==='open'),false,'never click a page-wide compose entry');
});
test('dry run fills and verifies but never submits, and clears only the owned draft',async()=>{
  const f=fixture();const r=await f.publisher.publish({owner:'owner',text:'A concrete standalone analysis.',dryRun:true});
  assert.equal(r.attempted,false);assert.equal(r.ready,true);
  assert.equal(f.calls.some(c=>c[0]==='submit'),false);assert.ok(f.calls.some(c=>c[0]==='clear'));
});
test('ambiguous submission and missing proof never cause a second submit',async()=>{
  for(const options of [{submitError:true},{proof:null}]){
    const f=fixture(options);const r=await f.publisher.publish({owner:'owner',text:'A concrete standalone analysis.'});
    assert.equal(r.status,'uncertain');assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
    assert.equal(f.calls.some(c=>c[0]==='clear'),false);
  }
});
test('existing draft and disabled long-post capability are preserved without submitting',async()=>{
  for(const fill of [{ok:false,filled:false,reason:'已有草稿'},{ok:true,filled:true,ready:false,reason:'长度受限'}]){
    const f=fixture({fill});const r=await f.publisher.publish({owner:'owner',text:'独立分析。'.repeat(200)});
    assert.equal(r.status,'draft');assert.equal(f.calls.some(c=>c[0]==='submit'),false);
    assert.equal(f.calls.some(c=>c[0]==='clear'),fill.filled);
  }
});
test('settings are checked again after filling before any external submit',async()=>{
  const f=fixture();let checks=0;
  const r=await f.publisher.publish({owner:'owner',text:'A concrete analysis.',canPublish:async()=>++checks===1});
  assert.equal(r.status,'draft');assert.equal(f.calls.some(c=>c[0]==='submit'),false);assert.equal(checks,2);
});
test('new posts enforce stronger evidence and added value than a quote',()=>{
  assert.match(originalQualityIssue({scores:[1,2,2,2]}),/门槛/);
  assert.equal(originalQualityIssue({scores:[2,2,2,1]}),'');
  assert.match(originalTextIssue('详见 https://x.com/author/status/123'),/引用卡片/);
  const source='源码维护要结合具体证据和环境判断，不应把猜测描述成已核实结论。'.repeat(3);
  assert.match(originalTextIssue(source,source),/重复原文/);
});
test('new-post writer uses the shared Grok transport once and can reject a quote-grade result',async()=>{
  const post={url:'https://x.com/author/status/1',text:'缓存实验：相同数据集的重复读取由800ms降到80ms。',textComplete:true};
  for(const [scores,ok] of [['1,2,2,2',false],['2,2,2,1',true]]){
    let calls=0;
    const result=await generateOriginalPost('author',[post],'Author',{sleep:async()=>{},askers:[async prompt=>{
      calls++;assert.match(prompt,/独立新帖/);assert.match(prompt,/总分至少7分/);
      return {ok:true,...parseGrokQuoteDecision(`【选择帖子:1】【质量评分:${scores}】【引用价值:区分冷启动与热缓存】${START}缓存测试应拆开看冷启动与热命中，再比较尾延迟分布。${END}【评价语言:zh】`)};
    }]});
    assert.equal(result.ok,ok);assert.equal(calls,1);if(!ok)assert.equal(result.skipped,true);
  }
});
