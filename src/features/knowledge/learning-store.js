import Dexie from 'dexie';

function trace(previous,row){
  const steps=[...(previous?.steps||[])];
  if(previous?.status!==row.status||row.relayJobId&&row.relayJobId!==previous?.relayJobId)steps.push({at:Date.now(),stage:row.status,detail:row.relayJobId&&row.relayJobId!==previous?.relayJobId?'原任务编号已保存':row.error||''});
  return {...row,steps};
}
function pagination(page=1,pageSize=10){
  if(!Number.isInteger(page)||page<1||![10,20,50].includes(pageSize))throw Error('分页参数无效');
  return {page,pageSize};
}

// Scheduling and delivery checkpoints are separate from the existing evidence library.
export function createLearningStore({name='xef-knowledge-learning-v1',dependencies}={}) {
  const db=new Dexie(name,dependencies);
  db.version(1).stores({settings:'ownerId',runs:'id,ownerId,[ownerId+status]',seen:'[ownerId+key]',uses:'id,ownerId'});
  db.version(2).stores({experienceSources:'[ownerId+knowledgeId+key],ownerId,[ownerId+knowledgeId]',wisdomHeads:'ownerId',wisdomVersions:'[ownerId+version],ownerId',wisdomDrafts:'id,ownerId'});
  db.version(3).stores({runs:'id,ownerId,[ownerId+status],[ownerId+at]',wisdomDrafts:'id,ownerId,[ownerId+at]'}).upgrade(async tx=>{
    for(const name of ['runs','wisdomDrafts'])await tx.table(name).toCollection().modify(row=>{if(!Number.isFinite(row.at))row.at=row.createdAt||row.startedAt||0;});
  });
  async function saveTraced(table,row){return db.transaction('rw',db.table(table),async()=>{await db.table(table).put(trace(await db.table(table).get(row.id),row));});}
  async function versionPage(ownerId,page=1,pageSize=10){
    pagination(page,pageSize);const collection=()=>db.wisdomVersions.where('ownerId').equals(ownerId).reverse(),total=await collection().count();
    page=Math.min(page,Math.max(1,Math.ceil(total/pageSize)));
    const items=(await collection().offset((page-1)*pageSize).limit(pageSize).toArray()).map(({ownerId,version,createdAt,action,trigger,addedIds,experiences})=>({ownerId,version,createdAt,action,trigger,count:experiences.length,addedCount:addedIds?.length||0}));
    return {items,total,page,pageSize};
  }
  async function historyPage(ownerId,{page=1,pageSize=10,scope='all'}={}){
    pagination(page,pageSize);if(!['all','daily','weekly'].includes(scope))throw Error('记录范围无效');
    const query=(name)=>db.table(name).where('[ownerId+at]').between([ownerId,Dexie.minKey],[ownerId,Dexie.maxKey]).reverse().filter(row=>scope==='all'||scope==='daily'&&name==='runs'&&row.kind==='extract'||scope==='weekly'&&name==='wisdomDrafts'&&row.trigger==='weekly');
    const counts=await Promise.all(['runs','wisdomDrafts'].map(name=>query(name).count())),total=counts[0]+counts[1];page=Math.min(page,Math.max(1,Math.ceil(total/pageSize)));
    const candidates=(await Promise.all(['runs','wisdomDrafts'].map(name=>query(name).limit(page*pageSize).toArray()))).flat().sort((a,b)=>b.at-a.at);
    const items=candidates.slice((page-1)*pageSize,page*pageSize).map(({id,kind,trigger,status,at,finishedAt,error,result,steps,version,selected,samples,remainingCount})=>({id,kind:kind==='extract'?'daily':trigger==='weekly'?'weekly':'manual',status,at,finishedAt,error,result,steps:steps||[],version,remainingCount:remainingCount||0,inputCount:(selected||samples||[]).length}));
    return {items,total,page,pageSize};
  }
  return {
    db,
    hasEnabledSettings:async()=> (await db.settings.toArray()).some(row=>row.enabled||row.weeklyEnabled),
    settings:id=>db.settings.get(id), saveSettings:row=>db.settings.put(row),
    runs:id=>db.runs.where('ownerId').equals(id).toArray(),
    saveRun:row=>saveTraced('runs',row),
    historyPage,
    claimDispatch:(table,row,budget)=>db.transaction('rw',db.runs,db.wisdomDrafts,async()=>{
      const old=await db.table(table).get(row.id);if(['cancelled','completed','committed'].includes(old?.status))throw Error('任务状态已变化');if(old?.dispatched)throw Error('请求已提交，请查询原任务');
      const records=[...await db.runs.where('ownerId').equals(row.ownerId).toArray(),...await db.wisdomDrafts.where('ownerId').equals(row.ownerId).toArray()];
      if(records.filter(r=>r.day===row.day&&r.dispatched).length>=budget)throw Error('今日整理预算已用完，明日继续');
      const next=trace(old,row);await db.table(table).put(next);return next;
    }),
    addSources:rows=>db.experienceSources.bulkPut(rows),
    sources:ownerId=>db.experienceSources.where('ownerId').equals(ownerId).toArray(),
    wisdom:ownerId=>db.wisdomHeads.get(ownerId),
    versions:async ownerId=>(await db.wisdomVersions.where('ownerId').equals(ownerId).toArray()).sort((a,b)=>b.version-a.version),
    version:(ownerId,version)=>db.wisdomVersions.get([ownerId,version]),
    versionPage,
    drafts:ownerId=>db.wisdomDrafts.where('ownerId').equals(ownerId).toArray(),
    saveDraft:row=>saveTraced('wisdomDrafts',row),
    commitWisdom:(value,expectedVersion,draftId)=>db.transaction('rw',db.wisdomHeads,db.wisdomVersions,db.wisdomDrafts,async()=>{
      const current=await db.wisdomHeads.get(value.ownerId);
      if((current?.version||0)!==expectedVersion)throw Error('智慧已更新，请基于当前版本重新预览');
      const latest=await db.wisdomVersions.where('ownerId').equals(value.ownerId).reverse().first(),version=(latest?.version||0)+1;
      if(draftId){const draft=await db.wisdomDrafts.get(draftId);if(!draft||draft.ownerId!==value.ownerId||draft.status!=='ready')throw Error('合入预览已变化');await db.wisdomDrafts.put(trace(draft,{...draft,status:'committed',version,finishedAt:Date.now()}));}
      const next={...value,version};
      await db.wisdomVersions.add(next);await db.wisdomHeads.put(next);return next;
    }),
    selectWisdom:(ownerId,version,expectedVersion)=>db.transaction('rw',db.wisdomHeads,db.wisdomVersions,async()=>{
      const current=await db.wisdomHeads.get(ownerId);if((current?.version||0)!==expectedVersion)throw Error('使用中的智慧已变化，请刷新');
      const selected=await db.wisdomVersions.get([ownerId,version]);if(!selected)throw Error('找不到这份智慧');
      await db.wisdomHeads.put({...selected,selectedAt:Date.now()});return selected;
    }),
    seen:(id,key)=>db.seen.get([id,key]),
    complete:run=>db.transaction('rw',db.runs,db.seen,async()=>{
      await db.runs.put(trace(await db.runs.get(run.id),run));
      for(const sample of run.samples||[])await db.seen.put({ownerId:run.ownerId,key:sample.key,hash:sample.hash,at:run.finishedAt});
    }),
    use:row=>db.uses.put(row),
    finishUse:(id,changes)=>db.uses.update(id,changes),
    uses:async id=>(await db.uses.where('ownerId').equals(id).toArray()).sort((a,b)=>b.at-a.at).slice(0,30)
  };
}
export const learningStore=createLearningStore();
