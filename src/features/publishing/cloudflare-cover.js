import Dexie from 'dexie';

export const CLOUDFLARE_IMAGE_MODEL='@cf/black-forest-labs/flux-1-schnell';
export const CLOUDFLARE_SETUP_URL='https://dash.cloudflare.com/?to=/:account/ai/workers-ai';
export const CLOUDFLARE_TEST_PROMPT='A premium editorial poster: one luminous amber geometric sculpture against a deep navy background, restrained teal accents, bold silhouette, dramatic studio lighting, generous negative space and a clear visual hierarchy. No text, logos or charts.';
let database;
function vault() {
  if(!database){database=new Dexie('xfollower-image-connections');database.version(1).stores({connections:'id'});}
  return database.table('connections');
}
const defaultVault={get:()=>vault().get('cloudflare'),put:value=>vault().put({...value,id:'cloudflare'}),clear:()=>vault().delete('cloudflare')};

export async function normalizeCloudflareCover(encoded) {
  const bytes=Uint8Array.from(atob(encoded),char=>char.charCodeAt(0));
  const bitmap=await createImageBitmap(new Blob([bytes]));
  const height=Math.floor(Math.min(bitmap.height,bitmap.width/2.5)/2)*2,width=height*2.5;
  if(height<128){bitmap.close();throw Error('生成的图片尺寸不足，未进入发布流程');}
  const cropWidth=Math.min(bitmap.width,bitmap.height*2.5),cropHeight=cropWidth/2.5;
  const canvas=new OffscreenCanvas(width,height);
  canvas.getContext('2d').drawImage(bitmap,(bitmap.width-cropWidth)/2,(bitmap.height-cropHeight)/2,cropWidth,cropHeight,0,0,width,height);
  bitmap.close();
  const blob=await canvas.convertToBlob({type:'image/png'});
  const pixels=new Uint8Array(await blob.arrayBuffer());let binary='';
  for(let i=0;i<pixels.length;i+=32768)binary+=String.fromCharCode(...pixels.subarray(i,i+32768));
  return {dataUrl:'data:image/png;base64,'+btoa(binary),mimeType:'image/png',width,height,provider:'cloudflare',model:CLOUDFLARE_IMAGE_MODEL};
}

// A small adapter around the documented Workers AI API. Credential CRUD uses
// the existing Dexie dependency; secrets stay out of synced settings/backups.
export function createCloudflareCoverService({credentials=defaultVault,fetchImpl=fetch,normalize=normalizeCloudflareCover}={}) {
  async function request(connection,path,options={}) {
    const response=await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${connection.accountId}/ai/${path}`,{
      ...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.token}`},signal:options.signal||AbortSignal.timeout(120000)
    });
    const result=await response.json().catch(()=>null);
    if(!response.ok||result?.success===false){
      const quotaExhausted=response.status===429||result?.errors?.some(e=>/quota|neurons|allocation|daily limit/i.test(e.message||''));
      throw Object.assign(new Error(quotaExhausted?'Cloudflare额度或速率受限，文章草稿已保留':response.status===401?'Cloudflare连接已失效，请重新连接':response.status===403?'Cloudflare权限不足，请按引导创建Workers AI专用Token':'Cloudflare配图请求失败，请稍后检查连接'),{status:response.status,quotaExhausted});
    }
    return result;
  }
  async function status(){const value=await credentials.get();return {connected:Boolean(value?.token&&value?.testedAt),accountId:value?.accountId||'',testedAt:value?.testedAt||null};}
  async function createCover(connection,prompt,signal){
    const result=await request(connection,`run/${CLOUDFLARE_IMAGE_MODEL}`,{method:'POST',signal,body:JSON.stringify({prompt:`Premium editorial poster, wide 5:2 composition. One strong focal subject, bold silhouette, clear visual hierarchy, restrained palette, generous negative space. Keep important subjects in the central horizontal band for cropping. No text or watermarks. ${String(prompt).slice(0,1400)}. This is the text-free fallback: use only the visual subject and composition above; ignore all headline, caption and lettering instructions. No text, letters, numbers, logos or watermarks.`.slice(0,2048),steps:4})});
    if(!result?.result?.image)throw Error('Cloudflare没有返回图片，请重试出图测试');
    return normalize(result.result.image);
  }
  async function connect({accountId,token}) {
    const connection={accountId:String(accountId||'').trim(),token:String(token||'').trim()};
    if(!/^[a-f\d]{32}$/i.test(connection.accountId))throw Error('请输入32位Cloudflare账号ID');
    if(!connection.token)throw Error('请输入Workers AI专用Token');
    await request(connection,'models/search?per_page=1');
    // Commit only after actual image decoding succeeds. A failed replacement
    // must leave the previous working connection intact.
    const cover=await createCover(connection,CLOUDFLARE_TEST_PROMPT);
    await credentials.put({...connection,testedAt:new Date().toISOString()});
    return {...await status(),cover};
  }
  async function generate({prompt,signal}={}) {
    const connection=await credentials.get();
    if(!connection?.token)return {ok:false,attempted:false,connectionRequired:true,reason:'请先连接Cloudflare图片生成服务'};
    if(!String(prompt||'').trim())return {ok:false,attempted:false,reason:'缺少封面提示词'};
    try{
      const cover=await createCover(connection,prompt,signal);
      return {ok:true,attempted:true,cover};
    }catch(error){return {ok:false,attempted:true,quotaExhausted:Boolean(error.quotaExhausted),status:error.status,reason:error.message};}
  }
  return {status,connect,generate,disconnect:()=>credentials.clear()};
}

export const cloudflareCoverService=createCloudflareCoverService();
