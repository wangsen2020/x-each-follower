import test from 'node:test';
import assert from 'node:assert/strict';
import {createFollowQueueStore, FOLLOW_QUEUE_DEFAULT_SETTINGS} from '../follow-queue-store.js';

function createFakeIndexedDB() {
  const databases = new Map();

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function createDatabase() {
    const data = {jobs: new Map(), outcomes: new Map(), settings: new Map()};
    let chain = Promise.resolve();
    return {
      data,
      createObjectStore() {
        return {createIndex() {}};
      },
      transaction(_storeNames, mode) {
        let releaseLock = () => {};
        const gate = new Promise(resolve => { releaseLock = resolve; });
        const previous = chain;
        chain = previous.then(() => gate);
        const tx = {};
        let pending = 0;
        let settled = false;
        let commitTimer;

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(commitTimer);
          tx.oncomplete?.();
          releaseLock();
        };

        const scheduleCommit = () => {
          clearTimeout(commitTimer);
          commitTimer = setTimeout(() => {
            if (!settled && pending === 0) finish();
          }, 0);
        };

        function request(exec) {
          pending += 1;
          const requestObject = {};
          previous.then(() => {
            try {
              requestObject.result = exec();
              pending -= 1;
              requestObject.onsuccess?.();
              scheduleCommit();
            } catch (error) {
              pending -= 1;
              requestObject.error = error;
              tx.error = error;
              requestObject.onerror?.();
              if (!settled) {
                settled = true;
                clearTimeout(commitTimer);
                tx.onabort?.();
                releaseLock();
              }
            }
          });
          return requestObject;
        }

        const storeApi = name => ({
          getAll() {
            return request(() => [...data[name].values()].map(clone));
          },
          get(key) {
            return request(() => clone(data[name].get(key)));
          },
          put(value) {
            return request(() => {
              if (mode !== 'readwrite') throw new Error('read-only');
              const key = name === 'jobs' ? value.id : name === 'settings' ? value.accountId : value.key;
              data[name].set(key, clone(value));
              return key;
            });
          },
          delete(key) {
            return request(() => {
              if (mode !== 'readwrite') throw new Error('read-only');
              data[name].delete(key);
            });
          }
        });

        tx.objectStore = name => storeApi(name);
        tx.abort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(commitTimer);
          tx.onabort?.();
          releaseLock();
        };
        return tx;
      }
    };
  }

  return {
    databases,
    open(name, version) {
      const request = {};
      queueMicrotask(() => {
        let record = databases.get(name);
        if (!record || record.version < version) {
          record = {version, db: createDatabase()};
          databases.set(name, record);
          request.result = record.db;
          request.onupgradeneeded?.();
        }
        request.result = record.db;
        request.onsuccess?.();
      });
      return request;
    }
  };
}

function storeFor(clock = {t: 1_000}) {
  const indexedDB = createFakeIndexedDB();
  const store = createFollowQueueStore({
    indexedDB,
    dbName: 'test-queue',
    now: () => clock.t
  });
  return {store, indexedDB, clock};
}

test('duplicate enqueue keeps one job, merges sources, and does not resurrect followed', async () => {
  const {store} = storeFor();
  const first = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '111',
    handle: '@Alice',
    sources: [{module: 'fans', url: 'https://x.com/a/followers', enabled: true, discoveredAt: 1}]
  });
  await store.settle({
    id: (await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 50})).id,
    owner: 'worker',
    version: 1,
    state: 'followed',
    patch: {followResult: {following: true, added: true}, stage: 'followed'}
  });
  for (let i = 0; i < 5; i += 1) {
    await store.enqueue({
      accountId: 'acc-1',
      targetUserId: '111',
      handle: i % 2 ? 'alice' : '@ALICE',
      sources: [
        {module: 'mutual', url: 'https://x.com/anchor', enabled: false},
        {module: 'comments', url: `https://x.com/post/${i}`, enabled: false}
      ]
    });
  }
  const jobs = await store.list({accountId: 'acc-1'});
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, first.id);
  assert.equal(jobs[0].state, 'followed');
  assert.equal(jobs[0].targetUserId, '111');
  assert.equal(jobs[0].sources.length, 2 + 5);
  assert.equal(jobs[0].sources[0].enabled, true);
  assert.ok(jobs[0].aliases.some(alias => alias.canonical === 'alice'));
  assert.equal(jobs[0].followResult.added, true);
});

test('handle-only jobs merge into the caller-supplied user id without resetting running', async () => {
  const {store, clock} = storeFor();
  const provisional = await store.enqueue({
    accountId: 'acc-1',
    handle: '@Bob',
    sources: [{module: 'comments', url: 'https://x.com/p/1', enabled: true}]
  });
  assert.equal(provisional.targetUserId, '');
  assert.equal(provisional.targetKey, 'handle:bob');
  clock.t = 2_000;
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker-a', leaseMs: 500});
  const merged = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '222',
    handle: 'bob',
    sources: [{module: 'fans', url: 'https://x.com/fans', enabled: false}]
  });
  assert.equal(merged.id, claimed.id);
  assert.equal(merged.state, 'running');
  assert.equal(merged.targetUserId, '222');
  assert.equal(merged.targetKey, 'id:222');
  assert.equal(merged.lease.owner, 'worker-a');
  assert.equal(merged.sources.length, 2);
  const jobs = await store.list({accountId: 'acc-1'});
  assert.equal(jobs.length, 1);
});

