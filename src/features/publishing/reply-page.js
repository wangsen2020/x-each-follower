// Chrome serializes this function; all page helpers must remain inside it.
export async function replyComposerOnPage(owner, sourcePostUrl='', text='', action='inspect', scopeToken='') {
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  const viewer=()=>document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replaceAll('/','').toLowerCase();
  const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
  const key='__xfReplyComposerScope';
  if(action==='release'){
    const session=window[key];
    if(session&&(!scopeToken||session.token===scopeToken)){session.observer?.disconnect();delete window[key];}
    return {ok:true,attempted:false};
  }
  const sourceMatch=String(sourcePostUrl||'').match(/\/([^/]+)\/status\/(\d+)/i)||String(sourcePostUrl||'').match(/\/status\/(\d+)/i);
  const sourceId=sourceMatch?(sourceMatch[2]||sourceMatch[1]):'';
  const sourceHandle=sourceMatch&&sourceMatch[2]?sourceMatch[1].replace(/^@/,'').toLowerCase():'';
  if(!sourceId)return {ok:false,attempted:false,reason:'原帖链接缺少有效 Snowflake ID'};

  const read=()=>{
    if(!location.pathname.includes(`/status/${sourceId}`))return {ok:false,reason:'当前页面不是目标原帖详情页'};
    const cleanOwner=String(owner||'').replace(/^@/,'').toLowerCase();
    const v=viewer();
    if(v&&v!==cleanOwner)return {ok:false,reason:'发帖账号与绑定账号不一致'};
    let session=window[key];
    if(!v&&(!session||session.token!==scopeToken||session.owner!==cleanOwner))return {ok:false,reason:'发帖账号与绑定账号不一致'};
    if(scopeToken&&session?.token!==scopeToken)return {ok:false,reason:'回复编辑会话已变化，已停止操作'};
    const visibleDialogs=[...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const hasLink=(el,id)=>[...(el?.querySelectorAll?.('a[href]')||[])].some(a=>{
      try{return new URL(a.href,location.origin).pathname.includes(`/status/${id}`);}catch{return String(a.getAttribute('href')||'').includes(`/status/${id}`);}
    });
    const sourceArticles=[...document.querySelectorAll('[data-testid="primaryColumn"] article, main article, article')].filter(a=>visible(a)&&hasLink(a,sourceId));
    if(sourceArticles.length===0&&visibleDialogs.length===0)return {ok:false,reason:'目标原帖未在详情页就绪'};

    const findScopedComposers=()=>{
      const inputs=[...document.querySelectorAll('[data-testid="tweetTextarea_0"][contenteditable="true"],[data-testid="tweetTextarea_0"] [contenteditable="true"],[data-testid="tweetTextarea_0"]')].filter(el=>visible(el)&&(el.getAttribute('contenteditable')==='true'||el.isContentEditable));
      const uniqInputs=[...new Set(inputs)];
      const candidates=[];
      for(const input of uniqInputs){
        const dialog=input.closest('[role="dialog"]');
        if(dialog){
          if(visibleDialogs.length!==1||visibleDialogs[0]!==dialog)continue;
          const dText=dialog.innerText||'';
          if(/(?:^|\n)[ \t]*(?:quote(?: post)?|引用(?:帖子|推文)?)[ \t]*(?:\n|$)/i.test(dText)||dialog.querySelector('[data-testid="quoteTweet"]'))continue;
          const attached=hasLink(dialog,sourceId)||(!sourceHandle||dText.toLowerCase().includes(`@${sourceHandle}`))&&/replying to\s+@|回复\s*@|回覆\s*@/i.test(dText);
          if(!attached)continue;
          candidates.push({root:dialog,input,isDialog:true});
        }else{
          if(visibleDialogs.length>0)continue;
          const main=input.closest('[data-testid="primaryColumn"]')||input.closest('main')||document.body;
          const container=input.closest('[data-testid="inline_reply_offscreen"]')||input.closest('form')||input.parentElement?.closest('div[ class ]')||main;
          if(container.querySelector?.('[data-testid="quoteTweet"]'))continue;
          if(sourceArticles.length>0&&main.contains(sourceArticles[0])){
            candidates.push({root:container,input,isDialog:false});
          }
        }
      }
      return candidates;
    };

    if(!session){
      let candidates=findScopedComposers();
      if(candidates.length===0&&sourceArticles.length===1&&visibleDialogs.length===0){
        const placeholder=document.querySelector('[data-testid="primaryColumn"] [data-testid="tweetTextarea_0_label"], [data-testid="primaryColumn"] [data-testid="tweetTextarea_0"]');
        if(placeholder&&visible(placeholder)){
          placeholder.click();
          candidates=findScopedComposers();
        }
      }
      if(candidates.length!==1)return {ok:false,reason:candidates.length>1?'检测到多个回复输入框，无法唯一锁定':'回复编辑器未唯一就绪'};
      const chosen=candidates[0];
      session={root:chosen.root,input:chosen.input,isDialog:chosen.isDialog,token:crypto.randomUUID(),mutations:0,owner:cleanOwner,sourceId};
      session.observer=new MutationObserver(()=>{session.mutations++;if(session.input&&!session.input.isConnected)session.invalidated=true;});
      session.observer.observe(session.root,{subtree:true,childList:true,characterData:true,attributes:true});
      window[key]=session;
    }

    const root=session.root;
    if(!root.isConnected||session.invalidated||session.owner!==cleanOwner||session.sourceId!==sourceId){
      return {ok:false,reason:'回复编辑器已关闭或被替换，已停止操作'};
    }
    if(session.isDialog){
      if(visibleDialogs.length!==1||visibleDialogs[0]!==root)return {ok:false,reason:'回复弹窗状态异常或出现其他弹窗'};
    }else if(visibleDialogs.length>0){
      return {ok:false,reason:'出现其他弹窗，已停止回复操作'};
    }
    const currentCandidates=findScopedComposers();
    if(currentCandidates.length!==1||currentCandidates[0].input!==session.input){
      return {ok:false,reason:'回复编辑器输入框已变化或不唯一，已停止操作'};
    }
    const input=session.input;
    const buttonScope=root.querySelector('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]')?root:(input.closest('[role="dialog"]')||input.closest('[data-testid="primaryColumn"]')||document);
    const buttons=[...buttonScope.querySelectorAll('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]')].filter(visible);
    const button=buttons.length===1?buttons[0]:null;
    const current=input.innerText||input.textContent||'';
    return {ok:true,input,root,button,current,scopeToken:session.token,ready:Boolean(button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true')};
  };

  let state=read();
  if(!state.ok)return {...state,attempted:false};
  if(action==='fill'){
    if(normalize(state.current))return {ok:false,attempted:false,reason:'回复编辑器已有草稿，未覆盖'};
    if(!String(text||'').trim())return {ok:false,attempted:false,reason:'回复内容为空'};
    state.input.focus();
    try{
      const data=new DataTransfer();data.setData('text/plain',text);
      state.input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    }catch{}
    await new Promise(r=>setTimeout(r,300));state=read();
    if(state.ok&&!normalize(state.current)){state.input.focus();document.execCommand('insertText',false,text);}
    for(let n=0;n<10;n++){
      await new Promise(r=>setTimeout(r,150));state=read();
      if(state.ok&&normalize(state.current)===normalize(text))break;
    }
    if(!state.ok||normalize(state.current)!==normalize(text))return {ok:false,attempted:false,filled:true,cleanupText:state.current||text,reason:'回复正文未完整写入，未提交'};
    await new Promise(r=>setTimeout(r,400));state=read();
    if(!state.ok||normalize(state.current)!==normalize(text))return {ok:false,attempted:false,filled:true,cleanupText:state?.current||text,reason:'回复编辑区域在填充后变化，未提交'};
    return {ok:true,attempted:false,filled:true,cleanupText:state.current,scopeToken:state.scopeToken,ready:state.ready,textLength:Array.from(state.current).length,reason:state.ready?'回复正文完整，提交按钮可用':'回复正文已保存，提交按钮不可用'};
  }
  if(action==='clear'){
    if(normalize(state.current)!==normalize(text))return {ok:false,attempted:false,reason:'草稿已变化，未清除'};
    state.input.focus();const range=document.createRange();range.selectNodeContents(state.input);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.execCommand('delete');
    return {ok:true,attempted:false};
  }
  if(action==='submit'){
    if(!state.ready||normalize(state.current)!==normalize(text))return {ok:false,attempted:false,reason:'回复内容或提交条件已变化，未提交'};
    try{state.button.click();return {ok:true,attempted:true};}catch(error){return {ok:false,attempted:true,reason:error.message};}
  }
  return {ok:true,attempted:false,scopeToken:state.scopeToken,ready:state.ready,empty:!normalize(state.current),textLength:Array.from(state.current).length};
}

export function readReplyPublicationOnPage(owner, sourcePostUrl, text, after=0) {
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  const key=String(owner||'').replace(/^@/,'').toLowerCase();
  if(!key||document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replaceAll('/','').toLowerCase()!==key)return null;
  const sourceMatch=String(sourcePostUrl||'').match(/\/([^/]+)\/status\/(\d+)/i)||String(sourcePostUrl||'').match(/\/status\/(\d+)/i);
  const sourceId=sourceMatch?(sourceMatch[2]||sourceMatch[1]):'';
  const sourceHandle=sourceMatch&&sourceMatch[2]?sourceMatch[1].replace(/^@/,'').toLowerCase():'';
  if(!sourceId)return null;
  const wanted=normalize(text);
  if(!wanted)return null;

  const articles=[...document.querySelectorAll('[data-testid="primaryColumn"] article, main article, article')];
  const onSourceThread=new RegExp(`/status/${sourceId}(?:/|$)`).test(location.pathname);
  const hasSourceArticle=articles.some(a=>[...a.querySelectorAll('a[href]')].some(link=>{
    try{return new URL(link.href,location.origin).pathname.includes(`/status/${sourceId}`);}catch{return String(link.getAttribute('href')||'').includes(`/status/${sourceId}`);}
  }));

  for(const article of articles){
    const time=article.querySelector('time'),at=Date.parse(time?.getAttribute('datetime')||'');
    const links=[...article.querySelectorAll('a[href]')];
    let statusUrl=null,statusId='',authorHandle='';
    for(const link of links){
      let url;try{url=new URL(link.href,location.origin);}catch{continue;}
      const m=url.pathname.match(/^\/([^/]+)\/status\/(\d+)$/);
      if(m&&m[1].toLowerCase()===key&&m[2]!==sourceId){
        statusUrl=url;statusId=m[2];authorHandle=m[1].toLowerCase();
        if(link.contains(time))break;
      }
    }
    if(!statusUrl||!statusId||authorHandle!==key)continue;
    if(Number.isFinite(at)&&after>0&&at<after-5000)continue;
    if(article.querySelector('[data-testid="quoteTweet"]'))continue;
    const attached=(onSourceThread&&hasSourceArticle)
      ||links.some(a=>new RegExp(`/status/${sourceId}(?:/|$)`).test(String(a.getAttribute('href')||'').split('?')[0]));
    if(!attached)continue;
    const body=article.querySelector('[data-testid="tweetText"]');
    // X renders Unicode emoji as images. Preserve their alt text for exact verification.
    let actualText=body?.innerText||'';
    if(body?.querySelector?.('img[alt]')){
      const read=node=>node.nodeType===3?node.textContent:node.nodeName==='IMG'?node.getAttribute('alt')||'':node.nodeName==='BR'?'\n':Array.from(node.childNodes).map(read).join('');
      actualText=read(body);
    }
    const actual=normalize(actualText);
    if(actual===wanted)return {id:statusId,url:statusUrl.href,textComplete:true,sourcePostId:sourceId};
    const prefix=actual.replace(/(?:…|\.\.\.)$/,'');
    if(article.querySelector('[data-testid="tweet-text-show-more-link"]')&&prefix.length>=40&&wanted.startsWith(prefix)){
      return {id:statusId,url:statusUrl.href,textComplete:false,sourcePostId:sourceId};
    }
  }
  return null;
}
