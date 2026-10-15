import test from 'node:test';
import assert from 'node:assert/strict';
import {collectVisible, readProfile, clickFollowOnProfile} from '../page-reader.js';

const link = (path, text) => ({href:`https://x.com${path}`,innerText:text});
test('collection uses only following user cells, deduplicates and checks target route', () => {
  globalThis.location = {pathname:'/owner/following',origin:'https://x.com'};
  let scrolled = false;
  globalThis.window = {innerHeight:800,scrollBy:()=>{scrolled=true;}};
  const cells = [{innerText:'Alice\n@alice',querySelectorAll:()=>[link('/alice','Alice'),link('/alice','@alice'),link('/other','Other')]}];
  globalThis.document = {querySelector: selector => {
    assert.equal(selector,'[data-testid="primaryColumn"]');
    return {querySelectorAll:selector=>{assert.equal(selector,'[data-testid="UserCell"]'); return cells;}};
  }};
  assert.deepEqual(collectVisible('owner').handles,['alice']);
  assert.ok(scrolled);
  assert.throws(()=>collectVisible('different'));
});
test('profile reads handle-specific counts, supports verified followers, waits for missing counts', () => {
  globalThis.location = {pathname:'/alice',origin:'https://x.com'};
  let links = [link('/other/followers','900K Followers'),link('/alice/following','110 Following'),link('/alice/verified_followers','100 Followers')];
  globalThis.document = {querySelector:()=>({
    querySelector:selector=>selector.includes('UserName') ? {innerText:'Alice\n@alice'} : {innerText:'互关'},
    querySelectorAll:()=>links
  })};
  const result = readProfile('alice');
  assert.equal(result.followersText,'100 Followers');
  assert.equal(result.followingText,'110 Following');
  assert.equal(result.name,'Alice');
  assert.equal(result.pending,false);
  assert.equal(readProfile('bob').pending,true);
  links = [];
  assert.equal(readProfile('alice').pending,true);
});
test('profile follow action only clicks an exact Follow button', () => {
  globalThis.location = {pathname:'/alice',origin:'https://x.com'};
  let clicked = 0;
  const button = {innerText:'Follow', getAttribute:()=>'', click:()=>{clicked++;}};
  globalThis.document = {querySelector:()=>({querySelectorAll:()=>[button]})};
  assert.deepEqual(clickFollowOnProfile('alice'), {ok:true});
  assert.equal(clicked,1);
  globalThis.document = {querySelector:()=>({querySelectorAll:()=>[{innerText:'Following',getAttribute:()=>''}]})};
  assert.deepEqual(clickFollowOnProfile('alice'), {ok:false, reason:'already_following'});
});
