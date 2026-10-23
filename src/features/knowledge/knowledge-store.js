import { KNOWLEDGE_DB_NAME, KNOWLEDGE_DB_VERSION } from './knowledge-model.js';

/**
 * Creates the dedicated IndexedDB store for the Grok Knowledge Base.
 * Enforces ownerId isolation across all tables and operations.
 */
export function createKnowledgeStore({
  indexedDB: factory = globalThis.indexedDB,
  name = KNOWLEDGE_DB_NAME,
  blockedTimeoutMs = 1000
} = {}) {
  let opening = null;
  let activeConnection = null;
  let isClosed = false;

  async function db() {
    if (activeConnection) return activeConnection;
    if (!opening) {
      isClosed = false;
      opening = new Promise((resolve, reject) => {
        let abandoned = false;
        let blockedTimer = null;

        const request = factory.open(name, KNOWLEDGE_DB_VERSION);
        request.onupgradeneeded = () => {
          if (abandoned || isClosed) {
            try { request.transaction?.abort(); } catch {}
            return;
          }
          const database = request.result;

          // 1. knowledge: [ownerId, id]
          if (!database.objectStoreNames.contains('knowledge')) {
            const ks = database.createObjectStore('knowledge', { keyPath: ['ownerId', 'id'] });
            ks.createIndex('owner', 'ownerId');
            ks.createIndex('ownerStatus', ['ownerId', 'status']);
            ks.createIndex('ownerType', ['ownerId', 'type']);
            ks.createIndex('ownerFingerprint', ['ownerId', 'fingerprint'], { unique: true });
            ks.createIndex('ownerUpdated', ['ownerId', 'updatedAt']);
          }

          // 2. evidence: [ownerId, id]
          if (!database.objectStoreNames.contains('evidence')) {
            const es = database.createObjectStore('evidence', { keyPath: ['ownerId', 'id'] });
            es.createIndex('owner', 'ownerId');
            es.createIndex('ownerPost', ['ownerId', 'postId']);
            es.createIndex('ownerAuthor', ['ownerId', 'authorId']);
          }

          // 3. analyses: [ownerId, id]
          if (!database.objectStoreNames.contains('analyses')) {
            const as = database.createObjectStore('analyses', { keyPath: ['ownerId', 'id'] });
            as.createIndex('owner', 'ownerId');
            as.createIndex('ownerSourceJob', ['ownerId', 'sourceJobId']);
          }

          // 4. knowledgeEvidence: [ownerId, knowledgeId, evidenceId, analysisId]
          if (!database.objectStoreNames.contains('knowledgeEvidence')) {
            const kes = database.createObjectStore('knowledgeEvidence', {
              keyPath: ['ownerId', 'knowledgeId', 'evidenceId', 'analysisId']
            });
            kes.createIndex('ownerKnowledge', ['ownerId', 'knowledgeId']);
            kes.createIndex('ownerEvidence', ['ownerId', 'evidenceId']);
            kes.createIndex('ownerAnalysis', ['ownerId', 'analysisId']);
          }

          // 5. revisions: [ownerId, knowledgeId, revision]
          if (!database.objectStoreNames.contains('revisions')) {
            const rs = database.createObjectStore('revisions', {
              keyPath: ['ownerId', 'knowledgeId', 'revision']
            });
            rs.createIndex('ownerKnowledge', ['ownerId', 'knowledgeId']);
          }

          // 6. jobs: [ownerId, id]
          if (!database.objectStoreNames.contains('jobs')) {
            const js = database.createObjectStore('jobs', { keyPath: ['ownerId', 'id'] });
            js.createIndex('owner', 'ownerId');
            js.createIndex('ownerStatus', ['ownerId', 'status']);
            js.createIndex('ownerExecution', ['ownerId', 'executionKey'], { unique: true });
          }

          // 7. requests: [ownerId, id]
          if (!database.objectStoreNames.contains('requests')) {
            const rqs = database.createObjectStore('requests', { keyPath: ['ownerId', 'id'] });
            rqs.createIndex('owner', 'ownerId');
            rqs.createIndex('ownerJob', ['ownerId', 'jobId']);
            rqs.createIndex('ownerClientRequest', ['ownerId', 'clientRequestId'], { unique: true });
          }

          // 8. analysisCache: [ownerId, cacheKey]
          if (!database.objectStoreNames.contains('analysisCache')) {
            const cs = database.createObjectStore('analysisCache', { keyPath: ['ownerId', 'cacheKey'] });
            cs.createIndex('owner', 'ownerId');
          }

          // 9. budgetLedger: [grokAccountKey, channel, day, attemptId]
          if (!database.objectStoreNames.contains('budgetLedger')) {
            database.createObjectStore('budgetLedger', {
              keyPath: ['grokAccountKey', 'channel', 'day', 'attemptId']
            });
          }

          // 10. contextUses: [ownerId, requestId]
          if (!database.objectStoreNames.contains('contextUses')) {
            database.createObjectStore('contextUses', { keyPath: ['ownerId', 'requestId'] });
          }

          // 11. meta: [ownerId, key]
          if (!database.objectStoreNames.contains('meta')) {
            database.createObjectStore('meta', { keyPath: ['ownerId', 'key'] });
          }
        };

        const cleanupBlockedTimer = () => {
          if (blockedTimer) {
            clearTimeout(blockedTimer);
            blockedTimer = null;
          }
        };

        request.onerror = (event) => {
          cleanupBlockedTimer();
          if (abandoned || isClosed) {
            event?.preventDefault?.();
            return;
          }
          opening = null;
          activeConnection = null;
          reject(request.error || new Error('打开知识库数据库失败'));
        };

        request.onblocked = () => {
          if (abandoned || isClosed || blockedTimer) return;
          const onTimeout = () => {
            if (abandoned || isClosed) return;
            abandoned = true;
            cleanupBlockedTimer();
            opening = null;
            activeConnection = null;
            try { request.transaction?.abort(); } catch {}
            reject(new Error('知识库数据库升级被占用，请关闭旧页面后重试。'));
          };

          if (blockedTimeoutMs <= 0) {
            onTimeout();
          } else {
            blockedTimer = setTimeout(onTimeout, blockedTimeoutMs);
          }
        };

        request.onsuccess = () => {
          cleanupBlockedTimer();
          const value = request.result;
          if (abandoned || isClosed) {
            try { value?.close(); } catch {}
            opening = null;
            if (!abandoned) {
              reject(new Error('知识库数据库已关闭'));
            }
            return;
          }
          value.onversionchange = () => {
            try { value.close(); } catch {}
            opening = null;
            activeConnection = null;
          };
          activeConnection = value;
          resolve(value);
        };
      }).catch(err => {
        opening = null;
        activeConnection = null;
        throw err;
      });
    }
    return opening;
  }

  async function runTransaction(tables, mode, fn) {
    const connection = await db();
    return new Promise((resolve, reject) => {
      let isSettled = false;
      let txError = null;

      const tx = connection.transaction(tables, mode);
      let result;

      const fail = (err) => {
        if (isSettled) return;
        isSettled = true;
        txError = err;
        try { tx.abort(); } catch {}
        reject(err);
      };

      tx.oncomplete = () => {
        if (isSettled) return;
        isSettled = true;
        resolve(result);
      };
      tx.onerror = () => {
        if (isSettled) return;
        isSettled = true;
        reject(txError || tx.error);
      };
      tx.onabort = () => {
        if (isSettled) return;
        isSettled = true;
        reject(txError || tx.error || new Error('知识库事务中断'));
      };

      const stores = {};
      const tableList = Array.isArray(tables) ? tables : [tables];
      for (const t of tableList) {
        stores[t] = tx.objectStore(t);
      }
      try {
        fn(stores, value => { result = value; }, fail);
      } catch (err) {
        fail(err);
      }
    });
  }

  const transactSingle = (table, mode, fn) =>
    runTransaction([table], mode, (stores, set, fail) => fn(stores[table], set, fail));

  return {
    async close() {
      isClosed = true;
      const current = activeConnection;
      const pending = opening;
      activeConnection = null;
      opening = null;
      if (current) {
        try { current.close(); } catch {}
      }
      if (pending) {
        try {
          const db = await pending;
          try { db?.close(); } catch {}
        } catch {}
      }
    },

    runTransaction,

    // --- Knowledge operations ---
    getKnowledge(ownerId, id) {
      if (!ownerId || !id) return Promise.resolve(undefined);
      return transactSingle('knowledge', 'readonly', (store, set) => {
        const req = store.get([String(ownerId), String(id)]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    listKnowledge(ownerId, { status, type } = {}) {
      if (!ownerId) return Promise.resolve([]);
      const sOwner = String(ownerId);
      return transactSingle('knowledge', 'readonly', (store, set) => {
        let req;
        if (status && type) {
          req = store.index('ownerStatus').getAll([sOwner, status]);
          req.onsuccess = () => {
            const list = (req.result || []).filter(item => item.type === type);
            set(list);
          };
          return;
        }
        if (status) {
          req = store.index('ownerStatus').getAll([sOwner, status]);
        } else if (type) {
          req = store.index('ownerType').getAll([sOwner, type]);
        } else {
          req = store.index('owner').getAll(sOwner);
        }
        req.onsuccess = () => set(req.result || []);
      });
    },

    findKnowledgeByFingerprint(ownerId, fingerprint) {
      if (!ownerId || !fingerprint) return Promise.resolve(undefined);
      return transactSingle('knowledge', 'readonly', (store, set) => {
        const req = store.index('ownerFingerprint').get([String(ownerId), String(fingerprint)]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    putKnowledge(knowledge) {
      if (!knowledge?.ownerId || !knowledge?.id) {
        return Promise.reject(new Error('知识记录缺少 ownerId 或 id'));
      }
      return transactSingle('knowledge', 'readwrite', (store, set) => {
        store.put(structuredClone(knowledge));
        set(knowledge);
      });
    },

    // --- Evidence operations ---
    getEvidence(ownerId, id) {
      if (!ownerId || !id) return Promise.resolve(undefined);
      return transactSingle('evidence', 'readonly', (store, set) => {
        const req = store.get([String(ownerId), String(id)]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    findEvidenceByPostId(ownerId, postId) {
      if (!ownerId || !postId) return Promise.resolve([]);
      return transactSingle('evidence', 'readonly', (store, set) => {
        const req = store.index('ownerPost').getAll([String(ownerId), String(postId)]);
        req.onsuccess = () => set(req.result || []);
      });
    },

    putEvidence(evidence) {
      if (!evidence?.ownerId || !evidence?.id) {
        return Promise.reject(new Error('证据记录缺少 ownerId 或 id'));
      }
      return transactSingle('evidence', 'readwrite', (store, set, fail) => {
        const key = [String(evidence.ownerId), String(evidence.id)];
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result) {
            fail(new Error(`不可变证据记录已存在，禁止覆盖: ${evidence.id}`));
            return;
          }
          store.add(structuredClone(evidence));
          set(evidence);
        };
      });
    },

    listEvidenceForKnowledge(ownerId, knowledgeId) {
      if (!ownerId || !knowledgeId) return Promise.resolve([]);
      const sOwner = String(ownerId);
      const sKid = String(knowledgeId);

      return runTransaction(['knowledgeEvidence', 'evidence'], 'readonly', (stores, set) => {
        const linkReq = stores.knowledgeEvidence.index('ownerKnowledge').getAll([sOwner, sKid]);
        linkReq.onsuccess = () => {
          const links = linkReq.result || [];
          if (links.length === 0) {
            set([]);
            return;
          }
          const evidenceList = [];
          let pending = links.length;
          for (const link of links) {
            const evReq = stores.evidence.get([sOwner, link.evidenceId]);
            evReq.onsuccess = () => {
              if (evReq.result) {
                evidenceList.push({
                  ...evReq.result,
                  relation: link.relation,
                  reason: link.reason,
                  analysisId: link.analysisId
                });
              }
              pending--;
              if (pending === 0) {
                set(evidenceList);
              }
            };
          }
        };
      });
    },

    // --- KnowledgeEvidence operations ---
    putKnowledgeEvidence(link) {
      if (!link?.ownerId || !link?.knowledgeId || !link?.evidenceId || !link?.analysisId) {
        return Promise.reject(new Error('知识证据关联缺少主键字段'));
      }
      return transactSingle('knowledgeEvidence', 'readwrite', (store, set) => {
        store.put(structuredClone(link));
        set(link);
      });
    },

    listKnowledgeEvidence(ownerId, knowledgeId) {
      if (!ownerId || !knowledgeId) return Promise.resolve([]);
      return transactSingle('knowledgeEvidence', 'readonly', (store, set) => {
        const req = store.index('ownerKnowledge').getAll([String(ownerId), String(knowledgeId)]);
        req.onsuccess = () => set(req.result || []);
      });
    },

    // --- Revisions operations ---
    getRevision(ownerId, knowledgeId, revision) {
      if (!ownerId || !knowledgeId || revision === undefined) return Promise.resolve(undefined);
      return transactSingle('revisions', 'readonly', (store, set) => {
        const req = store.get([String(ownerId), String(knowledgeId), revision]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    listRevisions(ownerId, knowledgeId) {
      if (!ownerId || !knowledgeId) return Promise.resolve([]);
      return transactSingle('revisions', 'readonly', (store, set) => {
        const req = store.index('ownerKnowledge').getAll([String(ownerId), String(knowledgeId)]);
        req.onsuccess = () => set((req.result || []).sort((a, b) => a.revision - b.revision));
      });
    },

    putRevision(rev) {
      if (!rev?.ownerId || !rev?.knowledgeId || rev?.revision === undefined) {
        return Promise.reject(new Error('修订记录缺少主键字段'));
      }
      return transactSingle('revisions', 'readwrite', (store, set) => {
        store.put(structuredClone(rev));
        set(rev);
      });
    },

    // --- Analyses operations ---
    getAnalysis(ownerId, id) {
      if (!ownerId || !id) return Promise.resolve(undefined);
      return transactSingle('analyses', 'readonly', (store, set) => {
        const req = store.get([String(ownerId), String(id)]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    putAnalysis(analysis) {
      if (!analysis?.ownerId || !analysis?.id) {
        return Promise.reject(new Error('分析记录缺少 ownerId 或 id'));
      }
      return transactSingle('analyses', 'readwrite', (store, set) => {
        store.put(structuredClone(analysis));
        set(analysis);
      });
    },

    listAnalysesForJob(ownerId, sourceJobId) {
      if (!ownerId || !sourceJobId) return Promise.resolve([]);
      return transactSingle('analyses', 'readonly', (store, set) => {
        const req = store.index('ownerSourceJob').getAll([String(ownerId), String(sourceJobId)]);
        req.onsuccess = () => set(req.result || []);
      });
    },

    // --- Job operations ---
    getJob(ownerId, id) {
      if (!ownerId || !id) return Promise.resolve(undefined);
      return transactSingle('jobs', 'readonly', (store, set) => {
        const req = store.get([String(ownerId), String(id)]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    findJobByExecutionKey(ownerId, executionKey) {
      if (!ownerId || !executionKey) return Promise.resolve(undefined);
      return transactSingle('jobs', 'readonly', (store, set) => {
        const req = store.index('ownerExecution').get([String(ownerId), String(executionKey)]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    listJobs(ownerId, { status } = {}) {
      if (!ownerId) return Promise.resolve([]);
      const sOwner = String(ownerId);
      return transactSingle('jobs', 'readonly', (store, set) => {
        const req = status
          ? store.index('ownerStatus').getAll([sOwner, status])
          : store.index('owner').getAll(sOwner);
        req.onsuccess = () => set(req.result || []);
      });
    },

    putJob(job) {
      if (!job?.ownerId || !job?.id) {
        return Promise.reject(new Error('任务记录缺少 ownerId 或 id'));
      }
      return transactSingle('jobs', 'readwrite', (store, set) => {
        store.put(structuredClone(job));
        set(job);
      });
    },

    // --- Request operations ---
    getRequest(ownerId, id) {
      if (!ownerId || !id) return Promise.resolve(undefined);
      return transactSingle('requests', 'readonly', (store, set) => {
        const req = store.get([String(ownerId), String(id)]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    findRequestByClientRequestId(ownerId, clientRequestId) {
      if (!ownerId || !clientRequestId) return Promise.resolve(undefined);
      return transactSingle('requests', 'readonly', (store, set) => {
        const req = store.index('ownerClientRequest').get([String(ownerId), String(clientRequestId)]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    listRequestsForJob(ownerId, jobId) {
      if (!ownerId || !jobId) return Promise.resolve([]);
      return transactSingle('requests', 'readonly', (store, set) => {
        const req = store.index('ownerJob').getAll([String(ownerId), String(jobId)]);
        req.onsuccess = () => set(req.result || []);
      });
    },

    putRequest(request) {
      if (!request?.ownerId || !request?.id) {
        return Promise.reject(new Error('请求记录缺少 ownerId 或 id'));
      }
      return transactSingle('requests', 'readwrite', (store, set) => {
        store.put(structuredClone(request));
        set(request);
      });
    },

    // --- AnalysisCache operations ---
    getCache(ownerId, cacheKey) {
      if (!ownerId || !cacheKey) return Promise.resolve(undefined);
      return transactSingle('analysisCache', 'readonly', (store, set) => {
        const req = store.get([String(ownerId), String(cacheKey)]);
        req.onsuccess = () => set(req.result || undefined);
      });
    },

    putCache(cacheEntry) {
      if (!cacheEntry?.ownerId || !cacheEntry?.cacheKey) {
        return Promise.reject(new Error('缓存条目缺少 ownerId 或 cacheKey'));
      }
      return transactSingle('analysisCache', 'readwrite', (store, set) => {
        store.put(structuredClone(cacheEntry));
        set(cacheEntry);
      });
    },

    // --- Meta operations ---
    getMeta(ownerId, key) {
      if (!ownerId || !key) return Promise.resolve(undefined);
      return transactSingle('meta', 'readonly', (store, set) => {
        const req = store.get([String(ownerId), String(key)]);
        req.onsuccess = () => set(req.result?.value ?? req.result);
      });
    },

    setMeta(ownerId, key, value) {
      if (!ownerId || !key) {
        return Promise.reject(new Error('元数据缺少 ownerId 或 key'));
      }
      const record = {
        ownerId: String(ownerId),
        key: String(key),
        value: structuredClone(value),
        updatedAt: Date.now()
      };
      return transactSingle('meta', 'readwrite', (store, set) => {
        store.put(record);
        set(record);
      });
    }
  };
}
