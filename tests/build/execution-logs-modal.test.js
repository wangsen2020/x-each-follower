import test from 'node:test';
import assert from 'node:assert/strict';
import { useExecutionLogs } from '../../src/entries/panel/composables/useExecutionLogs.js';

test('useExecutionLogs initializes with robust default state and computed titles', () => {
  const c = useExecutionLogs();
  assert.equal(c.isOpen.value, false);
  assert.equal(c.status.value, 'ready');
  assert.equal(c.entries.value.length, 0);
  assert.equal(c.total.value, 0);

  // Default scope
  c.currentScope.value = 'autoFollow';
  assert.equal(c.title.value, '关注队列 · 执行日志');
  assert.equal(c.emptyTitle.value, '暂无执行日志记录');

  // Fans scope (sub-tabs: scan, followBack, all)
  c.currentScope.value = 'fans';
  c.fansSubTab.value = 'scan';
  assert.equal(c.title.value, '粉丝管理 · 粉丝扫描日志');
  assert.equal(c.emptyTitle.value, '暂无粉丝扫描日志');

  c.fansSubTab.value = 'followBack';
  assert.equal(c.title.value, '粉丝管理 · 队列回关日志');
  assert.equal(c.emptyTitle.value, '暂无队列回关日志');

  c.fansSubTab.value = 'all';
  assert.equal(c.title.value, '粉丝管理 · 全部执行日志');
  assert.equal(c.emptyTitle.value, '暂无粉丝管理执行日志');

  // Monitor scope
  c.currentScope.value = 'monitor';
  c.fansSubTab.value = 'scan';
  assert.equal(c.title.value, '粉丝管理 · 粉丝扫描日志');

  // Unreciprocated scope
  c.currentScope.value = 'unreciprocated';
  assert.equal(c.title.value, '回关监测 · 定时检测与取关日志');
  assert.equal(c.emptyTitle.value, '暂无回关监测日志');

  // Comment scope
  c.currentScope.value = 'comment';
  assert.equal(c.title.value, '评论追踪 · 执行日志');

  // Mutual scope
  c.currentScope.value = 'mutual';
  assert.equal(c.title.value, '互关追踪 · 执行日志');
});

test('useExecutionLogs token generation prevents expired async race response', async () => {
  const c = useExecutionLogs();

  // Mock chrome.runtime.sendMessage with delay
  let delayedResolve;
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      sendMessage: ({ cursor }) => {
        if (cursor === 'first-query') {
          return new Promise(resolve => {
            delayedResolve = resolve;
          });
        }
        return Promise.resolve({ ok: true, entries: [{ id: 'fast-second', scope: 'fans' }], total: 1 });
      }
    }
  };

  try {
    c.isOpen.value = true;
    c.currentScope.value = 'fans';

    // Start first query
    const firstToken = c.logPager.begin();
    assert.equal(c.logPager.current(firstToken), true);

    // Fast-forward user actions: user clicks reset / switches scope
    const secondToken = c.logPager.begin();
    assert.equal(c.logPager.current(firstToken), false);
    assert.equal(c.logPager.current(secondToken), true);

    // Note page for firstToken should fail
    const noted = c.logPager.notePage(firstToken, { ok: true, entries: [{ id: 'stale' }] });
    assert.equal(noted, false, 'Expired generation token must be rejected');

    // Note page for current secondToken should succeed
    const noted2 = c.logPager.notePage(secondToken, { ok: true, nextCursor: 'page-2' });
    assert.equal(noted2, true, 'Current token must be accepted');
    assert.equal(c.logPager.canNext(), true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('useExecutionLogs refreshIfOpen respects target scope and open state', async () => {
  const c = useExecutionLogs();
  let loadCalls = 0;
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => {
        loadCalls++;
        return { ok: true, entries: [], total: 0 };
      }
    }
  };

  try {
    // Closed modal should not load
    c.isOpen.value = false;
    c.currentScope.value = 'fans';
    await c.refreshIfOpen('fans');
    assert.equal(loadCalls, 0);

    // Open modal with mismatched scope should not load
    c.isOpen.value = true;
    await c.refreshIfOpen('comment');
    assert.equal(loadCalls, 0);

    // Open modal with matching scope should load
    await c.refreshIfOpen('fans');
    assert.equal(loadCalls, 1);

    // Monitor scope matches fans scope
    await c.refreshIfOpen('monitor');
    assert.equal(loadCalls, 2);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('useExecutionLogs fansSubTab cleanly isolates scan logs from queue follow-back logs', () => {
  const c = useExecutionLogs();
  c.currentScope.value = 'fans';

  c.rawEntries.value = [
    { id: 'scan-1', scope: 'fans', origin: 'monitorLogs', summary: 'scanned 50' },
    { id: 'queue-1', scope: 'queue', sources: [{ module: 'fans' }], detail: 'followed' },
    { id: 'scan-2', scope: 'monitor', summary: 'scanned 30' },
    { id: 'queue-2', scope: 'queue', sources: [{ module: 'fans' }], detail: 'skipped' },
    { id: 'unrelated-queue', scope: 'queue', sources: [{ module: 'comments' }], detail: 'followed' },
    { id: 'ver-1', scope: 'verification', detail: 'cf challenge' }
  ];

  // 1. scan tab: only scan and verification logs
  c.setFansSubTab('scan');
  assert.deepEqual(c.entries.value.map(e => e.id), ['scan-1', 'scan-2', 'ver-1']);
  assert.equal(c.totalBadgeText.value, '0 条记录');

  // 2. followBack tab: only queue and verification logs
  c.setFansSubTab('followBack');
  assert.deepEqual(c.entries.value.map(e => e.id), ['queue-1', 'queue-2', 'ver-1']);
  assert.equal(c.totalBadgeText.value, '本页 3 条记录');

  c.setFansSubTab('all');
  assert.equal(c.fansSubTab.value, 'followBack', 'Unsupported aggregate tab must not imply an incomplete combined query');
});

test('clearLogs targets the current module and never clears fan scan records from queue follow-back tab', async () => {
  const originalChrome = globalThis.chrome;
  const originalWindow = globalThis.window;
  const requests = [];
  globalThis.chrome = {runtime: {sendMessage: async message => {
    requests.push(message);
    return message.cmd === 'queryExecutionLogs' ? {ok: true, entries: [], total: 0} : {ok: true};
  }}};
  globalThis.window = {confirm: () => true, alert: () => {}};
  try {
    const c = useExecutionLogs();
    await c.open('comment');
    await c.clearLogs();
    assert.deepEqual(requests.filter(r => r.cmd === 'clearExecutionLogs').map(r => r.scope), ['comment']);
    await c.open('fans');
    await c.setFansSubTab('followBack');
    const before = requests.filter(r => r.cmd === 'clearExecutionLogs').length;
    await c.clearLogs();
    assert.equal(requests.filter(r => r.cmd === 'clearExecutionLogs').length, before);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.window = originalWindow;
  }
});
