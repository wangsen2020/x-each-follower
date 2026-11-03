import {isAccessDeferred} from '../../platform/x/access-budget.js';
import {createStorageWriteQueue} from '../../platform/storage-write-queue.js';
import {mergeRecentPosts} from './network-api.js';
import {cachedReviewPosts,canonicalProfileHandle,inspectionProfilePatch,profileIdentityConflict,sameProfile,FAN_TIMELINE_TTL} from './fan-profile-evidence.js';

export const FAN_PROFILE_ALARM='x-fan-profile-collection';
export const FAN_PROFILE_STATE='fanProfileCollection:v1';
export const FAN_PROFILE_SPACING=15000;
export const FAN_PROFILE_LEASE=90000;
export const FAN_PROFILE_HISTORY_LIMIT=200;
const keyFor=item=>`${item.accountId}:${item.targetUserId}`;
const clone=value=>structuredClone(value);
function archiveResult(saved,item,result){
  const history=[{accountId:item.accountId,targetUserId:item.targetUserId,handle:item.handle,...result},
    ...(saved.history||[]).filter(j=>j.accountId===item.accountId)].slice(0,FAN_PROFILE_HISTORY_LIMIT);
  saved.history=[...(saved.history||[]).filter(j=>j.accountId!==item.accountId),...history];
}

