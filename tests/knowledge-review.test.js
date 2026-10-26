import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createKnowledgeStore } from '../src/features/knowledge/knowledge-store.js';
import { createKnowledgeReviewService } from '../src/features/knowledge/knowledge-review.js';
import {
  createKnowledgeRecord,
  createRevisionRecord
} from '../src/features/knowledge/knowledge-model.js';

test('account isolation: knowledge review enforces strict ownerId separation', async () => {
  const idb = new IDBFactory();
  const store = createKnowledgeStore({ indexedDB: idb });
  const reviewService = createKnowledgeReviewService({ store });

  const ownerA = '10001';
  const ownerB = '20002';

  // Owner A creates a candidate
  const createdA = await reviewService.createCandidate({
    ownerId: ownerA,
    id: 'k-a-1',
    type: 'writing_principle',
    statement: '账号 A 的独有写作原则',
    originalText: '账号 A 原始引用文本'
  });

  assert.equal(createdA.ok, true);
  assert.equal(createdA.knowledge.ownerId, ownerA);
  assert.equal(createdA.knowledge.status, 'candidate');

  // Owner B cannot view Owner A's knowledge
  const bList = await reviewService.listKnowledge(ownerB);
  assert.deepEqual(bList, [], 'Owner B 的知识列表必须为空，不得包含 Owner A 的数据');

  const bGet = await reviewService.getKnowledge(ownerB, 'k-a-1');
  assert.equal(bGet, undefined, 'Owner B 无法获取 Owner A 的知识条目');

  // Owner B cannot review Owner A's candidate
  await assert.rejects(
    reviewService.reviewKnowledge({
      ownerId: ownerB,
      knowledgeId: 'k-a-1',
      action: 'approve'
    }),
    /知识条目不存在|无权访问/,
    'Owner B 无法审核 Owner A 的候选知识'
  );

  // Owner A reviews their candidate
  const reviewedA = await reviewService.reviewKnowledge({
    ownerId: ownerA,
    knowledgeId: 'k-a-1',
    action: 'approve',
    reason: '核实无误，采纳'
  });

  assert.equal(reviewedA.ok, true);
  assert.equal(reviewedA.knowledge.status, 'active');
  assert.equal(reviewedA.knowledge.revision, 2);

  // Owner B's view remains completely empty
  const bListAfter = await reviewService.listKnowledge(ownerB);
  assert.deepEqual(bListAfter, []);
});

test('review concurrency: optimistic revision check rejects conflicting concurrent reviews', async () => {
  const idb = new IDBFactory();
  const store = createKnowledgeStore({ indexedDB: idb });
  const reviewService = createKnowledgeReviewService({ store });
  const ownerId = '10002';

  const res = await reviewService.createCandidate({
    ownerId,
    id: 'k-concur-1',
    type: 'pitfall',
    statement: '避免无依据断言'
  });
  assert.equal(res.knowledge.revision, 1);

  // First review succeeds at expectedRevision: 1 -> bumps to 2
  const review1 = await reviewService.reviewKnowledge({
    ownerId,
    knowledgeId: 'k-concur-1',
    action: 'approve',
    expectedRevision: 1
  });
  assert.equal(review1.ok, true);
  assert.equal(review1.knowledge.status, 'active');
  assert.equal(review1.knowledge.revision, 2);

  // Conflicting second review with stale expectedRevision: 1 must fail
  await assert.rejects(
    reviewService.reviewKnowledge({
      ownerId,
      knowledgeId: 'k-concur-1',
      action: 'reject',
      expectedRevision: 1
    }),
    /知识版本冲突：期望版本 1，当前版本 2/,
    '旧版本的并发审核请求必须被乐观锁拦截'
  );

  // Reviewing with fresh revision: 2 succeeds
  const review2 = await reviewService.reviewKnowledge({
    ownerId,
    knowledgeId: 'k-concur-1',
    action: 'reject',
    expectedRevision: 2
  });
  assert.equal(review2.ok, true);
  assert.equal(review2.knowledge.status, 'disabled');
  assert.equal(review2.knowledge.revision, 3);
});

