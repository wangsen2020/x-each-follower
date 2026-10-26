import test from 'node:test';
import assert from 'node:assert/strict';
import {networkFollow} from '../src/features/relationships/network-api.js';

const profile = (id, handle, following) => ({status: 200, json: {
  rest_id: id, legacy: {screen_name: handle, following}
}});

test('follow response needs a confirmed relationship before reporting success', async () => {
  const client = {
    follow: async () => ({status: 200, json: {ok: true}}),
    profile: async () => profile('123', 'alice', true)
  };
  const result = await networkFollow(1, {id: '123', handle: 'alice'}, client);
  assert.equal(result.status, 200);
  assert.equal(result.verifiedFollowing, true);
});

test('HTTP success without a following relationship stays uncertain', async () => {
  let checks = 0;
  const client = {
    follow: async () => ({status: 200, json: {ok: true}}),
    profile: async () => { checks++; return profile('123', 'alice', false); }
  };
  const result = await networkFollow(1, {id: '123', handle: 'alice'}, client);
  assert.equal(checks, 2);
  assert.equal(result.status, 0);
  assert.equal(result.uncertain, true);
});

test('confirmation rejects a different account even with the same handle', async () => {
  const client = {
    follow: async () => ({status: 200, json: profile('999', 'alice', true).json}),
    profile: async () => profile('999', 'alice', true)
  };
  const result = await networkFollow(1, {id: '123', handle: 'alice'}, client);
  assert.equal(result.uncertain, true);
});

test('HTTP success carrying an X error never confirms a follow', async () => {
  const client={follow:async()=>({status:200,json:{...profile('123','alice',true).json,errors:[{message:'denied'}]}}),profile:async()=>assert.fail('do not query after an explicit X error')};
  const result=await networkFollow(1,{id:'123',handle:'alice'},client);
  assert.equal(result.uncertain,true);
  assert.equal(result.verifiedFollowing,undefined);
});
