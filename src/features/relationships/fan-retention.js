import {fanDirectoryRow} from './fan-directory.js';

export const fanHandle=value=>String(value||'').trim().replace(/^@/,'').toLowerCase();
export const fanTargetId=payload=>[payload?.id,payload?.targetUserId,payload?.rest_id,payload?.restId].find(id=>typeof id==='string'&&/^\d+$/.test(id))||'';
export const fanObservation=payload=>Math.max(0,...['relationshipObservedAt','relationshipVerifiedAt','followingObservedAt','followedByObservedAt'].map(key=>typeof payload?.[key]==='number'?(Number.isFinite(payload[key])?payload[key]:0):Date.parse(payload?.[key]||'')||0));
export const FAN_JOB_ACTIVITY_WINDOW_MS=10*60*1000;
export function fanJobBusy(job,at=Date.now(),active=false){
  if(active||job.state==='running'||job.lease?.expiresAt>at)return true;
  const pending=(job.evaluations||[]).filter(e=>['processing','publishing'].includes(e.status));
  if(!pending.length)return false;
  const stamp=value=>typeof value==='number'?(Number.isFinite(value)?value:0):Date.parse(value||'')||0;
  const latest=Math.max(stamp(job.updatedAt),...pending.flatMap(e=>['updatedAt','commentAttemptedAt','generationAttemptedAt','publishedAttemptedAt'].map(k=>stamp(e[k]))));
  return !latest||at-latest<=FAN_JOB_ACTIVITY_WINDOW_MS;
}

export function fanRowOwned(row,owner,legacyOwner){
  const p=row.payload||{},claims=[p.accountId,p.ownerAccountId,p.fanReview?.ownerAccountId,p.fanGrant?.ownerAccountId].filter(id=>id&&id!=='unassigned');
  return !claims.some(id=>id!==owner)&&(row.accountId===owner||row.accountId==='unassigned'&&(legacyOwner===owner||claims.includes(owner)));
}
export function hasNewerFanRelationship(rows,marker,inclusive=false){
  return rows.some(row=>(!marker.targetIds?.length||marker.targetIds.includes(fanTargetId(row.payload)))&&fanObservation(row.payload)>0
    &&(inclusive?fanObservation(row.payload)>=marker.observedAt:fanObservation(row.payload)>marker.observedAt)
    &&(row.payload?.relationship?.following===true||row.payload?.relationship?.followedBy===true));
}

// Unknown, contradictory and undated default flags are not proof of no relation.
export function fanRetentionDecision(rows,access){
  const sources=rows.filter(row=>row.sourceKey==='monitor'&&['users','queue','followingUsers'].includes(row.sourcePath?.[1]));
  const ids=[...new Set(sources.map(row=>fanTargetId(row.payload)).filter(Boolean))];
  if(ids.length>1||sources.some(row=>row.payload?.status==='identity_mismatch'))return null;
  const evidence=[access,...rows.map(row=>row.payload?.accountAvailability)].filter(e=>e&&Number.isFinite(e.checkedAt));
  const latest=Math.max(0,...evidence.map(e=>e.checkedAt));
  const current=evidence.filter(e=>e.checkedAt===latest);
  if(current.length&&current.every(e=>['not_found','suspended'].includes(e.status))){
    return {scope:'account',reason:current[0].status,observedAt:latest,targetIds:ids};
  }
  const directory=fanDirectoryRow(sources),p=directory?.payload;
  if(!p||p.relationship.following!==false||p.relationship.followedBy!==false)return null;
  if(!p.relationshipKnown&&!sources.some(row=>row.payload?.relationshipKnown===true&&row.payload.relationship?.following===false&&row.payload.relationship?.followedBy===false))return null;
  const observedAt=Math.max(p.fanRelationshipObservedAt||0,...sources.map(row=>fanObservation(row.payload)));
  if(hasNewerFanRelationship(rows.filter(row=>row.sourceKey!=='monitor'),{targetIds:ids,observedAt},true))return null;
  return {scope:'fans',reason:'no_relationship',observedAt,targetIds:ids};
}

export function fanRetentionBlocks(marker,{accountId,sourceKey,payload,moduleName}){
  if(!marker||moduleName==='logs')return false;
  if(marker.scope==='fans'&&sourceKey!=='monitor')return false;
  const id=fanTargetId(payload);
  if(marker.targetIds?.length&&id&&!marker.targetIds.includes(id))return false;
  if([payload?.accountId,payload?.ownerAccountId].some(owner=>owner&&owner!=='unassigned'&&owner!==marker.ownerId))return false;
  if(marker.scope==='fans'){
    const positive=payload?.relationship?.following===true||payload?.relationship?.followedBy===true;
    return !(positive&&fanObservation(payload)>marker.observedAt);
  }
  const available=payload?.accountAvailability;
  return !(available?.status==='ok'&&available.checkedAt>marker.observedAt);
}
