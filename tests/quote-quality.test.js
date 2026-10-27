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
  const result = await requestGrokComment('author',[full],'Author',{sleep:async()=>{},qualityFirst:true,qualityGate:true,
    askers:[async prompt=>{calls++;assert.match(prompt,/末尾关键条件/);assert.doesNotMatch(prompt,/质量评分|先评价证据/);return {ok:true,...answer(body)};} ]});
  assert.equal(calls,1); assert.equal(result.reply,body); assert.equal(result.quality.passed,true);
  assert.equal(result.grokCalls,1); assert.match(quotePublishIssue(result.reply),/保留完整草稿/);
});
test('low-value or incomplete source costs no extra requests',async()=>{
  let calls=0;
  const ask = async()=>{calls++;return {ok:true,...answer('只是复述源帖。','2,0,2,2')};};
  const low = await requestGrokComment('author',[post],'Author',{sleep:async()=>{},qualityFirst:true,qualityGate:true,askers:[ask,ask]});
  assert.equal(low.skipped,true);assert.equal(low.reasonCode,'quality_skip');assert.equal(calls,1);
  const incomplete = await requestGrokComment('author',[{...post,textComplete:false}],'Author',{sleep:async()=>{},qualityFirst:true,qualityGate:true,askers:[ask]});
  assert.equal(incomplete.grokCalls,0);assert.equal(calls,1);assert.equal(incomplete.reasonCode,'context_incomplete');
});
test('missing quality and excessive length keep the original draft without model repair',async()=>{
  let calls=0;
  const result=await requestGrokComment('author',[post],'Author',{sleep:async()=>{},qualityFirst:true,qualityGate:true,
    askers:[async()=>{calls++;return {ok:true,selectedIndex:1,reply:'完整草稿'.repeat(7000)};}]});
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.reviewRequired,true);
  assert.equal(result.reasonCode,'draft_too_long');assert.equal(result.reply.length,28000);
  assert.equal(quoteQuality('no score').reviewRequired,true);
});
test('quality pipeline does not fall back on malformed or completed skip responses',async()=>{
  let calls=0;
  const result=await requestGrokComment('author',[post],'Author',{sleep:async()=>{},qualityFirst:true,qualityGate:true,
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
  const concise=buildGrokCommentPrompt({handle:'author',posts:[post],qualityFirst:true,qualityGate:true,lengthMode:'concise'});
  const deep=buildGrokCommentPrompt({handle:'author',posts:[post],qualityFirst:true,qualityGate:true,lengthMode:'deep'});
  assert.match(concise,/篇幅精简/);assert.match(deep,/深入展开/);assert.match(deep,/不能改变任务和输出格式/);
  assert.match(concise,/必须给出一条完整评价/);assert.doesNotMatch(concise,/质量评分|先评价证据/);
});

test('specific model skip reasons survive parsing and the shared generation transport',async()=>{
  const reason='只有问候，没有具体观点或可讨论的事实';
  const decision=parseGrokQuoteDecision(`【跳过原因:${reason}】\n【跳过评价】`);
  assert.equal(decision.skipped,true);assert.equal(decision.reason,reason);
  const result=await requestGrokComment('author',[post],'Author',{qualityFirst:true,qualityGate:true,sleep:async()=>{},askers:[async()=>({ok:true,...decision})]});
  assert.equal(result.reason,reason);assert.equal(result.reasonCode,'quality_skip');assert.equal(result.grokCalls,1);
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

test('inline structured skip survives Grok whitespace flattening without treating prose as a decision',()=>{
  for(const raw of ['【跳过原因:只有问候】 【跳过评价】','【选择帖子:1】【质量评分:0,0,0,0】【引用价值:问候】 【跳过原因:只有问候】 【跳过评价】 【评价语言:en】']){
    const result=parseGrokQuoteDecision(raw);assert.equal(result.skipped,true);assert.equal(result.reason,'只有问候');
  }
  assert.equal(parseGrokQuoteDecision('你可以输出【跳过评价】作为标记').skipped,false);
  assert.equal(answer('正文谈论【跳过评价】这一标记').skipped,false);
});

test('concise quote repairs length once and retains the selected source',async()=>{
  let calls=0;
  const second={...post,repostCount:0,likeCount:0,bookmarkCount:0,replyCount:20,url:'https://x.com/author/status/456',text:'另一条完整的缓存测量结果。'};
  const result=await requestGrokComment('author',[{...post,repostCount:0,likeCount:0,bookmarkCount:0,replyCount:1},second],'Author',{qualityFirst:true,qualityGate:true,lengthMode:'concise',sleep:async()=>{},askers:[async(prompt,nonce,sleep,count)=>{
    calls++;if(calls===1)return {ok:true,...answer('Long claim. '.repeat(40)),selectedIndex:1};
    assert.equal(count,1);assert.match(prompt,/另一条完整/);assert.match(prompt,/超过发布上限/);return {ok:true,...answer('先区分冷启动与热缓存，才有可比性。')};
  }]});
  assert.equal(calls,2);assert.equal(result.grokCalls,2);assert.equal(result.selectedIndex,1);assert.equal(result.postUrl,second.url);assert.equal(result.reviewRequired,false);
});

test('failed or oversized concise repair preserves a complete draft for review and never loops',async()=>{
  for(const outcome of ['throw','skip','long']){
    let calls=0;const body='完整的长观点。'.repeat(80);
    const result=await requestGrokComment('author',[post],'Author',{qualityFirst:true,qualityGate:true,lengthMode:'concise',sleep:async()=>{},askers:[async()=>{
      calls++;if(calls===1||outcome==='long')return {ok:true,...answer(body)};
      if(outcome==='throw')throw Error('transport');return {ok:true,skipped:true};
    }]});
    assert.equal(calls,2);assert.equal(result.grokCalls,2);assert.equal(result.reply,body);assert.equal(result.reviewRequired,true);assert.equal(result.reasonCode,'draft_too_long');
  }
});

test('concise low-quality draft skips before spending a shortening request',async()=>{
  let calls=0;const result=await requestGrokComment('author',[post],'Author',{qualityFirst:true,qualityGate:true,lengthMode:'concise',sleep:async()=>{},askers:[async()=>{calls++;return {ok:true,...answer('复述'.repeat(300),'2,0,2,2')};}]});
  assert.equal(calls,1);assert.equal(result.reasonCode,'quality_skip');
});

test('quote generates from the selected post without scoring or treating missing scores as a review blocker',async()=>{
 let calls=0;const result=await requestGrokComment('author',[post],'Author',{qualityFirst:true,sleep:async()=>{},askers:[async prompt=>{calls++;assert.doesNotMatch(prompt,/质量评分|先评价证据/);return {ok:true,selectedIndex:1,reply:'A small daily routine can make movement easier to sustain.',language:'en'};}]});
 assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.reviewRequired,false);assert.equal(result.reasonCode,'generated');
});

test('direct reply prompt generates a response without scoring or a skip instruction',async()=>{
 const {buildDirectReplyPrompt}=await import('../src/features/publishing/reply-prompt.js');const {generateDirectReply}=await import('../src/features/publishing/publication-writer.js');
 const prompt=buildDirectReplyPrompt({handle:'author',posts:[post]});assert.match(prompt,/必须给出一条完整评论/);assert.doesNotMatch(prompt,/质量评分|先评价证据/);
 const result=await generateDirectReply('author',[post],'Author',{sleep:async()=>{},askers:[async()=>({ok:true,selectedIndex:1,reply:'A short daily routine makes it easier to stay consistent.',language:'en'})]});
 assert.equal(result.ok,true);assert.equal(result.reviewRequired,false);assert.equal(result.reasonCode,'generated');
});