test('repeated review: idempotent repeated review succeeds without duplicate revisions', async () => {
  const idb = new IDBFactory();
  const store = createKnowledgeStore({ indexedDB: idb });
  const reviewService = createKnowledgeReviewService({ store });
  const ownerId = '10003';

  await reviewService.createCandidate({
    ownerId,
    id: 'k-repeat-1',
    type: 'writing_principle',
    statement: '首段亮明核心论点'
  });

  // Initial approve
  const first = await reviewService.reviewKnowledge({
    ownerId,
    knowledgeId: 'k-repeat-1',
    action: 'approve',
    expectedRevision: 1
  });
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.knowledge.status, 'active');
  assert.equal(first.knowledge.revision, 2);

  // Repeated approve (idempotent replay)
  const second = await reviewService.reviewKnowledge({
    ownerId,
    knowledgeId: 'k-repeat-1',
    action: 'approve',
    expectedRevision: 2
  });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.unchanged, true);
  assert.equal(second.knowledge.revision, 2);

  // Check revisions in store
  const revs = await reviewService.listRevisions(ownerId, 'k-repeat-1');
  assert.equal(revs.length, 2, '初始候选版本(1)与首次审核版本(2)，幂等重放不得新增版本快照');
  assert.equal(revs[0].revision, 1);
  assert.equal(revs[0].status, 'candidate');
  assert.equal(revs[1].revision, 2);
  assert.equal(revs[1].status, 'active');

  // Same idempotence for reject on disabled record
  const reject1 = await reviewService.reviewKnowledge({
    ownerId,
    knowledgeId: 'k-repeat-1',
    action: 'reject',
    expectedRevision: 2
  });
  assert.equal(reject1.ok, true);
  assert.equal(reject1.idempotent, false);
  assert.equal(reject1.knowledge.status, 'disabled');
  assert.equal(reject1.knowledge.revision, 3);

  const reject2 = await reviewService.reviewKnowledge({
    ownerId,
    knowledgeId: 'k-repeat-1',
    action: 'reject',
    expectedRevision: 3
  });
  assert.equal(reject2.ok, true);
  assert.equal(reject2.idempotent, true);
  assert.equal(reject2.knowledge.revision, 3);

  const finalRevs = await reviewService.listRevisions(ownerId, 'k-repeat-1');
  assert.equal(finalRevs.length, 3);
});

test('persistence and sources: manual candidate with safe X source URL links immutable evidence and preserves original text', async () => {
  const idb = new IDBFactory();
  const dbName = 'test-knowledge-persistence';
  const store1 = createKnowledgeStore({ indexedDB: idb, name: dbName });
  const service1 = createKnowledgeReviewService({ store: store1 });
  const ownerId = '10004';

  const sourceUrl = 'https://x.com/elonmusk/status/1880000000000000000';
  const originalText = 'Building something great takes relentless iteration.';
  const statement = '持续高频迭代是打磨优质产品的核心要素';

  const res = await service1.createCandidate({
    ownerId,
    id: 'k-with-evidence',
    type: 'conditional_observation',
    statement,
    originalText,
    sourceUrl,
    relation: 'support',
    reason: '推文展示高频迭代的真实案例'
  });

  assert.equal(res.ok, true);
  assert.ok(res.evidence, '必须创建证据记录');
  assert.equal(res.evidence.url, sourceUrl);
  assert.equal(res.evidence.postId, '1880000000000000000');
  assert.equal(res.evidence.handleAtCapture, 'elonmusk');
  assert.equal(res.knowledge.originalText, originalText);

  // Close and reopen store to verify persistence
  await store1.close();

  const store2 = createKnowledgeStore({ indexedDB: idb, name: dbName });
  const service2 = createKnowledgeReviewService({ store: store2 });

  const persisted = await service2.getKnowledgeWithDetails(ownerId, 'k-with-evidence');
  assert.ok(persisted);
  assert.equal(persisted.knowledge.statement, statement);
  assert.equal(persisted.knowledge.originalText, originalText);
  assert.equal(persisted.evidence.length, 1);
  assert.equal(persisted.evidence[0].url, sourceUrl);
  assert.equal(persisted.evidence[0].relation, 'support');
  assert.equal(persisted.revisions.length, 1);
  assert.equal(persisted.revisions[0].originalText, originalText);

  await store2.close();
});

