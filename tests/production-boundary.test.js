import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('shipped extension has no local development bridge or loopback permissions',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
 assert.ok(manifest.host_permissions.every(p=>! /localhost|127\.0\.0\.1|\[::1\]/.test(p)));
 for(const file of ['panel.js','background.js']) {
  const source=await readFile(new URL('../'+file,import.meta.url),'utf8');
  assert.doesNotMatch(source,/pollGrokDevBridge|https?:\/\/(?:localhost|127\.0\.0\.1)/);
 }
});
