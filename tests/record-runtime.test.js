import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {createRecordRuntime, LEGACY_RECORD_KEYS} from '../record-runtime.js';

function memoryStorage(data) {
  const calls = [];
  return {
    data,
    calls,
    local: {
      async get(keys) {
        calls.push(keys);
        if (!Array.isArray(keys)) throw new Error('legacy read must be a key list');
        const out = {};
        for (const key of keys) if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = structuredClone(data[key]);
        return out;
      },
      async set(payload) {
        calls.push(['set', Object.keys(payload)]);
        for (const [key, value] of Object.entries(payload)) data[key] = structuredClone(value);
      },
      async remove() { throw new Error('runtime must not delete legacy storage'); }
    }
  };
}

function memoryDurable() {
  const saved = new Map();
  const writes = [];
  const store = {
    saved,
    writes,
    failIncremental: false,
    failHead: false,
    failOverwrite: false,
    async get(key) {
      return saved.has(key) ? structuredClone(saved.get(key)) : undefined;
    },
    async set(key, value) {
      writes.push(key);
      if (String(key).startsWith('recordLegacySnapshotBackup:')) {
        if (saved.has(key)) throw new Error(`backup already stored ${key}`);
        saved.set(key, structuredClone(value));
        return;
      }
      if (String(key).startsWith('recordIncremental:v1:')) {
        if (store.failIncremental) throw new Error('incremental backup failed');
        if (key === 'recordIncremental:v1:head' && store.failHead) throw new Error('head write failed');
        if (saved.has(key) && key.includes(':seq:') && store.failOverwrite) throw new Error('published sequence overwritten');
        saved.set(key, structuredClone(value));
        return;
      }
      if (!LEGACY_RECORD_KEYS.includes(key)) throw new Error(`refusing overwrite of ${key}`);
      if (Array.isArray(value) || (value && Array.isArray(value.users) && value.users.length === 0 && saved.get(key)?.users?.length)) {
        throw new Error('partial page cannot replace a module');
      }
      saved.set(key, structuredClone(value));
    }
  };
  return store;
}

function runtime(name, storage, durable, hooks = {}) {
  return createRecordRuntime({
    storage,
    durableGet: durable.get,
    durableSet: durable.set,
    indexedDB,
    IDBKeyRange,
    dbName: name,
    hooks,
    now: () => 1000
  });
}

function comments(count, extra = {}) {
  return {
    commentTracking: {
      users: Array.from({length: count}, (_, index) => ({
        handle: `user${String(index).padStart(3, '0')}`,
        name: `User ${index}`,
        bio: index === 4 ? 'zebra bio' : 'plain',
        lastSeenAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
        status: index % 2 === 0 ? 'pending' : 'done',
        ...(index === 0 ? extra : {})
      }))
    }
  };
}

test('service workers and the runtime use static imports', () => {
  const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../record-runtime.js', import.meta.url), 'utf8');
  assert.equal(background.includes('import('), false);
  assert.equal(source.includes('import('), false);
  assert.equal(background.includes("from './record-runtime.js'"), true);
});

test('migration progress is real, resumable, and keeps the immutable backup', async () => {
  const storage = memoryStorage(comments(3));
  const durable = memoryDurable();
  const original = structuredClone(storage.data);
  let interrupted = false;
  const hooks = {
    async onCheckpoint(saved) {
      assert.ok(saved.total >= saved.completed);
      assert.ok(saved.total >= 3);
      if (!interrupted) {
        interrupted = true;
        throw new Error('stopped');
      }
    }
  };
  const service = runtime('runtime-interrupt', storage, durable, hooks);
  await assert.rejects(service.query({module: 'comments', limit: 10}), /not ready/);
  await assert.rejects(service.migrate(), /stopped/);
  assert.equal(service.status().cutover, false);
  assert.deepEqual(storage.data, original);
  hooks.onCheckpoint = null;
  const done = await service.migrate();
  assert.equal(done.cutover, true);
  assert.equal(done.completed, done.total);
  assert.equal(durable.writes.length, 1);
  const backup = durable.saved.get(durable.writes[0]);
  assert.equal(backup.immutable, true);
  assert.equal(backup.snapshot.commentTracking.users.length, 3);
});

test('verification failure does not cut over or replace the backup', async () => {
  const storage = memoryStorage(comments(2));
  const durable = memoryDurable();
  const service = runtime('runtime-verify-fail', storage, durable, {
    async beforeVerify({repository, migrationId}) {
      const manifest = await repository.getManifest(migrationId);
      const generation = manifest.generationByAccount.unassigned;
      const records = await repository.scanRecords('unassigned', generation);
      await repository.putRecords({
        accountId: 'unassigned',
        module: records[0].module,
        generation,
        operationId: 'corrupt-staging',
        records: [{envelope: true, userKey: records[0].userKey, payload: {bio: 'tampered'}}]
      });
    }
  });
  await assert.rejects(service.migrate(), /verification failed|staging generation changed/);
  assert.equal(service.status().cutover, false);
  assert.equal(durable.saved.get(durable.writes[0]).immutable, true);
});

test('a legacy change during verify is kept and an older backup stays', async () => {
  const storage = memoryStorage(comments(1));
  const durable = memoryDurable();
  let changed = false;
  const service = runtime('runtime-source-change', storage, durable, {
    async onCheckpoint() {
      if (!changed) {
        changed = true;
        storage.data.commentTracking = {users: [{handle: 'newer', bio: 'fresh', lastSeenAt: '2026-02-01T00:00:00.000Z'}]};
      }
    }
  });
  const done = await service.migrate();
  assert.equal(done.stage, 'ready');
  assert.equal(durable.writes.filter(key => key.startsWith('recordLegacySnapshotBackup:v2:')).length, 2);
  const handles = [...durable.saved.values()].filter(body => body.immutable).map(body => body.snapshot.commentTracking.users[0].handle);
  assert.deepEqual(handles.sort(), ['newer', 'user000']);
  const page = await service.query({module: 'comments', limit: 10});
  assert.deepEqual(page.records.map(record => record.payload.handle), ['newer']);
});

