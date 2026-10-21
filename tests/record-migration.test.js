import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {createRecordRepository} from '../src/features/records/record-repository.js';
import {createRecordMigration, flattenLegacySnapshot, hashCanonical, reconstructLegacySnapshot} from '../src/features/records/record-migration.js';

function repository(name) {
  return createRecordRepository({indexedDB, IDBKeyRange, dbName: name, now: () => 1000});
}

function sampleSnapshot() {
  return {
    accountId: 'should-not-apply',
    monitor: {
      enabled: true,
      users: [
        {id: '9007199254740993', handle: 'same', accountId: 'acct-a', nested: [{id: 'n1', note: 'keep'}], extra: {z: 1}},
        {id: '9007199254740993', handle: 'same', mystery: {ok: true}}
      ],
      followingUsers: [{id: '9007199254740993', handle: 'same', accountId: 'acct-a'}],
      queue: [{id: 'q1', handle: 'same', accountId: 'acct-a'}, {id: 'q1', handle: 'same', accountId: 'acct-a'}],
      unknownField: {kept: [1, {deep: true}]}
    },
    comments: {posts: [{tweetId: '9007199254740993', text: 'alt'}]},
    commentTracking: {
      users: [{handle: 'c', posts: [{tweetId: '9007199254740993'}]}],
      posts: [{tweetId: '9007199254740993', text: 'hi'}, {tweetId: '9007199254740993', text: 'hi'}]
    },
    autoFollowLogs: [{event: 'a', at: 1}, {event: 'a', at: 1}],
    monitorLogs: [{event: 'm'}],
    unreciprocatedLogs: [],
    profileCache: {same: {bio: 'x', accountId: 'acct-b'}, other: {bio: 'y'}},
    mutualNetwork: {users: [{handle: 'm', accountId: 'acct-a'}], autoFollow: {enabled: false, unknown: {a: 1}}},
    unreciprocatedTracker: {users: [{handle: 'u', deleted: true, reason: 'left', accountId: 'acct-a'}], config: {every: 60}},
    analysisRows: [{id: 'row', score: 1, accountId: 'acct-a'}],
    rows: [{id: 'raw'}],
    totallyUnknown: {items: [{foo: 'bar'}], flag: false}
  };
}

test('hashes canonical JSON with Web Crypto SHA-256', async () => {
  assert.equal(await hashCanonical('abc'), '6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25');
  assert.equal(await hashCanonical('abc'), await hashCanonical('abc'));
});

test('flattens and reconstructs nested legacy collections without dedup or guessed owners', async () => {
  const snapshot = sampleSnapshot();
  const before = structuredClone(snapshot);
  const flat = await flattenLegacySnapshot(snapshot);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(reconstructLegacySnapshot(flat), snapshot);
  const owned = flat.records.filter(record => record.accountId === 'should-not-apply');
  assert.equal(owned.length, 0);
  const sameFans = flat.records.filter(record => record.module === 'fans' && record.payload.handle === 'same');
  assert.equal(sameFans.length, 4);
  assert.equal(flat.records.filter(record => record.sourceModule === 'posts' && record.payload.tweetId === '9007199254740993').length, 3);
  const unowned = flat.records.find(record => record.payload.handle === 'same' && record.payload.mystery);
  assert.equal(unowned.module, 'unassigned');
  assert.equal(unowned.accountId, 'unassigned');
  const nested = flat.records.find(record => record.payload.note === 'keep');
  assert.equal(nested.accountId, 'unassigned');
  assert.equal(nested.payload.id, 'n1');
  assert.ok(flat.records.some(record => record.payload.deep === true));
  assert.ok(flat.records.some(record => record.scope === 'monitor' && record.payload.event === 'm'));
});

