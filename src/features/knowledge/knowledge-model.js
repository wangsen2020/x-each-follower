export const KNOWLEDGE_DB_NAME = 'xef-knowledge-v1';
export const KNOWLEDGE_DB_VERSION = 1;

export const KNOWLEDGE_TYPES = Object.freeze([
  'writing_principle',
  'pitfall',
  'conditional_observation'
]);

export const KNOWLEDGE_STATUSES = Object.freeze([
  'candidate',
  'active',
  'disabled',
  'archived',
  'merged'
]);

export const JOB_STATUSES = Object.freeze([
  'queued',
  'resolving_data',
  'ready',
  'submitted',
  'result_saved',
  'completed',
  'waiting_data',
  'waiting_budget',
  'retry_wait',
  'uncertain',
  'failed',
  'cancelled'
]);

export const REQUEST_STATUSES = Object.freeze([
  'pending',
  'delivered',
  'failed',
  'cancelled'
]);

export const EVIDENCE_RELATIONS = Object.freeze([
  'support',
  'counterexample',
  'scope_limitation'
]);

export const EVIDENCE_AVAILABILITIES = Object.freeze([
  'available',
  'deleted',
  'inaccessible',
  'legacy_reference',
  'missing'
]);

/**
 * Deterministic fast 64-bit hash (FNV-1a / Murmur inspired) returning a 16-character hex string.
 * Synchronous and safe for both Node.js and browser environments.
 */
export function fastHash(str) {
  const s = String(str ?? '');
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c64e6d ^ 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0');
}

/**
 * Conservative normalization for knowledge statements.
 * Preserves numbers, negation words ('不', '未', 'not', etc.), and condition words ('如果', '当', etc.).
 * Normalizes Unicode to NFC, collapses multiple whitespace characters, and trims edges.
 */
export function normalizeStatement(statement) {
  if (typeof statement !== 'string') return '';
  return statement
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes scope descriptor object into a deterministic canonical string key.
 */
export function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') {
    return '{}';
  }
  const clean = {};
  const keys = Object.keys(scope).sort();
  for (const k of keys) {
    const val = scope[k];
    if (val !== undefined && val !== null) {
      if (typeof val === 'string') {
        clean[k] = val.normalize('NFC').replace(/\s+/g, ' ').trim();
      } else if (Array.isArray(val)) {
        clean[k] = val.map(v => typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : v).sort();
      } else {
        clean[k] = val;
      }
    }
  }
  return JSON.stringify(clean);
}

/**
 * Computes exact fingerprint for knowledge deduplication.
 * Different types or differing scopes produce different fingerprints.
 */
export function computeKnowledgeFingerprint(type, statement, scope = {}) {
  const normType = String(type || '').trim();
  const normStmt = normalizeStatement(statement);
  const normScope = normalizeScope(scope);
  return `fp_${normType}_${fastHash(`${normType}::${normStmt}::${normScope}`)}`;
}

/**
 * Deterministic text hash.
 */
export function computeTextHash(text) {
  return fastHash(typeof text === 'string' ? text.normalize('NFC') : '');
}

/**
 * Deterministic metrics hash for snapshot metrics.
 */
export function computeMetricsHash(metrics) {
  if (!metrics || typeof metrics !== 'object') return '';
  const keys = Object.keys(metrics).sort();
  const sorted = {};
  for (const k of keys) {
    if (metrics[k] !== undefined && metrics[k] !== null) {
      sorted[k] = metrics[k];
    }
  }
  const str = JSON.stringify(sorted);
  return str === '{}' ? '' : fastHash(str);
}

/**
 * Deterministic evidence ID for immutable evidence snapshots.
 * Distinguishes metrics and capture snapshots so that different snapshots
 * produce distinct IDs and never overwrite existing immutable evidence.
 */
export function computeEvidenceId({
  platform = 'x',
  authorId,
  postId,
  textHash,
  metrics = null,
  capturedAt = null,
  snapshotId = null
}) {
  if (!postId) throw new Error('postId 必需');
  const safeAuthor = authorId ? String(authorId).trim() : 'unknown';
  const safePost = String(postId).trim();
  const safeHash = textHash ? String(textHash).trim() : 'empty';

  let id = `ev_${platform}_${safeAuthor}_${safePost}_${safeHash}`;

  const mHash = computeMetricsHash(metrics);
  if (mHash) {
    id += `_m_${mHash}`;
  }

  if (snapshotId) {
    id += `_s_${String(snapshotId).trim()}`;
  } else if (capturedAt !== null && capturedAt !== undefined) {
    id += `_c_${capturedAt}`;
  }

  return id;
}

/**
 * Checks whether an analysisSpec explicitly declares dependency on sample metrics.
 */
