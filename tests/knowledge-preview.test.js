import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('knowledge browser acceptance loads every production panel stylesheet in production order',()=>{
  const production=readFileSync(new URL('../src/panel.html',import.meta.url),'utf8');
  const preview=readFileSync(new URL('./fixtures/knowledge-learning-preview.html',import.meta.url),'utf8');
  const styles=html=>[...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(m=>m[1].split('/').at(-1));
  assert.ok(styles(production).length>=5);
  assert.deepEqual(styles(preview),styles(production),'Missing global CSS can hide layout regressions');
});
