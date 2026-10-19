import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('execution logs remain reachable from all source pages and the queue',()=>{
 const html=readFileSync(new URL('../panel.html',import.meta.url),'utf8');
 const panel=readFileSync(new URL('../panel.js',import.meta.url),'utf8');
 for(const id of ['openFollowLogs','openMutualLogs','openCommentLogs']) {
  assert.ok(html.includes('id="'+id+'"'));
  assert.ok(panel.includes("$('"+id+"')?.addEventListener('click'"));
 }
 const queue=readFileSync(new URL('../follow-queue-panel.js',import.meta.url),'utf8');
 assert.ok(queue.includes("new CustomEvent('open-execution-logs', {bubbles:true})"));
 assert.ok(panel.includes("document.addEventListener('open-execution-logs'"));
 assert.equal(html.includes('id="commentBatchAddToQueue"'),false);
});