// Durable checkpoints use the existing storage writer; profile CRUD stays in
// the record service/Dexie. One alarm invocation issues at most one timeline read.
export function createFanProfileCollector({storage,alarms,binding,readProfile,updateProfile,readTimeline,now=Date.now}={}){
  const writes=createStorageWriteQueue();let running=false;
  const state=async()=> (await storage.get(FAN_PROFILE_STATE))[FAN_PROFILE_STATE]||{pending:{},nextRequestAt:0};
  const change=transform=>writes.enqueue(async()=>{const previous=await state(),next=await transform(clone(previous));await storage.set({[FAN_PROFILE_STATE]:next});return next});
  async function guard(item){const owner=await binding();if(!owner?.activated||owner.accountId!==item.accountId)throw Object.assign(Error('资料采集绑定账号已变化'),{code:'PROFILE_OWNER_CHANGED'});}
  async function schedule(){
    if(!alarms?.create)return;
    const saved=await state(),owner=await binding(),jobs=Object.values(saved.pending).filter(j=>owner?.activated&&j.accountId===owner.accountId);
    if(!jobs.length){await alarms.clear?.(FAN_PROFILE_ALARM);return;}
    const due=Math.max(now()+1000,saved.nextRequestAt||0,saved.activeUntil||0,Math.min(...jobs.map(j=>j.retryAt||0)));
    const existing=await alarms.get?.(FAN_PROFILE_ALARM);
    if(existing&&existing.scheduledTime<=due)return;
    await alarms.create(FAN_PROFILE_ALARM,{when:due});
  }
  async function observe(target,accountId){
    const item={accountId,targetUserId:target.id,handle:canonicalProfileHandle(target.handle)};await guard(item);
    if(typeof target.id!=='string'||!/^\d+$/.test(target.id)||!item.handle)throw Error('资料采集目标账号无效');
    let cached;
    await updateProfile(item,previous=>{
      if(profileIdentityConflict(previous,item.targetUserId))throw Error('资料缓存用户 ID 冲突');
      const patch=inspectionProfilePatch(target,accountId,now());
      if(previous.profileEvidence?.ownerAccountId===accountId)patch.profileEvidence.fields={...previous.profileEvidence.fields,...patch.profileEvidence.fields};
      const old=previous.fanInspectionTimeline;
      cached=old?.ownerAccountId===accountId&&old.targetUserId===target.id&&old.fetchedAt<=now()&&now()-old.fetchedAt<FAN_TIMELINE_TTL&&['ready','partial','empty','unavailable'].includes(old.status);
      const waiting=old?.ownerAccountId===accountId&&old.targetUserId===target.id&&['pending','failed','rate-limited'].includes(old.status);
      return {...patch,...(!cached&&!waiting?{fanInspectionTimeline:{ownerAccountId:accountId,targetUserId:target.id,status:'pending',requestedAt:now(),posts:[]}}:{})};
    });
    if(!cached){
      await change(saved=>{const key=keyFor(item);saved.pending[key]||={...item,token:crypto.randomUUID(),attempts:0,retryAt:now()};return saved});
      await schedule();
    }
    return {profile:'saved',posts:cached?'cached':'pending'};
  }
  async function run(){
    if(running)return {busy:true};running=true;let claimed=false;
    try{
      const saved=await state(),owner=await binding();
      const item=Object.values(saved.pending).filter(j=>owner?.activated&&j.accountId===owner.accountId&&j.retryAt<=now()).sort((a,b)=>a.retryAt-b.retryAt)[0];
      if(!item||saved.nextRequestAt>now()||saved.activeUntil>now())return {deferred:true};
      await guard(item);
      const previous=await readProfile(item);
      if(!sameProfile(previous,item)||previous.profileEvidence?.ownerAccountId!==item.accountId){
        await change(s=>{if(s.pending[keyFor(item)]?.token===item.token)delete s.pending[keyFor(item)];return s});return {identityChanged:true};
      }
      const cached=previous.fanInspectionTimeline;
      if(cached?.ownerAccountId===item.accountId&&cached.targetUserId===item.targetUserId&&cached.fetchedAt<=now()&&now()-cached.fetchedAt<FAN_TIMELINE_TTL&&['ready','partial','empty','unavailable'].includes(cached.status)){
        await change(s=>{if(s.pending[keyFor(item)]?.token===item.token){delete s.pending[keyFor(item)];archiveResult(s,item,{status:cached.status,
          count:cached.count??cached.posts?.length??0,attempts:item.attempts||0,reason:cached.reason||'',finishedAt:now()});}return s});return {cached:true};
      }
      // Persist the shared request budget before network IO, including worker restarts.
      await change(s=>({...s,nextRequestAt:now()+FAN_PROFILE_SPACING,activeUntil:now()+FAN_PROFILE_LEASE,
        active:{...item,startedAt:now()}}));claimed=true;
      let response;
      try{response=await readTimeline(item);}catch(error){
        if(isAccessDeferred(error)){
          const retryAt=Math.max(now()+1000,error.retryAt||0);
          await change(s=>{if(s.pending[keyFor(item)]?.token===item.token)s.pending[keyFor(item)]={...item,retryAt,status:'pending',reason:error.message};
            s.nextRequestAt=Math.max(s.nextRequestAt||0,retryAt);return s;});
          return {deferred:true,retryAt};
        }
        response={status:error.status||0,error:error.message,retryAfterSeconds:error.retryAfterSeconds};
      }
      await guard(item);
      const ok=response?.status===200&&!response.error&&Array.isArray(response.posts),terminal=[401,403,404].includes(response?.status);
      const attempts=(item.attempts||0)+1;
      const finite=value=>Number.isFinite(Number(value))?Number(value):0;
      const retryAt=now()+Math.max(response?.status===429?15*60*1000:60000*2**Math.min(attempts,4),finite(response?.retryAfterSeconds)*1000,finite(response?.rateLimit?.resetAt)-now());
      const posts=ok?cachedReviewPosts(response.posts,item.handle):[];
      const textComplete=posts.every(post=>post.textComplete!==false);
      const postState=ok?posts.length&&textComplete&&(posts.length>=10||response.complete)?'ready':posts.length?'partial':response.complete?'empty':'partial':terminal?'unavailable':response?.status===429?'rate-limited':'failed';
      await updateProfile(item,current=>{
        if(!sameProfile(current,item)||current.profileEvidence?.ownerAccountId!==item.accountId)throw Error('资料采集目标或归属已变化');
        return {fanInspectionTimeline:{ownerAccountId:item.accountId,targetUserId:item.targetUserId,status:postState,posts,
          fetchedAt:ok||terminal?now():null,checkedAt:now(),complete:ok&&response.complete===true,count:posts.length,
          reason:response.error||'',attempts,exhausted:!ok&&!terminal&&attempts>=3,retryAt:ok||terminal||attempts>=3?null:retryAt,source:response.source||'UserTweets'},
          ...(ok?{posts:mergeRecentPosts(current.posts||[],posts,100)}:{})};
      });
      await change(s=>{
        if(s.pending[keyFor(item)]?.token!==item.token)return s;
        if(ok||terminal||attempts>=3){
          delete s.pending[keyFor(item)];
          archiveResult(s,item,{status:postState,count:posts.length,attempts,reason:response.error||'',finishedAt:now()});
        }
        else s.pending[keyFor(item)]={...item,attempts,retryAt,status:postState,reason:response.error||''};
        if(response?.status===429)s.nextRequestAt=Math.max(s.nextRequestAt||0,retryAt);
        if(response?.status===401)s.nextRequestAt=Math.max(s.nextRequestAt||0,now()+5*60*1000);
        return s;
      });
      return {ok,status:postState,count:posts.length};
    }finally{try{if(claimed)await change(s=>({...s,activeUntil:0,active:null}));}finally{running=false;await schedule();}}
  }
  async function discard({ownerId,handle,targetIds=[],checkOnly=false}){
    let deferred=false,removed=0;
    const matches=item=>item?.accountId===ownerId&&item.handle===handle&&(!targetIds.length||targetIds.includes(item.targetUserId));
    if(checkOnly){const saved=await state();return {deferred:!!(saved.activeUntil>now()&&matches(saved.active)),removed:0};}
    const snapshot=await state();
    if(!Object.values(snapshot.pending||{}).some(matches)&&!(snapshot.history||[]).some(matches))return {deferred:!!(snapshot.activeUntil>now()&&matches(snapshot.active)),removed:0};
    await change(saved=>{
      if(saved.activeUntil>now()&&matches(saved.active)){deferred=true;return saved;}
      for(const[key,item]of Object.entries(saved.pending||{}))if(matches(item)){delete saved.pending[key];removed++;}
      saved.history=(saved.history||[]).filter(item=>!matches(item));return saved;
    });
    await schedule();return {deferred,removed};
  }
  return {observe,run,schedule,discard,isRunning:()=>running};
}
