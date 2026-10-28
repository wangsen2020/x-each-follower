import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionLogStore} from '../src/shared/execution-log-store.js';
import {mergePendingLogs} from '../src/shared/log-backup-merge.js';
const storage={get:async()=>({})};
const op=(id,at='2026-10-28T00:00:00Z')=>({op:'put',record:{id,scope:'mutual',origin:'autoFollowLogs',membership:['autoFollow','mutual'],at}});
test('a conflicting sequence automatically merges into one committed chain without overwriting pages',async()=>{
 const saved=new Map(),writes=[];
 const store=createExecutionLogStore({dbName:'logs-auto-rebase',storage,durableGet:async key=>structuredClone(saved.get(key)),durableSet:async(key,value)=>{if(key.includes('BackupPage:')&&saved.has(key))throw Error('page overwrite');saved.set(key,structuredClone(value));writes.push(key);}});
 await store.append(op('first').record);
 saved.set('executionLogBackupPage:2',op('remote'));saved.set('executionLogBackupHead',{n:2});
 const result=await store.append(op('local').record);
 assert.equal(result.backup.ok,true);assert.equal(result.backup.pending,0);
 assert.equal(saved.get('executionLogBackupPage:2').record.id,'remote');
 assert.equal(saved.get('executionLogBackupPage:3').record.id,'local');assert.equal(saved.get('executionLogBackupHead').n,3);
 assert.deepEqual(new Set((await store.query({scope:'mutual'})).entries.map(r=>r.id)),new Set(['first','remote','local']));
});
test('same ID selects the newer complete version and favors committed data on a tie',()=>{
 const remote={...op('same','2026-10-28T02:00:00Z'),record:{...op('same').record,at:'2026-10-28T02:00:00Z',result:'success',name:'kept'}};
 const local={...op('same','2026-10-28T01:00:00Z'),record:{...op('same').record,at:'2026-10-28T01:00:00Z',result:'started',detail:'extra'}};
 const merged=mergePendingLogs([remote],[{seq:2,op:local}])[0].op.record;
 assert.equal(merged.result,'success');assert.equal(merged.detail,undefined);assert.equal(merged.name,'kept');
 assert.equal(mergePendingLogs([remote],[{op:{...remote,record:{...remote.record,result:'failed'}}}])[0].op.record.result,'success');
});
test('explicit record revisions take precedence over event creation time',()=>{
 const remote=op('same','2026-10-28T02:00:00Z');remote.record.revision=2;
 const local=op('same','2026-10-28T01:00:00Z');local.record.revision=3;local.record.result='corrected';
 assert.equal(mergePendingLogs([remote],[{op:local}])[0].op.record.result,'corrected');
});
test('missing committed pages stop reconciliation and retain the pending record',async()=>{
 const saved=new Map();const store=createExecutionLogStore({dbName:'logs-rebase-gap',storage,durableGet:async key=>saved.get(key),durableSet:async(key,value)=>saved.set(key,value)});
 await store.append(op('first').record);saved.set('executionLogBackupHead',{n:3});saved.set('executionLogBackupPage:2',op('remote'));
 const result=await store.append(op('local').record);assert.equal(result.backup.ok,false);assert.match(result.backup.error,/缺失或无效: 3/);
 assert.ok((await store.query({scope:'mutual'})).entries.some(r=>r.id==='local'));assert.equal(saved.get('executionLogBackupPage:2').record.id,'remote');
});
test('two warm writers use the shared lock and refresh the persisted sequence',async()=>{
 let tail=Promise.resolve();const locks={request:(name,options,task)=>{const r=tail.then(task);tail=r.catch(()=>{});return r;}};
 const saved=new Map(),options={dbName:'logs-two-writers',storage,locks,durableGet:async key=>saved.get(key),durableSet:async(key,value)=>{if(key.includes('BackupPage:')&&saved.has(key))throw Error('overwrite');saved.set(key,structuredClone(value));}};
 const a=createExecutionLogStore(options),b=createExecutionLogStore(options);await a.ready();await b.ready();
 await Promise.all([a.append(op('a').record),b.append(op('b').record),a.append(op('c').record),b.append(op('d').record)]);
 assert.equal(saved.get('executionLogBackupHead').n,4);assert.equal(new Set([1,2,3,4].map(i=>saved.get('executionLogBackupPage:'+i).record.id)).size,4);
});
test('explicit retry can recover an exhausted transport retry without resubmitting business operations',async()=>{
 const saved=new Map();let offline=true,writes=0;
 const store=createExecutionLogStore({dbName:'logs-explicit-retry',storage,durableGet:async key=>saved.get(key),durableSet:async(key,value)=>{writes++;if(offline)throw Error('offline');saved.set(key,structuredClone(value));}});
 await store.append(op('local').record);for(let i=0;i<8;i++)await store.ready();const stopped=writes;offline=false;await store.ready();assert.equal(writes,stopped);
 const status=await store.retryBackup();assert.equal(status.ok,true);assert.equal(status.pending,0);assert.equal(saved.get('executionLogBackupPage:1').record.id,'local');
});
