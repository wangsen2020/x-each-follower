import test from 'node:test';
import assert from 'node:assert/strict';
import {appendExecutionLog,selectExecutionLogs} from '../execution-log.js';
test('concurrent worker and panel append operations preserve both records and old history', async()=>{
  let saved=[{id:'old',scope:'mutual',at:'2026-10-16T00:00:00Z'}];
  const storage={get:async()=>({autoFollowLogs:structuredClone(saved)}),set:async data=>{saved=structuredClone(data.autoFollowLogs)}};
  await Promise.all([appendExecutionLog({scope:'comment',detail:'alarm'},storage),appendExecutionLog({scope:'mutual',detail:'panel'},storage)]);
  assert.equal(saved.length,3);
  assert.equal(new Set(saved.map(x=>x.id)).size,3);
  assert.equal(saved.filter(x=>x.scope==='comment').length,1);
});
test('comment log view excludes old mutual tests and orders newest first without changing storage',()=>{
  const logs=[{id:'old-comment',scope:'comment',at:'2026-10-16'}, {id:'new-comment',scope:'comment',at:'2026-10-17'},{id:'mutual',scope:'mutual',at:'2026-10-18'}];
  assert.deepEqual(selectExecutionLogs(logs,'comment').map(x=>x.id),['new-comment','old-comment']);
  assert.equal(logs[0].id,'old-comment');
});
test('a failed write does not block later logging',async()=>{
  await assert.rejects(appendExecutionLog({scope:'comment'},{get:async()=>{throw Error('storage failed')}}));
  const logs=await appendExecutionLog({scope:'comment',result:'started'},{get:async()=>({}),set:async()=>{}});
  assert.equal(logs[0].result,'started');
});
