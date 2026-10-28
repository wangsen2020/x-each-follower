// The validated committed chain is authoritative when versions cannot be ordered.
// Distinct IDs are distinct events; equal IDs produce one effective record.
const time=op=>{const value=op?.record?.updatedAt||op?.record?.at;return Number(op?.writtenAt)||(typeof value==='number'?value:Date.parse(value||''))||0;};
export function mergePendingLogs(committed,pending){
  const latest=new Map();
  const remember=op=>{
    if(op.record?.id)latest.set(op.record.id,op);
    if(op.op==='delete'&&op.id)latest.set(op.id,op);
    for(const id of op.op==='prune'?op.ids||[]:op.prunedIds||[])latest.set(id,{op:'delete',id,writtenAt:op.writtenAt});
  };
  committed.forEach(remember);
  return pending.map(item=>{
    let op=item.op;
    const id=op.record?.id||op.id,base=latest.get(id);
    if(base){
      const incomingRevision=op.record?.revision,committedRevision=base.record?.revision;
      const hasRevisions=Number.isFinite(incomingRevision)&&Number.isFinite(committedRevision)&&incomingRevision!==committedRevision;
      const newer=hasRevisions?incomingRevision>committedRevision:time(op)>0 && time(base)>0 && time(op)>time(base);
      const winner=newer?op:base,other=newer?base:op;
      if(winner.record){
        const identity={};for(const key of ['name','handle','target','sources'])if(other.record?.[key]!=null)identity[key]=other.record[key];
        // Never carry a losing failure/detail/evaluation into a newer success.
        op={...winner,record:{...identity,...winner.record},prunedIds:[...new Set([...(winner.prunedIds||[]),...(other.prunedIds||[])])]};
      }else op={...winner};
    }
    remember(op);return {...item,op};
  });
}
