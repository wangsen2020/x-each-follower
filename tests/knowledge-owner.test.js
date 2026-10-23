import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeOwner} from '../src/features/knowledge/knowledge-owner.js';

test('knowledge writes revalidate live account and reject stale owner after switching', async () => {
  let current = '123';
  const owner = createKnowledgeOwner({resolve:async()=>({ok:true,accountId:current})});
  assert.equal(await owner.current(),'123');
  current = '456';
  await assert.rejects(owner.assert('123'),/账号已变化/);
  assert.equal(await owner.assert('456'),'456');
});

test('knowledge owner accepts numeric account ID, never a nickname or failed lookup', async () => {
  for (const result of [{ok:true,accountId:'Watson'},{ok:false,accountId:'123'},{}]) {
    await assert.rejects(createKnowledgeOwner({resolve:async()=>result}).current());
  }
});

test('knowledge owner timeout settles and never resumes a write from late identity', async () => {
  let resolve;
  const owner = createKnowledgeOwner({timeoutMs:5,resolve:()=>new Promise(r=>{resolve=r;})});
  let writes = 0;
  await assert.rejects(owner.assert('123').then(()=>{writes++;}),/超时/);
  resolve({ok:true,accountId:'123'});
  await new Promise(r=>setImmediate(r));
  assert.equal(writes,0);
});
