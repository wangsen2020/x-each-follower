import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  createLoadRegistry,
  moduleView,
  badgePresentation,
  applyModuleView,
  migrationProgressView,
  replayDiagnosticText,
  paintMigrationProgress,
  hideMigrationProgress,
  recoveryModuleForKey,
  modulesAwaitingRecovery,
  preserveReadError,
  settleRecoveredModule
} from '../src/entries/panel/dashboard-load-ui.js';

test('migration display separates journal progress from baseline counts and exposes a blocked step', () => {
  const replay = {seq: 5, completed: 4, total: 9, step: 'read-entry', stepElapsedMs: 12345,
    elapsedMs: 15000, steps: {'read-entry': {count: 4, totalMs: 100, lastMs: 25, maxMs: 40}},
    recent: [{seq: 4, step: 'read-entry', ms: 25}]};
  const view = migrationProgressView({stage: '正在回放增量记录', completed: 17076, total: 17076, replay});
  assert.equal(view.completed, 4);
  assert.equal(view.total, 9);
  assert.match(view.label, /增量日志 4\/9/);
  assert.match(view.label, /基线记录 17076\/17076/);
  const text = replayDiagnosticText(replay);
  assert.match(text, /当前序号：5/);
  assert.match(text, /读取增量记录/);
  assert.match(text, /12.35 秒/);
  assert.match(text, /尚未返回/);
  assert.match(text, /0.10 秒 \/ 0.03 秒 \/ 0.04 秒 \/ 4/);
  assert.match(text, /#4/);
  const unknown = migrationProgressView({stage: '回放', completed: 17076, total: 17076, replay: {...replay, total: null}});
  assert.equal(unknown.total, null);
  assert.match(unknown.label, /读取中/);
});

const panelHtml = readFileSync(new URL('../src/panel.html', import.meta.url), 'utf8');
const pageMarkup = ['MonitorSection', 'CandidatesSection', 'CommentsSection', 'FollowQueueSection', 'UnreciprocatedSection']
  .map(name => readFileSync(new URL(`../src/entries/panel/pages/${name}.vue`, import.meta.url), 'utf8')).join('\n');
const vueEntry = readFileSync(new URL('../src/entries/panel/main.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/entries/panel/panel.js', import.meta.url), 'utf8');
const loadCss = readFileSync(new URL('../src/entries/panel/styles/dashboard-load.css', import.meta.url), 'utf8');

function element(id) {
  const attrs = new Map();
  const children = [];
  const node = {
    id,
    hidden: false,
    nodeType: 1,
    className: '',
    ownerDocument: null,
    get children() { return children.filter(child => child.nodeType === 1); },
    get textContent() { return children.map(child => child.textContent || '').join(''); },
    set textContent(value) { children.splice(0, children.length, {nodeType: 3, textContent: String(value)}); },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    append(...nodes) { children.push(...nodes); },
    replaceChildren(...nodes) { children.splice(0, children.length, ...nodes); },
    querySelector(selector) {
      const className = selector.startsWith('.') ? selector.slice(1) : '';
      const walk = list => {
        for (const child of list) {
          if (child.className?.split(/\s+/).includes(className)) return child;
          const nested = child.children && walk(child.children);
          if (nested) return nested;
        }
        return null;
      };
      return walk(children);
    }
  };
  return node;
}

function fakeDocument() {
  const nodes = new Map();
  for (const id of ['monitorLoad', 'monitorLoadError', 'mutualLoad', 'mutualLoadError', 'commentsLoad', 'commentsLoadError']) {
    const node = element(id);
    const text = element('');
    text.className = 'dash-load-text';
    text.textContent = 'placeholder';
    node.append(text);
    nodes.set(id, node);
  }
  return {getElementById: id => nodes.get(id) || null, nodes};
}

test('slow read keeps the skeleton and withholds the empty state', async () => {
  const registry = createLoadRegistry();
  let release;
  const read = new Promise(resolve => { release = resolve; });
  const pending = moduleView(registry.get('monitor'), {rowCount: 0});
  assert.equal(pending.showSkeleton, true);
  assert.equal(pending.showEmpty, false);
  assert.deepEqual(badgePresentation(registry.get('monitor'), 0), {mode: 'loading'});
  const doc = fakeDocument();
  applyModuleView(doc, 'monitor', registry.get('monitor'), 0);
  assert.equal(doc.nodes.get('monitorLoad').hidden, false);
  assert.equal(doc.nodes.get('monitorLoad').textContent.includes('正在加载粉丝跟进'), true);
  const done = (async () => {
    await read;
    registry.succeed('monitor');
    return moduleView(registry.get('monitor'), {rowCount: 0});
  })();
  assert.equal(registry.get('monitor').status, 'loading');
  release();
  const ready = await done;
  assert.equal(ready.showSkeleton, false);
  assert.equal(ready.showEmpty, true);
  assert.equal(ready.allowList, true);
});

test('failed read shows an explicit error and retry can return to loading', () => {
  const registry = createLoadRegistry();
  registry.fail('comments', '评论追踪记录加载失败：磁盘忙');
  const failed = moduleView(registry.get('comments'), {rowCount: 0});
  assert.equal(failed.showError, true);
  assert.equal(failed.showEmpty, false);
  assert.equal(failed.allowList, false);
  assert.equal(failed.errorText, '评论追踪记录加载失败：磁盘忙');
  assert.deepEqual(badgePresentation(registry.get('comments'), 0), {mode: 'error'});
  const doc = fakeDocument();
  applyModuleView(doc, 'comments', registry.get('comments'), 0);
  registry.begin('comments');
  const again = applyModuleView(doc, 'comments', registry.get('comments'), 0);
  assert.equal(again.showSkeleton, true);
  assert.equal(again.showError, false);
  assert.equal(doc.nodes.get('commentsLoad').hidden, false);
});

test('a successful empty read clears loading and a later refresh keeps rows', () => {
  const registry = createLoadRegistry();
  registry.succeed('mutual');
  const empty = moduleView(registry.get('mutual'), {rowCount: 0});
  assert.equal(empty.showEmpty, true);
  assert.equal(empty.showSkeleton, false);
  assert.deepEqual(badgePresentation(registry.get('mutual'), 0), {mode: 'count', count: 0});
  registry.begin('mutual');
  const refreshing = moduleView(registry.get('mutual'), {rowCount: 4});
  assert.equal(refreshing.showRefresh, true);
  assert.equal(refreshing.showSkeleton, false);
  assert.equal(refreshing.keepRows, true);
  assert.equal(refreshing.showEmpty, false);
  assert.deepEqual(badgePresentation(registry.get('mutual'), 4), {mode: 'count', count: 4});
});

test('migration progress uses the supplied stage and counts and never a percent', () => {
  const stageOnly = migrationProgressView({stage: ' 核对旧档案 '});
  assert.equal(stageOnly.label, '核对旧档案');
  assert.equal(stageOnly.percent, null);
  assert.equal(stageOnly.label.includes('%'), false);
  const counted = migrationProgressView({stage: '搬移记录', completed: 2, total: 5});
  assert.equal(counted.label, '搬移记录 2/5');
  assert.equal(counted.percent, null);
  const doc = fakeDocument();
  const host = element('migrationHost');
  host.ownerDocument = {createElement: tag => element(tag)};
  const painted = paintMigrationProgress(host, {stage: '搬移记录', completed: 2, total: 5});
  assert.equal(painted.percent, null);
  assert.equal(host.textContent.includes('%'), false);
  assert.equal(host.textContent.includes('2/5'), true);
  assert.equal(host.children.some(child => child.children.some(node => node.id === 'progress' || node.className === '')), true);
  assert.throws(() => migrationProgressView({stage: '搬移记录', completed: 1}), /together/);
});

test('completed record migration hides its progress host even when the host is absent', () => {
  const host = {hidden: false};
  hideMigrationProgress({getElementById: id => id === 'recordMigration' ? host : null});
  assert.equal(host.hidden, true);
  assert.doesNotThrow(() => hideMigrationProgress({getElementById: () => null}));
});

test('Vue page templates expose loading state before the business controller starts', () => {
  assert.ok(panelHtml.includes('id="panel-vue-root"'));
  assert.ok(vueEntry.indexOf('app.mount(container)') < vueEntry.search(/import\(['"]\.\/panel\.js['"]\)/));
  const skeletonAt = pageMarkup.indexOf('id="monitorLoad"');
  assert.ok(skeletonAt > 0);
  for (const id of ['mutualLoad', 'commentsLoad', 'followQueueLoad', 'unreciprocatedLoad']) {
    assert.ok(pageMarkup.includes(`id="${id}"`));
  }
  assert.match(panelHtml, /id="queueCount"[^>]*nav-count-loading/);
  assert.doesNotMatch(panelHtml, /id="queueCount"[^>]*>\s*0\s*</);
  assert.doesNotMatch(panelHtml, /id="mutualNetworkCount"[^>]*>\s*0\s*</);
  assert.doesNotMatch(panelHtml, /id="commentTrackingCount"[^>]*>\s*0\s*</);
  assert.doesNotMatch(panelHtml, /id="unreciprocatedCount"[^>]*>\s*0\s*</);
  assert.match(pageMarkup, /id="monitorEmpty"[^>]*hidden/);
  assert.match(pageMarkup, /id="mutualEmpty"[^>]*hidden/);
  assert.match(pageMarkup, /id="commentUsersEmpty"[^>]*hidden/);
  assert.match(loadCss, /display:\s*flex/);
  assert.match(loadCss, /margin:\s*10px/);
  assert.match(loadCss, /#245b45/);
  assert.match(loadCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(loadCss, /\.nav-tab\.active \.nav-count \.dash-spinner[\s\S]*#e9f2e9/);
  assert.equal(loadCss.includes('#102b22'), false);
  assert.ok(pageMarkup.indexOf('id="openFollowLogs"') < pageMarkup.indexOf('id="monitorLoad"'));
  assert.ok(pageMarkup.indexOf('id="selectionBar"') < pageMarkup.indexOf('id="monitorLoad"'));
  assert.ok(pageMarkup.indexOf('id="openMutualLogs"') < pageMarkup.indexOf('id="mutualLoad"'));
  assert.ok(pageMarkup.indexOf('class="mutual-subbar"') < pageMarkup.indexOf('id="mutualLoad"'));
  assert.ok(pageMarkup.indexOf('id="openCommentLogs"') < pageMarkup.indexOf('id="commentsLoad"'));
  assert.ok(pageMarkup.indexOf('class="comments-toolbar"') < pageMarkup.indexOf('id="commentsLoad"'));
  assert.ok(pageMarkup.indexOf('id="openUnreciprocatedLogs"') < pageMarkup.indexOf('id="unreciprocatedLoad"'));
  assert.match(pageMarkup, /id="followingCount"[^>]*>…</);
  assert.match(pageMarkup, /id="followBackCount"[^>]*>…</);
  assert.match(pageMarkup, /id="notMutualCount"[^>]*>…</);
  assert.doesNotMatch(pageMarkup, /id="followingCount"[^>]*>0</);
});

test('startup keeps the tab the user selected while reads are still running', () => {
  assert.equal(panelSource.includes('startupTab'), false);
  assert.equal(panelSource.includes("setTab('monitor')"), false);
  const finished = panelSource.indexOf('await loadUnreciprocatedModule()');
  assert.equal(panelSource.slice(finished).includes("setTab('"), false);
});

test('an absent backup recovery does not clear an earlier module read error', () => {
  const registry = createLoadRegistry();
  registry.fail('monitor', '关注与粉丝记录加载失败：boom');
  assert.equal(preserveReadError(registry.get('monitor')), true);
  assert.equal(settleRecoveredModule(registry, 'monitor'), false);
  assert.equal(registry.get('monitor').status, 'error');
  assert.equal(registry.get('monitor').error, '关注与粉丝记录加载失败：boom');
  const view = moduleView(registry.get('monitor'), {rowCount: 0});
  assert.equal(view.showError, true);
  assert.equal(view.showEmpty, false);
  registry.begin('monitor');
  registry.succeed('monitor');
  assert.equal(registry.get('monitor').status, 'ready');
  assert.equal(registry.get('monitor').error, '');
  assert.match(panelSource, /preserveReadError\(loadRegistry\.get\(moduleId\)\)/);
  assert.match(panelSource, /settleRecoveredModule\(loadRegistry, moduleId\)/);
});

test('backup recovery stays loading until the missing key resolves, including an absent backup', () => {
  assert.equal(recoveryModuleForKey('commentTracking'), 'comments');
  assert.deepEqual(modulesAwaitingRecovery({commentTracking: false, monitor: true, rows: false}), ['comments', 'monitor']);
  assert.deepEqual(modulesAwaitingRecovery({commentTracking: true}), []);
  const registry = createLoadRegistry();
  const doc = fakeDocument();
  registry.begin('comments', 'recover');
  const pending = applyModuleView(doc, 'comments', registry.get('comments'), 0);
  assert.equal(pending.showSkeleton, true);
  assert.equal(pending.showEmpty, false);
  assert.match(doc.nodes.get('commentsLoad').textContent, /本地备份恢复评论追踪/);
  registry.succeed('comments');
  const absent = moduleView(registry.get('comments'), {rowCount: 0});
  assert.equal(absent.showEmpty, true);
  assert.equal(absent.showSkeleton, false);
  registry.begin('comments', 'recover');
  registry.fail('comments', '本地备份恢复失败：读取中断');
  const failed = moduleView(registry.get('comments'), {rowCount: 0});
  assert.equal(failed.showError, true);
  assert.equal(failed.showEmpty, false);
});

test('startup loads the visible module page and migration progress', () => {
  const boot = panelSource.indexOf('recordBootPromise = bootRecordDashboard()');
  assert.ok(boot > 0);
  assert.match(panelSource.slice(boot), /await recordBootPromise/);
  assert.equal(panelSource.slice(boot).includes('await loadUnreciprocatedModule()'), false);
  assert.match(panelSource, /paintMigrationProgress/);
  assert.match(panelSource, /createPanelPages/);
  assert.match(panelSource, /if \(!\w+View\.allowList\) return;/);
});
