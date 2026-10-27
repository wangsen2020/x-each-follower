import {requestGrokComment} from '../grok/grok-comment.js';
import {tweetWeight} from '../grok/quote-text.js';
import {originalQualityIssue} from './original-quality.js';
import {buildDirectReplyPrompt} from './reply-prompt.js';
import {buildXArticlePrompt,ARTICLE_DESCRIPTION_MAX_WEIGHT} from './long-article-prompt.js';

export function parseXArticleDraft(text) {
  let value;
  try { value = JSON.parse(String(text).trim()); } catch { throw new Error('文章未返回有效的结构化内容，保留原结果待核对'); }
  for (const key of ['title','body','description','coverPrompt']) {
    if (typeof value?.[key] !== 'string' || !value[key].trim()) throw new Error(`文章缺少${key}，未进入发布流程`);
    value[key] = value[key].trim();
  }
  if (Array.from(value.title).length > 100) throw new Error('文章标题超过100字符，未截断');
  if (Array.from(value.body).length > 25000) throw new Error('文章正文超过生成预算，未截断');
  if (tweetWeight(value.description) > ARTICLE_DESCRIPTION_MAX_WEIGHT) throw new Error('文章发布描述超过X的256加权字符上限，未截断');
  return {title:value.title,body:value.body,description:value.description,coverPrompt:value.coverPrompt};
}

export async function generateDirectReply(handle, posts, name, options = {}) {
  const result = await requestGrokComment(handle, posts, name, {...options,qualityFirst:true,qualityGate:false,promptBuilder:buildDirectReplyPrompt});
  if (!result.ok) return result;
  if (tweetWeight(result.reply) > 280) return {...result,reviewRequired:true,reason:'评论超过280个加权字符，保留草稿待编辑，未截断',publicationMode:'reply'};
  return {...result,publicationMode:'reply'};
}

export async function generateXArticle(handle, posts, name, options = {}) {
  let correction='',lastResult,grokCalls=0;
  for(let attempt=0;attempt<2;attempt++){
    const result = await requestGrokComment(handle, posts, name, {...options,qualityFirst:true,promptBuilder:context=>buildXArticlePrompt(context)+(correction?`\n上一轮未通过发布前检查：${correction}。请重新撰写完整JSON；description使用一句简短说明，不超过180加权字符。正文必须独立分析，不复制素材段落；严格区分材料主张与事实，检查因果和数量关系；没有收益再投入机制时，不把固定奖励加成称为复利。不要为了通过格式检查给原文加标题了事。`:'')});
    grokCalls+=result.grokCalls||1;
    if (!result.ok) return {...result,grokCalls,publicationMode:'article'};
    const issue = originalQualityIssue(result.quality);
    if (issue) return {...result,ok:false,skipped:true,reason:issue,publicationMode:'article'};
    try {
      const article = parseXArticleDraft(result.reply);
      const compact=s=>String(s).replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
      const body=compact(article.body);
      const copied=String(result.postText||'').split(/\n\s*\n/).map(compact).some(paragraph=>paragraph.length>=120&&body.includes(paragraph));
      if(copied)throw new Error('正文整段复制素材，需要独立改写与分析');
      return {...result,grokCalls,article,reply:article.body,publicationMode:'article'};
    } catch (error) {
      correction=error.message;
      lastResult={...result,grokCalls,ok:false,reviewRequired:true,reason:error.message,publicationMode:'article'};
    }
  }
  return lastResult;
}