export function hasMetricDependency(analysisSpec) {
  if (!analysisSpec || typeof analysisSpec !== 'object') return false;
  if (
    analysisSpec.dependsOnMetrics === true ||
    analysisSpec.metricDependency === true ||
    analysisSpec.metricsDependency === true ||
    analysisSpec.includeMetrics === true ||
    analysisSpec.metrics === true
  ) {
    return true;
  }
  const deps = analysisSpec.dependencyFields || analysisSpec.dependencies || analysisSpec.metricDependencies;
  if (Array.isArray(deps)) {
    return deps.some(d => d === 'metrics' || (typeof d === 'string' && d.startsWith('metric')));
  }
  return false;
}

/**
 * Deterministic input hash for job input sets.
 * - Computes text hash directly from raw text; never trusts unverified caller textHash over raw text.
 * - Includes metrics in hash only when analysisSpec declares metric dependency.
 * - Preserves sample set semantics by default (sorted), or sample order semantics when preserveOrder/orderSensitive is specified.
 * - Includes declared dependency fields from analysisSpec.
 */
export function computeInputHash(inputs, specOrOptions = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) return fastHash('empty');

  const metricDep = hasMetricDependency(specOrOptions);
  const preserveOrder = Boolean(
    specOrOptions?.preserveOrder ||
    specOrOptions?.orderSensitive ||
    specOrOptions?.ordered ||
    specOrOptions?.sampleOrder === 'preserved'
  );

  const rawDeps = specOrOptions?.dependencyFields || specOrOptions?.dependencies || [];
  const declaredDeps = Array.isArray(rawDeps)
    ? rawDeps.filter(d => typeof d === 'string' && d !== 'metrics')
    : [];

  const formatItem = (item) => {
    const postId = String(item?.postId ?? '').trim();
    let textHash = '';
    if (typeof item?.text === 'string') {
      textHash = computeTextHash(item.text);
    } else if (item?.textHash) {
      textHash = String(item.textHash).trim();
    } else {
      textHash = computeTextHash('');
    }

    let mPart = '';
    if (metricDep && item?.metrics) {
      const mh = computeMetricsHash(item.metrics);
      if (mh) mPart = `:m_${mh}`;
    }

    let depPart = '';
    if (declaredDeps.length > 0) {
      const depValues = declaredDeps.map(dep => {
        const val = item?.[dep];
        return val !== undefined && val !== null ? `${dep}:${JSON.stringify(val)}` : '';
      }).filter(Boolean).join(',');
      if (depValues) depPart = `:deps_${depValues}`;
    }

    return `${postId}:${textHash}${mPart}${depPart}`;
  };

  const formattedItems = inputs.map(formatItem);
  const items = preserveOrder ? formattedItems : [...formattedItems].sort((a, b) => a.localeCompare(b));
  return fastHash(items.join('|'));
}

/**
 * Execution key for job deduplication.
 * Includes ownerId, analysis kind, spec version, promptVersion, parserVersion,
 * language, window, declared dependency fields, output capabilities / requested outputs, and inputHash.
 * Producer is intentionally kept out of the executionKey when semantically compatible.
 */