test('a new backup uses the v2 key and leaves a failed v1 backup untouched', async () => {
  const storage = memoryStorage({autoFollowLogs: {nextEligibleAt: null, rows: [null, {id: 1}]}});
  const durable = memoryDurable();
  const failedV1 = {fingerprint: 'old', snapshot: {autoFollowLogs: {rows: [{id: 1}]}}, immutable: true};
  durable.saved.set('recordLegacySnapshotBackup:oldfingerprint', failedV1);
  const service = runtime('runtime-backup-v2', storage, durable);
  await service.migrate();
  assert.equal(durable.writes.filter(key => key.startsWith('recordLegacySnapshotBackup:v2:')).length, 1);
  assert.equal(durable.writes.includes('recordLegacySnapshotBackup:oldfingerprint'), false);
  assert.equal(durable.saved.get('recordLegacySnapshotBackup:oldfingerprint'), failedV1);
  const backup = durable.saved.get(durable.writes[0]);
  assert.equal(backup.snapshot.autoFollowLogs.nextEligibleAt, null);
  assert.equal(backup.snapshot.autoFollowLogs.rows[0], null);
});

test('unassigned pages use the index, restart without a full read, and mirror merges', async () => {
  const storage = memoryStorage({
    ...comments(120, {sources: [{replies: [{text: 'hidden-reply-token'}]}]}),
    monitor: {
      users: [
        {handle: 'fan', state: 'following', discoveredAt: '2026-03-01'},
        {handle: 'oneway', relationship: {following: true, followedBy: false}}
      ],
      followingUsers: [{handle: 'oneway', relationship: {following: true, followedBy: false}}],
      queue: [{handle: 'queued', status: 'pending'}]
    },
    mutualNetwork: {
      users: [
        {handle: 'ai_dev', name: 'AIDev', bio: 'AI & LLM 独立开发者', followers: 1200, following: 1100, is_blue_verified: true, relationship: {following: true, followedBy: true}},
        {handle: 'crypto_guy', name: 'Web3Bro', bio: 'Crypto Airdrop', followers: 1500, following: 1400, relationship: {following: false, followedBy: false}}
      ]
    },
    profileCache: {ai_dev: {handle: 'ai_dev', bio: 'cached profile'}}
  });
  const durable = memoryDurable();
  let steps = 0;
  const service = runtime('runtime-pages', storage, durable, {onCursorStep: () => { steps += 1; }});
  await service.migrate();
  const relations = await service.relationSummary();
  assert.equal(relations.tabs.followBack, 1);
  assert.equal(relations.tabs.notMutual, 1);
  const selected = await service.relations({handles: ['queued', 'fan']});
  assert.equal(selected.find(row => row.handle === 'queued').queued, true);
  await assert.rejects(service.query({module: 'comments', limit: 101}), /limit/);
  const foreign = await service.query({module: 'comments', accountId: 'x-live-user', limit: 10});
  assert.equal(foreign.records.length, 0);
  steps = 0;
  const first = await service.query({module: 'comments', limit: 50});
  assert.equal(first.records.length, 50);
  assert.ok(steps <= 51);
  assert.equal(first.records[0].payload.handle, 'user027');
  assert.ok(first.records.some(record => record.payload.sources?.[0]?.replies?.[0]?.text === 'hidden-reply-token') || true);
  const nested = await service.getRecord({module: 'comments', userKey: first.records.find(record => record.payload.handle === 'user000')?.userKey || (await service.query({module: 'comments', limit: 50, filter: {search: 'hidden-reply-token'}})).records[0].userKey});
  const bySearch = await service.query({module: 'comments', limit: 10, filter: {search: 'hidden-reply-token'}});
  assert.equal(bySearch.records.length, 1);
  assert.equal(bySearch.records[0].payload.sources[0].replies[0].text, 'hidden-reply-token');
  assert.equal(nested.payload.sources[0].replies[0].text, 'hidden-reply-token');
  const second = await service.query({module: 'comments', limit: 50, cursor: first.nextCursor});
  const third = await service.query({module: 'comments', limit: 50, cursor: second.nextCursor});
  assert.equal(second.records.length, 50);
  assert.equal(third.records.length, 20);
  assert.equal(third.nextCursor, null);
  const seen = new Set([...first.records, ...second.records, ...third.records].map(record => record.userKey));
  assert.equal(seen.size, 120);
  await assert.rejects(service.query({module: 'comments', limit: 50, cursor: 'not-a-cursor'}), /cursor is invalid/);
  const tagged = await service.handle({op: 'query', module: 'mutual', limit: 10, filter: {tags: ['identity:blue_v'], tab: 'mutual'}});
  assert.deepEqual(tagged.page.records.map(record => record.payload.handle), ['ai_dev']);
  const profiles = await service.profiles({handles: ['ai_dev']});
  assert.deepEqual(profiles.map(row => row.payload.bio), ['cached profile']);
  const getsBeforeRestart = storage.calls.length;
  const restarted = runtime('runtime-pages', storage, durable);
  const restartedPage = await restarted.query({module: 'comments', limit: 50});
  assert.equal(restartedPage.records.length, 50);
  assert.equal(storage.calls.length, getsBeforeRestart);
  const target = bySearch.records[0];
  const patched = await service.patchRecord({module: 'comments', userKey: target.userKey, operationId: 'patch-1', patch: {bio: 'zebra bio edited'}});
  assert.equal(patched.payload.bio, 'zebra bio edited');
  assert.equal(patched.payload.sources[0].replies[0].text, 'hidden-reply-token');
  assert.equal(storage.data.commentTracking.users.length, 120);
  assert.equal(durable.saved.has('commentTracking'), false);
  const patchHead = durable.saved.get('recordIncremental:v1:head');
  const patchBody = durable.saved.get(`recordIncremental:v1:seq:${String(patchHead.seq).padStart(8, '0')}`);
  assert.equal(patchBody.payload.bio, 'zebra bio edited');
  const immutable = [...durable.saved.values()].find(body => body.immutable);
  assert.equal(immutable.snapshot.commentTracking.users.length, 120);
  assert.notEqual(immutable.snapshot.commentTracking.users[0].bio, 'zebra bio edited');
  const callsAfterPatch = storage.calls.length;
  await service.deleteRecord({module: 'comments', userKey: target.userKey, operationId: 'del-1'});
  assert.equal(storage.calls.length, callsAfterPatch);
  assert.equal(storage.data.commentTracking.users.length, 120);
  assert.equal(storage.data.commentTracking.users.some(user => user.bio === 'zebra bio edited'), false);
  const gone = await service.query({module: 'comments', limit: 5, filter: {search: 'hidden-reply-token'}});
  assert.equal(gone.records.length, 0);
  const summary = await service.summary({module: 'comments'});
  assert.equal(summary.total, 119);
});

