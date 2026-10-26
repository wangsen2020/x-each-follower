import test from 'node:test';
import assert from 'node:assert/strict';
import {useExecutionLogs} from '../../src/entries/panel/composables/useExecutionLogs.js';

test('loading reports real recovery progress and closing discards a late response', async t => {
  t.mock.timers.enable({apis: ['setInterval', 'Date']});
  const prior = globalThis.chrome;
  let finish;
  let polls = 0;
  globalThis.chrome = {runtime: {sendMessage: async ({cmd}) => {
    if (cmd === 'executionLogStatus') { polls++; return {ok: true, recovery: {phase: 'recovering', current: 12, total: 90}}; }
    return new Promise(resolve => { finish = resolve; });
  }}};
  const c = useExecutionLogs();
  try {
    const opening = c.open();
    assert.equal(c.totalBadgeText.value, '加载中');
    t.mock.timers.tick(1500);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(c.elapsedSeconds.value, 1);
    assert.equal(c.loadingTitle.value, '正在恢复历史日志…');
    assert.match(c.loadingDetail.value, /12 \/ 90/);
    c.close();
    const before = polls;
    t.mock.timers.tick(2000);
    assert.equal(polls, before);
    finish({ok: true, entries: [{id: 'stale'}], total: 1});
    await opening;
    assert.equal(c.entries.value.length, 0);
    assert.equal(c.isOpen.value, false);
  } finally { c.close(); globalThis.chrome = prior; }
});

test('failed loading can retry and removes feedback timers after success', async t => {
  t.mock.timers.enable({apis: ['setInterval', 'Date']});
  const prior = globalThis.chrome;
  let calls = 0;
  globalThis.chrome = {runtime: {sendMessage: async () => {
    calls++;
    return calls === 1 ? {ok: false, error: 'offline'} : {ok: true, entries: [{id: 'kept'}], total: 1};
  }}};
  const c = useExecutionLogs();
  try {
    await c.open();
    assert.equal(c.status.value, 'error');
    await c.loadPage();
    assert.equal(c.status.value, 'ready');
    assert.equal(c.entries.value[0].id, 'kept');
    t.mock.timers.tick(10000);
    assert.equal(calls, 2);
  } finally { c.close(); globalThis.chrome = prior; }
});

test('closing during settings read prevents a late log open or query',async()=>{
 const previous=globalThis.chrome;let resolveSettings,calls=0;
 globalThis.chrome={storage:{local:{get:()=>new Promise(resolve=>resolveSettings=resolve)}},runtime:{sendMessage:async()=>{calls++;return {ok:true,entries:[],total:0};}}};
 const c=useExecutionLogs();
 try {const opening=c.open();assert.equal(c.isOpen.value,true);c.close();resolveSettings({'systemSettings:logs':{pageSize:10,days:7}});await opening;assert.equal(c.isOpen.value,false);assert.equal(calls,0);}
 finally{c.close();globalThis.chrome=previous;}
});
