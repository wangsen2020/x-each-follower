import {createXNetworkClient} from '../../platform/x/network-client.js';
import {parsePublicTimeline} from '../../platform/x/public-data.js';

// Reuse the public timeline parser; only adapt pin identity, bookmarks and
// expanded note text needed by the queue. Never change missing metrics to zero.
export function parseScoredPosts(json,{userId,handle}={}) {
  const parsed=parsePublicTimeline(json,{creatorId:userId});
  const instructions=json?.data?.user?.result?.timeline?.timeline?.instructions || [];
  const pinnedIds=new Set();
  for(const instruction of instructions)if(instruction.type==='TimelinePinEntry') {
    const id=instruction.entry?.entryId?.match(/tweet-(\d+)$/)?.[1];if(id)pinnedIds.add(id);
  }
  const originals=new Map();
  const walk=value=>{
    if(!value||typeof value!=='object')return;
    if(value.rest_id&&value.legacy?.full_text!==undefined)originals.set(String(value.rest_id),value);
    for(const child of Object.values(value))if(child&&typeof child==='object')walk(child);
  };
  walk(json);
  const posts=parsed.posts.filter(post=>!pinnedIds.has(post.postId)&&post.handle.toLowerCase()===handle.toLowerCase()).map(post=>{
    const raw=originals.get(post.postId),legacy=raw?.legacy||{};
    const note=raw?.note_tweet?.note_tweet_results?.result?.text;
    const bookmarks=legacy.bookmark_count;
    return {...post,isPinned:false,text:note||post.text,textComplete:Boolean(note)||legacy.truncated===false,
      replyCount:post.metrics.replies,repostCount:post.metrics.reposts,likeCount:post.metrics.likes,
      bookmarkCount:Number.isSafeInteger(bookmarks)&&bookmarks>=0?bookmarks:null};
  });
  return {...parsed,posts,pinnedIds:[...pinnedIds]};
}

export async function readScoredPosts({api,tabId,userId,handle,guard=async()=>{}}) {
  if(!/^\d+$/.test(String(userId||'')))return null;
  const templates=(await api.storage.local.get('networkTemplates')).networkTemplates||{};
  if(!templates.UserOriginalsTimeline)return null;
  const client=createXNetworkClient(api),posts=new Map(),pins=new Set();let cursor='';
  for(let page=0;page<3;page++) {
    await guard();
    const response=await client.userOriginals(tabId,userId,{count:40,includePromotedContent:false,...(cursor?{cursor}:{})});
    if(response.status!==200||response.error)throw Object.assign(new Error(response.error||'公开时间线读取失败'),{status:response.status});
    const parsed=parseScoredPosts(response.json,{userId,handle});
    for(const id of parsed.pinnedIds)pins.add(id);
    for(const post of parsed.posts)if(!pins.has(post.postId)&&!posts.has(post.postId))posts.set(post.postId,post);
    for(const id of pins)posts.delete(id);
    if(posts.size>=20||!parsed.cursor||parsed.cursor===cursor)break;
    cursor=parsed.cursor;
  }
  return {posts:[...posts.values()].slice(0,20),pinnedIds:[...pins],source:'UserOriginalsTimeline'};
}