test('accounts are isolated and a missing account fails closed', async () => {
  const {store} = storeFor();
  await store.enqueue({accountId: 'acc-1', targetUserId: '5', handle: 'sam', sources: [{module: 'fans', url: 'u'}]});
  await store.enqueue({accountId: 'acc-2', targetUserId: '5', handle: 'sam', sources: [{module: 'mutual', url: 'm'}]});
  assert.equal((await store.list({accountId: 'acc-1'})).length, 1);
  assert.equal((await store.list({accountId: 'acc-2'}))[0].sources[0].module, 'mutual');
  await assert.rejects(() => store.enqueue({handle: 'sam', sources: []}), /missing account/);
  await assert.rejects(() => store.list({accountId: ''}), /missing account/);
  await assert.rejects(() => store.claim({owner: 'w', leaseMs: 10}), /missing account/);
  await assert.rejects(() => store.enqueue({accountId: 'acc-1', targetUserId: 5, handle: 'sam'}), /decimal string/);
});

test('concurrent claims grant one global lease', async () => {
  const {store} = storeFor();
  await store.enqueue({accountId: 'acc-1', targetUserId: '1', handle: 'one', sources: [{module: 'fans', url: 'a', enabled: true}]});
  await store.enqueue({accountId: 'acc-2', targetUserId: '2', handle: 'two', sources: [{module: 'fans', url: 'b', enabled: true}]});
  const [left, right] = await Promise.all([
    store.claim({accountId: 'acc-1', owner: 'left', leaseMs: 100}),
    store.claim({accountId: 'acc-2', owner: 'right', leaseMs: 100})
  ]);
  const winners = [left, right].filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].state, 'running');
  assert.equal(winners[0].lease.version, 1);
  const again = await store.claim({accountId: 'acc-1', owner: 'third', leaseMs: 100});
  assert.equal(again, null);
});

test('expired running becomes uncertain and a stale settle cannot overwrite a new lease', async () => {
  const {store, clock} = storeFor();
  await store.enqueue({accountId: 'acc-1', targetUserId: '9', handle: 'nine', sources: [{module: 'mutual', url: 'm', enabled: true}]});
  await store.enqueue({accountId: 'acc-1', targetUserId: '8', handle: 'eight', sources: [{module: 'fans', url: 'f', enabled: true}]});
  const first = await store.claim({accountId: 'acc-1', owner: 'old', leaseMs: 20});
  clock.t = 1_030;
  const second = await store.claim({accountId: 'acc-1', owner: 'new', leaseMs: 20});
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.equal(second.lease.version, 1);
  const jobs = await store.list({accountId: 'acc-1'});
  const expired = jobs.find(job => job.id === first.id);
  assert.equal(expired.state, 'uncertain');
  const stale = await store.settle({
    id: first.id,
    owner: 'old',
    version: 1,
    state: 'followed',
    patch: {followResult: {added: true}}
  });
  assert.deepEqual(stale, {ok: false, reason: 'stale'});
  const wrongOwner = await store.settle({
    id: second.id,
    owner: 'old',
    version: second.lease.version,
    state: 'followed',
    patch: {}
  });
  assert.equal(wrongOwner.ok, false);
  const fresh = await store.settle({
    id: second.id,
    owner: 'new',
    version: second.lease.version,
    state: 'uncertain',
    patch: {stage: 'verify', followResult: {unknown: true}}
  });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.job.state, 'uncertain');
  assert.equal(fresh.job.followResult.unknown, true);
  const still = await store.list({accountId: 'acc-1'});
  assert.equal(still.find(job => job.id === first.id).state, 'uncertain');
  assert.equal(still.find(job => job.id === first.id).followResult, null);
});

test('durable followed outcome survives job deletion and blocks rediscovery', async () => {
  const {store, indexedDB} = storeFor();
  await store.enqueue({accountId: 'acc-1', targetUserId: '42', handle: 'ada', sources: [{module: 'comments', url: 'c', enabled: true}]});
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 100});
  await store.settle({
    id: claimed.id,
    owner: 'worker',
    version: claimed.lease.version,
    state: 'followed',
    patch: {
      followResult: {added: true},
      evaluations: [{
        taskId: 'eval-1',
        originalAuthorId: '99',
        originalPostId: '555',
        originalPostUrl: 'https://x.com/i/status/555',
        text: 'draft',
        status: 'failed',
        publishedPostId: '',
        publishedPostUrl: '',
        attempts: [{at: 1, result: 'grok-failed'}]
      }]
    }
  });
  const db = indexedDB.databases.get('test-queue').db;
  db.data.jobs.clear();
  const rediscovered = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '42',
    handle: '@Ada',
    sources: [{module: 'fans', url: 'again'}]
  });
  assert.equal(rediscovered.state, 'followed');
  assert.equal(rediscovered.followResult.added, true);
  assert.equal(rediscovered.evaluations[0].taskId, 'eval-1');
  assert.equal(rediscovered.evaluations[0].originalPostId, '555');
  assert.equal(rediscovered.evaluations[0].status, 'failed');
  assert.notEqual(rediscovered.state, 'pending');
});

