import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createKnowledgeStore } from '../src/features/knowledge/knowledge-store.js';
import { createKnowledgeQueue } from '../src/features/knowledge/knowledge-queue.js';

test('frozen evidence rejects changed metrics and capture time', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'frozen-evidence-owner';
  const enqueued = await queue.enqueueAnalysis({
    ownerId, clientRequestId: 'request', producer: 'test',
    sourceRefs: [{ postId: 'p1', text: '原文', metrics: { views: 10 }, capturedAt: 1000 }],
    analysisSpec: { kind: 'metric_review', version: 1, dependsOnMetrics: true }
  });
  const job = await store.getJob(ownerId, enqueued.jobId);
  await store.putJob({ ...job, inputManifest: { ...job.inputManifest, frozen: true } });
  const base = { ownerId, jobId: enqueued.jobId, candidates: [], businessResults: { score: 1 } };
  await assert.rejects(queue.ingestAnalysisResult({
    ...base, inputEvidenceList: [{ postId: 'p1', text: '原文', metrics: { views: 99 }, capturedAt: 1000 }]
  }), /指标与冻结清单不一致/);
  await assert.rejects(queue.ingestAnalysisResult({
    ...base, inputEvidenceList: [{ postId: 'p1', text: '原文', metrics: { views: 10 }, capturedAt: 2000 }]
  }), /采集时间与冻结清单不一致/);
  assert.equal((await store.getJob(ownerId, enqueued.jobId)).status, 'queued');
  await store.close();
});

test('delivery replay never marks unfinished or resultless work as delivered', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const args = {
    ownerId: 'delivery-safety',
    clientRequestId: 'first',
    producer: 'test',
    sourceRefs: [{ postId: 'p1', text: '样本' }],
    analysisSpec: { kind: 'review', version: 1 }
  };
  const enqueued = await queue.enqueueAnalysis(args);
  const before = await queue.replayDelivery({ ownerId: args.ownerId, requestId: enqueued.requestId });
  assert.equal(before.delivered, false);
  assert.equal((await store.getRequest(args.ownerId, enqueued.requestId)).deliveryStatus, 'pending');
  await assert.rejects(
    queue.acknowledgeDelivery({ ownerId: args.ownerId, requestId: enqueued.requestId }),
    /尚未交付/
  );

  // Simulate an old completed checkpoint whose result was never durably saved.
  const job = await store.getJob(args.ownerId, enqueued.jobId);
  await store.putJob({ ...job, status: 'completed' });
  const replay = await queue.replayDelivery({ ownerId: args.ownerId, jobId: enqueued.jobId });
  assert.equal(replay.deliveredCount, 0);
  await assert.rejects(
    queue.enqueueAnalysis({ ...args, clientRequestId: 'second' }),
    /缺少可恢复的业务结果/
  );
  assert.equal((await store.getRequest(args.ownerId, enqueued.requestId)).deliveryStatus, 'pending');
  await store.close();
});

test('idempotent enqueue returns existing request on duplicate clientRequestId and shares jobs for matching executionKey', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let fakeTime = 1000;
  const queue = createKnowledgeQueue({
    store,
    now: () => fakeTime
  });

  const sourceRefs = [{ postId: 'p-1', text: '样本1' }, { postId: 'p-2', text: '样本2' }];

  // 1. First enqueue creates a fresh job and request
  const enq1 = await queue.enqueueAnalysis({
    ownerId: 'owner-1',
    clientRequestId: 'client-req-001',
    producer: 'test_producer',
    sourceRefs,
    analysisSpec: { kind: 'own_post_review', version: 1 }
  });

  assert.equal(enq1.created, true);
  assert.ok(enq1.jobId);
  assert.ok(enq1.requestId);

  // 2. Duplicate clientRequestId for the same owner returns the existing request (Idempotency)
  const enq1Dup = await queue.enqueueAnalysis({
    ownerId: 'owner-1',
    clientRequestId: 'client-req-001',
    producer: 'test_producer',
    sourceRefs,
    analysisSpec: { kind: 'own_post_review', version: 1 }
  });

  assert.equal(enq1Dup.reused, true);
  assert.equal(enq1Dup.requestId, enq1.requestId);
  assert.equal(enq1Dup.jobId, enq1.jobId);

  // 3. Different clientRequestId with matching executionKey subscribes to the same job
  const enq2 = await queue.enqueueAnalysis({
    ownerId: 'owner-1',
    clientRequestId: 'client-req-002',
    producer: 'second_producer',
    sourceRefs,
    analysisSpec: { kind: 'own_post_review', version: 1 }
  });

  assert.equal(enq2.subscribed, true);
  assert.equal(enq2.jobId, enq1.jobId);
  assert.notEqual(enq2.requestId, enq1.requestId);

  // 4. Same clientRequestId under a different ownerId is strictly isolated and creates a new job
  const enqOtherOwner = await queue.enqueueAnalysis({
    ownerId: 'owner-2',
    clientRequestId: 'client-req-001',
    producer: 'test_producer',
    sourceRefs,
    analysisSpec: { kind: 'own_post_review', version: 1 }
  });

  assert.equal(enqOtherOwner.created, true);
  assert.notEqual(enqOtherOwner.jobId, enq1.jobId);

  await store.close();
});

