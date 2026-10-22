const ID_RE=/^\d+$/;
const HANDLE_RE=/^[A-Za-z0-9_]{1,15}$/;

function count(value){
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return value;
  if(typeof value==='string'&&/^\d+$/.test(value)){
    const number=Number(value);
    if(Number.isSafeInteger(number))return number;
  }
  return null;
}

export function parsePublicProfile(json,capturedAt=Date.now()){
  if(json?.errors?.length)throw new Error(json.errors.map(error=>error.message).filter(Boolean).join('；')||'账号资料查询失败');
  const user=json?.data?.user?.result;
  const id=String(user?.rest_id||'');
  const handle=user?.core?.screen_name||user?.legacy?.screen_name||'';
  if(user?.__typename!=='User'||!ID_RE.test(id)||!HANDLE_RE.test(handle))throw new Error('账号资料缺少稳定用户 ID 或账号名');
  const followers=count(user?.relationship_counts?.followers??user?.legacy?.followers_count);
  return {id,handle,name:user?.core?.name||user?.legacy?.name||handle,avatarUrl:user?.avatar?.image_url||user?.legacy?.profile_image_url_https||'',followers,followersState:followers===null?'unavailable':'explicit',capturedAt};
}

function tweetsFromEntry(entry){
  const content=entry?.content;
  const direct=content?.itemContent?.tweet_results?.result;
  if(direct)return [direct.tweet||direct];
  const tweets=[];
  for(const item of content?.items||[]){
    const tweet=item?.item?.itemContent?.tweet_results?.result;
    if(tweet)tweets.push(tweet.tweet||tweet);
  }
  return tweets;
}

function metric(value){return {value:count(value),state:count(value)===null?'unavailable':'explicit'};}

export function parsePublicTimeline(json,{creatorId,capturedAt=Date.now(),source='UserOriginalsTimeline'}={}){
  if(!ID_RE.test(String(creatorId||'')))throw new Error('目标作者 ID 无效');
  if(json?.errors?.length)throw new Error(json.errors.map(error=>error.message).filter(Boolean).join('；')||'公开帖子查询失败');
  const instructions=json?.data?.user?.result?.timeline?.timeline?.instructions;
  if(!Array.isArray(instructions))throw new Error('公开帖子时间线缺失');
  const entries=instructions.flatMap(instruction=>instruction.entries||[]);
  const posts=new Map();let unavailable=0;
  for(const entry of entries)for(const tweet of tweetsFromEntry(entry)){
    const legacy=tweet.legacy||{},postId=String(tweet.rest_id||'');
    const author=tweet.core?.user_results?.result;
    const authorId=String(author?.rest_id||legacy.user_id_str||'');
    const handle=author?.core?.screen_name||author?.legacy?.screen_name||'';
    const createdAt=Date.parse(legacy.created_at||'');
    if(!ID_RE.test(postId)||authorId!==String(creatorId)||!HANDLE_RE.test(handle)||!Number.isFinite(createdAt)){unavailable++;continue;}
    const views=metric(tweet.views?.count),likes=metric(legacy.favorite_count),replies=metric(legacy.reply_count),reposts=metric(legacy.retweet_count);
    posts.set(postId,{postId,authorId,handle,text:String(legacy.full_text||''),createdAt,
      kind:legacy.in_reply_to_status_id_str?'reply':legacy.retweeted_status_result?'repost':legacy.is_quote_status?'quote':'post',
      url:`https://x.com/${handle}/status/${postId}`,
      metrics:{views:views.value,likes:likes.value,replies:replies.value,reposts:reposts.value},
      metricStates:{views:views.state,likes:likes.state,replies:replies.state,reposts:reposts.state},
      metricBasis:'public-cumulative',source,capturedAt});
  }
  const cursorEntry=entries.find(entry=>entry?.content?.cursorType==='Bottom');
  const cursor=typeof cursorEntry?.content?.value==='string'?cursorEntry.content.value:'';
  return {posts:[...posts.values()].sort((a,b)=>b.createdAt-a.createdAt||b.postId.localeCompare(a.postId)),cursor,hasMore:Boolean(cursor),unavailable,received:posts.size,source,capturedAt};
}