test('settings default closed and clamp to bounds per account', async () => {
  const {store} = storeFor();
  const defaults = await store.getSettings('acc-1');
  assert.deepEqual(defaults, {...FOLLOW_QUEUE_DEFAULT_SETTINGS});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.autoPublish, false);
  const saved = await store.saveSettings('acc-1', {
    enabled: true,
    every: 0,
    jitter: 999,
    batchLimit: 5,
    inspectLimit: 20,
    ratioThreshold: 1.4,
    autoPublish: true,
    minFollowers: -3
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.every, 1);
  assert.equal(saved.jitter, 1);
  assert.equal(saved.ratioThreshold, 1);
  assert.equal(saved.minFollowers, 0);
  assert.equal(saved.autoPublish, true);
  const timing = await store.saveSettings('acc-1', {every: 40, jitter: 0, dwellJitter: 0});
  assert.equal(timing.jitter, 1);
  assert.equal(timing.dwellJitter, 1);
  assert.equal((await store.getSettings('acc-2')).enabled, false);
});

test('retry waits until nextEligibleAt and pending is preferred', async () => {
  const {store, clock} = storeFor();
  const retryJob = await store.enqueue({accountId: 'acc-1', targetUserId: '1', handle: 'a', sources: [{module: 'fans', url: '1', enabled: true}]});
  clock.t += 1;
  const pendingJob = await store.enqueue({accountId: 'acc-1', targetUserId: '2', handle: 'b', sources: [{module: 'fans', url: '2', enabled: true}]});
  const claimed = await store.claim({accountId: 'acc-1', owner: 'w', leaseMs: 10});
  assert.equal(claimed.id, retryJob.id);
  await store.settle({
    id: claimed.id,
    owner: 'w',
    version: 1,
    state: 'retry',
    patch: {nextEligibleAt: clock.t + 500, stage: 'retry'}
  });
  clock.t += 10;
  const next = await store.claim({accountId: 'acc-1', owner: 'w2', leaseMs: 10});
  assert.equal(next.id, pendingJob.id);
  await store.settle({id: next.id, owner: 'w2', version: 1, state: 'skipped', patch: {stage: 'skipped'}});
  clock.t += 10;
  const tooSoon = await store.claim({accountId: 'acc-1', owner: 'w3', leaseMs: 10});
  assert.equal(tooSoon, null);
  clock.t += 500;
  const due = await store.claim({accountId: 'acc-1', owner: 'w4', leaseMs: 10});
  assert.equal(due.id, retryJob.id);
  assert.equal(due.state, 'running');
});

test('claim skips jobs until a source explicitly authorizes the action', async () => {
  const {store} = storeFor();
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '1',
    handle: 'closed',
    sources: [
      {module: 'fans', url: 'https://x.com/closed', enabled: false},
      {module: 'comments', url: 'https://x.com/closed/status'}
    ]
  });
  assert.equal(await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 50}), null);
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '2',
    handle: 'open',
    sources: [
      {module: 'mutual', url: 'https://x.com/open', enabled: false},
      {module: 'fans', url: 'https://x.com/open/fans', enabled: true}
    ]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 50});
  assert.equal(claimed.targetUserId, '2');
  assert.equal(claimed.handleCanonical, 'open');
});

test('handle-only enqueue resolves an existing user id and does not merge a different user id', async () => {
  const {store} = storeFor();
  const alice = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '111',
    handle: '@Alice',
    sources: [{module: 'fans', url: 'https://x.com/alice', enabled: true}]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker-a', leaseMs: 500});
  assert.equal(claimed.id, alice.id);
  const again = await store.enqueue({
    accountId: 'acc-1',
    handle: 'ALICE',
    sources: [{module: 'comments', url: 'https://x.com/p/alice', enabled: false}]
  });
  assert.equal(again.id, alice.id);
  assert.equal(again.targetUserId, '111');
  assert.equal(again.targetKey, 'id:111');
  assert.equal(again.state, 'running');
  assert.equal(again.lease.owner, 'worker-a');
  assert.equal(again.lease.version, claimed.lease.version);
  assert.equal((await store.list({accountId: 'acc-1'})).length, 1);
  await store.settle({
    id: claimed.id,
    owner: 'worker-a',
    version: claimed.lease.version,
    state: 'skipped',
    patch: {stage: 'skipped'}
  });

  const other = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '333',
    handle: '@alice',
    sources: [{module: 'mutual', url: 'https://x.com/other', enabled: true}]
  });
  assert.notEqual(other.id, alice.id);
  assert.equal(other.targetUserId, '333');
  const ambiguous = await store.enqueue({
    accountId: 'acc-1',
    handle: '@alice',
    sources: [{module: 'fans', url: 'https://x.com/ambiguous', enabled: true}]
  });
  const jobs = await store.list({accountId: 'acc-1'});
  assert.equal(jobs.filter(job => job.targetUserId === '111' || job.targetUserId === '333').length, 2);
  assert.ok(jobs.some(job => job.id === alice.id && job.targetUserId === '111'));
  assert.ok(jobs.some(job => job.id === other.id && job.targetUserId === '333'));
  assert.ok(ambiguous.targetUserId === '');
  assert.equal(jobs.length, 3);
});

test('settle rejects an expired lease before any later claim sweeps it', async () => {
  const {store, clock} = storeFor();
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '9',
    handle: 'nine',
    sources: [{module: 'fans', url: 'f', enabled: true}]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 20});
  clock.t += 20;
  const settled = await store.settle({
    id: claimed.id,
    owner: 'worker',
    version: claimed.lease.version,
    state: 'followed',
    patch: {followResult: {added: true}}
  });
  assert.deepEqual(settled, {ok: false, reason: 'expired'});
  const jobs = await store.list({accountId: 'acc-1'});
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'running');
  assert.equal(jobs[0].lease.owner, 'worker');
  assert.equal(jobs[0].lease.version, claimed.lease.version);
  assert.equal(jobs[0].followResult, null);
});

