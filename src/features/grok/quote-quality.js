import {tweetWeight} from './quote-text.js';

// An editorial limit protects the model context; it is not X's publishing limit.
export const QUOTE_CONTEXT_LIMIT = 40000;
export function quoteLengthPolicy(mode = 'adaptive') {
  return {version:1, mode:['adaptive','concise','deep'].includes(mode) ? mode : 'adaptive',
    maxDraftCharacters:25000, standardWeightedLimit:280};
}
export function quoteQuality(raw) {
  const text = String(raw || '');
  const match = text.match(/【质量评分[:：]\s*([012])\s*[,，]\s*([012])\s*[,，]\s*([012])\s*[,，]\s*([012])\s*】/);
  const reason = text.match(/【引用价值[:：]([^】]{1,300})】/)?.[1]?.trim() || '';
  if (!match) return {passed:false, reviewRequired:true, reason:'未返回完整质量判断，草稿待复核'};
  const scores = match.slice(1).map(Number);
  const total = scores.reduce((a,b)=>a+b,0);
  return {version:1, scores, total, reason, passed:scores[0]>0 && scores[1]>0 && total>=6};
}
export function quoteDraftIssue(text, policy = quoteLengthPolicy()) {
  if (Array.from(String(text || '')).length > policy.maxDraftCharacters) return '草稿超过 25,000 字符，请人工编辑；未截断或追加模型调用';
  return '';
}
export function quotePublishIssue(text) {
  return tweetWeight(text)>280 ? '长引用能力尚未确认，已保留完整草稿，请人工确认后发布' : '';
}
export function quoteInputComplete(post) {
  return post?.textComplete === true && post?.truncated !== true && post?.requiresContext !== true
    && !/(?:…|\.\.\.)\s*(?:Show more|显示更多|顯示更多|展开|展開)\s*$/i.test(String(post?.text || ''));
}

// Serialized by chrome.scripting: keep this reader self-contained.
export function readQuoteSourceOnPage(url) {
  const id=String(url || '').match(/\/status\/(\d+)/)?.[1];
  if (!id || !location.pathname.includes(`/status/${id}`)) return null;
  const root=document.querySelector('[data-testid="primaryColumn"]');
  const article=[...(root?.querySelectorAll('article') || [])].find(item=>
    [...item.querySelectorAll('a[href]')].some(a=>a.querySelector('time') && new URL(a.href,location.origin).pathname.endsWith(`/status/${id}`)));
  const body=article?.querySelector('[data-testid="tweetText"]');
  if (!body) return null;
  const text=(body.innerText || '').trim();
  return {url,text,textComplete:Boolean(text) && !article.querySelector('[data-testid="tweet-text-show-more-link"]')};
}
