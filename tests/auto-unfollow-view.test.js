import test from 'node:test';
import assert from 'node:assert/strict';
import {autoUnfollowView,autoUnfollowRowView} from '../src/features/relationships/auto-unfollow-view.js';
const now=new Date(2026,9,27,12).getTime();
const cfg={autoUnfollow:true,autoUnfollowAccount:{id:'1',handle:'owner'},dailyLimit:200,activeTimeStart:'09:00',activeTimeEnd:'21:00'};
const state={day:'2026-10-27',used:5,queue:['first','second'],pendingItems:[{user:{handle:'blocked',id:'8'},checks:3,reason:'结果未确认'}]};
const view=(config=cfg,s=state,alarm={scheduledTime:now+60000})=>autoUnfollowView(config,{accounts:{1:s}},alarm,now);
test('queue positions distinguish waiting from account isolation and explain recovery',()=>{
 const v=view();assert.equal(v.queue.length,2);assert.equal(v.pending.length,1);
 assert.equal(autoUnfollowRowView({handle:'second'},v).label,'排队第 2 位');
 assert.match(autoUnfollowRowView({handle:'second'},v).tip,/前面有 1 个/);
 assert.equal(autoUnfollowRowView({handle:'renamed',id:'8'},v).label,'待确认 · 已隔离');
 assert.match(autoUnfollowRowView({handle:'blocked'},v).tip,/自动恢复排队/);
});
test('global pause, disabled, window, quota, and missing alarm have explicit explanations',()=>{
 assert.equal(view({...cfg,autoUnfollow:false}).label,'未开启');
 assert.equal(view({...cfg,activeTimeStart:'18:00'}).label,'等待执行时段');
 assert.equal(view(cfg,{...state,used:200}).label,'今日额度已用完');
 assert.equal(view(cfg,{...state,scheduler:{phase:'paused',reason:'平台限流',resume:'稍后重试'}}).reason,'平台限流；稍后重试');
 assert.equal(view(cfg,state,null).label,'计划待恢复');
 assert.equal(view(cfg,{...state,day:'2026-10-26',used:200}).used,0);
});
test('an unresolved legacy pending target cannot appear in the runnable queue',()=>{
 const v=view(cfg,{...state,pending:{user:{handle:'first',id:'7'}}});assert.deepEqual(v.queue,['second']);
});
test('an active reservation is shown as processing, and becomes pending recovery after interruption',()=>{
 const s={...state,pending:{user:{handle:'first',id:'7'}},scheduler:{phase:'running',updatedAt:now}};
 const v=view(cfg,s);assert.equal(v.label,'正在处理');assert.equal(v.pending.length,1);assert.equal(autoUnfollowRowView({id:'7',handle:'first'},v).label,'正在处理');
 const interrupted=autoUnfollowView(cfg,{accounts:{1:s}},{scheduledTime:now+180000},now+121000);
 assert.equal(interrupted.pending.length,2);assert.equal(autoUnfollowRowView({id:'7',handle:'first'},interrupted).label,'待确认 · 已隔离');
});
