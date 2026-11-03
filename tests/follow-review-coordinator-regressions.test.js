import test from 'node:test';
import assert from 'node:assert/strict';
import {createFanGrant,hasAuthorizedFanGrant,parseTaggingResponse,saveReviewSettings,readReviewSettings,defaultReviewSettings} from '../src/features/relationships/follow-review-engine.js';

test('AI omission of a known stable user ID cannot authorize admission',()=>{
  const items=[{handle:'selected_user',targetUserId:'1234567890123456789'}];
  const rows=parseTaggingResponse(JSON.stringify([{handle:'selected_user',decision:'pass',reason:'资料正常',tags:[],evidence:[]}]),items);
  assert.equal(rows[0].valid,false);
  assert.equal(rows[0].decision,'uncertain');
});

test('an unbound handle-only grant cannot bypass rules for a later resolved stable identity',()=>{
  const grant=createFanGrant({accountId:'owner',handle:'selected_user',source:'initial-review-disabled'});
  assert.equal(hasAuthorizedFanGrant(grant,'owner','1234567890123456789','selected_user',{requireTargetUserId:true}),false);
});

test('concurrent fan and queue scoped saves preserve both changes',async()=>{
  const data={'followQueueReviewSettings:owner':defaultReviewSettings()};
  const storage={
    async get(keys){await new Promise(resolve=>setTimeout(resolve,2));return Object.fromEntries(keys.map(key=>[key,structuredClone(data[key]) ]));},
    async set(patch){await new Promise(resolve=>setTimeout(resolve,2));Object.assign(data,structuredClone(patch));}
  };
  await Promise.all([
    saveReviewSettings(storage,'owner',{initialReviewEnabled:true}),
    saveReviewSettings(storage,'owner',{followBackSkipRules:true})
  ]);
  const settings=await readReviewSettings(storage,'owner');
  assert.equal(settings.initialReviewEnabled,true);
  assert.equal(settings.followBackSkipRules,true);
});
