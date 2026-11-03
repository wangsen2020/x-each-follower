import test from 'node:test';
import assert from 'node:assert/strict';
import {createBatchResultReporter,createResultReporter,createTaskProgressReporter} from '../src/entries/panel/result-notices.js';

test('result polling is deduplicated while explicit reopens get independent identities',()=>{
  const notices=[];let time=100;
  const report=createResultReporter({publish:n=>notices.push(n),now:()=>++time});
  const notice={id:'review:1',title:'完成',items:['@one']};
  assert.equal(report(notice),true);assert.equal(report(notice),false);
  assert.equal(report(notice,{force:true}),true);
  notice.items.push('changed');assert.deepEqual(notices[0].items,['@one']);
  assert.notEqual(notices[0].id,notices[1].id);assert.ok(notices[0].createdAt<notices[1].createdAt);
});

test('historical completed batches stay silent; active transitions publish exactly once',()=>{
  const notices=[],report=createBatchResultReporter({publish:n=>notices.push(n)});
  const notice={id:'batch:1',title:'完成',items:[]};
  report({id:'1',stage:'completed'},notice);assert.equal(notices.length,0);
  report({id:'1',stage:'running'},notice);report({id:'1',stage:'completed'},notice);
  report({id:'1',stage:'completed'},notice);assert.equal(notices.length,1);
  report({id:'1',stage:'completed'},notice,{explicit:true});assert.equal(notices.length,2);
});

test('paused and failed results remain discoverable without repeating on polling',()=>{
  const notices=[],report=createBatchResultReporter({publish:n=>notices.push(n)});
  for(const stage of ['paused','paused','failed','failed'])report({id:'2',stage},{id:'batch:2',title:stage,note:'连接失败'});
  assert.deepEqual(notices.map(n=>n.title),['paused','failed']);
  report({id:'3',stage:'cancelled'},{id:'batch:3',title:'取消'});assert.equal(notices.length,2);
});

test('live task polls update one stable card, and completion stays available without republishing after dismissal',()=>{
  const notices=[],report=createTaskProgressReporter({publish:n=>notices.push(n),now:()=>100});
  const batch={id:'one',stage:'running'},notice={id:'verification:one',title:'核验',progress:{stage:'running',done:0,total:3}};
  report(batch,notice);assert.equal(report(batch,notice),false);
  notice.progress.done=1;report(batch,notice);batch.stage='completed';notice.progress.stage='completed';notice.progress.done=3;report(batch,notice);
  assert.equal(notices.length,3);assert.equal(new Set(notices.map(n=>n.id)).size,1);assert.equal(notices[0].progress.done,0);
  assert.equal(report(batch,notice),false);assert.equal(report(batch,notice,{explicit:true}),true);assert.equal(notices.at(-1).id,notices[0].id);
});
