// Unified follow queue scheduler (ARGON OWNERSHIP).
// Coordinates global single-worker execution, lease fencing/renewal, budget enforcement,
// pre-action exponential retries, and safe holding on uncertain post-effect outcomes.

import {FOLLOW_QUEUE_DEFAULT_SETTINGS} from './follow-queue-store.js';

const DEFAULT_LEASE_MS = 60_000;
const RETRY_BASE_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];
const MAX_TRANSIENT_RETRIES = 3;
const VALID_SETTLE_STATES = new Set(['pending', 'running', 'followed', 'skipped', 'retry', 'uncertain', 'excluded']);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function requireAccountId(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error('missing account; follow queue scheduler fails closed');
  }
  return accountId.trim();
}

function hasEnabledSource(job) {
  return Array.isArray(job?.sources) && job.sources.some(src => src && src.enabled === true);
}

function hasImportedHold(job) {
  return Boolean(job?.importedHold && typeof job.importedHold === 'object' && job.importedHold.state);
}

function hasEvaluationExternalEffect(evaluations) {
  if (!Array.isArray(evaluations)) return false;
  return evaluations.some(ev =>
    ev &&
    typeof ev === 'object' &&
    (ev.status === 'publishing' ||
      ev.status === 'published' ||
      ev.status === 'posted' ||
      ev.status === 'uncertain' ||
      Boolean(ev.publishedPostId) ||
      Boolean(ev.publishedPostUrl))
  );
}

