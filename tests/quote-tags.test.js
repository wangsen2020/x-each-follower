import test from 'node:test';
import assert from 'node:assert/strict';
import {appendQuoteTags,normalizeQuoteTags,cleanQuoteTag,RECOMMENDED_QUOTE_TAGS} from '../src/features/grok/quote-tags.js';
import {tweetWeight} from '../src/features/grok/grok-comment.js';
test('expanded recommendations remain selectable by language without changing saved selections',()=>{
 const chinese=['蓝V互关','蓝V涨友','蓝V互关互粉','蓝V扩列','蓝V','蓝V涨朋友','蓝V互助朋友'];
 const english=['VerifiedFollowBack','BlueCheckCommunity','VerifiedMutuals','LetsGrowTogether','ConnectAndGrow'];
 for(const tag of [...chinese,...english]) {
  assert.ok(RECOMMENDED_QUOTE_TAGS.includes(tag));
  assert.equal(cleanQuoteTag(tag),tag);
 }
 assert.equal(new Set(RECOMMENDED_QUOTE_TAGS.map(t=>t.toLowerCase())).size,RECOMMENDED_QUOTE_TAGS.length);
 const settings={quoteTagsEnabled:true,quoteSelectedTags:[chinese[0],chinese[1],english[0],english[1]]};
 assert.deepEqual(normalizeQuoteTags(settings).quoteSelectedTags,settings.quoteSelectedTags);
 assert.equal(appendQuoteTags('中文观点',settings,'zh',{random:()=>0}),'中文观点\n\n#蓝V互关 #蓝V涨友');
 assert.equal(appendQuoteTags('Useful perspective.',settings,'en',{random:()=>0}),'Useful perspective.\n\n#VerifiedFollowBack #BlueCheckCommunity');
 assert.deepEqual(normalizeQuoteTags({}).quoteSelectedTags,RECOMMENDED_QUOTE_TAGS.slice(0,10));
});
test('quote tags default off, enabling samples two distinct recommendations',()=>{
 assert.equal(appendQuoteTags('正文',{}),'正文');
 const s={quoteTagsEnabled:true};const text=appendQuoteTags('正文',s);
 assert.equal((text.match(/#[\p{L}\p{N}_]+/gu)||[]).length,2);
 assert.equal(appendQuoteTags(text,s),text);
 assert.equal(appendQuoteTags('',s),'');
});
test('custom multilingual tags validate, deduplicate, select and remove',()=>{
 assert.equal(cleanQuoteTag('#SíguemeYTeSigo'),'SíguemeYTeSigo');
 assert.equal(cleanQuoteTag('bad tag'),'');assert.equal(cleanQuoteTag('<script>'),'');
 const raw={quoteTagsEnabled:true,quoteCustomTags:['SíguemeYTeSigo','Amigos','amigos'],quoteSelectedTags:['Amigos','SíguemeYTeSigo']};
 assert.equal(normalizeQuoteTags(raw).quoteCustomTags.length,2);
 assert.equal(appendQuoteTags('Hola',raw,undefined,{random:()=>0}),'Hola\n\n#Amigos #SíguemeYTeSigo');
 raw.quoteCustomTags=['Amigos'];assert.deepEqual(normalizeQuoteTags(raw).quoteSelectedTags,['Amigos']);
});
test('selected tags are spaced without shortening the original quote',()=>{
 const settings={quoteTagsEnabled:true,quoteSelectedTags:['互关','互关呀']};
 assert.equal(appendQuoteTags('好 #互关#互关呀',settings).match(/#互关(?=\s|$)/gu).length,1);
 const text=appendQuoteTags('测'.repeat(140),settings);
 assert.equal(text,'测'.repeat(140));
 const shorter=appendQuoteTags('测'.repeat(130),settings,undefined,{random:()=>0});
 assert.ok(shorter.startsWith('测'.repeat(130)+'\n\n#互关'));
 assert.ok(tweetWeight(shorter)<=280);
});

test('random selection varies, preserves topical tags and reuses a draft selection',()=>{
 const settings={quoteTagsEnabled:true};
 const first=appendQuoteTags('观点 #人工智能',settings,'zh',{random:()=>0});
 const last=appendQuoteTags('观点 #人工智能',settings,'zh',{random:()=>0.999});
 assert.notEqual(first,last);
 assert.ok(first.includes('#人工智能'));
 assert.equal((first.match(/#/g)||[]).length,3);
 assert.equal(appendQuoteTags(first,settings,'zh',{random:()=>0.999}),first);
 assert.equal(appendQuoteTags('观点 #人工智能',settings,'zh',{previousText:last,random:()=>0}),last);
 assert.equal(appendQuoteTags('观点',{quoteTagsEnabled:true,quoteSelectedTags:[]},'zh'),'观点');
});