test('request abort and cancellation rules: cancels unsubmitted jobs, preserves submitted executions, and supports partial subscriber cancellation', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });

  const sourceRefs = [{ postId: 'p-1', text: '样本1' }];

  // Case 1: Single request cancelled before submission -> cancels underlying job
  const enq1 = await queue.enqueueAnalysis({
    ownerId: 'user_cancel',
    clientRequestId: 'req-single',
    producer: 'test',
    sourceRefs,
    analysisSpec: { kind: 'review', version: 1 }
  });

  const cancelResult1 = await queue.cancelAnalysisRequest({
    ownerId: 'user_cancel',
    requestId: enq1.requestId
  });

  assert.equal(cancelResult1.requestCancelled, true);
  assert.equal(cancelResult1.jobCancelled, true);

  const job1 = await store.getJob('user_cancel', enq1.jobId);
  assert.equal(job1.status, 'cancelled');

  // Case 2: Multi-subscriber: Request A and Request B share Job 2. Request A cancels -> Job 2 remains active
  const subA = await queue.enqueueAnalysis({
    ownerId: 'user_cancel',
    clientRequestId: 'sub-A',
    producer: 'test',
    sourceRefs: [{ postId: 'p-99', text: '共享样本' }],
    analysisSpec: { kind: 'shared', version: 1 }
  });
  const subB = await queue.enqueueAnalysis({
    ownerId: 'user_cancel',
    clientRequestId: 'sub-B',
    producer: 'test',
    sourceRefs: [{ postId: 'p-99', text: '共享样本' }],
    analysisSpec: { kind: 'shared', version: 1 }
  });

  assert.equal(subA.jobId, subB.jobId);

  const cancelA = await queue.cancelAnalysisRequest({
    ownerId: 'user_cancel',
    requestId: subA.requestId
  });

  assert.equal(cancelA.requestCancelled, true);
  assert.equal(cancelA.jobCancelled, false);
  assert.equal(cancelA.remainingActiveRequests, 1);

  const job2 = await store.getJob('user_cancel', subA.jobId);
  assert.equal(job2.status, 'queued', 'Job 仍保持活跃，因为仍有 subscriber B');

  // Case 3: Job is already 'submitted'. Subscriber cancels -> Job is NOT cancelled
  const subSubmitted = await queue.enqueueAnalysis({
    ownerId: 'user_cancel',
    clientRequestId: 'req-submitted',
    producer: 'test',
    sourceRefs: [{ postId: 'p-sub', text: '已提交样本' }],
    analysisSpec: { kind: 'sub', version: 1 }
  });

  await queue.advanceJobStage({
    ownerId: 'user_cancel',
    jobId: subSubmitted.jobId,
    expectedStage: 'queued',
    nextStage: 'submitted',
    data: { submittedAt: 12345 }
  });

  const cancelSubmitted = await queue.cancelAnalysisRequest({
    ownerId: 'user_cancel',
    requestId: subSubmitted.requestId
  });

  assert.equal(cancelSubmitted.requestCancelled, true);
  assert.equal(cancelSubmitted.jobCancelled, false);
  assert.equal(cancelSubmitted.reason, 'job_status_is_submitted');

  const jobSub = await store.getJob('user_cancel', subSubmitted.jobId);
  assert.equal(jobSub.status, 'submitted');

  await store.close();
});

test('checkpoint progression and lease timeout recovery: transitions expired submitted jobs to uncertain', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let currentTime = 100000;
  const queue = createKnowledgeQueue({
    store,
    now: () => currentTime,
    defaultLeaseMs: 60000
  });

  const enq = await queue.enqueueAnalysis({
    ownerId: 'recovery_user',
    clientRequestId: 'req-recover',
    producer: 'test',
    sourceRefs: [{ postId: 'rec-1', text: '恢复样本' }]
  });

  // Advance to resolving_data with lease
  await queue.advanceJobStage({
    ownerId: 'recovery_user',
    jobId: enq.jobId,
    expectedStage: 'queued',
    nextStage: 'resolving_data',
    leaseMs: 50000
  });

  let job = await store.getJob('recovery_user', enq.jobId);
  assert.equal(job.status, 'resolving_data');
  assert.equal(job.lease, 150000);

  // Advance time past lease
  currentTime = 160000;
  const recover1 = await queue.recoverInterruptedJobs({ ownerId: 'recovery_user' });
  assert.equal(recover1.recoveredCount, 1);
  assert.equal(recover1.recoveredJobs[0].status, 'retry_wait');

  // Next advance to submitted
  await queue.advanceJobStage({
    ownerId: 'recovery_user',
    jobId: enq.jobId,
    expectedStage: 'retry_wait',
    nextStage: 'submitted',
    leaseMs: 30000
  });

  job = await store.getJob('recovery_user', enq.jobId);
  assert.equal(job.status, 'submitted');
  assert.equal(job.lease, 190000);

  // Advance time past lease for submitted job -> must become 'uncertain'
  currentTime = 200000;
  const recover2 = await queue.recoverInterruptedJobs({ ownerId: 'recovery_user' });
  assert.equal(recover2.recoveredCount, 1);
  assert.equal(recover2.recoveredJobs[0].status, 'uncertain');
  assert.ok(recover2.recoveredJobs[0].error.includes('未决'));

  await store.close();
});

test('exact duplicate evidence linkage and duplicate source protection', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let currentTime = 50000;
  const queue = createKnowledgeQueue({
    store,
    now: () => currentTime
  });

  const ownerId = 'linkage_user';

  // 1. Attempt ingestion with candidate referencing unauthorized/foreign postId -> REJECTED
  const enqJob1 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'ingest-req-1',
    producer: 'test',
    sourceRefs: [{ postId: 'post-101', text: '第一篇分析推文' }]
  });

  await assert.rejects(
    async () => {
      await queue.ingestAnalysisResult({
        ownerId,
        jobId: enqJob1.jobId,
        inputEvidenceList: [{ postId: 'post-101', text: '第一篇分析推文' }],
        candidates: [
          {
            type: 'writing_principle',
            statement: '明确先给出结论',
            evidencePostIds: ['foreign-post-999'] // Not in inputEvidenceList!
          }
        ]
      });
    },
    /候选知识引用了未提交或非法的样本依据/
  );

  // 2. Ingest first valid analysis with Post 101 -> creates Knowledge K1 and links Post 101
  const validResult1 = await queue.ingestAnalysisResult({
    ownerId,
    jobId: enqJob1.jobId,
    inputEvidenceList: [{ postId: 'post-101', text: '第一篇分析推文', authorId: 'auth-A' }],
    candidates: [
      {
        type: 'writing_principle',
        statement: '明确先给出结论',
        scope: { topic: 'writing' },
        evidencePostIds: ['post-101'],
        reason: 'Post 101 提供支撑'
      }
    ],
    businessResults: { reviewScore: 9 }
  });

  assert.equal(validResult1.knowledgeCreated, 1);
  assert.equal(validResult1.knowledgeReused, 0);
  assert.equal(validResult1.evidenceLinked, 1);
  assert.equal(validResult1.deliveredRequests, 1);

  const knowledgeList1 = await store.listKnowledge(ownerId);
  assert.equal(knowledgeList1.length, 1);
  const k1 = knowledgeList1[0];
  assert.equal(k1.statement, '明确先给出结论');
  assert.equal(k1.status, 'candidate');
  assert.equal(k1.revision, 1);

  const initialEvLinks = await store.listEvidenceForKnowledge(ownerId, k1.id);
  assert.equal(initialEvLinks.length, 1);
  assert.equal(initialEvLinks[0].postId, 'post-101');

  // 3. Ingest second analysis with Post 202 providing the EXACT SAME knowledge (identical fingerprint)
  currentTime = 60000;
  const enqJob2 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'ingest-req-2',
    producer: 'test_second',
    sourceRefs: [{ postId: 'post-202', text: '第二篇分析推文，不同推文' }]
  });

  const validResult2 = await queue.ingestAnalysisResult({
    ownerId,
    jobId: enqJob2.jobId,
    inputEvidenceList: [{ postId: 'post-202', text: '第二篇分析推文，不同推文', authorId: 'auth-B' }],
    candidates: [
      {
        type: 'writing_principle',
        statement: '  明确先给出结论  ', // Same statement with extra whitespace
        scope: { topic: 'writing' },     // Same scope
        evidencePostIds: ['post-202'],
        reason: 'Post 202 也是该写法的生动案例'
      }
    ],
    businessResults: { reviewScore: 8 }
  });

  // EXACT DUPLICATE VERIFICATION:
  // Must NOT create a second knowledge record! Must reuse existing knowledge and link new evidence!
  assert.equal(validResult2.knowledgeCreated, 0, '精确重复知识不新建知识条目');
  assert.equal(validResult2.knowledgeReused, 1, '精确重复知识复用已有条目');
  assert.equal(validResult2.evidenceLinked, 1, '新证据建立链接');

  const knowledgeList2 = await store.listKnowledge(ownerId);
  assert.equal(knowledgeList2.length, 1, '知识库条目总量仍为 1，无重复行');
  assert.equal(knowledgeList2[0].id, k1.id);
  assert.equal(knowledgeList2[0].updatedAt, 60000, '更新时间被刷新');

  // Check linked evidence: K1 must now link BOTH Post 101 and Post 202!
  const combinedEvLinks = await store.listEvidenceForKnowledge(ownerId, k1.id);
  assert.equal(combinedEvLinks.length, 2, '知识同时关联了两个来源推文证据');
  const postIds = combinedEvLinks.map(e => e.postId).sort();
  assert.deepEqual(postIds, ['post-101', 'post-202']);

  await store.close();
});