test('imports an isolated generation, resumes, preserves tombstones, and exports post-cutover changes', async () => {
  const snapshot = sampleSnapshot();
  const before = structuredClone(snapshot);
  const base = repository('migration-main');
  let writes = 0;
  const failing = {
    ...base,
    putRecords(request) {
      writes += 1;
      if (writes > 2) throw new Error('injected failure');
      return base.putRecords(request);
    }
  };
  const migration = createRecordMigration({repository: failing, chunkSize: 2});
  await assert.rejects(() => migration.importSnapshot({snapshot, migrationId: 'mig-1'}), /injected failure/);
  assert.deepEqual(snapshot, before);
  const paused = await base.getMigration('mig-1');
  assert.equal(paused.status, 'importing');
  assert.ok(paused.nextIndex >= 2);
  assert.equal((await base.getMeta('acct-a')).activeGeneration, 1);
  const pausedFan = Object.values(paused.originals).find(item => item.module === 'fans');
  assert.equal(await base.getRecord(pausedFan.accountId, pausedFan.module, pausedFan.userKey), null);

  const resumed = createRecordMigration({repository: base, chunkSize: 2});
  const verified = await resumed.importSnapshot({snapshot, migrationId: 'mig-1'});
  assert.equal(verified.status, 'verified');
  assert.deepEqual(snapshot, before);
  const activeFans = await base.queryPage({accountId: 'acct-a', module: 'fans', limit: 100});
  assert.equal(activeFans.records.length, 0);
  const generation = verified.generationByAccount['acct-a'];
  const staged = await base.queryPage({accountId: 'acct-a', module: 'fans', generation, limit: 100});
  assert.equal(staged.records.length, 4);
  const deletedKey = staged.records[0].userKey;
  const deletedOriginal = Object.values(verified.originals).find(item => item.deleted);
  const tomb = await base.getTombstone(deletedOriginal.accountId, deletedOriginal.module, deletedOriginal.userKey, {generation});
  assert.equal(tomb.payload.reason, 'left');
  assert.equal(await base.getRecord('acct-a', 'unreciprocated', tomb.userKey, {generation}), null);

  await assert.rejects(() => base.activateMigration('missing'), /not found/);
  const other = repository('migration-unverified');
  const pending = createRecordMigration({repository: other, chunkSize: 50});
  await pending.stage(snapshot, 'mig-raw');
  await assert.rejects(() => pending.activate('mig-raw'), /not verified/);

  await assert.rejects(() => base.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    generation,
    operationId: 'corrupt-one',
    records: [{envelope: true, userKey: deletedKey, sortKey: deletedKey, payload: {id: 'changed'}}]
  }), /sealed/);
  assert.notEqual((await base.getRecord('acct-a', 'fans', deletedKey, {generation})).payload.id, 'changed');
  assert.equal((await base.getMeta('acct-a')).activeGeneration, 1);
  const checkpoint = await base.getCheckpoint('mig-1');
  assert.equal(checkpoint.skeleton, undefined);
  assert.equal(checkpoint.originals, undefined);
  assert.equal((await base.getManifest('mig-1')).fingerprint.length, 64);

  const clean = repository('migration-clean');
  const drill = createRecordMigration({repository: clean, chunkSize: 3});
  const job = await drill.importSnapshot({snapshot: sampleSnapshot(), migrationId: 'mig-clean'});
  await drill.activate('mig-clean');
  const liveKey = 'monitor/users/0';
  await clean.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'after-add',
    records: [{envelope: true, userKey: 'added-after', sortKey: 'added-after', sourcePath: ['monitor', 'users', 'added-after'], payload: {handle: 'new', accountId: 'acct-a'}}]
  });
  await clean.deleteRecords({accountId: 'acct-a', module: 'fans', operationId: 'after-delete', userKeys: [liveKey]});
  const exported = await drill.exportRollback('mig-clean');
  assert.equal(exported.deletions.some(item => item.userKey === liveKey), true);
  assert.equal(exported.writes.some(item => item.userKey === 'added-after'), true);
  assert.equal(exported.snapshot.monitor.users.some(user => user.handle === 'new'), true);
  assert.equal(exported.snapshot.monitor.users.some(user => user.nested), false);
  assert.equal(exported.snapshot.monitor.users.some(user => user.mystery), true);
  assert.equal(exported.snapshot.monitor.followingUsers.length, 1);
  assert.equal(exported.snapshot.monitor.queue.length, 2);
  assert.equal(exported.snapshot.unreciprocatedTracker.users[0].deleted, true);
  assert.deepEqual(sampleSnapshot().monitor.unknownField, exported.snapshot.monitor.unknownField);
  assert.equal(job.status, 'verified');
  assert.equal((await clean.getMeta('acct-a')).activeGeneration, job.generationByAccount['acct-a']);
});

