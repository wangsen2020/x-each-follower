import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';

test('local guide ships all six referenced screenshots and resolves its step anchors',async()=>{
  const html=await readFile(new URL('../src/grok-local-guide.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../src/entries/tutorial/grok-local-guide.js',import.meta.url),'utf8');
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  for(const [,anchor] of html.matchAll(/href="#([^"]+)"/g))assert.ok(ids.has(anchor),'Missing guide section '+anchor);
  const names=[...script.matchAll(/'((?:0[1-6])-[^']+\.png)'/g)].map(m=>m[1]);assert.equal(names.length,6);
  for(const name of names){const image=await readFile(new URL('../src/assets/grok-local-tutorial/'+name,import.meta.url));assert.equal(image.subarray(1,4).toString(),'PNG');assert.ok(image.length>20000,'Screenshot must contain rendered page: '+name);}
  const settings=await readFile(new URL('../src/entries/panel/components/GrokLocalSettings.vue',import.meta.url),'utf8');
  for(const [,anchor] of settings.matchAll(/tutorialUrl\+'#([^']+)'/g))assert.ok(ids.has(anchor),'Broken settings deep link '+anchor);
  await access(new URL('../src/grok-bot-guide.html',import.meta.url));
});
