import {driveGrokInput,setGrokFrameFallbackOnPage} from '../grok/grok-comment.js';
import {cloudflareCoverService} from './cloudflare-cover.js';

export async function generateArticleCover(options,{grok=generateGrokCover,cloudflare=cloudflareCoverService}={}) {
  let primary;
  try{primary=await grok(options);}
  catch(error){primary={ok:false,blocked:error.name==='AbortError',reason:error.message};}
  if(primary.ok||primary.blocked)return primary;
  if(options.canGenerate&&!await options.canGenerate())return {...primary,blocked:true,reason:'创作设置或账号已变化，未使用备用配图'};
  if(!(await cloudflare.status()).connected)return primary;
  const fallback=await cloudflare.generate(options);
  if(!fallback.ok)return {...fallback,reason:`Grok：${primary.reason||'未出图'}；Cloudflare兜底：${fallback.reason||'未出图'}`};
  return {...fallback,cover:{...fallback.cover,fallbackFrom:'x.com/grok',fallbackReason:primary.reason||'Grok未出图'}};
}

// Serialized page functions operate only on a new, task-owned Grok tab.
export function readGrokCoverStateOnPage(previousSources = []) {
  const viewer=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replaceAll('/','');
  const images=[...document.images];
  const text=document.body?.innerText||'';
  const quotaExhausted=/you have reached a grok usage limit|you(?:'ve| have) reached.{0,50}(?:limit|quota)|已达到.{0,20}(?:使用|次数|额度).{0,10}(?:限制|上限)|额度.{0,10}(?:耗尽|用尽)/i.test(text);
  const generated=images.find(img=>img.complete&&img.naturalWidth>=512&&img.naturalHeight>=256
    && !previousSources.includes(img.currentSrc||img.src) && !/profile_images|emoji/.test(img.currentSrc||img.src));
  return {viewer,quotaExhausted,sources:images.map(img=>img.currentSrc||img.src),image:generated?{src:generated.currentSrc||generated.src,width:generated.naturalWidth,height:generated.naturalHeight}:null};
}

export async function encodeGrokCoverOnPage(source) {
  const response=await fetch(source);
  if(!response.ok)throw new Error('Grok图片读取失败');
  const blob=await response.blob();
  if(!blob.type.startsWith('image/'))throw new Error('Grok返回的不是图片');
  const bitmap=await createImageBitmap(blob);
  // Normalize the generated artwork to an exact 5:2 cover without stretching.
  const height=Math.floor(Math.min(bitmap.height,bitmap.width/2.5)/2)*2;
  const width=height*2.5;
  if(height<128){bitmap.close();throw new Error('Grok图片尺寸不足');}
  const cropWidth=Math.min(bitmap.width,bitmap.height*2.5),cropHeight=cropWidth/2.5;
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  canvas.getContext('2d').drawImage(bitmap,(bitmap.width-cropWidth)/2,(bitmap.height-cropHeight)/2,cropWidth,cropHeight,0,0,width,height);
  bitmap.close();
  return {dataUrl:canvas.toDataURL('image/png'),mimeType:'image/png',width,height,provider:'x.com/grok'};
}

export async function generateGrokCover({owner,prompt,title='',api=chrome,sleep=ms=>new Promise(r=>setTimeout(r,ms)),canGenerate=async()=>true}={}) {
  if(!String(prompt||'').trim())return {ok:false,attempted:false,reason:'缺少Grok封面提示词'};
  const tab=await api.tabs.create({url:'https://x.com/i/grok',active:false});
  let attempted=false;
  const run=async(func,args=[])=>(await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func,args}))?.[0]?.result;
  try{
    for(let n=0;n<60;n++){if((await api.tabs.get(tab.id)).status==='complete')break;await sleep(500);}
    await run(setGrokFrameFallbackOnPage,[true]);
    let baseline;
    for(let n=0;n<30;n++){
      baseline=await run(readGrokCoverStateOnPage);
      if(baseline?.viewer)break;
      await sleep(500);
    }
    if(baseline?.viewer?.toLowerCase()!==String(owner||'').replace(/^@/,'').toLowerCase())return {ok:false,attempted:false,blocked:true,reason:'Grok配图账号与绑定账号不一致'};
    if(baseline.quotaExhausted)return {ok:false,attempted:false,quotaExhausted:true,reason:'Grok配图额度已用尽，未提交绘图请求'};
    if(!await canGenerate())return {ok:false,attempted:false,blocked:true,reason:'创作设置或账号已变化，未生成封面'};
    attempted=true;
    const input=await run(driveGrokInput,[`Generate an image, not a text explanation. Create one polished editorial poster in a 5:2 landscape aspect ratio.\n${prompt}\nInclude a short, legible headline based on this article title: ${JSON.stringify(title)}. Use the article's language, strong typography and a clear hierarchy. Keep all lettering and the focal subject inside the central horizontal band, with generous side margins, so a 5:2 center crop preserves them. These typography requirements override any earlier no-text instruction. No hashtags, watermarks, invented statistics or logos.`]);
    if(!input?.ok)return {ok:false,attempted:true,reason:input?.reason||'Grok绘图请求未确认，禁止自动重复请求'};
    for(let n=0;n<90;n++){
      await sleep(2000);
      const state=await run(readGrokCoverStateOnPage,[baseline.sources]);
      if(state?.viewer?.toLowerCase()!==String(owner).replace(/^@/,'').toLowerCase())return {ok:false,attempted,blocked:true,reason:'Grok绘图期间登录账号变化'};
      if(state.quotaExhausted)return {ok:false,attempted:true,quotaExhausted:true,reason:'Grok报告配图额度用尽，文章保留为草稿，停止绘图请求'};
      if(state.image)return {ok:true,attempted:true,cover:await run(encodeGrokCoverOnPage,[state.image.src])};
    }
    return {ok:false,attempted:true,reason:'Grok配图等待超时，文章保留为草稿，未降级为普通新帖'};
  }catch(error){return {ok:false,attempted,reason:error.message};}
  finally{await api.tabs.remove(tab.id).catch(()=>{});}
}
