import test from 'node:test';
import assert from 'node:assert/strict';
import {extractGrokComment,extractGrokCommentLanguage,appendFollowBackSuffix,resolveCommentLanguage,tweetWeight} from '../grok-comment.js';
import {appendQuoteTags} from '../quote-tags.js';
test('language metadata is separate from body and belongs to the last answer',()=>{
 const raw='【引用评价开始】旧的中文回答【引用评价结束】【评价语言:zh】\n【引用评价开始】Remote work still has a local pay ceiling.【引用评价结束】【评价语言:en】';
 assert.equal(extractGrokComment(raw),'Remote work still has a local pay ceiling.');
 assert.equal(extractGrokCommentLanguage(raw),'en');
 assert.equal(extractGrokCommentLanguage('【引用评价开始】Es un coste oculto.【引用评价结束】【评价语言:es】'),'es');
});
test('localized suffixes remove legacy Chinese endings and are idempotent',()=>{
 for(const [lang,body,suffix] of [['en','Remote work has a price.','I follow back.'],['es','El trabajo tiene un precio.','Te sigo de vuelta.'],['pt','O trabalho tem um preço.','Sigo de volta.'],['zh','这是隐形的代价','有关必回']]){
  const text=appendFollowBackSuffix(body,undefined,lang);
  assert.ok(text.endsWith(suffix));assert.equal(appendFollowBackSuffix(text,undefined,lang),text);
 }
 assert.equal(appendFollowBackSuffix('Remote work has a price.\n有关必回'),'Remote work has a price. I follow back.');
 assert.equal(appendFollowBackSuffix('未知语种',undefined,'de'),'未知语种');
 assert.ok(tweetWeight(appendFollowBackSuffix('a'.repeat(280),undefined,'en'))<=280);
 assert.equal(resolveCommentLanguage('English reply about remote jobs','zh'),'en');
});
test('language filters selected tags on generation and legacy draft retry',()=>{
 const settings={quoteTagsEnabled:true};
 const en=appendQuoteTags('Remote work has a price.',settings,'en');
 assert.ok(en.includes('#FollowBack #FollowForFollow'));assert.ok(!en.includes('#互关'));
 const zh=appendQuoteTags('远程工作也有隐形代价',settings,'zh');
 assert.ok(zh.includes('#互关 #互关呀'));assert.ok(!zh.includes('#FollowBack'));
 const old='Remote work has a price.\n\n#互关 #FollowBack';
 assert.equal(appendQuoteTags(old,settings,'und'),en);
 assert.equal(appendQuoteTags(en,settings,'en'),en);
 assert.equal(appendQuoteTags('これはテストです #互关',settings,'und'),'これはテストです');
});
