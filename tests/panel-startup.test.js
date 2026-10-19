import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  STARTUP_DURABLE_KEYS,
  LOG_DURABLE_KEYS,
  buildRelationshipIndex,
  monitorUserStatus,
  commentRelationshipLabel,
  applyRelationshipSnapshot,
  snapshotMutualUsers,
  keysMissingFromLocal,
  recoveredValueIfStillMissing,
  localKeyPresent,
  shouldPaintLogs,
  shouldRescanMojibake,
  tabRenderTargets,
  localStorageChangePlan,
  loadDurableLogBuffer,
  takeLogBufferTask
} from '../panel-data.js';

const panelSource = readFileSync(new URL('../panel.js', import.meta.url), 'utf8');

test('relationship flags keep first queue status and follower or following membership', () => {
  const monitor = {
    followingUsers: [{handle: 'Kept'}],
    users: [
      {handle: 'Fan'},
      {handle: 'Both', state: 'saved'},
      {handle: 'QueuedFollowed'}
    ],
    queue: [
      {handle: 'QueuedFollowed', status: 'followed'},
      {handle: 'QueuedFollowed', status: 'pending'},
      {handle: 'Dup', status: 'pending'},
      {handle: 'Dup', status: 'followed'},
      {status: 'saved'}
    ]
  };
  const index = buildRelationshipIndex(monitor);
  assert.equal(monitorUserStatus({handle: 'QueuedFollowed'}, index), 'followed');
  assert.equal(monitorUserStatus({handle: 'Dup'}, index), 'pending');
  assert.equal(monitorUserStatus({handle: 'missing'}, index), 'saved');
  assert.equal(monitorUserStatus({}, index), 'saved');
  assert.equal(monitorUserStatus({state: 'following', handle: 'Fan'}, index), 'following');
  assert.equal(commentRelationshipLabel({handle: 'Both', relationship: {followedBy: true}}, index), '未互关');
  assert.equal(commentRelationshipLabel({handle: 'Kept', relationship: {followedBy: true}}, index), '互相关注');
  assert.equal(commentRelationshipLabel({handle: 'Fan', relationship: {following: true, followedBy: true}}, index), '互相关注');
  assert.equal(commentRelationshipLabel({handle: 'QueuedFollowed'}, index), '互相关注');
  const snapped = applyRelationshipSnapshot({handle: 'Kept', relationship: {followedBy: false}}, index);
  assert.equal(snapped.relationship.following, true);
  assert.equal(snapped.relationship.followedBy, false);
  assert.equal(snapped.relationshipKnown, true);
  const unknown = applyRelationshipSnapshot({handle: 'Nope'}, index);
  assert.equal(unknown.relationship.following, false);
  assert.equal(unknown.relationshipKnown, false);
  const users = snapshotMutualUsers([{handle: 'Fan'}, {handle: 'Kept'}], index);
  assert.equal(users[0].relationship.followedBy, true);
  assert.equal(users[1].relationship.following, true);
});

test('a later pass sees in-place edits and does not reuse the previous index', () => {
  const monitor = {users: [{handle: 'A'}], queue: [{handle: 'A', status: 'pending'}], followingUsers: []};
  const first = buildRelationshipIndex(monitor);
  assert.equal(monitorUserStatus({handle: 'A'}, first), 'pending');
  monitor.queue[0].status = 'followed';
  monitor.users.push({handle: 'B', state: 'following'});
  assert.equal(monitorUserStatus({handle: 'A'}, first), 'pending');
  assert.equal(first.following.has('b'), false);
  const second = buildRelationshipIndex(monitor);
  assert.equal(monitorUserStatus({handle: 'A'}, second), 'followed');
  assert.equal(second.following.has('a'), true);
  assert.equal(second.following.has('b'), true);
  assert.equal(commentRelationshipLabel({handle: 'A'}, second), '互相关注');
});