export function computeExecutionKey({
  ownerId,
  analysisSpec = {},
  inputHash = 'empty',
  requestedOutputs = null
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  const safeOwner = String(ownerId);
  const kind = String(analysisSpec?.kind || 'generic');
  const version = String(analysisSpec?.version ?? 1);
  const promptVersion = String(analysisSpec?.promptVersion ?? analysisSpec?.prompt_version ?? '1');
  const parserVersion = String(analysisSpec?.parserVersion ?? analysisSpec?.parser_version ?? '1');
  const language = String(analysisSpec?.language ?? 'default');
  const windowVal = String(analysisSpec?.window ?? 'none');

  // Declared dependency fields
  const rawDeps = analysisSpec?.dependencyFields || analysisSpec?.dependencies || [];
  const deps = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
  const sortedDeps = Array.from(new Set(deps.map(String))).sort().join(',');

  // Output capabilities / requested outputs
  const rawOutputs = requestedOutputs || analysisSpec?.capabilities || analysisSpec?.outputCapabilities || analysisSpec?.requestedOutputs || ['knowledge_candidate'];
  const outputs = Array.isArray(rawOutputs) ? rawOutputs : [rawOutputs];
  const sortedOutputs = Array.from(new Set(outputs.map(String))).sort().join(',');

  const inHash = String(inputHash || 'empty');

  const specFingerprint = fastHash(
    `${promptVersion}::${parserVersion}::${language}::${windowVal}::${sortedDeps}::${sortedOutputs}`
  );

  return `exec_${safeOwner}_${kind}_v${version}_${specFingerprint}_${inHash}`;
}

/**
 * Factory and validator for Knowledge records.
 */
export function createKnowledgeRecord({
  ownerId,
  id,
  type,
  statement,
  originalText = null,
  scope = {},
  status = 'candidate',
  canonicalId = null,
  revision = 1,
  fingerprint,
  createdAt = Date.now(),
  updatedAt = createdAt
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  if (!id) throw new Error('id 必需');
  if (!KNOWLEDGE_TYPES.includes(type)) {
    throw new Error(`非法的知识类型: ${type}`);
  }
  if (!KNOWLEDGE_STATUSES.includes(status)) {
    throw new Error(`非法的知识状态: ${status}`);
  }
  const cleanStmt = normalizeStatement(statement);
  if (!cleanStmt) throw new Error('知识正文不能为空');

  const fp = fingerprint || computeKnowledgeFingerprint(type, cleanStmt, scope);
  return {
    ownerId: String(ownerId),
    id: String(id),
    type,
    statement: cleanStmt,
    originalText: originalText ? String(originalText) : null,
    scope: typeof scope === 'object' && scope !== null ? structuredClone(scope) : {},
    status,
    canonicalId: canonicalId ? String(canonicalId) : null,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 1,
    fingerprint: fp,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
  };
}

/**
 * Factory and validator for Evidence records.
 */
export function createEvidenceRecord({
  ownerId,
  id,
  platform = 'x',
  postId,
  authorId = '',
  handleAtCapture = '',
  url = '',
  text = '',
  textHash,
  capturedAt,
  metrics = null,
  metricStates = null,
  truncated = false,
  availability = 'available',
  legacyIncomplete = false,
  snapshotId = null
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  if (!postId) throw new Error('postId 必需');
  const computedHash = textHash || computeTextHash(text);
  const evId = id || computeEvidenceId({
    platform,
    authorId,
    postId,
    textHash: computedHash,
    metrics,
    capturedAt: capturedAt ?? null,
    snapshotId
  });

  if (!EVIDENCE_AVAILABILITIES.includes(availability)) {
    throw new Error(`非法的证据可用性状态: ${availability}`);
  }

  return {
    ownerId: String(ownerId),
    id: String(evId),
    platform,
    postId: String(postId),
    authorId: String(authorId || ''),
    handleAtCapture: String(handleAtCapture || ''),
    url: String(url || (postId ? `https://x.com/i/web/status/${postId}` : '')),
    text: String(text || ''),
    textHash: computedHash,
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : Date.now(),
    metrics: metrics && typeof metrics === 'object' ? structuredClone(metrics) : null,
    metricStates: metricStates && typeof metricStates === 'object' ? structuredClone(metricStates) : null,
    truncated: Boolean(truncated),
    availability,
    legacyIncomplete: Boolean(legacyIncomplete)
  };
}

/**
 * Factory and validator for Analysis records.
 */
export function createAnalysisRecord({
  ownerId,
  id,
  producer,
  sourceJobId = '',
  reportDate = null,
  inputEvidenceIds = [],
  inputHash = '',
  promptVersion = '1',
  parserVersion = '1',
  channel = 'x_grok',
  model = 'unknown',
  coverage = 'full',
  status = 'completed',
  createdAt = Date.now()
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  if (!id) throw new Error('id 必需');
  if (!producer) throw new Error('producer 必需');

  return {
    ownerId: String(ownerId),
    id: String(id),
    producer: String(producer),
    sourceJobId: String(sourceJobId || ''),
    reportDate: reportDate ? String(reportDate) : null,
    inputEvidenceIds: Array.isArray(inputEvidenceIds) ? [...inputEvidenceIds] : [],
    inputHash: String(inputHash || ''),
    promptVersion: String(promptVersion),
    parserVersion: String(parserVersion),
    channel: String(channel),
    model: String(model || 'unknown'),
    coverage: coverage === 'partial' ? 'partial' : 'full',
    status: status === 'failed' ? 'failed' : (status === 'partial' ? 'partial' : 'completed'),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now()
  };
}

/**
 * Factory for KnowledgeEvidence link records.
 */
export function createKnowledgeEvidenceLink({
  ownerId,
  knowledgeId,
  evidenceId,
  analysisId,
  relation = 'support',
  reason = '',
  limitations = '',
  createdAt = Date.now()
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  if (!knowledgeId) throw new Error('knowledgeId 必需');
  if (!evidenceId) throw new Error('evidenceId 必需');
  if (!analysisId) throw new Error('analysisId 必需');
  if (!EVIDENCE_RELATIONS.includes(relation)) {
    throw new Error(`非法的证据关系类型: ${relation}`);
  }

  return {
    ownerId: String(ownerId),
    knowledgeId: String(knowledgeId),
    evidenceId: String(evidenceId),
    analysisId: String(analysisId),
    relation,
    reason: String(reason || ''),
    limitations: String(limitations || ''),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now()
  };
}

/**
 * Factory for Revision records.
 */
export function createRevisionRecord({
  ownerId,
  knowledgeId,
  revision = 1,
  statement,
  originalText = null,
  scope = {},
  status = 'candidate',
  reason = '',
  operator = 'system',
  parentRefs = [],
  createdAt = Date.now()
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  if (!knowledgeId) throw new Error('knowledgeId 必需');
  const cleanStmt = normalizeStatement(statement);
  if (!cleanStmt) throw new Error('修订正文不能为空');

  return {
    ownerId: String(ownerId),
    knowledgeId: String(knowledgeId),
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 1,
    statement: cleanStmt,
    originalText: originalText ? String(originalText) : null,
    scope: typeof scope === 'object' && scope !== null ? structuredClone(scope) : {},
    status,
    reason: String(reason || ''),
    operator: String(operator || 'system'),
    parentRefs: Array.isArray(parentRefs) ? [...parentRefs] : [],
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now()
  };
}

/**
 * Factory for Job records.
 */
export function createJobRecord({
  ownerId,
  id,
  kind = 'generic',
  executionKey,
  attempt = 1,
  attemptKey = null,
  previousJobId = null,
  supersededByJobId = null,
  savedResult = null,
  businessResults = null,
  analysisSpec = {},
  outputCapabilities = null,
  inputManifest = {},
  lease = null,
  checkpoint = null,
  inputRevisions = [],
  status = 'queued',
  error = null,
  createdAt = Date.now(),
  updatedAt = createdAt
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  if (!id) throw new Error('id 必需');
  if (!JOB_STATUSES.includes(status)) {
    throw new Error(`非法的任务状态: ${status}`);
  }

  const rawCaps = outputCapabilities || analysisSpec?.capabilities || analysisSpec?.outputCapabilities || ['knowledge_candidate'];
  const caps = Array.isArray(rawCaps) ? Array.from(new Set(rawCaps.map(String))).sort() : [String(rawCaps)];

  return {
    ownerId: String(ownerId),
    id: String(id),
    kind: String(kind),
    executionKey: String(executionKey || `exec_${ownerId}_${id}`),
    attempt: Number.isInteger(attempt) && attempt >= 1 ? attempt : 1,
    attemptKey: attemptKey ? String(attemptKey) : null,
    previousJobId: previousJobId ? String(previousJobId) : null,
    supersededByJobId: supersededByJobId ? String(supersededByJobId) : null,
    savedResult: savedResult !== undefined && savedResult !== null ? structuredClone(savedResult) : null,
    businessResults: businessResults !== undefined && businessResults !== null ? structuredClone(businessResults) : null,
    analysisSpec: structuredClone(analysisSpec || {}),
    outputCapabilities: caps,
    inputManifest: structuredClone(inputManifest || {}),
    lease: Number.isFinite(lease) ? lease : null,
    checkpoint: checkpoint && typeof checkpoint === 'object' ? structuredClone(checkpoint) : { stage: status, at: createdAt },
    inputRevisions: Array.isArray(inputRevisions) ? structuredClone(inputRevisions) : [],
    status,
    error: error ? String(error) : null,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
  };
}

/**
 * Factory for Request records.
 */
export function createRequestRecord({
  ownerId,
  id,
  producer,
  clientRequestId,
  jobId,
  requestedOutputs = ['knowledge_candidate'],
  deliveryStatus = 'pending',
  businessResults = null,
  inputHash = null,
  executionKey = null,
  cancelledAt = null,
  deliveredAt = null,
  ackAt = null,
  ackToken = null,
  createdAt = Date.now(),
  updatedAt = createdAt
}) {
  if (!ownerId) throw new Error('ownerId 必需');
  if (!id) throw new Error('id 必需');
  if (!producer) throw new Error('producer 必需');
  if (!clientRequestId) throw new Error('clientRequestId 必需');
  if (!jobId) throw new Error('jobId 必需');
  if (!REQUEST_STATUSES.includes(deliveryStatus)) {
    throw new Error(`非法的请求交付状态: ${deliveryStatus}`);
  }

  return {
    ownerId: String(ownerId),
    id: String(id),
    producer: String(producer),
    clientRequestId: String(clientRequestId),
    jobId: String(jobId),
    requestedOutputs: Array.isArray(requestedOutputs) ? [...requestedOutputs] : ['knowledge_candidate'],
    deliveryStatus,
    businessResults: businessResults !== undefined ? structuredClone(businessResults) : null,
    inputHash: inputHash ? String(inputHash) : null,
    executionKey: executionKey ? String(executionKey) : null,
    cancelledAt: Number.isFinite(cancelledAt) ? cancelledAt : null,
    deliveredAt: Number.isFinite(deliveredAt) ? deliveredAt : null,
    ackAt: Number.isFinite(ackAt) ? ackAt : null,
    ackToken: ackToken ? String(ackToken) : null,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
  };
}