test('enqueue regression: atomic dedupe under concurrent requests using unique indexes and one transaction', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_concurrent';

  // 1. Concurrent requests with exact same clientRequestId
  const sourceRefs = [{ postId: 'c-1', text: '并发推文样本' }];
  const concurrentCalls = Array.from({ length: 5 }, (_, i) =>
    queue.enqueueAnalysis({
      ownerId,
      clientRequestId: 'concurrent-req-123',
      producer: `producer_${i}`,
      sourceRefs,
      analysisSpec: { kind: 'concurrent_test', version: 1 }
    })
  );

  const results = await Promise.all(concurrentCalls);
  const createdCount = results.filter(r => r.created).length;
  const reusedCount = results.filter(r => r.reused).length;

  assert.equal(createdCount, 1, '并发完全相同的 clientRequestId 只能有 1 个标记为 created');
  assert.equal(reusedCount, 4, '其余并发请求必须标记为 reused');

  const allReqs = await store.listRequestsForJob(ownerId, results[0].jobId);
  assert.equal(allReqs.length, 1, '数据库中最终只存在 1 条请求记录');

  // 2. Concurrent requests with different clientRequestId but identical executionKey
  const sharedCalls = Array.from({ length: 5 }, (_, i) =>
    queue.enqueueAnalysis({
      ownerId,
      clientRequestId: `shared-client-req-${i}`,
      producer: `producer_${i}`,
      sourceRefs,
      analysisSpec: { kind: 'shared_job_test', version: 1 }
    })
  );

  const sharedResults = await Promise.all(sharedCalls);
  const sharedCreated = sharedResults.filter(r => r.created).length;
  const sharedSubscribed = sharedResults.filter(r => r.subscribed).length;

  assert.equal(sharedCreated, 1, '相同 executionKey 的并发请求只创建 1 个 Job');
  assert.equal(sharedSubscribed, 4, '其余并发请求订阅同一 Job');

  const sharedJobId = sharedResults[0].jobId;
  for (const res of sharedResults) {
    assert.equal(res.jobId, sharedJobId, '所有并发请求关联同一 Job ID');
  }

  const jobRequests = await store.listRequestsForJob(ownerId, sharedJobId);
  assert.equal(jobRequests.length, 5, '该 Job 关联了全部 5 条并发请求');

  await store.close();
});

test('ingest regression: verifies candidate refs against frozen job input manifest', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_manifest_test';

  // Enqueue job with frozen input manifest containing only 'frozen-post-1'
  const enq = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-manifest-check',
    producer: 'test',
    sourceRefs: [{ postId: 'frozen-post-1', text: '清单内部样本' }]
  });

  // Attempt ingest with a candidate referencing 'foreign-post-2', which is NOT in frozen input manifest
  await assert.rejects(
    async () => {
      await queue.ingestAnalysisResult({
        ownerId,
        jobId: enq.jobId,
        inputEvidenceList: [
          { postId: 'frozen-post-1', text: '清单内部样本' },
          { postId: 'foreign-post-2', text: '清单外部样本' }
        ],
        candidates: [
          {
            type: 'writing_principle',
            statement: '未在清单中的推文',
            evidencePostIds: ['foreign-post-2']
          }
        ]
      });
    },
    /未在任务输入清单中/
  );

  await store.close();
});

test('ingest regression: idempotent on replay', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_replay_test';

  const enq = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-replay',
    producer: 'test',
    sourceRefs: [{ postId: 'post-replay-1', text: '可重放推文' }]
  });

  // First ingest
  const firstIngest = await queue.ingestAnalysisResult({
    ownerId,
    jobId: enq.jobId,
    inputEvidenceList: [{ postId: 'post-replay-1', text: '可重放推文' }],
    candidates: [
      {
        type: 'writing_principle',
        statement: '重放测试准则',
        evidencePostIds: ['post-replay-1']
      }
    ],
    businessResults: { score: 100 }
  });

  assert.equal(firstIngest.knowledgeCreated, 1);
  assert.equal(firstIngest.ok, true);

  // Replay ingest on the same completed job
  const replayedIngest = await queue.ingestAnalysisResult({
    ownerId,
    jobId: enq.jobId,
    inputEvidenceList: [{ postId: 'post-replay-1', text: '可重放推文' }],
    candidates: [
      {
        type: 'writing_principle',
        statement: '重放测试准则',
        evidencePostIds: ['post-replay-1']
      }
    ],
    businessResults: { score: 100 }
  });

  assert.equal(replayedIngest.ok, true);
  assert.equal(replayedIngest.replayed, true, '重放已完成任务时返回 replayed: true');
  assert.equal(replayedIngest.analysisId, firstIngest.analysisId);

  // Verify database has no duplicate knowledge
  const allKnowledge = await store.listKnowledge(ownerId);
  assert.equal(allKnowledge.length, 1, '重放未产生重复知识');

  await store.close();
});

