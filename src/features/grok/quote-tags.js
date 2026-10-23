import {tweetWeight,resolveCommentLanguage} from './quote-text.js';

export const RECOMMENDED_QUOTE_TAGS = Object.freeze([
  '互关','互关呀','互关互赞','互关互粉','互关必回','FollowBack','FollowForFollow','MutualFollow','F4F','LetsConnect',
  '蓝V互关','蓝V涨友','蓝V互关互粉','蓝V扩列','蓝V','蓝V涨朋友','蓝V互助朋友',
  'VerifiedFollowBack','BlueCheckCommunity','VerifiedMutuals','LetsGrowTogether','ConnectAndGrow'
]);
export const QUOTE_TAG_DEFAULTS = Object.freeze({quoteTagsEnabled:false,quoteCustomTags:[],quoteSelectedTags:RECOMMENDED_QUOTE_TAGS.slice(0,10)});
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
function eligibleTags(settings, language) {
  const s=normalizeQuoteTags(settings);
  return s.quoteTagsEnabled?s.quoteSelectedTags.filter(t=>!language || (language==='zh' ? /\p{Script=Han}/u.test(t) : language==='und' ? false : !/\p{Script=Han}/u.test(t))):[];
}
export function quoteTagSuffix(settings, language, random = Math.random, previousText = '') {
  const pool=eligibleTags(settings,language);
  const existing=new Set((String(previousText).match(/#[\p{L}\p{M}\p{N}_]+/gu)||[]).map(t=>t.slice(1).toLowerCase()));
  const chosen=[...existing].map(t=>pool.find(p=>p.toLowerCase()===t)).filter(Boolean).slice(0,2);
  const remaining=pool.filter(t=>!chosen.includes(t));
  while(chosen.length<2 && remaining.length) chosen.push(...remaining.splice(Math.floor(random()*remaining.length),1));
  return chosen.map(t=>'#'+t).join(' ');
}
export function validateQuoteTags(settings) {
  const longest=eligibleTags(settings).map(t=>tweetWeight('#'+t)).sort((a,b)=>b-a).slice(0,2);
  if(longest.reduce((a,b)=>a+b,0)+1>180) throw new Error('候选标签过长，请缩短标签，为评价正文保留空间。');
}
export function appendQuoteTags(text, settings, language, {random = Math.random, previousText = text} = {}) {
  const suffix=quoteTagSuffix(settings, language ? resolveCommentLanguage(text,language) : undefined, random, previousText);let base=String(text||'').trim();
  if(!base)return base;
  if(!normalizeQuoteTags(settings).quoteTagsEnabled)return base;
  validateQuoteTags(settings);
  // Remove matching tags before appending, including adjacent hashtags produced by Grok.
  const selected=new Set(normalizeQuoteTags(settings).quoteSelectedTags.map(t=>t.toLowerCase()));
  base=base.replace(/#[\p{L}\p{M}\p{N}_]+/gu,t=>selected.has(t.slice(1).toLowerCase())?'':t).trim();
  if(language && resolveCommentLanguage(base,language)!=='zh') base=base.replace(/[。.!?\s]*(有关必回|关注必回|互关必回)\s*$/u,'').trim();
  if(!suffix)return base;
  let result=base;
  let appended=false;
  for(const tag of suffix.split(' ')) {
    const candidate=result+(appended?' ':'\n\n')+tag;
    if(tweetWeight(candidate)<=280){result=candidate;appended=true;}
  }
  return result;
}
