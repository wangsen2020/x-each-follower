export function originalQualityIssue(quality) {
  const scores=quality?.scores;
  if (!Array.isArray(scores) || scores.length!==4 || scores.some(n=>!Number.isInteger(n)||n<0||n>2)) return '新帖缺少完整质量判断，草稿待复核';
  return scores[0]===2 && scores[1]===2 && scores[2]>=1 && scores[3]>=1 && scores.reduce((a,b)=>a+b,0)>=7
    ? '' : '新帖需要更充分的依据与独立分析，未达到质量门槛';
}
export function originalTextIssue(text, sourceText='') {
  const body=String(text||'').trim();
  if (!body) return '新帖正文为空';
  if (!isPostSafeForComment(body).safe || interactionSkipReason({posts:[{text:body}]})) return '新帖正文未通过现有内容检查，已保留草稿';
  if (Array.from(body).length>25000) return '新帖超过本次支持的 25,000 字符，请人工编辑';
  if (/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s/]+\/status\/\d+/i.test(body)) return '新帖包含原帖链接，可能形成引用卡片；请改为独立正文';
  const compact=s=>String(s||'').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
  const source=compact(sourceText), output=compact(body);
  if (source.length>=40 && output.includes(source)) return '新帖整段重复原文，缺少独立表达';
  return '';
}
import {isPostSafeForComment,interactionSkipReason} from '../relationships/content-risk.js';

