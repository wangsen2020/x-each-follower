import test from 'node:test';
import assert from 'node:assert/strict';
import {finishExperienceUse} from '../src/features/knowledge/learning-context.js';
import {resolveWritingContext} from '../src/features/knowledge/writing-context.js';
test('usage audit failure cannot turn successful generation into a retry',async()=>{
  await assert.doesNotReject(finishExperienceUse('request',{ok:true,reply:'已生成'}, {finishUse:async()=>{throw Error('disk full');}}));
});
test('wisdom injection does not need a connected Bot and excludes original/article/test purposes',async()=>{
  const repository={settings:async()=>({writingKnowledgeEnabled:true}),wisdom:async()=>({version:4,content:'尊重事实'}),use:async()=>{throw Error('disk full');}};
  assert.equal((await resolveWritingContext({ownerId:'123',purpose:'reply'},{repository})).wisdomVersion,4);
  for(const purpose of ['original','article','test'])assert.equal((await resolveWritingContext({ownerId:'123',purpose},{repository})).text,'');
});
