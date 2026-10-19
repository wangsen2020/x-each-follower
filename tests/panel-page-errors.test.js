import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLoadRegistry, applyModuleView} from '../dashboard-load-ui.js';

const panelSource = readFileSync(new URL('../panel.js', import.meta.url), 'utf8');

function loadPageAction() {
  const start = panelSource.indexOf('async function runRecordPageAction');
  const end = panelSource.indexOf('function reloadRecordModule');
  assert.ok(start > 0 && end > start);
  const factory = new Function(
    'loadRegistry',
    'applyModuleView',
    'document',
    'moduleRowCount',
    'refreshSidebarBadges',
    `${panelSource.slice(panelSource.indexOf('const RECORD_PAGE_PANEL'), end)}\nreturn {runRecordPageAction, RECORD_PAGE_PANEL, RECORD_PAGE_FAIL};`
  );
  return {factory, start, end};
}

function harness() {
  const registry = createLoadRegistry();
  const paints = [];
  const doc = {
    getElementById(id) {
      return {
        hidden: true,
        setAttribute() {},
        querySelector() {
          return {textContent: ''};
        },
        id
      };
    }
  };
  const {factory} = loadPageAction();
  const api = factory(
    registry,
    (document, moduleId, state, rowCount) => {
      paints.push({moduleId, status: state.status, error: state.error, rowCount});
      return applyModuleView(doc, moduleId, state, rowCount);
    },
    doc,
    () => 3,
    () => {}
  );
  return {registry, paints, ...api};
}

test('page search, previous, and next use the shared action wrapper', () => {
  const bare = panelSource.match(/recordPages\.(search|previous|next)\([^)]*\)\.then\(/g);
  assert.equal(bare, null);
  const calls = panelSource.match(/runRecordPageAction\('(fans|mutual|comments|unreciprocated)', \(\) => recordPages\.(search|previous|next)\(/g) || [];
  assert.equal(calls.length, 12);
  for (const moduleName of ['fans', 'mutual', 'comments', 'unreciprocated']) {
    for (const op of ['search', 'previous', 'next']) {
      assert.equal(calls.some(call => call.includes(`'${moduleName}'`) && call.includes(`.${op}(`)), true, `${moduleName} ${op}`);
    }
  }
  assert.match(panelSource, /function reloadRecordModule\(moduleName, render\) \{\s*if \(!\(recordPaging && recordPages\)\) \{ render\(\); return; \}\s*return runRecordPageAction\(moduleName,/);
  const retry = panelSource.slice(panelSource.indexOf('const retry = recordPaging && recordPages'));
  assert.match(retry, /monitor: \(\) => reloadRecordModule\('fans'/);
  assert.doesNotMatch(panelSource, /unhandledrejection/);
  assert.doesNotMatch(panelSource.slice(panelSource.indexOf('async function runRecordPageAction'), panelSource.indexOf('function reloadRecordModule')), /monitorStatus\(/);
});

test('a rejected page action shows the module error and keeps the current page', async () => {
  const {runRecordPageAction, registry, paints} = harness();
  let rendered = 0;
  const error = new Error('transaction aborted');
  await runRecordPageAction('fans', async () => { throw error; }, () => { rendered += 1; });
  assert.equal(rendered, 0);
  assert.equal(registry.get('monitor').status, 'error');
  assert.equal(registry.get('monitor').error, '关注与粉丝记录加载失败：transaction aborted');
  assert.equal(paints.at(-1).moduleId, 'monitor');
  assert.equal(paints.at(-1).rowCount, 3);
  assert.equal(registry.get('mutual').status, 'loading');
});

test('a successful page action clears the error and renders once', async () => {
  const {runRecordPageAction, registry, paints} = harness();
  registry.fail('comments', '评论追踪记录加载失败：transaction aborted');
  let rendered = 0;
  await runRecordPageAction('comments', async () => ({records: [{handle: 'kept'}]}), () => { rendered += 1; });
  assert.equal(rendered, 1);
  assert.equal(registry.get('comments').status, 'ready');
  assert.equal(registry.get('comments').error, '');
  assert.equal(paints.at(-1).moduleId, 'comments');
  assert.equal(paints.at(-1).status, 'ready');
});

test('a cancelled page action does not render or replace the last error', async () => {
  const {runRecordPageAction, registry} = harness();
  registry.fail('mutual', '互关追踪记录加载失败：transaction aborted');
  let rendered = 0;
  await runRecordPageAction('mutual', async () => null, () => { rendered += 1; });
  assert.equal(rendered, 0);
  assert.equal(registry.get('mutual').status, 'error');
  assert.equal(registry.get('mutual').error, '互关追踪记录加载失败：transaction aborted');
});
