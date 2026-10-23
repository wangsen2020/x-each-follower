import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createKnowledgeStore } from '../src/features/knowledge/knowledge-store.js';
import {
  createKnowledgeRecord,
  createEvidenceRecord,
  createJobRecord,
  createRequestRecord
} from '../src/features/knowledge/knowledge-model.js';

test('knowledge store enforces strict ownerId isolation across accounts', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });

  // Account 100 data
  await store.putKnowledge(createKnowledgeRecord({
    ownerId: '100',
    id: 'k-common',
    type: 'writing_principle',
    statement: '账号100的原则'
  }));
  await store.putEvidence(createEvidenceRecord({
    ownerId: '100',
    id: 'ev-common',
    postId: 'p-1',
    text: '推文内容100'
  }));
  await store.putJob(createJobRecord({
    ownerId: '100',
    id: 'job-100',
    executionKey: 'exec_100_test'
  }));
  await store.putRequest(createRequestRecord({
    ownerId: '100',
    id: 'req-100',
    producer: 'test',
    clientRequestId: 'client-req-1',
    jobId: 'job-100'
  }));
  await store.setMeta('100', 'activeStore', 'xef-knowledge-v1');

  // Account 101 data with same local ID
  await store.putKnowledge(createKnowledgeRecord({
    ownerId: '101',
    id: 'k-common',
    type: 'pitfall',
    statement: '账号101的避坑'
  }));
  await store.putEvidence(createEvidenceRecord({
    ownerId: '101',
    id: 'ev-common',
    postId: 'p-2',
    text: '推文内容101'
  }));
  await store.setMeta('101', 'activeStore', 'legacy');

  // 1. Account 100 cannot read Account 101 data and vice versa
  const k100 = await store.getKnowledge('100', 'k-common');
  const k101 = await store.getKnowledge('101', 'k-common');
  assert.equal(k100.statement, '账号100的原则');
  assert.equal(k101.statement, '账号101的避坑');

  // Querying from an unrelated account 102 returns undefined/empty
  assert.equal(await store.getKnowledge('102', 'k-common'), undefined);
  assert.equal(await store.getEvidence('102', 'ev-common'), undefined);
  assert.equal(await store.getJob('102', 'job-100'), undefined);
  assert.equal(await store.getRequest('102', 'req-100'), undefined);
  assert.equal((await store.listKnowledge('102')).length, 0);
  assert.equal(await store.getMeta('102', 'activeStore'), undefined);

  // Listing knowledge is owner-scoped
  const list100 = await store.listKnowledge('100');
  const list101 = await store.listKnowledge('101');
  assert.equal(list100.length, 1);
  assert.equal(list100[0].type, 'writing_principle');
  assert.equal(list101.length, 1);
  assert.equal(list101[0].type, 'pitfall');

  // Meta isolation
  assert.equal(await store.getMeta('100', 'activeStore'), 'xef-knowledge-v1');
  assert.equal(await store.getMeta('101', 'activeStore'), 'legacy');

  await store.close();
});

test('knowledge store supports multi-table atomic transactions and evidence linkage lookup', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const ownerId = 'user_abc';

  await store.runTransaction(
    ['knowledge', 'evidence', 'knowledgeEvidence', 'revisions'],
    'readwrite',
    (stores, set) => {
      const k = createKnowledgeRecord({
        ownerId,
        id: 'k-1',
        type: 'conditional_observation',
        statement: '在技术讨论中引用代码行号能提升可信度'
      });
      const ev1 = createEvidenceRecord({
        ownerId,
        id: 'ev-1',
        postId: 'post_1001',
        text: '这是样例推文1'
      });
      const ev2 = createEvidenceRecord({
        ownerId,
        id: 'ev-2',
        postId: 'post_1002',
        text: '这是样例推文2'
      });

      stores.knowledge.put(k);
      stores.evidence.put(ev1);
      stores.evidence.put(ev2);

      stores.knowledgeEvidence.put({
        ownerId,
        knowledgeId: 'k-1',
        evidenceId: 'ev-1',
        analysisId: 'ana-1',
        relation: 'support',
        reason: '正向支持',
        limitations: '',
        createdAt: 1000
      });
      stores.knowledgeEvidence.put({
        ownerId,
        knowledgeId: 'k-1',
        evidenceId: 'ev-2',
        analysisId: 'ana-1',
        relation: 'support',
        reason: '第二条证据',
        limitations: '',
        createdAt: 1000
      });

      set(true);
    }
  );

  const linked = await store.listEvidenceForKnowledge(ownerId, 'k-1');
  assert.equal(linked.length, 2);
  const postIds = linked.map(e => e.postId).sort();
  assert.deepEqual(postIds, ['post_1001', 'post_1002']);

  // Another account cannot read this knowledge's evidence links
  const foreignLinked = await store.listEvidenceForKnowledge('other_user', 'k-1');
  assert.equal(foreignLinked.length, 0);

  await store.close();
});

