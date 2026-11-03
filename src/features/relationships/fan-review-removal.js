import {isAccessDeferred} from '../../platform/x/access-budget.js';
import {networkGetUserProfile,parseNetworkUsers} from './network-api.js';
import {removePolicyFollower} from '../../platform/x/remove-follower.js';
import {createProfileTab} from '../../platform/x/profile-access.js';
import {createQueueTabs} from '../follow-queue/queue-lifecycle.js';

const PREFIX='followQueueFanRemovalIntent:';
const TABS='fanReviewRemovalOwnedTabs';
const locks=new WeakMap(),lifecycles=new WeakMap();
const canonical=value=>typeof value==='string'?value.trim().replace(/^@/,'').toLowerCase():'';
const stableId=value=>typeof value==='string'&&/^\d+$/.test(value)?value:'';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function viewerOnPage(){return globalThis.__xfAccountSnapshot?.account?.handle||'';}

function lifecycle(api) {
  const identity=api.storage.session||api.storage.local;
  if(lifecycles.has(identity))return lifecycles.get(identity);
  // Reuse the queue's tested close/URL safeguards with a separate ownership registry.
  const session=api.storage.session;
  if(!session?.get||!session?.set)throw Error('移除任务缺少持久标签登记存储');
  const tabs=createQueueTabs({...api,storage:{session:{
    async get(){const result=await session.get(TABS);return {followQueueOwnedTabs:result[TABS]};},
    async set(value){await session.set({[TABS]:value.followQueueOwnedTabs});}
  }}});
  let recovery;
  const result={tabs,ready(){return recovery ||= tabs.recover().catch(error=>{recovery=null;throw error;});}};
  lifecycles.set(identity,result);return result;
}

function serial(storage,key,work) {
  let pending=locks.get(storage);if(!pending){pending=new Map();locks.set(storage,pending);}
  const next=(pending.get(key)||Promise.resolve()).catch(()=>{}).then(work);
  pending.set(key,next);void next.finally(()=>{if(pending.get(key)===next)pending.delete(key);}).catch(()=>{});
  return next;
}

