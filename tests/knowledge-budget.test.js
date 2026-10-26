import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createKnowledgeStore } from '../src/features/knowledge/knowledge-store.js';
import {
  createKnowledgeBudget,
  getAsiaShanghaiDay,
  DEFAULT_BUDGET_CONFIG
} from '../src/features/knowledge/knowledge-budget.js';

test('budget requires a user configured hard limit and restores cooldown after manager restart', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let fakeTime = new Date('2026-10-22T23:55:00+08:00').getTime();
  const budget = createKnowledgeBudget({ store, now: () => fakeTime, IDBKeyRange });
  const denied = await budget.reserveBudget({ grokAccountKey: 'grok-shared', attemptId: 'a', inputChars: 10 });
  assert.equal(denied.reason, 'hard_limit_unconfigured');
  budget.updateConfig({ hardDailyCalls: 2 });
  await budget.recordCooldown({ grokAccountKey: 'grok-shared', cooldownMs: 20 * 60_000 });
  const restarted = createKnowledgeBudget({
    store, now: () => fakeTime, IDBKeyRange, config: { hardDailyCalls: 2 }
  });
  fakeTime += 10 * 60_000;
  const cooling = await restarted.reserveBudget({ grokAccountKey: 'grok-shared', attemptId: 'a', inputChars: 10 });
  assert.equal(cooling.reason, 'in_cooldown');
  fakeTime += 11 * 60_000;
  const granted = await restarted.reserveBudget({ grokAccountKey: 'grok-shared', attemptId: 'a', inputChars: 10 });
  assert.equal(granted.granted, true);
  await store.close();
});

test('an unresolved submitted attempt keeps shared concurrency occupied after its lease expires', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let fakeTime = 1000;
  const budget = createKnowledgeBudget({
    store, now: () => fakeTime, IDBKeyRange,
    config: { hardDailyCalls: 5, activeLeaseMs: 1000 }
  });
  await budget.reserveBudget({ grokAccountKey: 'same-grok', attemptId: 'first', inputChars: 10 });
  await budget.recordSubmission({ grokAccountKey: 'same-grok', attemptId: 'first' });
  fakeTime += 20_000;
  const second = await budget.reserveBudget({ grokAccountKey: 'same-grok', attemptId: 'second', inputChars: 10 });
  assert.equal(second.reason, 'concurrency_limit_exceeded');
  await store.close();
});

test('the same attempt cannot be reserved twice across midnight and can be reconciled without a caller day', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let fakeTime = new Date('2026-10-22T23:59:00+08:00').getTime();
  const budget = createKnowledgeBudget({
    store, now: () => fakeTime, IDBKeyRange,
    config: { hardDailyCalls: 2 }
  });
  const first = await budget.reserveBudget({ grokAccountKey: 'grok', attemptId: 'same', inputChars: 10 });
  assert.equal(first.granted, true);
  const conflicting = await budget.reserveBudget({ grokAccountKey: 'grok', attemptId: 'same', inputChars: 11 });
  assert.equal(conflicting.reason, 'attempt_payload_conflict');
  fakeTime += 2 * 60_000;
  const replay = await budget.reserveBudget({ grokAccountKey: 'grok', attemptId: 'same', inputChars: 10 });
  assert.equal(replay.reused, true);
  await budget.recordSubmission({ grokAccountKey: 'grok', attemptId: 'same' });
  await budget.recordResult({ grokAccountKey: 'grok', attemptId: 'same', outcome: 'success' });
  const day1 = await budget.getDailyUsage({ grokAccountKey: 'grok', day: '2026-10-22' });
  const day2 = await budget.getDailyUsage({ grokAccountKey: 'grok', day: '2026-10-23' });
  assert.equal(day1.totalCalls, 1);
  assert.equal(day2.totalCalls, 0);
  await store.close();
});

