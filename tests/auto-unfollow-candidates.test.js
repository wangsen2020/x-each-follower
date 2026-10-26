import test from 'node:test';
import assert from 'node:assert/strict';
import {readAutoUnfollowCandidates} from '../src/features/relationships/auto-unfollow-adapter.js';

test('stable candidate scan preserves source pages, account scope and real tracker overrides',async()=>{
  const calls=[];
  const row=(handle,extra={})=>({accountId:'unassigned',module:'unreciprocated',payload:{handle,status:'overdue'},...extra});
  const pages={
    'derived:tracker':[{records:[row('same'),row('derived')],nextCursor:'second'}, {records:[row('other-owner',{accountId:'another'}),row('wrong-module',{module:'comments'})],nextCursor:null}],
    unreciprocatedTracker:[{records:[row('SAME',{payload:{handle:'SAME',status:'mutual'}}),row('real')],nextCursor:null}]
  };
  const users=await readAutoUnfollowCandidates({records:{ready:async()=>calls.push('ready')},service:{
    summary:async()=>calls.push('flush'),
    query:async()=>{throw Error('revision-bound query must not be used');},
    sourcePage:async({sourceKey,cursor})=>{calls.push([sourceKey,cursor]);return pages[sourceKey][cursor?1:0];}
  }});
  assert.deepEqual(calls.slice(0,2),['ready','flush']);
  assert.deepEqual(users.map(u=>u.handle),['SAME','derived','real']);
  assert.equal(users[0].status,'mutual');
  assert.equal(calls.filter(Array.isArray).length,3);
});

test('a failed scan never returns a partial candidate list',async()=>{
  await assert.rejects(readAutoUnfollowCandidates({records:{ready:async()=>{}},service:{summary:async()=>{},sourcePage:async({cursor})=>{
    if(cursor)throw Error('read failed');
    return {records:[{accountId:'unassigned',module:'unreciprocated',payload:{handle:'first'}}],nextCursor:'next'};
  }}}),/read failed/);
});