test('ingest regression: dedupes duplicate fingerprints within the same batch', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_batch_dedupe';

  const enq = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-batch-dedupe',
    producer: 'test',
    sourceRefs: [
      { postId: 'post-b-1', text: '批次样本1' },
      { postId: 'post-b-2', text: '批次样本2' }
    ]
  });

  // Ingest with TWO candidates in the SAME batch having identical fingerprint
  const ingestRes = await queue.ingestAnalysisResult({
    ownerId,
    jobId: enq.jobId,
    inputEvidenceList: [
      { postId: 'post-b-1', text: '批次样本1' },
      { postId: 'post-b-2', text: '批次样本2' }
    ],
    candidates: [
      {
        type: 'writing_principle',
        statement: '标题必须明确提出问题',
        scope: { topic: 'copywriting' },
        evidencePostIds: ['post-b-1'],
        reason: '样本1验证'
      },
      {
        type: 'writing_principle',
        statement: '  标题必须明确提出问题  ', // Identical statement normalized
        scope: { topic: 'copywriting' },       // Identical scope
        evidencePostIds: ['post-b-2'],
        reason: '样本2验证'
      }
    ]
  });

  // Exactly 1 knowledge created, 1 reused within the batch
  assert.equal(ingestRes.knowledgeCreated, 1, '同批次相同指纹只创建 1 条知识记录');
  assert.equal(ingestRes.knowledgeReused, 1, '同批次重复指纹计入 knowledgeReused');
  assert.equal(ingestRes.evidenceLinked, 2, '关联了两条不同样本证据');

  const knowledgeList = await store.listKnowledge(ownerId);
  assert.equal(knowledgeList.length, 1, '知识库仅有 1 条知识记录');

  const evLinks = await store.listEvidenceForKnowledge(ownerId, knowledgeList[0].id);
  assert.equal(evLinks.length, 2, '知识条目成功关联了两条样本证据');
  const postIds = evLinks.map(e => e.postId).sort();
  assert.deepEqual(postIds, ['post-b-1', 'post-b-2']);

  await store.close();
});

test('ingest regression: rejects empty or mismatched frozen manifest content', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_manifest_negative_test';

  const enq = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-manifest-strict',
    producer: 'test',
    sourceRefs: [{ postId: 'p-frozen-1', text: '清单中的真实文本' }]
  });

  // 1. Rejects empty inputEvidenceList
  await assert.rejects(
    async () => {
      await queue.ingestAnalysisResult({
        ownerId,
        jobId: enq.jobId,
        inputEvidenceList: [],
        candidates: [{ type: 'writing_principle', statement: '准则', evidencePostIds: ['p-frozen-1'] }]
      });
    },
    /输入样本列表为空/
  );

  // 2. Rejects mismatched text content between inputEvidenceList and frozen manifest
  await assert.rejects(
    async () => {
      await queue.ingestAnalysisResult({
        ownerId,
        jobId: enq.jobId,
        inputEvidenceList: [{ postId: 'p-frozen-1', text: '篡改的假文本' }],
        candidates: [{ type: 'writing_principle', statement: '准则', evidencePostIds: ['p-frozen-1'] }]
      });
    },
    /不一致/
  );

  // 3. Rejects empty manifest on job
  await store.runTransaction(['jobs'], 'readwrite', (stores, set) => {
    const jReq = stores.jobs.get([ownerId, enq.jobId]);
    jReq.onsuccess = () => {
      const j = jReq.result;
      j.inputManifest = { items: [] };
      stores.jobs.put(j);
      set(true);
    };
  });

  await assert.rejects(
    async () => {
      await queue.ingestAnalysisResult({
        ownerId,
        jobId: enq.jobId,
        inputEvidenceList: [{ postId: 'p-frozen-1', text: '清单中的真实文本' }],
        candidates: [{ type: 'writing_principle', statement: '准则', evidencePostIds: ['p-frozen-1'] }]
      });
    },
    /清单为空/
  );

  await store.close();
});

test('ingest regression: rechecks job completion inside write transaction and avoids duplicate analyses on concurrent replay', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_concurrent_replay_test';

  const enq = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-concurrent-ingest',
    producer: 'test',
    sourceRefs: [{ postId: 'post-concurrent-1', text: '并发测试样本' }]
  });

  // Launch two concurrent ingestAnalysisResult calls simultaneously
  const ingestPayload = {
    ownerId,
    jobId: enq.jobId,
    inputEvidenceList: [{ postId: 'post-concurrent-1', text: '并发测试样本' }],
    candidates: [
      {
        type: 'writing_principle',
        statement: '并发重放安全准则',
        evidencePostIds: ['post-concurrent-1']
      }
    ],
    businessResults: { score: 99 }
  };

  const [res1, res2] = await Promise.all([
    queue.ingestAnalysisResult(ingestPayload),
    queue.ingestAnalysisResult(ingestPayload)
  ]);

  assert.equal(res1.ok, true);
  assert.equal(res2.ok, true);
  assert.equal(res1.analysisId, res2.analysisId, '并发重放共用同一个分析 ID');

  // Exactly one of them created knowledge, the other replayed
  const oneReplayed = Boolean(res1.replayed || res2.replayed);
  assert.equal(oneReplayed, true, '并发调用中重放者返回 replayed: true');

  // Verify only 1 analysis record exists in store
  const allAnalyses = await store.listAnalysesForJob(ownerId, enq.jobId);
  assert.equal(allAnalyses.length, 1, '并发调用绝不产生重复的 Analysis 记录');

  // Verify only 1 knowledge record exists
  const allKnowledge = await store.listKnowledge(ownerId);
  assert.equal(allKnowledge.length, 1, '并发调用绝不产生重复的 Knowledge 记录');

  await store.close();
});

test('enqueue regression: output mismatch prevents false reuse and creates a distinct job', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_output_mismatch';

  const sourceRefs = [{ postId: 'p-out-1', text: '输出不匹配测试推文' }];
  const spec = { kind: 'content_analysis', version: 1 };

  // 1. Request 1 only asks for knowledge_candidate
  const enq1 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-out-1',
    producer: 'producer_A',
    sourceRefs,
    analysisSpec: spec,
    requestedOutputs: ['knowledge_candidate']
  });
  assert.equal(enq1.created, true);

  // 2. Request 2 asks for knowledge_candidate AND post_critique
  // Must NOT subscribe to Job 1 because Job 1 lacks post_critique!
  const enq2 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-out-2',
    producer: 'producer_B',
    sourceRefs,
    analysisSpec: spec,
    requestedOutputs: ['knowledge_candidate', 'post_critique']
  });
  assert.equal(enq2.created, true, '缺少所需输出能力时必须创建独立任务');
  assert.notEqual(enq2.jobId, enq1.jobId, '输出能力不匹配的任务绝不能被错误复用');

  // 3. Request 3 asks for knowledge_candidate with same spec and inputs
  // Must subscribe to Job 1 (compatible reuse)
  const enq3 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-out-3',
    producer: 'producer_C',
    sourceRefs,
    analysisSpec: spec,
    requestedOutputs: ['knowledge_candidate']
  });
  assert.equal(enq3.subscribed, true, '输出能力兼容且一致时允许订阅共享任务');
  assert.equal(enq3.jobId, enq1.jobId);

  await store.close();
});