test('Asia/Shanghai day calculation formats correctly and respects UTC+8 boundary', () => {
  // 2026-10-22 15:59:00 UTC -> 2026-10-22 23:59:00 in Asia/Shanghai
  const beforeMidnight = new Date('2026-10-22T15:59:00Z').getTime();
  assert.equal(getAsiaShanghaiDay(beforeMidnight), '2026-10-22');

  // 2026-10-22 16:01:00 UTC -> 2026-10-23 00:01:00 in Asia/Shanghai
  const afterMidnight = new Date('2026-10-22T16:01:00Z').getTime();
  assert.equal(getAsiaShanghaiDay(afterMidnight), '2026-10-23');
});

test('concurrency and reservation: shared concurrency default 1 and resume cannot double reserve', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let fakeTime = new Date('2026-10-23T10:00:00+08:00').getTime();
  const budget = createKnowledgeBudget({
    store,
    now: () => fakeTime,
    IDBKeyRange,
    config: {
      concurrencyLimit: 1,
      hardDailyCalls: 10
    }
  });

  const grokAccountKey = 'grok-acc-1';
  const channel = 'default';

  // 1. First reservation succeeds
  const res1 = await budget.reserveBudget({
    grokAccountKey,
    channel,
    attemptId: 'att-1',
    inputChars: 1200
  });
  assert.equal(res1.granted, true);
  assert.equal(res1.reserved, true);
  assert.equal(res1.entry.outcome, 'reserved');

  // 2. Second reservation with different attemptId is blocked by concurrency limit (1)
  const res2 = await budget.reserveBudget({
    grokAccountKey,
    channel,
    attemptId: 'att-2',
    inputChars: 800
  });
  assert.equal(res2.granted, false);
  assert.equal(res2.reason, 'concurrency_limit_exceeded');
  assert.equal(res2.currentInFlight, 1);

  // 3. Resuming the existing attemptId does not double reserve or trigger concurrency block
  const res1Resume = await budget.reserveBudget({
    grokAccountKey,
    channel,
    attemptId: 'att-1',
    inputChars: 1200
  });
  assert.equal(res1Resume.granted, true);
  assert.equal(res1Resume.reused, true);
  assert.equal(res1Resume.resumed, true);

  // Check ledger count: only 1 entry exists
  const usage = await budget.getDailyUsage({ grokAccountKey, channel });
  assert.equal(usage.totalCalls, 1);
  assert.equal(usage.activeInFlight, 1);

  // 4. Settling first attempt frees concurrency slot
  await budget.recordSubmission({ grokAccountKey, channel, attemptId: 'att-1' });
  await budget.recordResult({ grokAccountKey, channel, attemptId: 'att-1', outcome: 'success' });

  // 5. Now att-2 can be reserved
  const res2Retry = await budget.reserveBudget({
    grokAccountKey,
    channel,
    attemptId: 'att-2',
    inputChars: 800
  });
  assert.equal(res2Retry.granted, true);
  assert.equal(res2Retry.reserved, true);

  await store.close();
});

