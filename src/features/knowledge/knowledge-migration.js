import {
  computeKnowledgeFingerprint,
  computeEvidenceId,
  createKnowledgeRecord,
  createEvidenceRecord,
  createAnalysisRecord,
  createKnowledgeEvidenceLink,
  createRevisionRecord
} from './knowledge-model.js';

export const LEGACY_MEMORY_PREFIX = 'postWritingMemory:';

/**
 * Migrates legacy postWritingMemory from chrome.storage.local into the dedicated Knowledge Store.
 * - Idempotent: checks checkpoint before running.
 * - High rules map to 'writing_principle'; low rules map to 'pitfall'.
 * - Enabled rules map to 'active'; disabled rules remain preserved as 'disabled'.
 * - Preserves originalText, reason, and evidencePostIds.
 * - Marks missing full-post snapshots as legacyIncomplete: true and availability: 'legacy_reference'.
 * - Atomically imports knowledge and links evidence.
 * - Does not mark empty or partial migrations completed.
 * - Does not switch activeStore during mere import.
 */
export async function migrateLegacyWritingMemory({
  ownerId,
  storageApi = globalThis.chrome,
  store,
  now = () => Date.now(),
  generateId = () => crypto.randomUUID()
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  if (!store) throw new Error('store 必需');
  const sOwner = String(ownerId);

  // 1. Check existing migration checkpoint
  const existingCheckpoint = await store.getMeta(sOwner, 'migration:legacyWritingMemory');
  if (existingCheckpoint && existingCheckpoint.completed) {
    return {
      ok: true,
      alreadyMigrated: true,
      migratedAt: existingCheckpoint.migratedAt,
      count: existingCheckpoint.count || 0
    };
  }

  // 2. Read legacy storage
  let legacyMemory = null;
  const storageKey = `${LEGACY_MEMORY_PREFIX}${sOwner}`;
  if (storageApi?.storage?.local) {
    const raw = await storageApi.storage.local.get(storageKey);
    legacyMemory = raw?.[storageKey] || null;
  }

  const rules = Array.isArray(legacyMemory?.rules) ? legacyMemory.rules : [];
  if (rules.length === 0) {
    // Do not mark empty migration completed incorrectly. Do not switch activeStore.
    return { ok: true, migrated: 0, completed: false };
  }

  // 3. Atomically import legacy rules
  const currentTime = now();
  const analysisId = generateId();

  const migrationSummary = await store.runTransaction(
    ['knowledge', 'evidence', 'analyses', 'knowledgeEvidence', 'revisions', 'meta'],
    'readwrite',
    (stores, set) => {
      // Create migration Analysis record
      const allReferencedPostIds = new Set();
      for (const r of rules) {
        if (Array.isArray(r.evidencePostIds)) {
          for (const pid of r.evidencePostIds) {
            if (pid) allReferencedPostIds.add(String(pid));
          }
        }
      }

      const evidenceIdByPostId = new Map();
      for (const postId of allReferencedPostIds) {
        const evRecord = createEvidenceRecord({
          ownerId: sOwner,
          platform: 'x',
          postId,
          text: `[历史记忆引用样本 #${postId}]`,
          capturedAt: currentTime,
          availability: 'legacy_reference',
          legacyIncomplete: true
        });
        const evCheck = stores.evidence.get([sOwner, evRecord.id]);
        evCheck.onsuccess = () => {
          if (!evCheck.result) {
            stores.evidence.add(evRecord);
          }
        };
        evidenceIdByPostId.set(postId, evRecord.id);
      }

      const analysisRecord = createAnalysisRecord({
        ownerId: sOwner,
        id: analysisId,
        producer: 'migration:legacy_writing_memory',
        sourceJobId: legacyMemory?.id || `legacy_rev_${legacyMemory?.revision || 0}`,
        inputEvidenceIds: Array.from(evidenceIdByPostId.values()),
        channel: 'legacy_migration',
        model: 'unknown',
        coverage: 'partial',
        status: 'completed',
        createdAt: currentTime
      });
      stores.analyses.put(analysisRecord);

      let importedCount = 0;
      let linkedCount = 0;

      for (const rule of rules) {
        const rawText = String(rule.text || '').trim();
        if (!rawText) continue;

        const originalText = rule.originalText ? String(rule.originalText).trim() : null;
        const type = rule.kind === 'low' ? 'pitfall' : 'writing_principle';
        // Preserve disabled legacy rules as disabled: enabled=true -> active, enabled=false -> disabled
        const status = rule.enabled ? 'active' : 'disabled';
        const scope = {
          legacySource: 'postWritingMemory',
          topic: 'writing_preference'
        };
        const fp = computeKnowledgeFingerprint(type, rawText, scope);

        const knowledgeId = generateId();
        const knowledgeRecord = createKnowledgeRecord({
          ownerId: sOwner,
          id: knowledgeId,
          type,
          statement: rawText,
          originalText,
          scope,
          status,
          revision: 1,
          fingerprint: fp,
          createdAt: rule.createdAt || currentTime,
          updatedAt: currentTime
        });
        stores.knowledge.put(knowledgeRecord);

        // Create initial revision with preserved status
        const revRecord = createRevisionRecord({
          ownerId: sOwner,
          knowledgeId,
          revision: 1,
          statement: rawText,
          originalText,
          scope,
          status,
          reason: rule.reason || 'legacy_migration',
          operator: 'migration',
          createdAt: rule.createdAt || currentTime
        });
        stores.revisions.put(revRecord);
        importedCount++;

        // Link evidence
        if (Array.isArray(rule.evidencePostIds)) {
          for (const pid of rule.evidencePostIds) {
            const evId = evidenceIdByPostId.get(String(pid));
            if (evId) {
              const link = createKnowledgeEvidenceLink({
                ownerId: sOwner,
                knowledgeId,
                evidenceId: evId,
                analysisId,
                relation: 'support',
                reason: rule.reason || '来自历史写作记忆样本',
                limitations: '历史引用样本正文缺失',
                createdAt: currentTime
              });
              stores.knowledgeEvidence.put(link);
              linkedCount++;
            }
          }
        }
      }

      // Record checkpoint ONLY (do not switch activeStore during mere import)
      if (importedCount > 0) {
        const checkpoint = {
          completed: true,
          migratedAt: currentTime,
          count: importedCount,
          linkedEvidenceCount: linkedCount,
          revision: legacyMemory?.revision || 0
        };
        stores.meta.put({
          ownerId: sOwner,
          key: 'migration:legacyWritingMemory',
          value: checkpoint,
          updatedAt: currentTime
        });
      }

      set({
        ok: true,
        completed: importedCount > 0,
        migrated: importedCount,
        linkedEvidence: linkedCount,
        migratedAt: currentTime
      });
    }
  );

  return migrationSummary;
}

/**
 * Migrates conclusions from completed leaderboard digest reports into candidate knowledge.
 * Critical: leaderboard reports use report.summary.conclusions, not report.conclusions.
 * Does not mark empty or partial migration completed incorrectly.
 */
export async function migrateLegacyLeaderboardReports({
  ownerId,
  leaderboardStore,
  store,
  now = () => Date.now(),
  generateId = () => crypto.randomUUID()
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  if (!leaderboardStore || !store) throw new Error('leaderboardStore 与 store 必需');
  const sOwner = String(ownerId);

  // Check checkpoint
  const existingCheckpoint = await store.getMeta(sOwner, 'migration:legacyLeaderboardReports');
  if (existingCheckpoint && existingCheckpoint.completed) {
    return {
      ok: true,
      alreadyMigrated: true,
      migratedAt: existingCheckpoint.migratedAt,
      count: existingCheckpoint.count || 0
    };
  }

  const reports = await leaderboardStore.listReports(sOwner);
  const getConclusions = r => {
    let summary = r.summary;
    if (typeof summary === 'string') {
      try { summary = JSON.parse(summary); } catch {}
    }
    // Critical: leaderboard reports use report.summary.conclusions, not report.conclusions
    if (Array.isArray(summary?.conclusions)) return summary.conclusions;
    if (Array.isArray(r.conclusions)) return r.conclusions;
    return [];
  };

  const completedReports = (reports || []).filter(
    r => r.status === 'completed' && getConclusions(r).length > 0
  );
  const hasPartial = (reports || []).some(
    r => r.status === 'partial' || r.status === 'collecting' || r.status === 'running'
  );

  const currentTime = now();
  const migratedDates = new Set(existingCheckpoint?.migratedDates || []);
  let totalMigrated = existingCheckpoint?.count || 0;

  if (completedReports.length === 0) {
    if (hasPartial) {
      await store.setMeta(sOwner, 'migration:legacyLeaderboardReports', {
        completed: false,
        partial: true,
        migratedDates: Array.from(migratedDates),
        migratedAt: currentTime,
        count: totalMigrated
      });
    }
    return { ok: true, migrated: totalMigrated, completed: false, partial: hasPartial };
  }

  for (let i = 0; i < completedReports.length; i++) {
    const report = completedReports[i];
    const reportKey = String(report.date || report.id || `report_${i}`);
    if (migratedDates.has(reportKey)) {
      continue;
    }

    const analysisId = generateId();
    const conclusions = getConclusions(report);
    let summaryObj = report.summary;
    if (typeof summaryObj === 'string') {
      try { summaryObj = JSON.parse(summaryObj); } catch {}
    }
    const limitations = summaryObj?.limitations || report.limitations || '';

    await store.runTransaction(
      ['knowledge', 'evidence', 'analyses', 'knowledgeEvidence', 'revisions', 'meta'],
      'readwrite',
      (stores, set, fail) => {
        // Atomic per-report checkpoint recheck inside transaction
        const cpReq = stores.meta.get([sOwner, 'migration:legacyLeaderboardReports']);
        cpReq.onerror = () => fail(cpReq.error);
        cpReq.onsuccess = () => {
          const currentCp = cpReq.result?.value || {};
          const currentMigratedDates = new Set(currentCp.migratedDates || migratedDates);
          if (currentMigratedDates.has(reportKey)) {
            set({ skipped: true, alreadyMigrated: true });
            return;
          }

          const evidenceIdByPostId = new Map();
          for (const conc of conclusions) {
            if (Array.isArray(conc.evidencePostIds)) {
              for (const pid of conc.evidencePostIds) {
                const sPid = String(pid);
                if (!evidenceIdByPostId.has(sPid)) {
                  const evRecord = createEvidenceRecord({
                    ownerId: sOwner,
                    platform: 'x',
                    postId: sPid,
                    text: `[榜单日报引用样本 #${sPid}]`,
                    capturedAt: currentTime,
                    availability: 'legacy_reference',
                    legacyIncomplete: true
                  });
                  const evCheck = stores.evidence.get([sOwner, evRecord.id]);
                  evCheck.onsuccess = () => {
                    if (!evCheck.result) {
                      stores.evidence.add(evRecord);
                    }
                  };
                  evidenceIdByPostId.set(sPid, evRecord.id);
                }
              }
            }
          }

          const analysisRecord = createAnalysisRecord({
            ownerId: sOwner,
            id: analysisId,
            producer: 'migration:leaderboard_digest',
            sourceJobId: report.date || 'legacy_report',
            reportDate: report.date || null,
            inputEvidenceIds: Array.from(evidenceIdByPostId.values()),
            channel: 'leaderboard_report',
            model: 'unknown',
            coverage: report.coverage?.status || (Array.isArray(report.coverage) ? (report.coverage.every(c => c.originalComplete && c.repliesComplete) ? 'full' : 'partial') : 'full'),
            status: 'completed',
            createdAt: currentTime
          });
          stores.analyses.put(analysisRecord);

          let reportMigratedCount = 0;
          const concList = [...conclusions];
          let pendingLookups = concList.length;

          const finishReport = () => {
            currentMigratedDates.add(reportKey);
            migratedDates.add(reportKey);
            totalMigrated = (currentCp.count || 0) + reportMigratedCount;

            const allCompletedDone = completedReports.every(r =>
              currentMigratedDates.has(String(r.date || r.id || ''))
            );
            const isCompleted = allCompletedDone && !hasPartial;

            const checkpoint = {
              completed: isCompleted,
              partial: hasPartial,
              migratedDates: Array.from(currentMigratedDates),
              migratedAt: currentTime,
              count: totalMigrated
            };

            // Atomically write checkpoint in the same transaction
            stores.meta.put({
              ownerId: sOwner,
              key: 'migration:legacyLeaderboardReports',
              value: checkpoint,
              updatedAt: currentTime
            });

            stores.meta.put({
              ownerId: sOwner,
              key: `migration:leaderboardReport:${reportKey}`,
              value: {
                reportKey,
                count: reportMigratedCount,
                migratedAt: currentTime
              },
              updatedAt: currentTime
            });

            set({ ok: true, migratedCount: reportMigratedCount });
          };

          if (concList.length === 0) {
            finishReport();
            return;
          }

          for (const conc of concList) {
            const rawText = typeof conc === 'string'
              ? conc.trim()
              : String(conc.text || conc.statement || '').trim();
            if (!rawText) {
              pendingLookups--;
              if (pendingLookups === 0) finishReport();
              continue;
            }

            const originalText = conc.originalText ? String(conc.originalText).trim() : null;
            const scope = {
              source: 'leaderboard_report',
              date: report.date,
              ...(typeof conc === 'object' && conc !== null && conc.scope ? conc.scope : {})
            };
            const fp = computeKnowledgeFingerprint('writing_principle', rawText, scope);

            // Deduplicate by ownerFingerprint to prevent unique constraint error on rerun
            const fpReq = stores.knowledge.index('ownerFingerprint').get([sOwner, fp]);
            fpReq.onerror = () => fail(fpReq.error);
            fpReq.onsuccess = () => {
              const existingKnowledge = fpReq.result;
              let targetKnowledgeId;

              if (existingKnowledge) {
                targetKnowledgeId = existingKnowledge.id;
                stores.knowledge.put({
                  ...existingKnowledge,
                  updatedAt: currentTime
                });
              } else {
                targetKnowledgeId = generateId();
                const knowledgeRecord = createKnowledgeRecord({
                  ownerId: sOwner,
                  id: targetKnowledgeId,
                  type: 'writing_principle',
                  statement: rawText,
                  originalText,
                  scope,
                  status: 'candidate',
                  revision: 1,
                  fingerprint: fp,
                  createdAt: currentTime,
                  updatedAt: currentTime
                });
                stores.knowledge.put(knowledgeRecord);

                const revRecord = createRevisionRecord({
                  ownerId: sOwner,
                  knowledgeId: targetKnowledgeId,
                  revision: 1,
                  statement: rawText,
                  originalText,
                  scope,
                  status: 'candidate',
                  reason: conc.reason || `迁移自 ${report.date || reportKey} 榜单日报`,
                  operator: 'migration',
                  createdAt: currentTime
                });
                stores.revisions.put(revRecord);
                reportMigratedCount++;
              }

              if (Array.isArray(conc.evidencePostIds)) {
                for (const pid of conc.evidencePostIds) {
                  const evId = evidenceIdByPostId.get(String(pid));
                  if (evId) {
                    const link = createKnowledgeEvidenceLink({
                      ownerId: sOwner,
                      knowledgeId: targetKnowledgeId,
                      evidenceId: evId,
                      analysisId,
                      relation: 'support',
                      reason: conc.reason || `来自 ${report.date || reportKey} 榜单日报依据`,
                      limitations,
                      createdAt: currentTime
                    });
                    stores.knowledgeEvidence.put(link);
                  }
                }
              }

              pendingLookups--;
              if (pendingLookups === 0) {
                finishReport();
              }
            };
          }
        };
      }
    );
  }

  const finalCheckpoint = await store.getMeta(sOwner, 'migration:legacyLeaderboardReports');
  const isFinalCompleted = Boolean(finalCheckpoint?.completed);
  return {
    ok: true,
    migrated: finalCheckpoint?.count || totalMigrated,
    completed: isFinalCompleted,
    partial: hasPartial
  };
}

/**
 * Returns the current migration and active store status for an owner.
 */
export async function getMigrationStatus({ ownerId, store }) {
  if (!ownerId || !store) throw new Error('ownerId 与 store 必需');
  const sOwner = String(ownerId);

  const activeStore = (await store.getMeta(sOwner, 'activeStore')) || 'legacy';
  const legacyMemory = (await store.getMeta(sOwner, 'migration:legacyWritingMemory')) || null;
  const leaderboardReports = (await store.getMeta(sOwner, 'migration:legacyLeaderboardReports')) || null;
  const knowledgeList = await store.listKnowledge(sOwner);

  return {
    ownerId: sOwner,
    activeStore,
    legacyMemoryMigrated: Boolean(legacyMemory?.completed),
    leaderboardReportsMigrated: Boolean(leaderboardReports?.completed),
    knowledgeCount: knowledgeList.length,
    activeCount: knowledgeList.filter(k => k.status === 'active').length,
    candidateCount: knowledgeList.filter(k => k.status === 'candidate').length
  };
}