test('a leased provisional keeps its id, owner, and version when a second leased row cannot collapse', async () => {
  const {store, indexedDB, clock} = storeFor();
  const resolved = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '222',
    handle: 'bob',
    sources: [{module: 'fans', url: 'https://x.com/fans', enabled: true}]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker-a', leaseMs: 500});
  assert.equal(claimed.id, resolved.id);
  const db = indexedDB.databases.get('test-queue').db;
  db.data.jobs.set('fq_prov', {
    id: 'fq_prov',
    accountId: 'acc-1',
    action: 'follow',
    targetUserId: '',
    targetKey: 'handle:bob',
    handle: 'bob',
    handleCanonical: 'bob',
    aliases: [{canonical: 'bob', handle: 'bob', seenAt: 1}],
    sources: [{module: 'comments', url: 'https://x.com/p/1', enabled: true, discoveredAt: 1}],
    state: 'running',
    stage: 'claimed',
    createdAt: 1,
    updatedAt: 1,
    nextEligibleAt: 1,
    lease: {owner: 'worker-b', version: 3, expiresAt: clock.t + 500},
    followResult: null,
    evaluations: []
  });
  const merged = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '222',
    handle: 'bob',
    sources: [{module: 'mutual', url: 'https://x.com/mutual', enabled: false}]
  });
  assert.equal(merged.id, 'fq_prov');
  assert.equal(merged.lease.owner, 'worker-b');
  assert.equal(merged.lease.version, 3);
  const jobs = await store.list({accountId: 'acc-1'});
  assert.equal(jobs.length, 2);
  const stillResolved = jobs.find(job => job.id === claimed.id);
  assert.equal(stillResolved.state, 'running');
  assert.equal(stillResolved.lease.owner, 'worker-a');
  assert.equal(stillResolved.lease.version, 1);
  assert.equal(stillResolved.targetUserId, '222');
  const settled = await store.settle({
    id: claimed.id,
    owner: 'worker-a',
    version: 1,
    state: 'skipped',
    patch: {stage: 'skipped', followResult: {added: false}}
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.job.id, claimed.id);
  assert.equal((await store.list({accountId: 'acc-1'})).find(job => job.id === 'fq_prov').lease.version, 3);
});

test('skipped, excluded, and uncertain outcomes stay closed after the job row is removed', async () => {
  const {store, indexedDB} = storeFor();
  for (const [id, state] of [['71', 'skipped'], ['72', 'excluded'], ['73', 'uncertain']]) {
    await store.enqueue({
      accountId: 'acc-1',
      targetUserId: id,
      handle: `user${id}`,
      sources: [{module: 'fans', url: id, enabled: true}]
    });
    const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 100});
    const settled = await store.settle({
      id: claimed.id,
      owner: 'worker',
      version: claimed.lease.version,
      state,
      patch: {stage: state, followResult: {reason: state}}
    });
    assert.equal(settled.ok, true);
    assert.equal(await store.claim({accountId: 'acc-1', owner: 'next', leaseMs: 100}), null);
  }
  indexedDB.databases.get('test-queue').db.data.jobs.clear();
  for (const [id, state] of [['71', 'skipped'], ['72', 'excluded'], ['73', 'uncertain']]) {
    const restored = await store.enqueue({
      accountId: 'acc-1',
      targetUserId: id,
      handle: `user${id}`,
      sources: [{module: 'mutual', url: `again-${id}`, enabled: true}]
    });
    assert.equal(restored.state, state);
    assert.notEqual(restored.state, 'pending');
    assert.notEqual(restored.state, 'retry');
    assert.equal(restored.followResult.reason, state);
  }
  assert.equal(await store.claim({accountId: 'acc-1', owner: 'resurrect', leaseMs: 100}), null);
});

test('importOutcome is idempotent, keeps the stronger hold, and does not touch an active lease', async () => {
  const {store} = storeFor();
  const skipped = await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '501',
    handle: '@Ada',
    state: 'skipped',
    followResult: {reason: 'legacy-skip'},
    sources: [{module: 'fans', url: 'https://x.com/ada', enabled: false}]
  });
  assert.equal(skipped.state, 'skipped');
  const again = await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '501',
    handle: 'ada',
    state: 'skipped',
    followResult: {reason: 'legacy-skip'},
    sources: [{module: 'fans', url: 'https://x.com/ada', enabled: true}]
  });
  assert.equal(again.id, skipped.id);
  assert.equal(again.sources.length, 1);
  assert.equal(again.sources[0].enabled, false);
  const stronger = await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '501',
    handle: 'ada',
    state: 'followed',
    followResult: {following: true},
    sources: [{module: 'mutual', url: 'https://x.com/mutual/ada'}]
  });
  assert.equal(stronger.state, 'followed');
  assert.equal(stronger.followResult.following, true);
  const weaker = await store.importOutcome({
    accountId: 'acc-1',
    handle: 'ada',
    state: 'uncertain',
    followResult: {unknown: true},
    sources: []
  });
  assert.equal(weaker.id, skipped.id);
  assert.equal(weaker.state, 'followed');
  assert.equal(weaker.followResult.following, true);

  const open = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '502',
    handle: 'bea',
    sources: [{module: 'fans', url: 'https://x.com/bea', enabled: true}]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 80});
  assert.equal(claimed.id, open.id);
  const held = await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '502',
    handle: 'bea',
    state: 'skipped',
    followResult: {reason: 'collision'},
    sources: [{module: 'comments', url: 'https://x.com/p/bea'}]
  });
  assert.equal(held.state, 'running');
  assert.equal(held.lease.owner, 'worker');
  assert.equal(held.lease.version, claimed.lease.version);
  assert.equal(held.followResult, null);
  assert.deepEqual(held.importedHold, {state: 'skipped', followResult: {reason: 'collision'}});
  assert.equal(held.sources.length, 2);
  const strongerHold = await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '502',
    handle: 'bea',
    state: 'uncertain',
    followResult: {reason: 'needs-verify'},
    sources: []
  });
  assert.equal(strongerHold.state, 'running');
  assert.equal(strongerHold.importedHold.state, 'uncertain');
  assert.equal(strongerHold.importedHold.followResult.reason, 'needs-verify');
  assert.equal(strongerHold.lease.version, claimed.lease.version);
  const weakerHold = await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '502',
    handle: 'bea',
    state: 'skipped',
    followResult: {reason: 'weaker'},
    sources: []
  });
  assert.equal(weakerHold.importedHold.state, 'uncertain');
  assert.equal(weakerHold.lease.version, claimed.lease.version);
  await assert.rejects(() => store.importOutcome({accountId: 'acc-1', handle: 'x', state: 'retry'}), /importOutcome/);
});

