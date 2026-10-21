import test from 'node:test';
import assert from 'node:assert/strict';
import {appendQuoteTags,normalizeQuoteTags,cleanQuoteTag,RECOMMENDED_QUOTE_TAGS} from '../src/features/grok/quote-tags.js';
import {tweetWeight} from '../src/features/grok/grok-comment.js';
test('quote tags default off, enabling chooses ten spaced recommendations',()=>{
 assert.equal(appendQuoteTags('正文',{}),'正文');
 const s={quoteTagsEnabled:true};const text=appendQuoteTags('正文',s);
 assert.ok(text.endsWith(RECOMMENDED_QUOTE_TAGS.map(t=>'#'+t).join(' ')));
 assert.equal(appendQuoteTags(text,s),text);
 assert.equal(appendQuoteTags('',s),'');
});
test('custom multilingual tags validate, deduplicate, select and remove',()=>{
 assert.equal(cleanQuoteTag('#SíguemeYTeSigo'),'SíguemeYTeSigo');
 assert.equal(cleanQuoteTag('bad tag'),'');assert.equal(cleanQuoteTag('<script>'),'');
 const raw={quoteTagsEnabled:true,quoteCustomTags:['SíguemeYTeSigo','Amigos','amigos'],quoteSelectedTags:['Amigos','SíguemeYTeSigo']};
 assert.equal(normalizeQuoteTags(raw).quoteCustomTags.length,2);
 assert.equal(appendQuoteTags('Hola',raw),'Hola\n\n#Amigos #SíguemeYTeSigo');
 raw.quoteCustomTags=['Amigos'];assert.deepEqual(normalizeQuoteTags(raw).quoteSelectedTags,['Amigos']);
});
test('selected tags are spaced without shortening the original quote',()=>{
 const settings={quoteTagsEnabled:true};
 assert.equal(appendQuoteTags('好 #互关#互关呀',settings).match(/#互关(?=\s|$)/gu).length,1);
 const text=appendQuoteTags('测'.repeat(140),settings);
 assert.equal(text,'测'.repeat(140));
 const shorter=appendQuoteTags('测'.repeat(130),settings);
 assert.ok(shorter.startsWith('测'.repeat(130)+'\n\n#互关'));
 assert.ok(tweetWeight(shorter)<=280);
});
