import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createKnowledgeStore } from '../src/features/knowledge/knowledge-store.js';
import {
  createKnowledgeDataResolver,
  resolveTaskData,
  normalizeDataPolicy,
  validateDeclaredRequiredFields,
  validateSnapshotFreshness,
  freezeInputManifest,
  deepFreeze,
  AccountMismatchError,
  createPostTrackingAdapter,
  createLeaderboardAdapter
} from '../src/features/knowledge/knowledge-data-resolver.js';

test('pinned references never substitute a mutable current post and a waiting manifest is not ready on retry', async () => {
  let reads = 0;
  const resolver = createKnowledgeDataResolver({
    adapters: { default: { async getSnapshot() { reads++; return { postId: 'p1', text: 'changed' }; } } }
  });
  const first = await resolver.resolveData({
    ownerId: 'o1', sourceRefs: [{ postId: 'p1', textHash: 'old-hash' }], dataPolicy: 'pinned'
  });
  assert.equal(first.status, 'waiting_data');
  assert.equal(reads, 0);
  const retry = await resolver.resolveData({
    ownerId: 'o1', job: {
      ownerId: 'o1', status: 'waiting_data', analysisSpec: {},
      inputManifest: first.manifest
    }
  });
  assert.equal(retry.status, 'waiting_data');
  assert.equal(reads, 0);
});

test('explicit owner cannot override a different persisted job owner', async () => {
  await assert.rejects(
    resolveTaskData({
      ownerId: 'other', job: { ownerId: 'actual', inputManifest: { items: [{ postId: 'p1', text: 'text' }] } }
    }),
    AccountMismatchError
  );
});

test('normalizeDataPolicy handles string and config objects with safe defaults', () => {
  const pinned = normalizeDataPolicy('pinned');
  assert.equal(pinned.mode, 'pinned');
  assert.equal(pinned.maxStaleMs, Infinity);
  assert.equal(pinned.allowNetwork, false);
  assert.equal(pinned.refuseSubstitution, true);
  assert.equal(pinned.maxFetchesPerTask, 3);
  assert.equal(pinned.onMissing, 'waiting_data');

  const latest = normalizeDataPolicy('latest');
  assert.equal(latest.mode, 'latest');
  assert.equal(latest.maxStaleMs, 86400000);
  assert.equal(latest.allowNetwork, true);
  assert.equal(latest.refuseSubstitution, false);

  const custom = normalizeDataPolicy({
    mode: 'latest',
    maxStaleMs: 3600000,
    allowNetwork: false,
    maxFetchesPerTask: 5,
    onMissing: 'partial'
  });
  assert.equal(custom.mode, 'latest');
  assert.equal(custom.maxStaleMs, 3600000);
  assert.equal(custom.allowNetwork, false);
  assert.equal(custom.maxFetchesPerTask, 5);
  assert.equal(custom.onMissing, 'partial');

  assert.throws(() => normalizeDataPolicy('invalid_mode'), /非法的 dataPolicy 模式/);
});

test('validateSnapshotFreshness accurately determines staleness against maxStaleMs', () => {
  const now = 1000000;
  const fresh = { capturedAt: 950000 };
  const stale = { capturedAt: 800000 };

  const freshRes = validateSnapshotFreshness(fresh, 100000, now);
  assert.equal(freshRes.fresh, true);
  assert.equal(freshRes.stale, false);
  assert.equal(freshRes.ageMs, 50000);

  const staleRes = validateSnapshotFreshness(stale, 100000, now);
  assert.equal(staleRes.fresh, false);
  assert.equal(staleRes.stale, true);
  assert.equal(staleRes.ageMs, 200000);

  const infRes = validateSnapshotFreshness(stale, Infinity, now);
  assert.equal(infRes.fresh, true);
  assert.equal(infRes.stale, false);

  const missingRes = validateSnapshotFreshness(null, 100000, now);
  assert.equal(missingRes.fresh, false);
  assert.equal(missingRes.stale, true);
});

