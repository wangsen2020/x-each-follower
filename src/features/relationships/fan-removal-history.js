// History is built from confirmed outcomes, never from an AI verdict or a local delete.
export function removalHistoryRows(receipts,accountId) {
  const unique=new Map();
  for(const receipt of receipts){
    const id=receipt?.targetUserId,handle=String(receipt?.handle||'').toLowerCase();
    const at=Number(receipt?.verifiedAt)||Date.parse(receipt?.verifiedAt||'');
    if(receipt?.accountId!==accountId||receipt.removed!==true||!Number.isFinite(at)||at<=0||typeof id!=='string'||!/^\d+$/.test(id)||!/^\w{1,15}$/.test(handle))continue;
    if((unique.get(id)?.at||0)<at)unique.set(id,{receipt,at});
  }
  return [...unique.values()].map(({receipt,at})=>({accountId,module:'fans',handle:receipt.handle.toLowerCase(),userKey:'removed:'+receipt.targetUserId,
    sortKey:String(999999999999999-at).padStart(15,'0'),status:'removed',sourcePath:['monitor','removedHistory',receipt.targetUserId],
    payload:{handle:receipt.handle.toLowerCase(),id:receipt.targetUserId,targetUserId:receipt.targetUserId,historyOnly:true,fanCategory:'removed',status:'removed',
      name:receipt.name||receipt.handle,fanReview:{state:'removed',decision:'remove',reason:receipt.reason||'已移除此关注者',removedAt:at,ownerAccountId:accountId,targetUserId:receipt.targetUserId,removalReceipt:receipt},
      followerRemoval:receipt,followerRemovedAt:at,relationship:{following:null,followedBy:null},fanRelationshipReason:receipt.reason||'已移除此关注者'},
    searchText:[receipt.handle,receipt.reason].join(' ').toLowerCase()})).sort((a,b)=>a.sortKey.localeCompare(b.sortKey)||a.userKey.localeCompare(b.userKey));
}
