// Chrome serializes this function; all page helpers must remain inside it.
export async function articleComposerOnPage(owner, payload={}, action='inspect', scopeToken='') {
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
  const viewer=()=>{
    const profileHref=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replaceAll('/','').trim().toLowerCase()||'';
    if(profileHref)return profileHref;
    const switcher=document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"],button[aria-label*="账号菜单"],button[aria-label*="Account menu" i]');
    const m=String(switcher?.innerText||switcher?.textContent||'').match(/@([A-Za-z0-9_]{1,15})\b/);
    return m?m[1].toLowerCase():'';
  };
  const cleanOwner=String(owner||'').replace(/^@/,'').toLowerCase();
  const key='__xfArticleComposerScope';

  if(action==='release'){
    const session=window[key];
    if(session&&(!scopeToken||session.token===scopeToken)){
      session.observer?.disconnect();
      delete window[key];
    }
    return {ok:true,attempted:false};
  }

  const parseDraftId=(url=location.href)=>{
    const m=String(url||'').match(/\/compose\/articles\/edit\/([^/?#]+)/i)||String(url||'').match(/\/articles\/edit\/([^/?#]+)/i);
    return m?m[1]:'';
  };
  const findTitleInput=()=>[...document.querySelectorAll('textarea[placeholder*="标题"],textarea[placeholder*="title" i],textarea[data-testid*="title" i],main textarea')].find(el=>visible(el)&&!el.closest('[role="dialog"]'))||null;
  const findBodyEditor=()=>[...document.querySelectorAll('[contenteditable="true"][data-testid="composer"],[data-testid="composer"].public-DraftEditor-content,[data-testid="composer"][contenteditable="true"]')].find(el=>visible(el)&&!el.closest('[role="dialog"]'))||null;
  const findCoverImages=editor=>{
    const imgs=[...document.querySelectorAll('main img,[data-testid="primaryColumn"] img')];
    return imgs.filter(img=>{
      if(editor&&editor.contains(img))return false;
      if(img.closest('[role="dialog"]'))return false;
      const src=String(img.currentSrc||img.src||'');
      if(!/^https:\/\//i.test(src))return false; // crop previews are blob URLs, not uploaded covers
      if(src.includes('pbs.twimg.com/media/'))img.loading='eager';
      if(src.includes('profile_images')||src.includes('emoji'))return false;
      const w=Number(img.naturalWidth||img.width||0),h=Number(img.naturalHeight||img.height||0);
      return w>=200&&h>=80;
    }).map(img=>{
      const width=Number(img.naturalWidth||img.width||0);
      const height=Number(img.naturalHeight||img.height||0);
      const ratio=height>0?width/height:0;
      return {
        complete:Boolean(img.complete&&width>0&&height>0),
        width,
        height,
        ratio,
        isFiveByTwo:Boolean(img.complete&&width>0&&height>0&&Math.abs(ratio-2.5)<=0.05),
        src:String(img.currentSrc||img.src||'')
      };
    });
  };
  const findTopPublishButton=()=>[...document.querySelectorAll('button,[role="button"]')].find(b=>{
    if(!visible(b)||b.closest('[role="dialog"]'))return false;
    const t=(b.innerText||b.textContent||b.getAttribute('aria-label')||'').trim();
    return /^(发布|Publish)$/i.test(t);
  })||null;
  const isSavingNow=()=>{
    const text=document.body?.innerText||'';
    return /正在保存|Saving\b/i.test(text);
  };
  const hasSavedFeedback=()=>{
    const text=document.body?.innerText||'';
    return /已保存|Saved\b|最后保存|上一次保存/i.test(text);
  };
  const getBodyText=editor=>{
    if(!editor)return '';
    const instance=draftEditor(editor);
    if(instance)return instance._latestEditorState.getCurrentContent().getBlocksAsArray().map(b=>b.getText()).join('\n').trim();
    const blocks=[...editor.querySelectorAll('[data-block="true"]')];
    if(blocks.length)return blocks.map(b=>b.innerText||b.textContent||'').join('\n').trim();
    return (editor.innerText||editor.textContent||'').trim();
  };
  // Reuse the exporter integration's latest Draft instance reader. The DOM can
  // show text that never reached Draft's ContentState or the saved article.
  function draftEditor(editor){
    const fiberKey=Object.keys(editor).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'));
    let fiber=fiberKey&&editor[fiberKey];
    for(let depth=0;fiber&&depth<40;depth++,fiber=fiber.return){if(fiber.stateNode?._latestEditorState)return fiber.stateNode;}
    return null;
  }
  const expectedBody=()=>{
    if(!payload?.html)return String(payload?.body||'').trim();
    const parsed=new DOMParser().parseFromString(payload.html,'text/html');
    return [...parsed.body.querySelectorAll('h1,h2,h3,p,li,blockquote,pre')].map(el=>el.textContent).join('\n').trim();
  };

  if(action==='open_saved'){
    const id=String(payload.expectedDraftId||'');
    if(!id||!/^\d+$/.test(id)||!scopeToken)return {ok:false,reason:'缺少任务草稿标识'};
    const check=checkViewer();if(!check.ok)return check;
    if(parseDraftId()===id&&findTitleInput()&&findBodyEditor())return {ok:true};
    const link=[...document.querySelectorAll('a[href]')].find(a=>a.getAttribute('href')===`/compose/articles/edit/${id}`);
    if(!link)return {ok:false,reason:'草稿列表尚未出现任务文章'};
    link.click();return {ok:false,reason:'正在打开已保存文章'};
  }

  function checkViewer(){
    const v=viewer();
    if(v&&v!==cleanOwner)return {ok:false,reason:'当前登录账号与绑定账号不一致'};
    const session=window[key];
    if(!v&&(!session||session.owner!==cleanOwner))return {ok:false,reason:'未识别到绑定账号登录状态'};
    return {ok:true};
  };

  // Action: create_draft
  // Strictly creates a NEW task-owned draft from /compose/articles without clicking any existing draft row.
  if(action==='create_draft'){
    if(!cleanOwner)return {ok:false,attempted:false,reason:'未指定绑定发帖账号'};
    const v=viewer();
    if(!v)return {ok:false,attempted:false,reason:'尚未识别当前登录账号，未创建文章'};
    if(v!==cleanOwner)return {ok:false,attempted:false,reason:'当前登录账号与绑定账号不一致'};
    if(!/\/compose\/articles/i.test(location.pathname)){
      return {ok:false,attempted:false,reason:'当前不在 X Articles 专栏路由'};
    }
    const existingDraftId=parseDraftId(location.href);
    const titleEl=findTitleInput();
    const editorEl=findBodyEditor();
    if(existingDraftId&&titleEl&&editorEl){
      const curTitle=normalize(titleEl.value);
      const curBody=normalize(getBodyText(editorEl));
      const covers=findCoverImages(editorEl);
      if(curTitle||curBody||covers.length){
        return {ok:false,attempted:false,reason:'当前文章草稿非空，禁止覆盖已有草稿'};
      }
      const token=scopeToken||crypto.randomUUID();
      window[key]={token,owner:cleanOwner,draftId:existingDraftId,draftUrl:location.href,editor:editorEl};
      return {ok:true,attempted:false,scopeToken:token,draftId:existingDraftId,draftUrl:location.href,empty:true};
    }
    // Look ONLY for explicit Create / New Article controls, NEVER click [data-testid="article_draft_row"]
    const createBtn=[...document.querySelectorAll('[aria-label="create"],[aria-label="Create"],[data-testid="empty_state_button_text"],[data-testid="create_article_button"],button,[role="button"],a[href]')].find(el=>{
      if(!visible(el)||el.closest('[data-testid="article_draft_row"]'))return false;
      const label=`${el.getAttribute('aria-label')||''} ${el.getAttribute('data-testid')||''} ${el.innerText||el.textContent||''}`.trim();
      return /^(create|new article|write|create article|撰写|新建|创建|写文章|创建文章)$/i.test(label)
        ||el.getAttribute('aria-label')==='create'
        ||el.getAttribute('data-testid')==='empty_state_button_text';
    });
    if(createBtn){
      createBtn.click();
      for(let i=0;i<25;i++){
        await sleep(250);
        const dId=parseDraftId(location.href);
        const tEl=findTitleInput();
        const eEl=findBodyEditor();
        if(tEl&&eEl){
          const curTitle=normalize(tEl.value);
          const curBody=normalize(getBodyText(eEl));
          const covers=findCoverImages(eEl);
          if(curTitle||curBody||covers.length){
            return {ok:false,attempted:false,reason:'打开的文章草稿包含已有内容，已停止操作以保护用户草稿'};
          }
          const token=scopeToken||crypto.randomUUID();
          const draftUrl=location.href;
          window[key]={token,owner:cleanOwner,draftId:dId||'task-draft',draftUrl,editor:eEl};
          return {ok:true,attempted:false,scopeToken:token,draftId:dId||'task-draft',draftUrl,empty:true};
        }
      }
    }
    return {ok:false,attempted:false,reason:'X Articles 新建草稿入口或编辑器未就绪'};
  }

  const readState=(allowNewSession=false)=>{
    if(!/\/compose\/articles/i.test(location.pathname)&&!/\/articles\/edit\//i.test(location.pathname)){
      return {ok:false,reason:'当前不在 X Articles 编辑器页面'};
    }
    const viewerCheck=checkViewer();
    if(!viewerCheck.ok)return viewerCheck;
    const titleEl=findTitleInput();
    const editorEl=findBodyEditor();
    if(!titleEl||!editorEl)return {ok:false,reason:'X Articles 标题栏或正文编辑器未就绪'};
    const currentDraftId=parseDraftId(location.href);
    let session=window[key];
    if(!session&&allowNewSession){
      session={
        token:scopeToken||crypto.randomUUID(),
        owner:cleanOwner,
        draftId:payload?.expectedDraftId||currentDraftId||'task-draft',
        draftUrl:location.href,
        editor:editorEl
      };
      window[key]=session;
    }
    if(!session)return {ok:false,reason:'未绑定当前任务专属的 X Articles 草稿会话'};
    if(scopeToken&&session.token!==scopeToken)return {ok:false,reason:'X Articles 草稿会话令牌不匹配，已停止操作'};
    if(payload?.expectedDraftId&&currentDraftId&&currentDraftId!==payload.expectedDraftId){
      return {ok:false,reason:'当前草稿 ID 与任务创建的草稿不一致，已停止操作'};
    }
    if(session.draftId&&session.draftId!=='task-draft'&&currentDraftId&&session.draftId!==currentDraftId){
      return {ok:false,reason:'X Articles 草稿路由已切换到其他草稿，已停止操作'};
    }
    if(currentDraftId&&session.draftId==='task-draft'){
      session.draftId=currentDraftId;
      session.draftUrl=location.href;
    }
    const covers=findCoverImages(editorEl);
    const publishBtn=findTopPublishButton();
    const saving=isSavingNow();
    const saved=hasSavedFeedback()&&!saving;
    const ready=Boolean(publishBtn&&!publishBtn.disabled&&publishBtn.getAttribute('aria-disabled')!=='true'&&!saving);
    const currentTitle=titleEl.value||'';
    const currentBody=getBodyText(editorEl);
    return {
      ok:true,
      scopeToken:session.token,
      draftId:session.draftId||currentDraftId,
      draftUrl:location.href,
      titleEl,
      editorEl,
      publishBtn,
      currentTitle,
      currentBody,
      covers,
      saving,
      saved,
      ready,
      empty:!normalize(currentTitle)&&!normalize(currentBody)&&covers.length===0
    };
  };

  if(action==='inspect'){
    const state=readState(Boolean(payload?.allowRebind));
    if(!state.ok)return {...state,attempted:false};
    return {
      ok:true,
      attempted:false,
      scopeToken:state.scopeToken,
      draftId:state.draftId,
      draftUrl:state.draftUrl,
      title:state.currentTitle,
      body:state.currentBody,
      covers:state.covers,
      saving:state.saving,
      saved:state.saved,
      ready:state.ready,
      empty:state.empty
    };
  }

  if(action==='upload_cover'){
    const state=readState(false);
    if(!state.ok)return {...state,attempted:false};
    if(state.covers.length>0)return {ok:false,attempted:false,reason:'当前草稿已有封面图，拒绝覆盖'};
    const cover=payload?.cover;
    if(!cover?.dataUrl||!String(cover.dataUrl).startsWith('data:'))return {ok:false,attempted:false,reason:'缺少有效的封面图数据'};
    const fileInput=[...document.querySelectorAll('input[data-testid="fileInput"],input[type="file"]')].find(el=>!el.closest('[role="dialog"]'))||document.querySelector('input[type="file"]');
    if(!fileInput)return {ok:false,attempted:false,reason:'未找到 X Articles 封面上传文件输入框'};
    let file;
    try{
      const [header,b64]=String(cover.dataUrl).split(',');
      const mime=cover.mimeType||(header.match(/data:([^;]+)/i)?.[1])||'image/png';
      const bin=atob(b64||'');
      if(!bin.length)return {ok:false,attempted:false,reason:'封面图字节内容为空'};
      const bytes=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
      const ext=mime.split('/')[1]||'png';
      file=new File([bytes],`article-cover.${ext}`,{type:mime});
      const dt=new DataTransfer();
      dt.items.add(file);
      fileInput.files=dt.files;
      fileInput.dispatchEvent(new Event('change',{bubbles:true}));
      fileInput.dispatchEvent(new Event('input',{bubbles:true}));
    }catch(err){
      return {ok:false,attempted:false,reason:`封面图注入失败: ${err.message}`};
    }

    // Wait for visible crop / Edit media Apply button if shown, then click it once
    let appliedCrop=false;
    for(let i=0;i<25;i++){
      await sleep(250);
      const applyBtn=[...document.querySelectorAll('[data-testid="applyButton"],[role="dialog"] button')].find(b=>{
        if(!visible(b))return false;
        if(b.getAttribute('data-testid')==='applyButton')return true;
        const t=(b.innerText||b.textContent||b.getAttribute('aria-label')||'').trim();
        return /^(应用|Apply)$/i.test(t);
      });
      if(applyBtn){
        applyBtn.click();
        appliedCrop=true;
        break;
      }
      const cur=readState(false);
      if(cur.ok&&cur.covers.some(c=>c.complete&&c.isFiveByTwo))break;
    }

    for(let i=0;i<30;i++){
      await sleep(300);
      const cur=readState(false);
      if(cur.ok&&cur.covers.length>0){
        const validCover=cur.covers.find(c=>c.complete&&c.isFiveByTwo);
        if(validCover){
          return {
            ok:true,
            attempted:false,
            appliedCrop,
            cover:validCover,
            draftId:cur.draftId,
            draftUrl:cur.draftUrl,
            scopeToken:cur.scopeToken
          };
        }
      }
    }
    const finalState=readState(false);
    const firstCover=finalState.ok?finalState.covers?.[0]:null;
    if(firstCover&&!firstCover.isFiveByTwo){
      return {ok:false,attempted:false,cover:firstCover,reason:`已保存封面图实际尺寸比例异常 (${firstCover.width}x${firstCover.height})，不满足 5:2 要求`};
    }
    return {ok:false,attempted:false,reason:'封面图上传后未在编辑器中加载完成'};
  }

  if(action==='fill'){
    let state=readState(false);
    if(!state.ok)return {...state,attempted:false};
    if(normalize(state.currentTitle)||normalize(state.currentBody)){
      return {ok:false,attempted:false,reason:'X Articles 编辑器已有标题或正文草稿，禁止覆盖'};
    }
    const wantedTitle=String(payload?.title||'').trim();
    const wantedBody=expectedBody();
    if(!wantedTitle||!wantedBody)return {ok:false,attempted:false,reason:'文章标题与正文不能为空'};

    // Fill title via visible textarea focus + standard value/input events
    state.titleEl.focus();
    const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement?.prototype||{},'value')?.set;
    if(setter)setter.call(state.titleEl,wantedTitle);
    else state.titleEl.value=wantedTitle;
    state.titleEl.dispatchEvent(new Event('input',{bubbles:true}));
    state.titleEl.dispatchEvent(new Event('change',{bubbles:true}));
    await sleep(200);

    // The user-provided exporter uses Draft's HTML paste conversion. On a new
    // empty task draft no existing selection/content is replaced.
    state.editorEl.focus();
    if(!draftEditor(state.editorEl))return {ok:false,attempted:false,filled:true,draftUrl:state.draftUrl,reason:'未接上文章编辑器状态，未写入正文'};
    const data=new DataTransfer();
    const html=payload.html||wantedBody.split(/\n\s*\n/).map(p=>'<p>'+p.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</p>').join('');
    data.setData('text/html',html);data.setData('text/plain',wantedBody);
    state.editorEl.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    await sleep(250);
    const insertedViaCommand=false;
    state=readState(false);

    // The existing "last saved" label belongs to the previous title/cover
    // mutation. X debounces body persistence; do not navigate away on that label.
    await sleep(3500);
    // Wait for save completion; the publisher also reopens in a separate tab
    // so an in-flight save is never cancelled by verification navigation.
    for(let i=0;i<30;i++){
      await sleep(300);
      state=readState(false);
      if(!state.ok)break;
      const titleMatch=normalize(state.currentTitle)===normalize(wantedTitle);
      const bodyMatch=normalize(state.currentBody)===normalize(wantedBody);
      if(titleMatch&&bodyMatch&&!state.saving&&state.saved){
        return {
          ok:true,
          attempted:false,
          filled:true,
          insertedViaCommand,
          scopeToken:state.scopeToken,
          draftId:state.draftId,
          draftUrl:state.draftUrl,
          ready:state.ready,
          saved:state.saved
        };
      }
    }
    state=readState(false);
    if(!state.ok)return {...state,attempted:false,filled:true};
    if(normalize(state.currentTitle)!==normalize(wantedTitle)||normalize(state.currentBody)!==normalize(wantedBody)){
      return {ok:false,attempted:false,filled:true,draftUrl:state.draftUrl,reason:'X Articles 标题或正文未能完整写入'};
    }
    if(state.saving||!state.saved){
      return {ok:false,attempted:false,filled:true,draftUrl:state.draftUrl,reason:'X Articles 草稿尚未完成自动保存反馈'};
    }
    return {
      ok:true,
      attempted:false,
      filled:true,
      scopeToken:state.scopeToken,
      draftId:state.draftId,
      draftUrl:state.draftUrl,
      ready:state.ready,
      saved:state.saved
    };
  }

  if(action==='verify_saved'){
    const state=readState(true);
    if(!state.ok)return {...state,attempted:false};
    const wantedTitle=normalize(payload?.title||'');
    const wantedBody=normalize(expectedBody());
    if(normalize(state.currentTitle)!==wantedTitle){
      return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'重载后校验失败：已保存的文章标题不匹配'};
    }
    if(normalize(state.currentBody)!==wantedBody){
      return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'重载后校验失败：已保存的文章正文不完整或不匹配'};
    }
    const validCover=state.covers.find(c=>c.complete&&c.isFiveByTwo);
    if(!validCover){
      return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'重载后校验失败：未检测到已保存的 5:2 封面图'};
    }
    return {
      ok:true,
      attempted:false,
      scopeToken:state.scopeToken,
      draftId:state.draftId,
      draftUrl:state.draftUrl,
      cover:validCover,
      ready:state.ready,
      saved:true
    };
  }

  if(action==='submit'){
    const state=readState(true);
    if(!state.ok)return {...state,attempted:false};
    const wantedTitle=normalize(payload?.title||'');
    const wantedBody=normalize(expectedBody());
    const description=String(payload?.description||'').trim();
    if(!description)return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'X Articles 发布缺少配套短说明（description）'};
    if(normalize(state.currentTitle)!==wantedTitle||normalize(state.currentBody)!==wantedBody){
      return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'发布前校验失败：文章标题或正文已变化'};
    }
    if(!state.covers.some(c=>c.complete&&c.isFiveByTwo)){
      return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'发布前校验失败：5:2 封面图缺失或尺寸异常'};
    }
    if(!state.publishBtn||state.publishBtn.disabled||state.publishBtn.getAttribute('aria-disabled')==='true'||state.saving){
      return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'X Articles 顶栏发布按钮不可用或草稿仍在保存'};
    }

    // Open the publish dialog (still non-public until final Publish inside dialog is clicked)
    const findPublishDialog=()=>[...document.querySelectorAll('[role="dialog"]')].find(d=>{
      const input=d.querySelector('[data-testid="articleTweetTextInput"],textarea,[data-testid="tweetTextarea_0"]');
      return input&&visible(input)&&/发布文章|Publish article|说明文字|Add a post|accompanying/i.test(d.innerText||d.textContent||'');
    });
    let dialog=findPublishDialog();
    if(!dialog)state.publishBtn.click();
    for(let i=0;i<20;i++){
      if(dialog)break;
      await sleep(250);
      dialog=findPublishDialog();
      if(dialog)break;
    }
    if(!dialog)return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'点击顶栏发布后未弹出发布确认与说明窗口'};

    const descInput=dialog.querySelector('textarea')||dialog.querySelector('[data-testid="tweetTextarea_0"][contenteditable="true"],[contenteditable="true"]');
    if(!descInput)return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'发布弹窗中未找到配套短说明输入框'};
    descInput.focus();
    if(descInput.tagName==='TEXTAREA'){
      const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement?.prototype||{},'value')?.set;
      if(setter)setter.call(descInput,description);
      else descInput.value=description;
      descInput.dispatchEvent(new Event('input',{bubbles:true}));
      descInput.dispatchEvent(new Event('change',{bubbles:true}));
    }else{
      if(normalize(descInput.innerText||descInput.textContent))return {ok:false,attempted:false,reason:'发布说明已有内容，未覆盖'};
      document.execCommand?.('insertText',false,description);
    }
    await sleep(250);
    const writtenDesc=normalize(descInput.value??descInput.innerText??descInput.textContent??'');
    if(writtenDesc!==normalize(description)){
      return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'发布弹窗中的配套短说明未能准确写入，未提交发布'};
    }

    const confirmBtn=[...dialog.querySelectorAll('button,[role="button"]')].find(b=>{
      if(!visible(b)||b.disabled||b.getAttribute('aria-disabled')==='true')return false;
      const t=(b.innerText||b.textContent||b.getAttribute('aria-label')||'').trim();
      return /^(发布|Publish)$/i.test(t)||b.getAttribute('data-testid')==='tweetButton';
    });
    if(!confirmBtn)return {ok:false,attempted:false,draftUrl:state.draftUrl,reason:'发布确认弹窗中的最终发布按钮不可用'};
    try{
      confirmBtn.click();
      return {ok:true,attempted:true,draftId:state.draftId,draftUrl:state.draftUrl};
    }catch(err){
      return {ok:false,attempted:true,draftId:state.draftId,draftUrl:state.draftUrl,reason:err.message};
    }
  }

  return {ok:false,attempted:false,reason:`未知操作: ${action}`};
}

