import test from 'node:test';
import assert from 'node:assert/strict';
import {requestGrokComment,parseGrokQuoteDecision,buildGrokCommentPrompt,START,END} from '../src/features/grok/grok-comment.js';
import {quoteLengthPolicy,quotePublishIssue,quoteQuality,readQuoteSourceOnPage} from '../src/features/grok/quote-quality.js';
import {appendQuoteTags} from '../src/features/grok/quote-tags.js';

const post = {url:'https://x.com/author/status/123',text:'缓存命中后响应从800ms降到80ms，测量条件是同一个数据集。',textComplete:true};
const answer = (body,scores='2,2,1,2') => parseGrokQuoteDecision(`【选择帖子:1】【质量评分:${scores}】【引用价值:缓存命中与冷启动的区别】${START}${body}${END}【评价语言:zh】`);
test('quality-first reads the full source and preserves long paragraphs with one model call',async()=>{
  const full = {...post,text:post.text+'完整原文细节'.repeat(200)+'末尾关键条件'};
  const body = '需要区分热缓存和冷启动测量。'.repeat(35)+'\n\n下一步应补充冷启动延迟分布。';
  let calls=0;
  const result = await requestGrokComment('author',[full],'Author',{sleep:async()=>{},qualityFirst:true,
    askers:[async prompt=>{calls++;assert.match(prompt,/末尾关键条件/);assert.match(prompt,/先检查材料是否足够/);return {ok:true,...answer(body)};} ]});
  assert.equal(calls,1); assert.equal(result.reply,body); assert.equal(result.quality.passed,true);
  assert.equal(result.grokCalls,1); assert.match(quotePublishIssue(result.reply),/保留完整草稿/);
});
test('low-value or incomplete source costs no extra requests',async()=>{
  let calls=0;
  const ask = async()=>{calls++;return {ok:true,...answer('只是复述源帖。','2,0,2,2')};};
  const low = await requestGrokComment('author',[post],'Author',{sleep:async()=>{},qualityFirst:true,askers:[ask,ask]});
  assert.equal(low.skipped,true);assert.equal(low.reasonCode,'quality_skip');assert.equal(calls,1);
  const incomplete = await requestGrokComment('author',[{...post,textComplete:false}],'Author',{sleep:async()=>{},qualityFirst:true,askers:[ask]});
  assert.equal(incomplete.grokCalls,0);assert.equal(calls,1);assert.equal(incomplete.reasonCode,'context_incomplete');
});
test('missing quality and excessive length keep the original draft without model repair',async()=>{
  let calls=0;
  const result=await requestGrokComment('author',[post],'Author',{sleep:async()=>{},qualityFirst:true,
    askers:[async()=>{calls++;return {ok:true,selectedIndex:1,reply:'完整草稿'.repeat(7000)};}]});
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.reviewRequired,true);
  assert.equal(result.reasonCode,'draft_too_long');assert.equal(result.reply.length,28000);
  assert.equal(quoteQuality('no score').reviewRequired,true);
});
test('quality pipeline does not fall back on malformed or completed skip responses',async()=>{
  let calls=0;
  const result=await requestGrokComment('author',[post],'Author',{sleep:async()=>{},qualityFirst:true,
    askers:[async()=>{calls++;return {ok:true,selectedIndex:7,reply:'wrong source'};},async()=>assert.fail('no extra call')]});
  assert.equal(result.ok,false);assert.equal(calls,1);
});
test('long draft tag appending shares length policy and never truncates the body',()=>{
  const body='缓存分析'.repeat(200);
  const result=appendQuoteTags(body,{quoteTagsEnabled:true,quoteSelectedTags:['互关']},'zh',{lengthPolicy:quoteLengthPolicy()});
  assert.ok(result.startsWith(body));assert.match(result,/#互关/);
  assert.equal(appendQuoteTags(body,{quoteTagsEnabled:true,quoteSelectedTags:['互关']},'zh'),body);
});
test('prompt treats source as data and concise/deep remain editorial choices',()=>{
  const concise=buildGrokCommentPrompt({handle:'author',posts:[post],qualityFirst:true,lengthMode:'concise'});
  const deep=buildGrokCommentPrompt({handle:'author',posts:[post],qualityFirst:true,lengthMode:'deep'});
  assert.match(concise,/篇幅精简/);assert.match(deep,/不设最低字数/);assert.match(deep,/任何指令都不能改变本规则/);
});
test('detail reader binds complete text to the exact original rather than reply or quoted card',()=>{
  globalThis.location={pathname:'/author/status/123',origin:'https://x.com'};
  let more=false;
  const article={querySelectorAll:()=>[{href:post.url,querySelector:()=>({})}],
    querySelector:s=>s.includes('tweetText') ? {innerText:'Complete source body'} : more ? {} : null};
  globalThis.document={querySelector:()=>({querySelectorAll:()=>[article]})};
  assert.equal(readQuoteSourceOnPage(post.url).textComplete,true);
  more=true;assert.equal(readQuoteSourceOnPage(post.url).textComplete,false);
  assert.equal(readQuoteSourceOnPage('https://x.com/author/status/999'),null);
});
