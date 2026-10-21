// Dedicated extension-origin tables: the legacy records 'posts' module is comment-source posts.
export function createPostStore({indexedDB: factory=globalThis.indexedDB, name='xef-own-post-tracking-v1'}={}) {
  let opening;
  async function db() {
    if (!opening) opening=new Promise((resolve,reject)=> {
      const request=factory.open(name,1);
      request.onupgradeneeded=()=> {
        request.result.createObjectStore('posts',{keyPath:['ownerId','postId']}).createIndex('owner','ownerId');
        request.result.createObjectStore('meta',{keyPath:'ownerId'});
        request.result.createObjectStore('intents',{keyPath:'id'});
      };
      request.onerror=()=>{opening=null;reject(request.error);};
      request.onblocked=()=>{opening=null;reject(new Error('帖子记录库升级被占用，请关闭旧面板后重试。'));};
      request.onsuccess=()=>{const value=request.result;value.onversionchange=()=>{value.close();opening=null;};resolve(value);};
    });
    return opening;
  }
  async function transaction(store, mode, action) {
    const connection=await db();
    return new Promise((resolve,reject)=> {
      const tx=connection.transaction(store,mode);let result;
      tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('帖子记录写入中断'));
      action(tx.objectStore(store), value=>{result=value;});
    });
  }
  const get=(store,key)=>transaction(store,'readonly',(s,set)=>{const r=s.get(key);r.onsuccess=()=>set(r.result);});
  const put=(store,value)=>transaction(store,'readwrite',s=>s.put(structuredClone(value)));
  return {
    get:(ownerId,postId)=>get('posts',[ownerId,postId]),
    list:ownerId=>transaction('posts','readonly',(s,set)=>{const r=s.index('owner').getAll(ownerId);r.onsuccess=()=>set(r.result);}),
    put:post=>put('posts',post),
    update:(ownerId,postId,change)=>transaction('posts','readwrite',(s,set)=>{const r=s.get([ownerId,postId]);r.onsuccess=()=>{const next=change(r.result);if(next)s.put(next);set(next);};}),
    putMany:posts=>transaction('posts','readwrite',s=>{for(const p of posts)s.put(structuredClone(p));}),
    meta:ownerId=>get('meta',ownerId), setMeta:value=>put('meta',value),
    intent:id=>get('intents',id), putIntent:value=>put('intents',value)
  };
}
