import parseTweet from 'twitter-text/dist/parseTweet.js';
// Pure quote text metrics shared by tag rules and the Grok comment workflow.

/** Official weighted length, including emoji sequences, Unicode and URL weights. */
export function tweetWeight(text) {
  return parseTweet(String(text || '')).weightedLength;
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