test('one relationship pass touches each collection a constant number of times at 10k', () => {
  const count = 10000;
  const users = Array.from({length: count}, (_, i) => ({handle: `user${i}`}));
  const queue = Array.from({length: count}, (_, i) => ({handle: `user${i}`, status: i === 0 ? 'followed' : 'pending'}));
  queue.push({handle: 'user0', status: 'saved'});
  const monitor = {users, queue, followingUsers: [{handle: 'other'}]};
  const index = buildRelationshipIndex(monitor);
  assert.equal(index.visits, users.length * 2 + queue.length + monitor.followingUsers.length);
  assert.equal(monitorUserStatus(users[0], index), 'followed');
  assert.equal(monitorUserStatus(users[count - 1], index), 'pending');
  assert.equal(index.queueStatus.get('user0'), 'followed');
  let naiveComparisons = 0;
  for (const user of users) {
    const key = user.handle.toLowerCase();
    for (const item of queue) {
      naiveComparisons += 1;
      if (String(item.handle || '').toLowerCase() === key) break;
    }
  }
  assert.ok(naiveComparisons > index.visits * 100);
});

test('empty local values stay authoritative and recovery rechecks before apply', () => {
  const present = {rows: [], monitor: {users: []}, profileCache: {}, commentTracking: {users: []}};
  assert.deepEqual(keysMissingFromLocal(present, STARTUP_DURABLE_KEYS), STARTUP_DURABLE_KEYS.filter(key => !localKeyPresent(present, key)));
  assert.equal(localKeyPresent(present, 'rows'), true);
  assert.equal(recoveredValueIfStillMissing(present, 'rows', [{handle: 'stale'}]), undefined);
  assert.deepEqual(keysMissingFromLocal({}, STARTUP_DURABLE_KEYS), STARTUP_DURABLE_KEYS);
  assert.deepEqual(recoveredValueIfStillMissing({}, 'rows', [{handle: 'restored'}]), [{handle: 'restored'}]);
  assert.equal(recoveredValueIfStillMissing({}, 'rows', null), undefined);
  assert.equal(recoveredValueIfStillMissing({rows: null}, 'rows', [{handle: 'restored'}]) === undefined, false);
  const raced = {commentTracking: {users: []}};
  assert.equal(recoveredValueIfStillMissing(raced, 'commentTracking', {users: [{handle: 'late-backup'}]}), undefined);
  assert.ok(LOG_DURABLE_KEYS.every(key => !STARTUP_DURABLE_KEYS.includes(key)));
});

