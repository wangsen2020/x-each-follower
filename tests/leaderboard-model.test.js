import test from 'node:test';
import assert from 'node:assert/strict';
import {dayWindow,shanghaiDay,previousDay,followerDelta,rankMembers,selectDigestPosts} from '../src/features/leaderboard/leaderboard-model.js';

test('Shanghai day window and previous day cross UTC date boundary',()=>{
  const window=dayWindow('2026-10-22');
  assert.equal(new Date(window.from).toISOString(),'2026-10-21T16:00:00.000Z');
  assert.equal(shanghaiDay(window.to-1),'2026-10-22');
  assert.equal(previousDay('2026-10-22'),'2026-10-21');
});

test('follower ranking uses two valid daily snapshots and retains negative growth',()=>{
  const early=dayWindow('2026-10-21').from+300000,late=dayWindow('2026-10-22').from+300000;
  const snapshots=new Map([['1',[{at:early,followers:100},{at:late,followers:110}]],['2',[{at:early,followers:200},{at:late,followers:199}]],['3',[{at:late,followers:400}]]]);
  const ranked=rankMembers([{creatorId:'3'},{creatorId:'2'},{creatorId:'1'}],snapshots,'2026-10-22');
  assert.deepEqual(ranked.map(row=>[row.creatorId,row.delta,row.deltaStatus]),[['1',10,'valid'],['2',-1,'valid'],['3',null,'baseline_missing']]);
  assert.equal(followerDelta([{at:early,followers:100},{at:late+12*3600000,followers:110}],'2026-10-22').status,'interval_invalid');
});

test('daily candidate selection excludes replies, reposts and other dates, max 30 per author',()=>{
  const {from}=dayWindow('2026-10-21');
  const posts=Array.from({length:40},(_,i)=>({postId:String(i),createdAt:from+i*1000,kind:'post',metrics:{views:i}}));
  posts.push({postId:'reply',createdAt:from+5000,kind:'reply',metrics:{views:99999}});
  posts.push({postId:'other',createdAt:from-1,kind:'post',metrics:{views:99999}});
  const selected=selectDigestPosts(posts,'2026-10-21');
  assert.equal(selected.length,30);
  assert.equal(selected[0].postId,'39');
  assert.equal(selected.some(p=>p.postId==='reply'||p.postId==='other'),false);
});