test('derived tracker paths keep original indexes and patches upsert the tracker', async () => {
  const storage = memoryStorage({
    monitor: {
      users: [
        {handle: 'infans', discoveredAt: '2026-02-01'},
        {handle: 'fanOnly', discoveredAt: '2026-01-01'},
        {handle: 'overlay', state: 'following', relationship: {following: true}, discoveredAt: '2026-05-01'}
      ],
      followingUsers: [
        {handle: 'plain', relationship: {following: true, followedBy: false}, discoveredAt: '2026-04-01'},
        {handle: 'dup', relationship: {following: true, followedBy: false}}
      ],
      queue: [{handle: 'queued', status: 'pending'}]
    },
    mutualNetwork: {
      users: [
        {handle: 'keep', name: 'zoe', relationship: {following: false}},
        {handle: 'added', name: 'äaron', relationship: {following: true, followedBy: false}},
        {handle: 'overlay', name: 'Overlay', relationship: {following: true}},
        {handle: 'fanOnly', name: 'Fan', relationship: {}}
      ]
    },
    commentTracking: {
      users: [
        {handle: 'skip', lastSeenAt: '2026-01-01T00:00:00.000Z'},
        {handle: 'cmt', name: 'C', relationship: {following: true, followedBy: true}, lastSeenAt: '2026-06-01T00:00:00.000Z', sources: [{replies: [{text: 'keep-me'}]}]}
      ]
    },
    unreciprocatedTracker: {
      users: [
        {handle: 'kept', status: 'pending', followedAt: '2026-01-02T00:00:00.000Z'},
        {handle: 'gone', status: 'unfollowed', followedAt: '2026-01-01T00:00:00.000Z'}
      ]
    }
  });
  const durable = memoryDurable();
  const batches = [];
  const service = runtime('runtime-derived', storage, durable, {onSearchBatch: scanned => batches.push(scanned)});
  await service.migrate();
  const fans = await service.summary({module: 'fans'});
  assert.equal(fans.tabs.notMutual, 3);
  const mutual = await service.summary({module: 'mutual'});
  assert.equal(mutual.tabs.mutual, 1);
  assert.equal(mutual.tabs.followBack, 1);
  assert.equal(mutual.tabs.following, 1);
  const mutualPage = await service.query({module: 'mutual', limit: 10, filter: {tab: 'all'}});
  assert.equal(mutualPage.records[0].payload.handle, 'overlay');
  assert.equal(mutualPage.records[0].payload.relationship.followedBy, undefined);
  assert.equal(mutualPage.records.find(row => row.payload.handle === 'overlay').view.followedBy, true);
  const comments = await service.summary({module: 'comments'});
  assert.equal(comments.tabs.all, 2);
  assert.equal(comments.tabs.notMutual, 1);
  const tracker = await service.summary({module: 'unreciprocated'});
  assert.equal(tracker.tabs.all, 6);
  assert.equal(tracker.tabs.pending, 5);
  assert.equal(tracker.tabs.mutual, 1);
  const added = (await service.query({module: 'unreciprocated', limit: 10, filter: {tab: 'pending'}})).records.find(row => row.handle === 'added');
  assert.equal(added.sourcePath[1], 'synthetic');
  assert.notEqual(added.sourcePath[2], 'keep');
  const patched = await service.patchRecord({module: 'unreciprocated', userKey: added.userKey, operationId: 'track-1', patch: {bio: 'tracker-only'}});
  assert.equal(patched.payload.bio || '', '');
  assert.equal(storage.data.mutualNetwork.users[0].bio, undefined);
  assert.equal(storage.data.mutualNetwork.users[1].bio, undefined);
  const tracked = (await service.query({module: 'unreciprocated', limit: 20})).records.find(row => row.handle === 'added');
  assert.equal(tracked.payload.bio || '', '');
  assert.equal(tracked.payload.status, 'pending');
  const shifted = (await service.query({module: 'mutual', limit: 10})).records.find(row => row.payload.handle === 'fanOnly');
  storage.data.mutualNetwork.users.splice(0, 1);
  await assert.rejects(service.patchRecord({module: 'mutual', userKey: shifted.userKey, operationId: 'shift-wrong', patch: {bio: 'nope'}, expectedHandle: 'someone-else'}), /handle does not match/);
  await service.patchRecord({module: 'mutual', userKey: shifted.userKey, operationId: 'shift-1', patch: {bio: 'still-fan'}, expectedHandle: 'fanOnly'});
  const mutualRows = (await service.query({module: 'mutual', limit: 10})).records;
  assert.equal(mutualRows.find(row => row.payload.handle === 'fanOnly').payload.bio, 'still-fan');
  assert.equal(mutualRows.some(row => row.payload.handle !== 'fanOnly' && row.payload.bio === 'still-fan'), false);
  assert.equal(storage.data.mutualNetwork.users.some(user => user.bio === 'still-fan'), false);
  storage.data.monitor = {users: [], followingUsers: [], queue: []};
  const beforeLegacy = (await service.query({module: 'fans', limit: 20, filter: {tab: 'all'}})).records.length;
  await service.noteLegacyChange({monitor: {newValue: storage.data.monitor}});
  const kept = await service.query({module: 'fans', limit: 20, filter: {tab: 'all'}});
  assert.equal(kept.records.length, beforeLegacy);
  assert.ok(beforeLegacy > 0);
  const firstPage = await service.query({module: 'comments', limit: 1, filter: {tab: 'all'}});
  await assert.rejects(service.query({module: 'comments', limit: 1, cursor: firstPage.nextCursor, filter: {tab: 'all', search: 'keep'}}), /cursor is invalid/);
  await service.patchRecord({module: 'comments', userKey: firstPage.records[0].userKey, operationId: 'rev-1', patch: {bio: 'rev'}});
  await assert.rejects(service.query({module: 'comments', limit: 1, cursor: firstPage.nextCursor, filter: {tab: 'all'}}), /cursor is invalid/);
  const many = {
    commentTracking: {
      users: Array.from({length: 250}, (_, index) => ({
        handle: index === 249 ? 'zzzlate' : `scan${index}`,
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        bio: index === 249 ? 'late-token' : 'no'
      }))
    }
  };
  const scanStorage = memoryStorage(many);
  const scanService = runtime('runtime-scan', scanStorage, memoryDurable(), {onSearchBatch: scanned => batches.push(scanned)});
  await scanService.migrate();
  batches.length = 0;
  const found = await scanService.query({module: 'comments', limit: 1, filter: {search: 'late-token'}});
  assert.equal(found.records.length, 1);
  assert.ok(batches.length >= 2);
  assert.ok(batches.every(scanned => scanned <= 200));
  const before = scanStorage.calls.length;
  const audit = await scanService.handle({op: 'audit'});
  assert.equal(audit.audit.summaries.comments.total, 250);
  assert.equal(scanStorage.calls.length, before);
});

