import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNetworkUsers, findCursor} from '../network-api.js';

test('parses nested X GraphQL user nodes and relationship state', () => {
  const json = {items:[{rest_id:'1',legacy:{screen_name:'alice',name:'Alice',description:'AI',following:false}},{value:'next-cursor',cursorType:'BottomCursor'}]};
  const users = parseNetworkUsers(json);
  assert.equal(users[0].handle, 'alice');
  assert.equal(users[0].state, 'follow_back');
  assert.equal(findCursor(json), 'next-cursor');
});
