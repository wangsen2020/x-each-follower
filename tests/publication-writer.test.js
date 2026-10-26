import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDirectReplyPrompt} from '../src/features/publishing/reply-prompt.js';
import {buildXArticlePrompt} from '../src/features/publishing/long-article-prompt.js';
import {buildGrokCommentPrompt} from '../src/features/grok/grok-comment.js';
import {parseXArticleDraft,generateDirectReply,generateXArticle} from '../src/features/publishing/publication-writer.js';

const context={handle:'source',name:'Source',posts:[{text:'A fixed reward multiplier does not define reinvestment.',url:'https://x.com/source/status/1',textComplete:true}]};
const article={title:'Fixed boosts and changing rules',body:'A source describes a fixed boost. Its value still depends on the rules that govern the base rate.',description:'A closer look at fixed incentives and protocol dependency.',coverPrompt:'5:2 landscape editorial illustration, no text.'};
test('article generation repairs an overlong description once without truncating it',async()=>{
  const previous=globalThis.chrome;globalThis.chrome={storage:{local:{get:async()=>({})}}};
  try{
    let calls=0;
    const result=await generateXArticle(context.handle,context.posts,context.name,{sleep:async()=>{},askers:[async prompt=>{
      calls++;if(calls===2)assert.match(prompt,/上一轮未通过发布前检查.*描述/);
      return {ok:true,selectedIndex:1,reply:JSON.stringify(calls===1?{...article,description:'a'.repeat(281)}:article),quality:{passed:true,scores:[2,2,2,2],total:8}};
    }]});
    assert.equal(result.ok,true);assert.equal(calls,2);assert.equal(result.grokCalls,2);assert.equal(result.article.description,article.description);
  }finally{globalThis.chrome=previous;}
});
test('article generation refuses copied source paragraphs after a bounded retry',async()=>{
  const previous=globalThis.chrome;globalThis.chrome={storage:{local:{get:async()=>({})}}};
  try{
    const source='The source claims a permanent multiplier, but its calculation and governance remain unspecified. '.repeat(3);let calls=0;
    const result=await generateXArticle(context.handle,[{...context.posts[0],text:source}],context.name,{sleep:async()=>{},askers:[async()=>{
      calls++;return {ok:true,selectedIndex:1,reply:JSON.stringify({...article,body:'## A heading\n\n'+source+'\n\nA conclusion.'}),quality:{passed:true,scores:[2,2,2,2],total:8}};
    }]});
    assert.equal(calls,2);assert.equal(result.ok,false);assert.equal(result.reviewRequired,true);assert.match(result.reason,/复制素材/);
  }finally{globalThis.chrome=previous;}
});
test('three prompts distinguish a direct response, a quote and a true Article with metadata and artwork',()=>{
  const reply=buildDirectReplyPrompt(context),quote=buildGrokCommentPrompt(context),long=buildXArticlePrompt(context);
  assert.match(reply,/原帖下的一条评论/);assert.match(reply,/280/);
  assert.match(quote,/公开引用评价/);
  assert.match(long,/X Articles/);assert.match(long,/description/);assert.match(long,/coverPrompt/);assert.match(long,/5:2/);
  assert.match(long,/固定比例的额外奖励不等于复利/);
  assert.match(long,/Markdown 排版/);assert.match(long,/## 小标题/);
  assert.match(long,/段落之间空一行/);assert.match(long,/没有重复段落/);
  for(const prompt of [reply,long])assert.ok(prompt.includes(context.posts[0].text));
});
test('article JSON preserves Markdown structure and paragraph order for the editor converter',()=>{
  const body='An opening paragraph.\n\n## A fixed boost\n\n**A multiplier is not compounding.**\n\n- Check the base rate.\n- Check the rules.\n\n## Practical boundary\n\nA final paragraph.';
  assert.equal(parseXArticleDraft(JSON.stringify({...article,body})).body,body);
});
test('article draft requires body, title, short accompanying description and Grok artwork prompt without silently truncating',()=>{
  assert.deepEqual(parseXArticleDraft(JSON.stringify(article)),article);
  for(const key of Object.keys(article))assert.throws(()=>parseXArticleDraft(JSON.stringify({...article,[key]:''})),new RegExp(key));
  assert.throws(()=>parseXArticleDraft(JSON.stringify({...article,title:'a'.repeat(101)})),/标题/);
  assert.throws(()=>parseXArticleDraft(JSON.stringify({...article,description:'a'.repeat(281)})),/描述/);
  assert.equal(parseXArticleDraft(JSON.stringify({...article,description:'a'.repeat(256)})).description.length,256);
  assert.throws(()=>parseXArticleDraft(JSON.stringify({...article,description:'中'.repeat(129)})),/256/);
});
test('writers use a single shared transport call with separate prompts and preserve source selection',async()=>{
  const previous=globalThis.chrome;globalThis.chrome={storage:{local:{get:async()=>({})}}};
  try{
    let calls=0;
    const options={sleep:async()=>{},askers:[async prompt=>{calls++;assert.match(prompt,/X Articles/);return {ok:true,selectedIndex:1,reply:JSON.stringify(article),quality:{passed:true,scores:[2,2,2,2],total:8}};}]};
    const generated=await generateXArticle(context.handle,context.posts,context.name,options);
    assert.equal(calls,1);assert.equal(generated.postUrl,context.posts[0].url);assert.deepEqual(generated.article,article);
    const reply=await generateDirectReply(context.handle,context.posts,context.name,{...options,askers:[async prompt=>{assert.match(prompt,/原帖下的一条评论/);return {ok:true,selectedIndex:1,reply:'A fixed boost still depends on the base-rate rules.',quality:{passed:true,scores:[2,2,1,1],total:6}};}]});
    assert.equal(reply.publicationMode,'reply');assert.equal(reply.ok,true);
  }finally{globalThis.chrome=previous;}
});
