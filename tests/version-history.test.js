import test from 'node:test';
import assert from 'node:assert/strict';
import {createVersionHistory, VERSION_HISTORY_KEY} from '../src/shared/version-history.js';

test('version history records real transitions once and keeps migration details', async () => {
  const data={};
  const storage={get:async key=>({[key]:data[key]}),set:async value=>Object.assign(data,value)};
  const history=createVersionHistory({storage,version:'2.12.9',now:()=> '2026-10-25T00:00:00.000Z'});
  await Promise.all([history.recordInstalled({reason:'update',previousVersion:'2.12.8'}),history.recordInstalled({reason:'update',previousVersion:'2.12.8'})]);
  await history.recordMigration('started',{migrationId:'legacy-abc',completed:3,total:10});
  await history.recordMigration('ready',{migrationId:'legacy-abc',completed:10,total:10,cutover:true});
  const saved=await history.read();
  assert.deepEqual(saved.versions,[{id:'update:2.12.8:2.12.9',version:'2.12.9',previousVersion:'2.12.8',kind:'update',at:'2026-10-25T00:00:00.000Z'}]);
  assert.equal(saved.logs.length,3);
  assert.equal(saved.logs[0].stage,'ready');
  assert.deepEqual([saved.logs[0].completed,saved.logs[0].total,saved.logs[0].cutover],[10,10,true]);
  assert.equal(saved.logs[1].stage,'started');
  assert.equal(saved.logs[2].previousVersion,'2.12.8');
  assert.ok(data[VERSION_HISTORY_KEY]);
});

test('a failed history write can be retried without inventing an earlier version', async () => {
  const data={};let fail=true;
  const storage={get:async key=>({[key]:data[key]}),set:async value=>{if(fail){fail=false;throw Error('quota')}Object.assign(data,value)}};
  const history=createVersionHistory({storage,version:'2.12.9'});
  await assert.rejects(history.recordInstalled({reason:'install'}),/quota/);
  await history.recordInstalled({reason:'install'});
  await history.recordInstalled({reason:'chrome_update'});
  await history.recordInstalled({reason:'update',previousVersion:'2.12.9'});
  assert.equal((await history.read()).versions.length,1);
  assert.equal((await history.read()).versions[0].previousVersion,null);
});
