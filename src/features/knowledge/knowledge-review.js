import {
  KNOWLEDGE_TYPES,
  KNOWLEDGE_STATUSES,
  EVIDENCE_RELATIONS,
  fastHash,
  normalizeStatement,
  normalizeScope,
  computeKnowledgeFingerprint,
  createKnowledgeRecord,
  createEvidenceRecord,
  createAnalysisRecord,
  createKnowledgeEvidenceLink,
  createRevisionRecord
} from './knowledge-model.js';
import { safeXPostUrl } from '../../shared/urls.js';

/**
 * Creates the atomic review service for the Grok Knowledge Base.
 * Implements:
 * - Immutable revision snapshots
 * - Optimistic revision check
 * - Idempotent repeated reviews
 * - Strict account isolation (ownerId, never nickname)
 * - Safe X source URL validation and original text preservation
 * - Zero deletion operations (no deletes)
 */
export function createKnowledgeReviewService({
  store,
  now = () => Date.now(),
  generateId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `k_${Date.now()}_${fastHash(String(Math.random()))}`)
} = {}) {
  if (!store) throw new Error('store 必需');

  return {
    /**
     * Creates a manual knowledge candidate.
     * Can be used without automated producers.
     * Optionally links a validated safe X source URL as evidence.
     */
    async createCandidate({
      ownerId,
      id,
      type = 'writing_principle',
      statement,
      originalText = null,
      scope = {},
      sourceUrl = '',
      relation = 'support',
      reason = '',
      limitations = '',
      operator = 'user'
    } = {}) {
      if (!ownerId) throw new Error('ownerId 必需');
      const sOwner = String(ownerId).trim();
      if (!sOwner) throw new Error('ownerId 不能为空');

      if (!KNOWLEDGE_TYPES.includes(type)) {
        throw new Error(`非法的知识类型: ${type}`);
      }

      const cleanStmt = normalizeStatement(statement);
      if (!cleanStmt) {
        throw new Error('知识正文不能为空');
      }

      const normScope = typeof scope === 'object' && scope !== null ? structuredClone(scope) : {};
      const fp = computeKnowledgeFingerprint(type, cleanStmt, normScope);

      // Validate sourceUrl if provided
      let cleanSourceUrl = '';
      let postId = '';
      let handleAtCapture = '';
      if (sourceUrl) {
        cleanSourceUrl = safeXPostUrl(sourceUrl);
        if (!cleanSourceUrl) {
          throw new Error('来源链接必须是有效的 X (Twitter) 链接');
        }
        const postMatch = cleanSourceUrl.match(/\/(?:status|statuses)\/(\d+)/i);
        postId = postMatch ? postMatch[1] : `manual_post_${fastHash(cleanSourceUrl)}`;
        const handleMatch = cleanSourceUrl.match(/https:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status/i);
        handleAtCapture = handleMatch ? handleMatch[1] : '';
      }

      if (cleanSourceUrl && relation && !EVIDENCE_RELATIONS.includes(relation)) {
        throw new Error(`非法的证据关系类型: ${relation}`);
      }

      const kid = id ? String(id).trim() : generateId();
      const currentTime = now();

      const kRecord = createKnowledgeRecord({
        ownerId: sOwner,
        id: kid,
        type,
        statement: cleanStmt,
        originalText: originalText ? String(originalText) : null,
        scope: normScope,
        status: 'candidate',
        revision: 1,
        fingerprint: fp,
        createdAt: currentTime,
        updatedAt: currentTime
      });

      const revRecord = createRevisionRecord({
        ownerId: sOwner,
        knowledgeId: kid,
        revision: 1,
        statement: cleanStmt,
        originalText: originalText ? String(originalText) : null,
        scope: normScope,
        status: 'candidate',
        reason: reason || '手动创建候选知识',
        operator: String(operator || 'user'),
        parentRefs: [],
        createdAt: currentTime
      });

      const tables = cleanSourceUrl
        ? ['knowledge', 'revisions', 'evidence', 'analyses', 'knowledgeEvidence']
        : ['knowledge', 'revisions'];

      return store.runTransaction(tables, 'readwrite', (stores, set, fail) => {
        // Check if record with same ID already exists
        const idReq = stores.knowledge.get([sOwner, kid]);
        idReq.onsuccess = () => {
          if (idReq.result) {
            fail(new Error(`知识条目 ID 已存在，禁止覆盖: ${kid}`));
            return;
          }

          // Check fingerprint uniqueness
          const fpReq = stores.knowledge.index('ownerFingerprint').get([sOwner, fp]);
          fpReq.onsuccess = () => {
            if (fpReq.result) {
              fail(new Error('相同内容的知识条目已存在'));
              return;
            }

          stores.knowledge.add(kRecord);
          stores.revisions.add(revRecord);

            if (!cleanSourceUrl) {
              set({ ok: true, knowledge: kRecord, revision: revRecord });
              return;
            }

            // Manual source URL is a reference, not a fabricated captured post
            const evRecord = createEvidenceRecord({
              ownerId: sOwner,
              platform: 'x',
              postId,
              handleAtCapture,
              url: cleanSourceUrl,
              text: originalText ? String(originalText) : '',
              capturedAt: currentTime,
              availability: 'legacy_reference'
            });

            // Check if evidence already exists in DB to prevent overwriting immutable evidence
            const evGetReq = stores.evidence.get([sOwner, evRecord.id]);
            evGetReq.onsuccess = () => {
              if (!evGetReq.result) {
                stores.evidence.add(evRecord);
              }

              const analysisRecord = createAnalysisRecord({
                ownerId: sOwner,
                id: `analysis_manual_${kid}_${currentTime}`,
                producer: 'manual_user',
                sourceJobId: '',
                inputEvidenceIds: [evRecord.id],
                channel: 'manual',
                model: 'user',
                status: 'completed',
                createdAt: currentTime
              });
              stores.analyses.put(analysisRecord);

              const linkRecord = createKnowledgeEvidenceLink({
                ownerId: sOwner,
                knowledgeId: kid,
                evidenceId: evRecord.id,
                analysisId: analysisRecord.id,
                relation: relation || 'support',
                reason: reason || '手动添加的证据来源',
                limitations: limitations ? String(limitations) : '',
                createdAt: currentTime
              });
              stores.knowledgeEvidence.put(linkRecord);

              set({
                ok: true,
                knowledge: kRecord,
                revision: revRecord,
                evidence: evRecord,
                link: linkRecord
              });
            };
          };
        };
      });
    },

    /**
     * Atomically reviews a knowledge record.
     * Actions:
     * - 'approve' -> status: 'active'
     * - 'reject'  -> status: 'disabled'
     * Supports optimistic concurrency check, idempotent repeated reviews,
     * and immutable revision snapshots. Never deletes records.
     */
    async reviewKnowledge({
      ownerId,
      knowledgeId,
      action,
      expectedRevision,
      reason = '',
      operator = 'user',
      statement,
      scope
    } = {}) {
      if (!ownerId) throw new Error('ownerId 必需');
      if (!knowledgeId) throw new Error('knowledgeId 必需');
      const sOwner = String(ownerId).trim();
      const sKid = String(knowledgeId).trim();

      let targetStatus;
      if (action === 'approve') {
        targetStatus = 'active';
      } else if (action === 'reject') {
        targetStatus = 'disabled';
      } else if (KNOWLEDGE_STATUSES.includes(action)) {
        targetStatus = action;
      } else {
        throw new Error(`非法的审核操作: ${action}`);
      }

      const defaultReason = action === 'approve'
        ? '人工审核通过'
        : (action === 'reject' ? '人工审核拒绝' : `状态变更为 ${targetStatus}`);

      return store.runTransaction(['knowledge', 'revisions'], 'readwrite', (stores, set, fail) => {
        const kReq = stores.knowledge.get([sOwner, sKid]);
        kReq.onsuccess = () => {
          const current = kReq.result;
          if (!current) {
            fail(new Error(`知识条目不存在: ${sKid}`));
            return;
          }
          if (current.ownerId !== sOwner) {
            fail(new Error('无权访问该账号知识条目'));
            return;
          }

          // Check existing revision snapshot for current.revision
          const revReq = stores.revisions.get([sOwner, sKid, current.revision]);
          revReq.onsuccess = () => {
            const currRev = revReq.result;

            // Optimistic revision check with idempotent retry support
            if (expectedRevision !== undefined && expectedRevision !== null && current.revision !== expectedRevision) {
              // Check if this was a repeated idempotent call after the revision was already bumped
              if (current.revision === expectedRevision + 1 && current.status === targetStatus) {
                const sameReason = !reason || (currRev && currRev.reason === reason);
                const noStmtChange = statement === undefined || normalizeStatement(statement) === current.statement;
                const noScopeChange = scope === undefined || JSON.stringify(scope) === JSON.stringify(current.scope);
                if (sameReason && noStmtChange && noScopeChange) {
                  set({
                    ok: true,
                    idempotent: true,
                    unchanged: true,
                    knowledge: current
                  });
                  return;
                }
              }
              fail(new Error(`知识版本冲突：期望版本 ${expectedRevision}，当前版本 ${current.revision}`));
              return;
            }

            // If already at targetStatus and revision matches
            if (current.status === targetStatus) {
              const noStmtChange = statement === undefined || normalizeStatement(statement) === current.statement;
              const noScopeChange = scope === undefined || JSON.stringify(scope) === JSON.stringify(current.scope);
              const sameReason = !reason || (currRev && currRev.reason === reason);
              if (noStmtChange && noScopeChange) {
                if (!sameReason) {
                  fail(new Error(`知识版本冲突：审核原因已变更（期望版本 ${expectedRevision ?? current.revision}，当前版本 ${current.revision}）`));
                  return;
                }
                set({
                  ok: true,
                  idempotent: true,
                  unchanged: true,
                  knowledge: current
                });
                return;
              }
            }

            // Existing records may have revision zero or one
            const currentRev = Number.isInteger(current.revision) && current.revision >= 0 ? current.revision : 0;
            const nextRev = currentRev + 1;
            const currentTime = now();

            // If original baseline revision is missing in revisions table, backfill it to preserve history
            if (!currRev) {
              const baselineRev = createRevisionRecord({
                ownerId: sOwner,
                knowledgeId: sKid,
                revision: currentRev,
                statement: current.statement,
                originalText: current.originalText ?? null,
                scope: current.scope || {},
                status: current.status,
                reason: 'initial_baseline',
                operator: 'system',
                parentRefs: [],
                createdAt: current.createdAt || currentTime
              });
              stores.revisions.add(baselineRev);
            }

            const finalStatement = statement !== undefined ? normalizeStatement(statement) : current.statement;
            if (!finalStatement) {
              fail(new Error('知识正文不能为空'));
              return;
            }

            const finalScope = scope !== undefined && typeof scope === 'object' && scope !== null
              ? structuredClone(scope)
              : (current.scope || {});

            const finalFp = (statement !== undefined || scope !== undefined)
              ? computeKnowledgeFingerprint(current.type, finalStatement, finalScope)
              : current.fingerprint;

            const updatedKnowledge = {
              ...current,
              statement: finalStatement,
              originalText: current.originalText ?? null,
              scope: finalScope,
              status: targetStatus,
              revision: nextRev,
              fingerprint: finalFp,
              updatedAt: currentTime
            };

            const revRecord = createRevisionRecord({
              ownerId: sOwner,
              knowledgeId: sKid,
              revision: nextRev,
              statement: finalStatement,
              originalText: current.originalText ?? null,
              scope: finalScope,
              status: targetStatus,
              reason: reason || defaultReason,
              operator: String(operator || 'user'),
              parentRefs: [current.revision],
              createdAt: currentTime
            });

            stores.knowledge.put(updatedKnowledge);
            stores.revisions.add(revRecord);

            set({
              ok: true,
              idempotent: false,
              unchanged: false,
              knowledge: updatedKnowledge,
              revision: revRecord
            });
          };
        };
      });
    },

    /**
     * Lists knowledge records for an owner with optional status and type filters.
     */
    async listKnowledge(ownerId, { status, type } = {}) {
      if (!ownerId) return [];
      return store.listKnowledge(String(ownerId).trim(), { status, type });
    },

    /**
     * Gets a single knowledge record.
     */
    async getKnowledge(ownerId, knowledgeId) {
      if (!ownerId || !knowledgeId) return undefined;
      return store.getKnowledge(String(ownerId).trim(), String(knowledgeId).trim());
    },

    /**
     * Gets a knowledge record along with all linked evidence and revision snapshots.
     */
    async getKnowledgeWithDetails(ownerId, knowledgeId) {
      if (!ownerId || !knowledgeId) return null;
      const sOwner = String(ownerId).trim();
      const sKid = String(knowledgeId).trim();

      const [knowledge, evidence, revisions] = await Promise.all([
        store.getKnowledge(sOwner, sKid),
        store.listEvidenceForKnowledge(sOwner, sKid),
        store.listRevisions(sOwner, sKid)
      ]);

      if (!knowledge) return null;

      return {
        knowledge,
        evidence: evidence || [],
        revisions: revisions || []
      };
    },

    /**
     * Lists evidence linked to a knowledge item.
     */
    async listEvidenceForKnowledge(ownerId, knowledgeId) {
      if (!ownerId || !knowledgeId) return [];
      return store.listEvidenceForKnowledge(String(ownerId).trim(), String(knowledgeId).trim());
    },

    /**
     * Lists revisions for a knowledge item.
     */
    async listRevisions(ownerId, knowledgeId) {
      if (!ownerId || !knowledgeId) return [];
      return store.listRevisions(String(ownerId).trim(), String(knowledgeId).trim());
    }
  };
}
