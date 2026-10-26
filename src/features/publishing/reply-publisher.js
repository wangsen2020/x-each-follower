import {replyComposerOnPage,readReplyPublicationOnPage} from './reply-page.js';
import {setQuoteFrameFallbackOnPage} from '../../platform/x/page-reader.js';
import {createTemporaryWindow,closeTemporaryWindow} from '../grok/temporary-windows.js';

function parseSourcePostUrl(sourcePostUrl) {
  const raw=String(sourcePostUrl||'').trim();
  if(!raw)return {ok:false,reason:'原帖链接为空'};
  let parsed;
  try{parsed=new URL(raw,'https://x.com');}catch{return {ok:false,reason:'原帖链接格式无效'};}
  if(!['x.com','twitter.com','www.x.com','www.twitter.com'].includes(parsed.hostname.toLowerCase())){
    return {ok:false,reason:'原帖链接不是有效的 X 状态地址'};
  }
  const match=parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/i)||parsed.pathname.match(/^\/i\/web\/status\/(\d+)/i);
  const id=match?(match[2]||match[1]):'';
  if(!id)return {ok:false,reason:'原帖链接缺少有效 Snowflake ID'};
  const handle=match&&match[2]?match[1]:'i/web';
  return {ok:true,id,url:`https://x.com/${handle}/status/${id}`};
}

export function createReplyPublisher({api=chrome,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,openComposer}={}) {
  const defaultOpen=async targetUrl=>{
    if(api?.tabs?.create&&(!api?.windows?.create||api!==chrome)){
      const tab=await api.tabs.create({url:targetUrl,active:false});
      return {tabId:tab.id,close:()=>api.tabs.remove(tab.id)};
    }
    const win=await createTemporaryWindow({url:targetUrl,type:'popup',focused:false,width:1000,height:800},'reply');
    return {tabId:win.tabs[0].id,close:()=>closeTemporaryWindow(win.id)};
  };
  const open=openComposer||defaultOpen;
  const script=async(tabId,func,args)=>(await api.scripting.executeScript({target:{tabId},func,args}))?.[0]?.result;

  async function verifyOnTab(tabId,{owner,sourcePostUrl,text,after=0,navigateFirst=false}) {
    if(navigateFirst){
      await api.tabs.update(tabId,{url:sourcePostUrl});
    }
    for(let n=0;n<12;n++){
      await sleep(500);
      await api.scripting.executeScript({target:{tabId},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
      const proof=await script(tabId,readReplyPublicationOnPage,[owner,sourcePostUrl,text,after]).catch(()=>null);
      if(proof){
        if(proof.textComplete)return proof;
        await api.tabs.update(tabId,{url:proof.url});
        for(let k=0;k<10;k++){
          await sleep(500);
          await api.scripting.executeScript({target:{tabId},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
          const detail=await script(tabId,readReplyPublicationOnPage,[owner,sourcePostUrl,text,after]).catch(()=>null);
          if(detail?.id===proof.id&&detail.textComplete)return detail;
        }
        return null;
      }
      if(n===5){
        await api.tabs.update(tabId,{url:`https://x.com/${encodeURIComponent(String(owner).replace(/^@/,''))}/with_replies`}).catch(()=>{});
      }
    }
    return null;
  }

  async function verify(options={}) {
    const parsed=parseSourcePostUrl(options.sourcePostUrl);
    if(!parsed.ok)return null;
    const tab=await api.tabs.create({url:parsed.url,active:false});
    try{return await verifyOnTab(tab.id,{...options,sourcePostUrl:parsed.url,navigateFirst:false});}
    finally{await api.tabs.remove(tab.id).catch(()=>{});}
  }

  async function publish({owner,sourcePostUrl,text,canPublish=async()=>true,dryRun=false}={}) {
    const cleanOwner=String(owner||'').replace(/^@/,'').trim();
    if(!cleanOwner)return {ok:false,attempted:false,status:'draft',reason:'未指定绑定发帖账号'};
    const parsed=parseSourcePostUrl(sourcePostUrl);
    if(!parsed.ok)return {ok:false,attempted:false,status:'draft',reason:parsed.reason};
    const body=String(text||'').trim();
    if(!body)return {ok:false,attempted:false,status:'draft',reason:'回复内容为空'};

    const page=await open(parsed.url);
    const tab={id:page.tabId};
    let filled=false,attempted=false,cleanupText=text,scopeToken='';
    try{
      await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',injectImmediately:true,func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
      if(api.tabs?.get)for(let n=0;n<40;n++){
        if((await api.tabs.get(tab.id)).status==='complete')break;
        await sleep(500);
      }
      await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[true]}).catch(()=>{});
      let ready;
      for(let n=0;n<40;n++){
        ready=await script(tab.id,replyComposerOnPage,[cleanOwner,parsed.url,'','inspect']);
        if(ready?.ok)break;
        await sleep(500);
      }
      if(!ready?.ok)return {ok:false,attempted:false,status:'draft',reason:ready?.reason||'回复编辑器未就绪'};
      scopeToken=ready.scopeToken;
      if(!scopeToken)return {ok:false,attempted:false,status:'draft',reason:'未取得唯一回复编辑器会话，已停止操作'};
      if(!await canPublish())return {ok:false,attempted:false,status:'draft',reason:'发布设置或账号已变化'};

      const draft=await script(tab.id,replyComposerOnPage,[cleanOwner,parsed.url,text,'fill',scopeToken]);
      filled=Boolean(draft?.filled);
      cleanupText=draft?.cleanupText??text;
      if(!draft?.ok||!draft.ready)return {ok:false,attempted:false,status:'draft',reason:draft?.reason||'回复正文未就绪'};
      if(dryRun)return {ok:true,attempted:false,status:'draft',ready:true,textLength:draft.textLength,reason:'已验证回复填充与提交条件，未点击发布'};
      if(!await canPublish())return {ok:false,attempted:false,status:'draft',reason:'发布设置或账号已变化'};

      const submittedAt=now();
      attempted=true;
      const result=await script(tab.id,replyComposerOnPage,[cleanOwner,parsed.url,text,'submit',scopeToken]);
      if(result?.attempted===false){
        attempted=false;
        return {ok:false,attempted:false,status:'draft',reason:result.reason||'回复未提交'};
      }
      const proof=await verifyOnTab(tab.id,{owner:cleanOwner,sourcePostUrl:parsed.url,text,after:submittedAt});
      return proof
        ? {ok:true,attempted:true,status:'posted',publishedPostId:proof.id,publishedPostUrl:proof.url}
        : {ok:false,attempted:true,status:'uncertain',reason:'回复已尝试提交，尚未核实发布结果；禁止重复发送'};
    }catch(error){
      return {ok:false,attempted,status:attempted?'uncertain':'draft',reason:error.message};
    }finally{
      if(filled&&!attempted)await script(tab.id,replyComposerOnPage,[cleanOwner,parsed.url,cleanupText,'clear',scopeToken]).catch(()=>{});
      await script(tab.id,replyComposerOnPage,[cleanOwner,parsed.url,'','release',scopeToken]).catch(()=>{});
      await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:setQuoteFrameFallbackOnPage,args:[false]}).catch(()=>{});
      await page.close().catch(()=>{});
    }
  }
  return {publish,verify};
}
