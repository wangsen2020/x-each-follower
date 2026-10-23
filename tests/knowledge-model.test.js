import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStatement,
  normalizeScope,
  computeKnowledgeFingerprint,
  computeEvidenceId,
  computeInputHash,
  computeExecutionKey,
  hasMetricDependency,
  createKnowledgeRecord,
  createEvidenceRecord,
  createJobRecord,
  createRequestRecord
} from '../src/features/knowledge/knowledge-model.js';

test('normalizeStatement collapses whitespace and normalizes unicode without dropping numbers, negations, or condition words', () => {
  const statement = '  在分析   数据时，不要\u00A0盲目下结论；当样本只有 20 条时，必须说明局限。  ';
  const normalized = normalizeStatement(statement);
  assert.equal(normalized, '在分析 数据时，不要 盲目下结论；当样本只有 20 条时，必须说明局限。');
  assert.ok(normalized.includes('不要'), '保留否定词');
  assert.ok(normalized.includes('当'), '保留条件词');
  assert.ok(normalized.includes('20'), '保留数字');
});

test('computeKnowledgeFingerprint produces distinct fingerprints for different types, scopes, or statements', () => {
  const fp1 = computeKnowledgeFingerprint('writing_principle', '先给结论再说明依据', { theme: 'tech' });
  const fp1Duplicate = computeKnowledgeFingerprint('writing_principle', '  先给结论再说明依据  ', { theme: 'tech' });
  const fpDiffType = computeKnowledgeFingerprint('pitfall', '先给结论再说明依据', { theme: 'tech' });
  const fpDiffScope = computeKnowledgeFingerprint('writing_principle', '先给结论再说明依据', { theme: 'crypto' });
  const fpDiffStmt = computeKnowledgeFingerprint('writing_principle', '不要先给结论', { theme: 'tech' });

  assert.equal(fp1, fp1Duplicate, '相同内容与范围的指纹完全一致');
  assert.notEqual(fp1, fpDiffType, '不同类型的知识产生不同指纹');
  assert.notEqual(fp1, fpDiffScope, '不同适用范围产生不同指纹');
  assert.notEqual(fp1, fpDiffStmt, '不同表述产生不同指纹');
});

test('createKnowledgeRecord validates required fields and sets safe defaults', () => {
  const record = createKnowledgeRecord({
    ownerId: '12345',
    id: 'k-1',
    type: 'writing_principle',
    statement: '重要观点前置'
  });

  assert.equal(record.ownerId, '12345');
  assert.equal(record.status, 'candidate');
  assert.equal(record.revision, 1);
  assert.ok(record.fingerprint.startsWith('fp_writing_principle_'));

  assert.throws(() => {
    createKnowledgeRecord({ ownerId: '123', id: 'k-2', type: 'invalid_type', statement: 'test' });
  }, /非法的知识类型/);

  assert.throws(() => {
    createKnowledgeRecord({ ownerId: '123', id: 'k-3', type: 'writing_principle', statement: '   ' });
  }, /知识正文不能为空/);
});

test('createEvidenceRecord and computeEvidenceId generate deterministic IDs', () => {
  const ev1 = createEvidenceRecord({
    ownerId: '123',
    platform: 'x',
    postId: '998877',
    authorId: '5544',
    text: '这是一条推文',
    textHash: 'hash1'
  });

  const ev2 = createEvidenceRecord({
    ownerId: '123',
    platform: 'x',
    postId: '998877',
    authorId: '5544',
    text: '这是一条推文',
    textHash: 'hash1'
  });

  assert.equal(ev1.id, ev2.id);
  assert.equal(ev1.id, 'ev_x_5544_998877_hash1');
  assert.equal(ev1.url, 'https://x.com/i/web/status/998877');
});

test('computeExecutionKey and computeInputHash are deterministic and owner-isolated', () => {
  const inputsA = [{ postId: '101', text: 'hello' }, { postId: '102', text: 'world' }];
  const inputsB = [{ postId: '102', text: 'world' }, { postId: '101', text: 'hello' }];

  const hashA = computeInputHash(inputsA);
  const hashB = computeInputHash(inputsB);
  assert.equal(hashA, hashB, '不同顺序的同一组输入产生相同的输入哈希');

  const execKeyOwner1 = computeExecutionKey({ ownerId: 'user_1', analysisSpec: { kind: 'review', version: 1 }, inputHash: hashA });
  const execKeyOwner2 = computeExecutionKey({ ownerId: 'user_2', analysisSpec: { kind: 'review', version: 1 }, inputHash: hashA });
  assert.notEqual(execKeyOwner1, execKeyOwner2, '不同账号产生不同的 executionKey');
});