test('startup does not paint hidden logs or read log backups before the scope exists', () => {
  const declaration = panelSource.indexOf('let currentLogsScope');
  const monitorLoad = panelSource.indexOf("chrome.storage.local.get('monitor')");
  assert.ok(declaration > 0 && declaration < monitorLoad);
  assert.equal(shouldPaintLogs(true), false);
  assert.equal(shouldPaintLogs(false), true);
  assert.equal(panelSource.includes("durableGet('autoFollowLogs')"), false);
  assert.equal(panelSource.includes("durableGet('monitorLogs')"), false);
  assert.equal(panelSource.includes("durableGet('unreciprocatedLogs')"), false);
  assert.equal(panelSource.includes('renderQueue();\n  renderMonitorList();'), false);
  assert.match(panelSource, /if \(!modal \|\| modal\.hidden\) return;/);
  assert.match(panelSource, /if \(!dashboardPanelVisible\('comments'\)\) return;/);
  assert.match(panelSource, /if \(!dashboardPanelVisible\('candidates'\)\) return;/);
  assert.match(panelSource, /if \(!dashboardPanelVisible\('unreciprocated'\)\) return;/);
  assert.match(panelSource, /if \(targets\.includes\('comments'\)\) \{ renderCommentTracking\(\); renderCommentAutoFollowSettings\(\); \}/);
  assert.match(panelSource, /recoveredValueIfStillMissing\(latest, key, recovered\)/);
  assert.match(panelSource, /shouldRescanMojibake\(restoredCount\)/);
  assert.match(panelSource, /loadDurableLogBuffer\(name,/);
  assert.match(panelSource, /tabRenderTargets\(activeDashboardTab, tab\)/);
  assert.match(panelSource, /localStorageChangePlan\(changes, area\)/);
});

test('mojibake rescan runs only after a startup record is restored', () => {
  assert.equal(shouldRescanMojibake(0), false);
  assert.equal(shouldRescanMojibake(1), true);
});

test('tab changes and storage events decide work by executing the plan', () => {
  assert.deepEqual(tabRenderTargets('monitor', 'monitor'), []);
  assert.deepEqual(tabRenderTargets('monitor', 'comments'), ['comments', 'commentSettings']);
  assert.deepEqual(tabRenderTargets('comments', 'unreciprocated'), ['unreciprocated']);
  assert.deepEqual(tabRenderTargets('comments', 'candidates'), ['mutual']);
  const idle = localStorageChangePlan({commentTracking: {newValue: {users: [{handle: 'A'}]}}}, 'sync');
  assert.equal(idle.commentRender, false);
  assert.equal(idle.commentTracking, null);
  const comment = localStorageChangePlan({
    commentTracking: {newValue: {users: [], posts: []}},
    monitor: {newValue: {users: []}}
  }, 'local');
  assert.equal(comment.commentRender, true);
  assert.deepEqual(comment.commentTracking, {users: [], posts: []});
  const logs = localStorageChangePlan({autoFollowLogs: {newValue: []}}, 'local');
  assert.deepEqual(logs.logs, []);
  assert.equal(logs.commentRender, false);
  const status = localStorageChangePlan({commentTrackingStatus: {newValue: null}}, 'local');
  assert.equal(status.commentStatus, null);
  assert.equal(status.commentRender, true);
});

test('log buffer load fails closed, keeps an empty local array, and retries', async () => {
  let localReads = 0;
  let durableReads = 0;
  const storage = {
    localGet: async () => {
      localReads += 1;
      throw new Error('transient');
    },
    durableGet: async () => {
      durableReads += 1;
      return [{id: 'backup'}];
    }
  };
  await assert.rejects(loadDurableLogBuffer('monitorLogs', storage), error => error.retryable === true && error.message === 'local log read failed');
  assert.equal(durableReads, 0);
  const tasks = {};
  const buffers = {};
  const assign = outcome => { buffers.monitorLogs = outcome.value; };
  await assert.rejects(takeLogBufferTask(tasks, 'monitorLogs', async () => {
    const outcome = await loadDurableLogBuffer('monitorLogs', storage);
    if (outcome.action === 'assign') assign(outcome);
  }));
  assert.equal(tasks.monitorLogs, undefined);
  assert.equal(buffers.monitorLogs, undefined);
  storage.localGet = async () => ({monitorLogs: []});
  const kept = await loadDurableLogBuffer('monitorLogs', storage);
  assert.equal(kept.action, 'assign');
  assert.deepEqual(kept.value, []);
  assert.equal(kept.persist, false);
  assert.equal(durableReads, 0);
  let appeared = false;
  storage.localGet = async () => {
    if (!appeared) return {};
    return {monitorLogs: [{id: 'live'}]};
  };
  storage.durableGet = async () => {
    durableReads += 1;
    appeared = true;
    return [{id: 'backup'}];
  };
  const raced = await loadDurableLogBuffer('monitorLogs', storage);
  assert.deepEqual(raced.value, [{id: 'live'}]);
  assert.equal(raced.persist, false);
  appeared = false;
  storage.localGet = async () => ({});
  storage.durableGet = async () => [{id: 'backup'}];
  const restored = await loadDurableLogBuffer('unreciprocatedLogs', storage);
  assert.deepEqual(restored.value, [{id: 'backup'}]);
  assert.equal(restored.persist, true);
  storage.durableGet = async () => { throw new Error('durable down'); };
  await assert.rejects(loadDurableLogBuffer('autoFollowLogs', storage), error => error.retryable === true);
  const loaded = await takeLogBufferTask(tasks, 'monitorLogs', async () => {
    buffers.monitorLogs = [{id: 'kept'}];
  });
  await loaded;
  assert.deepEqual(buffers.monitorLogs, [{id: 'kept'}]);
  const again = takeLogBufferTask(tasks, 'monitorLogs', async () => { buffers.monitorLogs = [{id: 'replaced'}]; });
  await again;
  assert.deepEqual(buffers.monitorLogs, [{id: 'kept'}]);
  assert.ok(localReads >= 1);
});
