import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createKnowledgeStore } from '../src/features/knowledge/knowledge-store.js';
import {
  migrateLegacyWritingMemory,
  migrateLegacyLeaderboardReports,
  getMigrationStatus
} from '../src/features/knowledge/knowledge-migration.js';

function createMockStorage(initialData = {}) {
  const store = { ...initialData };
  return {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') {
            return { [keys]: store[keys] };
          }
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) res[k] = store[k];
            return res;
          }
          return { ...store };
        },
        async set(items) {
          Object.assign(store, items);
        }
      }
    }
  };
}

test('migrateLegacyWritingMemory migrates rules with status/type mapping, marks legacy incomplete evidence, and is idempotent', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const ownerId = 'mig_user_1';

  const mockStorage = createMockStorage({
    [`postWritingMemory:${ownerId}`]: {
      ownerId,
      revision: 3,
      rules: [
        {
          id: 'rule-1',
          kind: 'high',
          text: '教程类推文先给结论再展示排查步骤',
          originalText: '教程类先给结论',
          reason: '样本高互动',
          enabled: true,
          evidencePostIds: ['post_1001', 'post_1002']
        },
        {
          id: 'rule-2',
          kind: 'low',
          text: '避免在推文末尾添加毫无互动的口号',
          reason: '读者流失',
          enabled: false,
          evidencePostIds: ['post_2001']
        }
      ]
    }
  });

  // 1. Initial migration
  const res1 = await migrateLegacyWritingMemory({
    ownerId,
    storageApi: mockStorage,
    store,
    now: () => 1000
  });

  assert.equal(res1.ok, true);
  assert.equal(res1.migrated, 2);
  assert.equal(res1.linkedEvidence, 3);

  // Check store contents
  const knowledgeList = await store.listKnowledge(ownerId);
  assert.equal(knowledgeList.length, 2);

  const highRule = knowledgeList.find(k => k.type === 'writing_principle');
  assert.ok(highRule);
  assert.equal(highRule.statement, '教程类推文先给结论再展示排查步骤');
  assert.equal(highRule.originalText, '教程类先给结论', '旧写作记忆中的 originalText 必须被完整保留');
  assert.equal(highRule.status, 'active', 'enabled=true 映射为 active');

  const lowRule = knowledgeList.find(k => k.type === 'pitfall');
  assert.ok(lowRule);
  assert.equal(lowRule.statement, '避免在推文末尾添加毫无互动的口号');
  assert.equal(lowRule.status, 'disabled', 'disabled legacy rules must be preserved as disabled');

  // Check evidence records: must be marked legacyIncomplete: true
  const highEvList = await store.listEvidenceForKnowledge(ownerId, highRule.id);
  assert.equal(highEvList.length, 2);
  for (const ev of highEvList) {
    assert.equal(ev.legacyIncomplete, true, '历史样本正文缺失应标记 legacyIncomplete');
    assert.equal(ev.availability, 'legacy_reference');
  }

  // Check activeStore pointer: must NOT be switched during mere import
  assert.equal(await store.getMeta(ownerId, 'activeStore'), undefined, 'mere import must not switch activeStore');

  // 2. Re-run migration: must be idempotent and not create duplicate knowledge
  const res2 = await migrateLegacyWritingMemory({
    ownerId,
    storageApi: mockStorage,
    store,
    now: () => 2000
  });

  assert.equal(res2.ok, true);
  assert.equal(res2.alreadyMigrated, true);

  const knowledgeListAfter = await store.listKnowledge(ownerId);
  assert.equal(knowledgeListAfter.length, 2, '重新执行迁移不会重复创建知识');

  // 3. Status check: activeStore remains legacy
  const status = await getMigrationStatus({ ownerId, store });
  assert.equal(status.activeStore, 'legacy', 'activeStore remains legacy');
  assert.equal(status.legacyMemoryMigrated, true);
  assert.equal(status.knowledgeCount, 2);
  assert.equal(status.activeCount, 1);
  assert.equal(status.candidateCount, 0);

  // 4. Cross-account check: other account remains untouched
  const otherStatus = await getMigrationStatus({ ownerId: 'other_user', store });
  assert.equal(otherStatus.activeStore, 'legacy');
  assert.equal(otherStatus.legacyMemoryMigrated, false);
  assert.equal(otherStatus.knowledgeCount, 0);

  await store.close();
});

