import test from 'node:test';
import assert from 'node:assert/strict';
import {appendExecutionLog,selectExecutionLogs,normalizeQueueExecutionLog} from '../execution-log.js';

test('queue events distinguish task start and cycle completion from failure',()=>{
  assert.equal(normalizeQueueExecutionLog({type:'job-start'}).result,'started');
  assert.equal(normalizeQueueExecutionLog({type:'run-complete',summary:'新增关注 5'}).result,'completed');
  const legacy=normalizeQueueExecutionLog({type:'job-start',result:'job-start',detail:'job-start'});
  assert.equal(legacy.detail,'开始访问主页并读取账号资料');
  assert.equal(legacy.posts,undefined);
  assert.equal(legacy.source,'unknown');
  const existing=normalizeQueueExecutionLog({type:'job-complete',state:'followed',alreadyFollowing:true,detail:'job-complete'});
  assert.equal(existing.result,'already_following');
  assert.match(existing.detail,/未重复关注/);
});

test('queue logs retain scans and independent quote failure after successful follow',()=>{
  const evaluation={status:'failed',text:'评价正文',originalPostUrl:'https://x.com/a/status/123',reason:'生成失败'};
  const log=normalizeQueueExecutionLog({type:'job-complete',state:'followed',manual:true},
    {handle:'alice',sources:[{module:'comments'}],evaluations:[evaluation],followResult:{succeeded:true}},
    {posts:[{text:'原文',url:'https://x.com/a/status/123'}],scanned:true,scrollRounds:3,dwellSeconds:15});
  assert.equal(log.result,'followed');
  assert.equal(log.source,'manual');
  assert.equal(log.handle,'alice');
  assert.equal(log.evaluations[0].reason,'生成失败');
  assert.equal(log.posts.length,1);
  assert.equal(log.scrollRounds,3);
  assert.equal(selectExecutionLogs([log],'comment').length,1);
  assert.equal(selectExecutionLogs([log],'mutual').length,0);
});
test('concurrent worker and panel append operations preserve both records and old history', async()=>{
  let saved=[{id:'old',scope:'mutual',at:'2026-10-16T00:00:00Z'}];
  const storage={get:async()=>({autoFollowLogs:structuredClone(saved)}),set:async data=>{saved=structuredClone(data.autoFollowLogs)}};
  await Promise.all([appendExecutionLog({scope:'comment',detail:'alarm'},storage),appendExecutionLog({scope:'mutual',detail:'panel'},storage)]);
  assert.equal(saved.length,3);
  assert.equal(new Set(saved.map(x=>x.id)).size,3);
  assert.equal(saved.filter(x=>x.scope==='comment').length,1);
});
test('comment log view excludes old mutual tests and orders newest first without changing storage',()=>{
  const logs=[{id:'old-comment',scope:'comment',at:'2026-10-16'}, {id:'new-comment',scope:'comment',at:'2026-10-17'},{id:'mutual',scope:'mutual',at:'2026-10-18'}];
  assert.deepEqual(selectExecutionLogs(logs,'comment').map(x=>x.id),['new-comment','old-comment']);
  assert.equal(logs[0].id,'old-comment');
});
test('a failed write does not block later logging',async()=>{
  await assert.rejects(appendExecutionLog({scope:'comment'},{get:async()=>{throw Error('storage failed')}}));
  const logs=await appendExecutionLog({scope:'comment',result:'started'},{get:async()=>({}),set:async()=>{}});
  assert.equal(logs[0].result,'started');
});
test('fans scope selects fan-specific logs and queue jobs with fans source',()=>{
  const logs=[
    {id:'fan-sync',scope:'fans',at:'2026-10-18T10:00:00Z'},
    {id:'fan-queue',scope:'queue',sources:[{module:'fans'}],at:'2026-10-18T11:00:00Z'},
    {id:'mutual-queue',scope:'queue',sources:[{module:'mutual'}],at:'2026-10-18T12:00:00Z'},
    {id:'comment-log',scope:'comment',at:'2026-10-18T13:00:00Z'}
  ];
  const selected=selectExecutionLogs(logs,'fans');
  assert.equal(selected.length,2);
  assert.equal(selected[0].id,'fan-queue');
  assert.equal(selected[1].id,'fan-sync');
});