test('nested edits, deletes, and additions overlay the parent instead of keeping a stale copy', async () => {
  const snapshot = {
    monitor: {
      users: [{handle: 'parent', accountId: 'acct-a', posts: [{id: 'c1', text: 'before'}]}],
      followingUsers: [{handle: 'followed', accountId: 'acct-a'}],
      queue: [{handle: 'queued', accountId: 'acct-a'}]
    }
  };
  const flat = await flattenLegacySnapshot(snapshot);
  const parent = flat.records.find(record => record.userKey === 'monitor/users/0');
  assert.equal(parent.payload.posts, undefined);
  assert.equal(reconstructLegacySnapshot(flat).monitor.users[0].posts[0].text, 'before');
  const store = repository('migration-nested');
  const migration = createRecordMigration({repository: store, chunkSize: 10});
  await migration.importSnapshot({snapshot, migrationId: 'nested'});
  await migration.activate('nested');
  const childKey = flat.records.find(record => record.payload.text === 'before').userKey;
  await store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'edit-parent',
    records: [{envelope: true, userKey: parent.userKey, sortKey: parent.sortKey, sourcePath: parent.sourcePath, payload: {handle: 'renamed', accountId: 'acct-a'}}]
  });
  await store.putRecords({
    accountId: 'unassigned',
    module: 'unassigned',
    operationId: 'edit-child',
    records: [{envelope: true, userKey: childKey, sortKey: childKey, sourcePath: ['monitor', 'users', 0, 'posts', 0], payload: {id: 'c1', text: 'after'}}]
  });
  await store.deleteRecords({accountId: 'unassigned', module: 'unassigned', operationId: 'drop-child', userKeys: [childKey]});
  await store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'add-child',
    records: [{envelope: true, userKey: 'post-added', sortKey: 'post-added', sourcePath: ['monitor', 'users', 0, 'posts', 'added'], payload: {id: 'c2', text: 'added'}}]
  });
  await store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'add-following',
    records: [{envelope: true, userKey: 'follow-added', sortKey: 'follow-added', sourcePath: ['monitor', 'followingUsers', 'added'], payload: {handle: 'extra-follow', accountId: 'acct-a'}}]
  });
  await store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'add-queue',
    records: [{envelope: true, userKey: 'queue-added', sortKey: 'queue-added', sourcePath: ['monitor', 'queue', 'added'], payload: {handle: 'extra-queue', accountId: 'acct-a'}}]
  });
  const exported = await migration.exportRollback('nested');
  const user = exported.snapshot.monitor.users[0];
  assert.equal(user.handle, 'renamed');
  assert.equal(user.posts.some(post => post.text === 'before'), false);
  assert.deepEqual(user.posts, [{id: 'c2', text: 'added'}]);
  assert.deepEqual(exported.snapshot.monitor.followingUsers.map(item => item.handle), ['followed', 'extra-follow']);
  assert.deepEqual(exported.snapshot.monitor.queue.map(item => item.handle), ['queued', 'extra-queue']);
  await assert.rejects(() => store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'add-ambiguous',
    records: [{envelope: true, userKey: 'loose', sortKey: 'loose', payload: {handle: 'loose', accountId: 'acct-a'}}]
  }).then(() => migration.exportRollback('nested')), /unrepresentable rollback/);
});