test('store regression: immutable evidence cannot be overwritten', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  const ownerId = 'user_immutable';

  const ev1 = createEvidenceRecord({
    ownerId,
    id: 'ev_fixed_001',
    postId: 'post_100',
    text: '首次采集快照'
  });

  // 1. First write succeeds
  await store.putEvidence(ev1);
  const fetched = await store.getEvidence(ownerId, 'ev_fixed_001');
  assert.equal(fetched.text, '首次采集快照');

  // 2. Second write with same ID must be rejected and not overwrite
  const evOverwriting = createEvidenceRecord({
    ownerId,
    id: 'ev_fixed_001',
    postId: 'post_100',
    text: '尝试篡改的不可变证据快照'
  });

  await assert.rejects(
    async () => {
      await store.putEvidence(evOverwriting);
    },
    /不可变证据记录已存在，禁止覆盖/
  );

  // Original snapshot remains intact
  const afterAttempt = await store.getEvidence(ownerId, 'ev_fixed_001');
  assert.equal(afterAttempt.text, '首次采集快照');

  await store.close();
});

test('store regression: bounded blocked-open and late-close behavior', async () => {
  let closed = false;
  let aborted = false;
  const fakeBlocked = {
    open() {
      const request = {
        transaction: {
          abort() { aborted = true; }
        }
      };
      queueMicrotask(() => {
        request.onblocked?.();
        setTimeout(() => {
          request.onupgradeneeded?.();
          request.result = {
            close() { closed = true; },
            onversionchange: null
          };
          request.onsuccess?.();
        }, 30);
      });
      return request;
    }
  };

  const store = createKnowledgeStore({
    indexedDB: fakeBlocked,
    dbName: 'blocked-store-test',
    blockedTimeoutMs: 10
  });

  // Must reject when blocked open times out
  await assert.rejects(
    async () => {
      await store.getKnowledge('123', 'k-1');
    },
    /被占用/
  );

  // Wait for late callbacks to fire
  await new Promise(resolve => setTimeout(resolve, 40));

  // Late upgrade must be aborted and late success connection must be closed immediately
  assert.equal(aborted, true, 'blocked abandoned open must abort late upgrade transaction');
  assert.equal(closed, true, 'blocked abandoned open must close late connection on arrival');

  // Test slow normal open: when onblocked is not called, slow open must succeed
  let slowOpened = false;
  const fakeSlowNormal = {
    open() {
      const request = {};
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            return {
              objectStore: () => ({ get: () => ({ onsuccess: null }) }),
              oncomplete: null,
              onerror: null,
              onabort: null
            };
          },
          close() { slowOpened = true; },
          onversionchange: null
        };
        request.onsuccess?.();
      }, 30);
      return request;
    }
  };

  const slowStore = createKnowledgeStore({
    indexedDB: fakeSlowNormal,
    dbName: 'slow-store-test',
    blockedTimeoutMs: 10
  });

  // Must NOT fail or time out because onblocked was never called
  const pendingSlow = slowStore.close();
  await assert.doesNotReject(async () => {
    await pendingSlow;
  });

  // Test close() while opening is in flight
  let inFlightDbClosed = false;
  const slowFactory = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          close() { inFlightDbClosed = true; },
          onversionchange: null
        };
        request.onsuccess?.();
      });
      return request;
    }
  };

  const store2 = createKnowledgeStore({ indexedDB: slowFactory });
  // Start operation (triggers opening)
  const pendingOp = store2.getKnowledge('123', 'k-1');
  // Immediately call close()
  await store2.close();
  await pendingOp.catch(() => {});

  assert.equal(inFlightDbClosed, true, 'closing store while opening closes the resolved connection');
});
