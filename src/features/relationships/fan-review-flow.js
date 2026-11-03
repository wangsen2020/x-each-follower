// Business policy shared by automatic admission, manual AI batches and the directory.
export const hasFanReviewEvidence = item => Boolean(String(item?.bio || item?.description || '').trim()
  || item?.posts?.some(post => String(post?.text || '').trim()));
export const needsFanEnrichment = review => review?.state!=='failed' && (review?.state === 'verify'
  || review?.reasonCode === 'missing_biography'
  || review?.decision === 'uncertain' && ['initial-ai-review','manual-ai-analyze'].includes(review.source));
export function evidenceReviewState(review, decision, valid = true) {
  return valid && decision === 'uncertain' ? 'verify' : 'review';
}
export const fanEnrichmentFinished = item => ['ready','partial','empty','unavailable'].includes(item?.information?.posts)
  && Number(item?.information?.postsObservedAt) > 0;

// An unavailable/private timeline or a failed request is not proof of emptiness.
export const fanConfirmedEmpty = item => !hasFanReviewEvidence(item)
  && !item?.posts?.length && !(Number(item?.information?.observedPostCount)>0)
  && item?.information?.posts === 'empty' && Number(item?.information?.postsObservedAt) > 0
  && Number(item?.information?.fieldObservedAt?.bio) > 0;
// A successful bounded collection can finish with zero usable original posts
// while X still supplies a cursor. That is partial, not a pending collection.
export const fanCollectedWithoutEvidence = item => !hasFanReviewEvidence(item)
  && !item?.posts?.length && !(Number(item?.information?.observedPostCount)>0)
  && ['empty','partial','ready'].includes(item?.information?.posts)
  && Number(item?.information?.postsObservedAt) > 0
  && Number(item?.information?.fieldObservedAt?.bio) > 0;
export const EMPTY_FAN_REASON = '补采已结束，仍无可审核的简介和帖子，移除关注者';

// Apply only to identity-validated AI results and the exact submitted input.
// Keep the provider's original verdict for audit; never turn a transport error into approval.
export function normalizeFanVerdict(result,item,rules={}) {
  if(!result || result.valid!==true || !hasFanReviewEvidence(item))return result;
  const sexual=(result.tags||[]).some(tag=>/色情|低俗|擦边|性交易|pornograph|suggestive|sexually explicit/i.test(tag));
  if(sexual&&!rules.blockSuggestive&&!/(宗教|军事|政治|极端|恐怖|诈骗|religio|military|politic|terror|fraud)/i.test((result.tags||[]).join(' ')))return {...result,decision:'pass',originalAiVerdict:result,reason:'擦边拦截已关闭，不以此项移除；'+(result.reason||'')};
  const texts=[item.bio||item.description||'',...(item.posts||[]).map(post=>post.text||'')].map(String);
  const quoted=(result.evidence||[]).some(value=>{
    const quote=String(value).replace(/^(?:post|bio|简介|帖子)\s*[:：]\s*/i,'').trim();
    return quote.length>=4&&texts.some(text=>text.includes(quote));
  });
  if(sexual&&quoted)return {...result,decision:'remove',originalAiVerdict:result,
    reason:'已有色情低俗或擦边内容依据，审核不通过；'+(result.reason||'')};
  if(result.decision!=='uncertain')return result;
  if(sexual)return {...result,valid:false,originalAiVerdict:result,
    reason:'AI 风险结论未提供可对应原文的证据，待重新审核'};
  return {...result,decision:'pass',originalAiVerdict:result,
    reason:'已有简介或帖子，未提供明确不通过依据，按现有资料通过；'+(result.reason||'')};
}