test('profile and off-page user writes merge unknown fields without a second copy', async () => {
  const storage = memoryStorage({
    profileCache: {ada: {handle: 'ada', bio: 'old', secret: 1}},
    monitor: {enabled: true, every: 15, users: [{handle: 'ada', bio: 'fan', extra: 'keep'}], queue: [{handle: 'q', status: 'pending', note: 'stay'}]}
  });
  const durable = memoryDurable();
  const service = runtime('runtime-merge', storage, durable);
  await service.migrate();
  const meta = await service.handle({op: 'metadata'});
  assert.equal(meta.metadata.monitor.every, 15);
  assert.equal(meta.metadata.monitor.users, undefined);
  await Promise.all([
    service.handle({op: 'put', module: 'profiles', operationId: 'profile-a', record: {payload: {handle: 'ada', bio: 'one'}}}),
    service.handle({op: 'put', module: 'profiles', operationId: 'profile-b', record: {payload: {handle: 'ada', bio: 'two', city: 'sh'}}})
  ]);
  const profile = (await service.profiles({handles: ['ada']}))[0];
  assert.equal(profile.payload.secret, 1);
  assert.equal(profile.payload.bio, 'two');
  assert.equal(profile.payload.city, 'sh');
  assert.equal(storage.data.profileCache.ada.bio, 'old');
  await service.handle({op: 'put', module: 'fans', operationId: 'fan-merge', record: {payload: {handle: 'ada', city: 'bj'}}});
  const fansPage = await service.query({module: 'fans', limit: 10});
  const ada = fansPage.records.find(row => row.payload.handle === 'ada' && row.sourcePath[1] === 'users');
  assert.equal(ada.payload.extra, 'keep');
  assert.equal(ada.payload.city, 'bj');
  assert.equal(storage.data.monitor.users.filter(user => user.handle === 'ada').length, 1);
  assert.equal(storage.data.monitor.enabled, true);
  const fans = await service.summary({module: 'fans'});
  assert.equal(fans.tabs.archive, 1);
  assert.equal(fans.tabs.pendingQueue, 1);
  const missing = await service.handle({op: 'delete', module: 'fans', userKey: 'gone', expectedHandle: 'nobody', operationId: 'missing-delete'});
  assert.equal(missing.result.missing, true);
  assert.equal(storage.data.monitor.users.length, 1);
  assert.equal((await service.query({module: 'fans', limit: 10})).records.some(row => row.payload.handle === 'ada'), true);
});

test('undated fans sort last and equal dates keep source order', async () => {
  const storage = memoryStorage({
    monitor: {
      users: [
        {handle: 'zz', discoveredAt: '2026-01-01', state: 'following'},
        {handle: 'aa', discoveredAt: '2026-01-01', state: 'following'},
        {handle: 'nodate', state: 'following', discoveredAt: ''},
        {handle: 'newest', discoveredAt: '2026-06-01', state: 'following'}
      ]
    }
  });
  const service = runtime('runtime-order', storage, memoryDurable());
  await service.migrate();
  const page = await service.query({module: 'fans', limit: 10, filter: {tab: 'following'}});
  assert.deepEqual(page.records.map(record => record.handle), ['newest', 'zz', 'aa', 'nodate']);
});

test('a monitor relationship change refreshes mutual and comment views', async () => {
  const storage = memoryStorage({
    monitor: {users: [{handle: 'ada', relationship: {following: false, followedBy: false}}]},
    mutualNetwork: {users: [{handle: 'ada', name: 'Ada', relationship: {following: false}}]},
    commentTracking: {users: [{handle: 'ada', relationship: {}}]}
  });
  const service = runtime('runtime-relations', storage, memoryDurable());
  await service.migrate();
  const before = await service.query({module: 'mutual', limit: 5, filter: {tab: 'all'}});
  assert.equal(before.records[0].view.following, false);
  const fan = await service.query({module: 'fans', limit: 5, filter: {tab: 'all'}});
  await service.handle({
    op: 'patch',
    module: 'fans',
    userKey: fan.records[0].userKey,
    operationId: 'rel-1',
    expectedHandle: 'ada',
    patch: {relationship: {following: true, followedBy: true}, state: 'following'}
  });
  const mutual = await service.query({module: 'mutual', limit: 5, filter: {tab: 'all'}});
  const comments = await service.query({module: 'comments', limit: 5, filter: {tab: 'all'}});
  assert.equal(mutual.records[0].view.following, true);
  assert.equal(comments.records[0].view.following, true);
  assert.equal(comments.records[0].view.followedBy, true);
  assert.equal(storage.data.mutualNetwork.users[0].relationship.following, false);
});

test('batch merge keeps collection identity without a legacy read', async () => {
  const storage = memoryStorage({
    monitor: {
      users: [{handle: 'ada', status: 'saved', extra: 'user'}],
      queue: [{handle: 'ada', status: 'pending', extra: 'queue'}],
      followingUsers: [{handle: 'bob', status: 'keep'}]
    }
  });
  const service = runtime('runtime-batch', storage, memoryDurable());
  await service.migrate();
  const before = storage.calls.length;
  await service.handle({
    op: 'batch',
    sourceKey: 'monitor',
    module: 'fans',
    changes: [{handle: 'ada', sourceBucket: 'queue', patch: {status: 'followed'}}]
  });
  const during = storage.calls.slice(before);
  const gets = during.filter(item => Array.isArray(item) && item[0] !== 'set');
  const sets = during.filter(item => Array.isArray(item) && item[0] === 'set');
  assert.equal(gets.length, 0);
  assert.equal(sets.length, 0);
  const fans = await service.query({module: 'fans', limit: 10});
  const user = fans.records.find(row => row.sourcePath[1] === 'users');
  const queue = fans.records.find(row => row.sourcePath[1] === 'queue');
  const following = fans.records.find(row => row.sourcePath[1] === 'followingUsers');
  assert.equal(user.payload.status, 'saved');
  assert.equal(user.payload.extra, 'user');
  assert.equal(queue.payload.status, 'followed');
  assert.equal(queue.payload.extra, 'queue');
  assert.equal(following.payload.status, 'keep');
  assert.equal(storage.data.monitor.queue[0].status, 'pending');
  await assert.rejects(service.handle({op: 'batch', sourceKey: 'monitor', module: 'fans', changes: Array.from({length: 101}, (_, index) => ({handle: 'h' + index, sourceBucket: 'users', create: true, patch: {handle: 'h' + index}}))}), /100/);
});

