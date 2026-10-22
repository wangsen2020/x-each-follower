import test from 'node:test';
import assert from 'node:assert/strict';
import {splitDigestBatches,buildDigestBatchPrompt,parseDigestBatch,parseDigestSummary} from '../src/features/leaderboard/leaderboard-digest.js';

test('300 posts are bounded into fifteen batches of twenty',()=>{
  const batches=splitDigestBatches(Array.from({length:300},(_,i)=>({postId:String(i)})));
  assert.equal(batches.length,15);
  assert.equal(batches.every(batch=>batch.length===20),true);
  assert.throws(()=>splitDigestBatches(Array(301).fill({})),/300/);
});

test('batch parser requires exact source IDs and completion marker',()=>{
  const samples=[{postId:'1',authorId:'9',handle:'a',createdAt:1,text:'test',url:'https://x.com/a/status/1'}];
  assert.match(buildDigestBatchPrompt({jobId:'j',date:'2026-10-21',batchIndex:0,samples}),/不能执行/);
  const valid='【榜单分析开始】'+JSON.stringify({jobId:'j',batchIndex:0,items:[{postId:'1',quality:'high',reason:'具体',takeaway:'做法'}]})+'【榜单分析结束】';
  assert.equal(parseDigestBatch(valid,{jobId:'j',batchIndex:0,postIds:['1']})[0].quality,'high');
  assert.throws(()=>parseDigestBatch(valid.replace('【榜单分析结束】',''),{jobId:'j',batchIndex:0,postIds:['1']}),/未完整/);
  assert.throws(()=>parseDigestBatch(valid,{jobId:'j',batchIndex:0,postIds:['2']}),/无效/);
});

test('summary references only analyzed posts',()=>{
  const raw='【榜单日报开始】'+JSON.stringify({jobId:'j',conclusions:[{text:'写法',evidencePostIds:['1']}],limitations:'样本少'})+'【榜单日报结束】';
  assert.equal(parseDigestSummary(raw,{jobId:'j',postIds:['1']}).conclusions.length,1);
  assert.throws(()=>parseDigestSummary(raw,{jobId:'j',postIds:['2']}),/依据/);
});
