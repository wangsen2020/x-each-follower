import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createKnowledgeStore} from '../src/features/knowledge/knowledge-store.js';
import {createKnowledgeReviewService} from '../src/features/knowledge/knowledge-review.js';

function fixture() {
  const store = createKnowledgeStore({indexedDB:new IDBFactory()});
  return {store, service:createKnowledgeReviewService({store})};
}

test('manual creation cannot overwrite an existing record by reusing its ID', async () => {
  const {store,service} = fixture();
  await service.createCandidate({ownerId:'1',id:'same',statement:'原有内容'});
  await assert.rejects(service.createCandidate({ownerId:'1',id:'same',statement:'不同内容'}));
  assert.equal((await store.getKnowledge('1','same')).statement,'原有内容');
  assert.equal((await store.listRevisions('1','same')).length,1);
});

test('a manual source URL is a reference, never a fabricated captured post', async () => {
  const {service} = fixture();
  await service.createCandidate({ownerId:'1',id:'source',statement:'这是知识结论',sourceUrl:'https://x.com/test/status/123'});
  const {evidence} = await service.getKnowledgeWithDetails('1','source');
  assert.equal(evidence.length,1);
  assert.equal(evidence[0].text,'');
  assert.equal(evidence[0].availability,'legacy_reference');
});

test('review preserves an existing revision and a missing original baseline', async () => {
  const {store,service} = fixture();
  const {knowledge} = await service.createCandidate({ownerId:'1',id:'old',statement:'待审核原文'});
  await store.runTransaction(['revisions'],'readwrite',stores=>stores.revisions.delete(['1','old',1]));
  await service.reviewKnowledge({ownerId:'1',knowledgeId:'old',action:'approve',expectedRevision:1});
  const revisions = await store.listRevisions('1','old');
  assert.equal(revisions.length,2);
  assert.equal(revisions[0].statement,knowledge.statement);
  assert.equal(revisions[0].status,'candidate');
  assert.equal(revisions[1].status,'active');
});

test('a changed rejection reason is not silently treated as the same review', async () => {
  const {store,service} = fixture();
  await service.createCandidate({ownerId:'1',id:'review',statement:'观点'});
  await service.reviewKnowledge({ownerId:'1',knowledgeId:'review',action:'reject',expectedRevision:1,reason:'缺少依据'});
  await assert.rejects(service.reviewKnowledge({ownerId:'1',knowledgeId:'review',action:'reject',expectedRevision:1,reason:'条件错误'}),/冲突|更新|版本/);
  assert.equal((await store.listRevisions('1','review')).length,2);
});

test('review refuses to overwrite a pre-existing future snapshot and rolls back status', async () => {
  const {store,service} = fixture();
  await service.createCandidate({ownerId:'1',id:'collision',statement:'观点'});
  await store.runTransaction(['revisions'],'readwrite',stores=>stores.revisions.add({ownerId:'1',knowledgeId:'collision',revision:2,statement:'保留的历史'}));
  await assert.rejects(service.reviewKnowledge({ownerId:'1',knowledgeId:'collision',action:'approve',expectedRevision:1}));
  assert.equal((await store.getKnowledge('1','collision')).status,'candidate');
  assert.equal((await store.getRevision('1','collision',2)).statement,'保留的历史');
});
