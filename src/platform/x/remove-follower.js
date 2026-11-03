import {profileRelationshipOnPage,mergeVerifiedRelationship} from './guarded-relationship.js';
import {createXNetworkClient} from './network-client.js';
import {followerRatioDecision} from '../../features/relationships/follower-ratio-policy.js';

export async function removePolicyFollower({api,tabId,handle,targetId,owner,readProfile,canAct,checkpoint,
  policy=live=>followerRatioDecision(live),
  wait=ms=>new Promise(r=>setTimeout(r,ms)),sendRemoval=id=>createXNetworkClient(api).removeFollower(tabId,id),refreshPage=()=>api.tabs.reload(tabId)}) {
  let attempted=false;
  const page=async(func,args)=>(await api.scripting.executeScript({target:{tabId},func,args}))?.[0]?.result;
  const verify=async()=>{
    if(!await canAct())throw Error('任务或账号保护条件已变化');
    const target=await readProfile();
    if(!target || String(target.id)!==String(targetId) || target.handle.toLowerCase()!==handle.toLowerCase())throw Error('目标账号无法核实');
    const dom=await page(profileRelationshipOnPage,[handle,String(targetId),owner,'read']);
    return {...target,relationship:mergeVerifiedRelationship(target.relationship,dom)};
  };
  try{
    let live=await verify();const firstPolicy=await policy(live);
    if(live.relationship.followedBy!==true || live.relationship.following!==false || !firstPolicy?.remove)return {attempted:false,removed:false,reason:!firstPolicy?.remove?(firstPolicy?.reason||'当前不满足移除条件'):'当前关系不满足待回关移除条件',live};
    live=await verify();const secondPolicy=await policy(live);
    if(live.relationship.followedBy!==true || live.relationship.following!==false || !secondPolicy?.remove)return {attempted:false,removed:false,reason:'确认前关系或比例已变化',live};
    // Persist ambiguous intent before the irreversible confirmation, never blindly retry.
    await checkpoint({attemptedAt:Date.now(),targetUserId:String(targetId),policy:secondPolicy});
    if(!await canAct())return {attempted:false,removed:false,reason:'提交前任务保护条件已变化'};
    attempted=true;
    const result=await sendRemoval(String(targetId));
    if(!(result.status>=200&&result.status<300)||result.error)return {attempted:result.attempted!==false,removed:false,responseStatus:result.status,reason:result.error||'移除接口未确认成功'};
    await refreshPage();
    for(let i=0;i<6;i++){
      await wait(700);const confirmed=await verify();
      if(confirmed.relationship.followedBy===false && confirmed.relationship.following===false)return {attempted:true,removed:true,responseStatus:result.status,live:confirmed,reason:secondPolicy.reason};
    }
    return {attempted:true,removed:false,reason:'移除结果未确认，禁止自动重复提交'};
  }catch(error){return {attempted,removed:false,reason:error.message};}
}

export async function removeRatioFollower(options = {}) {
  const ratioLimit = options.ratioLimit ?? 10;
  const policy = typeof options.policy === 'function' ? options.policy : live => followerRatioDecision(live, ratioLimit);
  return removePolicyFollower({...options, policy});
}
