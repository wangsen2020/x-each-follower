import test from 'node:test';
import assert from 'node:assert/strict';
import {collectFollowQueueCandidates} from '../src/features/follow-queue/follow-queue-sources.js';

test('candidates merge handles, keep comment urls, and enable only explicit sources', () => {
  const rows = collectFollowQueueCandidates({
    accountId: 'acc-1',
    sourceEnabled: {fans: true, mutual: false, comments: true},
    monitor: {
      enabled: true,
      users: [{handle: '@Alice', id: '999001', state: 'new'}],
      queue: [{handle: 'alice', id: 42}],
      followingUsers: [{handle: 'BOB', id: '12', state: 'following'}]
    },
    mutualNetwork: {
      autoFollow: {enabled: true},
      users: [{handle: 'Alice', id: '777', relationship: {following: false}, followedAt: ''}]
    },
    commentTracking: {
      autoFollow: {enabled: true},
      posts: [
        {tweetId: 'p1', url: 'https://x.com/someone/status/1'},
        {tweetId: 'p2', url: 'https://x.com/someone/status/2'}
      ],
      users: [{
        handle: 'ALICE',
        id: '555',
        sources: [
          {tweetId: 'p1', url: 'https://x.com/someone/status/1'},
          {tweetId: 'p2', url: 'https://x.com/someone/status/2'},
          {tweetId: 'p1', url: 'https://x.com/someone/status/1'}
        ]
      }]
    },
    attempts: {}
  });
  const alice = rows.find(row => row.handle.toLowerCase() === 'alice');
  const bob = rows.find(row => row.handle.toLowerCase() === 'bob');
  assert.equal(rows.length, 2);
  assert.equal(alice.targetUserId, '');
  assert.equal(alice.accountId, 'acc-1');
  assert.deepEqual(alice.sources.map(source => [source.module, source.url, source.enabled]), [
    ['fans', '', true],
    ['mutual', '', false],
    ['comments', 'https://x.com/someone/status/1', true],
    ['comments', 'https://x.com/someone/status/2', true]
  ]);
  assert.equal(alice.state, undefined);
  assert.equal(bob.state, 'followed');
  assert.equal(bob.followResult.following, true);
  assert.equal(bob.sources[0].enabled, true);
  assert.equal(bob.targetUserId, '');
});

test('verified rest ids, attempt holds, and disabled followed history stay imported', () => {
  const rows = collectFollowQueueCandidates({
    accountId: ' acc-9 ',
    sourceEnabled: {fans: false, mutual: false, comments: false},
    monitor: {users: [], queue: [], followingUsers: []},
    mutualNetwork: {users: [{handle: '@Cara', rest_id: '888', relationship: {following: true}}]},
    commentTracking: {
      posts: [{tweetId: 't9', url: 'https://x.com/i/status/9'}],
      users: [{handle: 'dee', targetUserId: 'not-a-rest', sources: [{tweetId: 't9'}]}]
    },
    attempts: {
      'autoFollowAttempt:dee': {state: 'failed', reason: 'quote-missing', at: 1},
      'autoFollowAttempt:cara': {state: 'skipped', reason: 'old-skip', at: 1},
      'autoFollowAttempt:erin': {state: 'processing', at: 1},
      'autoFollowAttempt:fran': {state: 'excluded', reason: 'blocked', at: 1}
    }
  });
  const extra = collectFollowQueueCandidates({
    accountId: 'acc-9',
    sourceEnabled: {},
    monitor: {queue: ['Erin'], users: [{handle: 'fran', id: '1'}]},
    mutualNetwork: {users: []},
    commentTracking: {users: []},
    attempts: {
      'autoFollowAttempt:erin': {state: 'processing', at: 1},
      'autoFollowAttempt:fran': {state: 'excluded', reason: 'blocked', at: 1}
    }
  });
  const cara = rows.find(row => row.handle.toLowerCase() === 'cara');
  const dee = rows.find(row => row.handle.toLowerCase() === 'dee');
  assert.equal(cara.targetUserId, '888');
  assert.equal(cara.state, 'followed');
  assert.equal(cara.sources.every(source => source.enabled === false), true);
  assert.equal(dee.targetUserId, '');
  assert.equal(dee.state, 'uncertain');
  assert.equal(dee.followResult.reason, 'quote-missing');
  assert.equal(dee.sources[0].url, 'https://x.com/i/status/9');
  assert.equal(extra.find(row => row.handle === 'Erin').state, 'uncertain');
  assert.equal(extra.find(row => row.handle === 'fran').state, 'excluded');
  assert.equal(extra.find(row => row.handle === 'fran').sources[0].enabled, false);
});

test('conflicting verified ids stay handle-only and a missing account fails closed', () => {
  const rows = collectFollowQueueCandidates({
    accountId: 'acc-1',
    sourceEnabled: {fans: true},
    monitor: {users: [{handle: 'Gale', restId: '100'}]},
    mutualNetwork: {users: [{handle: 'gale', targetUserId: '200'}]},
    commentTracking: {users: []},
    attempts: {'autoFollowAttempt:gale': {state: 'skipped', reason: 'ratio', at: 1}}
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetUserId, '');
  assert.equal(rows[0].state, 'uncertain');
  assert.equal(rows[0].followResult.reason, 'conflicting-rest-ids');
  assert.throws(() => collectFollowQueueCandidates({monitor: {users: [{handle: 'a'}]}}), /missing account/);
});

test('legacy autoFollowState, processed handles, and unflagged following users import holds', () => {
  const rows = collectFollowQueueCandidates({
    accountId: 'acc-1',
    sourceEnabled: {fans: false, mutual: false, comments: false},
    monitor: {
      users: [
        {handle: 'Ann', autoFollowState: 'skipped'},
        {handle: 'Jo', autoFollowState: 'failed'}
      ],
      queue: [],
      followingUsers: [{handle: 'Bea'}, {handle: 'Cyd'}],
      autoFollow: {processedHandles: ['Cyd', '@Ned']}
    },
    mutualNetwork: {
      users: [{handle: 'Dee', autoFollowState: 'rate_limited'}],
      autoFollow: {processedHandles: ['Erin']}
    },
    commentTracking: {
      users: [{handle: 'Fay', autoFollowState: 'followed'}],
      autoFollow: ['Gina']
    },
    mutualAutoFollowSettings: {processedHandles: [{handle: '@Hank'}]},
    commentAutoFollowSettings: ['Ivy'],
    attempts: {}
  });
  const byHandle = handle => rows.find(row => row.handle.toLowerCase() === handle);
  assert.equal(byHandle('ann').state, 'skipped');
  assert.equal(byHandle('ann').sources[0].enabled, false);
  assert.equal(byHandle('jo').state, 'uncertain');
  assert.equal(byHandle('bea').state, 'followed');
  assert.equal(byHandle('bea').followResult.following, true);
  assert.equal(byHandle('bea').sources[0].enabled, false);
  assert.equal(byHandle('bea').sources[0].module, 'fans');
  assert.equal(byHandle('cyd').state, 'followed');
  assert.equal(byHandle('cyd').followResult.reason, undefined);
  assert.equal(byHandle('dee').state, 'uncertain');
  assert.equal(byHandle('fay').state, 'followed');
  assert.equal(byHandle('fay').followResult.following, true);
  for (const handle of ['ned', 'erin', 'gina', 'hank', 'ivy']) {
    assert.equal(byHandle(handle).state, 'uncertain');
    assert.equal(byHandle(handle).followResult.reason, 'processed-handle');
    assert.deepEqual(byHandle(handle).sources, []);
  }
});
