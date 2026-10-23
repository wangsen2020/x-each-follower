/** Per-module dashboard load chrome. Presentation only; it does not read or migrate storage. */

export const DASHBOARD_MODULES = {
  monitor: {initial: '正在加载粉丝管理…', refresh: '正在刷新粉丝管理…', recover: '正在从本地备份恢复粉丝管理…', badgeId: 'queueCount'},
  mutual: {initial: '正在加载互关追踪…', refresh: '正在刷新互关追踪…', recover: '正在从本地备份恢复互关追踪…', badgeId: 'mutualNetworkCount'},
  comments: {initial: '正在加载评论追踪…', refresh: '正在刷新评论追踪…', recover: '正在从本地备份恢复评论追踪…', badgeId: 'commentTrackingCount'},
  followQueue: {initial: '正在加载关注队列…', refresh: '正在刷新关注队列…', recover: '正在从本地备份恢复关注队列…', badgeId: null},
  unreciprocated: {initial: '正在加载回关监测…', refresh: '正在刷新回关监测…', recover: '正在从本地备份恢复回关监测…', badgeId: 'unreciprocatedCount'}
};

export const RECOVERY_KEY_MODULE = {
  rows: 'monitor',
  monitor: 'monitor',
  analysisRows: 'monitor',
  profileCache: 'monitor',
  mutualNetwork: 'mutual',
  mutualAutoFollowSettings: 'mutual',
  commentTracking: 'comments',
  commentAutoFollowSettings: 'comments',
  unreciprocatedTracker: 'unreciprocated'
};

export function recoveryModuleForKey(key) {
  return RECOVERY_KEY_MODULE[key] || null;
}

export function modulesAwaitingRecovery(presence) {
  const modules = [];
  for (const [key, present] of Object.entries(presence || {})) {
    if (present !== false) continue;
    const moduleId = recoveryModuleForKey(key);
    if (moduleId && !modules.includes(moduleId)) modules.push(moduleId);
  }
  return modules;
}

export function preserveReadError(state) {
  return state?.status === 'error' && state.phase !== 'recover';
}

export function settleRecoveredModule(registry, moduleId) {
  if (preserveReadError(registry.get(moduleId))) return false;
  registry.succeed(moduleId);
  return true;
}

export function createLoadRegistry() {
  const states = {};
  for (const id of Object.keys(DASHBOARD_MODULES)) {
    states[id] = {status: 'loading', phase: 'load', error: '', hadSuccess: false};
  }
  return {
    get(id) {
      if (!states[id]) throw new Error(`unknown dashboard module ${id}`);
      return states[id];
    },
    begin(id, phase = 'load') {
      const state = this.get(id);
      state.status = 'loading';
      state.phase = phase === 'recover' ? 'recover' : 'load';
      state.error = '';
      return state;
    },
    succeed(id) {
      const state = this.get(id);
      state.status = 'ready';
      state.error = '';
      state.hadSuccess = true;
      return state;
    },
    fail(id, message) {
      const state = this.get(id);
      state.status = 'error';
      state.error = message || '加载失败';
      return state;
    }
  };
}

export function moduleView(state, {rowCount = 0} = {}) {
  const rows = Number(rowCount) || 0;
  const known = state.hadSuccess || rows > 0;
  const loading = state.status === 'loading';
  const failed = state.status === 'error';
  return {
    showSkeleton: loading && !known,
    showRefresh: loading && known,
    showError: failed,
    showEmpty: state.status === 'ready' && rows === 0,
    allowList: state.status === 'ready' || known,
    keepRows: rows > 0,
    errorText: state.error || '加载失败'
  };
}

export function badgePresentation(state, count) {
  if (state.status === 'loading' && !state.hadSuccess) return {mode: 'loading'};
  if (state.status === 'error' && !state.hadSuccess) return {mode: 'error'};
  return {mode: 'count', count: Number(count) || 0};
}

export function applyModuleView(doc, moduleId, state, rowCount) {
  const view = moduleView(state, {rowCount});
  const copy = DASHBOARD_MODULES[moduleId];
  const load = doc.getElementById?.(`${moduleId}Load`);
  if (load) {
    const visible = view.showSkeleton || view.showRefresh;
    load.hidden = !visible;
    load.setAttribute('aria-busy', visible ? 'true' : 'false');
    const text = load.querySelector('.dash-load-text');
    if (text) {
      text.textContent = state.phase === 'recover'
        ? copy.recover
        : (view.showRefresh ? copy.refresh : copy.initial);
    }
  }
  const error = doc.getElementById?.(`${moduleId}LoadError`);
  if (error) {
    error.hidden = !view.showError;
    const text = error.querySelector('.dash-load-text');
    if (text) text.textContent = view.errorText;
  }
  return view;
}

/**
 * Reusable migration progress chrome. Caller supplies the real stage and counts.
 * This function does not start a migration and does not invent a percentage.
 */
