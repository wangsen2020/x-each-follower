import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('execution logs remain reachable from all source pages and the queue',()=>{
 const html=['MonitorSection','CandidatesSection','CommentsSection'].map(name=>readFileSync(new URL(`../src/entries/panel/pages/${name}.vue`,import.meta.url),'utf8')).join('\n');
 const panel=readFileSync(new URL('../src/entries/panel/panel.js',import.meta.url),'utf8');
 for(const id of ['openFollowLogs','openMutualLogs','openCommentLogs']) {
  assert.ok(html.includes('id="'+id+'"'));
  assert.ok(panel.includes("$('"+id+"')?.addEventListener('click'"));
 }
 const queue=readFileSync(new URL('../src/entries/panel/follow-queue-panel.js',import.meta.url),'utf8');
 const vueEntry=readFileSync(new URL('../src/entries/panel/main.js',import.meta.url),'utf8');
 assert.ok(queue.includes("new CustomEvent('open-execution-logs', {bubbles:true, detail:{scope:'queue'}})"));
 assert.ok(vueEntry.includes("document.addEventListener('open-execution-logs'"));
 assert.equal(panel.includes("document.addEventListener('open-execution-logs'"),false);
 assert.equal(html.includes('id="commentBatchAddToQueue"'),false);
});

test('source pages omit redundant manual queue controls and handlers',()=>{
 const html=readFileSync(new URL('../src/panel.html',import.meta.url),'utf8');
 const panel=readFileSync(new URL('../src/entries/panel/panel.js',import.meta.url),'utf8');
 const settings=readFileSync(new URL('../src/entries/panel/components/SettingsDrawer.vue',import.meta.url),'utf8');
 for(const token of ['commentBatchAddToQueue','processFollowBack','加入关注队列']) {
  assert.equal(html.includes(token),false);assert.equal(panel.includes(token),false);
 }
 assert.ok(settings.includes('id="monitorAutoEnqueue"'));
 assert.ok(settings.includes('id="runMonitorScanNow"'));
 assert.equal(html.includes('id="monitorAutoEnqueue"'),false);
});