test('cross-owner shared Grok account: multiple X owners share quota and concurrency', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let fakeTime = new Date('2026-10-23T12:00:00+08:00').getTime();
  const budget = createKnowledgeBudget({
    store,
    now: () => fakeTime,
    IDBKeyRange,
    config: {
      concurrencyLimit: 1,
      hardDailyCalls: 2,
      hardDailyChars: 5000
    }
  });

  const sharedGrok = 'shared-pro-account';

  // Owner 1 reserves
  const owner1Res = await budget.reserveBudget({
    grokAccountKey: sharedGrok,
    ownerId: 'x-owner-1',
    attemptId: 'att-owner1-1',
    inputChars: 2000
  });
  assert.equal(owner1Res.granted, true);

  // Owner 2 tries while Owner 1 is in-flight -> blocked by shared concurrency
  const owner2Blocked = await budget.reserveBudget({
    grokAccountKey: sharedGrok,
    ownerId: 'x-owner-2',
    attemptId: 'att-owner2-1',
    inputChars: 1500
  });
  assert.equal(owner2Blocked.granted, false);
  assert.equal(owner2Blocked.reason, 'concurrency_limit_exceeded');

  // Owner 1 completes execution
  await budget.recordResult({
    grokAccountKey: sharedGrok,
    attemptId: 'att-owner1-1',
    outcome: 'success'
  });

  // Owner 2 tries again -> now granted (shared call count becomes 2)
  const owner2Granted = await budget.reserveBudget({
    grokAccountKey: sharedGrok,
    ownerId: 'x-owner-2',
    attemptId: 'att-owner2-1',
    inputChars: 1500
  });
  assert.equal(owner2Granted.granted, true);
  await budget.recordResult({
    grokAccountKey: sharedGrok,
    attemptId: 'att-owner2-1',
    outcome: 'success'
  });

  // Now both Owner 1 and Owner 2 are capped because shared limit of 2 is reached!
  const owner1Over = await budget.reserveBudget({
    grokAccountKey: sharedGrok,
    ownerId: 'x-owner-1',
    attemptId: 'att-owner1-2',
    inputChars: 500
  });
  assert.equal(owner1Over.granted, false);
  assert.equal(owner1Over.reason, 'hard_daily_calls_exceeded');

  // However, an independent Grok account has its own budget
  const independent = await budget.reserveBudget({
    grokAccountKey: 'independent-grok',
    ownerId: 'x-owner-1',
    attemptId: 'att-indep-1',
    inputChars: 1000
  });
  assert.equal(independent.granted, true);

  await store.close();
});

test('day rollover: daily counts reset on Asia/Shanghai midnight boundary', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  // Start on 2026-10-22 23:00 Asia/Shanghai
  let fakeTime = new Date('2026-10-22T23:00:00+08:00').getTime();
  const budget = createKnowledgeBudget({
    store,
    now: () => fakeTime,
    IDBKeyRange,
    config: {
      concurrencyLimit: 2,
      hardDailyCalls: 2
    }
  });

  const grokAccountKey = 'rollover-grok';

  // Day 1: consume 2 calls
  const day1Call1 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'day1-call1'
  });
  assert.equal(day1Call1.granted, true);
  await budget.recordResult({ grokAccountKey, attemptId: 'day1-call1', outcome: 'success' });

  const day1Call2 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'day1-call2'
  });
  assert.equal(day1Call2.granted, true);
  await budget.recordResult({ grokAccountKey, attemptId: 'day1-call2', outcome: 'success' });

  // 3rd call on Day 1 is rejected
  const day1Call3 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'day1-call3'
  });
  assert.equal(day1Call3.granted, false);
  assert.equal(day1Call3.reason, 'hard_daily_calls_exceeded');

  // Advance time past Asia/Shanghai midnight to 2026-10-23 00:05
  fakeTime = new Date('2026-10-23T00:05:00+08:00').getTime();

  // Day 2 call is granted!
  const day2Call1 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'day2-call1'
  });
  assert.equal(day2Call1.granted, true);

  // Check usage stats for each day
  const usageDay1 = await budget.getDailyUsage({ grokAccountKey, day: '2026-10-22' });
  const usageDay2 = await budget.getDailyUsage({ grokAccountKey, day: '2026-10-23' });
  assert.equal(usageDay1.totalCalls, 2);
  assert.equal(usageDay2.totalCalls, 1);

  await store.close();
});

