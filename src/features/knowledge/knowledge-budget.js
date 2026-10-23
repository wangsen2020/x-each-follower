/**
 * Grok Knowledge-Base Budget Management (Docs 20.5.3)
 *
 * Provides persistent atomic reservation, quota control, concurrency limiting,
 * cooldown tracking and day rollover management for Grok API access.
 *
 * Keyed by: [grokAccountKey, channel, Asia-Shanghai day, attemptId]
 */

const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/**
 * Returns date string 'YYYY-MM-DD' in Asia/Shanghai timezone.
 */
export function getAsiaShanghaiDay(timestamp = Date.now()) {
  const date = timestamp instanceof Date
    ? timestamp
    : new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  return SHANGHAI_DAY_FORMATTER.format(date);
}

export const DEFAULT_BUDGET_CONFIG = Object.freeze({
  concurrencyLimit: 1, // "shared concurrency default 1"
  hardDailyCalls: null, // user must explicitly configure the hard call ceiling
  autoDailyCalls: null, // "automatic tasks disabled when auto limit unconfigured" (null/undefined/<=0 disables auto tasks)
  hardDailyChars: null,
  maxInputCharsPerCall: null,
  defaultChannel: 'default',
  defaultCooldownMs: 60_000,
  activeLeaseMs: 240_000 // 4 minutes before a hanging reservation is deemed timed out
});

export const LEDGER_OUTCOMES = Object.freeze({
  RESERVED: 'reserved',
  SUBMITTED: 'submitted',
  SUCCESS: 'success',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
  RELEASED: 'released'
});

/**
 * Factory for creating the Grok Knowledge Budget manager.
 *
 * @param {object} options
 * @param {object} options.store - KnowledgeStore instance providing runTransaction
 * @param {object} [options.config] - Optional configuration overrides
 * @param {function} [options.now] - Time source function returning ms timestamp
 * @param {object} [options.IDBKeyRange] - KeyRange implementation for IndexedDB queries
 */
