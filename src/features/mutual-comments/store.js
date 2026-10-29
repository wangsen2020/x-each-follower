import Dexie from 'dexie';
import {defaults} from './model.js';
export function createMutualCommentStore({name='xef-mutual-comments-v1',dependencies}={}){
  const db=new Dexie(name,dependencies);
  db.version(1).stores({settings:'ownerId',posts:'[ownerId+postId],ownerId,[ownerId+createdAt]',scans:'id,ownerId'});
  db.version(2).stores({batches:'id,ownerId'}).upgrade(async tx=>{
    await tx.table('settings').toCollection().modify(row=>{const old={...row};Object.assign(row,defaults(row.ownerId),{scanProvider:old.generationProvider||'',scanBotId:old.generationBotId||'',commentProvider:old.generationProvider||'',commentBotId:old.generationBotId||'',scanIntervalMinutes:old.intervalMinutes||60,scrollRounds:old.scrollRounds||5,perRun:old.perScan||3,dailyLimit:old.dailyLimit||10,legacyConfig:old});delete row.enabled;});
    await tx.table('posts').toCollection().modify(row=>{
      row.legacy={status:row.status,relayJobId:row.relayJobId,prompt:row.prompt,raw:row.raw};
      if(typeof row.match==='boolean'&&row.raw){row.tag=row.match?'mutual':'not_mutual';row.tagReason=row.reason;row.taggedAt=row.finishedAt||row.createdAt;row.tagBatchId='legacy';}
      else row.tag='pending';
      if(row.status==='publishing')row.status='uncertain';
      else if(!['posted','uncertain'].includes(row.status))row.status=row.tag==='mutual'?'ready':row.tag==='not_mutual'?'skipped':'idle';
      delete row.relayJobId;delete row.prompt;
    });
  });
  const newer=(a,b)=>a.length-b.length||a.localeCompare(b);
  const trim=async ownerId=>{
    const rows=await db.posts.where('ownerId').equals(ownerId).toArray();
    rows.sort((a,b)=>b.createdAt-a.createdAt||newer(b.postId,a.postId));
    const expired=rows.slice(1000);
    if(expired.length){
      await db.posts.bulkDelete(expired.map(row=>[ownerId,row.postId]));
      const config=await db.settings.get(ownerId),retired=expired.map(r=>r.postId).filter(id=>/^\d+$/.test(id)).sort(newer).at(-1);
      if(retired&&(!config?.retiredPostId||newer(retired,config.retiredPostId)>0))await db.settings.update(ownerId,{retiredPostId:retired});
    }
    const retained=rows.slice(0,1000),refs=new Set(retained.map(row=>row.tagBatchId));
    const batches=await db.batches.where('ownerId').equals(ownerId).toArray();
    await db.batches.bulkDelete(batches.filter(b=>!refs.has(b.id)).map(b=>b.id));
    const scans=(await db.scans.where('ownerId').equals(ownerId).toArray()).sort((a,b)=>b.at-a.at);
    await db.scans.bulkDelete(scans.slice(10).map(row=>row.id));
  };
  const prune=ownerId=>db.transaction('rw',db.posts,db.settings,db.batches,db.scans,()=>trim(ownerId));
  const add=async rows=>{for(const row of rows){const config=await db.settings.get(row.ownerId);if(config?.retiredPostId&&newer(row.postId,config.retiredPostId)<=0)continue;if(!await db.posts.get([row.ownerId,row.postId]))await db.posts.add(row);}};
  return {db,
    enabled:async phase=>(await db.settings.toArray()).some(row=>row[phase+'Enabled']),
    config:id=>db.settings.get(id),saveConfig:row=>db.settings.put(row),updateConfig:(id,value)=>db.settings.update(id,value),
    prune,list:async id=>{await prune(id);return db.posts.where('ownerId').equals(id).toArray();},get:(ownerId,postId)=>db.posts.get([ownerId,postId]),put:row=>db.posts.put(row),
    updatePost:row=>db.posts.update([row.ownerId,row.postId],row),
    addPosts:rows=>db.transaction('rw',db.posts,db.settings,db.batches,db.scans,async()=>{await add(rows);for(const id of new Set(rows.map(r=>r.ownerId)))await trim(id);}),
    checkpoint:(ownerId,rows,anchor,run)=>db.transaction('rw',db.posts,db.settings,db.scans,db.batches,async()=>{await add(rows);await db.settings.update(ownerId,{anchor});await db.scans.put(run);await trim(ownerId);}),
    saveScan:row=>db.scans.put(row),scans:async id=>(await db.scans.where('ownerId').equals(id).toArray()).sort((a,b)=>b.at-a.at).slice(0,10),
    getBatch:id=>db.batches.get(id),
    batches:id=>db.batches.where('ownerId').equals(id).toArray(),saveBatch:row=>db.batches.put(row),
    reserveBatch:batch=>db.transaction('rw',db.posts,db.batches,async()=>{for(const postId of batch.postIds){const row=await db.posts.get([batch.ownerId,postId]);if(row?.tag!=='pending')throw Error('帖子已经进入打标批次');await db.posts.update([batch.ownerId,postId],{tag:'tagging',tagBatchId:batch.id});}await db.batches.put(batch);}),
    finishBatch:(batch,items,at)=>db.transaction('rw',db.posts,db.batches,async()=>{for(const item of items){const key=[batch.ownerId,item.postId],row=await db.posts.get(key);if(!row)continue;if(row.tagBatchId!==batch.id)throw Error('打标归属已变化');await db.posts.update(key,{tag:item.tag,tagReason:item.reason,taggedAt:at,status:row.status==='idle'?(item.tag==='mutual'?'ready':'skipped'):row.status});}await db.batches.put({...batch,status:'completed',finishedAt:at,error:''});}),
    failBatch:(batch,error)=>db.transaction('rw',db.posts,db.batches,async()=>{for(const id of batch.postIds)await db.posts.update([batch.ownerId,id],{tag:'failed',tagReason:error});await db.batches.put({...batch,status:'failed',error});})
  };
}