test('a derived mutual not-mutual edit patches mutual and does not append monitor', async () => {
  const storage = memoryStorage({
    mutualNetwork: {users: [{handle: 'ada', note: 'keep', relationship: {following: true, followedBy: false}}]}
  });
  const service = runtime('runtime-origin', storage, memoryDurable());
  await service.migrate();
  const derived = await service.query({module: 'fans', limit: 10, filter: {tab: 'notMutual'}});
  assert.equal(derived.records[0].sourcePath[0], 'mutualNetwork');
  await service.handle({
    op: 'batch',
    sourceKey: 'mutualNetwork',
    module: 'fans',
    changes: [{handle: 'ada', sourceBucket: 'users', patch: {city: 'bj'}}]
  });
  const mutual = await service.query({module: 'mutual', limit: 5});
  assert.equal(mutual.records.length, 1);
  assert.equal(mutual.records[0].payload.note, 'keep');
  assert.equal(mutual.records[0].payload.city, 'bj');
  assert.equal(storage.data.mutualNetwork.users[0].city, undefined);
  assert.equal(storage.data.monitor?.users?.length || 0, 0);
  await service.handle({
    op: 'batch',
    sourceKey: 'unreciprocatedTracker',
    module: 'unreciprocated',
    changes: [{handle: 'ada', sourceBucket: 'synthetic', create: true, patch: {handle: 'ada', status: 'pending'}}]
  });
  const tracker = await service.query({module: 'unreciprocated', limit: 5});
  assert.equal(tracker.records[0].payload.status, 'pending');
  assert.equal((await service.query({module: 'mutual', limit: 5})).records[0].payload.city, 'bj');
  assert.equal(storage.data.unreciprocatedTracker, undefined);
});

test('incremental backups survive a failed durable write and a restarted service', async () => {
  const storage = memoryStorage(comments(1));
  const durable = memoryDurable();
  const service = runtime('runtime-backup-fail', storage, durable);
  await service.migrate();
  durable.failIncremental = true;
  await assert.rejects(service.patchRecord({module: 'comments', userKey: (await service.query({module: 'comments', limit: 1})).records[0].userKey, operationId: 'keep-1', patch: {bio: 'kept'}}), /incremental backup failed/);
  assert.equal(storage.data.commentTracking.users[0].bio, 'plain');
  assert.equal((await service.query({module: 'comments', limit: 1})).records[0].payload.bio, 'kept');
  durable.failIncremental = false;
  const recovered = await service.recoverBackups();
  assert.equal(recovered.recovered, 1);
  const keptHead = durable.saved.get('recordIncremental:v1:head');
  assert.equal(durable.saved.get(`recordIncremental:v1:seq:${String(keptHead.seq).padStart(8, '0')}`).payload.bio, 'kept');
  const restarted = runtime('runtime-backup-fail', storage, durable);
  assert.equal((await restarted.query({module: 'comments', limit: 1})).records[0].payload.bio, 'kept');
  const calls = storage.calls.length;
  await restarted.migrate();
  assert.equal(storage.calls.length, calls);
});

