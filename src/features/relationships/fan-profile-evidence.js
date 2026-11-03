import {selectQueueScreeningPosts} from './review-posts.js';

export const FAN_TIMELINE_TTL=6*60*60*1000;
export const canonicalProfileHandle=value=>String(value||'').trim().replace(/^@/,'').toLowerCase();
export function profileIdentity(profile){
  const ids=[...new Set([profile?.id,profile?.targetUserId,profile?.rest_id,profile?.restId].filter(v=>typeof v==='string'&&/^\d+$/.test(v)))];
  return ids.length===1?ids[0]:'';
}
export function sameProfile(profile,{handle,targetUserId}){
  return profileIdentity(profile)===targetUserId&&canonicalProfileHandle(profile?.handle)===canonicalProfileHandle(handle);
}
export function profileIdentityConflict(profile,targetUserId){
  return [profile?.id,profile?.targetUserId,profile?.rest_id,profile?.restId].filter(v=>v!==undefined&&v!==null&&v!=='')
    .some(v=>typeof v!=='string'||!/^\d+$/.test(v)||v!==targetUserId);
}
export function cachedReviewPosts(posts,handle){
  const time=p=>typeof p.createdAt==='number'?p.createdAt:Date.parse(p.createdAt||p.time||'')||0;
  return selectQueueScreeningPosts((Array.isArray(posts)?posts:[]).filter(p=>(!p.kind||p.kind==='post'))
    .sort((a,b)=>time(b)-time(a)),handle,10);
}
export function inspectionProfilePatch(target,accountId,now=Date.now()){
  const patch={id:target.id,targetUserId:target.id,handle:canonicalProfileHandle(target.handle),
    profileObservedAt:now,profileSource:'relationship-inspection',
    profileEvidence:{ownerAccountId:accountId,targetUserId:target.id,observedAt:now,source:'relationship-inspection',fields:{}}};
  for(const field of ['name','bio','avatarUrl','followersText','followingText']){
    const value=target[field],present=target.profileFieldPresence?.[field];
    if(value!=null&&(present===true||present!==false&&String(value)!=='')){patch[field]=String(value);patch.profileEvidence.fields[field]=now;}
  }
  for(const field of ['is_blue_verified','verified','protected'])if(typeof target[field]==='boolean')patch[field]=target[field];
  return patch;
}
export function reviewProfileEvidence(profile,context,now=Date.now()){
  const identity=sameProfile(profile,context),owned=identity&&profile.profileEvidence?.ownerAccountId===context.accountId&&profile.profileEvidence?.targetUserId===context.targetUserId;
  if(!owned)return {profile:null,posts:[],information:{profile:'unavailable',posts:'not-collected',count:0}};
  const timeline=profile.fanInspectionTimeline;
  const valid=timeline?.ownerAccountId===context.accountId&&timeline?.targetUserId===context.targetUserId;
  const fresh=valid&&Number.isFinite(timeline.fetchedAt)&&timeline.fetchedAt<=now&&now-timeline.fetchedAt<FAN_TIMELINE_TTL;
  const posts=fresh&&['ready','partial'].includes(timeline.status)?cachedReviewPosts(timeline.posts,context.handle):[];
  return {profile,posts,information:{profile:['bio','followersText','followingText'].every(field=>profile.profileEvidence.fields?.[field])?'collected':'partial',profileObservedAt:profile.profileObservedAt||null,fieldObservedAt:profile.profileEvidence.fields||{},
    posts:fresh?timeline.status:valid?timeline.fetchedAt?'stale':timeline.status:'not-collected',
    count:posts.length,observedPostCount:fresh&&Array.isArray(timeline.posts)?timeline.posts.length:0,postsObservedAt:valid?timeline.fetchedAt||null:null,collectionExhausted:valid&&timeline.exhausted===true,reason:valid?timeline.reason||'':''}};
}