test('evidence IDs distinguish metrics and capture snapshots', () => {
  const baseOptions = {
    ownerId: 'owner_snap',
    platform: 'x',
    postId: 'post_8899',
    authorId: 'auth_77',
    text: '相同的推文文本',
    textHash: 'hash_same'
  };

  const evNoMetrics = createEvidenceRecord(baseOptions);

  const evDay1 = createEvidenceRecord({
    ...baseOptions,
    metrics: { impressions: 1000, likes: 50 },
    capturedAt: 100000
  });

  const evDay2 = createEvidenceRecord({
    ...baseOptions,
    metrics: { impressions: 85000, likes: 3200 },
    capturedAt: 200000
  });

  const evDay1DifferentMetrics = createEvidenceRecord({
    ...baseOptions,
    metrics: { impressions: 1200, likes: 60 },
    capturedAt: 100000
  });

  // Must all be distinct
  assert.notEqual(evNoMetrics.id, evDay1.id, '无指标与有指标快照的 ID 必须区分');
  assert.notEqual(evDay1.id, evDay2.id, '不同采集时间与指标的快照 ID 必须区分');
  assert.notEqual(evDay1.id, evDay1DifferentMetrics.id, '相同采集时间但不同指标的快照 ID 必须区分');

  // Same options produce deterministic identical ID
  const evDay1Duplicate = createEvidenceRecord({
    ...baseOptions,
    metrics: { impressions: 1000, likes: 50 },
    capturedAt: 100000
  });
  assert.equal(evDay1.id, evDay1Duplicate.id, '相同指标与快照时间生成确定性的同一 ID');
});

test('computeInputHash does not trust unverified caller textHash against raw text', () => {
  const itemWithRaw = { postId: 'p-1', text: '真实推文文本' };
  const itemWithForgedHash = { postId: 'p-1', text: '真实推文文本', textHash: 'fake_forged_hash_12345' };

  const hashRaw = computeInputHash([itemWithRaw]);
  const hashForged = computeInputHash([itemWithForgedHash]);

  // Both should derive from raw text, disregarding forged caller textHash
  assert.equal(hashRaw, hashForged, '提供了真实文本时，不信任调用方传入的伪造 textHash');

  // If two items have different raw text, caller passing the same textHash must not produce the same inputHash
  const itemA = { postId: 'p-1', text: '文本 A', textHash: 'identical_text_hash' };
  const itemB = { postId: 'p-1', text: '文本 B', textHash: 'identical_text_hash' };
  assert.notEqual(computeInputHash([itemA]), computeInputHash([itemB]), '不同文本即使传入相同 textHash 也绝不产生相同 inputHash');
});

test('computeInputHash respects sample set semantics by default and order semantics when specified', () => {
  const p1 = { postId: 'p-1', text: '第一条' };
  const p2 = { postId: 'p-2', text: '第二条' };

  // Default: set semantics (order invariant)
  assert.equal(computeInputHash([p1, p2]), computeInputHash([p2, p1]), '默认集合语义下顺序不同产生相同哈希');

  // Explicit preserveOrder / orderSensitive: preserves sample order
  const hashOrder1 = computeInputHash([p1, p2], { preserveOrder: true });
  const hashOrder2 = computeInputHash([p2, p1], { preserveOrder: true });
  assert.notEqual(hashOrder1, hashOrder2, '指定保序时不同样本顺序产生不同哈希');

  const hashOrderSensitive1 = computeInputHash([p1, p2], { orderSensitive: true });
  const hashOrderSensitive2 = computeInputHash([p2, p1], { orderSensitive: true });
  assert.notEqual(hashOrderSensitive1, hashOrderSensitive2, 'orderSensitive 选项同样严格保序');
});

test('computeInputHash includes metric values only when analysisSpec declares metric dependency', () => {
  const sampleLowMetrics = { postId: 'p-1', text: '推文', metrics: { impressions: 100, likes: 2 } };
  const sampleHighMetrics = { postId: 'p-1', text: '推文', metrics: { impressions: 99999, likes: 5000 } };

  // Case 1: analysisSpec does NOT declare metric dependency -> compatible reuse (identical hash)
  const hashNoDep1 = computeInputHash([sampleLowMetrics], { kind: 'general_review', version: 1 });
  const hashNoDep2 = computeInputHash([sampleHighMetrics], { kind: 'general_review', version: 1 });
  assert.equal(hashNoDep1, hashNoDep2, '未声明指标依赖时，指标变化不影响 inputHash，允许兼容复用');

  // Case 2: analysisSpec declares metric dependency -> metrics-dependent invalidation
  assert.equal(hasMetricDependency({ dependsOnMetrics: true }), true);
  assert.equal(hasMetricDependency({ dependencyFields: ['metrics', 'language'] }), true);

  const hashWithDep1 = computeInputHash([sampleLowMetrics], { kind: 'general_review', dependsOnMetrics: true });
  const hashWithDep2 = computeInputHash([sampleHighMetrics], { kind: 'general_review', dependsOnMetrics: true });
  assert.notEqual(hashWithDep1, hashWithDep2, '声明指标依赖后，指标变化导致 inputHash 发生变化（失效）');

  // Identical metrics with metric dependency produce identical hash
  const hashWithDep1Dup = computeInputHash([sampleLowMetrics], { kind: 'general_review', dependsOnMetrics: true });
  assert.equal(hashWithDep1, hashWithDep1Dup, '相同指标与依赖声明时保持确定性哈希');
});