export function readArticlePublicationOnPage(owner, article={}, after=0) {
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  const key=String(owner||'').replace(/^@/,'').toLowerCase();
  const viewer=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replaceAll('/','').toLowerCase()||'';
  if(!key||(viewer&&viewer!==key))return null;

  const wantedTitle=normalize(article?.title||'');
  const wantedDesc=normalize(article?.description||'');
  if(!wantedTitle)return null;

  const hasValidCover=root=>{
    const imgs=[...(root?.querySelectorAll?.('img')||[])];
    return imgs.some(img=>{
      const src=String(img.currentSrc||img.src||'');
      if(src.includes('profile_images')||src.includes('emoji'))return false;
      const w=Number(img.naturalWidth||img.width||0);
      const h=Number(img.naturalHeight||img.height||0);
      if(!img.complete||w<=0||h<=0)return false;
      return Math.abs(w/h-2.5)<=0.08&&w>=200;
    });
  };

  // Case 1: Current page directly navigated to a public status or article URL
  if(!/\/compose\/articles/i.test(location.pathname)&&!/\/edit\//i.test(location.pathname)){
    const directMatch=location.pathname.match(/^\/([^/]+)\/(?:status|articles)\/(\d+)/i)||location.pathname.match(/^\/i\/articles\/(\d+)/i);
    if(directMatch){
      const routeOwner=directMatch[2]?directMatch[1].toLowerCase():key;
      const pubId=directMatch[2]||directMatch[1];
      const pageText=normalize(document.body?.innerText||'');
      if(routeOwner===key&&pageText.includes(wantedTitle)&&hasValidCover(document.querySelector('main')||document.body)){
        return {
          id:pubId,
          url:location.href,
          coverVerified:true,
          titleVerified:true
        };
      }
    }
  }

  // Case 2: Profile or timeline article cards
  for(const card of document.querySelectorAll('[data-testid="primaryColumn"] article, main article, article')){
    const time=card.querySelector('time');
    const at=Date.parse(time?.getAttribute('datetime')||'');
    if(Number.isFinite(at)&&after>0&&at<after-10000)continue;
    const cardText=normalize(card.innerText||'');
    const titleEl=card.querySelector('[data-testid="twitter-article-title"]');
    const titleMatch=(titleEl&&normalize(titleEl.innerText)===wantedTitle)||cardText.includes(wantedTitle);
    if(!titleMatch)continue;
    if(wantedDesc&&card.querySelector('[data-testid="tweetText"]')){
      const actualDesc=normalize(card.querySelector('[data-testid="tweetText"]')?.innerText||'');
      if(actualDesc&&!actualDesc.includes(wantedDesc)&&!wantedDesc.includes(actualDesc))continue;
    }
    if(!hasValidCover(card))continue;

    let pubUrl='',pubId='';
    for(const link of card.querySelectorAll('a[href]')){
      let u;try{u=new URL(link.href,location.origin);}catch{continue;}
      const m=u.pathname.match(/^\/([^/]+)\/(?:status|articles)\/(\d+)$/i)||u.pathname.match(/^\/i\/articles\/(\d+)$/i);
      if(m){
        const h=m[2]?m[1].toLowerCase():key;
        const id=m[2]||m[1];
        if(h===key){
          pubUrl=u.href;
          pubId=id;
          if(u.pathname.includes('/status/'))break;
        }
      }
    }
    if(pubId&&pubUrl){
      return {id:pubId,url:pubUrl,coverVerified:true,titleVerified:true};
    }
  }
  return null;
}
