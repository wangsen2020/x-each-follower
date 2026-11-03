const handleOf = value => String(value || '').replace(/^@/, '').toLowerCase();
const validHandle = value => /^[a-z0-9_]{1,15}$/.test(value);
// Historical outcomes are independent of current relationship/profile records.
export function unfollowLogReceipts(log, {accountId='',handle=''}={}) {
  if(log?.result!=='success'||!Array.isArray(log.unfollowedHandles))return [];
  const at=Date.parse(log.at||'');if(!Number.isFinite(at))return [];
  const explicit=log.accountId||log.ownerAccountId||log.details?.['绑定账号ID'];
  const ownerHandle=handleOf(log.details?.['绑定账号']);
  const owner=explicit||(!ownerHandle||ownerHandle===handleOf(handle)?accountId:'')||'unassigned';
  return [...new Set(log.unfollowedHandles.map(handleOf))].filter(validHandle).map(target=>({accountId:String(owner),handle:target,
    targetUserId:handleOf(log.target?.handle)===target?String(log.target.id||''):'',
    name:handleOf(log.target?.handle)===target?log.target.name||target:target,
    at,evidenceId:log.id||'',source:'success-log'}));
}
export function mergeUnfollowHistory(history, receipts) {
  const next={...history};
  for(const receipt of receipts){
    if(!validHandle(receipt.handle)||!receipt.accountId||!Number.isFinite(receipt.at))continue;
    const key=receipt.accountId+':'+receipt.handle,old=next[key];
    if(!old||receipt.at>old.at)next[key]={...receipt};
  }
  return next;
}
export function unfollowHistoryRows(history, accountId, legacyOwner='') {
  const owner=accountId==='unassigned'?legacyOwner||'unassigned':accountId;
  return Object.values(history).filter(r=>r.accountId===owner).map(r=>({accountId,module:'unreciprocated',handle:r.handle,
    userKey:'unfollow-history/'+r.handle,sourceKey:'unfollowHistory',sourcePath:['unfollowHistory',r.accountId,r.handle],
    sortKey:String(999999999999999-r.at).padStart(15,'0'),tabs:['unfollowed'],status:'unfollowed',
    payload:{handle:r.handle,id:r.targetUserId||'',name:r.name||r.handle,status:'unfollowed',historyOnly:true,
      unfollowedAt:new Date(r.at).toISOString(),relationship:{following:false,followedBy:null},unfollowReceipt:r}}));
}
