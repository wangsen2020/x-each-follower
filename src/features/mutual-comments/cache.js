// Reuse the existing per-owner Dexie post history; no second cache database.
export const COMMENT_CACHE_TTL=7*24*60*60*1000;
export function normalizedCommentSource(text) {
  return String(text||'').normalize('NFKC').replace(/^(?:\s*@[A-Za-z0-9_]{1,15}\b[\s,:：]*)+/u,'')
    .replace(/\s+/gu,' ').trim().replace(/[。.!！?？,，;；\s]+$/gu,'');
}
export function commentCacheKey(row) {
  const text=normalizedCommentSource(row.text);
  return /^\d+$/.test(String(row.authorId||''))&&text ? JSON.stringify([row.ownerId,String(row.authorId),text]) : null;
}
export function cacheMatch(row,source,now) {
  const key=commentCacheKey(row),at=source.taggedAt;
  return source.postId!==row.postId&&key!==null&&key===commentCacheKey(source)&&
    Number.isFinite(at)&&at<=now&&now-at<=COMMENT_CACHE_TTL;
}
export function findTagCache(row,rows,now) {
  return rows.filter(source=>!source.tagCache&&source.tagBatchId&&['mutual','not_mutual'].includes(source.tag)&&cacheMatch(row,source,now))
    .sort((a,b)=>b.taggedAt-a.taggedAt)[0];
}
export function findReplyCache(row,rows,context,config,now) {
  return rows.filter(source=>cacheMatch(row,source,now)&&!source.replyCache&&source.baseReply&&
    source.tag==='mutual'&&['posted','draft'].includes(source.status)&&!source.decorationIssue&&
    source.provider===config.commentProvider&&(source.botId||'')===(config.commentBotId||'')&&
    JSON.stringify([source.knowledge?.text||'',source.knowledge?.wisdomVersion??null])===JSON.stringify([context.text||'',context.wisdomVersion??null])&&
    // A prior reply naming another recipient must never be carried into this thread.
    !/@[A-Za-z0-9_]/.test(source.baseReply))
    .sort((a,b)=>(b.finishedAt||b.lastAttemptAt||0)-(a.finishedAt||a.lastAttemptAt||0))[0];
}