test('importedHold blocks renew and settle, then claim applies it after the lease expires', async () => {
  const {store, clock} = storeFor();
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '880',
    handle: 'lea',
    sources: [{module: 'fans', url: 'https://x.com/lea', enabled: true}]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 50});
  const held = await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '880',
    handle: 'lea',
    state: 'followed',
    followResult: {following: true, imported: true},
    sources: [{module: 'mutual', url: 'https://x.com/lea', enabled: true}]
  });
  assert.equal(held.state, 'running');
  assert.equal(held.lease.owner, 'worker');
  assert.equal(held.lease.version, claimed.lease.version);
  assert.equal(held.lease.expiresAt, claimed.lease.expiresAt);
  assert.equal(held.followResult, null);
  assert.deepEqual(held.importedHold, {state: 'followed', followResult: {following: true, imported: true}});

  const renewed = await store.renew({
    id: claimed.id,
    owner: 'worker',
    version: claimed.lease.version,
    leaseMs: 50
  });
  assert.deepEqual(renewed, {ok: false, reason: 'imported-hold'});
  const checkpoint = await store.settle({
    id: claimed.id,
    owner: 'worker',
    version: claimed.lease.version,
    state: 'running',
    patch: {stage: 'opening', followResult: {added: true}}
  });
  assert.deepEqual(checkpoint, {ok: false, reason: 'imported-hold'});
  const during = (await store.list({accountId: 'acc-1'})).find(job => job.id === claimed.id);
  assert.equal(during.state, 'running');
  assert.equal(during.lease.owner, 'worker');
  assert.equal(during.lease.version, claimed.lease.version);
  assert.equal(during.followResult, null);
  assert.equal(during.importedHold.state, 'followed');
  const settled = await store.settle({
    id: claimed.id,
    owner: 'worker',
    version: claimed.lease.version,
    state: 'skipped',
    patch: {
      stage: 'skipped',
      followResult: {added: false},
      evaluations: [{taskId: 'hold-eval', reason: 'from-patch', channel: 'comments', attempts: 2, status: 'failed'}]
    }
  });
  assert.equal(settled.ok, false);
  assert.equal(settled.reason, 'imported-hold');
  assert.equal(settled.job.state, 'followed');
  assert.equal(settled.job.lease.owner, '');
  assert.equal(settled.job.lease.expiresAt, 0);
  assert.equal(settled.job.followResult.following, true);
  assert.equal(settled.job.importedHold, undefined);
  assert.equal(settled.job.evaluations[0].taskId, 'hold-eval');
  assert.equal(settled.job.evaluations[0].attempts, 2);
  const still = (await store.list({accountId: 'acc-1'})).find(job => job.id === claimed.id);
  assert.equal(still.state, 'followed');
  assert.equal(still.lease.owner, '');
  assert.equal(still.followResult.following, true);
  assert.equal(still.importedHold, undefined);

  clock.t += 50;
  assert.equal(await store.claim({accountId: 'acc-1', owner: 'next', leaseMs: 50}), null);
  const closed = (await store.list({accountId: 'acc-1'})).find(job => job.id === claimed.id);
  assert.equal(closed.state, 'followed');
  assert.equal(closed.followResult.following, true);
  assert.equal(closed.importedHold, undefined);
  assert.equal(closed.lease.owner, '');
  assert.equal(closed.lease.expiresAt, 0);

  const again = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '880',
    handle: 'lea',
    sources: [{module: 'fans', url: 'https://x.com/lea', enabled: true}]
  });
  assert.equal(again.id, claimed.id);
  assert.equal(again.state, 'followed');
  assert.equal(await store.claim({accountId: 'acc-1', owner: 'next', leaseMs: 50}), null);
});

