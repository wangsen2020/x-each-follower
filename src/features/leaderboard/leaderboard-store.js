import {shanghaiDay} from './leaderboard-model.js';

// Keep leaderboard data separate from follow queues and the author's own posts.
export function createLeaderboardStore({indexedDB: factory=globalThis.indexedDB, name='xef-leaderboard-v1'}={}) {
  let opening;
  async function db() {
    if (!opening) opening=new Promise((resolve,reject)=>{
      const request=factory.open(name,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        db.createObjectStore('members',{keyPath:['ownerId','creatorId']}).createIndex('owner','ownerId');
        db.createObjectStore('snapshots',{keyPath:['ownerId','creatorId','day']}).createIndex('creator',['ownerId','creatorId']);
        db.createObjectStore('posts',{keyPath:['ownerId','creatorId','postId']}).createIndex('creator',['ownerId','creatorId']);
        db.createObjectStore('jobs',{keyPath:['ownerId','date']});
        db.createObjectStore('reports',{keyPath:['ownerId','date']}).createIndex('owner','ownerId');
      };
      request.onerror=()=>{opening=null;reject(request.error);};
      request.onblocked=()=>{opening=null;reject(new Error('榜单数据库被旧页面占用'));};
      request.onsuccess=()=>{const value=request.result;value.onversionchange=()=>{value.close();opening=null;};resolve(value);};
    });
    return opening;
  }
  async function transact(table,mode,fn) {
    const connection=await db();
    return new Promise((resolve,reject)=>{
      const tx=connection.transaction(table,mode);let result;
      tx.oncomplete=()=>resolve(result);
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error||new Error('榜单数据事务中断'));
      fn(tx.objectStore(table),value=>{result=value;});
    });
  }
  const read=(table,key)=>transact(table,'readonly',(store,set)=>{const request=store.get(key);request.onsuccess=()=>set(request.result);});
  const write=(table,row)=>transact(table,'readwrite',store=>store.put(structuredClone(row)));
  const byIndex=(table,index,key)=>transact(table,'readonly',(store,set)=>{const request=store.index(index).getAll(key);request.onsuccess=()=>set(request.result||[]);});
  return {
    upsertMember:row=>write('members',row),
    getMember:(ownerId,creatorId)=>read('members',[ownerId,creatorId]),
    listMembers:(ownerId)=>byIndex('members','owner',ownerId),
    appendSnapshot:row=>transact('snapshots','readwrite',(store,set)=>{
      const day=shanghaiDay(row.at),key=[row.ownerId,row.creatorId,day];
      const request=store.get(key);
      request.onsuccess=()=>{
        const previous=request.result;
        const next={...row,day};
        // The first observation of each local day is the comparison baseline.
        if(!previous||next.at<previous.at)store.put(structuredClone(next));
        set(previous&&previous.at<=next.at?previous:next);
      };
    }),
    listSnapshots:(ownerId,creatorId)=>byIndex('snapshots','creator',[ownerId,creatorId]),
    putPost:row=>write('posts',row),
    listPosts:(ownerId,creatorId,{from=-Infinity,to=Infinity}={})=>byIndex('posts','creator',[ownerId,creatorId]).then(rows=>rows.filter(row=>row.createdAt>=from&&row.createdAt<to)),
    putJob:row=>write('jobs',row),
    getJob:(ownerId,date)=>read('jobs',[ownerId,date]),
    putReport:row=>transact('reports','readwrite',(store,set)=>{
      const request=store.get([row.ownerId,row.date]);
      request.onsuccess=()=>{
        const previous=request.result;
        if(previous?.status!=='completed')store.put(structuredClone(row));
        set(previous?.status==='completed'?previous:row);
      };
    }),
    getReport:(ownerId,date)=>read('reports',[ownerId,date]),
    listReports:ownerId=>byIndex('reports','owner',ownerId)
  };
}