test('validateDeclaredRequiredFields detects missing metrics and text without inventing values', () => {
  const itemNoText = { text: '', metrics: { views: 100 } };
  const res1 = validateDeclaredRequiredFields(itemNoText, { requireText: true });
  assert.equal(res1.valid, false);
  assert.ok(res1.missing.includes('text'));

  const itemMissingViews = { text: '有效文本', metrics: { likes: 5 } };
  const res2 = validateDeclaredRequiredFields(itemMissingViews, {
    dependsOnMetrics: true,
    requiredMetrics: ['views', 'likes']
  });
  assert.equal(res2.valid, false);
  assert.ok(res2.missing.includes('metrics.views'));
  assert.equal(res2.metricStates.views, 'missing');
  assert.equal(res2.metricStates.likes, 'available');
  // Crucially, metrics.views must remain undefined, never invented as 0
  assert.equal(itemMissingViews.metrics.views, undefined);

  const itemFull = { text: '有效文本', metrics: { views: 500, likes: 20 } };
  const res3 = validateDeclaredRequiredFields(itemFull, {
    dependsOnMetrics: true,
    requiredMetrics: ['views', 'likes']
  });
  assert.equal(res3.valid, true);
  assert.equal(res3.missing.length, 0);
  assert.equal(res3.metricStates.views, 'available');
  assert.equal(res3.metricStates.likes, 'available');
});