test('migrateLegacyLeaderboardReports imports completed digest reports using report.summary.conclusions and links evidence', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const ownerId = 'mig_user_leaderboard';

  const mockLeaderboardStore = {
    async listReports(id) {
      if (id !== ownerId) return [];
      return [
        {
          date: '2026-10-21',
          status: 'completed',
          coverage: [{ originalComplete: true, repliesComplete: true }],
          summary: {
            conclusions: [
              {
                text: '图文结合的干货推文在清晨发布时互动率最高',
                evidencePostIds: ['lead_post_1']
              }
            ],
            limitations: '仅覆盖前10位博主'
          }
        }
      ];
    }
  };

  const res = await migrateLegacyLeaderboardReports({
    ownerId,
    leaderboardStore: mockLeaderboardStore,
    store,
    now: () => 5000
  });

  assert.equal(res.ok, true);
  assert.equal(res.migrated, 1);
  assert.equal(res.completed, true);

  const knowledgeList = await store.listKnowledge(ownerId);
  assert.equal(knowledgeList.length, 1);
  assert.equal(knowledgeList[0].statement, '图文结合的干货推文在清晨发布时互动率最高');
  assert.equal(knowledgeList[0].type, 'writing_principle');
  assert.equal(knowledgeList[0].status, 'candidate');

  const evList = await store.listEvidenceForKnowledge(ownerId, knowledgeList[0].id);
  assert.equal(evList.length, 1);
  assert.equal(evList[0].postId, 'lead_post_1');

  // Idempotent re-run
  const rerun = await migrateLegacyLeaderboardReports({
    ownerId,
    leaderboardStore: mockLeaderboardStore,
    store
  });
  assert.equal(rerun.alreadyMigrated, true);

  await store.close();
});

test('migration regression: empty or partial migrations are never marked completed and activeStore is not switched', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const ownerId = 'mig_user_empty_partial';

  // 1. Empty writing memory: rules is empty -> must NOT mark completed and NOT switch activeStore
  const emptyStorage = createMockStorage({
    [`postWritingMemory:${ownerId}`]: {
      ownerId,
      rules: []
    }
  });

  const emptyMemRes = await migrateLegacyWritingMemory({
    ownerId,
    storageApi: emptyStorage,
    store
  });
  assert.equal(emptyMemRes.migrated, 0);
  assert.equal(emptyMemRes.completed, false);
  assert.equal(await store.getMeta(ownerId, 'migration:legacyWritingMemory'), undefined, 'empty writing memory must not mark checkpoint completed');
  assert.equal(await store.getMeta(ownerId, 'activeStore'), undefined, 'empty migration must not switch activeStore');

  // 2. Empty leaderboard reports: 0 reports -> must NOT mark completed
  const emptyLbStore = {
    async listReports() { return []; }
  };
  const emptyLbRes = await migrateLegacyLeaderboardReports({
    ownerId,
    leaderboardStore: emptyLbStore,
    store
  });
  assert.equal(emptyLbRes.migrated, 0);
  assert.equal(emptyLbRes.completed, false);
  assert.equal(await store.getMeta(ownerId, 'migration:legacyLeaderboardReports'), undefined, 'empty leaderboard reports must not mark checkpoint completed');

  // 3. Partial leaderboard report: report status is 'partial' -> must NOT mark completed
  const partialLbStore = {
    async listReports() {
      return [
        {
          date: '2026-10-22',
          status: 'partial',
          summary: {
            conclusions: [
              { text: '部分分析结论', evidencePostIds: ['part_post_1'] }
            ]
          }
        }
      ];
    }
  };
  const partialLbRes = await migrateLegacyLeaderboardReports({
    ownerId,
    leaderboardStore: partialLbStore,
    store
  });
  assert.equal(partialLbRes.completed, false, 'partial migration must not be marked completed');
  assert.equal(partialLbRes.partial, true);
  const cp = await store.getMeta(ownerId, 'migration:legacyLeaderboardReports');
  assert.equal(cp?.completed, false, 'checkpoint completed must be false for partial migration');

  await store.close();
});