export function createFanReviewRemoval({api=globalThis.chrome,readBinding,records=null,storage=api?.storage?.local,
  wait=sleep,now=()=>Date.now(),fetchProfile=networkGetUserProfile,parseUsers=parseNetworkUsers,readAccount,
  readViewer=async tabId=>(await api.scripting.executeScript({target:{tabId},func:viewerOnPage,args:[]}))?.[0]?.result,
  removePolicy=removePolicyFollower,ownedTabs,createTab=options=>createProfileTab(api,options,'fan-review-removal'),
  sendRemoval,refreshPage}={}) {
  if(typeof readBinding!=='function'||!storage?.get||!storage?.set)throw Error('移除任务缺少账号或持久存储接口');
  // records is deliberately optional: the live X identity, not a mutable local handle, authorizes removal.
  void records;
  return async function removeFollower({accountId,handle,targetUserId,reason='人工确认移除关注者'}={}) {
    const owner=stableId(accountId),target=stableId(targetUserId),name=canonical(handle);
    const base={accountId:owner||accountId,targetUserId:target||targetUserId,handle:name,attempted:false,removed:false};
    if(!owner||!target||owner===target||!/^[a-z0-9_]{1,15}$/.test(name))return {...base,state:'failed',reason:'移除任务需要明确的账号与稳定用户 ID'};
    const key=`${PREFIX}${owner}:${target}`;
    return serial(storage,key,async()=>{
      let tab,keyedTabs,receipt,cleanupError='';
      const tabKey=`fan-remove:${owner}:${target}`;
      const readIntent=async()=>(await storage.get([key]))?.[key];
      const writeIntent=async value=>{await storage.set({[key]:value});receipt=value;};
      try {
        keyedTabs=ownedTabs||lifecycle(api).tabs;
        if(!ownedTabs)await lifecycle(api).ready();
        const prior=await readIntent();
        if(prior){
          if(prior.accountId!==owner||prior.targetUserId!==target)throw Error('移除意图账号记录不一致，禁止重复提交');
          await keyedTabs.release(tabKey);
          if(prior.removed===true&&prior.verifiedAt)return {...prior,attempted:true,state:'removed',recovered:true};
        }
        const binding=await readBinding();
        const ownerHandle=canonical(binding?.handle);
        if(!binding?.activated||binding.accountId!==owner||!/^[a-z0-9_]{1,15}$/.test(ownerHandle)||ownerHandle===name)throw Error('队列绑定账号不一致，未执行移除');
        const sameBinding=async()=>{const current=await readBinding();return current?.activated===true&&current.accountId===owner&&canonical(current.handle)===ownerHandle;};
        const url=`https://x.com/${encodeURIComponent(name)}`;
        tab=await keyedTabs.acquire(tabKey,()=>createTab({url,active:false}),url);
        // Let a fresh inactive profile page expose its independently signed-in viewer.
        let ready=false;
        if(readAccount){const account=await readAccount();if(String(account?.id)!==owner)throw Error('账号模块尚未确认当前操作账号');ready=true;}
        for(let i=0;!ready&&i<20;i++){
          if(!await sameBinding())throw Error('移除前绑定账号已变化');
          const viewer=canonical(await readViewer(tab.id));
          if(viewer&&viewer!==ownerHandle)throw Error('X 当前登录账号与绑定账号不一致');
          if(viewer===ownerHandle){ready=true;break;}
          await wait(500);
        }
        if(!ready)throw Error('X 当前登录账号无法核实');
        const canAct=async()=>await sameBinding()&&(readAccount?String((await readAccount())?.id)===owner:canonical(await readViewer(tab.id))===ownerHandle);
        if(!readAccount){
        const viewerResponse=await fetchProfile(tab.id,ownerHandle,{preferPageResponse:false});
        const viewers=viewerResponse?.status===200?parseUsers(viewerResponse.json).filter(user=>canonical(user.handle)===ownerHandle):[];
        if(viewers.length!==1||stableId(viewers[0].id)!==owner)throw Error('X 当前登录账号 ID 与绑定账号不一致');
        }
        const readProfile=async()=>{
          if(!await canAct())throw Error('移除任务账号保护条件已变化');
          const raw=await fetchProfile(tab.id,name,{preferPageResponse:false});
          const candidates=raw?.status===200?parseUsers(raw.json).filter(user=>canonical(user.handle)===name):[];
          if(candidates.length!==1||stableId(candidates[0].id)!==target)throw Error('目标账号信息已变化，未执行移除');
          return candidates[0];
        };
        // Reconcile the previous operation against fresh X evidence. A receipt
        // alone must not leave a rejected follower waiting for a person forever.
        const live=await readProfile();
        if(live.relationship?.followedBy===false&&live.relationship?.following===false){
          const confirmed={...base,...prior,attempted:Boolean(prior?.attemptedAt),removed:true,state:'removed',verifiedAt:now(),reason:'X 已确认该账号不再是关注者'};
          await writeIntent(confirmed);return confirmed;
        }
        if(prior?.attemptedAt&&now()-prior.attemptedAt<60000)return {...prior,state:'deferred',deferred:true,retryAt:prior.attemptedAt+60000,reason:'正在自动核对上一条移除结果'};
        const result=await removePolicy({api,tabId:tab.id,handle:name,targetId:target,owner:ownerHandle,
          readProfile,canAct,wait,policy:()=>({remove:true,reason}),
          checkpoint:async intent=>{
            if(!await canAct())throw Error('提交移除前账号保护条件已变化');
            const current=await readIntent();
            if(current?.attemptedAt&&current.attemptedAt!==prior?.attemptedAt)throw Error('已有新的移除提交意图，等待自动核对');
            // removePolicy has freshly confirmed the stable target, signed-in
            // owner and follower relationship twice before this checkpoint.
            await writeIntent({...base,attempted:true,attemptedAt:intent.attemptedAt||now(),state:'unknown',reason:'移除已提交，正在自动核对结果',
              ...(prior?.attemptedAt?{previousAttempts:[...(prior.previousAttempts||[]),{attemptedAt:prior.attemptedAt,reason:prior.reason}].slice(-5)}:{})});
          },...(sendRemoval?{sendRemoval:id=>sendRemoval(tab.id,id)}:{}),...(refreshPage?{refreshPage:()=>refreshPage(tab.id)}:{})});
        if(result?.removed===true&&receipt?.attemptedAt){
          const confirmed={...receipt,attempted:true,removed:true,state:'removed',verifiedAt:now(),reason:result.reason||reason,responseStatus:result.responseStatus||200};
          await writeIntent(confirmed);return confirmed;
        }
        if(receipt?.attemptedAt){
          const unknown={...receipt,attempted:true,removed:false,state:'unknown',reason:result?.reason||'移除结果待核实，禁止重复提交'};
          await writeIntent(unknown);return unknown;
        }
        return {...base,state:'failed',reason:result?.reason||'未提交移除操作'};
      }catch(error){
        // A lost checkpoint/outcome response may have committed. Re-read before classifying failure.
        const durable=await readIntent().catch(()=>receipt);
        if(isAccessDeferred(error))return {...base,...(durable||{}),attempted:Boolean(durable?.attemptedAt),removed:false,state:'deferred',deferred:true,retryAt:error.retryAt,reason:error.message};
        return {...base,...(durable||{}),attempted:Boolean(durable?.attemptedAt),removed:durable?.removed===true,
          state:durable?.removed===true?'removed':durable?.attemptedAt?'unknown':'failed',reason:error.message};
      }finally{
        if(tab)try{await keyedTabs.release(tabKey);}catch(error){cleanupError=error.message;}
        // createQueueTabs retains registration after close failures for the next worker recovery.
        if(cleanupError&&receipt)receipt.cleanupError=cleanupError;
      }
    });
  };
}