test('persistence and sources: unsafe source URLs are strictly rejected', async () => {
  const idb = new IDBFactory();
  const store = createKnowledgeStore({ indexedDB: idb });
  const reviewService = createKnowledgeReviewService({ store });
  const ownerId = '10005';

  const unsafeUrls = [
    'javascript:alert(1)',
    'http://x.com/user/status/123',
    'https://evil.attacker.com/status/123',
    'https://x.com.phishing.org/user/status/123',
    'ftp://x.com/user/status/123'
  ];

  for (const badUrl of unsafeUrls) {
    await assert.rejects(
      reviewService.createCandidate({
        ownerId,
        type: 'writing_principle',
        statement: '测试不安全 URL 防护',
        sourceUrl: badUrl
      }),
      /来源链接必须是有效的 X \(Twitter\) 链接/,
      `应拦截不安全来源 URL: ${badUrl}`
    );
  }
});

test('existing knowledge records may have revision zero or one, and review bumps cleanly', async () => {
  const idb = new IDBFactory();
  const store = createKnowledgeStore({ indexedDB: idb });
  const reviewService = createKnowledgeReviewService({ store });
  const ownerId = '10006';

  // Seed existing knowledge record with revision: 0
  const kRev0 = createKnowledgeRecord({
    ownerId,
    id: 'k-zero',
    type: 'writing_principle',
    statement: '历史迁移而来的版本 0 知识',
    status: 'candidate',
    revision: 0
  });
  await store.putKnowledge(kRev0);
  assert.equal(kRev0.revision, 0, '模型必须如实保留 revision 0');

  // Reviewing revision 0 bumps to revision 1
  const rev0Result = await reviewService.reviewKnowledge({
    ownerId,
    knowledgeId: 'k-zero',
    action: 'approve',
    expectedRevision: 0
  });
  assert.equal(rev0Result.ok, true);
  assert.equal(rev0Result.knowledge.revision, 1);
  assert.equal(rev0Result.knowledge.status, 'active');
  assert.equal(rev0Result.revision.revision, 1);

  // Seed existing knowledge record with revision: 1
  const kRev1 = createKnowledgeRecord({
    ownerId,
    id: 'k-one',
    type: 'pitfall',
    statement: '历史录入的版本 1 知识',
    status: 'candidate',
    revision: 1
  });
  await store.putKnowledge(kRev1);
  assert.equal(kRev1.revision, 1);

  // Reviewing revision 1 bumps to revision 2
  const rev1Result = await reviewService.reviewKnowledge({
    ownerId,
    knowledgeId: 'k-one',
    action: 'reject',
    expectedRevision: 1
  });
  assert.equal(rev1Result.ok, true);
  assert.equal(rev1Result.knowledge.revision, 2);
  assert.equal(rev1Result.knowledge.status, 'disabled');
  assert.equal(rev1Result.revision.revision, 2);
});

test('honest empty state and status filtering', async () => {
  const idb = new IDBFactory();
  const store = createKnowledgeStore({ indexedDB: idb });
  const reviewService = createKnowledgeReviewService({ store });
  const ownerId = '10007';

  // Empty state is honestly empty
  const initial = await reviewService.listKnowledge(ownerId);
  assert.deepEqual(initial, []);

  // Add 3 candidates
  const c1 = await reviewService.createCandidate({
    ownerId,
    id: 'item-1',
    type: 'writing_principle',
    statement: '原则一'
  });
  const c2 = await reviewService.createCandidate({
    ownerId,
    id: 'item-2',
    type: 'pitfall',
    statement: '陷阱一'
  });
  const c3 = await reviewService.createCandidate({
    ownerId,
    id: 'item-3',
    type: 'conditional_observation',
    statement: '观察一'
  });

  // Approve item-1 -> active
  await reviewService.reviewKnowledge({ ownerId, knowledgeId: 'item-1', action: 'approve' });
  // Reject item-2 -> disabled
  await reviewService.reviewKnowledge({ ownerId, knowledgeId: 'item-2', action: 'reject' });
  // item-3 stays candidate

  const candidates = await reviewService.listKnowledge(ownerId, { status: 'candidate' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'item-3');

  const actives = await reviewService.listKnowledge(ownerId, { status: 'active' });
  assert.equal(actives.length, 1);
  assert.equal(actives[0].id, 'item-1');

  const disableds = await reviewService.listKnowledge(ownerId, { status: 'disabled' });
  assert.equal(disableds.length, 1);
  assert.equal(disableds[0].id, 'item-2');

  const all = await reviewService.listKnowledge(ownerId);
  assert.equal(all.length, 3);
});
