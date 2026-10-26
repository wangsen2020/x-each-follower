import {standaloneComposerOnPage,readStandalonePublicationOnPage} from './post-page.js';
import {originalTextIssue} from './original-quality.js';
import {setQuoteFrameFallbackOnPage} from '../../platform/x/page-reader.js';
import {createTemporaryWindow,closeTemporaryWindow} from '../grok/temporary-windows.js';

// The publishing feature owns editor access and proof; callers own their queue.
export function createPostPublisher({api=chrome,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,openComposer}={}) {
  const open=openComposer || (async()=>{
    const win=await createTemporaryWindow({url:'https://x.com/compose/post',type:'popup',focused:false,width:1000,height:800},'post');
    return {tabId:win.tabs[0].id,close:()=>closeTemporaryWindow(win.id)};
  });
  const script=async(tabId,func,args)=>(await api.scripting.executeScript({target:{tabId},func,args}))?.[0]?.result;
  async function verifyOnTab(tabId,{owner,text,after=0}) {
    await api.tabs.update(tabId,{url:`https://x.com/${encodeURIComponent(owner)}`});
    for(let n=0;n<12;n++){
      await sleep(500);
      await api.scripting.executeScript({target:{tabId},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
      const proof=await script(tabId,readStandalonePublicationOnPage,[owner,text,after]).catch(()=>null);
      if(!proof)continue;
      if(proof.textComplete)return proof;
      await api.tabs.update(tabId,{url:proof.url});
      for(let k=0;k<10;k++){
        await sleep(500);
        await api.scripting.executeScript({target:{tabId},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
        const detail=await script(tabId,readStandalonePublicationOnPage,[owner,text,after]).catch(()=>null);
        if(detail?.id===proof.id&&detail.textComplete)return detail;
      }
      return null;
    }
    return null;
  }
  async function verify(options) {
    const tab=await api.tabs.create({url:`https://x.com/${encodeURIComponent(options.owner)}`,active:false});
    try{return await verifyOnTab(tab.id,options);}finally{await api.tabs.remove(tab.id).catch(()=>{});}
  }
  async function publish({owner,text,sourceText='',canPublish=async()=>true,dryRun=false}={}) {
    const issue=originalTextIssue(text,sourceText);
    if(issue)return {ok:false,attempted:false,status:'draft',reason:issue};
    const page=await open();
    const tab={id:page.tabId};
    let filled=false,attempted=false,cleanupText=text,scopeToken='';
    try{
      // Install the existing background-frame bridge as early as Chrome allows,
      // before the SPA schedules its initial compose-modal animation frame.
      await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',injectImmediately:true,func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
      if(api.tabs.get)for(let n=0;n<40;n++){
        if((await api.tabs.get(tab.id)).status==='complete')break;
        await sleep(500);
      }
      // Reuse the existing temporary rAF fallback for background X tabs.
      await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]});
      let ready;
      for(let n=0;n<40;n++){
        ready=await script(tab.id,standaloneComposerOnPage,[owner,'','inspect']);
        if(ready?.ok)break;await sleep(500);
      }
      if(!ready?.ok)return {ok:false,attempted:false,status:'draft',reason:ready?.reason||'新帖编辑器未就绪'};
      scopeToken=ready.scopeToken;
      if(!scopeToken)return {ok:false,attempted:false,status:'draft',reason:'未取得唯一发帖弹窗会话，已停止操作'};
      if(!await canPublish())return {ok:false,attempted:false,status:'draft',reason:'发布设置或账号已变化'};
      const draft=await script(tab.id,standaloneComposerOnPage,[owner,text,'fill',scopeToken]);filled=Boolean(draft?.filled);
      cleanupText=draft?.cleanupText ?? text;
      if(!draft?.ok||!draft.ready)return {ok:false,attempted:false,status:'draft',reason:draft?.reason||'新帖正文未就绪'};
      if(dryRun)return {ok:true,attempted:false,status:'draft',ready:true,textLength:draft.textLength,reason:'已验证新帖填充与提交条件，未点击发布'};
      if(!await canPublish())return {ok:false,attempted:false,status:'draft',reason:'发布设置或账号已变化'};
      const submittedAt=now();
      // A lost scripting response may follow a real click; never treat it as unsent.
      attempted=true;
      const result=await script(tab.id,standaloneComposerOnPage,[owner,text,'submit',scopeToken]);
      if(result?.attempted===false){attempted=false;return {ok:false,attempted:false,status:'draft',reason:result.reason};}
      const proof=await verifyOnTab(tab.id,{owner,text,after:submittedAt});
      return proof ? {ok:true,attempted:true,status:'posted',publishedPostId:proof.id,publishedPostUrl:proof.url}
        : {ok:false,attempted:true,status:'uncertain',reason:'新帖已尝试提交，尚未核实发布结果；禁止重复发送'};
    }catch(error){return {ok:false,attempted,status:attempted?'uncertain':'draft',reason:error.message};}
    finally{
      if(filled&&!attempted)await script(tab.id,standaloneComposerOnPage,[owner,cleanupText,'clear',scopeToken]).catch(()=>{});
      await script(tab.id,standaloneComposerOnPage,[owner,'','release',scopeToken]).catch(()=>{});
      await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[false]}).catch(()=>{});
      await page.close().catch(()=>{});
    }
  }
  return {publish,verify};
}