test('migration regression: atomic per-report checkpointing allows safe rerun after partial import without duplicate or failure and preserves real report.summary.conclusions', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const ownerId = 'user_rerun_partial_test';

  const report1 = {
    date: '2026-10-20',
    status: 'completed',
    // report.summary.conclusions is the real digest conclusions:
    summary: {
      conclusions: [
        { text: '日历视图先展示高频互动时段', evidencePostIds: ['post-d1'] }
      ]
    },
    // report.conclusions is a decoy that must NOT override report.summary.conclusions:
    conclusions: [
      { text: '伪造的外部结论，不应采用' }
    ]
  };

  const report2 = {
    date: '2026-10-21',
    status: 'completed',
    summary: {
      conclusions: [
        { text: '评论区置顶问答可提升完读率', evidencePostIds: ['post-d2'] }
      ]
    }
  };

  // Phase 1: Only Report 1 is completed, Report 2 is still running
  let currentReports = [
    report1,
    { date: '2026-10-21', status: 'running', summary: null }
  ];

  const dynamicStore = {
    async listReports() {
      return currentReports;
    }
  };

  // Run initial migration with partial state
  const res1 = await migrateLegacyLeaderboardReports({
    ownerId,
    leaderboardStore: dynamicStore,
    store,
    now: () => 1000
  });

  assert.equal(res1.ok, true);
  assert.equal(res1.migrated, 1);
  assert.equal(res1.completed, false, '有未完成任务时整体 completed 为 false');

  // Verify Report 1 checkpoint was recorded atomically
  const cp1 = await store.getMeta(ownerId, 'migration:legacyLeaderboardReports');
  assert.equal(cp1.completed, false);
  assert.deepEqual(cp1.migratedDates, ['2026-10-20']);

  const perReport1 = await store.getMeta(ownerId, 'migration:leaderboardReport:2026-10-20');
  assert.equal(perReport1?.reportKey, '2026-10-20');

  // Verify the imported conclusion was from report.summary.conclusions, NOT decoy report.conclusions
  const kList1 = await store.listKnowledge(ownerId);
  assert.equal(kList1.length, 1);
  assert.equal(kList1[0].statement, '日历视图先展示高频互动时段', '必须使用真实 report.summary.conclusions');

  // Phase 2: Rerun after Report 2 finishes
  currentReports = [report1, report2];

  const rerunRes = await migrateLegacyLeaderboardReports({
    ownerId,
    leaderboardStore: dynamicStore,
    store,
    now: () => 2000
  });

  assert.equal(rerunRes.ok, true);
  assert.equal(rerunRes.completed, true, '全部完成后 completed 为 true');
  assert.equal(rerunRes.migrated, 2, '两份日报均已迁移');

  // Verify no duplicate knowledge was created for Report 1, and Report 2 was imported safely
  const kListAfter = await store.listKnowledge(ownerId);
  assert.equal(kListAfter.length, 2, '重新执行不会为 Report 1 创建重复知识，总数应为 2');
  const statements = kListAfter.map(k => k.statement).sort();
  assert.deepEqual(statements, ['日历视图先展示高频互动时段', '评论区置顶问答可提升完读率']);

  // Phase 3: Rerun again on already-completed store
  const rerun3 = await migrateLegacyLeaderboardReports({
    ownerId,
    leaderboardStore: dynamicStore,
    store,
    now: () => 3000
  });
  assert.equal(rerun3.alreadyMigrated, true);

  await store.close();
});