test('computeExecutionKey distinguishes prompt, parser, language, window, outputs, and dependencies, while keeping producer out', () => {
  const baseSpec = {
    kind: 'deep_post_analysis',
    version: 1,
    promptVersion: '1.0.0',
    parserVersion: '1.0.0',
    language: 'zh-CN',
    window: '7d',
    dependencyFields: ['theme']
  };
  const inHash = 'input_hash_xyz';

  const baseKey = computeExecutionKey({
    ownerId: 'user_exec_test',
    analysisSpec: baseSpec,
    inputHash: inHash,
    requestedOutputs: ['knowledge_candidate']
  });

  // 1. Output mismatch
  const diffOutputKey = computeExecutionKey({
    ownerId: 'user_exec_test',
    analysisSpec: baseSpec,
    inputHash: inHash,
    requestedOutputs: ['knowledge_candidate', 'post_critique']
  });
  assert.notEqual(baseKey, diffOutputKey, 'requestedOutputs 不一致必须生成不同的 executionKey');

  // 2. Prompt version mismatch
  const diffPromptKey = computeExecutionKey({
    ownerId: 'user_exec_test',
    analysisSpec: { ...baseSpec, promptVersion: '2.0.0' },
    inputHash: inHash,
    requestedOutputs: ['knowledge_candidate']
  });
  assert.notEqual(baseKey, diffPromptKey, 'promptVersion 不一致必须生成不同的 executionKey');

  // 3. Parser version mismatch
  const diffParserKey = computeExecutionKey({
    ownerId: 'user_exec_test',
    analysisSpec: { ...baseSpec, parserVersion: '2.0.0' },
    inputHash: inHash,
    requestedOutputs: ['knowledge_candidate']
  });
  assert.notEqual(baseKey, diffParserKey, 'parserVersion 不一致必须生成不同的 executionKey');

  // 4. Language mismatch
  const diffLangKey = computeExecutionKey({
    ownerId: 'user_exec_test',
    analysisSpec: { ...baseSpec, language: 'en-US' },
    inputHash: inHash,
    requestedOutputs: ['knowledge_candidate']
  });
  assert.notEqual(baseKey, diffLangKey, 'language 不一致必须生成不同的 executionKey');

  // 5. Window mismatch
  const diffWinKey = computeExecutionKey({
    ownerId: 'user_exec_test',
    analysisSpec: { ...baseSpec, window: '30d' },
    inputHash: inHash,
    requestedOutputs: ['knowledge_candidate']
  });
  assert.notEqual(baseKey, diffWinKey, 'window 不一致必须生成不同的 executionKey');

  // 6. Declared dependency fields mismatch
  const diffDepsKey = computeExecutionKey({
    ownerId: 'user_exec_test',
    analysisSpec: { ...baseSpec, dependencyFields: ['theme', 'authorRank'] },
    inputHash: inHash,
    requestedOutputs: ['knowledge_candidate']
  });
  assert.notEqual(baseKey, diffDepsKey, 'declared dependencyFields 不一致必须生成不同的 executionKey');

  // 7. Compatible reuse across different producers: producer is kept OUT of key
  const keyProducerA = computeExecutionKey({
    ownerId: 'user_exec_test',
    producer: 'producer_alpha',
    analysisSpec: baseSpec,
    inputHash: inHash,
    requestedOutputs: ['knowledge_candidate']
  });
  const keyProducerB = computeExecutionKey({
    ownerId: 'user_exec_test',
    producer: 'producer_beta',
    analysisSpec: baseSpec,
    inputHash: inHash,
    requestedOutputs: ['knowledge_candidate']
  });
  assert.equal(keyProducerA, baseKey);
  assert.equal(keyProducerA, keyProducerB, '不同 producer 在语义兼容时生成相同 executionKey 允许共享');
});