export function createKnowledgeBudget({
  store,
  config = {},
  now = () => Date.now(),
  IDBKeyRange = globalThis.IDBKeyRange
} = {}) {
  if (!store || typeof store.runTransaction !== 'function') {
    throw new Error('createKnowledgeBudget 需要具备 runTransaction 方法的 store 实例');
  }

  let currentConfig = {
    ...DEFAULT_BUDGET_CONFIG,
    ...config
  };

  // Cooldown storage: Map<"grokAccountKey::channel", { cooldownUntil, reason, setAt }>
  const cooldownMap = new Map();

  function makeCooldownKey(grokAccountKey, channel) {
    return `${grokAccountKey}::${channel || currentConfig.defaultChannel}`;
  }

  /**
   * Set or update cooldown for a specific grokAccountKey and channel.
   * Survives day boundaries because cooldownUntil is an absolute timestamp.
   */
  async function recordCooldown({
    grokAccountKey,
    channel = currentConfig.defaultChannel,
    cooldownUntil,
    cooldownMs,
    reason = 'rate_limit'
  }) {
    if (!grokAccountKey) throw new Error('recordCooldown 需要 grokAccountKey');
    const currentTime = now();
    const until = Number.isFinite(cooldownUntil)
      ? cooldownUntil
      : (currentTime + (Number.isFinite(cooldownMs) ? cooldownMs : currentConfig.defaultCooldownMs));

    const key = makeCooldownKey(grokAccountKey, channel);
    const record = {
      grokAccountKey: String(grokAccountKey),
      channel: String(channel || currentConfig.defaultChannel),
      cooldownUntil: until,
      reason: String(reason || ''),
      setAt: currentTime
    };
    cooldownMap.set(key, record);

    await store.setMeta('__budget__', `cooldown:${key}`, record);
    return { ...record };
  }

  /**
   * Clear active cooldown.
   */
  async function clearCooldown({ grokAccountKey, channel = currentConfig.defaultChannel }) {
    if (!grokAccountKey) return;
    const key = makeCooldownKey(grokAccountKey, channel);
    cooldownMap.delete(key);
    await store.setMeta('__budget__', `cooldown:${key}`, null);
  }

  /**
   * Check cooldown state.
   */
  function getCooldown({ grokAccountKey, channel = currentConfig.defaultChannel }) {
    if (!grokAccountKey) return { inCooldown: false, cooldownUntil: null, remainingMs: 0, reason: null };
    const key = makeCooldownKey(grokAccountKey, channel);
    const entry = cooldownMap.get(key);
    if (!entry) return { inCooldown: false, cooldownUntil: null, remainingMs: 0, reason: null };

    const currentTime = now();
    if (entry.cooldownUntil > currentTime) {
      return {
        inCooldown: true,
        cooldownUntil: entry.cooldownUntil,
        remainingMs: entry.cooldownUntil - currentTime,
        reason: entry.reason
      };
    }
    cooldownMap.delete(key);
    return { inCooldown: false, cooldownUntil: null, remainingMs: 0, reason: null };
  }

  async function resolveAttemptDay(grokAccountKey, channel, attemptId, suppliedDay) {
    if (suppliedDay) return String(suppliedDay);
    const matches = (await listLedger({ grokAccountKey, channel }))
      .filter(entry => entry.attemptId === String(attemptId));
    if (matches.length > 1) throw new Error(`重复的跨日 attemptId: ${attemptId}`);
    return matches[0]?.day || getAsiaShanghaiDay(now());
  }

  /**
   * Atomically reserve quota and concurrency before actual Grok submission.
   * Follows docs 20.5.3:
   * - Keyed by actual grokAccountKey/channel/Asia-Shanghai day
   * - Configurable hard daily calls and input chars
   * - Automatic tasks disabled when auto limit unconfigured
   * - Persistent atomic reservation BEFORE actual submission
   * - Idempotent attemptId (resume cannot double reserve)
   * - Shared concurrency default 1
   * - Cooldown survives day boundary
   */
  async function reserveBudget({
    grokAccountKey,
    channel = currentConfig.defaultChannel,
    attemptId,
    inputChars = 0,
    isAuto = false,
    ownerId = null,
    jobId = null,
    requestId = null,
    day = null
  }) {
    if (!grokAccountKey) throw new Error('reserveBudget 需要 grokAccountKey');
    if (!attemptId) throw new Error('reserveBudget 需要 attemptId');

    const ch = String(channel || currentConfig.defaultChannel);
    if (!Number.isSafeInteger(inputChars) || inputChars < 0) {
      throw new Error('inputChars 必须是非负安全整数');
    }
    const chars = inputChars;
    const currentTime = now();
    // Reservation day always comes from the trusted clock; caller supplied dates cannot bypass limits.
    const taskDay = getAsiaShanghaiDay(currentTime);
    const auto = Boolean(isAuto);

    if (!Number.isSafeInteger(currentConfig.hardDailyCalls) || currentConfig.hardDailyCalls <= 0) {
      return { granted: false, reason: 'hard_limit_unconfigured' };
    }

    // 1. Single-call input chars limit check
    if (currentConfig.maxInputCharsPerCall != null && chars > currentConfig.maxInputCharsPerCall) {
      return {
        granted: false,
        reason: 'call_input_chars_exceeded',
        message: `单次输入字符数 (${chars}) 超出单次上限 (${currentConfig.maxInputCharsPerCall})`,
        limit: currentConfig.maxInputCharsPerCall,
        requested: chars
      };
    }

    // 2. Automatic tasks disabled when auto limit unconfigured
    if (auto) {
      const autoLimit = currentConfig.autoDailyCalls;
      if (autoLimit === null || autoLimit === undefined || autoLimit <= 0) {
        return {
          granted: false,
          reason: 'auto_limit_unconfigured',
          message: '未配置自动分析每日预算，后台自动分析任务已停用',
          autoDailyCalls: autoLimit
        };
      }
    }

    // Restore cooldown from IndexedDB on every reservation, including after a browser restart.
    const persistedCooldown = await store.getMeta('__budget__', `cooldown:${makeCooldownKey(grokAccountKey, ch)}`);
    if (persistedCooldown?.cooldownUntil > currentTime) {
      cooldownMap.set(makeCooldownKey(grokAccountKey, ch), persistedCooldown);
    } else {
      cooldownMap.delete(makeCooldownKey(grokAccountKey, ch));
    }

    // 3. Cooldown check (survives day boundary and browser restart)
    const cd = getCooldown({ grokAccountKey, channel: ch });
    if (cd.inCooldown) {
      return {
        granted: false,
        reason: 'in_cooldown',
        message: `通道正在冷却中 (剩余 ${Math.ceil(cd.remainingMs / 1000)} 秒): ${cd.reason || ''}`,
        cooldownUntil: cd.cooldownUntil,
        waitMs: cd.remainingMs,
        cooldownReason: cd.reason
      };
    }

    // 4. Atomic check and reservation in budgetLedger transaction
    return store.runTransaction(['budgetLedger'], 'readwrite', (stores, set, fail) => {
      const ledgerStore = stores.budgetLedger;
      const primaryKey = [String(grokAccountKey), ch, taskDay, String(attemptId)];
      const getReq = ledgerStore.get(primaryKey);

      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          if (existing.inputChars !== chars || existing.isAuto !== auto ||
              (jobId && existing.jobId && String(jobId) !== existing.jobId)) {
            set({ granted: false, reused: true, reason: 'attempt_payload_conflict', entry: existing });
            return;
          }
          // Idempotency: resume cannot double reserve
          if (existing.outcome === 'reserved') {
            set({
              granted: true,
              reserved: true,
              reused: true,
              resumed: true,
              entry: existing
            });
            return;
          }
          if (existing.outcome === 'released') {
            set({
              granted: false,
              reused: true,
              reason: 'attempt_already_released',
              entry: existing
            });
            return;
          }
          // Already submitted, uncertain, completed, or failed
          set({
            granted: false,
            reused: true,
            reason: 'attempt_already_executed',
            outcome: existing.outcome,
            entry: existing
          });
          return;
        }

        // New attempt: query records for this grokAccountKey and channel
        const KeyRangeImpl = IDBKeyRange || globalThis.IDBKeyRange;
        let allReq;
        if (KeyRangeImpl?.bound) {
          const range = KeyRangeImpl.bound(
            [String(grokAccountKey), ch, '', ''],
            [String(grokAccountKey), ch, '\uffff', '\uffff']
          );
          allReq = ledgerStore.getAll(range);
        } else {
          allReq = ledgerStore.getAll();
        }

        allReq.onsuccess = () => {
          const allRecords = (allReq.result || []).filter(
            r => r.grokAccountKey === String(grokAccountKey) && r.channel === ch
          );

          const priorAttempt = allRecords.find(r => r.attemptId === String(attemptId));
          if (priorAttempt) {
            if (priorAttempt.inputChars !== chars || priorAttempt.isAuto !== auto ||
                (jobId && priorAttempt.jobId && String(jobId) !== priorAttempt.jobId)) {
              set({ granted: false, reused: true, reason: 'attempt_payload_conflict', entry: priorAttempt });
              return;
            }
            set({
              granted: priorAttempt.outcome === 'reserved',
              reused: true,
              reason: 'attempt_already_exists',
              entry: priorAttempt
            });
            return;
          }

          // A timed-out reservation may already have reached Grok before the browser died.
          // Keep the channel occupied until the attempt is explicitly reconciled or released.
          const inFlightRecords = allRecords.filter(r =>
            ['reserved', 'submitted', 'uncertain'].includes(r.outcome)
          );

          const activeInFlight = inFlightRecords.length;
          const concurrencyLimit = Number.isFinite(currentConfig.concurrencyLimit) && currentConfig.concurrencyLimit > 0
            ? currentConfig.concurrencyLimit
            : 1;

          if (activeInFlight >= concurrencyLimit) {
            set({
              granted: false,
              reason: 'concurrency_limit_exceeded',
              message: `达到通道共享并发限制 (${concurrencyLimit})，当前在途请求数: ${activeInFlight}`,
              limit: concurrencyLimit,
              currentInFlight: activeInFlight
            });
            return;
          }

          // Check Day Quotas (Asia-Shanghai Day Rollover)
          const dayRecords = allRecords.filter(r => r.day === taskDay);
          // Only non-released records consume daily budget; uncertain counts as attempted!
          const countedRecords = dayRecords.filter(r => r.outcome !== 'released');

          const totalDailyCalls = countedRecords.length;
          const totalDailyChars = countedRecords.reduce((sum, r) => sum + (Number(r.inputChars) || 0), 0);
          const totalAutoCalls = countedRecords.filter(r => r.isAuto).length;

          // Check hard daily calls
          if (currentConfig.hardDailyCalls != null && totalDailyCalls + 1 > currentConfig.hardDailyCalls) {
            set({
              granted: false,
              reason: 'hard_daily_calls_exceeded',
              message: `超出每日总调用硬上限 (${currentConfig.hardDailyCalls})，当日已占用: ${totalDailyCalls}`,
              limit: currentConfig.hardDailyCalls,
              current: totalDailyCalls
            });
            return;
          }

          // Check auto daily calls
          if (auto && currentConfig.autoDailyCalls != null && totalAutoCalls + 1 > currentConfig.autoDailyCalls) {
            set({
              granted: false,
              reason: 'auto_daily_calls_exceeded',
              message: `超出每日自动分析调用上限 (${currentConfig.autoDailyCalls})，当日已占用: ${totalAutoCalls}`,
              limit: currentConfig.autoDailyCalls,
              current: totalAutoCalls
            });
            return;
          }

          // Check hard daily input chars
          if (currentConfig.hardDailyChars != null && totalDailyChars + chars > currentConfig.hardDailyChars) {
            set({
              granted: false,
              reason: 'hard_daily_chars_exceeded',
              message: `超出每日输入字符硬上限 (${currentConfig.hardDailyChars})，当日已占用: ${totalDailyChars}，请求: ${chars}`,
              limit: currentConfig.hardDailyChars,
              current: totalDailyChars,
              requested: chars
            });
            return;
          }

          // Persist the reservation BEFORE actual submission
          const reservationRecord = {
            grokAccountKey: String(grokAccountKey),
            channel: ch,
            day: taskDay,
            attemptId: String(attemptId),
            reserved: true,
            submitted: false,
            inputChars: chars,
            outcome: 'reserved',
            isAuto: auto,
            ownerId: ownerId ? String(ownerId) : null,
            jobId: jobId ? String(jobId) : null,
            requestId: requestId ? String(requestId) : null,
            releaseReason: null,
            error: null,
            createdAt: currentTime,
            updatedAt: currentTime,
            submittedAt: null,
            releasedAt: null,
            uncertainAt: null
          };

          const putReq = ledgerStore.put(reservationRecord);
          putReq.onsuccess = () => {
            set({
              granted: true,
              reserved: true,
              entry: reservationRecord
            });
          };
          putReq.onerror = () => fail(putReq.error);
        };
        allReq.onerror = () => fail(allReq.error);
      };
      getReq.onerror = () => fail(getReq.error);
    });
  }

  /**
   * Marks that the reserved attempt has actually been dispatched/submitted to Grok.
   */
  async function recordSubmission({
    grokAccountKey,
    channel = currentConfig.defaultChannel,
    day = null,
    attemptId
  }) {
    if (!grokAccountKey) throw new Error('recordSubmission 需要 grokAccountKey');
    if (!attemptId) throw new Error('recordSubmission 需要 attemptId');

    const ch = String(channel || currentConfig.defaultChannel);
    const currentTime = now();
    const taskDay = await resolveAttemptDay(grokAccountKey, ch, attemptId, day);

    return store.runTransaction(['budgetLedger'], 'readwrite', (stores, set, fail) => {
      const ledgerStore = stores.budgetLedger;
      const primaryKey = [String(grokAccountKey), ch, taskDay, String(attemptId)];
      const getReq = ledgerStore.get(primaryKey);

      getReq.onsuccess = () => {
        const entry = getReq.result;
        if (!entry) {
          fail(new Error(`未找到预留记录: ${attemptId}`));
          return;
        }
        if (entry.outcome === 'released') {
          fail(new Error(`已释放的预留记录禁止标记为已提交: ${attemptId}`));
          return;
        }
        if (entry.submitted) {
          set({ success: true, reused: true, entry });
          return;
        }
        const updated = {
          ...entry,
          submitted: true,
          outcome: 'submitted',
          submittedAt: currentTime,
          updatedAt: currentTime
        };
        const putReq = ledgerStore.put(updated);
        putReq.onsuccess = () => set({ success: true, entry: updated });
        putReq.onerror = () => fail(putReq.error);
      };
      getReq.onerror = () => fail(getReq.error);
    });
  }

  /**
   * Records execution outcome (success, completed, failed, uncertain).
   * Note: "uncertain counts as attempted" and remains counted towards quota!
   */
  async function recordResult({
    grokAccountKey,
    channel = currentConfig.defaultChannel,
    day = null,
    attemptId,
    outcome = 'success',
    error = null,
    cooldownMs = null,
    cooldownUntil = null
  }) {
    if (!grokAccountKey) throw new Error('recordResult 需要 grokAccountKey');
    if (!attemptId) throw new Error('recordResult 需要 attemptId');

    const ch = String(channel || currentConfig.defaultChannel);
    const currentTime = now();
    const taskDay = await resolveAttemptDay(grokAccountKey, ch, attemptId, day);

    if (!['success', 'completed', 'failed', 'uncertain'].includes(outcome)) {
      throw new Error(`非法的 Grok 调用结果: ${outcome}`);
    }

    const result = await store.runTransaction(['budgetLedger'], 'readwrite', (stores, set, fail) => {
      const ledgerStore = stores.budgetLedger;
      const primaryKey = [String(grokAccountKey), ch, taskDay, String(attemptId)];
      const getReq = ledgerStore.get(primaryKey);

      getReq.onsuccess = () => {
        const entry = getReq.result;
        if (!entry) {
          fail(new Error(`未找到预留记录: ${attemptId}`));
          return;
        }
        if (entry.outcome === 'released') {
          fail(new Error(`已释放的记录禁止更新结果: ${attemptId}`));
          return;
        }
        if (['success', 'completed', 'failed'].includes(entry.outcome)) {
          if (entry.outcome === outcome) {
            set({ success: true, reused: true, entry });
          } else {
            fail(new Error(`已结算的调用结果不可改写: ${attemptId}`));
          }
          return;
        }
        const updated = {
          ...entry,
          submitted: true, // "uncertain counts as attempted", failed after submission counts as submitted
          outcome: String(outcome),
          error: error ? String(error) : null,
          updatedAt: currentTime
        };
        if (outcome === 'uncertain') {
          updated.uncertainAt = currentTime;
        }
        const putReq = ledgerStore.put(updated);
        putReq.onsuccess = () => set({ success: true, entry: updated });
        putReq.onerror = () => fail(putReq.error);
      };
      getReq.onerror = () => fail(getReq.error);
    });
    if (cooldownUntil || cooldownMs) {
      await recordCooldown({
        grokAccountKey,
        channel: ch,
        cooldownUntil,
        cooldownMs,
        reason: error ? String(error) : outcome
      });
    }
    return result;
  }

  /**
   * Releases quota reservation ONLY when definitely not submitted to Grok.
   * If already submitted, uncertain, or completed, rejects with error!
   */
  async function releaseReservation({
    grokAccountKey,
    channel = currentConfig.defaultChannel,
    day = null,
    attemptId,
    reason = 'cancelled_before_submission'
  }) {
    if (!grokAccountKey) throw new Error('releaseReservation 需要 grokAccountKey');
    if (!attemptId) throw new Error('releaseReservation 需要 attemptId');

    const ch = String(channel || currentConfig.defaultChannel);
    const currentTime = now();
    const taskDay = await resolveAttemptDay(grokAccountKey, ch, attemptId, day);

    return store.runTransaction(['budgetLedger'], 'readwrite', (stores, set, fail) => {
      const ledgerStore = stores.budgetLedger;
      const primaryKey = [String(grokAccountKey), ch, taskDay, String(attemptId)];
      const getReq = ledgerStore.get(primaryKey);

      getReq.onsuccess = () => {
        const entry = getReq.result;
        if (!entry) {
          set({ released: false, reason: 'not_found' });
          return;
        }
        // "release ONLY when definitely not submitted, uncertain counts as attempted"
        if (entry.submitted || ['submitted', 'uncertain', 'success', 'completed', 'failed'].includes(entry.outcome)) {
          fail(new Error(`无法释放预留额度：只有确定未向远端提交的任务才可释放预留 (当前状态: outcome=${entry.outcome}, submitted=${entry.submitted})`));
          return;
        }
        if (entry.outcome === 'released') {
          set({ released: true, reused: true, entry });
          return;
        }

        const updated = {
          ...entry,
          reserved: false,
          submitted: false,
          outcome: 'released',
          releaseReason: String(reason || ''),
          releasedAt: currentTime,
          updatedAt: currentTime
        };
        const putReq = ledgerStore.put(updated);
        putReq.onsuccess = () => set({ released: true, entry: updated });
        putReq.onerror = () => fail(putReq.error);
      };
      getReq.onerror = () => fail(getReq.error);
    });
  }

  /**
   * Retrieves daily quota usage and limits for a specific grokAccountKey/channel/day.
   */
  async function getDailyUsage({
    grokAccountKey,
    channel = currentConfig.defaultChannel,
    day = null
  } = {}) {
    if (!grokAccountKey) throw new Error('getDailyUsage 需要 grokAccountKey');

    const ch = String(channel || currentConfig.defaultChannel);
    const currentTime = now();
    const taskDay = day ? String(day) : getAsiaShanghaiDay(currentTime);

    return store.runTransaction(['budgetLedger'], 'readonly', (stores, set, fail) => {
      const ledgerStore = stores.budgetLedger;
      const KeyRangeImpl = IDBKeyRange || globalThis.IDBKeyRange;
      let allReq;
      if (KeyRangeImpl?.bound) {
        const range = KeyRangeImpl.bound(
          [String(grokAccountKey), ch, taskDay, ''],
          [String(grokAccountKey), ch, taskDay, '\uffff']
        );
        allReq = ledgerStore.getAll(range);
      } else {
        allReq = ledgerStore.getAll();
      }

      allReq.onsuccess = () => {
        const dayEntries = (allReq.result || []).filter(
          r => r.grokAccountKey === String(grokAccountKey) && r.channel === ch && r.day === taskDay
        );

        const nonReleased = dayEntries.filter(r => r.outcome !== 'released');
        const totalCalls = nonReleased.length;
        const totalChars = nonReleased.reduce((sum, r) => sum + (Number(r.inputChars) || 0), 0);
        const autoCalls = nonReleased.filter(r => r.isAuto).length;
        const manualCalls = totalCalls - autoCalls;
        const activeInFlight = dayEntries.filter(r => r.outcome === 'reserved').length;

        const cd = getCooldown({ grokAccountKey, channel: ch });

        set({
          grokAccountKey: String(grokAccountKey),
          channel: ch,
          day: taskDay,
          totalCalls,
          autoCalls,
          manualCalls,
          totalChars,
          activeInFlight,
          hardDailyCalls: currentConfig.hardDailyCalls,
          autoDailyCalls: currentConfig.autoDailyCalls,
          hardDailyChars: currentConfig.hardDailyChars,
          maxInputCharsPerCall: currentConfig.maxInputCharsPerCall,
          concurrencyLimit: currentConfig.concurrencyLimit,
          inCooldown: cd.inCooldown,
          cooldownUntil: cd.cooldownUntil,
          remainingCooldownMs: cd.remainingMs,
          cooldownReason: cd.reason,
          entries: dayEntries
        });
      };
      allReq.onerror = () => fail(allReq.error);
    });
  }

  /**
   * Lists ledger entries matching grokAccountKey and optional channel and day.
   */
  async function listLedger({
    grokAccountKey,
    channel = currentConfig.defaultChannel,
    day = null
  } = {}) {
    if (!grokAccountKey) throw new Error('listLedger 需要 grokAccountKey');

    const ch = String(channel || currentConfig.defaultChannel);

    return store.runTransaction(['budgetLedger'], 'readonly', (stores, set, fail) => {
      const ledgerStore = stores.budgetLedger;
      const KeyRangeImpl = IDBKeyRange || globalThis.IDBKeyRange;
      let allReq;
      if (day && KeyRangeImpl?.bound) {
        allReq = ledgerStore.getAll(
          KeyRangeImpl.bound([String(grokAccountKey), ch, String(day), ''], [String(grokAccountKey), ch, String(day), '\uffff'])
        );
      } else if (KeyRangeImpl?.bound) {
        allReq = ledgerStore.getAll(
          KeyRangeImpl.bound([String(grokAccountKey), ch, '', ''], [String(grokAccountKey), ch, '\uffff', '\uffff'])
        );
      } else {
        allReq = ledgerStore.getAll();
      }

      allReq.onsuccess = () => {
        let results = (allReq.result || []).filter(
          r => r.grokAccountKey === String(grokAccountKey) && r.channel === ch
        );
        if (day) {
          results = results.filter(r => r.day === String(day));
        }
        set(results);
      };
      allReq.onerror = () => fail(allReq.error);
    });
  }

  function updateConfig(newConfig = {}) {
    currentConfig = {
      ...currentConfig,
      ...newConfig
    };
    return { ...currentConfig };
  }

  function getConfig() {
    return { ...currentConfig };
  }

  return {
    reserveBudget,
    recordSubmission,
    recordResult,
    releaseReservation,
    recordCooldown,
    clearCooldown,
    getCooldown,
    getDailyUsage,
    listLedger,
    updateConfig,
    getConfig
  };
}

export const createKnowledgeBudgetManager = createKnowledgeBudget;
