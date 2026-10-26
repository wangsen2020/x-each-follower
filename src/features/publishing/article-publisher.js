import {articleComposerOnPage,readArticlePublicationOnPage} from './article-page.js';
import {articleMarkdown} from './article-markdown.js';
import {setQuoteFrameFallbackOnPage} from '../../platform/x/page-reader.js';
import {createTemporaryWindow,closeTemporaryWindow} from '../grok/temporary-windows.js';
import {tweetWeight} from '../grok/quote-text.js';
import {ARTICLE_DESCRIPTION_MAX_WEIGHT} from './long-article-prompt.js';

export function validateArticleInput(article) {
  if(!article||typeof article!=='object')return {ok:false,reason:'缺少文章参数对象'};
  const title=String(article.title||'').trim();
  if(!title)return {ok:false,reason:'X Articles 标题不能为空'};
  if(Array.from(title).length>100)return {ok:false,reason:'X Articles 标题超过 100 字符上限'};
  const body=String(article.body||'').trim();
  if(!body)return {ok:false,reason:'X Articles 正文不能为空'};
  if(Array.from(body).length>25000)return {ok:false,reason:'X Articles 正文超过 25,000 字符上限'};
  const description=String(article.description||'').trim();
  if(!description)return {ok:false,reason:'X Articles 配套短说明（description）不能为空'};
  if(tweetWeight(description)>ARTICLE_DESCRIPTION_MAX_WEIGHT)return {ok:false,reason:'X Articles 配套短说明超过 256 加权字符上限'};

  const candidates=Array.isArray(article.covers)?article.covers:(article.cover?[article.cover]:[]);
  if(!candidates.length)return {ok:false,reason:'X Articles 必须提供至少一张 5:2 封面图'};
  const validCover=candidates.find(c=>{
    if(!c||typeof c!=='object')return false;
    const width=Number(c.width||0),height=Number(c.height||0);
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return false;
    if(Math.abs(width/height-2.5)>0.01)return false;
    const dataUrl=String(c.dataUrl||'').trim();
    if(!/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(dataUrl))return false;
    const b64=dataUrl.split(',')[1]||'';
    return b64.length>=8;
  });
  if(!validCover){
    return {ok:false,reason:'封面图必须包含有效字节数据且严格满足 5:2 宽高比'};
  }
  return {
    ok:true,
    normalized:{
      title,
      body,
      description,
      cover:{
        dataUrl:String(validCover.dataUrl).trim(),
        mimeType:String(validCover.mimeType||'image/png').trim(),
        width:Number(validCover.width),
        height:Number(validCover.height)
      }
    }
  };
}