test('same user key on the previous generation is not a staging leak, and late writes cannot activate', async () => {
  const snapshot = {
    monitor: {
      users: [{handle: 'staged', accountId: 'acct-a', note: 'one'}],
      queue: [{handle: 'other', accountId: 'acct-b'}]
    }
  };
  const store = repository('migration-live');
  await store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'old-live',
    records: [{userKey: 'monitor/users/0', sortKey: 's', handle: 'already-live', accountId: 'acct-a'}]
  });
  const migration = createRecordMigration({repository: store, chunkSize: 5});
  const verified = await migration.importSnapshot({snapshot, migrationId: 'live'});
  assert.equal((await store.getRecord('acct-a', 'fans', 'monitor/users/0')).handle, 'already-live');
  assert.equal((await store.getRecord('acct-a', 'fans', 'monitor/users/0', {generation: verified.generationByAccount['acct-a']})).handle, 'staged');
  await store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    operationId: 'late-live',
    records: [{userKey: 'monitor/users/0', sortKey: 's', handle: 'newer-live', accountId: 'acct-a'}]
  });
  await assert.rejects(() => migration.activate('live'), /live data changed/);
  assert.equal((await store.getMeta('acct-b')).activeGeneration, 1);
  assert.equal((await store.getRecord('acct-a', 'fans', 'monitor/users/0')).handle, 'newer-live');
  await assert.rejects(() => store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    generation: verified.generationByAccount['acct-a'],
    operationId: 'tamper-sealed',
    records: [{envelope: true, userKey: 'monitor/users/0', sortKey: 's', payload: {handle: 'tampered', accountId: 'acct-a'}}]
  }), /sealed/);
});

test('a second verified migration cannot replace a generation that already activated', async () => {
  const snapshot = {
    monitor: {
      users: [{handle: 'one', accountId: 'acct-a'}],
      queue: [{handle: 'two', accountId: 'acct-b'}]
    }
  };
  const store = repository('migration-concurrent');
  const first = createRecordMigration({repository: store, chunkSize: 5});
  const second = createRecordMigration({repository: store, chunkSize: 5});
  const older = await first.importSnapshot({snapshot, migrationId: 'older'});
  await second.importSnapshot({snapshot, migrationId: 'newer'});
  await first.activate('older');
  await assert.rejects(() => second.activate('newer'), /live data changed/);
  assert.equal((await store.getMeta('acct-a')).activeGeneration, older.generationByAccount['acct-a']);
  assert.equal((await store.getMeta('acct-b')).activeGeneration, older.generationByAccount['acct-b']);
  assert.equal((await store.getRecord('acct-b', 'fans', 'monitor/queue/0')).handle, 'two');
});

test('verification rejects extra rows and a revision that changes while rows are read', async () => {
  const snapshot = {monitor: {users: [{handle: 'kept', accountId: 'acct-a'}]}};
  const store = repository('migration-extra');
  const migration = createRecordMigration({repository: store, chunkSize: 10});
  await migration.stage(snapshot, 'extra');
  const generation = (await store.getMigration('extra')).generationByAccount['acct-a'];
  await store.putRecords({
    accountId: 'acct-a',
    module: 'fans',
    generation,
    operationId: 'sneak-row',
    records: [{envelope: true, userKey: 'extra-row', sortKey: 'extra-row', sourcePath: ['monitor', 'users', 'extra-row'], payload: {handle: 'extra', accountId: 'acct-a'}}]
  });
  await assert.rejects(() => migration.verify(snapshot, 'extra'), /verification failed/);
  assert.equal((await store.getCheckpoint('extra')).status, 'failed');
  assert.notEqual((await store.getMeta('acct-a')).sealedGenerations?.[String(generation)], (await store.getMeta('acct-a')).generationRevisions?.[String(generation)]);

  const racingStore = repository('migration-race');
  let raceArmed = true;
  const racing = {
    ...racingStore,
    async scanRecords(accountId, generation) {
      const rows = await racingStore.scanRecords(accountId, generation);
      if (raceArmed && accountId === 'acct-a') {
        raceArmed = false;
        await racingStore.putRecords({
          accountId: 'acct-a',
          module: 'fans',
          generation,
          operationId: 'during-verify',
          records: [{envelope: true, userKey: 'during', sortKey: 'during', sourcePath: ['monitor', 'users', 'during'], payload: {handle: 'during', accountId: 'acct-a'}}]
        });
      }
      return rows;
    }
  };
  const race = createRecordMigration({repository: racing, chunkSize: 10});
  await race.stage(snapshot, 'race');
  await assert.rejects(() => race.verify(snapshot, 'race'), /changed during verification/);
  const raced = await racingStore.getMeta('acct-a');
  const racedGeneration = (await racingStore.getMigration('race')).generationByAccount['acct-a'];
  assert.equal(raced.sealedGenerations?.[String(racedGeneration)], undefined);
  assert.equal((await racingStore.getCheckpoint('race')).status, 'failed');

  const resume = repository('migration-resume');
  const again = createRecordMigration({repository: resume, chunkSize: 10});
  const verified = await again.importSnapshot({snapshot, migrationId: 'resume'});
  const repeated = await again.verify(snapshot, 'resume');
  assert.equal(repeated.status, 'verified');
  assert.equal(repeated.sealedRevisions['acct-a'], verified.sealedRevisions['acct-a']);
  await again.activate('resume');
  const afterActivate = await again.verify(snapshot, 'resume');
  assert.equal(afterActivate.status, 'active');
  assert.equal((await resume.getRecord('acct-a', 'fans', 'monitor/users/0')).handle, 'kept');
});

