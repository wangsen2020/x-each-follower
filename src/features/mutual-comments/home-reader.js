import {createXNetworkClient} from '../../platform/x/network-client.js';

export function readHomeSession() {
  return {viewer:document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.split('/')[1]||'',home:location.pathname==='/home',native:window.__xefNativeHome||null};
}

// Only top-level items: a quoted tweet or advertisement is not a candidate.
export function parseHomeTimeline(json) {
  if(json?.errors?.length)throw Error('首页接口返回错误');
  const instructions=json?.data?.home?.home_timeline_urt?.instructions;
  if(!Array.isArray(instructions))throw Error('首页接口结构不可用');
  const entries=instructions.flatMap(i=>i.entries||(i.entry?[i.entry]:[]));
  const posts=new Map();let cursor='';
  for(const entry of entries){
    if(entry.content?.cursorType==='Bottom')cursor=entry.content.value||'';
    const items=entry.content?.items?.map(i=>i.item?.itemContent)||[entry.content?.itemContent];
    for(const item of items){
      if(item?.promotedMetadata)continue;
      const result=item?.tweet_results?.result,tweet=result?.tweet||result,legacy=tweet?.legacy;
      if(!legacy||legacy.retweeted_status_result)continue;
      const author=tweet.core?.user_results?.result,handle=author?.core?.screen_name||author?.legacy?.screen_name;
      const postId=String(tweet.rest_id||''),text=tweet.note_tweet?.note_tweet_results?.result?.text||legacy.full_text;
      if(!/^\d+$/.test(postId)||!/^\w{1,15}$/.test(handle||'')||!text)continue;
      posts.set(postId,{postId,handle,authorId:author.rest_id,text,url:`https://x.com/${handle}/status/${postId}`});
    }
  }
  return {posts:[...posts.values()],cursor};
}

export function createHomeScanner({api,openPage,network=createXNetworkClient(api),sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  return async(account,rounds,{anchor=null,knownIds=[],retiredPostId,checkpoint=async()=>{},canContinue=async()=>{}}={})=>{
    const page=await openPage();
    const collected=new Map(),known=new Set(knownIds),seenCursors=new Set();
    const read=async()=>(await api.scripting.executeScript({target:{tabId:page.tabId},world:'MAIN',func:readHomeSession}))?.[0]?.result;
    const check=async value=>{await canContinue();if(!value?.home||value.viewer?.toLowerCase()!==account.handle.toLowerCase())throw Error('首页登录账号未确认或已变化');};
    try{
      let session;
      for(let i=0;i<60;i++){await sleep(500);session=await read().catch(()=>null);if(session?.viewer&&session?.native)break;}
      await check(session);
      if(!session?.native)throw Error('首页网络响应尚未就绪，请稍后重试');
      const operation=session.native.op;
      // Recommendations are reordered: one old snowflake is not a safe stopping point.
      const boundary=new Set(anchor?.operation===operation?(anchor.postIds||[]):[]);
      let batch=parseHomeTimeline(session.native.json),pages=0,duplicates=0,stopped='page-limit';
      const head=batch.posts.map(p=>p.postId).slice(0,40);
      while(true){
        await check(await read());pages++;
        let fresh=0,hits=0;
        for(const post of batch.posts){
          if(boundary.has(post.postId))hits++;
          if((retiredPostId&&BigInt(post.postId)<=BigInt(retiredPostId))||known.has(post.postId)||collected.has(post.postId)){duplicates++;continue;}
          collected.set(post.postId,post);fresh++;
        }
        await checkpoint({posts:[...collected.values()],anchor:{operation,postIds:head,cursor:batch.cursor,at:Date.now()},pages,duplicates});
        if(!batch.cursor){stopped='end';break;}
        if(hits&&fresh===0){stopped='anchor';break;}
        if(seenCursors.has(batch.cursor)){stopped='repeated-cursor';break;}
        if(pages>=rounds+1)break;
        seenCursors.add(batch.cursor);
        await sleep(1200);await check(await read());
        const response=await network.query(page.tabId,operation,{count:20,cursor:batch.cursor});
        if(response.status!==200)throw Error(response.error||`首页接口请求失败（${response.status}）`);
        batch=parseHomeTimeline(response.json);
      }
      return {posts:[...collected.values()],anchor:{operation,postIds:head,cursor:batch.cursor,at:Date.now()},pages,duplicates,stopped,source:'network'};
    }finally{await page.close().catch(()=>{});}
  };
}
