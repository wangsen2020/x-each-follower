import test from 'node:test';
import assert from 'node:assert/strict';
import {extractGrokComment,extractGrokCommentLanguage,appendFollowBackSuffix,composeQueueFollowBack,resolveCommentLanguage,tweetWeight} from '../src/features/grok/grok-comment.js';
import {appendQuoteTags} from '../src/features/grok/quote-tags.js';
test('language metadata is separate from body and belongs to the last answer',()=>{
 const raw='【引用评价开始】旧的中文回答【引用评价结束】【评价语言:zh】\n【引用评价开始】Remote work still has a local pay ceiling.【引用评价结束】【评价语言:en】';
 assert.equal(extractGrokComment(raw),'Remote work still has a local pay ceiling.');
 assert.equal(extractGrokCommentLanguage(raw),'en');
 assert.equal(extractGrokCommentLanguage('【引用评价开始】Es un coste oculto.【引用评价结束】【评价语言:es】'),'es');
});
test('localized suffixes remove legacy Chinese endings and are idempotent',()=>{
 for(const [lang,body,suffix] of [['en','Remote work has a price.','Follow me and I’ll follow back! 🤝'],['es','El trabajo tiene un precio.','¡Sígueme y te seguiré de vuelta! 🤝'],['pt','O trabalho tem um preço.','Siga-me e eu seguirei você de volta! 🤝'],['vi','Đây là một ý hay.','Theo dõi mình, mình sẽ theo dõi lại bạn! 🤝'],['zh','这是隐形的代价','关注我，必回关！🤝']]){
  const text=appendFollowBackSuffix(body,undefined,lang);
  assert.equal(text,body+'\n\n'+suffix);assert.equal(appendFollowBackSuffix(text,undefined,lang),text);
 }
 assert.equal(appendFollowBackSuffix('Remote work has a price.\n有关必回'),'Remote work has a price.\n\nFollow me and I’ll follow back! 🤝');
 assert.equal(appendFollowBackSuffix('未知语种',undefined,'de'),'未知语种');
 assert.ok(appendFollowBackSuffix('a'.repeat(280),undefined,'en').startsWith('a'.repeat(280)));
 assert.equal(resolveCommentLanguage('English reply about remote jobs','zh'),'en');
});
test('queue follow-back switch preserves text, localizes once, and reports insufficient space',()=>{
 const zh='事实和专有名词需要实测。', en='The result needs a real test.';
 assert.deepEqual(composeQueueFollowBack(zh,'zh',false),{text:zh,issue:''});
 assert.equal(composeQueueFollowBack(zh,'zh',true).text,zh+'\n\n关注我，必回关！🤝');
 assert.equal(composeQueueFollowBack(en,'en',true).text,en+'\n\nFollow me and I’ll follow back! 🤝');
 assert.equal(composeQueueFollowBack(en,'es',true).text,en+'\n\n¡Sígueme y te seguiré de vuelta! 🤝');
 assert.equal(composeQueueFollowBack(en,'pt-BR',true).text,en+'\n\nSiga-me e eu seguirei você de volta! 🤝');
 assert.equal(composeQueueFollowBack(en,'vi',true).text,en+'\n\nTheo dõi mình, mình sẽ theo dõi lại bạn! 🤝');
 for(const existing of [zh+'来关必回',zh+'有关必回',en+' I follow back.',en+'\n\nFollow me and I’ll follow back! 🤝',zh+'\n\n关注我，必回关！🤝','Hola. Te sigo de vuelta.','Olá. Sigo de volta.','Hola. ¡Sígueme y te seguiré de vuelta! 🤝','Olá. Siga-me e eu seguirei você de volta! 🤝','Xin chào. Theo dõi mình, mình sẽ theo dõi lại bạn! 🤝'])assert.equal(composeQueueFollowBack(existing,undefined,true).text,existing);
 const full='a'.repeat(280);const out=composeQueueFollowBack(full,'en',true);
 assert.equal(out.text,full);assert.match(out.issue,/无法追加/);
 const invitation='\n\nFollow me and I’ll follow back! 🤝';
 const exact='a'.repeat(280-tweetWeight(invitation));
 assert.equal(tweetWeight(composeQueueFollowBack(exact,'en',true).text),280);
 const overflow=composeQueueFollowBack(exact+'a','en',true);
 assert.equal(overflow.text,exact+'a');assert.match(overflow.issue,/无法追加/);
});
test('language filters selected tags on generation and legacy draft retry',()=>{
 const settings={quoteTagsEnabled:true,quoteSelectedTags:['互关','互关呀','FollowBack','FollowForFollow']};
 const en=appendQuoteTags('Remote work has a price.',settings,'en',{random:()=>0});
 assert.ok(en.includes('#FollowBack #FollowForFollow'));assert.ok(!en.includes('#互关'));
 const zh=appendQuoteTags('远程工作也有隐形代价',settings,'zh',{random:()=>0});
 assert.ok(zh.includes('#互关 #互关呀'));assert.ok(!zh.includes('#FollowBack'));
 const old='Remote work has a price.\n\n#互关 #FollowBack';
 assert.equal(appendQuoteTags(old,settings,'und'),en);
 assert.equal(appendQuoteTags(en,settings,'en'),en);
 assert.equal(appendQuoteTags('これはテストです #互关',settings,'und'),'これはテストです');
});
