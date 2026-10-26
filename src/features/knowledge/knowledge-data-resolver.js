import {
  computeInputHash,
  computeTextHash,
  hasMetricDependency
} from './knowledge-model.js';

export const DATA_POLICY_MODES = Object.freeze(['pinned', 'latest']);

export class AccountMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccountMismatchError';
  }
}

/**
 * Deep freezes an object and all nested properties recursively, making it strictly immutable.
 */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = obj[key];
    if (val !== null && (typeof val === 'object' || typeof val === 'function') && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Normalizes data policy options.
 * - pinned: preserves enqueue-time snapshot, refuses substitution if lost.
 * - latest: checks freshness, allows single targeted fetch then freezes.
 */
export function normalizeDataPolicy(policy = 'pinned') {
  if (typeof policy === 'string') {
    const mode = policy.toLowerCase();
    if (!DATA_POLICY_MODES.includes(mode)) {
      throw new Error(`非法的 dataPolicy 模式: ${policy}，有效值为 pinned 或 latest`);
    }
    return {
      mode,
      maxStaleMs: mode === 'latest' ? 24 * 3600 * 1000 : Infinity,
      allowNetwork: mode === 'latest',
      maxFetchesPerTask: 3,
      onMissing: 'waiting_data',
      refuseSubstitution: mode === 'pinned'
    };
  }
  if (typeof policy === 'object' && policy !== null) {
    const mode = String(policy.mode || 'pinned').toLowerCase();
    if (!DATA_POLICY_MODES.includes(mode)) {
      throw new Error(`非法的 dataPolicy 模式: ${policy.mode}，有效值为 pinned 或 latest`);
    }
    return {
      mode,
      maxStaleMs: Number.isFinite(policy.maxStaleMs)
        ? Math.max(0, policy.maxStaleMs)
        : (mode === 'latest' ? 24 * 3600 * 1000 : Infinity),
      allowNetwork: mode === 'latest' && policy.allowNetwork !== false,
      maxFetchesPerTask: Number.isInteger(policy.maxFetchesPerTask) && policy.maxFetchesPerTask >= 0
        ? policy.maxFetchesPerTask
        : 3,
      onMissing: ['partial', 'waiting_data', 'failed'].includes(policy.onMissing)
        ? policy.onMissing
        : 'waiting_data',
      refuseSubstitution: mode === 'pinned',
    };
  }
  throw new Error('dataPolicy 必须是字符串或配置对象');
}

/**
 * Validates declared required fields and metrics against an item snapshot.
 * Never invents values for missing mandatory metrics.
 */
export function validateDeclaredRequiredFields(item, analysisSpec = {}) {
  const missing = [];
  const metricStates = { ...(item?.metricStates || {}) };

  // 1. Text requirement
  if (analysisSpec.requireText !== false && (!item || typeof item.text !== 'string' || !item.text.trim())) {
    missing.push('text');
  }

  // 2. Metrics dependencies
  const metricDep = hasMetricDependency(analysisSpec);
  const declaredMetrics = Array.isArray(analysisSpec.requiredMetrics)
    ? analysisSpec.requiredMetrics
    : (metricDep ? ['views'] : []);

  const metrics = item?.metrics;

  // Record available/missing states for any metrics already present on item
  if (metrics && typeof metrics === 'object') {
    for (const [key, val] of Object.entries(metrics)) {
      if (metricStates[key] === undefined) {
        metricStates[key] = (val !== undefined && val !== null && Number.isFinite(val)) ? 'available' : 'missing';
      }
    }
  }

  for (const metricKey of declaredMetrics) {
    const val = metrics?.[metricKey];
    if (val === undefined || val === null || !Number.isFinite(val)) {
      missing.push(`metrics.${metricKey}`);
      metricStates[metricKey] = 'missing';
    } else {
      metricStates[metricKey] = 'available';
    }
  }

  // 3. Other declared required fields
  const declaredFields = Array.isArray(analysisSpec.requiredFields) ? analysisSpec.requiredFields : [];
  for (const field of declaredFields) {
    if (field.startsWith('metrics.')) {
      const mKey = field.slice(8);
      if (!declaredMetrics.includes(mKey)) {
        const val = metrics?.[mKey];
        if (val === undefined || val === null || !Number.isFinite(val)) {
          missing.push(field);
          metricStates[mKey] = 'missing';
        } else {
          metricStates[mKey] = 'available';
        }
      }
    } else if (field === 'authorId' && (!item?.authorId || item.authorId === 'unknown')) {
      missing.push('authorId');
    } else if (item?.[field] === undefined || item?.[field] === null) {
      missing.push(field);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    metricStates
  };
}

/**
 * Validates snapshot freshness against maxStaleMs.
 */
export function validateSnapshotFreshness(snapshot, maxStaleMs, nowTime = Date.now()) {
  if (!snapshot) return { fresh: false, stale: true, reason: '快照不存在' };
  if (!Number.isFinite(snapshot.capturedAt)) {
    return { fresh: false, stale: true, reason: '快照无有效捕获时间 capturedAt' };
  }
  if (maxStaleMs === Infinity) {
    return { fresh: true, stale: false, ageMs: Math.max(0, nowTime - snapshot.capturedAt) };
  }
  const ageMs = nowTime - snapshot.capturedAt;
  const stale = ageMs > maxStaleMs;
  return {
    fresh: !stale,
    stale,
    ageMs: Math.max(0, ageMs),
    maxStaleMs
  };
}

/**
 * Resolves appropriate adapter for a producer from an adapter registry, map, or function.
 */
export function resolveAdapter(adapters, producer) {
  if (!adapters) return null;
  if (typeof adapters === 'function') return adapters(producer);
  if (typeof adapters.get === 'function') return adapters.get(producer);
  if (typeof adapters === 'object') {
    if (producer && adapters[producer]) return adapters[producer];
    if (adapters.default) return adapters.default;
  }
  return null;
}

/**
 * Constructs and freezes the input manifest immutably.
 */
export function freezeInputManifest({
  items,
  analysisSpec = {},
  dataPolicy,
  currentTime = Date.now(),
  fetchCount = 0,
  maxFetches = 3,
  missingFields = [],
  limitations = []
}) {
  const normItems = items.map(item => ({
    postId: String(item.postId || '').trim(),
    authorId: String(item.authorId || ''),
    handleAtCapture: String(item.handleAtCapture || ''),
    url: String(item.url || (item.postId ? `https://x.com/i/web/status/${item.postId}` : '')),
    text: String(item.text || ''),
    textHash: item.text ? computeTextHash(item.text) : (item.textHash || ''),
    metrics: item.metrics && typeof item.metrics === 'object' ? structuredClone(item.metrics) : null,
    metricStates: item.metricStates ? structuredClone(item.metricStates) : null,
    originalPostText: item.originalPostText ?? null,
    coverage: item.coverage ?? null,
    statisticsWindow: item.statisticsWindow ?? null,
    availability: item.availability || (item.text ? 'available' : 'missing'),
    truncated: Boolean(item.truncated),
    capturedAt: Number.isFinite(item.capturedAt) ? item.capturedAt : null,
    missingFields: Array.isArray(item.missingFields) ? [...item.missingFields] : [],
    limitations: item.limitations || null
  }));

  const inputHash = computeInputHash(normItems, analysisSpec);
  const hasMissing = missingFields.length > 0 || normItems.some(i => i.availability !== 'available' || i.missingFields?.length > 0);
  const coverage = hasMissing ? 'partial' : 'full';

  const manifest = {
    frozen: true,
    frozenAt: currentTime,
    inputHash,
    dataPolicy: typeof dataPolicy === 'object' ? structuredClone(dataPolicy) : dataPolicy,
    coverage,
    items: normItems,
    stats: {
      totalItems: normItems.length,
      availableItems: normItems.filter(i => i.availability === 'available').length,
      missingItems: normItems.filter(i => i.availability !== 'available').length,
      partialItems: normItems.filter(i => i.missingFields?.length > 0).length,
      fetchCount,
      maxFetches
    },
    missingFields: Array.from(new Set(missingFields)),
    limitations: Array.from(new Set(limitations))
  };

  return deepFreeze(manifest);
}

/**
 * Resolves source data and constructs a frozen input manifest according to section 20.5.2.
 * - Dependency-injected adapters read snapshots without knowing underlying DB table shapes.
 * - Pinned: preserves enqueue-time snapshot and refuses substitution if lost.
 * - Latest: checks freshness, allows single targeted fetch then freezes; retries reuse frozen manifest.
 * - Enforces account/owner check and per-task targeted fetch budget (no 3-channel rescans).
 * - Missing mandatory stats returns waiting_data or partial per spec, never inventing values.
 */
export async function resolveTaskData({
  ownerId,
  job = null,
  sourceRefs = null,
  analysisSpec = null,
  dataPolicy = null,
  priority = 0,
  producer = null,
  adapters = {},
  getCurrentOwner = null,
  now = () => Date.now(),
  defaultMaxFetches = 3,
  defaultMaxStaleMs = 24 * 3600 * 1000
} = {}) {
  if (job?.ownerId && ownerId && String(job.ownerId) !== String(ownerId)) {
    throw new AccountMismatchError('传入账号与持久任务所属账号不一致');
  }
  const effectiveOwner = String(job?.ownerId || ownerId || '').trim();
  if (!effectiveOwner) {
    throw new AccountMismatchError('ownerId 必需且必须为非空字符串');
  }

  // 1. Owner account verification
  if (typeof getCurrentOwner === 'function') {
    const current = await getCurrentOwner();
    const currentAccountId = typeof current === 'object' && current !== null
      ? (current.accountId || current.ownerId || current.id)
      : current;
    if (currentAccountId && String(currentAccountId) !== effectiveOwner) {
      throw new AccountMismatchError(`账号不匹配: 当前登录账号为 ${currentAccountId}，任务所属账号为 ${effectiveOwner}`);
    }
  }

  // 2. Frozen retry check: reuse existing frozen manifest directly without substitution or re-fetching
  const existingManifest = job?.inputManifest;
  if (existingManifest?.frozen === true &&
      !['waiting_data', 'failed'].includes(job?.status) &&
      Array.isArray(existingManifest.items) && existingManifest.items.length > 0) {
    return {
      status: 'ready',
      reused: true,
      manifest: existingManifest,
      coverage: existingManifest.coverage || 'full',
      items: existingManifest.items
    };
  }

  // 3. Resolve configuration
  const spec = job?.analysisSpec || analysisSpec || {};
  const rawPolicy = job?.inputManifest?.dataPolicy || dataPolicy || job?.dataPolicy || (job?.kind === 'scheduled' ? 'latest' : 'pinned');
  const policy = normalizeDataPolicy(rawPolicy);
  const maxFetches = policy.maxFetchesPerTask ?? defaultMaxFetches;
  const currentTime = now();

  // 4. Source refs resolution
  const refs = (Array.isArray(sourceRefs) && sourceRefs.length > 0)
    ? sourceRefs
    : (Array.isArray(job?.inputManifest?.items) && job.inputManifest.items.length > 0
      ? job.inputManifest.items
      : (Array.isArray(job?.sourceRefs) ? job.sourceRefs : []));

  if (!refs || refs.length === 0) {
    return {
      status: 'waiting_data',
      reason: '无输入样本引用',
      manifest: null
    };
  }

  const effectiveProducer = producer || job?.producer || 'default';
  let fetchCount = 0;

  const resolvedItems = [];
  const taskMissingFields = [];
  const taskLimitations = [];
  const missingSources = [];
  const missingMandatoryStats = [];

  for (const ref of refs) {
    const postId = String(ref?.postId || ref?.id || '').trim();
    if (!postId) {
      throw new Error('输入样本必须包含有效 postId');
    }

    // Account check on ref
    if (ref.ownerId && String(ref.ownerId) !== effectiveOwner) {
      throw new AccountMismatchError(`样本 ${postId} 所属账号 ${ref.ownerId} 与任务所属账号 ${effectiveOwner} 不符`);
    }

    const itemProducer = ref.producer || effectiveProducer;
    const adapter = resolveAdapter(adapters, itemProducer);

    let snapshot = null;

    // Step A: Resolve existing snapshot first
    if (policy.mode === 'pinned') {
      // Pinned policy: Enqueue-time snapshot preservation
      const hasInlineSnapshot = (typeof ref.text === 'string' && ref.text !== '') ||
        (ref.snapshot && typeof ref.snapshot === 'object') ||
        (ref.capturedAt && ref.metrics !== undefined);

      if (hasInlineSnapshot) {
        // Enqueue-time snapshot is strictly preserved
        const src = (ref.snapshot && typeof ref.snapshot === 'object') ? ref.snapshot : ref;
        snapshot = {
          postId,
          authorId: src.authorId || ref.authorId || '',
          handleAtCapture: src.handleAtCapture || ref.handleAtCapture || '',
          url: src.url || ref.url || `https://x.com/i/web/status/${postId}`,
          text: src.text,
          metrics: src.metrics || null,
          metricStates: src.metricStates || null,
          capturedAt: Number.isFinite(src.capturedAt) ? src.capturedAt : null,
          availability: src.availability || 'available',
          truncated: Boolean(src.truncated),
          originalPostText: src.originalPostText || src.source?.originalPostText || null,
          limitations: src.limitations || null
        };
      } else {
        // Resolve from adapter
        if (ref.snapshotId && adapter && typeof adapter.getPinnedSnapshot === 'function') {
          const fetchedSnap = await adapter.getPinnedSnapshot({ ownerId: effectiveOwner, ref, analysisSpec: spec, dataPolicy: policy });
          if (fetchedSnap) {
            if (fetchedSnap.ownerId && String(fetchedSnap.ownerId) !== effectiveOwner) {
              throw new AccountMismatchError(`快照数据所属账号 ${fetchedSnap.ownerId} 与当前账号 ${effectiveOwner} 不符`);
            }
            const expectedHash = ref.textHash || null;
            if (fetchedSnap.snapshotId !== ref.snapshotId ||
                (expectedHash && computeTextHash(fetchedSnap.text || '') !== expectedHash)) {
              throw new Error(`固定样本版本不一致: ${postId}`);
            }
            snapshot = fetchedSnap;
          }
        }
        // If lost/missing in pinned mode: refuse substitution!
        if (!snapshot || snapshot.availability === 'missing' || snapshot.availability === 'deleted') {
          missingSources.push(postId);
          snapshot = snapshot || {
            postId,
            availability: 'missing',
            text: '',
            metrics: null,
            capturedAt: null
          };
        }
      }
    } else {
      // Latest policy: read from adapter
      if (adapter && typeof adapter.getSnapshot === 'function') {
        const fetchedSnap = await adapter.getSnapshot({ ownerId: effectiveOwner, ref, analysisSpec: spec, dataPolicy: policy });
        if (fetchedSnap) {
          if (fetchedSnap.ownerId && String(fetchedSnap.ownerId) !== effectiveOwner) {
            throw new AccountMismatchError(`快照数据所属账号 ${fetchedSnap.ownerId} 与当前账号 ${effectiveOwner} 不符`);
          }
          snapshot = fetchedSnap;
        }
      }
      if (!snapshot && ref.text !== undefined) {
        snapshot = ref;
      }
    }

    // Step B: Validate freshness & declared required fields
    let freshness = validateSnapshotFreshness(snapshot, policy.maxStaleMs, currentTime);
    let fieldValidation = validateDeclaredRequiredFields(snapshot, spec);

    // Step C: Bounded targeted fetch when policy permits
    const needsFetch = !snapshot || snapshot.availability === 'missing' || freshness.stale || !fieldValidation.valid;
    const canFetch = policy.allowNetwork && adapter && typeof adapter.targetedFetch === 'function';

    if (needsFetch && canFetch) {
      if (fetchCount < maxFetches) {
        fetchCount++;
        const targetRes = await adapter.targetedFetch({
          ownerId: effectiveOwner,
          ref,
          missingFields: fieldValidation.missing,
          analysisSpec: spec,
          dataPolicy: policy
        });

        const newSnap = targetRes?.snapshot || targetRes?.data || (targetRes?.text !== undefined ? targetRes : null);
        if (newSnap) {
          if (newSnap.ownerId && String(newSnap.ownerId) !== effectiveOwner) {
            throw new AccountMismatchError(`补采数据所属账号 ${newSnap.ownerId} 与当前账号 ${effectiveOwner} 不符`);
          }
          snapshot = newSnap;
          freshness = validateSnapshotFreshness(snapshot, policy.maxStaleMs, currentTime);
          fieldValidation = validateDeclaredRequiredFields(snapshot, spec);
        }
      } else {
        taskLimitations.push(`样本 ${postId} 达到每任务补采上限 (${maxFetches})，停止补采`);
      }
    }

    // Step D: Record missing stats & availability
    if (!snapshot || !snapshot.text || snapshot.availability === 'missing' || snapshot.availability === 'deleted') {
      if (!missingSources.includes(postId)) {
        missingSources.push(postId);
      }
    }

    for (const mf of fieldValidation.missing) {
      if (mf.startsWith('metrics.')) {
        missingMandatoryStats.push(`${postId}:${mf}`);
      }
      taskMissingFields.push(`${postId}:${mf}`);
    }

    // Step E: Normalize and format item
    let text = String(snapshot?.text || '');
    let truncated = Boolean(snapshot?.truncated);
    if (spec.maxTextChars && text.length > spec.maxTextChars) {
      text = text.slice(0, spec.maxTextChars);
      truncated = true;
    }

    const item = {
      postId,
      authorId: String(snapshot?.authorId || ref.authorId || ''),
      handleAtCapture: String(snapshot?.handleAtCapture || ref.handleAtCapture || ''),
      url: String(snapshot?.url || ref.url || (postId ? `https://x.com/i/web/status/${postId}` : '')),
      text,
      textHash: text ? computeTextHash(text) : (ref.textHash || ''),
      metrics: snapshot?.metrics && typeof snapshot.metrics === 'object' ? structuredClone(snapshot.metrics) : null,
      metricStates: fieldValidation.metricStates,
      originalPostText: snapshot?.originalPostText ?? ref.originalPostText ?? null,
      coverage: snapshot?.coverage ?? ref.coverage ?? null,
      statisticsWindow: snapshot?.statisticsWindow ?? ref.statisticsWindow ?? null,
      availability: snapshot?.availability || (text ? 'available' : 'missing'),
      truncated,
      capturedAt: Number.isFinite(snapshot?.capturedAt) ? snapshot.capturedAt : null,
      missingFields: [...fieldValidation.missing],
      limitations: snapshot?.limitations || null
    };

    resolvedItems.push(item);
  }

  // 5. Freeze manifest
  const manifest = freezeInputManifest({
    items: resolvedItems,
    analysisSpec: spec,
    dataPolicy: policy,
    currentTime,
    fetchCount,
    maxFetches,
    missingFields: taskMissingFields,
    limitations: taskLimitations
  });

  // 6. Return status per specification
  if (policy.mode === 'pinned' && missingSources.length > 0) {
    if (policy.onMissing === 'failed') {
      return {
        status: 'failed',
        error: `固定样本丢失或不可用: ${missingSources.join(', ')}，拒绝替换`,
        manifest,
        missingSources
      };
    }
    return {
      status: 'waiting_data',
      reason: `固定样本丢失或不可用: ${missingSources.join(', ')}，拒绝替换`,
      manifest,
      missingSources
    };
  }

  if (missingMandatoryStats.length > 0) {
    const isPartialAllowed = spec.allowPartial === true || policy.onMissing === 'partial';
    if (isPartialAllowed) {
      return {
        status: 'partial',
        reason: `缺少必需统计指标: ${missingMandatoryStats.join(', ')}`,
        manifest,
        missingMandatoryStats
      };
    }
    return {
      status: 'waiting_data',
      reason: `缺少必需统计指标: ${missingMandatoryStats.join(', ')}`,
      manifest,
      missingMandatoryStats
    };
  }

  const staleSources = resolvedItems.filter((item, index) =>
    policy.mode === 'latest' && validateSnapshotFreshness(item, policy.maxStaleMs, currentTime).stale
  );
  if (staleSources.length > 0) {
    return {
      status: spec.allowPartial === true ? 'partial' : 'waiting_data',
      reason: `样本快照过期或缺少采集时间: ${staleSources.map(item => item.postId).join(', ')}`,
      manifest,
      staleSources: staleSources.map(item => item.postId)
    };
  }

  if (missingSources.length > 0) {
    const isPartialAllowed = spec.allowPartial === true || policy.onMissing === 'partial';
    if (isPartialAllowed) {
      return {
        status: 'partial',
        reason: `部分样本不可用: ${missingSources.join(', ')}`,
        manifest,
        missingSources
      };
    }
    return {
      status: 'waiting_data',
      reason: `样本不可用: ${missingSources.join(', ')}`,
      manifest,
      missingSources
    };
  }

  return {
    status: 'ready',
    manifest,
    coverage: manifest.coverage,
    items: manifest.items
  };
}

/**
 * Creates a Knowledge Data Resolver instance configured with adapters.
 */
export function createKnowledgeDataResolver({
  adapters = {},
  getCurrentOwner = null,
  now = () => Date.now(),
  defaultMaxFetches = 3,
  defaultMaxStaleMs = 24 * 3600 * 1000
} = {}) {
  return {
    resolveData(options) {
      return resolveTaskData({
        adapters,
        getCurrentOwner,
        now,
        defaultMaxFetches,
        defaultMaxStaleMs,
        ...options
      });
    },

    /**
     * Resolves job data in a store, transitioning stages and persisting the frozen input manifest.
     */
    async resolveJob({ store, ownerId, jobId, ...overrideOptions } = {}) {
      if (!store) throw new Error('store 必需');
      if (!ownerId) throw new Error('ownerId 必需');
      if (!jobId) throw new Error('jobId 必需');

      const job = await store.getJob(ownerId, jobId);
      if (!job) throw new Error(`未找到任务: ${jobId}`);

      const result = await resolveTaskData({
        adapters,
        getCurrentOwner,
        now,
        defaultMaxFetches,
        defaultMaxStaleMs,
        job,
        ownerId,
        ...overrideOptions
      });

      if (result.manifest) {
        const nextStatus = result.status === 'ready'
          ? 'ready'
          : (result.status === 'partial'
            ? 'ready'
            : (result.status === 'waiting_data' ? 'waiting_data' : job.status));

        const persisted = await store.runTransaction(['jobs'], 'readwrite', (stores, set, fail) => {
          const getReq = stores.jobs.get([String(ownerId), String(jobId)]);
          getReq.onerror = () => fail(getReq.error);
          getReq.onsuccess = () => {
            const current = getReq.result;
            if (!current) {
              fail(new Error(`未找到任务: ${jobId}`));
              return;
            }
            if (current.status !== job.status || current.updatedAt !== job.updatedAt) {
              set(false);
              return;
            }
            const updatedJob = {
              ...current,
              inputManifest: result.manifest,
              status: nextStatus,
              checkpoint: { stage: nextStatus, at: now() },
              updatedAt: now()
            };
            stores.jobs.put(updatedJob);
            set(true);
          };
        });
        if (!persisted) return { ...result, persisted: false, reason: 'job_changed_during_resolution' };
      }

      return { ...result, persisted: true };
    }
  };
}

/**
 * Reference adapter factory for Post Tracking.
 * Adapts post-store to snapshot interface without exposing internal IndexedDB structure.
 */
export function createPostTrackingAdapter({ postStore, fetchPostTarget = null } = {}) {
  if (!postStore) throw new Error('postStore 必需');
  return {
    async getSnapshot({ ownerId, ref }) {
      const postId = ref?.postId || ref?.id;
      if (!postId) return null;
      const post = await postStore.get(ownerId, postId);
      if (!post) return null;
      return {
        ownerId,
        postId: post.postId,
        authorId: post.authorId || ownerId,
        handleAtCapture: post.handle || post.authorHandle || '',
        url: post.url || `https://x.com/i/web/status/${post.postId}`,
        text: post.text,
        metrics: post.metrics ? structuredClone(post.metrics) : null,
        metricStates: post.metricStates ? structuredClone(post.metricStates) : null,
        capturedAt: Number.isFinite(post.capturedAt) ? post.capturedAt : null,
        availability: post.deletion && post.deletion.status !== 'failed' ? 'deleted' : 'available',
        truncated: Boolean(post.truncated),
        originalPostText: post.source?.originalPostText || null
      };
    },
    async targetedFetch(args) {
      if (typeof fetchPostTarget === 'function') {
        return fetchPostTarget(args);
      }
      return null;
    }
  };
}

/**
 * Reference adapter factory for Leaderboard.
 * Adapts leaderboard-store to snapshot interface without exposing internal IndexedDB structure.
 */
export function createLeaderboardAdapter({ leaderboardStore, fetchLeaderboardTarget = null } = {}) {
  return {
    async getSnapshot({ ownerId, ref }) {
      const postId = ref?.postId || ref?.id;
      if (!postId) return null;
      if (ref?.date && leaderboardStore?.getJob) {
        const job = await leaderboardStore.getJob(ownerId, ref.date);
        // job.items are Grok conclusions; job.samples are the posts actually sent to Grok.
        const item = job?.samples?.find?.(i => i.postId === postId);
        if (item) {
          return {
            ownerId,
            postId: item.postId,
            authorId: item.authorId || '',
            handleAtCapture: item.handle || '',
            url: item.url || `https://x.com/i/web/status/${item.postId}`,
            text: item.text,
            metrics: item.metrics ? structuredClone(item.metrics) : null,
            metricStates: item.metricStates ? structuredClone(item.metricStates) : null,
            capturedAt: Number.isFinite(item.capturedAt) ? item.capturedAt : null,
            availability: 'available',
            truncated: Boolean(item.truncated)
          };
        }
      }
      return null;
    },
    async targetedFetch(args) {
      if (typeof fetchLeaderboardTarget === 'function') {
        return fetchLeaderboardTarget(args);
      }
      return null;
    }
  };
}