test('auto-off default: automatic tasks disabled when unconfigured, allowed when configured', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let fakeTime = new Date('2026-10-23T14:00:00+08:00').getTime();

  // Default configuration: autoDailyCalls is null
  const budget = createKnowledgeBudget({
    store,
    now: () => fakeTime,
    IDBKeyRange,
    config: {
      hardDailyCalls: 10
      // autoDailyCalls defaults to null
    }
  });

  const grokAccountKey = 'auto-test-grok';

  // Manual task proceeds normally
  const manual1 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'manual-1',
    isAuto: false
  });
  assert.equal(manual1.granted, true);
  await budget.recordResult({ grokAccountKey, attemptId: 'manual-1', outcome: 'success' });

  // Automatic task is disabled because auto limit is unconfigured
  const auto1 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'auto-1',
    isAuto: true
  });
  assert.equal(auto1.granted, false);
  assert.equal(auto1.reason, 'auto_limit_unconfigured');

  // Now configure autoDailyCalls: 2
  budget.updateConfig({ autoDailyCalls: 2 });

  // First auto call succeeds
  const autoConfigured1 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'auto-conf-1',
    isAuto: true
  });
  assert.equal(autoConfigured1.granted, true);
  await budget.recordResult({ grokAccountKey, attemptId: 'auto-conf-1', outcome: 'success' });

  // Second auto call succeeds
  const autoConfigured2 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'auto-conf-2',
    isAuto: true
  });
  assert.equal(autoConfigured2.granted, true);
  await budget.recordResult({ grokAccountKey, attemptId: 'auto-conf-2', outcome: 'success' });

  // Third auto call exceeds auto quota
  const autoConfigured3 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'auto-conf-3',
    isAuto: true
  });
  assert.equal(autoConfigured3.granted, false);
  assert.equal(autoConfigured3.reason, 'auto_daily_calls_exceeded');

  // Manual calls can still proceed as long as hardDailyCalls is not exceeded
  const manual2 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'manual-2',
    isAuto: false
  });
  assert.equal(manual2.granted, true);

  await store.close();
});

test('retry, uncertain, and release: release ONLY when definitely not submitted; uncertain counts as attempted', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  let fakeTime = new Date('2026-10-23T15:00:00+08:00').getTime();
  const budget = createKnowledgeBudget({
    store,
    now: () => fakeTime,
    IDBKeyRange,
    config: {
      concurrencyLimit: 2,
      hardDailyCalls: 2,
      hardDailyChars: 5000
    }
  });

  const grokAccountKey = 'retry-grok';

  // 1. Reserve and release before submission
  const resCancel = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'att-cancel',
    inputChars: 2000
  });
  assert.equal(resCancel.granted, true);

  const releaseRes = await budget.releaseReservation({
    grokAccountKey,
    attemptId: 'att-cancel',
    reason: 'validation_failed'
  });
  assert.equal(releaseRes.released, true);
  assert.equal(releaseRes.entry.outcome, 'released');

  // Released entry does NOT consume daily calls or chars
  const usageAfterRelease = await budget.getDailyUsage({ grokAccountKey });
  assert.equal(usageAfterRelease.totalCalls, 0);
  assert.equal(usageAfterRelease.totalChars, 0);

  // 2. An attempt that was submitted CANNOT be released
  const resSub = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'att-sub',
    inputChars: 1500
  });
  assert.equal(resSub.granted, true);
  await budget.recordSubmission({ grokAccountKey, attemptId: 'att-sub' });

  await assert.rejects(
    budget.releaseReservation({ grokAccountKey, attemptId: 'att-sub' }),
    /只有确定未向远端提交的任务才可释放预留/
  );

  // 3. Mark att-sub as uncertain (e.g. timeout / network interruption)
  await budget.recordResult({
    grokAccountKey,
    attemptId: 'att-sub',
    outcome: 'uncertain',
    error: 'timeout after request sent'
  });

  // Attempting to release an uncertain entry must also be rejected
  await assert.rejects(
    budget.releaseReservation({ grokAccountKey, attemptId: 'att-sub' }),
    /只有确定未向远端提交的任务才可释放预留/
  );

  // Uncertain definitely counts as attempted
  const usageAfterUncertain = await budget.getDailyUsage({ grokAccountKey });
  assert.equal(usageAfterUncertain.totalCalls, 1);
  assert.equal(usageAfterUncertain.totalChars, 1500);

  // 4. Retry with a new attemptId
  const resRetry = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'att-retry-1',
    inputChars: 1500
  });
  assert.equal(resRetry.granted, true);
  await budget.recordResult({
    grokAccountKey,
    attemptId: 'att-retry-1',
    outcome: 'success'
  });

  // Total daily calls is now 2 (1 uncertain + 1 retry)
  const usageFinal = await budget.getDailyUsage({ grokAccountKey });
  assert.equal(usageFinal.totalCalls, 2);
  assert.equal(usageFinal.totalChars, 3000);

  // Further attempts exceed hardDailyCalls
  const resExceeded = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'att-over',
    inputChars: 500
  });
  assert.equal(resExceeded.granted, false);
  assert.equal(resExceeded.reason, 'hard_daily_calls_exceeded');

  await store.close();
});