test('rollback keeps payload fields added after import and still overlays nested refs', async () => {
  const snapshot = {
    monitor: {
      users: [{accountId: 'A', id: 1, name: 'old', posts: [{id: 'c1', text: 'before'}]}]
    }
  };
  const store = repository('migration-new-field');
  const migration = createRecordMigration({repository: store, chunkSize: 10});
  await migration.importSnapshot({snapshot, migrationId: 'fields'});
  await migration.activate('fields');
  const original = {accountId: 'A', id: 1, name: 'old', posts: [{id: 'c1', text: 'stale-parent-copy'}]};
  await store.putRecords({
    accountId: 'A',
    module: 'fans',
    operationId: 'add-fields',
    records: [{
      envelope: true,
      userKey: 'monitor/users/0',
      sortKey: 'monitor/users/0',
      sourcePath: ['monitor', 'users', 0],
      payload: {
        ...original,
        name: 'replaced',
        newField: 'must-survive',
        extraObject: {keep: true, nested: {n: 1}},
        extraList: [1, {nested: 'yes'}]
      }
    }]
  });
  await store.putRecords({
    accountId: 'unassigned',
    module: 'unassigned',
    operationId: 'edit-nested',
    records: [{
      envelope: true,
      userKey: 'monitor/users/0/posts/0',
      sortKey: 'monitor/users/0/posts/0',
      sourcePath: ['monitor', 'users', 0, 'posts', 0],
      payload: {id: 'c1', text: 'after', childField: {ok: true}}
    }]
  });
  const exported = await migration.exportRollback('fields');
  const user = exported.snapshot.monitor.users[0];
  assert.equal(user.name, 'replaced');
  assert.equal(user.id, 1);
  assert.equal(user.newField, 'must-survive');
  assert.deepEqual(user.extraObject, {keep: true, nested: {n: 1}});
  assert.deepEqual(user.extraList, [1, {nested: 'yes'}]);
  assert.deepEqual(user.posts, [{id: 'c1', text: 'after', childField: {ok: true}}]);
  await store.putRecords({
    accountId: 'A',
    module: 'fans',
    operationId: 'partial-keep',
    records: [{
      envelope: true,
      userKey: 'monitor/users/0',
      sortKey: 'monitor/users/0',
      sourcePath: ['monitor', 'users', 0],
      payload: {nickname: null}
    }]
  });
  const kept = (await migration.exportRollback('fields')).snapshot.monitor.users[0];
  assert.equal(kept.newField, 'must-survive');
  assert.equal(kept.name, 'replaced');
  assert.equal(kept.nickname, null);
  assert.equal(kept.posts[0].text, 'after');
});