test('enqueue regression: prompt, parser, language, and window mismatch prevent false reuse', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_spec_mismatch';

  const sourceRefs = [{ postId: 'p-spec-1', text: '多版本测试推文' }];
  const baseSpec = {
    kind: 'deep_review',
    version: 1,
    promptVersion: '1.0.0',
    parserVersion: '1.0.0',
    language: 'zh-CN',
    window: '7d'
  };

  // Base job
  const enqBase = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-base',
    producer: 'test_runner',
    sourceRefs,
    analysisSpec: baseSpec
  });
  assert.equal(enqBase.created, true);

  // 1. Prompt version mismatch -> creates separate job
  const enqPrompt = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-prompt-diff',
    producer: 'test_runner',
    sourceRefs,
    analysisSpec: { ...baseSpec, promptVersion: '2.0.0' }
  });
  assert.equal(enqPrompt.created, true);
  assert.notEqual(enqPrompt.jobId, enqBase.jobId, 'promptVersion 不一致必须创建独立任务');

  // 2. Parser version mismatch -> creates separate job
  const enqParser = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-parser-diff',
    producer: 'test_runner',
    sourceRefs,
    analysisSpec: { ...baseSpec, parserVersion: '2.0.0' }
  });
  assert.equal(enqParser.created, true);
  assert.notEqual(enqParser.jobId, enqBase.jobId, 'parserVersion 不一致必须创建独立任务');

  // 3. Language mismatch -> creates separate job
  const enqLang = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-lang-diff',
    producer: 'test_runner',
    sourceRefs,
    analysisSpec: { ...baseSpec, language: 'en-US' }
  });
  assert.equal(enqLang.created, true);
  assert.notEqual(enqLang.jobId, enqBase.jobId, 'language 不一致必须创建独立任务');

  // 4. Window mismatch -> creates separate job
  const enqWin = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-win-diff',
    producer: 'test_runner',
    sourceRefs,
    analysisSpec: { ...baseSpec, window: '30d' }
  });
  assert.equal(enqWin.created, true);
  assert.notEqual(enqWin.jobId, enqBase.jobId, 'window 不一致必须创建独立任务');

  // 5. Compatible reuse with different producer
  const enqCompatible = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-compatible-diff-producer',
    producer: 'another_producer_name',
    sourceRefs,
    analysisSpec: baseSpec
  });
  assert.equal(enqCompatible.subscribed, true, '语义完全兼容但 producer 不同时允许复用共享任务');
  assert.equal(enqCompatible.jobId, enqBase.jobId);

  await store.close();
});

test('enqueue regression: metrics-dependent invalidation vs compatible reuse', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_metrics_invalidation';

  const sampleLowMetrics = [{ postId: 'p-metric', text: '指标测试推文', metrics: { impressions: 100 } }];
  const sampleHighMetrics = [{ postId: 'p-metric', text: '指标测试推文', metrics: { impressions: 99000 } }];

  // Case 1: dependsOnMetrics is TRUE -> different metrics invalidate old job
  const enqMetric1 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-m-1',
    producer: 'metrics_agent',
    sourceRefs: sampleLowMetrics,
    analysisSpec: { kind: 'metrics_audit', version: 1, dependsOnMetrics: true }
  });
  assert.equal(enqMetric1.created, true);

  const enqMetric2 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-m-2',
    producer: 'metrics_agent',
    sourceRefs: sampleHighMetrics,
    analysisSpec: { kind: 'metrics_audit', version: 1, dependsOnMetrics: true }
  });
  assert.equal(enqMetric2.created, true, '指标依赖型任务在指标变更后必须创建新任务（失效旧任务）');
  assert.notEqual(enqMetric2.jobId, enqMetric1.jobId);

  // Case 2: dependsOnMetrics is NOT declared -> metrics difference does NOT prevent reuse
  const enqNoMetric1 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-nm-1',
    producer: 'text_agent_1',
    sourceRefs: sampleLowMetrics,
    analysisSpec: { kind: 'text_audit', version: 1 }
  });
  assert.equal(enqNoMetric1.created, true);

  const enqNoMetric2 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-nm-2',
    producer: 'text_agent_2',
    sourceRefs: sampleHighMetrics,
    analysisSpec: { kind: 'text_audit', version: 1 }
  });
  assert.equal(enqNoMetric2.subscribed, true, '未声明指标依赖时指标变更不破坏复用');
  assert.equal(enqNoMetric2.jobId, enqNoMetric1.jobId);

  await store.close();
});

test('enqueue regression: rejects unverified caller textHash against raw text', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_unverified_hash';

  await assert.rejects(
    async () => {
      await queue.enqueueAnalysis({
        ownerId,
        clientRequestId: 'req-tampered-hash',
        producer: 'test',
        sourceRefs: [
          { postId: 'p-tampered', text: '真实的原始推文', textHash: 'forged_fake_hash' }
        ]
      });
    },
    /textHash 与 raw text 不一致/
  );

  await store.close();
});

test('enqueue regression: same clientRequestId replay with changed payload rejects conflicting input', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const queue = createKnowledgeQueue({ store });
  const ownerId = 'user_client_req_conflict';

  const initialSource = [{ postId: 'p-orig', text: '原始样本内容' }];
  const initialSpec = { kind: 'sentiment', version: 1 };
  const initialOutputs = ['knowledge_candidate'];

  // Initial enqueue
  const enq1 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'fixed-client-req-id',
    producer: 'test_client',
    sourceRefs: initialSource,
    analysisSpec: initialSpec,
    requestedOutputs: initialOutputs
  });
  assert.equal(enq1.created, true);

  // 1. Conflict: Changed sourceRefs (inputHash mismatch)
  await assert.rejects(
    async () => {
      await queue.enqueueAnalysis({
        ownerId,
        clientRequestId: 'fixed-client-req-id',
        producer: 'test_client',
        sourceRefs: [{ postId: 'p-orig', text: '已被修改的样本内容' }],
        analysisSpec: initialSpec,
        requestedOutputs: initialOutputs
      });
    },
    /clientRequestId 冲突.*输入样本不一致/
  );

  // 2. Conflict: Changed requestedOutputs
  await assert.rejects(
    async () => {
      await queue.enqueueAnalysis({
        ownerId,
        clientRequestId: 'fixed-client-req-id',
        producer: 'test_client',
        sourceRefs: initialSource,
        analysisSpec: initialSpec,
        requestedOutputs: ['post_critique']
      });
    },
    /clientRequestId 冲突.*requestedOutputs 不一致/
  );

  // 3. Conflict: Changed analysisSpec
  await assert.rejects(
    async () => {
      await queue.enqueueAnalysis({
        ownerId,
        clientRequestId: 'fixed-client-req-id',
        producer: 'test_client',
        sourceRefs: initialSource,
        analysisSpec: { kind: 'sentiment', version: 2 },
        requestedOutputs: initialOutputs
      });
    },
    /clientRequestId 冲突.*分析配置不一致/
  );

  // 4. Exact replay with identical payload -> succeeds idempotently
  const enqReplay = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'fixed-client-req-id',
    producer: 'test_client',
    sourceRefs: initialSource,
    analysisSpec: initialSpec,
    requestedOutputs: initialOutputs
  });
  assert.equal(enqReplay.reused, true);
  assert.equal(enqReplay.requestId, enq1.requestId);
  assert.equal(enqReplay.jobId, enq1.jobId);

  await store.close();
});

