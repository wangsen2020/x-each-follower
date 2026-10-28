import {createKnowledgeRecord,createRevisionRecord} from './knowledge-model.js';

export async function saveMergeProposal(store,run,group,index,now){
  const id=`merge:${run.id}:${index}`;
  const existing=await store.getKnowledge(run.ownerId,id);if(existing)return existing;
  const links=(await Promise.all(group.parents.map(p=>store.listKnowledgeEvidence(run.ownerId,p.id)))).flat();
  const row={...createKnowledgeRecord({ownerId:run.ownerId,id,type:group.parents[0].type,statement:group.statement,scope:group.parents[0].scope,createdAt:now}),mergeParents:group.parents.map(({id,revision,status})=>({id,revision,status}))};
  return store.runTransaction(['knowledge','revisions','knowledgeEvidence'],'readwrite',(tables,set,fail)=>{
    const lookup=tables.knowledge.index('ownerFingerprint').get([row.ownerId,row.fingerprint]);
    lookup.onerror=()=>fail(lookup.error);
    lookup.onsuccess=()=>{
      if(lookup.result){set(lookup.result);return;}
      tables.knowledge.add(row);
      tables.revisions.add(createRevisionRecord({ownerId:row.ownerId,knowledgeId:id,statement:row.statement,scope:row.scope,parentRefs:row.mergeParents,reason:group.reason,createdAt:now}));
      for(const link of links)tables.knowledgeEvidence.put({...link,knowledgeId:id});
      set(row);
    };
  });
}

// Approval replaces all parents atomically; stale proposals never supersede newer decisions.
export function approveMerge(store,{ownerId,id,revision},now){
  return store.runTransaction(['knowledge','revisions'],'readwrite',(tables,set,fail)=>{
    const lookup=tables.knowledge.get([ownerId,id]);
    lookup.onsuccess=()=>{
      const row=lookup.result;
      if(!row?.mergeParents?.length||row.revision!==revision||row.status!=='candidate'){fail(Error('归并建议已变化，请刷新'));return;}
      const parents=[];let remaining=row.mergeParents.length;
      for(const ref of row.mergeParents){
        const request=tables.knowledge.get([ownerId,ref.id]);
        request.onsuccess=()=>{
          const parent=request.result;
          if(!parent||parent.revision!==ref.revision||parent.status!==ref.status||!['candidate','active'].includes(parent.status)){fail(Error('原经验已变化，归并建议需重新整理'));return;}
          parents.push(parent);
          if(--remaining)return;
          for(const item of [...parents,row]){
            const next={...item,status:item.id===id?'active':'merged',canonicalId:item.id===id?null:id,revision:item.revision+1,updatedAt:now};
            tables.knowledge.put(next);
            tables.revisions.put(createRevisionRecord({ownerId,knowledgeId:item.id,revision:next.revision,statement:next.statement,scope:next.scope,status:next.status,parentRefs:row.mergeParents,reason:'用户采纳归并建议',operator:'user',createdAt:now}));
          }
          set({ok:true});
        };
      }
    };
  });
}