test('input chars limits and cooldown: per-call, daily limit, and cooldown surviving day boundary', async () => {
  const store = createKnowledgeStore({ indexedDB: new IDBFactory() });
  // Start on 2026-10-22 23:50:00 Asia/Shanghai
  let fakeTime = new Date('2026-10-22T23:50:00+08:00').getTime();
  const budget = createKnowledgeBudget({
    store,
    now: () => fakeTime,
    IDBKeyRange,
    config: {
      concurrencyLimit: 2,
      hardDailyCalls: 10,
      hardDailyChars: 10000,
      maxInputCharsPerCall: 4000
    }
  });

  const grokAccountKey = 'chars-cooldown-grok';

  // 1. Single call limit exceeded
  const singleExceeded = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'single-huge',
    inputChars: 4500
  });
  assert.equal(singleExceeded.granted, false);
  assert.equal(singleExceeded.reason, 'call_input_chars_exceeded');

  // 2. Daily chars accumulation
  const call1 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'call-1',
    inputChars: 4000
  });
  assert.equal(call1.granted, true);
  await budget.recordResult({ grokAccountKey, attemptId: 'call-1', outcome: 'success' });

  const call2 = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'call-2',
    inputChars: 4000
  });
  assert.equal(call2.granted, true);
  await budget.recordResult({ grokAccountKey, attemptId: 'call-2', outcome: 'success' });

  // 3rd call with 3000 chars would exceed 10000 total (4000 + 4000 + 3000 = 11000 > 10000)
  const call3Over = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'call-3',
    inputChars: 3000
  });
  assert.equal(call3Over.granted, false);
  assert.equal(call3Over.reason, 'hard_daily_chars_exceeded');

  // 3. Cooldown set before midnight (at 23:55) with 20 min duration -> expires at 00:15 next day
  fakeTime = new Date('2026-10-22T23:55:00+08:00').getTime();
  await budget.recordCooldown({
    grokAccountKey,
    cooldownMs: 20 * 60 * 1000,
    reason: 'rate_limited_429'
  });

  const cd1 = budget.getCooldown({ grokAccountKey });
  assert.equal(cd1.inCooldown, true);

  // Advance time to 2026-10-23 00:05 (next day, crossing midnight!)
  fakeTime = new Date('2026-10-23T00:05:00+08:00').getTime();

  // Day rolled over, so daily chars count is 0 on 2026-10-23.
  // HOWEVER, cooldown survives day boundary!
  const cdRolloverAttempt = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'day2-attempt-during-cd',
    inputChars: 1000
  });
  assert.equal(cdRolloverAttempt.granted, false);
  assert.equal(cdRolloverAttempt.reason, 'in_cooldown');
  assert.ok(cdRolloverAttempt.waitMs > 0);

  // Advance time to 2026-10-23 00:16 (after cooldown expires)
  fakeTime = new Date('2026-10-23T00:16:00+08:00').getTime();

  const cdExpiredAttempt = await budget.reserveBudget({
    grokAccountKey,
    attemptId: 'day2-attempt-after-cd',
    inputChars: 1000
  });
  assert.equal(cdExpiredAttempt.granted, true);

  await store.close();
});