test('queue lifecycle regression: never recycle cancelled or failed job ID, preserve historical checkpoints and references, allocate new attempt/key with unique ownerExecution and cache safety', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let currentTime = 1000;
  const queue = createKnowledgeQueue({
    store,
    now: () => currentTime
  });
  const ownerId = 'user_lifecycle_recycle';
  const sourceRefs = [{ postId: 'p-rec-1', text: '生命周期重试隔离推文' }];
  const spec = { kind: 'lifecycle_test', version: 1 };

  // 1. Initial enqueue creates Job 1 (attempt 1) and Request A
  const enqA = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-A',
    producer: 'test_producer',
    sourceRefs,
    analysisSpec: spec
  });
  assert.equal(enqA.created, true);
  assert.equal(enqA.attempt, 1);
  const job1Id = enqA.jobId;

  // Cancel Request A before submission -> cancels Job 1
  currentTime = 2000;
  const cancelA = await queue.cancelAnalysisRequest({
    ownerId,
    requestId: enqA.requestId
  });
  assert.equal(cancelA.requestCancelled, true);
  assert.equal(cancelA.jobCancelled, true);

  const job1 = await store.getJob(ownerId, job1Id);
  assert.equal(job1.status, 'cancelled');
  assert.equal(job1.checkpoint.stage, 'cancelled');
  assert.equal(job1.checkpoint.at, 2000);

  // 2. Enqueue Request B with identical inputs/spec:
  // MUST NOT recycle cancelled Job 1's ID!
  // MUST allocate a new attempt and job ID!
  currentTime = 3000;
  const enqB = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-B',
    producer: 'test_producer',
    sourceRefs,
    analysisSpec: spec
  });
  assert.equal(enqB.created, true);
  assert.notEqual(enqB.jobId, job1Id, '绝不能复用已取消任务的 ID');
  assert.equal(enqB.attempt, 2, '重试任务必须递增 attempt 计数');
  const job2Id = enqB.jobId;

  // Verify historical Job 1 remains completely immutable
  const job1After = await store.getJob(ownerId, job1Id);
  assert.equal(job1After.id, job1Id);
  assert.equal(job1After.status, 'cancelled', '已取消的 Job 1 状态必须保持不可变');
  assert.equal(job1After.checkpoint.stage, 'cancelled', 'Job 1 的历史检查点必须保持不可变');
  assert.equal(job1After.checkpoint.at, 2000);
  assert.equal(job1After.supersededByJobId, job2Id);

  // Verify Request A still immutably references Job 1
  const reqA = await store.getRequest(ownerId, enqA.requestId);
  assert.equal(reqA.jobId, job1Id, '历史请求 A 必须仍指向原 Job 1');
  assert.equal(reqA.deliveryStatus, 'cancelled');

  // Verify Job 2 is active and clean
  const job2 = await store.getJob(ownerId, job2Id);
  assert.equal(job2.id, job2Id);
  assert.equal(job2.status, 'queued');
  assert.equal(job2.attempt, 2);
  assert.ok(job2.attemptKey.includes('attempt:2'));
  assert.equal(job2.previousJobId, job1Id);
  assert.equal(job2.checkpoint.stage, 'queued');
  assert.equal(job2.checkpoint.at, 3000);

  // Verify unique ownerExecution index resolves to active Job 2
  const activeJob = await store.findJobByExecutionKey(ownerId, job2.executionKey);
  assert.equal(activeJob.id, job2Id, '唯一 ownerExecution 索引必须指向活跃的 Job 2');

  // Verify subsequent sibling Request C subscribes to Job 2 (not Job 1)
  const enqC = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-C',
    producer: 'sibling_producer',
    sourceRefs,
    analysisSpec: spec
  });
  assert.equal(enqC.subscribed, true);
  assert.equal(enqC.jobId, job2Id, '新兄弟请求必须订阅活跃的 Job 2');

  // 3. Fail Job 2 and verify next attempt again allocates fresh ID and preserves Job 2
  currentTime = 4000;
  await store.putJob({
    ...job2,
    status: 'failed',
    error: '模拟 Grok 临时故障',
    checkpoint: { stage: 'failed', at: 4000, data: { reason: 'network_timeout' } },
    updatedAt: 4000
  });

  currentTime = 5000;
  const enqD = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-D',
    producer: 'retry_producer',
    sourceRefs,
    analysisSpec: spec
  });
  assert.equal(enqD.created, true);
  assert.notEqual(enqD.jobId, job2Id, '绝不能复用失败任务的 ID');
  assert.notEqual(enqD.jobId, job1Id);
  assert.equal(enqD.attempt, 3, '重试任务递增至 attempt 3');

  const job2After = await store.getJob(ownerId, job2Id);
  assert.equal(job2After.status, 'failed', '已失败任务的 checkpoint 与状态不可变');
  assert.equal(job2After.checkpoint.stage, 'failed');
  assert.equal(job2After.supersededByJobId, enqD.jobId);

  const job3 = await store.getJob(ownerId, enqD.jobId);
  assert.equal(job3.attempt, 3);
  assert.equal(job3.previousJobId, job2Id);

  await store.close();
});

