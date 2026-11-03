const canonical=value=>String(value||'').trim().replace(/^@/,'').toLowerCase();
export function selectQueueScreeningPosts(posts, handle, limit = 10) {
  const cleanHandle = canonical(handle);
  const list = Array.isArray(posts) ? posts : [];
  const selected = [];
  const seen = new Set();
  for (const post of list) {
    if (!post || typeof post !== 'object' || post.isPinned || post.isRetweet || post.isRepost || post.isQuote
      || post.retweeted_status || post.retweetedStatus || post.quoted_status || post.quotedStatus) continue;
    const text = String(post.text || '').trim();
    const url = String(post.url || '').trim();
    const match = url.match(/^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([^/?#]+)\/status\/(\d+)(?:[/?#]|$)/i);
    if (!match || !text || !cleanHandle || canonical(match[1]) !== cleanHandle) continue;
    const author = canonical(post.handle || post.author?.handle || post.author?.screen_name || '');
    if (author && author !== cleanHandle || seen.has(match[2])) continue;
    seen.add(match[2]);
    selected.push(post);
    if (selected.length >= limit) break;
  }
  return selected;
}

