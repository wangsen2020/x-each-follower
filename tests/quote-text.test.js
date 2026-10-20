import test from 'node:test';
import assert from 'node:assert/strict';
import {tweetWeight, resolveCommentLanguage} from '../quote-text.js';
import {tweetWeight as grokWeight, resolveCommentLanguage as grokLanguage, extractGrokComment, appendFollowBackSuffix} from '../grok-comment.js';
import {appendQuoteTags, validateQuoteTags} from '../quote-tags.js';

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

test('quote tags and grok length checks use the shared weight', () => {
  const settings = {quoteTagsEnabled: true, quoteSelectedTags: ['互关']};
  const tagged = appendQuoteTags('测'.repeat(140), settings, 'zh');
  assert.ok(tweetWeight(tagged) <= 280);
  assert.match(tagged, /…\n\n#互关$/);
  assert.equal(extractGrokComment(`【引用评价开始】${'字'.repeat(141)}【引用评价结束】`), '');
  const fitted = appendFollowBackSuffix('a'.repeat(280), 'I follow back.', 'en');
  assert.ok(tweetWeight(fitted) <= 280);
  assert.match(fitted, /I follow back\.$/);
  const longTags = Array.from({length: 10}, (_, i) => `Tag${'X'.repeat(20)}${i}`);
  assert.throws(() => validateQuoteTags({
    quoteTagsEnabled: true,
    quoteCustomTags: longTags,
    quoteSelectedTags: longTags
  }), /已选标签过长/);
});
