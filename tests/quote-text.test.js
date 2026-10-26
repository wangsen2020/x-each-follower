import test from 'node:test';
import assert from 'node:assert/strict';
import {tweetWeight, resolveCommentLanguage} from '../src/features/grok/quote-text.js';
import {tweetWeight as grokWeight, resolveCommentLanguage as grokLanguage, extractGrokComment, appendFollowBackSuffix} from '../src/features/grok/grok-comment.js';
import {appendQuoteTags, validateQuoteTags} from '../src/features/grok/quote-tags.js';

test('grok comment re-exports the pure quote text helpers', () => {
  assert.equal(grokWeight, tweetWeight);
  assert.equal(grokLanguage, resolveCommentLanguage);
});

test('tweet weight and language rules stay available without the Grok workflow', () => {
  assert.equal(tweetWeight('abc'), 3);
  assert.equal(tweetWeight('你好'), 4);
  assert.equal(tweetWeight('a你'), 3);
  assert.equal(tweetWeight(''), 0);
  assert.equal(resolveCommentLanguage('English reply about remote jobs', 'zh'), 'en');
  assert.equal(resolveCommentLanguage('这是一段中文评价', 'en'), 'en');
  assert.equal(resolveCommentLanguage('这是一段中文评价', ''), 'zh');
  assert.equal(resolveCommentLanguage('こんにちはです', ''), 'und');
  assert.equal(resolveCommentLanguage('plain english words here', 'und'), 'en');
  assert.equal(resolveCommentLanguage('短', 'zh-CN'), 'zh');
});

test('parsing and optional suffixes retain the full long quote', () => {
  const settings = {quoteTagsEnabled: true, quoteSelectedTags: ['互关']};
  const tagged = appendQuoteTags('测'.repeat(140), settings, 'zh');
  assert.equal(tagged, '测'.repeat(140));
  assert.equal(extractGrokComment(`【引用评价开始】${'字'.repeat(141)}【引用评价结束】`), '字'.repeat(141));
  const fitted = appendFollowBackSuffix('a'.repeat(280), 'I follow back.', 'en');
  assert.ok(fitted.startsWith('a'.repeat(280)));
  assert.equal(fitted,'a'.repeat(280));
  const longTags = Array.from({length: 10}, (_, i) => `Tag${'X'.repeat(20)}${i}`);
  assert.doesNotThrow(() => validateQuoteTags({
    quoteTagsEnabled: true,
    quoteCustomTags: longTags,
    quoteSelectedTags: longTags
  }));
});

test('weighted budget handles emoji sequences, extended Han, punctuation and URLs', () => {
  assert.equal(tweetWeight('😀'),2);
  assert.equal(tweetWeight('👩‍💻'),2);
  assert.equal(tweetWeight('🇨🇳'),2);
  assert.equal(tweetWeight('𠀀。'),4);
  assert.equal(tweetWeight('e\u0301'),1);
  assert.equal(tweetWeight('https://example.com/a/very/long/path'),23);
  assert.equal(tweetWeight('a'.repeat(279)+'😀'),281);
  const body='😀'.repeat(140);
  assert.equal(appendQuoteTags(body,{quoteTagsEnabled:true},'en'),body);
});