test('queue lifecycle regression: advanceJobStage and cancelAnalysisRequest execute atomic CAS transitions without separate-transaction races', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let currentTime = 1000;
  const queue = createKnowledgeQueue({
    store,
    now: () => currentTime
  });
  const ownerId = 'user_cas_test';
  const sourceRefs = [{ postId: 'p-cas-1', text: '原子CAS测试推文' }];
  const spec = { kind: 'cas_test', version: 1 };

  const enq = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-cas-1',
    producer: 'test',
    sourceRefs,
    analysisSpec: spec
  });

  // 1. CAS mismatch rejection on advanceJobStage
  const advanceMismatch = await queue.advanceJobStage({
    ownerId,
    jobId: enq.jobId,
    expectedStage: 'submitted', // Actual is 'queued'
    nextStage: 'ready'
  });
  assert.equal(advanceMismatch.ok, false);
  assert.equal(advanceMismatch.error, 'stage_mismatch');
  assert.equal(advanceMismatch.currentStage, 'queued');

  // Verify job state unchanged
  let job = await store.getJob(ownerId, enq.jobId);
  assert.equal(job.status, 'queued');

  // Correct CAS progression to submitted
  currentTime = 2000;
  const advanceOk = await queue.advanceJobStage({
    ownerId,
    jobId: enq.jobId,
    expectedStage: 'queued',
    nextStage: 'submitted',
    data: { submittedGrokAt: 2000 }
  });
  assert.equal(advanceOk.ok, true);
  assert.equal(advanceOk.job.status, 'submitted');

  // 2. Cancellation of request on submitted job CANNOT cancel the job (Atomic CAS)
  currentTime = 3000;
  const cancelSubmitted = await queue.cancelAnalysisRequest({
    ownerId,
    requestId: enq.requestId
  });
  assert.equal(cancelSubmitted.requestCancelled, true);
  assert.equal(cancelSubmitted.jobCancelled, false);
  assert.equal(cancelSubmitted.reason, 'job_status_is_submitted');

  job = await store.getJob(ownerId, enq.jobId);
  assert.equal(job.status, 'submitted', '已提交给 Grok 的任务绝不能被并发取消中断');

  // 3. Terminal state protection: completed job cannot be advanced
  await store.putJob({
    ...job,
    status: 'completed',
    checkpoint: { stage: 'completed', at: 4000 },
    updatedAt: 4000
  });

  const advanceTerminal = await queue.advanceJobStage({
    ownerId,
    jobId: enq.jobId,
    nextStage: 'submitted'
  });
  assert.equal(advanceTerminal.ok, false);
  assert.equal(advanceTerminal.error, 'terminal_state');

  await store.close();
});

test('queue lifecycle regression: independent business delivery with idempotent ack and replay, and explicit outbox recovery without Grok calls', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let currentTime = 1000;
  const queue = createKnowledgeQueue({
    store,
    now: () => currentTime
  });
  const ownerId = 'user_delivery_repair';
  const sourceRefs = [{ postId: 'p-del-1', text: '交付与重放测试推文' }];
  const spec = { kind: 'delivery_test', version: 1 };
  const testBusinessResults = {
    summary: '交付修复测试成功',
    insights: ['无二次 Grok 调用', '幂等确认与重放']
  };

  // 1. Initial job and ingestion
  const enq1 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'req-orig',
    producer: 'producer_1',
    sourceRefs,
    analysisSpec: spec
  });

  currentTime = 2000;
  await queue.ingestAnalysisResult({
    ownerId,
    jobId: enq1.jobId,
    producer: 'producer_1',
    analysisSpec: spec,
    inputEvidenceList: [{ postId: 'p-del-1', text: '交付与重放测试推文' }],
    candidates: [{
      type: 'writing_principle',
      statement: '交付与重放必须幂等',
      evidencePostIds: ['p-del-1']
    }],
    businessResults: testBusinessResults
  });

  const jobCompleted = await store.getJob(ownerId, enq1.jobId);
  assert.equal(jobCompleted.status, 'completed');
  assert.deepEqual(jobCompleted.savedResult, testBusinessResults);

  // 2. Idempotent acknowledgment (acknowledgeDelivery)
  currentTime = 3000;
  const ack1 = await queue.acknowledgeDelivery({
    ownerId,
    requestId: enq1.requestId,
    ackToken: 'ack_token_abc'
  });
  assert.equal(ack1.ok, true);
  assert.equal(ack1.acknowledged, true);
  assert.equal(ack1.ackAt, 3000);
  assert.equal(ack1.ackToken, 'ack_token_abc');

  // Repeated ack is strictly idempotent
  currentTime = 4000;
  const ack2 = await queue.acknowledgeDelivery({
    ownerId,
    requestId: enq1.requestId,
    ackToken: 'ack_token_abc'
  });
  assert.equal(ack2.ok, true);
  assert.equal(ack2.alreadyAcknowledged, true);
  assert.equal(ack2.ackAt, 3000); // Unchanged original ack time

  // 3. Independent delivery replay without second Grok call (replayDelivery)
  // Simulate an outbox request that was pending or needs replay
  const enqPending = await store.putRequest({
    ownerId,
    id: 'req-pending-outbox',
    producer: 'delayed_producer',
    clientRequestId: 'req-pending-client',
    jobId: enq1.jobId,
    requestedOutputs: ['knowledge_candidate'],
    deliveryStatus: 'pending',
    businessResults: null,
    deliveredAt: null,
    createdAt: 2500,
    updatedAt: 2500
  });

  currentTime = 5000;
  const replayResult = await queue.replayDelivery({
    ownerId,
    requestId: 'req-pending-outbox'
  });
  assert.equal(replayResult.ok, true);
  assert.equal(replayResult.delivered, true);
  assert.deepEqual(replayResult.businessResults, testBusinessResults);

  const replayedReq = await store.getRequest(ownerId, 'req-pending-outbox');
  assert.equal(replayedReq.deliveryStatus, 'delivered');
  assert.deepEqual(replayedReq.businessResults, testBusinessResults);
  assert.equal(replayedReq.deliveredAt, 5000);

  // Replay again is idempotent
  const replayAgain = await queue.replayDelivery({
    ownerId,
    requestId: 'req-pending-outbox'
  });
  assert.equal(replayAgain.ok, true);
  assert.equal(replayAgain.alreadyDelivered, true);

  // Verify Job status remained 'completed' with NO status reset
  const jobAfterReplay = await store.getJob(ownerId, enq1.jobId);
  assert.equal(jobAfterReplay.status, 'completed');

  // 4. Outbox recovery via recoverInterruptedJobs
  // Put another pending request under the completed job
  await store.putRequest({
    ownerId,
    id: 'req-outbox-2',
    producer: 'outbox_producer',
    clientRequestId: 'req-outbox-client-2',
    jobId: enq1.jobId,
    requestedOutputs: ['knowledge_candidate'],
    deliveryStatus: 'pending',
    businessResults: null,
    deliveredAt: null,
    createdAt: 2600,
    updatedAt: 2600
  });

  currentTime = 6000;
  const recovery = await queue.recoverInterruptedJobs({ ownerId });
  assert.equal(recovery.deliveredOutboxCount, 1);

  const recoveredReq = await store.getRequest(ownerId, 'req-outbox-2');
  assert.equal(recoveredReq.deliveryStatus, 'delivered');
  assert.deepEqual(recoveredReq.businessResults, testBusinessResults);
  assert.equal(recoveredReq.deliveredAt, 6000);

  await store.close();
});

