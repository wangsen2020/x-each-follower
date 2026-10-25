import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../src/features/relationships/relationship-rules.js';
import * as panelData from '../src/entries/panel/panel-data.js';

const monitor = {
  queue: [{handle: 'Queued', status: 'followed'}, {status: 'pending'}],
  users: [
    {handle: 'Fan', relationship: {followedBy: true}},
    {handle: 'Both', state: 'following', relationship: {followedBy: true}},
    {handle: 'OneWay', relationship: {following: true, followedBy: false}}
  ],
  followingUsers: [
    {handle: 'Kept', relationship: {followedBy: false}},
    {handle: 'Open'}
  ]
};

test('panel data re-exports the same relationship functions', () => {
  for (const name of [
    'buildRelationshipIndex', 'monitorUserStatus', 'commentRelationshipLabel',
    'applyRelationshipSnapshot', 'snapshotMutualUsers', 'deriveNotMutualUsers', 'deriveTrackerUsers'
  ]) {
    assert.equal(panelData[name], rules[name]);
  }
});

test('not-mutual derivation keeps monitor rows ahead of later duplicates', () => {
  const rows = rules.deriveNotMutualUsers({
    monitor,
    mutualNetwork: {users: [
      {handle: 'Kept', relationship: {following: true, followedBy: false}},
      {handle: 'Later', relationship: {following: true, followedBy: false}},
      {handle: 'MutualFan', relationship: {following: true, followedBy: true}}
    ]}
  });
  assert.deepEqual(rows.map(row => row.handle), ['kept', 'open', 'oneway', 'later']);
  assert.deepEqual(rows[0].sourcePath, ['monitor', 'followingUsers', 0]);
  assert.equal(rows[0].payload.relationship.followedBy, false);
  assert.deepEqual(rows[2].sourcePath, ['monitor', 'users', 2]);
  assert.deepEqual(rows[3].sourcePath, ['mutualNetwork', 'users', 1]);
});

test('tracker derivation preserves stored rows and skips unfollowed users', () => {
  const rows = rules.deriveTrackerUsers({
    monitor: {followingUsers: [{handle: 'New', name: 'New Name', relationship: {followedBy: false}}]},
    mutualNetwork: {users: [{handle: 'FromMutual', followedAt: '2026-01-01', relationship: {following: true, followedBy: true}}]},
    commentTracking: {users: [{handle: 'Commented', state: 'saved'}]},
    unreciprocatedTracker: {users: [
      {handle: 'Stored', status: 'pending', relationship: {following: true, followedBy: false}},
      {handle: 'Gone', status: 'unfollowed'},
      {handle: 'New', status: 'pending', name: 'Stored Name'}
    ]}
  });
  assert.deepEqual(rows.map(row => row.handle), ['stored', 'new', 'frommutual']);
  assert.equal(rows[0].derived, false);
  assert.equal(rows[0].payload.name, undefined);
  assert.equal(rows[1].derived, false);
  assert.equal(rows[1].payload.name, 'Stored Name');
  const created = rows[2];
  assert.equal(created.derived, true);
  assert.equal(created.payload.status, 'mutual');
  assert.deepEqual(created.payload.relationship, {following: true, followedBy: true});
  assert.deepEqual(created.originPath, ['mutualNetwork', 'users', 0]);
  assert.deepEqual(created.sourcePath, ['unreciprocatedTracker', 'synthetic', 'frommutual']);
});

test('relationship index still classifies queue, following, and empty handles', () => {
  const index = rules.buildRelationshipIndex(monitor);
  assert.equal(rules.monitorUserStatus({handle: 'Queued'}, index), 'followed');
  assert.equal(rules.monitorUserStatus({}, index), 'pending');
  assert.equal(rules.commentRelationshipLabel({handle: 'Both'}, index), '互相关注');
  assert.equal(rules.commentRelationshipLabel({handle: 'Kept'}, index), '未互关');
  const snapped = rules.applyRelationshipSnapshot({handle: 'Kept', relationship: {followedBy: false}}, index);
  assert.equal(snapped.relationship.following, true);
  assert.equal(snapped.relationship.followedBy, false);
  assert.equal(snapped.relationshipKnown, true);
  assert.equal(rules.snapshotMutualUsers([{handle: 'Nope'}], index)[0].relationship.following, false);
});

