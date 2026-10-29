import {requestGrokComment} from '../grok/grok-comment.js';
import {originalQualityIssue,originalTextIssue} from './original-quality.js';
import {buildOriginalArticlePrompt} from './article-prompt.js';

export async function generateOriginalPost(handle,posts,name,options={}) {
  const result=await requestGrokComment(handle,posts,name,{...options,qualityFirst:true,knowledgePurpose:'article',promptBuilder:buildOriginalArticlePrompt});
  if (!result.ok) return result;
  const issue=originalQualityIssue(result.quality) || originalTextIssue(result.reply,result.post?.text);
  if (issue) return {...result,ok:false,skipped:true,reply:'',reasonCode:'original_quality_skip',reason:issue};
  return {...result,publicationMode:'original'};
}
