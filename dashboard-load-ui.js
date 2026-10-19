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
  return view;
}