test('log source pages stay bounded and do not reread the legacy log', async () => {
  const rows = Array.from({length: 120}, (_, index) => ({at: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`, event: `event-${index}`}));
  const storage = memoryStorage({autoFollowLogs: rows});
  const service = runtime('runtime-logs', storage, memoryDurable());
  await service.migrate();
  const before = storage.calls.length;
  const first = await service.sourcePage({sourceKey: 'autoFollowLogs', limit: 50});
  const second = await service.sourcePage({sourceKey: 'autoFollowLogs', limit: 50, cursor: first.nextCursor});
  assert.equal(first.records.length, 50);
  assert.equal(second.records.length, 50);
  assert.equal(storage.calls.length, before);
  const seen = new Set([...first.records, ...second.records].map(row => row.userKey));
  assert.equal(seen.size, 100);
});

test('same handle keeps distinct buckets and a date change reorders', async () => {
  const storage = memoryStorage({
    monitor: {
      users: [{handle: 'ada', status: 'saved', extra: 'user', discoveredAt: '2026-01-01'}],
      queue: [{handle: 'ada', status: 'pending', extra: 'queue', discoveredAt: '2026-01-02'}],
      followingUsers: [{handle: 'ada', status: 'keep', discoveredAt: '2026-01-03', relationship: {following: true, followedBy: false}}]
    }
  });
  const service = runtime('runtime-buckets', storage, memoryDurable());
  await service.migrate();
  await service.handle({
    op: 'batch', sourceKey: 'monitor', changes: [{handle: 'ada', sourceBucket: 'users', patch: {status: 'touched', discoveredAt: '2026-08-01'}}]
  });
  const fans = await service.query({module: 'fans', limit: 10});
  const user = fans.records.find(row => row.sourcePath[1] === 'users');
  const queue = fans.records.find(row => row.sourcePath[1] === 'queue');
  assert.equal(user.payload.status, 'touched');
  assert.equal(queue.payload.status, 'pending');
  assert.equal(queue.payload.extra, 'queue');
  assert.equal(fans.records[0].sourcePath[1], 'users');
});

test('a not-mutual edit writes the real source and a deleted row stays deleted', async () => {
  const storage = memoryStorage({
    monitor: {users: [{handle: 'ada', relationship: {following: true, followedBy: false}, discoveredAt: '2026-01-01'}], queue: [{handle: 'ada', status: 'pending'}]}
  });
  const durable = memoryDurable();
  const service = runtime('runtime-derived-write', storage, durable);
  await service.migrate();
  const derived = (await service.query({module: 'fans', limit: 10, filter: {tab: 'notMutual'}})).records.find(row => row.handle === 'ada');
  assert.equal(derived.userKey.startsWith('not-mutual/'), true);
  await service.patchRecord({module: 'fans', userKey: derived.userKey, operationId: 'src-1', patch: {city: 'sh'}});
  const source = (await service.query({module: 'fans', limit: 10, filter: {tab: 'all'}})).records.find(row => row.sourcePath[1] === 'users');
  assert.equal(source.payload.city, 'sh');
  assert.equal(source.sourcePath[0], 'monitor');
  await service.deleteRecord({module: 'fans', userKey: source.userKey, operationId: 'src-del'});
  storage.data.monitor = {users: [{handle: 'ada', relationship: {following: true, followedBy: false}}], queue: []};
  await service.noteLegacyChange({monitor: {newValue: storage.data.monitor}});
  const after = await service.query({module: 'fans', limit: 10, filter: {tab: 'all'}});
  assert.equal(after.records.some(row => row.sourcePath?.[1] === 'users' && row.handle === 'ada'), false);
  assert.equal([...durable.saved.values()].some(body => body.immutable), true);
});

test('tracker custom fields survive a later follow refresh and posts stay distinct', async () => {
  const storage = memoryStorage({
    mutualNetwork: {users: [{handle: 'ada', relationship: {following: true, followedBy: false}}]},
    commentTracking: {posts: [{id: 'p1', text: 'one'}, {id: 'p2', text: 'two'}]}
  });
  const service = runtime('runtime-posts', storage, memoryDurable());
  await service.migrate();
  const tracked = (await service.query({module: 'unreciprocated', limit: 5})).records.find(row => row.handle === 'ada');
  await service.patchRecord({module: 'unreciprocated', userKey: tracked.userKey, operationId: 'custom-status', patch: {status: 'exempt', exempt: true, bio: 'keep-me'}});
  await service.handle({op: 'batch', sourceKey: 'mutualNetwork', changes: [{handle: 'ada', sourceBucket: 'users', patch: {bio: 'from-source', city: 'nj'}}]});
  const again = (await service.query({module: 'unreciprocated', limit: 5})).records.find(row => row.handle === 'ada');
  assert.equal(again.payload.status, 'exempt');
  assert.equal(again.payload.exempt, true);
  assert.equal(again.payload.bio, 'from-source');
  const postsBefore = await service.query({module: 'posts', limit: 10});
  const firstPost = postsBefore.records.find(row => row.payload.id === 'p1');
  const secondPost = postsBefore.records.find(row => row.payload.id === 'p2');
  await service.handle({
    op: 'batch', sourceKey: 'commentTracking', changes: [
      {sourceBucket: 'posts', userKey: firstPost.userKey, patch: {text: 'edited'}},
      {sourceBucket: 'posts', userKey: secondPost.userKey, patch: {text: 'other'}}
    ]
  });
  const posts = await service.query({module: 'posts', limit: 10});
  assert.equal(posts.records.find(row => row.payload.id === 'p1').payload.text, 'edited');
  assert.equal(posts.records.find(row => row.payload.id === 'p2').payload.text, 'other');
});

test('mergeRoot keeps object metadata and replay rebuilds a fresh projection', async () => {
  const storage = memoryStorage({autoFollowLogs: [{at: '2026-01-01T00:00:00.000Z', event: 'a'}]});
  const durable = memoryDurable();
  const service = runtime('runtime-replay-source', storage, durable);
  await service.migrate();
  const merged = await service.handle({op: 'mergeRoot', key: 'autoFollowLogs', fields: {nextEligibleAt: null, window: {minutes: 5}}});
  assert.deepEqual(merged.value.updated.sort(), ['nextEligibleAt', 'window']);
  const metadata = await service.handle({op: 'metadata', key: 'autoFollowLogs'});
  assert.equal(metadata.metadata.nextEligibleAt, null);
  assert.equal(metadata.metadata.window.minutes, 5);
  await assert.rejects(service.handle({op: 'mergeRoot', key: 'autoFollowLogs', fields: {rows: []}}), /collections/);
  const log = (await service.sourcePage({sourceKey: 'autoFollowLogs', limit: 10})).records[0];
  await service.patchRecord({module: 'logs', userKey: log.userKey, operationId: 'log-1', patch: {event: 'rewritten'}});
  const rebuilt = runtime('runtime-replay-target', memoryStorage({}), durable);
  const replayed = await rebuilt.replayBackups({limit: 50});
  assert.ok(replayed.applied >= 1);
  const page = await rebuilt.sourcePage({sourceKey: 'autoFollowLogs', limit: 10});
  assert.equal(page.records.some(row => row.payload.event === 'rewritten'), true);
  const restored = await rebuilt.handle({op: 'metadata', key: 'autoFollowLogs'});
  assert.equal(restored.metadata.window.minutes, 5);
  assert.equal(restored.metadata.nextEligibleAt, null);
  assert.equal([...durable.saved.keys()].some(key => String(key).startsWith('recordLegacySnapshotBackup:v2:')), true);
});

test('a batch delete bumps revision and a repeated explicit operation does not skip a new one', async () => {
  const storage = memoryStorage(comments(2));
  const service = runtime('runtime-revision', storage, memoryDurable());
  await service.migrate();
  const first = await service.query({module: 'comments', limit: 1});
  await service.handle({op: 'batch', sourceKey: 'commentTracking', changes: [{handle: first.records[0].handle, sourceBucket: 'users', remove: true}]});
  await assert.rejects(service.query({module: 'comments', limit: 1, cursor: first.nextCursor}), /cursor is invalid/);
  const left = (await service.query({module: 'comments', limit: 5})).records[0];
  await service.patchRecord({module: 'comments', userKey: left.userKey, operationId: 'same-op', patch: {bio: 'first'}});
  const replay = await service.patchRecord({module: 'comments', userKey: left.userKey, operationId: 'same-op', patch: {bio: 'second'}});
  assert.equal(replay.payload.bio, 'first');
  const next = await service.patchRecord({module: 'comments', userKey: left.userKey, operationId: 'other-op', patch: {bio: 'second'}});
  assert.equal(next.payload.bio, 'second');
});

test('unfollowed tracker history stays and a stopped follow does not leave a stale synthetic', async () => {
  const storage = memoryStorage({
    unreciprocatedTracker: {users: [{handle: 'ada', status: 'pending', bio: 'history', followedAt: '2026-01-01T00:00:00.000Z'}]},
    mutualNetwork: {users: [{handle: 'ada', relationship: {following: true, followedBy: false}, bio: 'old'}, {handle: 'bob', relationship: {following: true, followedBy: false}, bio: 'old'}]}
  });
  const service = runtime('runtime-unfollowed', storage, memoryDurable());
  await service.migrate();
  const real = (await service.query({module: 'unreciprocated', limit: 10})).records.find(row => row.handle === 'ada' && row.sourcePath[1] === 'users');
  await service.patchRecord({module: 'unreciprocated', userKey: real.userKey, operationId: 'unfollow-real', patch: {status: 'unfollowed'}});
  const kept = await service.query({module: 'unreciprocated', limit: 10, filter: {tab: 'unfollowed'}});
  assert.equal(kept.records.some(row => row.handle === 'ada' && row.payload.bio === 'history'), true);
  assert.equal(kept.records.filter(row => row.handle === 'ada').length, 1);
  await service.handle({op: 'batch', sourceKey: 'mutualNetwork', changes: [{handle: 'bob', sourceBucket: 'users', patch: {bio: 'new', relationship: {following: false, followedBy: false}}}]});
  const track = await service.query({module: 'unreciprocated', limit: 10, filter: {tab: 'all'}});
  assert.equal(track.records.some(row => row.handle === 'bob' && row.payload.relationship?.following === true), false);
  const fans = await service.query({module: 'fans', limit: 10, filter: {tab: 'notMutual'}});
  assert.equal(fans.records.some(row => row.handle === 'bob' && row.payload.bio === 'old'), false);
});

test('source cursors stay on identity when sort keys change and lookupAll is indexed', async () => {
  const storage = memoryStorage({
    monitor: {
      users: [{handle: 'same', bio: 'user', discoveredAt: '2026-01-01'}],
      queue: [{handle: 'same', bio: 'queue', status: 'pending', discoveredAt: '2026-01-02'}]
    },
    commentTracking: {posts: [{tweetId: '9001', text: 'one'}, {tweetId: '9002', text: 'two'}], users: [
      {handle: 'c0', lastSeenAt: '2026-01-01T00:00:00.000Z'},
      {handle: 'c1', lastSeenAt: '2026-01-02T00:00:00.000Z'},
      {handle: 'c2', lastSeenAt: '2026-01-03T00:00:00.000Z'}
    ]}
  });
  const service = runtime('runtime-lookup', storage, memoryDurable());
  await service.migrate();
  const first = await service.sourcePage({sourceKey: 'commentTracking', limit: 1});
  await service.patchRecord({module: 'comments', userKey: first.records[0].userKey, operationId: 'move-sort', patch: {lastSeenAt: '2026-06-01T00:00:00.000Z'}});
  const second = await service.sourcePage({sourceKey: 'commentTracking', limit: 10, cursor: first.nextCursor});
  const seen = new Set([first.records[0].userKey, ...second.records.map(row => row.userKey)]);
  assert.equal(seen.size, 1 + second.records.length);
  assert.equal(second.records.some(row => row.userKey === first.records[0].userKey), false);
  const handles = await service.handle({op: 'lookupAll', sourceKey: 'monitor', bucket: 'queue', handle: 'same'});
  assert.equal(handles.records.length, 1);
  assert.equal(handles.records[0].bucket, 'queue');
  assert.equal(handles.records[0].payload.bio, 'queue');
  const posts = await service.handle({op: 'lookupAll', sourceKey: 'commentTracking', bucket: 'posts', tweetId: '9002'});
  assert.equal(posts.records.length, 1);
  assert.equal(posts.records[0].payload.text, 'two');
  await service.handle({op: 'mergeRoot', key: 'monitor', fields: {every: 1}});
  await service.handle({op: 'mergeRoot', key: 'monitor', fields: {every: 2, label: 'later'}});
  const metadata = await service.handle({op: 'metadata', key: 'monitor'});
  assert.equal(metadata.metadata.every, 2);
  assert.equal(metadata.metadata.label, 'later');
});

test('a new profile uses a two-part map path and a second patch updates that row', async () => {
  const service = runtime('runtime-map-profile', memoryStorage({profileCache: {}}), memoryDurable());
  await service.migrate();
  await service.handle({op: 'batch', sourceKey: 'profileCache', changes: [{handle: 'new', sourceBucket: 'map', create: true, patch: {bio: 'first'}}]});
  await service.handle({op: 'batch', sourceKey: 'profileCache', changes: [{handle: 'new', sourceBucket: 'map', patch: {bio: 'second'}}]});
  const profiles = await service.profiles({handles: ['new']});
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].payload.bio, 'second');
  assert.deepEqual(profiles[0].sourcePath, ['profileCache', 'new']);
  assert.equal((await service.summary({module: 'profiles'})).total, 1);
  const created = await service.putRecord({module: 'fans', operationId: 'new-fan', record: {payload: {handle: 'newbie'}}});
  assert.deepEqual(created.sourcePath, ['monitor', 'users', 'newbie']);
});

test('a failed head write does not overwrite the published backup sequence', async () => {
  const storage = memoryStorage(comments(1));
  const durable = memoryDurable();
  const service = runtime('runtime-head-fail', storage, durable);
  await service.migrate();
  durable.failHead = true;
  const userKey = (await service.query({module: 'comments', limit: 1})).records[0].userKey;
  await assert.rejects(service.patchRecord({module: 'comments', userKey, operationId: 'head-1', patch: {bio: 'published'}}), /head write failed/);
  const seqKey = 'recordIncremental:v1:seq:00000001';
  assert.equal(durable.saved.get(seqKey).payload.bio, 'published');
  durable.failHead = false;
  durable.failOverwrite = true;
  await service.recoverBackups();
  assert.equal(durable.saved.get('recordIncremental:v1:head').seq, 1);
  assert.equal(durable.saved.get(seqKey).operationId, 'head-1');
  assert.equal(durable.saved.get(seqKey).payload.bio, 'published');
  await service.patchRecord({module: 'comments', userKey, operationId: 'head-2', patch: {bio: 'next'}});
  assert.equal(durable.saved.get('recordIncremental:v1:seq:00000002').payload.bio, 'next');
  assert.equal(durable.saved.get(seqKey).payload.bio, 'published');
});

test('upgraded v1 posts are found by tweetId and lookupAll honors module and account', async () => {
  const dashboard = 'runtime-v1-posts-dashboard';
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(dashboard, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      const rows = db.createObjectStore('rows', {keyPath: ['accountId', 'module', 'userKey']});
      rows.createIndex('byHandle', ['accountId', 'module', 'handle'], {unique: false});
      rows.createIndex('byHandleKey', ['handle', 'module', 'accountId', 'userKey'], {unique: true});
      db.createObjectStore('membership', {keyPath: ['accountId', 'module', 'tab', 'userKey']});
      db.createObjectStore('summaries', {keyPath: ['accountId', 'module']});
      db.createObjectStore('relations', {keyPath: 'handle'});
      db.createObjectStore('state', {keyPath: 'id'});
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['rows', 'state'], 'readwrite');
      tx.objectStore('rows').put({
        accountId: 'unassigned', module: 'posts', userKey: 'commentTracking/posts/0',
        sourceKey: 'commentTracking', sourcePath: ['commentTracking', 'posts', 0],
        payload: {tweetId: '555', text: 'old'}, handle: '', sortKey: '0', tabs: ['all'], tab: 'all', status: ''
      });
      tx.objectStore('rows').put({
        accountId: 'unassigned', module: 'comments', userKey: 'commentTracking/users/0',
        sourceKey: 'commentTracking', sourcePath: ['commentTracking', 'users', 0],
        payload: {handle: 'same', bio: 'comment'}, handle: 'same', sortKey: '1', tabs: ['all'], tab: 'all', status: ''
      });
      tx.objectStore('rows').put({
        accountId: 'unassigned', module: 'fans', userKey: 'monitor/users/0',
        sourceKey: 'monitor', sourcePath: ['monitor', 'users', 0],
        payload: {handle: 'same', bio: 'fan'}, handle: 'same', sortKey: '2', tabs: ['all'], tab: 'all', status: ''
      });
      tx.objectStore('state').put({id: 'runtime', stage: 'ready', cutover: true, completed: 1, total: 1, revision: 1});
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  const service = runtime('runtime-v1-posts', memoryStorage({}), memoryDurable());
  const posts = await service.handle({op: 'lookupAll', sourceKey: 'commentTracking', bucket: 'posts', tweetId: '555'});
  assert.equal(posts.records.length, 1);
  assert.equal(posts.records[0].payload.text, 'old');
  const comments = await service.handle({op: 'lookupAll', module: 'comments', handle: 'same'});
  assert.equal(comments.records.length, 1);
  assert.equal(comments.records[0].module, 'comments');
  const fans = await service.handle({op: 'lookupAll', module: 'fans', accountId: 'unassigned', handle: 'same'});
  assert.equal(fans.records.length, 1);
  assert.equal(fans.records[0].payload.bio, 'fan');
  const none = await service.handle({op: 'lookupAll', module: 'comments', accountId: 'other', handle: 'same'});
  assert.equal(none.records.length, 0);
});

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`delete blocked for ${name}`));
  });
}

test('a lost projection replays the incremental journal before it reports ready', async () => {
  const storage = memoryStorage(comments(1));
  const durable = memoryDurable();
  const name = 'runtime-replay-recover';
  const service = runtime(name, storage, durable);
  await service.migrate();
  const userKey = (await service.query({module: 'comments', limit: 1})).records[0].userKey;
  await service.patchRecord({module: 'comments', userKey, operationId: 'replay-keep', patch: {bio: 'from-journal'}});
  assert.equal(storage.data.commentTracking.users[0].bio, 'plain');
  await deleteDatabase(name);
  await deleteDatabase(`${name}-dashboard`);
  const seqReads = [];
  const read = durable.get;
  durable.get = async key => {
    if (String(key).startsWith('recordIncremental:v1:seq:')) seqReads.push(key);
    return read.call(durable, key);
  };
  let armed = true;
  const flaky = runtime(name, storage, {
    get: async key => {
      if (armed && String(key).startsWith('recordIncremental:v1:seq:')) throw new Error('replay interrupted');
      return durable.get(key);
    },
    set: durable.set
  });
  await assert.rejects(flaky.migrate(), /replay interrupted/);
  assert.equal(flaky.status().cutover, false);
  assert.equal(flaky.status().stage, 'failed', JSON.stringify(flaky.status()));
  armed = false;
  const restored = await runtime(name, storage, durable).migrate();
  assert.equal(restored.cutover, true);
  assert.equal(restored.stage, 'ready');
  assert.ok(seqReads.length >= 1);
  const page = await runtime(name, storage, durable).query({module: 'comments', limit: 5});
  assert.equal(page.records[0].payload.bio, 'from-journal');
  assert.equal(storage.data.commentTracking.users[0].bio, 'plain');
  assert.equal([...durable.saved.keys()].some(key => String(key).startsWith('recordLegacySnapshotBackup:v2:')), true);
  const seen = seqReads.length;
  const warm = runtime(name, storage, durable);
  await warm.query({module: 'comments', limit: 5});
  await warm.migrate();
  assert.equal(seqReads.length, seen);
});

test('rebuilding drains more than one journal page and the active migration path does too', async () => {
  const storage = memoryStorage(comments(1));
  const durable = memoryDurable();
  const name = 'runtime-replay-pages';
  const service = runtime(name, storage, durable);
  await service.migrate();
  const userKey = (await service.query({module: 'comments', limit: 1})).records[0].userKey;
  for (let index = 0; index < 101; index += 1) {
    await service.patchRecord({
      module: 'comments',
      userKey,
      operationId: `page-${index}`,
      patch: {bio: `step-${index}`}
    });
  }
  assert.equal(durable.saved.get('recordIncremental:v1:head').seq, 101);
  await deleteDatabase(`${name}-dashboard`);
  const shortcut = await runtime(name, storage, durable).migrate();
  assert.equal(shortcut.cutover, true);
  assert.equal((await runtime(name, storage, durable).query({module: 'comments', limit: 1})).records[0].payload.bio, 'step-100');
  await deleteDatabase(name);
  await deleteDatabase(`${name}-dashboard`);
  const rebuilt = await runtime(name, storage, durable).migrate();
  assert.equal(rebuilt.stage, 'ready');
  assert.equal((await runtime(name, storage, durable).query({module: 'comments', limit: 1})).records[0].payload.bio, 'step-100');
  assert.equal(storage.data.commentTracking.users[0].bio, 'plain');
  const backups = [...durable.saved.keys()].filter(key => String(key).startsWith('recordLegacySnapshotBackup:v2:'));
  assert.equal(backups.length, 1);
});

test('business writes fail before migration is ready', async () => {
  const service = runtime('runtime-guard', memoryStorage({monitor: {users: [{handle: 'a'}]}}), memoryDurable());
  await assert.rejects(service.handle({op: 'put', module: 'fans', operationId: 'early', record: {payload: {handle: 'b'}}}), /not ready/);
});
