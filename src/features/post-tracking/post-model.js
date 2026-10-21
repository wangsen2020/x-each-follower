import {normalizeLowRules} from './post-rules.js';
export const METRICS = {impressions:'Impressions', likes:'Likes', replies:'Replies', reposts:'Retweets', bookmarks:'Bookmark', follows:'Follows', profileVisits:'ProfileVisits'};
export const ANALYTICS_METRICS = Object.values(METRICS);
export function comparePosts(a, b) {
  return b.createdAt - a.createdAt || (BigInt(b.postId) > BigInt(a.postId) ? 1 : BigInt(b.postId) < BigInt(a.postId) ? -1 : 0);
}
export function analyticsRange(days = 14, now = Date.now()) {
  const to = new Date(now); to.setUTCHours(23,59,59,999);
  const from = new Date(to); from.setUTCDate(from.getUTCDate() - Number(days) + 1); from.setUTCHours(0,0,0,0);
  return {from_time:from.toISOString(), to_time:to.toISOString(), max_results:1000, query_page_size:100, requested_metrics:ANALYTICS_METRICS};
}
export function parseOwnAnalytics(json, capturedAt = Date.now()) {
  if (json?.errors?.length) throw new Error(json.errors.map(e=>e.message).join('；'));
  const user = json?.data?.viewer_v2?.user_results?.result;
  if (user?.__typename !== 'User' || !/^\d+$/.test(user.rest_id || '') || !Array.isArray(user.tweets_results)) throw new Error('分析数据不完整或当前账号无权访问。');
  const owner = {id:user.rest_id, handle:user.core?.screen_name || '', name:user.core?.name || ''};
  const posts = new Map(); const unavailableIds=[]; let unavailable = 0;
  for (const wrapper of user.tweets_results) {
    const item = wrapper.result; const postId = wrapper.rest_id;
    if (!/^\d+$/.test(postId || '') || item?.__typename !== 'Tweet' || !item.details || item.rest_id !== postId || !Number.isFinite(item.details.created_at_ms)) { unavailable++; if(/^\d+$/.test(postId||''))unavailableIds.push(postId);continue; }
    const raw = item.organic_metrics_total;
    const metrics = {}; const metricStates = {};
    for (const [key, type] of Object.entries(METRICS)) {
      const entry = raw?.find(v=>v.metric_type === type);
      const valid = typeof entry?.metric_value === 'number' && Number.isFinite(entry.metric_value) && entry.metric_value >= 0;
      metrics[key] = valid ? entry.metric_value : null;
      metricStates[key] = valid ? 'explicit' : entry && entry.metric_value == null ? 'omitted-as-zero' : 'pending';
      if (metricStates[key] === 'omitted-as-zero') metrics[key] = 0;
    }
    posts.set(postId, {ownerId:owner.id, postId, handle:owner.handle, text:item.details.full_text || '', createdAt:item.details.created_at_ms,
      type:item.reply_to_results ? 'reply' : 'post', metrics, metricStates, capturedAt, availability:'available',metricBasis:'organic-total', url:`https://x.com/${owner.handle}/status/${postId}`});
  }
  return {owner, posts:[...posts.values()].sort(comparePosts), unavailableIds, coverage:{received:user.tweets_results.length, unavailable, truncated:user.tweets_results.length >= 1000}};
}
export function mergePost(previous, incoming) {
  const snapshots = [...(previous?.snapshots || [])];
  const last = snapshots.at(-1);
  // Retain at least hourly evidence; manual refresh must not evict the 48h baseline.
  if (!last || incoming.capturedAt - last.at >= 3600000) snapshots.push({at:incoming.capturedAt, metrics:incoming.metrics, states:incoming.metricStates});
  const current = {at:incoming.capturedAt, metrics:incoming.metrics, states:incoming.metricStates};
  return {...previous, ...incoming, protected:previous?.protected === true, review:previous?.text === incoming.text ? previous.review : null, grokReview:previous?.text === incoming.text ? previous.grokReview : null,
    deletion:previous?.deletion, snapshots:snapshots.slice(-336), current};
}
export function dueReviewPosts(posts, refreshedIds, now=Date.now()) {
  return posts.filter(p=>p.source?.kind==='auto-quote'&&!p.protected&&!p.deletion&&!refreshedIds.has(p.postId)&&now-p.createdAt>=7*86400000&&now-p.createdAt<=90*86400000&&now-p.capturedAt>=86400000);
}
export function evaluatePost(post, peers = [], now = Date.now(), context, rules) {
  const thresholds=normalizeLowRules(rules);
  const age = now - post.createdAt;
  const contentScore = post.grokReview?.keep===true ? post.grokReview.score : null;
  if(post.availability==='unavailable')return {contentScore,performance:'unknown',low:false,high:false,deleteSuggested:false,reason:'当前分析数据不可用，保留历史，需重新核实',delta:null,sampleSize:0};
  const sample = peers.filter(p=>p.createdAt >= now-30*86400000 && p.type === post.type && p.availability!=='unavailable' && (!p.deletion || p.deletion.status==='failed') && Math.abs((p.capturedAt-p.createdAt) - (post.capturedAt-post.createdAt)) <= 86400000 && p.metricStates.impressions === 'explicit').map(p=>p.metrics.impressions).sort((a,b)=>a-b);
  let performance = 'unknown'; let reason = '指标未匹配低价值条件';
  if (sample.length >= 20 && age >= 86400000 && post.metricStates.impressions === 'explicit') {
    const median = (sample[Math.floor((sample.length-1)/2)] + sample[Math.floor(sample.length/2)])/2;
    if (post.metrics.impressions >= sample[Math.floor(sample.length*.8)] && post.metrics.impressions > 0) performance = 'high';
    else if (sample.length >= thresholds.sampleMin && post.metrics.impressions < median*thresholds.medianPercent/100 && post.metrics.impressions <= sample[Math.floor(sample.length*thresholds.lowPercentile/100)]) performance = 'low';
    else performance = 'normal';
  }
  const old = [...(post.snapshots || [])].reverse().find(s=>post.capturedAt-s.at >= thresholds.stagnantHours*3600000);
  const delta = old && old.states.impressions === 'explicit' && post.metricStates.impressions === 'explicit' ? post.metrics.impressions-old.metrics.impressions : null;
  const stagnant = delta !== null && delta >= 0 && delta <= Math.max(thresholds.stagnantAbsolute,old.metrics.impressions*thresholds.stagnantPercent/100);
  const low = !post.protected && !post.retained && age >= thresholds.matureHours*3600000 && performance==='low';
  reason=post.protected?'已保护保留':post.retained?'已保留':low?'指标匹配低价值候选':performance==='unknown'?'指标样本不足，暂不判定低价值':'指标未匹配低价值条件';
  return {contentScore,performance,low,high:performance==='high',deleteSuggested:false,reason,delta,stagnant,sampleSize:sample.length};
}
export function selectPostPage(posts, {view='latest', search='', sort='date', direction='desc', type='all', page=1, pageSize=20, days=14, onlyMonitored=false} = {}, now=Date.now(), rules) {
  const sorted = [...posts].filter(p=>p.deletion?.status !== 'verified').sort(comparePosts);
  const monitored = new Set(sorted.filter(p=>p.availability!=='unavailable'&&(!p.deletion || p.deletion.status==='failed')).slice(0,30).map(p=>p.postId));
  let rows = sorted.map(p=>({...p, monitored:monitored.has(p.postId), evaluation:evaluatePost(p, sorted, now,undefined,rules)})).filter(p=>now-p.createdAt <= days*86400000 && (!onlyMonitored || p.monitored) && (type==='all' || (type==='auto-quote'?p.source?.kind==='auto-quote':p.type===type)) && (!search || p.text.toLowerCase().includes(search.toLowerCase()) || p.postId.includes(search)));
  const counts = {latest:rows.length, low:rows.filter(p=>p.evaluation.low).length, high:rows.filter(p=>p.evaluation.high).length};
  if (view === 'low') rows=rows.filter(p=>p.evaluation.low);
  if (view === 'high') rows=rows.filter(p=>p.evaluation.high);
  rows.sort((a,b)=> {
    if (sort==='date') return direction==='desc' ? comparePosts(a,b) : comparePosts(b,a);
    const av=a.availability==='unavailable'?null:a.metrics[sort], bv=b.availability==='unavailable'?null:b.metrics[sort];
    if (av == null || bv == null) return av == null ? (bv == null ? comparePosts(a,b) : 1) : -1;
    return (direction==='desc' ? bv-av : av-bv) || comparePosts(a,b);
  });
  const size=Math.min(100,Math.max(1,Number(pageSize)||20));
  const pages=Math.max(1,Math.ceil(rows.length/size)); const actual=Math.min(pages,Math.max(1,Number(page)||1));
  return {rows:rows.slice((actual-1)*size,actual*size), counts, total:rows.length, page:actual, pages, monitored:monitored.size};
}
