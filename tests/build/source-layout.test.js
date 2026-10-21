import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, existsSync, readFileSync} from 'node:fs';
import {RUNTIME_RESOURCES} from '../../tools/runtime-resources.mjs';

const root = new URL('../../', import.meta.url);
test('all application source and extension metadata stay under src', () => {
  const loose = readdirSync(root).filter(name => /\.(js|css|html|png|svg|webp)$/.test(name) && name !== 'vite.config.js');
  assert.deepEqual(loose, []);
  assert.equal(existsSync(new URL('manifest.json',root)),false);
  for (const [output, source] of Object.entries(RUNTIME_RESOURCES)) {
    assert.equal(output.includes('/'),false);
    assert.ok(source.startsWith('src/') || source === 'THIRD_PARTY_NOTICES.txt');
    assert.ok(existsSync(new URL(source,root)),source);
  }
});

test('build entrypoints use src while Chrome filenames remain stable', () => {
  const config=readFileSync(new URL('vite.config.js',root),'utf8');
  assert.ok(config.includes("'src/panel.html'"));
  assert.ok(config.includes("'src/entries/background/background.js'"));
  const manifest=JSON.parse(readFileSync(new URL('src/manifest.json',root),'utf8'));
  assert.equal(manifest.background.service_worker,'background.js');
  for (const entry of manifest.content_scripts) for (const name of [...entry.js||[],...entry.css||[]]) assert.ok(RUNTIME_RESOURCES[name],name);
});
