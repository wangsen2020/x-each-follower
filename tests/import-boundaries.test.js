import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {init, parse} from 'es-module-lexer';

await init;

const root = new URL('../', import.meta.url);

async function source(name) {
  return readFile(new URL(name, root), 'utf8');
}

function staticImports(text) {
  return parse(text)[0].map(entry => entry.specifier).filter(specifier => typeof specifier === 'string');
}

test('boundary traversal recognizes multiline imports, reexports and dynamic imports', () => {
  assert.deepEqual(staticImports(`import {\n value\n} from './one.js';
export { value } from './two.js';
import('./three.js');
// import './comment-only.js';
const text = "import './string-only.js'";`), ['./one.js', './two.js', './three.js']);
});

async function importClosure(entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const text = await source(name);
    for (const spec of staticImports(text)) {
      assert.ok(spec.startsWith('.'), `unexpected non-relative runtime import: ${name} -> ${spec}`);
      const next = new URL(spec, new URL(name, root));
      assert.ok(next.href.startsWith(root.href), `import escapes repository: ${spec}`);
      const relative = decodeURIComponent(next.pathname.slice(root.pathname.length));
      pending.push(relative);
    }
  }
  return seen;
}

test('record runtime no longer imports panel data', async () => {
  const runtime = await source('record-runtime.js');
  assert.match(runtime, /from '\.\/relationship-rules\.js'/);
  assert.doesNotMatch(runtime, /panel-data\.js/);
  const closure = await importClosure('record-runtime.js');
  assert.equal(closure.has('panel-data.js'), false);
  assert.equal(closure.has('panel.js'), false);
});

test('quote tags no longer import the Grok workflow', async () => {
  const tags = await source('quote-tags.js');
  assert.match(tags, /from '\.\/quote-text\.js'/);
  assert.doesNotMatch(tags, /grok-comment\.js/);
  for (const entry of ['quote-tags.js', 'follow-queue-store.js']) {
    const closure = await importClosure(entry);
    assert.equal(closure.has('grok-comment.js'), false, entry);
    assert.equal(closure.has('grok-session-manager.js'), false, entry);
    assert.equal(closure.has('grok-verification.js'), false, entry);
  }
});

test('extracted modules stay pure and at the repository root', async () => {
  for (const name of ['relationship-rules.js', 'quote-text.js']) {
    const text = await source(name);
    assert.equal(staticImports(text).length, 0, name);
    assert.doesNotMatch(text, /\b(chrome|indexedDB|document|window|fetch|localStorage)\b/);
    assert.equal(new URL(name, root).pathname.includes('/features/'), false);
  }
});