test('promoting a running or retry handle job honors a durable user id outcome with no jobs row', async () => {
  const {store, indexedDB, clock} = storeFor();
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '42',
    sources: [{module: 'fans', url: 'https://x.com/ada', enabled: true}]
  });
  const verified = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 100});
  await store.settle({
    id: verified.id,
    owner: 'worker',
    version: verified.lease.version,
    state: 'followed',
    patch: {
      stage: 'followed',
      followResult: {added: true, following: true},
      evaluations: [{
        taskId: 'eval-ada',
        originalAuthorId: '7',
        originalPostId: '900',
        originalPostUrl: 'https://x.com/i/status/900',
        text: 'kept',
        status: 'failed',
        publishedPostId: '',
        publishedPostUrl: '',
        attempts: [{at: 1, result: 'grok-failed'}]
      }]
    }
  });
  indexedDB.databases.get('test-queue').db.data.jobs.clear();

  const running = await store.enqueue({
    accountId: 'acc-1',
    handle: '@Ada',
    sources: [{module: 'comments', url: 'https://x.com/p/ada', enabled: true}]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'external', leaseMs: 80});
  assert.equal(claimed.id, running.id);
  assert.equal(claimed.targetKey, 'handle:ada');
  const promoted = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '42',
    handle: 'ada',
    sources: [{module: 'mutual', url: 'https://x.com/mutual/ada', enabled: false}]
  });
  assert.equal(promoted.id, claimed.id);
  assert.equal(promoted.state, 'running');
  assert.equal(promoted.targetUserId, '42');
  assert.equal(promoted.targetKey, 'id:42');
  assert.equal(promoted.lease.owner, 'external');
  assert.equal(promoted.lease.version, claimed.lease.version);
  assert.equal(promoted.lease.expiresAt, claimed.lease.expiresAt);
  assert.equal(promoted.followResult, null);
  assert.deepEqual(promoted.importedHold, {state: 'followed', followResult: {added: true, following: true}});
  assert.equal(promoted.evaluations[0].taskId, 'eval-ada');
  assert.equal(promoted.evaluations[0].originalPostId, '900');
  const renewed = await store.renew({
    id: claimed.id,
    owner: 'external',
    version: claimed.lease.version,
    leaseMs: 80
  });
  assert.deepEqual(renewed, {ok: false, reason: 'imported-hold'});
  const afterRenew = (await store.list({accountId: 'acc-1'})).find(job => job.id === claimed.id);
  assert.equal(afterRenew.lease.version, claimed.lease.version);
  assert.equal(afterRenew.lease.expiresAt, claimed.lease.expiresAt);

  const skippedHold = await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '42',
    handle: 'ada',
    state: 'skipped',
    followResult: {reason: 'legacy-skip'},
    sources: []
  });
  assert.equal(skippedHold.importedHold.state, 'followed');
  assert.equal(skippedHold.importedHold.followResult.added, true);
  assert.equal(skippedHold.importedHold.followResult.following, true);
  assert.equal(skippedHold.lease.version, claimed.lease.version);
  const uncertainHold = await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '42',
    handle: 'ada',
    state: 'uncertain',
    followResult: {unknown: true},
    sources: []
  });
  assert.equal(uncertainHold.state, 'running');
  assert.equal(uncertainHold.importedHold.state, 'followed');
  assert.deepEqual(uncertainHold.importedHold.followResult, {added: true, following: true});
  assert.equal(uncertainHold.lease.expiresAt, claimed.lease.expiresAt);

  clock.t += 80;
  assert.equal(await store.claim({accountId: 'acc-1', owner: 'next', leaseMs: 40}), null);
  const closed = (await store.list({accountId: 'acc-1'})).find(job => job.id === claimed.id);
  assert.equal(closed.state, 'followed');
  assert.equal(closed.followResult.added, true);
  assert.equal(closed.importedHold, undefined);
  assert.equal(closed.lease.owner, '');
  assert.equal(closed.evaluations[0].taskId, 'eval-ada');

  const retryStore = storeFor();
  await retryStore.store.enqueue({
    accountId: 'acc-1',
    targetUserId: '42',
    sources: [{module: 'fans', url: 'https://x.com/ada', enabled: true}]
  });
  const verifiedRetry = await retryStore.store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 100});
  await retryStore.store.settle({
    id: verifiedRetry.id,
    owner: 'worker',
    version: verifiedRetry.lease.version,
    state: 'followed',
    patch: {
      stage: 'followed',
      followResult: {added: true, following: true},
      evaluations: [{
        taskId: 'eval-ada',
        originalAuthorId: '7',
        originalPostId: '900',
        originalPostUrl: 'https://x.com/i/status/900',
        text: 'kept',
        status: 'failed',
        publishedPostId: '',
        publishedPostUrl: '',
        attempts: [{at: 1, result: 'grok-failed'}]
      }]
    }
  });
  retryStore.indexedDB.databases.get('test-queue').db.data.jobs.clear();
  const retryOnly = await retryStore.store.enqueue({
    accountId: 'acc-1',
    handle: 'ada',
    sources: [{module: 'comments', url: 'https://x.com/p/ada-2', enabled: true}]
  });
  assert.equal(retryOnly.state, 'pending');
  assert.equal(retryOnly.targetKey, 'handle:ada');
  const retryClaim = await retryStore.store.claim({accountId: 'acc-1', owner: 'retry-worker', leaseMs: 30});
  assert.equal(retryClaim.id, retryOnly.id);
  await retryStore.store.settle({
    id: retryClaim.id,
    owner: 'retry-worker',
    version: retryClaim.lease.version,
    state: 'retry',
    patch: {stage: 'retry', nextEligibleAt: retryStore.clock.t}
  });
  const resolvedRetry = await retryStore.store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '42',
    handle: '@Ada',
    state: 'skipped',
    followResult: {reason: 'should-not-win'},
    sources: [{module: 'fans', url: 'https://x.com/ada', enabled: true}]
  });
  assert.equal(resolvedRetry.id, retryOnly.id);
  assert.equal(resolvedRetry.state, 'followed');
  assert.equal(resolvedRetry.targetUserId, '42');
  assert.equal(resolvedRetry.targetKey, 'id:42');
  assert.equal(resolvedRetry.followResult.added, true);
  assert.equal(resolvedRetry.followResult.following, true);
  assert.equal(resolvedRetry.importedHold, undefined);
  assert.equal(resolvedRetry.lease.owner, '');
  assert.equal(resolvedRetry.evaluations[0].originalPostId, '900');
  const weaker = await retryStore.store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '42',
    handle: 'ada',
    state: 'uncertain',
    followResult: {unknown: true},
    sources: []
  });
  assert.equal(weaker.id, retryOnly.id);
  assert.equal(weaker.state, 'followed');
  assert.deepEqual(weaker.followResult, {added: true, following: true});
  assert.equal(await retryStore.store.claim({accountId: 'acc-1', owner: 'resurrect', leaseMs: 30}), null);
});