test('explicit not-following survives stale lists, queue success, and follow dates', () => {
  const snapshot = {
    monitor: {
      queue:[{handle:'Stale',status:'followed'}],
      users:[{handle:'Stale',state:'following',relationship:{following:false,followedBy:false}}],
      followingUsers:[{handle:'Stale',relationship:{following:false,followedBy:false}}]
    },
    mutualNetwork:{users:[{handle:'Stale',followedAt:'2026-10-16',relationship:{following:false,followedBy:false}}]},
    unreciprocatedTracker:{users:[{handle:'Stale',status:'pending',relationship:{following:false,followedBy:false}}]}
  };
  const index = rules.buildRelationshipIndex(snapshot.monitor);
  assert.equal(index.following.has('stale'),false);
  assert.equal(rules.applyRelationshipSnapshot(snapshot.monitor.users[0],index).relationship.following,false);
  assert.equal(rules.commentRelationshipLabel(snapshot.monitor.users[0],index),'未互关');
  assert.equal(rules.deriveNotMutualUsers(snapshot).some(row=>row.handle==='stale'),false);
  assert.equal(rules.deriveTrackerUsers(snapshot).some(row=>row.handle==='stale'),false);
});

test('old followedAt without a current positive relationship cannot create a tracker record', () => {
  const rows=rules.deriveTrackerUsers({mutualNetwork:{users:[{handle:'Old',followedAt:'2026-10-16',relationship:{following:false}}]}});
  assert.deepEqual(rows,[]);
});

test('a stale following-list entry loses to explicit negatives in other live collections', () => {
  const snapshot={
    monitor:{followingUsers:[{handle:'Stale',relationship:{followedBy:false}}],users:[{handle:'Stale',relationship:{following:false}}]},
    mutualNetwork:{users:[{handle:'Other',relationship:{following:false}}]},
    unreciprocatedTracker:{users:[{handle:'Other',status:'no_longer_following'}]}
  };
  assert.equal(rules.buildRelationshipIndex(snapshot.monitor).following.has('stale'),false);
  assert.deepEqual(rules.deriveNotMutualUsers(snapshot),[]);
  assert.deepEqual(rules.deriveTrackerUsers(snapshot),[]);
  assert.equal(rules.inactiveFollowingHandles(snapshot).has('other'),true);
});
test('applyRelationshipSnapshot safely handles numeric index from array map or missing index', () => {
  const users = [{handle: 'QQ20C'}, {handle: 'OtherUser', relationship: {followedBy: true}}];

  // Directly passed as array.map callback (where index is 0, 1, ...)
  const mapped = users.map(rules.applyRelationshipSnapshot);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].handle, 'QQ20C');
  assert.equal(mapped[0].relationship.following, false);
  assert.equal(mapped[1].relationship.followedBy, true);

  // Explicitly called with number or undefined
  assert.doesNotThrow(() => rules.applyRelationshipSnapshot({handle: 'Test'}, 0));
  assert.doesNotThrow(() => rules.applyRelationshipSnapshot({handle: 'Test'}, null));
  assert.doesNotThrow(() => rules.applyRelationshipSnapshot({handle: 'Test'}, undefined));
  assert.doesNotThrow(() => rules.applyRelationshipSnapshot({handle: 'Test'}, {}));

  // commentRelationshipLabel and monitorUserStatus with invalid index
  assert.doesNotThrow(() => rules.commentRelationshipLabel({handle: 'Test'}, 0));
  assert.doesNotThrow(() => rules.monitorUserStatus({handle: 'Test'}, 0));
});
