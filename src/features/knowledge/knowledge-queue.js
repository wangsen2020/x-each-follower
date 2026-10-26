import {
  computeKnowledgeFingerprint,
  computeEvidenceId,
  computeTextHash,
  computeMetricsHash,
  computeInputHash,
  computeExecutionKey,
  createKnowledgeRecord,
  createEvidenceRecord,
  createAnalysisRecord,
  createKnowledgeEvidenceLink,
  createRevisionRecord,
  createJobRecord,
  createRequestRecord
} from './knowledge-model.js';

/**
 * Creates the durable Request/Job queue for the Grok Knowledge Base.
 * Implements ownerId isolation, idempotent enqueue, checkpoints,
 * exact duplicate evidence linkage, and safe cancellation/replay.
 */
export function createKnowledgeQueue({
  store,
  now = () => Date.now(),
  generateId = () => crypto.randomUUID(),
  defaultLeaseMs = 240000
}) {
  if (!store) throw new Error('store 必需');

  /**
   * Enqueues an analysis request idempotently.
   * Atomic under concurrent requests using unique indexes and one transaction.
   * - Deduplicates clientRequestId for the same ownerId.
   * - Subscribes to existing active job matching executionKey.
   * - Otherwise creates new job and request.
   */
  async function enqueueAnalysis({
    ownerId,
    clientRequestId,
    producer,
    sourceRefs = [],
    analysisSpec = {},
    requestedOutputs = ['knowledge_candidate'],
    dataPolicy = 'pinned',
    priority = 0
  }) {
    if (!ownerId) throw new Error('ownerId 必需');
    if (!clientRequestId) throw new Error('clientRequestId 必需');
    if (!producer) throw new Error('producer 必需');

    const sOwner = String(ownerId);
    const sClientReqId = String(clientRequestId);

    // Validate raw text against caller textHash: never trust unverified caller textHash
    for (const item of sourceRefs) {
      if (typeof item.text === 'string' && item.textHash) {
        const computed = computeTextHash(item.text);
        if (item.textHash !== computed) {
          throw new Error(`输入样本 ${item.postId || ''} 的 textHash 与 raw text 不一致，拒绝未经校验的 caller textHash`);
        }
      }
    }

    const inputHash = computeInputHash(sourceRefs, analysisSpec);
    const executionKey = computeExecutionKey({
      ownerId: sOwner,
      analysisSpec,
      inputHash,
      requestedOutputs
    });

    const normRequestedOutputs = Array.from(new Set(
      Array.isArray(requestedOutputs) ? requestedOutputs : [requestedOutputs]
    )).map(String).sort();

    return store.runTransaction(['jobs', 'requests', 'analysisCache'], 'readwrite', (stores, set, fail) => {
      // 1. Check if clientRequestId already exists for this ownerId
      const reqQuery = stores.requests.index('ownerClientRequest').get([sOwner, sClientReqId]);
      reqQuery.onerror = () => fail(reqQuery.error);
      reqQuery.onsuccess = () => {
        const existingReq = reqQuery.result;
        if (existingReq) {
          // Replay check: reject conflicting input on changed payload
          const existingOutputs = Array.from(new Set(
            Array.isArray(existingReq.requestedOutputs) ? existingReq.requestedOutputs : [existingReq.requestedOutputs]
          )).map(String).sort();

          const outputsMatch = existingOutputs.length === normRequestedOutputs.length &&
            existingOutputs.every((val, idx) => val === normRequestedOutputs[idx]);

          if (!outputsMatch) {
            fail(new Error(`clientRequestId 冲突: 请求 ${sClientReqId} 已存在且 requestedOutputs 不一致`));
            return;
          }

          if (existingReq.inputHash && existingReq.inputHash !== inputHash) {
            fail(new Error(`clientRequestId 冲突: 请求 ${sClientReqId} 已存在且输入样本不一致`));
            return;
          }

          if (existingReq.executionKey && existingReq.executionKey !== executionKey) {
            fail(new Error(`clientRequestId 冲突: 请求 ${sClientReqId} 已存在且分析配置不一致`));
            return;
          }

          // Check associated job to verify inputHash and executionKey
          const jobQuery = stores.jobs.get([sOwner, existingReq.jobId]);
          jobQuery.onerror = () => fail(jobQuery.error);
          jobQuery.onsuccess = () => {
            const associatedJob = jobQuery.result;
            if (!associatedJob) {
              fail(new Error(`未找到关联任务: ${existingReq.jobId}`));
              return;
            }

            if (associatedJob.inputManifest?.inputHash !== inputHash) {
              fail(new Error(`clientRequestId 冲突: 请求 ${sClientReqId} 已存在且输入样本不一致`));
              return;
            }

            if (associatedJob.executionKey !== executionKey) {
              fail(new Error(`clientRequestId 冲突: 请求 ${sClientReqId} 已存在且分析配置不一致`));
              return;
            }

            set({
              requestId: existingReq.id,
              jobId: existingReq.jobId,
              reused: true,
              request: existingReq
            });
          };
          return;
        }

        // 2. Check if an active / completed job matching executionKey already exists
        const jobQuery = stores.jobs.index('ownerExecution').get([sOwner, executionKey]);
        jobQuery.onerror = () => fail(jobQuery.error);
        jobQuery.onsuccess = () => {
          const existingJob = jobQuery.result;

          // Capability check: ensure existing job has all requested outputs
          const jobCaps = new Set([
            ...(existingJob?.outputCapabilities || []),
            ...(existingJob?.analysisSpec?.capabilities || []),
            ...(existingJob?.analysisSpec?.outputCapabilities || []),
            ...(existingJob?.analysisSpec?.requestedOutputs || [])
          ]);
          if (jobCaps.size === 0 && existingJob) {
            jobCaps.add('knowledge_candidate');
          }

          const hasAllOutputs = existingJob ? normRequestedOutputs.every(out => jobCaps.has(out)) : false;
          const canReuseJob = existingJob && !['cancelled', 'failed'].includes(existingJob.status) && hasAllOutputs;

          if (canReuseJob) {
            // If existing job is already completed, atomically deliver using businessResults from analysisCache
            if (existingJob.status === 'completed') {
              const cacheQuery = stores.analysisCache.get([sOwner, existingJob.executionKey || executionKey]);
              cacheQuery.onerror = () => fail(cacheQuery.error);
              cacheQuery.onsuccess = () => {
                const cacheEntry = cacheQuery.result;
                let businessResults = Object.hasOwn(existingJob, 'resultSavedAt')
                  ? structuredClone(existingJob.savedResult)
                  : (cacheEntry?.resultRef?.jobId === existingJob.id && Object.hasOwn(cacheEntry, 'businessResults')
                    ? structuredClone(cacheEntry.businessResults) : undefined);

                const deliverAndFinish = (finalResults) => {
                  const currentTime = now();
                  const reqRecord = createRequestRecord({
                    ownerId: sOwner,
                    id: generateId(),
                    producer,
                    clientRequestId: sClientReqId,
                    jobId: existingJob.id,
                    requestedOutputs: normRequestedOutputs,
                    deliveryStatus: 'delivered',
                    businessResults: finalResults ?? null,
                    deliveredAt: currentTime,
                    inputHash,
                    executionKey,
                    createdAt: currentTime,
                    updatedAt: currentTime
                  });
                  stores.requests.add(reqRecord);
                  set({
                    requestId: reqRecord.id,
                    jobId: existingJob.id,
                    subscribed: true,
                    reused: true,
                    jobStatus: existingJob.status,
                    deliveryStatus: 'delivered',
                    businessResults: finalResults ?? null,
                    request: reqRecord
                  });
                };

                if (businessResults !== undefined) {
                  deliverAndFinish(businessResults);
                  return;
                }

                // Fallback: check sibling delivered requests on this job if cacheEntry did not contain businessResults
                const sibQuery = stores.requests.index('ownerJob').getAll([sOwner, existingJob.id]);
                sibQuery.onerror = () => fail(sibQuery.error);
                sibQuery.onsuccess = () => {
                  const siblings = sibQuery.result || [];
                  const deliveredSibling = siblings.find(s => s.deliveryStatus === 'delivered' && Object.hasOwn(s, 'businessResults'));
                  if (deliveredSibling) {
                    deliverAndFinish(structuredClone(deliveredSibling.businessResults));
                    return;
                  }
                  // A completed checkpoint without a recoverable result must not fabricate a null delivery.
                  fail(new Error(`已完成任务 ${existingJob.id} 缺少可恢复的业务结果`));
                };
              };
              return;
            }

            // Subscribe new request to active/queued existing job
            const reqRecord = createRequestRecord({
              ownerId: sOwner,
              id: generateId(),
              producer,
              clientRequestId: sClientReqId,
              jobId: existingJob.id,
              requestedOutputs: normRequestedOutputs,
              deliveryStatus: 'pending',
              inputHash,
              executionKey,
              createdAt: now(),
              updatedAt: now()
            });
            stores.requests.add(reqRecord);
            set({
              requestId: reqRecord.id,
              jobId: existingJob.id,
              subscribed: true,
              reused: true,
              jobStatus: existingJob.status
            });
            return;
          }

          let jobId;
          let jobRecord;
          const jobOutputCapabilities = Array.from(new Set([
            ...normRequestedOutputs,
            ...(analysisSpec?.capabilities || []),
            ...(analysisSpec?.outputCapabilities || [])
          ]));

          const frozenItems = sourceRefs.map(item => {
            const pid = String(item.postId || '').trim();
            const text = typeof item.text === 'string' ? item.text : '';
            const tHash = text ? computeTextHash(text) : (item.textHash || '');
            return {
              ...item,
              postId: pid,
              text,
              textHash: tHash
            };
          });

          if (existingJob && ['cancelled', 'failed'].includes(existingJob.status)) {
            // Never recycle cancelled/failed job ID: historical checkpoints and request references remain immutable!
            const nextAttempt = (existingJob.attempt || 1) + 1;
            const newJobId = generateId();
            const attemptKey = `${executionKey}:attempt:${nextAttempt}`;

            // Retire old cancelled/failed job's executionKey to avoid unique index collision
            const retiredJob = {
              ...existingJob,
              executionKey: `${executionKey}:retired:${existingJob.attempt || 1}:${existingJob.id}`,
              supersededByJobId: newJobId,
              retiredAt: now(),
              updatedAt: now()
            };
            stores.jobs.put(retiredJob);

            // Safe cache behavior: delete any stale or invalidated cache for this executionKey
            stores.analysisCache.delete([sOwner, executionKey]);

            jobId = newJobId;
            jobRecord = createJobRecord({
              ownerId: sOwner,
              id: jobId,
              kind: analysisSpec.kind || 'generic',
              executionKey, // Canonical executionKey in ownerExecution index
              attempt: nextAttempt,
              attemptKey,
              previousJobId: existingJob.id,
              analysisSpec: {
                ...analysisSpec,
                capabilities: jobOutputCapabilities
              },
              outputCapabilities: jobOutputCapabilities,
              inputManifest: {
                items: frozenItems,
                inputHash,
                frozenAt: now(),
                dataPolicy,
                priority
              },
              lease: null,
              checkpoint: { stage: 'queued', at: now() },
              status: 'queued',
              createdAt: now(),
              updatedAt: now()
            });
            stores.jobs.add(jobRecord);
          } else {
            jobId = generateId();
            jobRecord = createJobRecord({
              ownerId: sOwner,
              id: jobId,
              kind: analysisSpec.kind || 'generic',
              executionKey,
              attempt: 1,
              attemptKey: `${executionKey}:attempt:1`,
              analysisSpec: {
                ...analysisSpec,
                capabilities: jobOutputCapabilities
              },
              outputCapabilities: jobOutputCapabilities,
              inputManifest: {
                items: frozenItems,
                inputHash,
                frozenAt: now(),
                dataPolicy,
                priority
              },
              lease: null,
              checkpoint: { stage: 'queued', at: now() },
              status: 'queued',
              createdAt: now(),
              updatedAt: now()
            });
            stores.jobs.add(jobRecord);
          }

          const reqRecord = createRequestRecord({
            ownerId: sOwner,
            id: generateId(),
            producer,
            clientRequestId: sClientReqId,
            jobId,
            requestedOutputs: normRequestedOutputs,
            deliveryStatus: 'pending',
            inputHash,
            executionKey,
            createdAt: now(),
            updatedAt: now()
          });
          stores.requests.add(reqRecord);

          set({
            requestId: reqRecord.id,
            jobId,
            created: true,
            jobStatus: 'queued',
            attempt: jobRecord.attempt,
            attemptKey: jobRecord.attemptKey,
            request: reqRecord
          });
        };
      };
    });
  }

  /**
   * Advances the checkpoint stage of a job with lease management.
   * Atomic CAS across status transitions to prevent lost updates or concurrent races.
   */
  async function advanceJobStage({
    ownerId,
    jobId,
    expectedStage,
    nextStage,
    data = {},
    leaseMs = defaultLeaseMs
  }) {
    if (!ownerId || !jobId || !nextStage) {
      throw new Error('ownerId, jobId, nextStage 均为必需');
    }
    const sOwner = String(ownerId);
    const sJobId = String(jobId);

    return store.runTransaction(['jobs'], 'readwrite', (stores, set, fail) => {
      const jobReq = stores.jobs.get([sOwner, sJobId]);
      jobReq.onerror = () => fail(jobReq.error);
      jobReq.onsuccess = () => {
        const job = jobReq.result;
        if (!job) {
          fail(new Error(`未找到任务: ${sJobId}`));
          return;
        }

        if (expectedStage && job.status !== expectedStage) {
          set({
            ok: false,
            error: 'stage_mismatch',
            currentStage: job.status,
            expectedStage
          });
          return;
        }

        // Terminal states cannot transition to other stages
        if (['completed', 'cancelled', 'failed'].includes(job.status) && job.status !== nextStage) {
          set({
            ok: false,
            error: 'terminal_state',
            currentStage: job.status,
            nextStage
          });
          return;
        }

        let lease = null;
        if (['submitted', 'resolving_data', 'ready'].includes(nextStage)) {
          lease = now() + (leaseMs || defaultLeaseMs);
        }

        const updatedJob = {
          ...job,
          status: nextStage,
          lease,
          checkpoint: {
            stage: nextStage,
            at: now(),
            data
          },
          updatedAt: now()
        };

        stores.jobs.put(updatedJob);
        set({ ok: true, job: updatedJob });
      };
    });
  }

  /**
   * Cancels a business request atomically.
   * State decisions and writes are CAS inside a single readwrite transaction:
   * - If all requests subscribing to the underlying job are cancelled and the job has
   *   not yet been submitted to Grok, the job is cancelled as well.
   * - Submitted or completed jobs are never cancelled.
   */
  async function cancelAnalysisRequest({ ownerId, requestId }) {
    if (!ownerId || !requestId) throw new Error('ownerId 与 requestId 必需');
    const sOwner = String(ownerId);
    const sReqId = String(requestId);

    return store.runTransaction(['jobs', 'requests'], 'readwrite', (stores, set, fail) => {
      const reqQuery = stores.requests.get([sOwner, sReqId]);
      reqQuery.onerror = () => fail(reqQuery.error);
      reqQuery.onsuccess = () => {
        const req = reqQuery.result;
        if (!req) {
          fail(new Error(`未找到请求: ${sReqId}`));
          return;
        }

        if (req.deliveryStatus === 'cancelled') {
          set({ ok: true, alreadyCancelled: true, requestId: sReqId });
          return;
        }

        const currentTime = now();
        const updatedReq = {
          ...req,
          deliveryStatus: 'cancelled',
          cancelledAt: currentTime,
          updatedAt: currentTime
        };
        stores.requests.put(updatedReq);

        const sibQuery = stores.requests.index('ownerJob').getAll([sOwner, req.jobId]);
        sibQuery.onerror = () => fail(sibQuery.error);
        sibQuery.onsuccess = () => {
          const siblings = sibQuery.result || [];
          const activeSiblings = siblings.filter(r => r.id !== sReqId && r.deliveryStatus !== 'cancelled');

          if (activeSiblings.length === 0) {
            const jobQuery = stores.jobs.get([sOwner, req.jobId]);
            jobQuery.onerror = () => fail(jobQuery.error);
            jobQuery.onsuccess = () => {
              const job = jobQuery.result;
              if (job && ['queued', 'resolving_data', 'ready'].includes(job.status)) {
                const cancelledJob = {
                  ...job,
                  status: 'cancelled',
                  lease: null,
                  checkpoint: {
                    stage: 'cancelled',
                    at: currentTime,
                    data: { reason: 'all_subscribers_cancelled' }
                  },
                  updatedAt: currentTime
                };
                stores.jobs.put(cancelledJob);
                set({
                  ok: true,
                  requestCancelled: true,
                  jobCancelled: true,
                  jobId: job.id
                });
                return;
              }
              set({
                ok: true,
                requestCancelled: true,
                jobCancelled: false,
                reason: job ? `job_status_is_${job.status}` : 'job_not_found'
              });
            };
            return;
          }

          set({
            ok: true,
            requestCancelled: true,
            jobCancelled: false,
            remainingActiveRequests: activeSiblings.length
          });
        };
      };
    });
  }

  /**
   * Recovers jobs whose lease has expired.
   * - Jobs submitted whose lease expired become 'uncertain'.
   * - Jobs resolving data whose lease expired become 'retry_wait'.
   */
  async function recoverInterruptedJobs({ ownerId, leaseTimeoutMs = defaultLeaseMs }) {
    if (!ownerId) throw new Error('ownerId 必需');
    const sOwner = String(ownerId);

    const jobs = await store.listJobs(sOwner);
    const currentTime = now();
    const recovered = [];
    let deliveredOutboxCount = 0;

    for (const job of jobs) {
      // 1. Deliver pending outbox requests on already completed jobs (without second Grok call)
      if (job.status === 'completed') {
        const requests = await store.listRequestsForJob(sOwner, job.id);
        const pending = requests.filter(r => r.deliveryStatus === 'pending');
        if (pending.length > 0) {
          const delivery = await replayDelivery({ ownerId: sOwner, jobId: job.id });
          deliveredOutboxCount += delivery.deliveredCount || 0;
        }
      }

      // 2. Recover expired leases
      const isExpired = (job.lease && currentTime > job.lease) ||
        (['submitted', 'resolving_data'].includes(job.status) && (currentTime - (job.checkpoint?.at || job.updatedAt) > leaseTimeoutMs));

      if (isExpired) {
        let nextStatus = job.status;
        let reason = '';
        if (job.status === 'submitted') {
          nextStatus = 'uncertain';
          reason = '任务超时或连接中断，状态未决，需核对后处理';
        } else if (job.status === 'resolving_data') {
          nextStatus = 'retry_wait';
          reason = '数据解析超时，待重试';
        }

        if (nextStatus !== job.status) {
          const patched = {
            ...job,
            status: nextStatus,
            lease: null,
            error: reason,
            checkpoint: {
              stage: nextStatus,
              at: currentTime,
              data: { previousStage: job.status, reason }
            },
            updatedAt: currentTime
          };
          await store.putJob(patched);
          recovered.push(patched);
        }
      }
    }

    return {
      recoveredCount: recovered.length,
      recoveredJobs: recovered,
      deliveredOutboxCount
    };
  }

  /**
   * Ingests analysis results with strict source validation and exact duplicate evidence linkage.
   * Atomically:
   * 1. Validates candidate evidence references against frozen job input manifest.
   * 2. Persists immutable Evidence snapshots (reusing duplicate evidence).
   * 3. Persists Analysis execution record.
   * 4. Deduplicates Knowledge by fingerprint:
   *    - Reuses existing knowledge if already in DB or earlier in the same batch.
   *    - Deduplicates duplicate fingerprints within the same batch.
   * 5. Delivers business results to subscribed requests.
   * 6. Marks job as completed. Idempotent on replay.
   * 7. Saves analysis cache entry.
   */
  async function ingestAnalysisResult({
    ownerId,
    jobId,
    producer,
    analysisSpec = {},
    inputEvidenceList = [],
    candidates = [],
    businessResults = null
  }) {
    if (!ownerId || !jobId) throw new Error('ownerId 与 jobId 必需');
    const sOwner = String(ownerId);
    const sJobId = String(jobId);

    // 1. Verify job ownership
    const job = await store.getJob(sOwner, sJobId);
    if (!job) throw new Error(`未找到任务: ${sJobId}`);
    if (job.ownerId !== sOwner) throw new Error('任务与当前 ownerId 不匹配');

    // Idempotent on replay: if job is already completed, return existing results
    if (job.status === 'completed') {
      const existingAnalyses = await store.listAnalysesForJob(sOwner, sJobId);
      const existingAnalysis = existingAnalyses[0];
      return {
        ok: true,
        replayed: true,
        jobId: sJobId,
        analysisId: existingAnalysis?.id || null,
        knowledgeCreated: job.checkpoint?.data?.knowledgeCreated || 0,
        knowledgeReused: job.checkpoint?.data?.knowledgeReused || 0,
        evidenceLinked: job.checkpoint?.data?.evidenceLinked || 0,
        deliveredRequests: job.checkpoint?.data?.deliveredRequests || 0
      };
    }

    // 2. Strict frozen manifest validation:
    // Reject empty or mismatched frozen manifest content
    const manifestItems = job.inputManifest?.items;
    if (!manifestItems || !Array.isArray(manifestItems) || manifestItems.length === 0) {
      throw new Error('任务输入清单为空或未初始化');
    }

    const manifestMap = new Map();
    for (const item of manifestItems) {
      const pid = String(item?.postId || '');
      if (!pid) {
        throw new Error('任务输入清单存在缺少 postId 的非法条目');
      }
      const text = item.text != null ? String(item.text) : '';
      const textHash = (text ? computeTextHash(text) : item.textHash) || '';
      if (!text && !textHash) {
        throw new Error(`任务输入清单中样本内容为空: ${pid}`);
      }
      manifestMap.set(pid, { ...item, postId: pid, text, textHash });
    }

    if (!Array.isArray(inputEvidenceList) || inputEvidenceList.length === 0) {
      throw new Error('输入样本列表为空');
    }

    const inputEvidenceMap = new Map();
    for (const rawEv of inputEvidenceList) {
      const postId = String(rawEv?.postId || '');
      if (!postId) throw new Error('输入样本缺少 postId');
      const manifestItem = manifestMap.get(postId);
      if (!manifestItem) {
        throw new Error(`候选知识引用了未提交或非法的样本依据（未在任务输入清单中）: ${postId}`);
      }
      const rawText = rawEv.text != null ? String(rawEv.text) : '';
      const rawHash = (rawText ? computeTextHash(rawText) : rawEv.textHash) || '';
      if (!rawText && !rawHash) {
        throw new Error(`输入样本内容为空: ${postId}`);
      }
      if (manifestItem.text && rawText && manifestItem.text.trim() !== rawText.trim()) {
        throw new Error(`输入样本内容与任务输入清单不一致: ${postId}`);
      }
      if (manifestItem.textHash && rawHash && manifestItem.textHash !== rawHash) {
        throw new Error(`输入样本内容哈希与任务输入清单不一致: ${postId}`);
      }
      if (job.inputManifest?.frozen === true) {
        if (rawEv.metrics !== undefined &&
            computeMetricsHash(rawEv.metrics) !== computeMetricsHash(manifestItem.metrics)) {
          throw new Error(`输入样本指标与冻结清单不一致: ${postId}`);
        }
        if (rawEv.capturedAt !== undefined && rawEv.capturedAt !== manifestItem.capturedAt) {
          throw new Error(`输入样本采集时间与冻结清单不一致: ${postId}`);
        }
        for (const field of ['authorId', 'availability', 'truncated']) {
          if (rawEv[field] !== undefined && rawEv[field] !== manifestItem[field]) {
            throw new Error(`输入样本 ${field} 与冻结清单不一致: ${postId}`);
          }
        }
        if (rawEv.metricStates !== undefined &&
            JSON.stringify(rawEv.metricStates) !== JSON.stringify(manifestItem.metricStates)) {
          throw new Error(`输入样本指标状态与冻结清单不一致: ${postId}`);
        }
        // The persisted frozen manifest is authoritative for evidence snapshots.
        inputEvidenceMap.set(postId, { ...rawEv, ...manifestItem });
      } else {
        inputEvidenceMap.set(postId, rawEv);
      }
    }

    for (const cand of candidates) {
      if (!Array.isArray(cand.evidencePostIds) || cand.evidencePostIds.length === 0) {
        throw new Error(`候选知识缺少证据帖子引用: "${cand.statement || cand.text || ''}"`);
      }
      for (const refPostId of cand.evidencePostIds) {
        const sRef = String(refPostId);
        if (!manifestMap.has(sRef)) {
          throw new Error(`候选知识引用了未提交或非法的样本依据（未在任务输入清单中）: ${refPostId}`);
        }
        if (!inputEvidenceMap.has(sRef)) {
          throw new Error(`候选知识引用了未提交或非法的样本依据: ${refPostId}`);
        }
      }
    }

    // 3. Perform atomic ingestion transaction
    return store.runTransaction(
      ['knowledge', 'evidence', 'analyses', 'knowledgeEvidence', 'revisions', 'jobs', 'requests', 'analysisCache'],
      'readwrite',
      (stores, set, fail) => {
        // Recheck job inside write transaction for concurrent replay safety
        const jobCheckReq = stores.jobs.get([sOwner, sJobId]);
        jobCheckReq.onerror = () => fail(jobCheckReq.error);
        jobCheckReq.onsuccess = () => {
          const currentJob = jobCheckReq.result;
          if (!currentJob) {
            fail(new Error(`未找到任务: ${sJobId}`));
            return;
          }
          if (JSON.stringify(currentJob.inputManifest) !== JSON.stringify(job.inputManifest)) {
            fail(new Error(`任务 ${sJobId} 的冻结输入在结果校验期间发生变化`));
            return;
          }
          if (currentJob.status === 'completed') {
            const anaQuery = stores.analyses.index('ownerSourceJob').getAll([sOwner, sJobId]);
            anaQuery.onerror = () => fail(anaQuery.error);
            anaQuery.onsuccess = () => {
              const existingAnalyses = anaQuery.result || [];
              const existingAnalysis = existingAnalyses[0];
              set({
                ok: true,
                replayed: true,
                jobId: sJobId,
                analysisId: existingAnalysis?.id || null,
                knowledgeCreated: currentJob.checkpoint?.data?.knowledgeCreated || 0,
                knowledgeReused: currentJob.checkpoint?.data?.knowledgeReused || 0,
                evidenceLinked: currentJob.checkpoint?.data?.evidenceLinked || 0,
                deliveredRequests: currentJob.checkpoint?.data?.deliveredRequests || 0
              });
            };
            return;
          }
          if (['cancelled', 'failed', 'waiting_data'].includes(currentJob.status)) {
            fail(new Error(`任务 ${sJobId} 当前状态 ${currentJob.status} 不可入库`));
            return;
          }

          const currentTime = now();
          const analysisId = generateId();

          // 3.1 Store Evidence records without overwriting immutable evidence
          const evidenceIdByPostId = new Map();
          for (const [postId, rawEv] of inputEvidenceMap.entries()) {
            const evRecord = createEvidenceRecord({
              ownerId: sOwner,
              platform: rawEv.platform || 'x',
              postId,
              authorId: rawEv.authorId,
              handleAtCapture: rawEv.handleAtCapture || rawEv.handle,
              url: rawEv.url,
              text: rawEv.text,
              textHash: rawEv.textHash,
              capturedAt: rawEv.capturedAt ?? null,
              metrics: rawEv.metrics,
              metricStates: rawEv.metricStates,
              truncated: rawEv.truncated,
              availability: rawEv.availability || 'available',
              legacyIncomplete: rawEv.legacyIncomplete || false
            });
            const evCheck = stores.evidence.get([sOwner, evRecord.id]);
            evCheck.onsuccess = () => {
              if (!evCheck.result) {
                stores.evidence.add(evRecord);
              }
            };
            evidenceIdByPostId.set(postId, evRecord.id);
          }

          // 3.2 Store Analysis record
          const analysisRecord = createAnalysisRecord({
            ownerId: sOwner,
            id: analysisId,
            producer: producer || currentJob.kind,
            sourceJobId: sJobId,
            reportDate: analysisSpec.reportDate || null,
            inputEvidenceIds: Array.from(evidenceIdByPostId.values()),
            inputHash: currentJob.inputManifest?.inputHash || '',
            promptVersion: analysisSpec.version || '1',
            parserVersion: analysisSpec.parserVersion || '1',
            channel: analysisSpec.channel || 'x_grok',
            model: analysisSpec.model || 'unknown',
            coverage: analysisSpec.coverage || 'full',
            status: 'completed',
            createdAt: currentTime
          });
          stores.analyses.put(analysisRecord);

          // 3.3 Ingest Candidates, deduplicating fingerprints within the same batch
          let knowledgeCreated = 0;
          let knowledgeReused = 0;
          let evidenceLinked = 0;

          const candidateGroups = new Map();
          for (const cand of candidates) {
            const type = cand.type || (cand.kind === 'low' ? 'pitfall' : 'writing_principle');
            const statement = cand.statement || cand.text || '';
            const scope = cand.scope || {};
            const fp = computeKnowledgeFingerprint(type, statement, scope);
            if (!candidateGroups.has(fp)) {
              candidateGroups.set(fp, {
                type,
                statement,
                scope,
                fingerprint: fp,
                items: []
              });
            }
            candidateGroups.get(fp).items.push({
              raw: cand,
              relation: cand.relation || 'support',
              reason: cand.reason || '',
              limitations: cand.limitations || ''
            });
          }

          const groupList = Array.from(candidateGroups.values());
          let pendingGroups = groupList.length;

          function onLookupsFinished() {
            // 3.4 Deliver to subscribed requests
            const reqQuery = stores.requests.index('ownerJob').getAll([sOwner, sJobId]);
            reqQuery.onsuccess = () => {
              const requests = reqQuery.result || [];
              let deliveredRequests = 0;
              for (const r of requests) {
                if (r.deliveryStatus !== 'cancelled') {
                  const delivered = {
                    ...r,
                    deliveryStatus: 'delivered',
                    businessResults: structuredClone(businessResults),
                    deliveredAt: currentTime,
                    updatedAt: currentTime
                  };
                  stores.requests.put(delivered);
                  deliveredRequests++;
                }
              }

              // 3.5 Mark Job completed: keep completed meaning persisted analysis
              const completedJob = {
                ...currentJob,
                status: 'completed',
                lease: null,
                savedResult: structuredClone(businessResults),
                businessResults: structuredClone(businessResults),
                resultSavedAt: currentTime,
                checkpoint: {
                  stage: 'completed',
                  at: currentTime,
                  data: {
                    knowledgeCreated,
                    knowledgeReused,
                    evidenceLinked,
                    deliveredRequests
                  }
                },
                updatedAt: currentTime
              };
              stores.jobs.put(completedJob);

              // 3.6 Save AnalysisCache
              stores.analysisCache.put({
                ownerId: sOwner,
                cacheKey: currentJob.executionKey,
                resultRef: { jobId: sJobId, analysisId },
                inputHash: currentJob.inputManifest?.inputHash || '',
                capabilities: currentJob.outputCapabilities || currentJob.analysisSpec?.capabilities || [],
                specVersion: currentJob.analysisSpec?.version || 1,
                businessResults: structuredClone(businessResults),
                knowledgeCandidates: groupList.map(g => ({
                  type: g.type,
                  statement: g.statement,
                  scope: g.scope,
                  fingerprint: g.fingerprint
                })),
                expiresAt: currentTime + 7 * 86400000,
                createdAt: currentTime
              });

              set({
                ok: true,
                jobId: sJobId,
                analysisId,
                knowledgeCreated,
                knowledgeReused,
                evidenceLinked,
                deliveredRequests
              });
            };
          }

          if (groupList.length === 0) {
            onLookupsFinished();
            return;
          }

          for (const group of groupList) {
            const fpReq = stores.knowledge.index('ownerFingerprint').get([sOwner, group.fingerprint]);
            fpReq.onsuccess = () => {
              const existing = fpReq.result;
              let targetKnowledgeId;

              if (existing) {
                targetKnowledgeId = existing.id;
                knowledgeReused += group.items.length;
                stores.knowledge.put({
                  ...existing,
                  updatedAt: currentTime
                });
              } else {
                targetKnowledgeId = generateId();
                const newRecord = createKnowledgeRecord({
                  ownerId: sOwner,
                  id: targetKnowledgeId,
                  type: group.type,
                  statement: group.statement,
                  scope: group.scope,
                  status: 'candidate',
                  revision: 1,
                  fingerprint: group.fingerprint,
                  createdAt: currentTime,
                  updatedAt: currentTime
                });
                stores.knowledge.put(newRecord);

                const revRecord = createRevisionRecord({
                  ownerId: sOwner,
                  knowledgeId: targetKnowledgeId,
                  revision: 1,
                  statement: group.statement,
                  scope: group.scope,
                  status: 'candidate',
                  reason: 'initial_ingest',
                  operator: producer || currentJob.kind,
                  createdAt: currentTime
                });
                stores.revisions.put(revRecord);
                knowledgeCreated += 1;
                if (group.items.length > 1) {
                  knowledgeReused += (group.items.length - 1);
                }
              }

              for (const item of group.items) {
                for (const postId of item.raw.evidencePostIds) {
                  const evidenceId = evidenceIdByPostId.get(String(postId));
                  if (evidenceId) {
                    const linkRecord = createKnowledgeEvidenceLink({
                      ownerId: sOwner,
                      knowledgeId: targetKnowledgeId,
                      evidenceId,
                      analysisId,
                      relation: item.relation,
                      reason: item.reason,
                      limitations: item.limitations,
                      createdAt: currentTime
                    });
                    stores.knowledgeEvidence.put(linkRecord);
                    evidenceLinked++;
                  }
                }
              }

              pendingGroups--;
              if (pendingGroups === 0) {
                onLookupsFinished();
              }
            };
          }
        };
      }
    );
  }

  /**
   * Replays delivery for pending request(s) on completed jobs using persisted results from job or analysisCache.
   * Completely idempotent, no second Grok call.
   */
  async function replayDelivery({ ownerId, requestId, jobId } = {}) {
    if (!ownerId) throw new Error('ownerId 必需');
    if (!requestId && !jobId) throw new Error('requestId 或 jobId 必需');
    const sOwner = String(ownerId);

    return store.runTransaction(['jobs', 'requests', 'analysisCache'], 'readwrite', (stores, set, fail) => {
      const deliverRequest = (req, job, cacheEntry, fallbackSiblings = []) => {
        if (req.deliveryStatus === 'delivered' || req.deliveryStatus === 'cancelled') {
          return req;
        }
        if (job?.status !== 'completed') return req;
        let results = Object.hasOwn(job, 'resultSavedAt') ? job.savedResult : undefined;
        if (results === undefined && cacheEntry?.resultRef?.jobId === job.id && Object.hasOwn(cacheEntry, 'businessResults')) {
          results = structuredClone(cacheEntry.businessResults);
        }
        if (results === undefined) {
          const sib = fallbackSiblings.find(s => s.deliveryStatus === 'delivered' && Object.hasOwn(s, 'businessResults'));
          if (sib) results = structuredClone(sib.businessResults);
        }
        if (results === undefined) return req;
        const currentTime = now();
        const delivered = {
          ...req,
          deliveryStatus: 'delivered',
          businessResults: structuredClone(results),
          deliveredAt: req.deliveredAt || currentTime,
          updatedAt: currentTime
        };
        stores.requests.put(delivered);
        return delivered;
      };

      if (requestId) {
        const sReqId = String(requestId);
        const reqQuery = stores.requests.get([sOwner, sReqId]);
        reqQuery.onerror = () => fail(reqQuery.error);
        reqQuery.onsuccess = () => {
          const req = reqQuery.result;
          if (!req) {
            fail(new Error(`未找到请求: ${sReqId}`));
            return;
          }
          if (req.deliveryStatus === 'delivered') {
            set({ ok: true, alreadyDelivered: true, businessResults: req.businessResults, request: req });
            return;
          }
          if (req.deliveryStatus === 'cancelled') {
            set({ ok: true, alreadyCancelled: true, request: req });
            return;
          }
          const jobQuery = stores.jobs.get([sOwner, req.jobId]);
          jobQuery.onerror = () => fail(jobQuery.error);
          jobQuery.onsuccess = () => {
            const job = jobQuery.result;
            if (!job || job.status !== 'completed') {
              set({ ok: true, delivered: false, reason: 'job_not_completed', request: req });
              return;
            }
            const cacheQuery = stores.analysisCache.get([sOwner, req.executionKey || job.executionKey]);
            cacheQuery.onerror = () => fail(cacheQuery.error);
            cacheQuery.onsuccess = () => {
              const cacheEntry = cacheQuery.result;
              const sibQuery = stores.requests.index('ownerJob').getAll([sOwner, req.jobId]);
              sibQuery.onerror = () => fail(sibQuery.error);
              sibQuery.onsuccess = () => {
                const delivered = deliverRequest(req, job, cacheEntry, sibQuery.result || []);
                set({ ok: true, delivered: delivered.deliveryStatus === 'delivered', businessResults: delivered.businessResults, request: delivered });
              };
            };
          };
        };
      } else {
        const sJobId = String(jobId);
        const jobQuery = stores.jobs.get([sOwner, sJobId]);
        jobQuery.onerror = () => fail(jobQuery.error);
        jobQuery.onsuccess = () => {
          const job = jobQuery.result;
          if (!job) {
            fail(new Error(`未找到任务: ${sJobId}`));
            return;
          }
          if (job.status !== 'completed') {
            set({ ok: true, deliveredCount: 0, reason: 'job_not_completed', requests: [] });
            return;
          }
          const reqQuery = stores.requests.index('ownerJob').getAll([sOwner, sJobId]);
          reqQuery.onerror = () => fail(reqQuery.error);
          reqQuery.onsuccess = () => {
            const requests = reqQuery.result || [];
            const cacheQuery = stores.analysisCache.get([sOwner, job.executionKey]);
            cacheQuery.onerror = () => fail(cacheQuery.error);
            cacheQuery.onsuccess = () => {
              const cacheEntry = cacheQuery.result;
              const deliveredList = [];
              for (const req of requests) {
                if (req.deliveryStatus === 'pending') {
                  const delivered = deliverRequest(req, job, cacheEntry, requests);
                  if (delivered.deliveryStatus === 'delivered') deliveredList.push(delivered);
                }
              }
              set({ ok: true, deliveredCount: deliveredList.length, requests: deliveredList });
            };
          };
        };
      }
    });
  }

  /**
   * Idempotent business delivery acknowledgment.
   */
  async function acknowledgeDelivery({ ownerId, requestId, ackToken = null }) {
    if (!ownerId || !requestId) throw new Error('ownerId 与 requestId 必需');
    const sOwner = String(ownerId);
    const sReqId = String(requestId);

    return store.runTransaction(['requests'], 'readwrite', (stores, set, fail) => {
      const reqQuery = stores.requests.get([sOwner, sReqId]);
      reqQuery.onerror = () => fail(reqQuery.error);
      reqQuery.onsuccess = () => {
        const req = reqQuery.result;
        if (!req) {
          fail(new Error(`未找到请求: ${sReqId}`));
          return;
        }

        if (req.ackAt) {
          set({
            ok: true,
            alreadyAcknowledged: true,
            requestId: sReqId,
            ackAt: req.ackAt,
            ackToken: req.ackToken || null
          });
          return;
        }

        if (req.deliveryStatus !== 'delivered') {
          fail(new Error(`请求 ${sReqId} 尚未交付，不能确认应用`));
          return;
        }

        const currentTime = now();
        const updatedReq = {
          ...req,
          ackAt: currentTime,
          ackToken: ackToken ? String(ackToken) : (req.ackToken || null),
          updatedAt: currentTime
        };
        stores.requests.put(updatedReq);
        set({
          ok: true,
          acknowledged: true,
          requestId: sReqId,
          ackAt: currentTime,
          ackToken: updatedReq.ackToken
        });
      };
    });
  }

  return {
    enqueueAnalysis,
    advanceJobStage,
    cancelAnalysisRequest,
    recoverInterruptedJobs,
    ingestAnalysisResult,
    replayDelivery,
    acknowledgeDelivery
  };
}
