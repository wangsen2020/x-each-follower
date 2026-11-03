import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewIntervalRange,reviewIntervalMs,validReviewInterval} from '../src/features/relationships/review-pacing.js';
import {normalizeReviewSettings,validateReviewSettings,mergeReviewSettingsPatch} from '../src/features/relationships/follow-review-engine.js';
import {normalizeFollowReviewSettings,validateFollowReviewSettings} from '../src/entries/panel/follow-review-settings.js';
import {fanReviewProgress} from '../src/entries/panel/fan-review-panel.js';

test('old pacing preserves batch size and explicit zero, and expands positive intervals into a range',()=>{
  for(const normalize of [normalizeReviewSettings,normalizeFollowReviewSettings]){
    const settings=normalize({fanTagging:{batchSize:30,intervalSeconds:3}});
    assert.equal(settings.fanTagging.batchSize,30);
    assert.equal(settings.fanTagging.intervalSeconds,3);
    assert.equal(settings.fanTagging.intervalMaxSeconds,8);
    assert.equal(normalize({fanTagging:{intervalSeconds:0}}).fanTagging.intervalMaxSeconds,0);
  }
  assert.deepEqual(reviewIntervalRange({intervalSeconds:299}),{intervalSeconds:299,intervalMaxSeconds:300});
  const merged=mergeReviewSettingsPatch({fanTagging:{intervalSeconds:10,intervalMaxSeconds:20}},{fanTagging:{prompt:'keep range'}});
  assert.equal(merged.fanTagging.intervalMaxSeconds,20);
});

test('random delay spans the configured range, including intentional fixed and zero intervals',()=>{
  assert.equal(reviewIntervalMs({intervalSeconds:3,intervalMaxSeconds:8},()=>0),3000);
  assert.equal(reviewIntervalMs({intervalSeconds:3,intervalMaxSeconds:8},()=>0.5),5500);
  assert.equal(reviewIntervalMs({intervalSeconds:3,intervalMaxSeconds:8},()=>1),8000);
  assert.equal(reviewIntervalMs({intervalSeconds:4,intervalMaxSeconds:4},()=>0.8),4000);
  assert.equal(reviewIntervalMs({intervalSeconds:0},()=>0.8),0);
});

test('UI and background reject inverted, fractional, blank and excessive ranges',()=>{
  for(const value of [-1,301,3.5,''])assert.equal(validReviewInterval({intervalSeconds:3,intervalMaxSeconds:value}),false);
  for(const validate of [validateReviewSettings,validateFollowReviewSettings]){
    assert.throws(()=>validate({...normalizeReviewSettings(),fanTagging:{batchSize:10,intervalSeconds:8,intervalMaxSeconds:3}}),/间隔/);
  }
});

test('progress distinguishes AI submission, interruptible waiting, and stopping',()=>{
  const batch={action:'analyze',stage:'running',completed:30,total:80};
  assert.match(fanReviewProgress({...batch,requestSize:30}),/本批 30 人/);
  assert.match(fanReviewProgress({...batch,phase:'checking',checked:3,planned:30,currentHandle:'person'}),/检查记录 3\/30/);
  assert.match(fanReviewProgress({...batch,phase:'saving',applied:4,planned:25,requestSize:25}),/保存结果 4\/25/);
  assert.match(fanReviewProgress({...batch,nextRequestAt:Date.now()+60000}),/下批等待/);
  assert.match(fanReviewProgress({...batch,stopping:true,requestSize:30}),/正在停止/);
  assert.doesNotMatch(fanReviewProgress({...batch,stage:'completed',requestSize:30}),/本批|等待/);
});