function makeOwnerId(now) {
  if (globalThis.crypto?.randomUUID) return `fq_sched_${crypto.randomUUID()}`;
  return `fq_sched_${now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function emptyCounters() {
  return {
    inspected: 0,
    followed: 0,
    alreadyFollowing: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    uncertain: 0,
    excluded: 0,
    quoteEvaluated: 0,
    quoteDrafted: 0,
    quotePublished: 0,
    quoteFailed: 0,
    quoteUncertain: 0
  };
}

function formatSummary(counters, {reason = '', paused = false, enabled = true, manual = false} = {}) {
  if (paused && counters.inspected === 0) {
    return '队列已暂停，未启动新任务。';
  }
  if (!enabled && !manual && counters.inspected === 0) {
    return '自动调度未开启，跳过本轮执行。';
  }
  if (reason === 'busy' && counters.inspected === 0) {
    return '调度器正在执行其他轮次，跳过重复触发。';
  }
  if (reason === 'account-blocked' && counters.inspected === 0) {
    return '当前账号未通过运行校验或处于限流暂停状态。';
  }
  if (counters.inspected === 0) {
    return '本轮无可执行的候选任务。';
  }
  const parts = [
    `本轮检查 ${counters.inspected} 人`,
    `新增关注 ${counters.followed}`,
    `原已关注 ${counters.alreadyFollowing}`,
    `策略跳过 ${counters.skipped}`
  ];
  if (counters.retried > 0) parts.push(`等待重试 ${counters.retried}`);
  if (counters.uncertain > 0) parts.push(`待核实 ${counters.uncertain}`);
  if (counters.excluded > 0) parts.push(`已排除 ${counters.excluded}`);
  if (counters.failed > 0) parts.push(`失败 ${counters.failed}`);
  const quoteParts = [];
  if (counters.quotePublished > 0) quoteParts.push(`发布 ${counters.quotePublished}`);
  if (counters.quoteDrafted > 0) quoteParts.push(`草稿 ${counters.quoteDrafted}`);
  if (counters.quoteFailed > 0) quoteParts.push(`失败 ${counters.quoteFailed}`);
  if (counters.quoteUncertain > 0) quoteParts.push(`待确认 ${counters.quoteUncertain}`);
  let text = `${parts[0]}：${parts.slice(1).join('、')}。`;
  if (quoteParts.length > 0) {
    text += `引用评价：${quoteParts.join('、')}。`;
  }
  if (paused) {
    text += '（已暂停后续任务）';
  }
  return text;
}

export function createFollowQueueScheduler({
  store,
  execute,
  canRun = async () => true,
  now = () => Date.now(),
  owner,
  leaseMs,
  heartbeatMs,
  onEvent
} = {}) {
  if (!store || typeof store !== 'object') {
    throw new Error('follow queue store is required');
  }
  if (typeof execute !== 'function') {
    throw new Error('execute callback is required');
  }

  const workerOwner = typeof owner === 'string' && owner.trim() ? owner.trim() : makeOwnerId(now);
  const explicitLeaseMs = Number.isFinite(leaseMs) && leaseMs > 0 ? Math.round(leaseMs) : null;
  const pausedAccounts = new Set();

  let activeRun = null;
  let lastRunAt = 0;
  let lastCompletedAt = 0;
  let lastSummary = '尚未执行调度。';
  let lastCounters = emptyCounters();
  let lastAccountId = '';
  let runSeq = 0;

  async function emit(event) {
    if (typeof onEvent !== 'function') return;
    try {
      await onEvent({
        at: now(),
        owner: workerOwner,
        ...event
      });
    } catch {
      // onEvent is async safe log and never determines success
    }
  }

  function isPaused(accountId) {
    if (accountId && pausedAccounts.has(accountId)) return true;
    if (!accountId && lastAccountId && pausedAccounts.has(lastAccountId)) return true;
    return false;
  }

  async function readLiveJob(accountId, jobId) {
    const jobs = await store.list({accountId});
    return jobs.find(item => item.id === jobId) || null;
  }

  function buildStatus() {
    return {
      ok: true,
      owner: workerOwner,
      running: Boolean(activeRun),
      isPaused: activeRun ? isPaused(activeRun.accountId) : isPaused(lastAccountId),
      pausedAccounts: [...pausedAccounts],
      activeAccountId: activeRun?.accountId || '',
      activeJobId: activeRun?.jobId || '',
      activeStage: activeRun?.stage || '',
      runId: activeRun?.runId || '',
      lastRunAt: lastRunAt || null,
      lastCompletedAt: lastCompletedAt || null,
      summary: lastSummary,
      counters: clone(lastCounters)
    };
  }

  async function pause(accountId) {
    const targetAccount = accountId ? requireAccountId(accountId) : requireAccountId(activeRun?.accountId || lastAccountId);
    // Mark in-memory pause and abort any active job controller immediately so in-flight work stops right away,
    // and propagate any storage persistence error instead of swallowing it and reporting fake success.
    pausedAccounts.add(targetAccount);
    if (activeRun && activeRun.accountId === targetAccount) {
      activeRun.paused = true;
      if (activeRun.abortController && !activeRun.abortController.signal.aborted) {
        activeRun.abortController.abort(new Error('follow queue paused'));
      }
    }
    const saved = await store.saveSettings(targetAccount, {enabled: false});
    if (saved && saved.enabled !== false) {
      throw new Error('failed to persist paused state');
    }
    await emit({
      type: 'pause',
      accountId: targetAccount,
      runId: activeRun?.runId || ''
    });
    return {
      ...buildStatus(),
      isPaused: true
    };
  }

  async function run({accountId, manual = false} = {}) {
    const account = requireAccountId(accountId);
    lastAccountId = account;

    if (activeRun) {
      const counters = emptyCounters();
      const summary = formatSummary(counters, {reason: 'busy', manual});
      await emit({type: 'run-skipped', reason: 'busy', accountId: account, manual});
      return {
        ok: false,
        reason: 'busy',
        summary,
        counters,
        status: buildStatus()
      };
    }

    const runId = `run_${now()}_${++runSeq}`;
    const startedAt = now();
    lastRunAt = startedAt;

    const counters = emptyCounters();
    const state = {
      runId,
      accountId: account,
      manual: Boolean(manual),
      startedAt,
      paused: false,
      jobId: '',
      stage: 'starting',
      abortController: null
    };
    activeRun = state;

    try {
      const settings = {
        ...FOLLOW_QUEUE_DEFAULT_SETTINGS,
        ...(await store.getSettings(account))
      };

      // Clear any prior in-memory paused state if either:
      // 1. User explicitly re-enabled settings.enabled in the UI, or
      // 2. User explicitly triggered a manual run (resumes one-shot execution without enabling recurring scheduler).
      if ((settings.enabled === true || manual) && pausedAccounts.has(account)) {
        pausedAccounts.delete(account);
      }
      state.paused = pausedAccounts.has(account);

      if (state.paused) {
        const summary = formatSummary(counters, {paused: true, manual});
        lastSummary = summary;
        lastCounters = clone(counters);
        await emit({type: 'run-paused', runId, accountId: account, manual, summary});
        return {ok: false, reason: 'paused', paused: true, summary, counters: clone(counters), status: buildStatus()};
      }

      if (!manual && !settings.enabled) {
        const summary = formatSummary(counters, {enabled: false, manual: false});
        lastSummary = summary;
        lastCounters = clone(counters);
        await emit({type: 'run-disabled', runId, accountId: account, manual, summary});
        return {ok: true, skipped: true, reason: 'disabled', summary, counters: clone(counters), status: buildStatus()};
      }

      let allowed = false;
      try {
        allowed = (await canRun(account)) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        const summary = formatSummary(counters, {reason: 'account-blocked', manual});
        lastSummary = summary;
        lastCounters = clone(counters);
        await emit({type: 'run-blocked', runId, accountId: account, manual, summary});
        return {ok: false, reason: 'account-blocked', summary, counters: clone(counters), status: buildStatus()};
      }

      const batchLimit = Math.max(1, Number(settings.batchLimit) || FOLLOW_QUEUE_DEFAULT_SETTINGS.batchLimit);
      const inspectLimit = Math.max(1, Number(settings.inspectLimit) || FOLLOW_QUEUE_DEFAULT_SETTINGS.inspectLimit);
      const timeBudgetMs = Math.max(1, (Number(settings.timeBudgetMinutes) || FOLLOW_QUEUE_DEFAULT_SETTINGS.timeBudgetMinutes) * 60_000);
      const cycleDeadline = startedAt + timeBudgetMs;

      await emit({
        type: 'run-start',
        runId,
        accountId: account,
        manual,
        batchLimit,
        inspectLimit,
        deadline: cycleDeadline
      });

      while (
        !state.paused &&
        !pausedAccounts.has(account) &&
        counters.followed < batchLimit &&
        counters.inspected < inspectLimit &&
        now() < cycleDeadline
      ) {
        const liveSettings = await store.getSettings(account);
        if (liveSettings?.enabled === true && pausedAccounts.has(account)) {
          pausedAccounts.delete(account);
        }
        if (state.paused || pausedAccounts.has(account)) {
          break;
        }
        if (!manual && !liveSettings?.enabled) {
          break;
        }
        let accountOk = false;
        try {
          accountOk = (await canRun(account)) === true;
        } catch {
          accountOk = false;
        }
        if (!accountOk) {
          break;
        }

        const remainingCycleMs = cycleDeadline - now();
        if (remainingCycleMs <= 0) break;

        // Use short default 60s lease (or custom leaseMs) renewed via serialized heartbeats and checkpoints.
        const claimLeaseMs = explicitLeaseMs ?? DEFAULT_LEASE_MS;

        const claimed = await store.claim({
          accountId: account,
          owner: workerOwner,
          leaseMs: claimLeaseMs
        });
        if (!claimed) {
          break;
        }

        counters.inspected += 1;
        state.jobId = claimed.id;
        state.stage = claimed.stage || 'claimed';

        await processClaimedJob({
          claimed,
          account,
          manual,
          settings: {...settings, ...liveSettings},
          cycleDeadline,
          claimLeaseMs,
          counters,
          runState: state
        });

        state.jobId = '';
        state.stage = '';
      }

      const paused = state.paused || pausedAccounts.has(account);
      const summary = formatSummary(counters, {paused, enabled: settings.enabled || manual, manual});
      lastCompletedAt = now();
      lastSummary = summary;
      lastCounters = clone(counters);

      await emit({
        type: 'run-complete',
        runId,
        accountId: account,
        manual,
        paused,
        counters: clone(counters),
        summary
      });

      return {
        ok: true,
        runId,
        accountId: account,
        manual,
        paused,
        summary,
        counters: clone(counters),
        status: buildStatus()
      };
    } finally {
      activeRun = null;
    }
  }

  async function processClaimedJob({
    claimed,
    account,
    manual,
    settings,
    cycleDeadline,
    claimLeaseMs,
    counters,
    runState
  }) {
    let currentJob = clone(claimed);
    let leaseVersion = currentJob.lease?.version || 1;
    let leaseExpiresAt = currentJob.lease?.expiresAt || (now() + claimLeaseMs);
    let leaseBroken = false;
    let jobFinished = false;
    let hasExternalEffect = Boolean(
      currentJob.followResult?.succeeded ||
      currentJob.followResult?.attemptedAt ||
      currentJob.stage === 'following' ||
      currentJob.stage === 'followed' ||
      currentJob.stage === 'evaluating' ||
      currentJob.stage === 'evaluated' ||
      currentJob.stage === 'publishing' ||
      hasEvaluationExternalEffect(currentJob.evaluations)
    );
    let followSucceeded = Boolean(currentJob.followResult?.succeeded);
    let latestFollowResult = currentJob.followResult ? clone(currentJob.followResult) : null;
    let latestEvaluations = Array.isArray(currentJob.evaluations) ? clone(currentJob.evaluations) : [];
    let lastClockSeen = now();

    // Serialize all lease operations (heartbeat renew, canAct renew, checkpoint settle, final settle)
    // so concurrent heartbeat ticks and checkpoints never race on leaseVersion.
    let leaseLock = Promise.resolve();
    function withLeaseLock(fn) {
      const next = leaseLock.then(fn, fn);
      leaseLock = next.catch(() => {});
      return next;
    }

    function currentRenewalDuration() {
      return explicitLeaseMs ?? DEFAULT_LEASE_MS;
    }

    // When custom clock advances abruptly in one step (e.g. simulated >60s Grok call in tests or event loop stall)
    // while the cycle budget is still valid and no explicit short leaseMs was forced for expiry testing,
    // catch up virtual heartbeat renewals before store operations check leaseExpiresAt.
    async function catchUpHeartbeatsUnlocked(currentTime) {
      if (leaseBroken || explicitLeaseMs != null) return;
      if (typeof store.renew !== 'function') return;
      if (currentTime >= cycleDeadline) return;
      if (currentTime > leaseExpiresAt && lastClockSeen < leaseExpiresAt) {
        const renewed = await store.renew({
          id: currentJob.id,
          owner: workerOwner,
          version: leaseVersion,
          leaseMs: Math.max(currentRenewalDuration(), (currentTime - leaseExpiresAt) + currentRenewalDuration())
        });
        if (renewed && renewed.ok && renewed.job && renewed.job.state === 'running' && !hasImportedHold(renewed.job)) {
          currentJob = clone(renewed.job);
          leaseVersion = renewed.job.lease.version;
          leaseExpiresAt = renewed.job.lease.expiresAt;
        }
      }
      lastClockSeen = currentTime;
    }

    async function performRenewUnlocked() {
      if (leaseBroken) return false;
      const currentTime = now();
      await catchUpHeartbeatsUnlocked(currentTime);
      if (!(leaseExpiresAt > currentTime)) {
        leaseBroken = true;
        return false;
      }
      if (typeof store.renew !== 'function') {
        return true;
      }
      const renewed = await store.renew({
        id: currentJob.id,
        owner: workerOwner,
        version: leaseVersion,
        leaseMs: currentRenewalDuration()
      });
      if (!renewed || !renewed.ok || !renewed.job || renewed.job.state !== 'running' || hasImportedHold(renewed.job)) {
        leaseBroken = true;
        return false;
      }
      currentJob = clone(renewed.job);
      leaseVersion = renewed.job.lease.version;
      leaseExpiresAt = renewed.job.lease.expiresAt;
      lastClockSeen = currentTime;
      return true;
    }

    const jobDeadline = cycleDeadline;
    const abortController = new AbortController();
    runState.abortController = abortController;

    const remainingMs = Math.max(1, jobDeadline - now());
    let timeoutHandle = null;
    const timeoutPromise = new Promise(resolve => {
      timeoutHandle = setTimeout(() => {
        abortController.abort(new Error('follow queue job deadline exceeded'));
        resolve({__timedOut: true});
      }, remainingMs);
    });

    // Periodic heartbeat keeps short 60s lease fresh across long operations (e.g., 120s Grok generation)
    const heartbeatIntervalMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0
      ? Math.round(heartbeatMs)
      : Math.max(50, Math.min(20_000, Math.floor(claimLeaseMs / 2)));
    let heartbeatTimer = null;
    if (typeof store.renew === 'function' && heartbeatIntervalMs > 0 && remainingMs > heartbeatIntervalMs) {
      heartbeatTimer = setInterval(() => {
        if (jobFinished || leaseBroken || abortController.signal.aborted || runState.paused || pausedAccounts.has(account)) {
          return;
        }
        withLeaseLock(async () => {
          if (jobFinished || leaseBroken || abortController.signal.aborted || runState.paused || pausedAccounts.has(account)) {
            return;
          }
          await performRenewUnlocked();
        }).catch(() => {});
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }

    async function canAct() {
      return withLeaseLock(async () => {
        try {
          if (jobFinished || leaseBroken || abortController.signal.aborted) return false;
          if (runState.paused || pausedAccounts.has(account)) return false;
          const currentTime = now();
          if (currentTime >= jobDeadline || currentTime >= cycleDeadline) return false;

          if (!manual) {
            const liveSettings = await store.getSettings(account);
            if (!liveSettings?.enabled) return false;
          }

          const accountVerified = (await canRun(account)) === true;
          if (!accountVerified) return false;

          await catchUpHeartbeatsUnlocked(currentTime);

          const liveJob = await readLiveJob(account, currentJob.id);
          if (!liveJob || liveJob.state !== 'running' || hasImportedHold(liveJob)) {
            leaseBroken = true;
            return false;
          }
          if (liveJob.lease?.owner !== workerOwner || liveJob.lease?.version !== leaseVersion) {
            leaseBroken = true;
            return false;
          }
          if (!(liveJob.lease?.expiresAt > currentTime)) {
            leaseBroken = true;
            return false;
          }
          if (!hasEnabledSource(liveJob)) return false;

          currentJob = liveJob;
          leaseExpiresAt = liveJob.lease.expiresAt;

          const renewedOk = await performRenewUnlocked();
          if (!renewedOk || !hasEnabledSource(currentJob) || hasImportedHold(currentJob)) {
            return false;
          }

          return true;
        } catch {
          return false;
        }
      });
    }

    async function checkpoint(patch = {}) {
      return withLeaseLock(async () => {
        const currentTime = now();
        if (
          jobFinished ||
          leaseBroken ||
          abortController.signal.aborted ||
          runState.paused ||
          pausedAccounts.has(account) ||
          currentTime >= jobDeadline
        ) {
          throw new Error('checkpoint rejected: deadline exceeded or aborted');
        }
        await catchUpHeartbeatsUnlocked(currentTime);
        if (!(leaseExpiresAt > currentTime)) {
          leaseBroken = true;
          throw new Error('checkpoint rejected: lease expired');
        }

        // Renew right before settling checkpoint if within half lease window
        if (typeof store.renew === 'function' && (leaseExpiresAt - currentTime <= Math.floor(claimLeaseMs / 2))) {
          const renewedOk = await performRenewUnlocked();
          if (!renewedOk) {
            throw new Error('checkpoint rejected: lease renew failed');
          }
        }

        if (
          patch.stage === 'following' ||
          patch.stage === 'followed' ||
          patch.stage === 'evaluating' ||
          patch.stage === 'evaluated' ||
          patch.stage === 'publishing' ||
          patch.followResult?.attemptedAt ||
          patch.followResult?.succeeded ||
          hasEvaluationExternalEffect(patch.evaluations)
        ) {
          hasExternalEffect = true;
        }
        if (patch.followResult && typeof patch.followResult === 'object') {
          latestFollowResult = {...(latestFollowResult || {}), ...clone(patch.followResult)};
          if (latestFollowResult.succeeded === true) {
            followSucceeded = true;
          }
        }
        if (Array.isArray(patch.evaluations)) {
          latestEvaluations = clone(patch.evaluations);
        }
        if (typeof patch.stage === 'string') {
          runState.stage = patch.stage;
        }

        const settled = await store.settle({
          id: currentJob.id,
          owner: workerOwner,
          version: leaseVersion,
          state: 'running',
          patch: {
            ...patch,
            ...(latestFollowResult ? {followResult: latestFollowResult} : {}),
            ...(latestEvaluations.length ? {evaluations: latestEvaluations} : {})
          }
        });
        if (!settled || !settled.ok || !settled.job || settled.job.state !== 'running' || hasImportedHold(settled.job)) {
          leaseBroken = true;
          throw new Error(`checkpoint failed: ${settled?.reason || 'stale'}`);
        }
        currentJob = clone(settled.job);
        leaseVersion = settled.job.lease?.version || leaseVersion;
        leaseExpiresAt = settled.job.lease?.expiresAt || leaseExpiresAt;
        lastClockSeen = currentTime;
        return clone(settled.job);
      });
    }

    await emit({
      type: 'job-start',
      runId: runState.runId,
      accountId: account,
      jobId: currentJob.id,
      handle: currentJob.handle,
      targetUserId: currentJob.targetUserId
    });

    let outcome;
    try {
      const execPromise = Promise.resolve().then(() =>
        execute(clone(currentJob), clone(settings), {
          checkpoint,
          canAct,
          deadline: jobDeadline,
          signal: abortController.signal
        })
      );
      outcome = await Promise.race([execPromise, timeoutPromise]);
    } catch (error) {
      outcome = {
        __threw: true,
        error,
        reason: String(error?.message || error || 'execution error')
      };
    } finally {
      jobFinished = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      abortController.abort();
      runState.abortController = null;
    }

    await withLeaseLock(async () => {
      if (outcome && outcome.followResult && typeof outcome.followResult === 'object') {
        latestFollowResult = {...(latestFollowResult || {}), ...clone(outcome.followResult)};
        if (latestFollowResult.succeeded === true) {
          followSucceeded = true;
          hasExternalEffect = true;
        }
        if (latestFollowResult.attemptedAt) {
          hasExternalEffect = true;
        }
      }
      if (outcome && Array.isArray(outcome.evaluations)) {
        latestEvaluations = clone(outcome.evaluations);
        if (hasEvaluationExternalEffect(latestEvaluations)) {
          hasExternalEffect = true;
        }
      }
      if (
        outcome &&
        typeof outcome.stage === 'string' &&
        (outcome.stage === 'following' ||
          outcome.stage === 'followed' ||
          outcome.stage === 'evaluating' ||
          outcome.stage === 'evaluated' ||
          outcome.stage === 'publishing')
      ) {
        hasExternalEffect = true;
      }

      await finalizeJobOutcome({
        currentJob,
        leaseVersion,
        account,
        outcome,
        followSucceeded,
        hasExternalEffect,
        latestFollowResult,
        latestEvaluations,
        counters,
        runState
      });
    });
  }

  async function finalizeJobOutcome({
    currentJob,
    leaseVersion,
    account,
    outcome,
    followSucceeded,
    hasExternalEffect,
    latestFollowResult,
    latestEvaluations,
    counters,
    runState
  }) {
    let finalState = outcome && typeof outcome.state === 'string' ? outcome.state : '';
    let finalStage = finalState || 'verify';
    let nextEligibleAt;
    const reason = typeof outcome?.reason === 'string' ? outcome.reason : '';

    // Rule: successful follow result persists even if evaluation fails or throws
    if (followSucceeded) {
      finalState = 'followed';
      finalStage = 'followed';
    } else if (!outcome || outcome.__timedOut || outcome.__threw || !VALID_SETTLE_STATES.has(finalState) || finalState === 'running' || finalState === 'pending') {
      // Pre-action interruption without attemptedAt or publishing settles as retry (not uncertain);
      // after external effect it settles as uncertain (or followed above).
      if (hasExternalEffect) {
        finalState = 'uncertain';
        finalStage = 'verify';
      } else {
        finalState = 'retry';
        finalStage = 'retry';
      }
    }

    // Rule: after external effect, never retry follow (avoid duplicate follow)
    if (finalState === 'retry' && hasExternalEffect) {
      finalState = followSucceeded ? 'followed' : 'uncertain';
      finalStage = finalState === 'followed' ? 'followed' : 'verify';
    }

    // Handle pre-action transient retry max 3 with exponential backoff using persisted retry counts
    if (finalState === 'retry') {
      const prevRetries = Math.max(
        0,
        Number(currentJob.followResult?.retryCount ?? currentJob.followResult?.attempts ?? 0) || 0
      );
      const nextRetryCount = prevRetries + 1;
      if (nextRetryCount > MAX_TRANSIENT_RETRIES) {
        finalState = 'uncertain';
        finalStage = 'verify';
        latestFollowResult = {
          ...(latestFollowResult || {}),
          retryCount: prevRetries,
          attempts: prevRetries,
          exhaustedRetries: true,
          ...(reason ? {reason} : {})
        };
      } else {
        const delayMs = RETRY_BASE_DELAYS_MS[Math.min(nextRetryCount - 1, RETRY_BASE_DELAYS_MS.length - 1)];
        nextEligibleAt = now() + delayMs;
        finalStage = 'retry';
        latestFollowResult = {
          ...(latestFollowResult || {}),
          retryCount: nextRetryCount,
          attempts: nextRetryCount,
          ...(reason ? {reason} : {})
        };
      }
    }

    if (finalState === 'uncertain') {
      finalStage = 'verify';
      latestFollowResult = {
        ...(latestFollowResult || {}),
        ...(reason ? {reason} : {})
      };
    } else if (finalState === 'skipped' || finalState === 'excluded') {
      finalStage = finalState;
      latestFollowResult = {
        ...(latestFollowResult || {}),
        ...(reason ? {reason} : {})
      };
    } else if (finalState === 'followed') {
      finalStage = 'followed';
      latestFollowResult = {
        ...(latestFollowResult || {}),
        succeeded: true,
        alreadyFollowing: Boolean(latestFollowResult?.alreadyFollowing),
        ...(reason ? {reason} : {})
      };
    }

    const patch = {
      stage: finalStage,
      ...(Number.isFinite(nextEligibleAt) ? {nextEligibleAt} : {}),
      ...(latestFollowResult ? {followResult: latestFollowResult} : {}),
      ...(latestEvaluations.length ? {evaluations: latestEvaluations} : {})
    };

    const settled = await store.settle({
      id: currentJob.id,
      owner: workerOwner,
      version: leaseVersion,
      state: finalState,
      patch
    });

    if (!settled || !settled.ok) {
      counters.failed += 1;
      await emit({
        type: 'job-settle-failed',
        runId: runState.runId,
        accountId: account,
        jobId: currentJob.id,
        attemptedState: finalState,
        settleReason: settled?.reason || 'unknown'
      });
      return;
    }

    // Update counters only when our fenced settle succeeded
    if (finalState === 'followed') {
      if (latestFollowResult?.alreadyFollowing) {
        counters.alreadyFollowing += 1;
      } else {
        counters.followed += 1;
      }
    } else if (finalState === 'skipped') {
      counters.skipped += 1;
    } else if (finalState === 'retry') {
      counters.retried += 1;
      counters.failed += 1;
    } else if (finalState === 'uncertain') {
      counters.uncertain += 1;
      counters.failed += 1;
    } else if (finalState === 'excluded') {
      counters.excluded += 1;
    }

    for (const ev of latestEvaluations) {
      if (!ev || typeof ev !== 'object') continue;
      counters.quoteEvaluated += 1;
      if (ev.status === 'posted' || ev.status === 'published') {
        counters.quotePublished += 1;
      } else if (ev.status === 'draft') {
        counters.quoteDrafted += 1;
      } else if (ev.status === 'failed') {
        counters.quoteFailed += 1;
      } else if (ev.status === 'uncertain' || ev.status === 'publishing' || ev.status === 'generating') {
        counters.quoteUncertain += 1;
      }
    }

    await emit({
      type: 'job-complete',
      runId: runState.runId,
      accountId: account,
      jobId: currentJob.id,
      handle: settled.job?.handle || currentJob.handle,
      targetUserId: settled.job?.targetUserId || currentJob.targetUserId,
      state: finalState,
      stage: finalStage,
      alreadyFollowing: Boolean(latestFollowResult?.alreadyFollowing),
      reason,
      nextEligibleAt: nextEligibleAt || null
    });
  }

  return {
    run,
    pause,
    status: buildStatus
  };
}