test('enqueue regression: completed job delivers business results to second request and leaves cancellation unaffected', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let currentTime = 10000;
  const queue = createKnowledgeQueue({
    store,
    now: () => currentTime
  });
  const ownerId = 'user_completed_delivery';

  const sourceRefs = [{ postId: 'post-comp-1', text: '完成任务复用推文样本' }];
  const spec = { kind: 'deep_review', version: 1 };
  const expectedBusinessResults = {
    score: 98,
    summary: '深度推文分析完成',
    metricsAssessment: '优质',
    tags: ['深度', '精选']
  };

  // 1. First request is enqueued and initially creates a new queued job
  const enq1 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'first-client-req',
    producer: 'agent_first',
    sourceRefs,
    analysisSpec: spec,
    requestedOutputs: ['knowledge_candidate']
  });
  assert.equal(enq1.created, true);
  assert.equal(enq1.jobStatus, 'queued');

  // Complete the underlying job via ingestAnalysisResult with business results
  currentTime = 20000;
  const ingestResult = await queue.ingestAnalysisResult({
    ownerId,
    jobId: enq1.jobId,
    producer: 'agent_first',
    analysisSpec: spec,
    inputEvidenceList: [{ postId: 'post-comp-1', text: '完成任务复用推文样本' }],
    candidates: [
      {
        type: 'writing_principle',
        statement: '首句亮明观点',
        evidencePostIds: ['post-comp-1'],
        reason: '样本验证'
      }
    ],
    businessResults: expectedBusinessResults
  });
  assert.equal(ingestResult.ok, true);

  // Verify first request is delivered
  const firstReq = await store.getRequest(ownerId, enq1.requestId);
  assert.equal(firstReq.deliveryStatus, 'delivered');
  assert.deepEqual(firstReq.businessResults, expectedBusinessResults);

  const completedJob = await store.getJob(ownerId, enq1.jobId);
  assert.equal(completedJob.status, 'completed');

  // 2. Second request with different clientRequestId but matching input/spec subscribes to the completed job
  currentTime = 30000;
  const enq2 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'second-client-req',
    producer: 'agent_second',
    sourceRefs,
    analysisSpec: spec,
    requestedOutputs: ['knowledge_candidate']
  });

  // Verify second request is atomically delivered using persisted businessResults from analysisCache
  assert.equal(enq2.subscribed, true);
  assert.equal(enq2.reused, true);
  assert.equal(enq2.jobId, enq1.jobId);
  assert.equal(enq2.jobStatus, 'completed');
  assert.equal(enq2.deliveryStatus, 'delivered');
  assert.notEqual(enq2.requestId, enq1.requestId);
  assert.deepEqual(enq2.businessResults, expectedBusinessResults);

  // Verify second request record persisted in database is delivered, not left pending forever
  const secondReq = await store.getRequest(ownerId, enq2.requestId);
  assert.equal(secondReq.deliveryStatus, 'delivered', '第二条订阅已完成任务的请求必须处于 delivered 状态，不能永久 pending');
  assert.deepEqual(secondReq.businessResults, expectedBusinessResults, '第二条请求应交付从 analysisCache 持久化的 businessResults');
  assert.equal(secondReq.deliveredAt, 30000);

  // 3. Verification: Cancellation of requests on a completed job is unaffected
  // Cancelling second request (already delivered) cancels the request record without cancelling the completed job
  const cancelReq2 = await queue.cancelAnalysisRequest({
    ownerId,
    requestId: enq2.requestId
  });
  assert.equal(cancelReq2.requestCancelled, true);
  assert.equal(cancelReq2.jobCancelled, false);

  const secondReqAfterCancel = await store.getRequest(ownerId, enq2.requestId);
  assert.equal(secondReqAfterCancel.deliveryStatus, 'cancelled');

  // Completed job status remains strictly 'completed'
  const jobAfterReq2Cancel = await store.getJob(ownerId, enq1.jobId);
  assert.equal(jobAfterReq2Cancel.status, 'completed', '已完成任务不能被取消');

  // Cancelling first request as well
  const cancelReq1 = await queue.cancelAnalysisRequest({
    ownerId,
    requestId: enq1.requestId
  });
  assert.equal(cancelReq1.requestCancelled, true);
  assert.equal(cancelReq1.jobCancelled, false);

  const jobAfterAllCancel = await store.getJob(ownerId, enq1.jobId);
  assert.equal(jobAfterAllCancel.status, 'completed', '所有请求取消后，已完成任务仍保持 completed');

  // 4. Verification: Normal active job cancellation remains fully functional
  const activeEnq1 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'active-req-1',
    producer: 'test',
    sourceRefs: [{ postId: 'p-active-1', text: '活跃任务样本' }]
  });
  const activeEnq2 = await queue.enqueueAnalysis({
    ownerId,
    clientRequestId: 'active-req-2',
    producer: 'test',
    sourceRefs: [{ postId: 'p-active-1', text: '活跃任务样本' }]
  });

  // Cancel 1 of 2 active subscribers: job remains queued
  const cancelActive1 = await queue.cancelAnalysisRequest({
    ownerId,
    requestId: activeEnq1.requestId
  });
  assert.equal(cancelActive1.requestCancelled, true);
  assert.equal(cancelActive1.jobCancelled, false);
  assert.equal(cancelActive1.remainingActiveRequests, 1);

  let activeJob = await store.getJob(ownerId, activeEnq1.jobId);
  assert.equal(activeJob.status, 'queued');

  // Cancel last active subscriber: queued job is cancelled
  const cancelActive2 = await queue.cancelAnalysisRequest({
    ownerId,
    requestId: activeEnq2.requestId
  });
  assert.equal(cancelActive2.requestCancelled, true);
  assert.equal(cancelActive2.jobCancelled, true);

  activeJob = await store.getJob(ownerId, activeEnq1.jobId);
  assert.equal(activeJob.status, 'cancelled');

  // 5. Verification: replayDelivery recovers pending request on completed job without new Grok call
  // Simulate a pending request directly in store on the completed job
  const pendingReqId = 'simulated-pending-req';
  await store.putRequest({
    ownerId,
    id: pendingReqId,
    producer: 'replay_tester',
    clientRequestId: 'simulated-pending-client',
    jobId: enq1.jobId,
    requestedOutputs: ['knowledge_candidate'],
    deliveryStatus: 'pending',
    businessResults: null,
    inputHash: completedJob.inputManifest?.inputHash,
    executionKey: completedJob.executionKey,
    createdAt: 40000,
    updatedAt: 40000
  });

  const replayResult = await queue.replayDelivery({
    ownerId,
    requestId: pendingReqId
  });
  assert.equal(replayResult.ok, true);
  assert.equal(replayResult.delivered, true);

  const replayedReq = await store.getRequest(ownerId, pendingReqId);
  assert.equal(replayedReq.deliveryStatus, 'delivered');
  assert.deepEqual(replayedReq.businessResults, expectedBusinessResults);

  await store.close();
});
