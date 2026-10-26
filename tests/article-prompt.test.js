import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOriginalArticlePrompt} from '../src/features/publishing/article-prompt.js';
import {generateOriginalPost} from '../src/features/publishing/post-writer.js';
import {buildGrokCommentPrompt,parseGrokQuoteDecision,START,END} from '../src/features/grok/grok-comment.js';

test('article prompt carries full source, opening context, provenance and reader value without quote framing',()=>{
  const source='A comparison of road safety figures needs compatible definitions. '.repeat(20);
  for(const lengthMode of ['concise','deep','adaptive']){
    const prompt=buildOriginalArticlePrompt({handle:'author',name:'Author',posts:[{text:source}],nonce:'test-token',writingContext:'Prefer clear paragraphs.',lengthMode});
    for(const expected of [source,'开篇必须交代背景与写作缘起','读者为什么会关心','不能自动升级为已核实事实','不要虚构','年份、单位、分母与口径','总分至少7分','Prefer clear paragraphs.','test-token',START,END])assert.ok(prompt.includes(expected),expected);
    for(const oldInstruction of ['最值得公开引用评价','上文的引用措辞','总分至少 6','220 加权字符','280 加权字符','系统会从用户候选池随机补充'])assert.ok(!prompt.includes(oldInstruction),oldInstruction);
  }
  assert.match(buildGrokCommentPrompt({handle:'author',posts:[{text:source}],qualityFirst:true}),/最值得公开引用评价/,'quote framing stays in the quote path');
});

test('original writer sends article instructions in the real shared request path and keeps selection binding',async()=>{
  const posts=['Cache experiment: 800ms cold, 80ms warm; same dataset.','Database migration: a checkpoint after each transaction permits restart without replaying committed work.'].map((text,i)=>({url:`https://x.com/author/status/${i+1}`,text,textComplete:true}));
  let calls=0;
  const result=await generateOriginalPost('author',posts,'Author',{sleep:async()=>{},askers:[async prompt=>{
    calls++;assert.match(prompt,/开篇必须交代背景与写作缘起/);assert.doesNotMatch(prompt,/最值得公开引用评价/);
    return {ok:true,...parseGrokQuoteDecision(`【选择帖子:2】【质量评分:2,2,2,1】【引用价值:区分实验条件】${START}A cache benchmark compares cold and warm reads. For a reader choosing a cache, tail latency matters alongside that difference.${END}【评价语言:en】`,2)};
  },async()=>{throw Error('must not request a second draft');}]});
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.post.url,posts[1].url);assert.equal(result.publicationMode,'original');
});

test('article generation respects an explicit insufficient-material skip without extra quota use',async()=>{
  let calls=0;
  const result=await generateOriginalPost('author',[{url:'https://x.com/author/status/1',text:'A short observation without supporting details.',textComplete:true}],'Author',{sleep:async()=>{},askers:[async()=>{calls++;return {ok:true,skipped:true};}]});
  assert.equal(result.ok,false);assert.equal(result.skipped,true);assert.equal(calls,1);
});
