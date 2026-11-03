// Account-scoped user preferences; absent legacy fields intentionally default off.
export const normalizeFanRemovalRules = (value = {}) => ({
  blockSuggestive: value?.blockSuggestive === true,
  blockEmpty: value?.blockEmpty === true
});
const sexual = /色情|低俗|擦边|性交易|pornograph|suggestive|sexually explicit/i;
const other = /宗教|军事|政治|极端|恐怖|诈骗|religio|military|politic|terror|fraud/i;
export function disabledFanRemoval(review = {}, rules = {}) {
  if (review.source === 'manual-remove') return false;
  const text = [...(review.tags || []), review.reason || ''].join(' ');
  if (other.test(text)) return false;
  if (!rules.blockEmpty && /补采已结束，仍无可审核|empty-profile-rejection/.test(text + ' ' + review.source)) return true;
  return !rules.blockSuggestive && sexual.test(text);
}
