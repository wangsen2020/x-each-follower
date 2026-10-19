// Dashboard page client. One module page at a time. Record arrays stay on the service.

const RECORD_KEYS = ['monitor', 'mutualNetwork', 'commentTracking', 'unreciprocatedTracker'];
const SUMMARY_MODULES = ['fans', 'mutual', 'comments', 'posts', 'unreciprocated', 'relations'];
const MODULE_BY_PANEL = {monitor: 'fans', candidates: 'mutual', comments: 'comments', unreciprocated: 'unreciprocated'};

export function panelModuleForTab(tab) {
  return MODULE_BY_PANEL[tab] || null;
}

const STAGE_LABELS = {
  reading: '正在读取旧记录',
  backup: '正在保存迁移备份',
  importing: '正在导入记录',
  verifying: '正在校验记录',
  activating: '正在切换读取',
  replaying: '正在回放增量记录',
  ready: '迁移完成',
  failed: '迁移失败'
};

export function migrationStageLabel(status = {}) {
  const label = STAGE_LABELS[status.stage] || '正在迁移';
  return status.stage === 'failed' && status.error ? `${label}：${status.error}` : label;
}

export function createPanelPages({request, onProgress, delay, cacheLimit = 3, debounceMs = 200} = {}) {
  if (typeof request !== 'function') throw new Error('record request is required');
  const wait = delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const windows = new Map();
  const summaries = {};
  const complete = new Set();
  const cache = [];
  let generation = 0;
  let searchTimer = null;
  let resolveSearch = null;
  const calls = [];

  function remember(key, value) {
    const index = cache.findIndex(entry => entry.key === key);
    if (index >= 0) cache.splice(index, 1);
    cache.push({key, value});
    while (cache.length > cacheLimit) cache.shift();
  }

  async function send(message) {
    calls.push(message.op);
    const result = await request(message);
    if (result && result.ok === false) throw new Error(result.error || 'record request failed');
    return result;
  }

  function presentStatus(status) {
    return {...(status || {}), label: migrationStageLabel(status)};
  }

  async function migrate(progress) {
    let status = (await send({op: 'status'})).status;
    progress?.(presentStatus(status));
    if (status?.cutover) return presentStatus(status);
    let settled = null;
    let jobError = null;
    const job = send({op: 'migrate'}).then(result => {
      settled = result?.status || null;
    }).catch(error => {
      jobError = error;
    });
    while (!jobError && !status?.cutover) {
      await wait(250);
      try {
        status = (await send({op: 'status'})).status;
        progress?.(presentStatus(status));
        if (status?.cutover || (settled && status?.stage === 'failed')) break;
      } catch (error) {
        jobError = error;
        break;
      }
      if (settled?.cutover) break;
    }
    if (!jobError) await job;
    status = settled?.cutover ? settled : ((await send({op: 'status'})).status || settled || status);
    if (jobError && !status?.cutover) {
      status = {stage: 'failed', error: String(jobError.message || jobError), cutover: false, completed: status?.completed || 0, total: status?.total || 0};
    }
    progress?.(presentStatus(status));
    if (!status?.cutover) {
      const failure = new Error(status?.error || '迁移失败');
      failure.status = presentStatus(status);
      throw failure;
    }
    return presentStatus(status);
  }

  async function refreshSummaries() {
    for (const moduleName of SUMMARY_MODULES) {
      summaries[moduleName] = (await send({op: 'summary', module: moduleName})).summary;
    }
  }

  async function boot(activeModule, filter = {}) {
    generation += 1;
    const token = generation;
    await migrate(onProgress);
    if (token !== generation) return null;
    await refreshSummaries();
    const config = {};
    for (const key of ['mutualAutoFollowSettings', 'commentAutoFollowSettings', 'unreciprocatedSettings', 'followQueueBinding']) {
      config[key] = (await send({op: 'config', key})).value;
    }
    const chosen = typeof activeModule === 'function' ? activeModule() : {module: activeModule, filter};
    const page = await open(chosen.module, chosen.filter || filter, token);
    return {summaries: {...summaries}, config, page, module: chosen.module, calls: calls.slice()};
  }

  async function open(moduleName, filter = {}, token = generation) {
    const page = await readPage(moduleName, filter, null, token);
    if (token !== generation) return null;
    windows.set(moduleName, page);
    return page;
  }

  async function readPage(moduleName, filter, cursor, token) {
    const cacheKey = JSON.stringify({moduleName, filter, cursor});
    const cached = cache.find(entry => entry.key === cacheKey);
    if (cached && token === generation) return structuredClone(cached.value);
    const cancelToken = `page-${token}-${cacheKey.length}`;
    const limit = Math.max(1, Math.min(100, Number(filter.pageSize) || 20));
    const result = await send({op: 'query', module: moduleName, limit, cursor, filter, cancelToken});
    if (token !== generation) {
      await send({op: 'cancel', cancelToken}).catch(() => {});
      return null;
    }
    const summary = summaries[moduleName] || null;
    const tab = filter.tab || 'all';
    const complex = Boolean(filter.search || (filter.tags && filter.tags.length));
    const tabCount = summary?.tabs && Object.prototype.hasOwnProperty.call(summary.tabs, tab) ? summary.tabs[tab] : undefined;
    const total = complex ? null : (tabCount != null ? tabCount : (tab === 'all' || !summary?.tabs ? (summary?.total ?? result.page.records.length) : 0));
    const page = {
      module: moduleName,
      filter: {...filter},
      records: (result.page.records || []).map(record => ({...record, payload: structuredClone(record.payload), view: record.view ? structuredClone(record.view) : null})),
      nextCursor: result.page.nextCursor,
      scanned: result.page.scanned,
      total,
      summary: summary ? structuredClone(summary) : null,
      history: []
    };
    remember(cacheKey, structuredClone(page));
    return page;
  }

  function search(moduleName, filter) {
    generation += 1;
    const token = generation;
    if (searchTimer) clearTimeout(searchTimer);
    if (resolveSearch) resolveSearch(null);
    return new Promise(resolve => {
      resolveSearch = resolve;
      searchTimer = setTimeout(() => {
        resolveSearch = null;
        open(moduleName, filter, token).then(resolve);
      }, debounceMs);
    });
  }

  async function next(moduleName) {
    const current = windows.get(moduleName);
    if (!current?.nextCursor) return current || null;
    generation += 1;
    const page = await readPage(moduleName, current.filter, current.nextCursor, generation);
    if (!page) return null;
    page.history = [...(current.history || []), current.nextCursor ? 'next' : null].filter(Boolean);
    page.cursors = [...(current.cursors || [null]), current.nextCursor];
    windows.set(moduleName, page);
    return page;
  }

  async function previous(moduleName) {
    const current = windows.get(moduleName);
    const cursors = current?.cursors || [];
    if (cursors.length < 2) return current || null;
    generation += 1;
    const cursor = cursors[cursors.length - 2];
    const page = await readPage(moduleName, current.filter, cursor, generation);
    if (!page) return null;
    page.cursors = cursors.slice(0, -1);
    windows.set(moduleName, page);
    return page;
  }

  async function invalidate() {
    generation += 1;
    cache.length = 0;
    windows.clear();
    complete.clear();
    await refreshSummaries();
  }

  async function retry() {
    generation += 1;
    return migrate(onProgress);
  }

  async function bridgeWrite(key, value, options = {}) {
    complete.delete(key);
    const moduleName = key === 'monitor' ? 'fans' : key === 'mutualNetwork' ? 'mutual' : key === 'commentTracking' ? 'comments' : key === 'unreciprocatedTracker' ? 'unreciprocated' : key === 'profileCache' ? 'profiles' : key === 'analysisRows' ? 'analysis' : null;
    if (!moduleName) return null;
    const mapKey = key === 'profileCache' || key === 'analysisRows';
    const baseline = options.baseline && typeof options.baseline === 'object' ? options.baseline : null;
    const fields = {};
    if (!mapKey && baseline && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, field] of Object.entries(value)) {
        if (Array.isArray(field) || (field && typeof field === 'object')) continue;
        if (JSON.stringify(baseline[name]) !== JSON.stringify(field)) fields[name] = field;
      }
    }
    if (Object.keys(fields).length) await send({op: 'mergeRoot', key, fields});
    const page = windows.get(moduleName);
    const visible = page?.records || [];
    function locate(bucket, handle, userKey) {
      if (userKey) {
        const byKey = visible.find(record => record.userKey === userKey);
        if (byKey) return byKey;
      }
      return visible.find(record => (record.sourcePath?.[1] || 'users') === bucket && String(record.handle || record.payload?.handle || '').toLowerCase() === handle) || null;
    }
    const changes = [];
    for (const [bucket, list] of namedLists(value)) {
      for (const found of list) {
        const handle = String(found?.handle || '').toLowerCase();
        if (!handle) continue;
        const record = locate(found.__sourceBucket || bucket, handle, found.__userKey);
        const sourceBucket = found.__sourceBucket || record?.sourcePath?.[1] || bucket;
        const payload = stripBridgeMeta(found);
        const synthetic = sourceBucket === 'synthetic' || record?.sourcePath?.[1] === 'synthetic';
        const sourceKey = synthetic ? 'unreciprocatedTracker' : (found.__sourceKey || record?.sourcePath?.[0] || key);
        if (synthetic) {
          const baseline = stripBridgeMeta(record?.payload || {});
          const patch = {...baseline, ...payload};
          if (record && !Object.keys(changedFields(baseline, payload)).length) continue;
          changes.push({handle, sourceBucket: 'synthetic', sourceKey, create: true, patch});
          continue;
        }
        if (!record && !found.__userKey) {
          changes.push({handle, sourceBucket, sourceKey, create: true, patch: payload});
          continue;
        }
        const patch = changedFields(record?.payload || {}, payload);
        if (!Object.keys(patch).length) continue;
        changes.push({userKey: record?.userKey || found.__userKey, handle: record?.handle || handle, sourceBucket: record?.sourcePath?.[1] || sourceBucket, sourceKey, patch});
      }
    }
    for (const handle of options.deleteHandles || []) {
      const keyName = String(handle).toLowerCase();
      for (const bucket of ['users', 'queue', 'followingUsers', 'synthetic']) {
        const record = locate(bucket, keyName);
        if (record) changes.push({userKey: record.userKey, handle: record.handle || keyName, sourceBucket: record.sourcePath?.[1] || bucket, sourceKey: record.sourcePath?.[1] === 'synthetic' ? 'unreciprocatedTracker' : (record.sourcePath?.[0] || key), remove: true});
      }
    }
    const groups = new Map();
    for (const change of changes) {
      const origin = change.sourceKey || key;
      if (!groups.has(origin)) groups.set(origin, []);
      groups.get(origin).push(change);
    }
    for (const [origin, items] of groups) {
      for (let index = 0; index < items.length; index += 100) {
        await send({op: 'batch', module: moduleName, sourceKey: origin, changes: items.slice(index, index + 100)});
      }
    }
    cache.length = 0;
    windows.clear();
    await refreshSummaries();
    return {ok: true};
  }

  async function loadComplete(moduleName, legacyKey) {
    const records = [];
    let cursor = null;
    const seen = new Set();
    do {
      const result = await send({op: 'query', module: moduleName, limit: 100, cursor, filter: {tab: 'all'}});
      for (const record of result.page.records) {
        if (seen.has(record.userKey)) continue;
        seen.add(record.userKey);
        records.push(record);
      }
      cursor = result.page.nextCursor;
    } while (cursor);
    if (legacyKey) complete.add(legacyKey);
    return records;
  }

  return {
    boot, open, search, next, previous, invalidate, retry, bridgeWrite, loadComplete,
    window: moduleName => windows.get(moduleName) || null,
    summaries: () => ({...summaries}),
    isComplete: key => complete.has(key),
    markComplete: key => complete.add(key),
    calls: () => calls.slice(),
    cacheSize: () => cache.length
  };
}