export function migrationProgressView(input) {
  if (!input || typeof input.stage !== 'string' || !input.stage.trim()) {
    throw new Error('migration progress requires a stage');
  }
  const stage = input.stage.trim();
  if (input.replay) {
    const replay = input.replay;
    const completed = Number(replay.completed) || 0;
    const total = replay.total == null ? null : Number(replay.total);
    return {stage, completed, total, percent: null,
      label: `${stage} · 增量日志 ${completed}/${total == null ? '读取中' : total} · 基线记录 ${input.completed}/${input.total}`};
  }
  const hasCompleted = Object.prototype.hasOwnProperty.call(input, 'completed');
  const hasTotal = Object.prototype.hasOwnProperty.call(input, 'total');
  if (hasCompleted !== hasTotal) throw new Error('migration progress counts must be provided together');
  if (!hasCompleted) return {stage, completed: null, total: null, label: stage, percent: null};
  if (!Number.isFinite(input.completed) || !Number.isFinite(input.total) || input.completed < 0 || input.total < 0) {
    throw new Error('migration progress counts must be finite and non-negative');
  }
  return {
    stage,
    completed: input.completed,
    total: input.total,
    label: `${stage} ${input.completed}/${input.total}`,
    percent: null
  };
}

const REPLAY_STEPS = {
  'read-head': '读取增量日志总数', 'read-entry': '读取增量记录',
  'read-row': '读取目标记录', 'prepare-row': '整理目标记录', 'write-row': '写入目标记录', 'delete-row': '删除目标记录',
  'read-metadata': '读取模块信息', 'write-metadata': '写入模块信息',
  'read-related-rows': '读取关联记录', 'read-relations': '读取关系状态',
  'write-relation': '写入关系状态', 'delete-relation': '清理关系状态',
  'write-derived-row': '更新未互关记录', 'delete-derived-row': '清理未互关记录',
  'prepare-tracker-row': '整理回关监测记录', 'write-tracker-row': '写入回关监测记录', 'delete-tracker-row': '清理回关监测记录',
  'refresh-related-views': '更新关联视图', 'update-revision': '更新数据版本',
  checkpoint: '保存回放批次状态', 'read-dirty-keys': '检查待同步数据', 'finalize-ready': '完成迁移状态写入'
};
export function replayDiagnosticText(replay) {
  const seconds = value => `${(Math.max(0, Number(value) || 0) / 1000).toFixed(2)} 秒`;
  const step = name => REPLAY_STEPS[name] || name;
  const lines = [
    `当前序号：${replay.seq ?? '尚未读取'}；已完成：${replay.completed}；日志总数：${replay.total ?? '读取中'}`,
    `当前步骤：${replay.step ? step(replay.step) : (replay.finishedAt != null ? '已结束' : '切换步骤')}；本步耗时：${seconds(replay.stepElapsedMs)}；回放总耗时：${seconds(replay.elapsedMs)}`
  ];
  if (replay.kind || replay.module) lines.push(`记录类型：${replay.kind || '—'}；模块：${replay.module || '—'}`);
  if (replay.error) lines.push(`回放错误：${replay.error}`);
  else if (replay.step && replay.stepElapsedMs >= 10000) lines.push('此步骤已等待超过 10 秒，尚未返回；请保留此处的序号与步骤名称。');
  const stats = Object.entries(replay.steps || {});
  if (stats.length) lines.push('各步骤耗时（累计 / 最近一次 / 最长一次 / 次数）：', ...stats.map(([name, value]) =>
    `${step(name)}：${seconds(value.totalMs)} / ${seconds(value.lastMs)} / ${seconds(value.maxMs)} / ${value.count}`));
  if (replay.recent?.length) lines.push('最近完成的步骤：', ...replay.recent.slice(-6).map(item =>
    `#${item.seq ?? '—'} ${step(item.step)}：${seconds(item.ms)}${item.failed ? ' · 失败' : ''}`));
  return lines.join('\n');
}

export function paintMigrationProgress(container, input) {
  const view = migrationProgressView(input);
  const row = container.ownerDocument.createElement('div');
  row.className = 'dash-load dash-migration';
  row.setAttribute('role', 'status');
  row.setAttribute('aria-live', 'polite');
  const text = container.ownerDocument.createElement('span');
  text.className = 'dash-load-text';
  text.textContent = view.label;
  row.append(text);
  if (view.total !== null && view.total > 0) {
    const bar = container.ownerDocument.createElement('progress');
    bar.max = String(view.total);
    bar.value = String(Math.min(view.completed, view.total));
    bar.setAttribute('aria-label', view.label);
    row.append(bar);
  }
  container.replaceChildren(row);
  if (input.replay) {
    const diagnostic = container.ownerDocument.createElement('pre');
    diagnostic.className = 'dash-migration-diagnostic';
    diagnostic.textContent = replayDiagnosticText(input.replay);
    container.append(diagnostic);
  }
  return view;
}
export function hideMigrationProgress(doc) {
  const host = doc?.getElementById?.('recordMigration');
  if (host) host.hidden = true;
}
