import {tweetWeight,resolveCommentLanguage} from './grok-comment.js';

export const RECOMMENDED_QUOTE_TAGS = Object.freeze(['互关','互关呀','互关互赞','互关互粉','互关必回','FollowBack','FollowForFollow','MutualFollow','F4F','LetsConnect']);
export const QUOTE_TAG_DEFAULTS = Object.freeze({quoteTagsEnabled:false,quoteCustomTags:[],quoteSelectedTags:[...RECOMMENDED_QUOTE_TAGS]});
export function cleanQuoteTag(value) {
  const tag=String(value || '').normalize('NFC').trim().replace(/^[#＃]+/u,'');
  return /^[\p{L}\p{M}\p{N}_]{1,30}$/u.test(tag) && /[\p{L}_]/u.test(tag) ? tag : '';
}
export function normalizeQuoteTags(raw={}) {
  const unique=values=>{const seen=new Set();return values.map(cleanQuoteTag).filter(t=>t&&!seen.has(t.toLowerCase())&&seen.add(t.toLowerCase()));};
  const custom=unique(Array.isArray(raw.quoteCustomTags)?raw.quoteCustomTags:[]).filter(t=>!RECOMMENDED_QUOTE_TAGS.some(r=>r.toLowerCase()===t.toLowerCase())).slice(0,50);
  const available=[...RECOMMENDED_QUOTE_TAGS,...custom];
  const selected=unique(Array.isArray(raw.quoteSelectedTags)?raw.quoteSelectedTags:[...RECOMMENDED_QUOTE_TAGS]).map(t=>available.find(a=>a.toLowerCase()===t.toLowerCase())).filter(Boolean).slice(0,10);
  return {quoteTagsEnabled:raw.quoteTagsEnabled===true,quoteCustomTags:custom,quoteSelectedTags:selected};
}
export function quoteTagSuffix(settings, language) {
  const s=normalizeQuoteTags(settings);
  return s.quoteTagsEnabled?s.quoteSelectedTags.filter(t=>!language || (language==='zh' ? /\p{Script=Han}/u.test(t) : language==='und' ? false : !/\p{Script=Han}/u.test(t))).map(t=>'#'+t).join(' '):'';
}
export function validateQuoteTags(settings) {
  if(tweetWeight(quoteTagSuffix(settings))>180) throw new Error('已选标签过长，请减少标签，为评价正文保留空间。');
}
export function appendQuoteTags(text, settings, language) {
  const suffix=quoteTagSuffix(settings, language ? resolveCommentLanguage(text,language) : undefined);let base=String(text||'').trim();
  if(!base)return base;
  if(!normalizeQuoteTags(settings).quoteTagsEnabled)return base;
  validateQuoteTags(settings);
  // Remove matching tags before appending, including adjacent hashtags produced by Grok.
  const selected=new Set(normalizeQuoteTags(settings).quoteSelectedTags.map(t=>t.toLowerCase()));
  base=base.replace(/#[\p{L}\p{M}\p{N}_]+/gu,t=>selected.has(t.slice(1).toLowerCase())?'':t).trim();
  if(language && resolveCommentLanguage(base,language)!=='zh') base=base.replace(/[。.!?\s]*(有关必回|关注必回|互关必回)\s*$/u,'').trim();
  if(!suffix)return base;
  const chars=Array.from(base);let shortened=false;
  while(chars.length && tweetWeight(chars.join('')+(shortened?'…':'')+'\n\n'+suffix)>280){chars.pop();shortened=true;}
  return chars.join('').trimEnd()+(shortened?'…':'')+'\n\n'+suffix;
}