test('pinned policy preserves enqueue-time snapshot and refuses substitution when adapter changes', async () => {
  const ownerId = 'owner-pinned-01';
  let adapterCallCount = 0;

  // Adapter contains modified/live text that must NOT replace the pinned enqueue snapshot
  const mockAdapter = {
    async getSnapshot({ ref }) {
      adapterCallCount++;
      return {
        ownerId,
        postId: ref.postId,
        text: '这是后来被修改的实时正文，不能替换用户入队时选定的快照！',
        metrics: { views: 999999, likes: 8888 },
        capturedAt: 5000000
      };
    }
  };

  const resolver = createKnowledgeDataResolver({
    adapters: { test_producer: mockAdapter },
    now: () => 2000000
  });

  // Source ref includes the enqueue-time snapshot
  const sourceRefs = [
    {
      postId: 'post-pinned-101',
      text: '入队时的原始推文快照',
      metrics: { views: 120, likes: 10 },
      capturedAt: 1000000
    }
  ];

  const result = await resolver.resolveData({
    ownerId,
    producer: 'test_producer',
    sourceRefs,
    dataPolicy: 'pinned',
    analysisSpec: { kind: 'own_post_review', dependsOnMetrics: true }
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.manifest.coverage, 'full');
  assert.equal(result.manifest.items.length, 1);

  const item = result.manifest.items[0];
  assert.equal(item.postId, 'post-pinned-101');
  assert.equal(item.text, '入队时的原始推文快照', '必须严格保留入队时的原始快照正文');
  assert.equal(item.metrics.views, 120, '必须严格保留入队时的原始指标');
  assert.equal(item.capturedAt, 1000000, '必须保留入队时的原始快照时间');
  assert.equal(adapterCallCount, 0, '入队时已存在完整快照时，pinned 策略不调用 adapter 替换数据');
});

test('latest policy checks freshness and invokes bounded targeted fetch once then freezes', async () => {
  const ownerId = 'owner-latest-01';
  let getSnapshotCalls = 0;
  let targetedFetchCalls = 0;

  const mockAdapter = {
    // Adapter returns an old stale snapshot (captured at t=1000, now=5000, maxStaleMs=1000)
    async getSnapshot({ ref }) {
      getSnapshotCalls++;
      return {
        ownerId,
        postId: ref.postId,
        text: '旧快照文本',
        metrics: { views: 50 },
        capturedAt: 1000
      };
    },
    // Targeted fetch returns fresh snapshot
    async targetedFetch({ ref }) {
      targetedFetchCalls++;
      return {
        ownerId,
        postId: ref.postId,
        text: '补采后的最新正文',
        metrics: { views: 500 },
        capturedAt: 5000
      };
    }
  };

  const resolver = createKnowledgeDataResolver({
    adapters: { test_producer: mockAdapter },
    now: () => 5000
  });

  const result = await resolver.resolveData({
    ownerId,
    producer: 'test_producer',
    sourceRefs: [{ postId: 'post-latest-201' }],
    dataPolicy: { mode: 'latest', maxStaleMs: 1000, allowNetwork: true },
    analysisSpec: { kind: 'scheduled_analysis', dependsOnMetrics: true }
  });

  assert.equal(result.status, 'ready');
  assert.equal(getSnapshotCalls, 1);
  assert.equal(targetedFetchCalls, 1);

  const item = result.manifest.items[0];
  assert.equal(item.text, '补采后的最新正文');
  assert.equal(item.metrics.views, 500);
  assert.equal(item.capturedAt, 5000);
  assert.equal(result.manifest.frozen, true);
  assert.equal(result.manifest.stats.fetchCount, 1);
});

test('missing source under pinned policy refuses substitution and returns waiting_data', async () => {
  const ownerId = 'owner-missing-01';

  // Adapter cannot find post (deleted or lost)
  const mockAdapter = {
    async getSnapshot() {
      return null;
    }
  };

  const resolver = createKnowledgeDataResolver({
    adapters: { test_producer: mockAdapter }
  });

  const result = await resolver.resolveData({
    ownerId,
    producer: 'test_producer',
    sourceRefs: [{ postId: 'post-lost-999' }],
    dataPolicy: 'pinned',
    analysisSpec: { kind: 'own_post_review' }
  });

  assert.equal(result.status, 'waiting_data');
  assert.match(result.reason, /固定样本丢失或不可用: post-lost-999，拒绝替换/);
  assert.deepEqual(result.missingSources, ['post-lost-999']);
  assert.equal(result.manifest.items[0].availability, 'missing');
  assert.equal(result.manifest.coverage, 'partial');

  // When policy explicitly configures onMissing: 'failed'
  const failResult = await resolver.resolveData({
    ownerId,
    producer: 'test_producer',
    sourceRefs: [{ postId: 'post-lost-999' }],
    dataPolicy: { mode: 'pinned', onMissing: 'failed' },
    analysisSpec: { kind: 'own_post_review' }
  });
  assert.equal(failResult.status, 'failed');
  assert.match(failResult.error, /固定样本丢失或不可用/);
});

test('enforces per-task targeted fetch count limit and avoids runaway rescans', async () => {
  const ownerId = 'owner-fetch-limit-01';
  let targetedFetchCount = 0;

  const mockAdapter = {
    async getSnapshot({ ref }) {
      // Stale or missing snapshot to trigger fetch
      return null;
    },
    async targetedFetch({ ref }) {
      targetedFetchCount++;
      return {
        ownerId,
        postId: ref.postId,
        text: `补采正文 ${ref.postId}`,
        metrics: { views: 100 },
        capturedAt: Date.now()
      };
    }
  };

  // Configure maxFetchesPerTask: 2
  const resolver = createKnowledgeDataResolver({
    adapters: { test_producer: mockAdapter },
    defaultMaxFetches: 2
  });

  // Pass 4 items needing fetch
  const sourceRefs = [
    { postId: 'post-1' },
    { postId: 'post-2' },
    { postId: 'post-3' },
    { postId: 'post-4' }
  ];

  const result = await resolver.resolveData({
    ownerId,
    producer: 'test_producer',
    sourceRefs,
    dataPolicy: { mode: 'latest', allowNetwork: true, maxFetchesPerTask: 2, onMissing: 'partial' },
    analysisSpec: { kind: 'batch_review', allowPartial: true }
  });

  assert.equal(targetedFetchCount, 2, '补采次数必须被严格限制在每任务上限 2 次以内');
  assert.equal(result.manifest.stats.fetchCount, 2);
  assert.equal(result.manifest.stats.maxFetches, 2);
  assert.ok(result.manifest.limitations.some(l => l.includes('达到每任务补采上限 (2)')));
  assert.equal(result.status, 'partial');
});

test('frozen retry reuses frozen manifest directly without invoking adapters or network', async () => {
  const ownerId = 'owner-retry-01';
  let adapterCalled = false;

  const mockAdapter = {
    async getSnapshot() {
      adapterCalled = true;
      return null;
    },
    async targetedFetch() {
      adapterCalled = true;
      return null;
    }
  };

  const resolver = createKnowledgeDataResolver({
    adapters: { test_producer: mockAdapter }
  });

  // Simulated existing job with frozen inputManifest from previous execution
  const existingFrozenManifest = deepFreeze({
    frozen: true,
    frozenAt: 1234567,
    inputHash: 'hash-abc-123',
    coverage: 'full',
    items: [
      {
        postId: 'post-frozen-01',
        text: '冻结的正文',
        metrics: { views: 300 },
        availability: 'available',
        capturedAt: 1234567
      }
    ]
  });

  const job = {
    id: 'job-001',
    ownerId,
    producer: 'test_producer',
    inputManifest: existingFrozenManifest,
    analysisSpec: { kind: 'review' }
  };

  const result = await resolver.resolveData({
    ownerId,
    job
  });

  assert.equal(result.reused, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.manifest, existingFrozenManifest, '必须直接复用已固化的 inputManifest');
  assert.equal(adapterCalled, false, '固化重试绝不重新查询 adapter 或发起网络请求');
});

test('missing mandatory stats returns waiting_data or partial per spec, never invents values', async () => {
  const ownerId = 'owner-stats-01';

  // Snapshot has text and likes, but views metric is completely missing
  const snapshotMissingViews = {
    ownerId,
    postId: 'post-stat-01',
    text: '推文正文',
    metrics: { likes: 10 }, // views is undefined
    capturedAt: Date.now()
  };

  const mockAdapter = {
    async getSnapshot() {
      return snapshotMissingViews;
    }
  };

  const resolver = createKnowledgeDataResolver({
    adapters: { test_producer: mockAdapter }
  });

  // Case 1: Baseline mandatory stats missing -> returns waiting_data
  const waitingResult = await resolver.resolveData({
    ownerId,
    producer: 'test_producer',
    sourceRefs: [{ postId: 'post-stat-01' }],
    dataPolicy: 'latest',
    analysisSpec: {
      kind: 'review_with_views',
      dependsOnMetrics: true,
      requiredMetrics: ['views'],
      allowPartial: false
    }
  });

  assert.equal(waitingResult.status, 'waiting_data');
  assert.match(waitingResult.reason, /缺少必需统计指标: post-stat-01:metrics.views/);
  // Never invent values: metrics.views must remain undefined / missing
  assert.equal(waitingResult.manifest.items[0].metrics?.views, undefined);
  assert.equal(waitingResult.manifest.items[0].metricStates?.views, 'missing');
  assert.equal(waitingResult.manifest.items[0].metricStates?.likes, 'available');

  // Case 2: Spec explicitly permits partial analysis -> returns partial
  const partialResult = await resolver.resolveData({
    ownerId,
    producer: 'test_producer',
    sourceRefs: [{ postId: 'post-stat-01' }],
    dataPolicy: 'latest',
    analysisSpec: {
      kind: 'review_with_views',
      dependsOnMetrics: true,
      requiredMetrics: ['views'],
      allowPartial: true
    }
  });

  assert.equal(partialResult.status, 'partial');
  assert.equal(partialResult.manifest.coverage, 'partial');
  assert.equal(partialResult.manifest.items[0].metrics?.views, undefined, '绝不把缺失指标编造为 0');
});

test('account mismatch strictly rejects mismatched owners and cross-account access', async () => {
  const ownerId = 'legitimate-owner-888';

  // 1. Session current owner mismatch
  const resolverWithSession = createKnowledgeDataResolver({
    getCurrentOwner: async () => ({ accountId: 'different-logged-in-account-999' })
  });

  await assert.rejects(
    resolverWithSession.resolveData({
      ownerId,
      sourceRefs: [{ postId: 'p-1', text: '文本' }]
    }),
    AccountMismatchError
  );

  // 2. Sample ref belongs to another owner
  const resolverClean = createKnowledgeDataResolver();
  await assert.rejects(
    resolverClean.resolveData({
      ownerId,
      sourceRefs: [
        { postId: 'p-1', text: '文本', ownerId: 'foreign-owner-111' }
      ]
    }),
    /样本 p-1 所属账号 foreign-owner-111 与任务所属账号 legitimate-owner-888 不符/
  );

  // 3. Adapter returns snapshot belonging to another owner
  const foreignAdapter = {
    async getSnapshot({ ref }) {
      return {
        ownerId: 'sneaky-foreign-owner',
        postId: ref.postId,
        text: '跨账号私自窃取的数据'
      };
    }
  };

  const resolverWithForeignAdapter = createKnowledgeDataResolver({
    adapters: { test_producer: foreignAdapter }
  });

  await assert.rejects(
    resolverWithForeignAdapter.resolveData({
      ownerId,
      producer: 'test_producer',
      sourceRefs: [{ postId: 'p-1' }],
      dataPolicy: 'latest'
    }),
    /快照数据所属账号 sneaky-foreign-owner 与当前账号 legitimate-owner-888 不符/
  );
});

test('adapters decouple post-tracking and leaderboard without resolver knowing their table shapes', async () => {
  const ownerId = 'adapter-test-owner';

  // Mock postStore with custom internal table structure
  const mockPostStore = {
    async get(owner, postId) {
      if (owner === ownerId && postId === 'my-post-1') {
        return {
          postId: 'my-post-1',
          text: '我的推文',
          metrics: { views: 1500, likes: 80 },
          metricStates: { views: 'available', likes: 'available' },
          createdAt: 1000,
          capturedAt: 1000
        };
      }
      return null;
    }
  };

  // Mock leaderboardStore with totally different table structure
  const mockLeaderboardStore = {
    async getJob(owner, date) {
      if (owner === ownerId && date === '2026-10-22') {
        return {
          ownerId,
          date,
          createdAt: 2000,
          samples: [
            {
              postId: 'leaderboard-post-9',
              authorId: 'creator-99',
              handle: 'topcreator',
              text: '榜单高赞推文',
              metrics: { views: 50000, likes: 2000 },
              metricStates: { views: 'available', likes: 'available' },
              capturedAt: 2000
            }
          ]
        };
      }
      return null;
    }
  };

  const postAdapter = createPostTrackingAdapter({ postStore: mockPostStore });
  const lbAdapter = createLeaderboardAdapter({ leaderboardStore: mockLeaderboardStore });

  const resolver = createKnowledgeDataResolver({
    now: () => 3000,
    adapters: {
      post_tracking: postAdapter,
      leaderboard: lbAdapter
    }
  });

  // Resolve post-tracking item
  const postRes = await resolver.resolveData({
    ownerId,
    producer: 'post_tracking',
    sourceRefs: [{ postId: 'my-post-1' }],
    dataPolicy: 'latest',
    analysisSpec: { kind: 'own_post_review', dependsOnMetrics: true }
  });
  assert.equal(postRes.status, 'ready');
  assert.equal(postRes.manifest.items[0].text, '我的推文');
  assert.equal(postRes.manifest.items[0].metrics.views, 1500);

  // Resolve leaderboard item
  const lbRes = await resolver.resolveData({
    ownerId,
    producer: 'leaderboard',
    sourceRefs: [{ postId: 'leaderboard-post-9', date: '2026-10-22' }],
    dataPolicy: 'latest',
    analysisSpec: { kind: 'leaderboard_analysis', dependsOnMetrics: true }
  });
  assert.equal(lbRes.status, 'ready');
  assert.equal(lbRes.manifest.items[0].text, '榜单高赞推文');
  assert.equal(lbRes.manifest.items[0].handleAtCapture, 'topcreator');
  assert.equal(lbRes.manifest.items[0].metrics.views, 50000);
});

test('manifest and items are deeply frozen and immutable', async () => {
  const ownerId = 'owner-immutability-01';
  const resolver = createKnowledgeDataResolver();

  const result = await resolver.resolveData({
    ownerId,
    sourceRefs: [
      {
        postId: 'post-immutable-1',
        text: '不可变正文',
        metrics: { views: 100 }
      }
    ]
  });

  assert.equal(result.status, 'ready');
  const manifest = result.manifest;

  assert.ok(Object.isFrozen(manifest), 'manifest 根对象必须被冻结');
  assert.ok(Object.isFrozen(manifest.items), 'items 数组必须被冻结');
  assert.ok(Object.isFrozen(manifest.items[0]), 'item 元素必须被冻结');
  assert.ok(Object.isFrozen(manifest.items[0].metrics), 'metrics 对象必须被冻结');
  assert.ok(Object.isFrozen(manifest.stats), 'stats 统计对象必须被冻结');

  assert.throws(() => {
    manifest.items[0].text = '试图篡改正文';
  }, TypeError);
});

test('resolveJob integrates with store to transition job status and persist frozen inputManifest', async () => {
  const idb = new IDBFactory();
  const store = createKnowledgeStore({ indexedDB: idb });
  const ownerId = 'owner-job-test-01';
  const jobId = 'test-job-uuid-1';

  const mockAdapter = {
    async getSnapshot({ ref }) {
      return {
        ownerId,
        postId: ref.postId,
        text: '从存储任务中解析的快照文本',
        metrics: { views: 777 },
        capturedAt: 1234000
      };
    }
  };

  const resolver = createKnowledgeDataResolver({
    now: () => 1235000,
    adapters: { default: mockAdapter }
  });

  // Create an initial job in queued state
  await store.putJob({
    ownerId,
    id: jobId,
    kind: 'generic',
    executionKey: `exec_${ownerId}_${jobId}`,
    status: 'queued',
    analysisSpec: { kind: 'review' },
    inputManifest: {
      items: [{ postId: 'job-post-01' }],
      dataPolicy: 'latest'
    },
    createdAt: 1000,
    updatedAt: 1000
  });

  const res = await resolver.resolveJob({
    store,
    ownerId,
    jobId
  });

  assert.equal(res.status, 'ready');
  assert.ok(res.manifest.frozen);

  // Check persisted job in store
  const savedJob = await store.getJob(ownerId, jobId);
  assert.equal(savedJob.status, 'ready');
  assert.equal(savedJob.inputManifest.frozen, true);
  assert.equal(savedJob.inputManifest.items[0].text, '从存储任务中解析的快照文本');
  assert.equal(savedJob.inputManifest.items[0].metrics.views, 777);

  await store.close();
});

test('text truncation marks truncated: true when exceeding maxTextChars', async () => {
  const ownerId = 'owner-trunc-01';
  const longText = 'A'.repeat(500);

  const resolver = createKnowledgeDataResolver();
  const res = await resolver.resolveData({
    ownerId,
    sourceRefs: [{ postId: 'long-post-1', text: longText }],
    analysisSpec: { maxTextChars: 120 }
  });

  assert.equal(res.status, 'ready');
  assert.equal(res.manifest.items[0].text.length, 120);
  assert.equal(res.manifest.items[0].truncated, true);
  assert.equal(res.manifest.items[0].text, 'A'.repeat(120));
});

test('targetedFetch returning snapshot from foreign account is rejected with AccountMismatchError', async () => {
  const ownerId = 'legit-owner-555';
  const mockAdapter = {
    async getSnapshot() { return null; },
    async targetedFetch({ ref }) {
      return {
        ownerId: 'attacker-owner-999',
        postId: ref.postId,
        text: '来自未授权账号的内容'
      };
    }
  };

  const resolver = createKnowledgeDataResolver({
    adapters: { default: mockAdapter }
  });

  await assert.rejects(
    resolver.resolveData({
      ownerId,
      sourceRefs: [{ postId: 'p-1' }],
      dataPolicy: { mode: 'latest', allowNetwork: true }
    }),
    AccountMismatchError
  );
});

test('index.js exports all data resolver classes, functions, and policy constants', async () => {
  const knowledgeModule = await import('../src/features/knowledge/index.js');

  assert.equal(typeof knowledgeModule.createKnowledgeDataResolver, 'function');
  assert.equal(typeof knowledgeModule.resolveTaskData, 'function');
  assert.equal(typeof knowledgeModule.normalizeDataPolicy, 'function');
  assert.equal(typeof knowledgeModule.validateSnapshotFreshness, 'function');
  assert.equal(typeof knowledgeModule.validateDeclaredRequiredFields, 'function');
  assert.equal(typeof knowledgeModule.freezeInputManifest, 'function');
  assert.equal(typeof knowledgeModule.deepFreeze, 'function');
  assert.equal(typeof knowledgeModule.createPostTrackingAdapter, 'function');
  assert.equal(typeof knowledgeModule.createLeaderboardAdapter, 'function');
  assert.equal(typeof knowledgeModule.AccountMismatchError, 'function');
  assert.ok(Array.isArray(knowledgeModule.DATA_POLICY_MODES));
  assert.ok(knowledgeModule.DATA_POLICY_MODES.includes('pinned'));
  assert.ok(knowledgeModule.DATA_POLICY_MODES.includes('latest'));
});
