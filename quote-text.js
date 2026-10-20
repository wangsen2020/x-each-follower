// Pure quote text metrics shared by tag rules and the Grok comment workflow.

/** X 的字数权重：CJK 等宽字符计 2，其余计 1。 */
export function tweetWeight(text) {
  let n = 0;
  for (const ch of String(text || '')) n += /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}

/** Prefer explicit model metadata; legacy drafts only infer scripts with high confidence. */
export function resolveCommentLanguage(text, declared = '') {
  const code = String(declared).trim().toLowerCase().split('-')[0];
  const body = String(text || '').replace(/#[\p{L}\p{M}\p{N}_]+/gu, '').replace(/有关必回|关注必回|互关必回/g, '');
  const han = (body.match(/\p{Script=Han}/gu) || []).length;
  const latin = (body.match(/[a-z]/gi) || []).length;
  if (/^[a-z]{2}$/.test(code) && code !== 'un') {
    // Reject an obviously contradictory Chinese label on an English body.
    if (code === 'zh' && !han && latin > 3) return 'en';
    return code;
  }
  if (han > 0 && han * 2 >= latin) return 'zh';
  if (/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(body)) return 'und';
  if (latin > 3 && !/[^\x00-\x7f]/.test(body.replace(/[’‘“”—–…]/g, ''))) return 'en';
  return 'und';
}