export function assertRecordWritesOpen(blocked) {
  if (blocked) throw new Error('记录仍在迁移或迁移失败，档案未写入。请等待完成或点击重试。');
}

function stripBridgeMeta(value) {
  const copy = {...(value || {})};
  delete copy.__userKey;
  delete copy.__expectedHandle;
  delete copy.__sourceBucket;
  delete copy.__sourceKey;
  return copy;
}

export function createSelectionMemory() {
  const saved = new Map();
  function bucket(moduleName) {
    if (!saved.has(moduleName)) saved.set(moduleName, new Map());
    return saved.get(moduleName);
  }
  return {
    retain(moduleName, handle, user) {
      const key = String(handle || '').toLowerCase();
      if (!key || !user) return;
      bucket(moduleName).set(key, structuredClone(user));
    },
    forget(moduleName, handle) {
      bucket(moduleName).delete(String(handle || '').toLowerCase());
    },
    clear(moduleName) {
      bucket(moduleName).clear();
    },
    selected(moduleName, handles) {
      const rows = bucket(moduleName);
      return [...handles].map(handle => rows.get(String(handle).toLowerCase())).filter(Boolean);
    }
  };
}

function namedLists(value) {
  if (Array.isArray(value)) return [['users', value]];
  if (!value || typeof value !== 'object') return [];
  const named = ['users', 'queue', 'followingUsers', 'posts'].filter(name => Array.isArray(value[name])).map(name => [name, value[name]]);
  if (named.length) return named;
  return [['map', Object.values(value).filter(item => item && typeof item === 'object' && item.handle)]];
}

function arrayValues(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const arrays = Object.values(value).filter(Array.isArray).flat();
  if (arrays.length) return arrays;
  return Object.values(value).filter(item => item && typeof item === 'object' && item.handle);
}

function changedFields(original, next) {
  const patch = {};
  for (const [key, value] of Object.entries(next || {})) {
    if (JSON.stringify(original?.[key]) !== JSON.stringify(value)) patch[key] = value;
  }
  return patch;
}