test('renew is fenced and updateSources applies explicit booleans without rediscovery re-enabling', async () => {
  const {store, clock} = storeFor();
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '9',
    handle: 'nine',
    sources: [
      {module: 'fans', url: 'https://x.com/nine', enabled: true},
      {module: 'mutual', url: 'https://x.com/m/nine', enabled: true}
    ]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 30});
  const renewed = await store.renew({id: claimed.id, owner: 'worker', version: claimed.lease.version, leaseMs: 40});
  assert.equal(renewed.ok, true);
  assert.equal(renewed.job.lease.version, claimed.lease.version + 1);
  assert.equal(renewed.job.lease.expiresAt, clock.t + 40);
  const stale = await store.renew({id: claimed.id, owner: 'worker', version: claimed.lease.version, leaseMs: 40});
  assert.deepEqual(stale, {ok: false, reason: 'stale'});
  const wrong = await store.renew({id: claimed.id, owner: 'other', version: renewed.job.lease.version, leaseMs: 40});
  assert.equal(wrong.ok, false);
  clock.t += 40;
  const expired = await store.renew({id: claimed.id, owner: 'worker', version: renewed.job.lease.version, leaseMs: 40});
  assert.deepEqual(expired, {ok: false, reason: 'expired'});

  await store.enqueue({
    accountId: 'acc-2',
    targetUserId: '8',
    handle: 'eight',
    sources: [{module: 'comments', url: 'https://x.com/p/8', enabled: false}]
  });
  const updated = await store.updateSources({accountId: 'acc-1', modules: {fans: false, comments: true}});
  assert.equal(updated.length, 1);
  assert.equal(updated[0].sources.find(source => source.module === 'fans').enabled, false);
  assert.equal(updated[0].sources.find(source => source.module === 'mutual').enabled, true);
  const other = await store.list({accountId: 'acc-2'});
  assert.equal(other[0].sources[0].enabled, false);
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '9',
    handle: 'nine',
    sources: [{module: 'fans', url: 'https://x.com/nine', enabled: true}]
  });
  const jobs = await store.list({accountId: 'acc-1'});
  assert.equal(jobs.find(job => job.targetUserId === '9').sources.find(source => source.module === 'fans').enabled, false);
});

test('a live followed settle wins over importedHold and releases the lease', async () => {
  const {store} = storeFor();
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '881',
    handle: 'mia',
    sources: [{module: 'fans', url: 'https://x.com/mia', enabled: true}]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 80});
  await store.importOutcome({
    accountId: 'acc-1',
    targetUserId: '881',
    handle: 'mia',
    state: 'uncertain',
    followResult: {unknown: true},
    sources: []
  });
  const stale = await store.settle({
    id: claimed.id,
    owner: 'other',
    version: claimed.lease.version,
    state: 'followed',
    patch: {followResult: {added: true}}
  });
  assert.deepEqual(stale, {ok: false, reason: 'stale'});
  const won = await store.settle({
    id: claimed.id,
    owner: 'worker',
    version: claimed.lease.version,
    state: 'skipped',
    patch: {
      stage: 'followed',
      followResult: {added: true},
      evaluations: [{taskId: 'live', reason: 'clicked', channel: 'fans', attempts: [{at: 1, result: 'ok'}]}]
    }
  });
  assert.equal(won.ok, true);
  assert.equal(won.job.state, 'followed');
  assert.equal(won.job.followResult.added, true);
  assert.equal(won.job.importedHold, undefined);
  assert.equal(won.job.lease.owner, '');
  assert.equal(won.job.evaluations[0].reason, 'clicked');
  assert.equal(won.job.evaluations[0].channel, 'fans');
  assert.equal(won.job.evaluations[0].attempts[0].result, 'ok');
  const next = await store.claim({accountId: 'acc-1', owner: 'next', leaseMs: 40});
  assert.equal(next, null);
});

