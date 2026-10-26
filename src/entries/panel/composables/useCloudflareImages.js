import {ref} from 'vue';
import {cloudflareCoverService} from '../../../features/publishing/cloudflare-cover.js';

export function createCloudflareImagesController({service=cloudflareCoverService,api=globalThis.chrome}={}) {
  const isOpen=ref(false),busy=ref(false),step=ref(1),accountId=ref(''),token=ref(''),connected=ref(false),message=ref(''),error=ref(''),preview=ref('');
  const boundAccountId=ref('');
  async function refreshStatus(){
    const state=await service.status();
    connected.value=state.connected;
    boundAccountId.value=state.connected?state.accountId:'';
    return state;
  }
  async function open(){
    if(busy.value)return;
    isOpen.value=true;error.value='';message.value='';token.value='';preview.value='';busy.value=true;
    try{const state=await service.status();accountId.value=state.accountId;boundAccountId.value=state.connected?state.accountId:'';connected.value=state.connected;step.value=state.connected?4:1;}
    catch{error.value='无法读取连接信息，请关闭后重试';}
    finally{busy.value=false;}
  }
  function next(){
    if(busy.value)return;
    error.value='';
    if(step.value===2&&!/^[a-f\d]{32}$/i.test(accountId.value.trim())){error.value='请填写32位 Account ID，可从 Workers AI 页面复制';return;}
    if(step.value<3)step.value++;
  }
  function back(){if(!busy.value&&step.value>1&&step.value<4){step.value--;error.value='';}}
  async function task(action){if(busy.value)return;busy.value=true;error.value='';message.value='';try{await action();}catch(e){error.value=e.message;}finally{busy.value=false;}}
  const connect=()=>task(async()=>{
    if(!/^[a-f\d]{32}$/i.test(accountId.value.trim())){step.value=2;throw Error('请填写32位 Account ID');}
    if(!token.value.trim())throw Error('请填写 Workers AI API Token');
    if(api?.permissions){const origins=['https://api.cloudflare.com/*'];if(!await api.permissions.contains({origins})&&!await api.permissions.request({origins}))throw Error('未获得Cloudflare接口访问权限，请重新点击测试并绑定');}
    message.value='正在验证连接并生成测试图片…';
    const result=await service.connect({accountId:accountId.value,token:token.value});
    token.value='';connected.value=true;boundAccountId.value=result.accountId;accountId.value=result.accountId;
    preview.value=result.cover.dataUrl;step.value=4;message.value='绑定成功，已完成出图测试';
  });
  const disconnect=()=>task(async()=>{await service.disconnect();connected.value=false;token.value='';accountId.value='';boundAccountId.value='';preview.value='';step.value=1;message.value='已解绑，可重新连接。若不再使用，可在 Cloudflare 中撤销该 Token。';});
  function rebind(){if(busy.value)return;step.value=1;token.value='';preview.value='';error.value='';message.value='';}
  function close(){if(!busy.value){isOpen.value=false;token.value='';}}
  return {isOpen,busy,step,accountId,token,connected,boundAccountId,message,error,preview,open,close,next,back,connect,disconnect,rebind,refreshStatus};
}
export const cloudflareImagesController=createCloudflareImagesController();