export function createArticlePublisher({api=chrome,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,openComposer}={}) {
  const defaultOpen=async()=>{
    const targetUrl='https://x.com/compose/articles';
    if(api?.tabs?.create&&(!api?.windows?.create||api!==chrome)){
      const tab=await api.tabs.create({url:targetUrl,active:false});
      return {tabId:tab.id,close:()=>api.tabs.remove(tab.id)};
    }
    const win=await createTemporaryWindow({url:targetUrl,type:'popup',focused:false,width:1100,height:850},'article');
    return {tabId:win.tabs[0].id,close:()=>closeTemporaryWindow(win.id)};
  };
  const open=openComposer||defaultOpen;
  const script=async(tabId,func,args)=>(await api.scripting.executeScript({target:{tabId},world:'MAIN',func,args}))?.[0]?.result;

  async function waitTabComplete(tabId) {
    if(!api.tabs?.get)return;
    for(let n=0;n<40;n++){
      const info=await api.tabs.get(tabId).catch(()=>null);
      if(info?.status==='complete')break;
      await sleep(500);
    }
  }

  async function verifyOnTab(tabId,{owner,article,after=0}) {
    for(let n=0;n<12;n++){
      await sleep(500);
      await api.scripting.executeScript({target:{tabId},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
      const proof=await script(tabId,readArticlePublicationOnPage,[owner,article,after]).catch(()=>null);
      if(proof?.id&&proof?.url&&proof?.coverVerified)return proof;
      if(n===4){
        await api.tabs.update(tabId,{url:`https://x.com/${encodeURIComponent(String(owner).replace(/^@/,''))}`}).catch(()=>{});
      }
    }
    return null;
  }

  async function verify(options={}) {
    const cleanOwner=String(options.owner||'').replace(/^@/,'').trim();
    if(!cleanOwner)return null;
    const tab=await api.tabs.create({url:`https://x.com/${encodeURIComponent(cleanOwner)}`,active:false});
    try{return await verifyOnTab(tab.id,{...options,owner:cleanOwner});}
    finally{await api.tabs.remove(tab.id).catch(()=>{});}
  }

  async function publish({owner,article,canPublish=async()=>true,dryRun=false}={}) {
    const cleanOwner=String(owner||'').replace(/^@/,'').trim();
    if(!cleanOwner)return {ok:false,attempted:false,status:'draft',reason:'未指定绑定发帖账号'};
    const validation=validateArticleInput(article);
    if(!validation.ok)return {ok:false,attempted:false,status:'draft',reason:validation.reason};
    const normalized=validation.normalized;
    normalized.html=articleMarkdown.toHtml(normalized.body);

    const page=await open();
    const tab={id:page.tabId};
    let attempted=false,scopeToken='',draftId='',draftUrl='',verificationTabId=null,verificationClose=null;
    try{
      await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',injectImmediately:true,func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
      await waitTabComplete(tab.id);
      await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});

      // Step 1: Create or bind a task-owned empty draft on /compose/articles (never reusing preexisting drafts)
      let created;
      for(let n=0;n<40;n++){
        created=await script(tab.id,articleComposerOnPage,[cleanOwner,{},'create_draft',scopeToken]);
        if(created?.ok||created?.reason?.includes('已有')||created?.reason?.includes('不一致'))break;
        await sleep(500);
      }
      if(!created?.ok){
        return {ok:false,attempted:false,status:'draft',reason:created?.reason||'X Articles 新建草稿未就绪'};
      }
      scopeToken=created.scopeToken;
      draftId=created.draftId||'';
      draftUrl=created.draftUrl||'';
      if(!scopeToken)return {ok:false,attempted:false,status:'draft',reason:'未取得唯一 X Articles 草稿会话令牌'};
      if(!await canPublish())return {ok:false,attempted:false,status:'draft', ...(draftUrl?{draftUrl}:{}),reason:'发布设置或账号已变化'};

      // Step 2: Upload 5:2 cover via fileInput + File/DataTransfer and visible Apply
      const coverRes=await script(tab.id,articleComposerOnPage,[cleanOwner,{cover:normalized.cover,expectedDraftId:draftId},'upload_cover',scopeToken]);
      if(coverRes?.draftUrl)draftUrl=coverRes.draftUrl;
      if(coverRes?.draftId)draftId=coverRes.draftId;
      if(!coverRes?.ok){
        return {
          ok:false,
          attempted:false,
          status:'draft',
          ...(draftUrl?{draftUrl}:{}),
          reason:coverRes?.reason||'X Articles 封面图上传或 5:2 校验未通过'
        };
      }

      // Step 3: Fill title and body and wait for saved feedback
      const fillRes=await script(tab.id,articleComposerOnPage,[cleanOwner,{title:normalized.title,body:normalized.body,html:normalized.html,expectedDraftId:draftId},'fill',scopeToken]);
      if(fillRes?.draftUrl)draftUrl=fillRes.draftUrl;
      if(fillRes?.draftId)draftId=fillRes.draftId;
      if(!fillRes?.ok){
        return {
          ok:false,
          attempted:false,
          status:'draft',
          ...(draftUrl?{draftUrl}:{}),
          reason:fillRes?.reason||'X Articles 标题或正文填充及保存未通过'
        };
      }

      // Step 4: Reload ONLY the task-owned draft URL and verify full saved content and actual 5:2 cover dimensions
      if(!draftUrl||!/\/compose\/articles|\/articles\/edit\//i.test(draftUrl)){
        return {ok:false,attempted:false,status:'draft',reason:'未获取到任务专属草稿地址，拒绝重载未知页面'};
      }
      // X's split-view editor can stay blank on a direct edit URL. Reopen the
      // exact task draft from the list using X's own client-side navigation.
      const savedPage=await open();
      verificationTabId=savedPage.tabId;verificationClose=savedPage.close;
      await api.scripting.executeScript({target:{tabId:verificationTabId},world:'MAIN',injectImmediately:true,func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
      await waitTabComplete(verificationTabId);
      await api.scripting.executeScript({target:{tabId:verificationTabId},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});

      let verifiedSaved;
      for(let n=0;n<30;n++){
        await script(verificationTabId,articleComposerOnPage,[cleanOwner,{expectedDraftId:draftId},'open_saved',scopeToken]);
        verifiedSaved=await script(verificationTabId,articleComposerOnPage,[cleanOwner,{
          title:normalized.title,
          body:normalized.body,
          html:normalized.html,
          expectedDraftId:draftId,
          allowRebind:true
        },'verify_saved',scopeToken]);
        if(verifiedSaved?.ok)break;
        await sleep(500);
      }
      if(!verifiedSaved?.ok){
        return {
          ok:false,
          attempted:false,
          status:'draft',
          ...(draftUrl?{draftUrl}:{}),
          reason:verifiedSaved?.reason||'重载草稿后未能核实完整标题、正文或 5:2 封面图'
        };
      }
      draftUrl=verifiedSaved.draftUrl||draftUrl;
      await verificationClose();verificationTabId=null;verificationClose=null;

      // Step 5: Handle dryRun without clicking final Publish
      if(dryRun){
        return {
          ok:true,
          attempted:false,
          status:'draft',
          draftUrl,
          cover:verifiedSaved.cover,
          reason:'已验证 X Articles 草稿落盘、完整正文与 5:2 封面尺寸，未执行最终发布'
        };
      }

      // Step 6: Recheck canPublish immediately before final submit
      if(!await canPublish()){
        return {
          ok:false,
          attempted:false,
          status:'draft',
          ...(draftUrl?{draftUrl}:{}),
          reason:'发布设置或账号已变化，已保留草稿未发布'
        };
      }

      const submittedAt=now();
      attempted=true;
      const submitRes=await script(tab.id,articleComposerOnPage,[cleanOwner,{
        title:normalized.title,
        body:normalized.body,
        description:normalized.description,
        html:normalized.html,
        expectedDraftId:draftId
      },'submit',scopeToken]);
      if(submitRes?.attempted===false){
        attempted=false;
        return {
          ok:false,
          attempted:false,
          status:'draft',
          ...(draftUrl?{draftUrl}:{}),
          reason:submitRes.reason||'X Articles 未执行最终发布点击'
        };
      }

      // Step 7: Verify public URL and saved cover
      const proof=await verifyOnTab(tab.id,{owner:cleanOwner,article:normalized,after:submittedAt});
      if(proof){
        return {
          ok:true,
          attempted:true,
          status:'posted',
          publishedPostId:proof.id,
          publishedPostUrl:proof.url,
          ...(draftUrl?{draftUrl}:{})
        };
      }
      return {
        ok:false,
        attempted:true,
        status:'uncertain',
        ...(draftUrl?{draftUrl}:{}),
        reason:'X Articles 已尝试提交最终发布，尚未核实公开文章链接与封面；禁止重复提交'
      };
    }catch(error){
      return {
        ok:false,
        attempted,
        status:attempted?'uncertain':'draft',
        ...(draftUrl?{draftUrl}:{}),
        reason:error.message
      };
    }finally{
      if(verificationClose)await verificationClose().catch(()=>{});
      await script(tab.id,articleComposerOnPage,[cleanOwner,{},'release',scopeToken]).catch(()=>{});
      await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[false]}).catch(()=>{});
      await page.close().catch(()=>{});
    }
  }

  return {publish,verify};
}
