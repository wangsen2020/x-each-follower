import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildGrokBotInstruction} from '../src/features/grok/grok-bot-instruction.js';
test('tutorial pasteable Worker matches current deployment source and all thirteen screenshot assets exist',async()=>{
  const source=await readFile(new URL('../deploy/grok-bot-relay/worker.js',import.meta.url),'utf8');
  const bundle=await readFile(new URL('../src/assets/grok-bot-relay-worker.txt',import.meta.url),'utf8');
  assert.ok(bundle.startsWith('// source-sha256: '+createHash('sha256').update(source).digest('hex')),'Run npm run guide:sync after changing the Worker');
  const guide=await readFile(new URL('../src/entries/tutorial/grok-bot-guide.js',import.meta.url),'utf8');
  const images=[...guide.matchAll(/'((?:0\d|1[0-3])-[^']+\.png)'/g)].map(m=>m[1]);assert.equal(images.length,13);
  await Promise.all(images.map(name=>access(new URL('../src/assets/grok-bot-tutorial/'+name,import.meta.url))));
});
test('fixed Bot instruction preserves the validated callback contract and pins one callback address',()=>{
  const instruction=buildGrokBotInstruction('https://relay.example');
  assert.match(instruction,/jobId、text、callback、callbackToken/);assert.match(instruction,/https:\/\/relay\.example\/v1\/callback/);assert.match(instruction,/"token":callbackToken/);assert.match(instruction,/不重新生成/);
});