test('collapsing a leased job with a durable twin records importedHold and followed outranks uncertain', async () => {
  const {store, indexedDB} = storeFor();
  const running = await store.enqueue({
    accountId: 'acc-1',
    handle: 'cara',
    sources: [{module: 'comments', url: 'https://x.com/p/cara', enabled: true}]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 200});
  assert.equal(claimed.id, running.id);
  indexedDB.databases.get('test-queue').db.data.jobs.set('fq_durable_cara', {
    id: 'fq_durable_cara',
    accountId: 'acc-1',
    action: 'follow',
    targetUserId: '640',
    targetKey: 'id:640',
    handle: 'cara',
    handleCanonical: 'cara',
    aliases: [],
    sources: [{module: 'fans', url: 'https://x.com/cara', enabled: false, discoveredAt: 1}],
    state: 'uncertain',
    stage: 'verify',
    createdAt: 1,
    updatedAt: 1,
    nextEligibleAt: 1,
    lease: {owner: '', version: 0, expiresAt: 0},
    followResult: {unknown: true},
    evaluations: [{taskId: 'prior', reason: 'needs-verify', channel: 'fans', attempts: 3, status: 'failed'}]
  });
  const held = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '640',
    handle: 'cara',
    sources: [{module: 'mutual', url: 'https://x.com/mutual/cara', enabled: false}]
  });
  assert.equal(held.id, claimed.id);
  assert.equal(held.state, 'running');
  assert.equal(held.targetUserId, '640');
  assert.equal(held.targetKey, 'id:640');
  assert.equal(held.lease.owner, 'worker');
  assert.deepEqual(held.importedHold, {state: 'uncertain', followResult: {unknown: true}});
  assert.equal(held.evaluations[0].reason, 'needs-verify');
  assert.equal(held.evaluations[0].channel, 'fans');
  assert.equal(held.evaluations[0].attempts, 3);
  assert.equal((await store.list({accountId: 'acc-1'})).length, 1);

  const {store: quiet, indexedDB: quietDb} = storeFor();
  const followed = await quiet.importOutcome({
    accountId: 'acc-1',
    targetUserId: '641',
    handle: 'dee',
    state: 'followed',
    followResult: {following: true, added: true},
    sources: [{module: 'fans', url: 'https://x.com/dee', enabled: false}]
  });
  quietDb.databases.get('test-queue').db.data.jobs.set('fq_uncertain_dee', {
    id: 'fq_uncertain_dee',
    accountId: 'acc-1',
    action: 'follow',
    targetUserId: '',
    targetKey: 'handle:dee',
    handle: 'dee',
    handleCanonical: 'dee',
    aliases: [],
    sources: [],
    state: 'uncertain',
    stage: 'verify',
    createdAt: 2,
    updatedAt: 2,
    nextEligibleAt: 2,
    lease: {owner: '', version: 0, expiresAt: 0},
    followResult: {unknown: true},
    evaluations: []
  });
  const collapsed = await quiet.enqueue({
    accountId: 'acc-1',
    targetUserId: '641',
    handle: 'dee',
    sources: [{module: 'comments', url: 'https://x.com/p/dee', enabled: false}]
  });
  assert.equal(collapsed.id, followed.id);
  assert.equal(collapsed.state, 'followed');
  assert.equal(collapsed.followResult.following, true);
  assert.equal((await quiet.list({accountId: 'acc-1'})).length, 1);
});

test('resolveJob reopens a verified unfollow and can overwrite a weaker outcome', async () => {
  const {store, indexedDB} = storeFor();
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '77',
    handle: 'nia',
    sources: [{module: 'fans', url: 'https://x.com/nia', enabled: true}]
  });
  const claimed = await store.claim({accountId: 'acc-1', owner: 'worker', leaseMs: 40});
  await store.settle({
    id: claimed.id,
    owner: 'worker',
    version: claimed.lease.version,
    state: 'uncertain',
    patch: {stage: 'verify', followResult: {unknown: true}}
  });
  const blocked = await store.resolveJob({
    accountId: 'acc-1',
    id: 'missing',
    state: 'pending'
  });
  assert.deepEqual(blocked, {ok: false, reason: 'missing'});
  const reopened = await store.resolveJob({
    accountId: 'acc-1',
    id: claimed.id,
    state: 'pending',
    stage: 'queued',
    followResult: null,
    nextEligibleAt: 1,
    evaluations: [{taskId: 'again', reason: 'unfollowed', channel: 'manual', attempts: 1, status: 'open'}]
  });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.job.state, 'pending');
  assert.equal(reopened.job.lease.owner, '');
  assert.equal(reopened.job.evaluations[0].reason, 'unfollowed');
  assert.equal(reopened.job.evaluations[0].attempts, 1);
  const outcomes = [...indexedDB.databases.get('test-queue').db.data.outcomes.values()];
  assert.equal(outcomes.length, 0);
  const again = await store.claim({accountId: 'acc-1', owner: 'worker-2', leaseMs: 40});
  assert.equal(again.id, claimed.id);

  const leased = await store.resolveJob({
    accountId: 'acc-1',
    id: claimed.id,
    state: 'skipped'
  });
  assert.deepEqual(leased, {ok: false, reason: 'leased'});

  await store.settle({
    id: again.id,
    owner: 'worker-2',
    version: again.lease.version,
    state: 'uncertain',
    patch: {followResult: {unknown: true}, stage: 'verify'}
  });
  const overwritten = await store.resolveJob({
    accountId: 'acc-1',
    id: claimed.id,
    state: 'skipped',
    stage: 'skipped',
    followResult: {reason: 'operator'}
  });
  assert.equal(overwritten.ok, true);
  assert.equal(overwritten.job.state, 'skipped');
  assert.equal(overwritten.job.followResult.reason, 'operator');
  const stored = [...indexedDB.databases.get('test-queue').db.data.outcomes.values()];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].state, 'skipped');
  assert.equal(await store.claim({accountId: 'acc-1', owner: 'nope', leaseMs: 20}), null);
  await assert.rejects(
    () => store.resolveJob({accountId: 'acc-1', id: claimed.id, state: 'running'}),
    /invalid follow queue state/
  );
});
