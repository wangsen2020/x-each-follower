// Chrome serializes this function; all page helpers must remain inside it.
export async function standaloneComposerOnPage(owner, text='', action='inspect', scopeToken='') {
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  const viewer=()=>document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replaceAll('/','').toLowerCase();
  const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
  const key='__xfStandaloneComposerScope';
  if(action==='release'){
    const session=window[key];
    if(session&&(!scopeToken||session.token===scopeToken)){session.observer?.disconnect();delete window[key];}
    return {ok:true,attempted:false};
  }
  const read=()=>{
    if (location.pathname!=='/compose/post') return {ok:false,reason:'当前不是新帖编辑器'};
    if (viewer()!==String(owner).replace(/^@/,'').toLowerCase()) return {ok:false,reason:'发帖账号与绑定账号不一致'};
    let session=window[key];
    if(scopeToken&&session?.token!==scopeToken)return {ok:false,reason:'发帖弹窗会话已变化，已停止操作'};
    if(!session){
      // Only discover dialogs globally. Never search the home input or controls.
      const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(visible);
      if(dialogs.length!==1)return {ok:false,reason:'发帖弹窗未唯一就绪'};
      session={root:dialogs[0],token:crypto.randomUUID(),mutations:0,owner:String(owner).toLowerCase()};
      session.observer=new MutationObserver(()=>{session.mutations++;if(session.input&&!session.input.isConnected)session.invalidated=true;});
      // Observe only this dialog; background timeline mutations are irrelevant.
      session.observer.observe(session.root,{subtree:true,childList:true,characterData:true,attributes:true});
      window[key]=session;
    }
    const root=session.root;
    if(!root.isConnected||session.invalidated||session.owner!==String(owner).toLowerCase())return {ok:false,reason:'发帖弹窗已关闭或替换，已停止操作'};
    if([...document.querySelectorAll('[role="dialog"]')].filter(visible).some(dialog=>dialog!==root))return {ok:false,reason:'出现其他弹窗，已停止发帖操作'};
    const inputs=[...root.querySelectorAll('[data-testid="tweetTextarea_0"][contenteditable="true"]')].filter(el=>visible(el)&&el.closest('[role="dialog"]')===root);
    if (inputs.length!==1) return {ok:false,reason:'新帖编辑器未唯一就绪'};
    const input=inputs[0];
    if(session.input&&session.input!==input)return {ok:false,reason:'发帖弹窗输入框已被替换，已停止操作'};
    session.input=input;
    if(root.querySelector('[data-testid="quoteTweet"],[data-testid="tweet"],[data-testid="replyingTo"]') || /Replying to @|回复 @|回覆 @/i.test(root.innerText)) return {ok:false,reason:'编辑器含引用或回复上下文，已停止新帖发布'};
    const buttons=[...root.querySelectorAll('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]')].filter(visible);
    const button=buttons.length===1?buttons[0]:null;
    const current=input.innerText || input.textContent || '';
    return {ok:true,input,root,button,current,scopeToken:session.token,ready:Boolean(button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true')};
  };
  let state=read();
  if(!state.ok)return {...state,attempted:false};
  if(action==='fill'){
    if(normalize(state.current))return {ok:false,attempted:false,reason:'新帖编辑器已有草稿，未覆盖'};
    if(!String(text).trim())return {ok:false,attempted:false,reason:'新帖正文为空'};
    state.input.focus();
    // Reuse X's paste handler before the native insertion fallback. Draft.js
    // can process execCommand and its beforeinput handler twice on some builds.
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
    if(!state.ok||normalize(state.current)!==normalize(text))return {ok:false,attempted:false,filled:true,cleanupText:state.current,reason:'新帖正文未完整写入，未提交'};
    await new Promise(r=>setTimeout(r,400));state=read();
    if(!state.ok||normalize(state.current)!==normalize(text))return {ok:false,attempted:false,filled:true,reason:'新帖编辑区域在填充后变化，未提交'};
    return {ok:true,attempted:false,filled:true,cleanupText:state.current,scopeToken:state.scopeToken,ready:state.ready,textLength:Array.from(state.current).length,reason:state.ready?'新帖正文完整，提交按钮可用':'新帖正文已保存，提交按钮不可用，可能受篇幅或账号限制'};
  }
  if(action==='clear'){
    if(normalize(state.current)!==normalize(text))return {ok:false,attempted:false,reason:'草稿已变化，未清除'};
    state.input.focus();const range=document.createRange();range.selectNodeContents(state.input);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.execCommand('delete');
    return {ok:true,attempted:false};
  }
  if(action==='submit'){
    if(!state.ready||normalize(state.current)!==normalize(text))return {ok:false,attempted:false,reason:'新帖内容或提交条件已变化，未提交'};
    try{state.button.click();return {ok:true,attempted:true};}catch(error){return {ok:false,attempted:true,reason:error.message};}
  }
  return {ok:true,attempted:false,scopeToken:state.scopeToken,ready:state.ready,empty:!normalize(state.current),textLength:Array.from(state.current).length};
}

export function readStandalonePublicationOnPage(owner,text,after=0) {
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  const key=String(owner).replace(/^@/,'').toLowerCase();
  if(document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replaceAll('/','').toLowerCase()!==key)return null;
  const wanted=normalize(text);
  for(const article of document.querySelectorAll('[data-testid="primaryColumn"] article')){
    const time=article.querySelector('time'),at=Date.parse(time?.getAttribute('datetime')||'');
    const link=time?.closest('a[href]');let url;try{url=new URL(link?.href,location.origin);}catch{continue;}
    const match=url.pathname.match(/^\/([^/]+)\/status\/(\d+)$/);
    if(!match||match[1].toLowerCase()!==key||!Number.isFinite(at)||at<after-2000)continue;
    if(article.querySelector('[data-testid="quoteTweet"],[data-testid="replyingTo"]'))continue;
    const actual=normalize(article.querySelector('[data-testid="tweetText"]')?.innerText);
    if(actual===wanted)return {id:match[2],url:url.href,textComplete:true};
    // Long timeline previews require a second, exact check on the detail page.
    const prefix=actual.replace(/(?:…|\.\.\.)$/,'');
    // Chinese long posts can be collapsed well below 200 code points. Use X's
    // explicit Show more marker instead of an English-length assumption.
    if(article.querySelector('[data-testid="tweet-text-show-more-link"]')&&prefix.length>=40&&wanted.startsWith(prefix))return {id:match[2],url:url.href,textComplete:false};
  }
  return null;
}
