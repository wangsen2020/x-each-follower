import test from 'node:test';
import assert from 'node:assert/strict';
import {createFollowQueueStore} from '../src/features/follow-queue/follow-queue-store.js';
import {createFollowQueueScheduler} from '../src/features/follow-queue/follow-queue-scheduler.js';

function installKeyRange() {
  if (globalThis.IDBKeyRange) return;
  globalThis.IDBKeyRange = {
    only(value) { return {lower: value, upper: value, lowerOpen: false, upperOpen: false}; },
    bound(lower, upper, lowerOpen, upperOpen) { return {lower, upper, lowerOpen: !!lowerOpen, upperOpen: !!upperOpen}; },
    lowerBound(lower, open) { return {lower, lowerOpen: !!open}; },
    upperBound(upper, open) { return {upper, upperOpen: !!open}; }
  };
}

function createFakeIndexedDB() {
  installKeyRange();
  const databases = new Map();

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function typeRank(value) {
    if (typeof value === 'number') return 1;
    if (typeof value === 'string') return 2;
    if (Array.isArray(value)) return 3;
    return 4;
  }

  function compareKeys(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      const length = Math.min(a.length, b.length);
      for (let i = 0; i < length; i += 1) {
        const diff = compareKeys(a[i], b[i]);
        if (diff) return diff;
      }
      return a.length - b.length;
    }
    const rank = typeRank(a) - typeRank(b);
    if (rank) return rank;
    if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
    const left = String(a);
    const right = String(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function inRange(key, range) {
    if (!range) return true;
    if (Object.prototype.hasOwnProperty.call(range, 'lower')) {
      const diff = compareKeys(key, range.lower);
      if (diff < 0 || (diff === 0 && range.lowerOpen)) return false;
    }
    if (Object.prototype.hasOwnProperty.call(range, 'upper')) {
      const diff = compareKeys(key, range.upper);
      if (diff > 0 || (diff === 0 && range.upperOpen)) return false;
    }
    return true;
  }

  function createDatabase() {
    const data = {jobs: new Map(), outcomes: new Map(), settings: new Map(), meta: new Map()};
    const indexes = {jobs: new Map(), outcomes: new Map(), settings: new Map(), meta: new Map()};
    let chain = Promise.resolve();
    return {
      data,
      createObjectStore(name) {
        if (!data[name]) data[name] = new Map();
        if (!indexes[name]) indexes[name] = new Map();
        return {
          createIndex(indexName, keyPath, options = {}) {
            indexes[name].set(indexName, {keyPath, multiEntry: options.multiEntry === true});
          }
        };
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

        function indexEntries(name, spec) {
          const rows = [];
          for (const record of data[name].values()) {
            const raw = Array.isArray(spec.keyPath) ? spec.keyPath.map(part => record[part]) : record[spec.keyPath];
            let keys = [];
            if (Array.isArray(spec.keyPath)) {
              if (raw.every(part => part !== undefined)) keys = [raw];
            } else if (spec.multiEntry && Array.isArray(raw)) {
              keys = raw.filter(part => part !== undefined);
            } else if (raw !== undefined) keys = [raw];
            for (const key of keys) rows.push({key, record});
          }
          rows.sort((a, b) => compareKeys(a.key, b.key));
          return rows;
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
          },
          index(indexName) {
            const spec = indexes[name].get(indexName);
            if (!spec) throw new Error(`missing index ${indexName}`);
            const rowsFor = range => indexEntries(name, spec).filter(entry => inRange(entry.key, range));
            return {
              get(key) {
                return request(() => clone(rowsFor({lower: key, upper: key, lowerOpen: false, upperOpen: false})[0]?.record));
              },
              count(range) {
                return request(() => rowsFor(range).length);
              },
              openCursor(range) {
                const requestObject = {};
                const rows = rowsFor(range);
                let index = 0;
                const step = () => {
                  pending += 1;
                  previous.then(() => {
                    try {
                      if (index >= rows.length) requestObject.result = null;
                      else {
                        const current = rows[index];
                        requestObject.result = {
                          value: clone(current.record),
                          key: clone(current.key),
                          primaryKey: current.record.id || current.record.key,
                          continue() { index += 1; step(); },
                          update(value) { return storeApi(name).put(value); }
                        };
                      }
                      pending -= 1;
                      requestObject.onsuccess?.();
                      scheduleCommit();
                    } catch (error) {
                      pending -= 1;
                      requestObject.error = error;
                      tx.error = error;
                      requestObject.onerror?.();
                    }
                  });
                };
                step();
                return requestObject;
              }
            };
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

function setupEnv(clock = {t: 10_000}) {
  const indexedDB = createFakeIndexedDB();
  const store = createFollowQueueStore({
    indexedDB,
    dbName: 'scheduler-test-db',
    now: () => clock.t
  });
  const origEnqueue = store.enqueue.bind(store);
  store.enqueue = async args => {
    clock.t += 1;
    return origEnqueue(args);
  };
  return {store, indexedDB, clock};
}

test('blocked run reports the specific cause and retry time without claiming jobs',async()=>{
  const {store,clock}=setupEnv();
  await store.saveSettings('acc-1',{enabled:true});
  const blockReason={code:'follow-cooldown',retryAt:clock.t+3600000,message:'关注限流，暂停至指定时间后重试'};
  const events=[];
  const scheduler=createFollowQueueScheduler({store,now:()=>clock.t,canRun:async()=>false,
    getBlockReason:()=>blockReason,execute:async()=>assert.fail('must not execute'),onEvent:async e=>events.push(e)});
  const result=await scheduler.run({accountId:'acc-1'});
  assert.equal(result.summary,blockReason.message);
  assert.deepEqual(events.find(e=>e.type==='run-blocked').blockReason,blockReason);
});

test('comment quota metadata cannot stop subsequent automatic follows', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled:true,batchLimit:5,inspectLimit:10});
  for (const handle of ['first','second']) await store.enqueue({accountId:'acc-1',handle,sources:[{module:'fans',enabled:true}]});
  let calls=0;
  const scheduler=createFollowQueueScheduler({store,now:()=>clock.t,owner:'worker',canRun:async()=>true,
    execute:async()=>{calls++;return {state:'followed',followResult:{succeeded:true},quotaExhausted:true};}});
  const result=await scheduler.run({accountId:'acc-1'});
  assert.equal(calls,2);
  assert.doesNotMatch(result.summary,/额度已耗尽/);
  assert.ok((await store.list({accountId:'acc-1'})).every(job=>job.state==='followed'));
});

test('successful follow clears previous failure at checkpoint and final persistence',async()=>{
  const {store,clock}=setupEnv();
  await store.saveSettings('acc-1',{enabled:true});
  const job=await store.enqueue({accountId:'acc-1',handle:'recovered',sources:[{module:'fans',enabled:true}]});
  await store.resolveJob({accountId:'acc-1',id:job.id,state:'pending',followResult:{
    retryCount:2,reason:'用户资料接口限流',error:'old error',responseStatus:429,exhaustedRetries:true}});
  const events=[];
  const scheduler=createFollowQueueScheduler({store,now:()=>clock.t,canRun:async()=>true,
    onEvent:async event=>events.push(event),execute:async(_job,_settings,control)=>{
      await control.checkpoint({stage:'followed',followResult:{succeeded:true,targetUserId:'123'}});
      const current=(await store.list({accountId:'acc-1'}))[0];
      assert.equal(current.followResult.reason,'');
      assert.equal(current.followResult.responseStatus,undefined);
      return {state:'followed',followResult:{succeeded:true,targetUserId:'123'}};
    }});
  await scheduler.run({accountId:'acc-1'});
  const saved=(await store.list({accountId:'acc-1'}))[0];
  assert.equal(saved.state,'followed');assert.equal(saved.followResult.reason,'');
  assert.equal(saved.followResult.error,undefined);assert.equal(saved.followResult.exhaustedRetries,undefined);
  assert.equal(events.find(e=>e.type==='job-complete').followResult.reason,'');
});

test('batchLimit counts only new follows while alreadyFollowing and skipped continue within inspectLimit', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true, batchLimit: 2, inspectLimit: 10, timeBudgetMinutes: 10});

  const handles = ['already1', 'skip1', 'new1', 'already2', 'new2', 'new3'];
  for (let i = 0; i < handles.length; i += 1) {
    clock.t += 10;
    await store.enqueue({
      accountId: 'acc-1',
      targetUserId: String(100 + i),
      handle: handles[i],
      sources: [{module: 'fans', url: `https://x.com/${handles[i]}`, enabled: true}]
    });
  }

  const events = [];
  const scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    owner: 'worker-1',
    canRun: async () => true,
    onEvent: async ev => {
      events.push(ev);
      if (ev.type === 'job-start') throw new Error('logger failure must be swallowed');
    },
    execute: async (job, _settings, control) => {
      assert.equal(await control.canAct(), true);
      if (job.handle.startsWith('already')) {
        return {
          state: 'followed',
          followResult: {succeeded: true, alreadyFollowing: true, targetUserId: job.targetUserId, at: clock.t},
          evaluations: []
        };
      }
      if (job.handle.startsWith('skip')) {
        return {state: 'skipped', reason: '比例偏低'};
      }
      await control.checkpoint({stage: 'following', followResult: {attemptedAt: clock.t, targetUserId: job.targetUserId}});
      const followResult = {succeeded: true, alreadyFollowing: false, targetUserId: job.targetUserId, at: clock.t};
      await control.checkpoint({stage: 'followed', followResult});
      return {
        state: 'followed',
        followResult,
        evaluations: [{
          taskId: `acc-1:${job.id}`,
          followJobId: job.id,
          targetUserId: job.targetUserId,
          originalAuthorId: job.targetUserId,
          originalPostId: '999',
          originalPostUrl: 'https://x.com/i/status/999',
          text: '好帖',
          status: 'posted',
          publishedPostId: '1000',
          publishedPostUrl: 'https://x.com/me/status/1000',
          attempts: []
        }]
      };
    }
  });

  const result = await scheduler.run({accountId: 'acc-1'});
  assert.equal(result.ok, true);
  assert.equal(result.counters.inspected, 5);
  assert.equal(result.counters.followed, 2);
  assert.equal(result.counters.alreadyFollowing, 2);
  assert.equal(result.counters.skipped, 1);
  assert.equal(result.counters.quotePublished, 2);
  assert.match(result.summary, /本轮检查 5 人：新增关注 2、原已关注 2、策略跳过 1/);
  assert.match(result.summary, /引用评价：发布 2/);
  assert.ok(events.some(e => e.type === 'run-complete'));

  const jobs = await store.list({accountId: 'acc-1'});
  const thirdNew = jobs.find(j => j.handle === 'new3');
  assert.equal(thirdNew.state, 'pending');
});

test('inspectLimit and timeBudgetMinutes stop the cycle cleanly', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true, batchLimit: 5, inspectLimit: 2, timeBudgetMinutes: 1});

  for (let i = 1; i <= 4; i += 1) {
    clock.t += 1;
    await store.enqueue({
      accountId: 'acc-1',
      targetUserId: String(200 + i),
      handle: `user${i}`,
      sources: [{module: 'mutual', url: `https://x.com/u${i}`, enabled: true}]
    });
  }

  const scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    canRun: async () => true,
    execute: async () => ({state: 'skipped', reason: '粉丝不足'})
  });

  const firstRun = await scheduler.run({accountId: 'acc-1'});
  assert.equal(firstRun.ok, true);
  assert.equal(firstRun.counters.inspected, 2);
  assert.equal(firstRun.counters.skipped, 2);

  await store.saveSettings('acc-1', {enabled: true, batchLimit: 5, inspectLimit: 10, timeBudgetMinutes: 1});
  const timeScheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    canRun: async () => true,
    execute: async () => {
      clock.t += 65_000;
      return {state: 'skipped', reason: '耗时跳过'};
    }
  });

  const secondRun = await timeScheduler.run({accountId: 'acc-1'});
  assert.equal(secondRun.counters.inspected, 1);
  const remaining = (await store.list({accountId: 'acc-1'})).filter(j => j.state === 'pending');
  assert.equal(remaining.length, 1);
});

test('fresh pending candidates run before retry jobs and pre-action transient retries cap at 3 across scheduler restarts', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true, batchLimit: 5, inspectLimit: 10, timeBudgetMinutes: 10});

  const flaky = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '301',
    handle: 'flaky',
    sources: [{module: 'fans', url: 'https://x.com/flaky', enabled: true}]
  });

  let freshAdded = false;
  const order = [];
  const makeScheduler = () => createFollowQueueScheduler({
    store,
    now: () => clock.t,
    canRun: async () => true,
    execute: async job => {
      order.push(`${job.handle}:${job.state}`);
      if (job.handle === 'flaky') {
        if (!freshAdded) {
          freshAdded = true;
          clock.t += 1;
          await store.enqueue({
            accountId: 'acc-1',
            targetUserId: '302',
            handle: 'fresh',
            sources: [{module: 'fans', url: 'https://x.com/fresh', enabled: true}]
          });
        }
        return {state: 'retry', reason: '主页资料读取超时'};
      }
      return {
        state: 'followed',
        followResult: {succeeded: true, alreadyFollowing: false, targetUserId: job.targetUserId, at: clock.t}
      };
    }
  });

  // Cycle 1 with scheduler instance 1
  const run1 = await makeScheduler().run({accountId: 'acc-1'});
  assert.equal(run1.counters.retried, 1);
  assert.equal(run1.counters.followed, 1);
  assert.deepEqual(order, ['flaky:running', 'fresh:running']);

  let flakyJob = (await store.list({accountId: 'acc-1'})).find(j => j.id === flaky.id);
  assert.equal(flakyJob.state, 'retry');
  assert.equal(flakyJob.followResult.retryCount, 1);
  const firstEligible = flakyJob.nextEligibleAt;
  assert.ok(firstEligible >= clock.t + 5 * 60_000 - 10);

  // Before nextEligibleAt, nothing claimed
  clock.t += 60_000;
  const earlyRun = await makeScheduler().run({accountId: 'acc-1'});
  assert.equal(earlyRun.counters.inspected, 0);

  // Attempt 2 on a brand-new scheduler instance (simulating worker restart) at +5m -> retry +15m
  clock.t = firstEligible + 1;
  await makeScheduler().run({accountId: 'acc-1'});
  flakyJob = (await store.list({accountId: 'acc-1'})).find(j => j.id === flaky.id);
  assert.equal(flakyJob.state, 'retry');
  assert.equal(flakyJob.followResult.retryCount, 2);
  assert.equal(flakyJob.nextEligibleAt, clock.t + 15 * 60_000);

  // Attempt 3 on a brand-new scheduler instance at +15m -> retry +60m
  clock.t = flakyJob.nextEligibleAt + 1;
  await makeScheduler().run({accountId: 'acc-1'});
  flakyJob = (await store.list({accountId: 'acc-1'})).find(j => j.id === flaky.id);
  assert.equal(flakyJob.state, 'retry');
  assert.equal(flakyJob.followResult.retryCount, 3);
  assert.equal(flakyJob.nextEligibleAt, clock.t + 60 * 60_000);

  // Attempt 4 after 3 persisted retries -> held as uncertain
  clock.t = flakyJob.nextEligibleAt + 1;
  const finalRun = await makeScheduler().run({accountId: 'acc-1'});
  assert.equal(finalRun.counters.uncertain, 1);
  flakyJob = (await store.list({accountId: 'acc-1'})).find(j => j.id === flaky.id);
  assert.equal(flakyJob.state, 'uncertain');
  assert.equal(flakyJob.stage, 'verify');
  assert.equal(flakyJob.followResult.exhaustedRetries, true);
});

test('long >60s Grok generation uses default 60s lease, renews via serialized heartbeat, preserves followed checkpoint, and cleans up timers', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true, timeBudgetMinutes: 10, grokEnabled: true, autoPublish: true});

  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '400',
    handle: 'longGrok',
    sources: [{module: 'comments', url: 'https://x.com/p/long', enabled: true}]
  });

  let initialLeaseSpan = 0;
  const scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    owner: 'worker-long',
    heartbeatMs: 15,
    canRun: async () => true,
    execute: async (job, _settings, control) => {
      // Verify default lease is short 60s (not the entire 10-minute cycle)
      initialLeaseSpan = job.lease.expiresAt - clock.t;
      assert.equal(initialLeaseSpan, 60_000);

      assert.equal(await control.canAct(), true);
      await control.checkpoint({stage: 'following', followResult: {attemptedAt: clock.t, targetUserId: job.targetUserId}});
      const followResult = {succeeded: true, alreadyFollowing: false, targetUserId: job.targetUserId, at: clock.t};
      await control.checkpoint({stage: 'followed', followResult});

      const evaluation = {
        taskId: `acc-1:${job.targetUserId}`,
        followJobId: job.id,
        targetUserId: job.targetUserId,
        originalAuthorId: job.targetUserId,
        originalPostId: '888',
        originalPostUrl: 'https://x.com/i/status/888',
        status: 'generating',
        attempts: 1
      };
      await control.checkpoint({stage: 'evaluating', followResult, evaluations: [evaluation]});

      // Simulate >120 seconds of Grok generation across serialized heartbeat ticks (> 60s default lease)
      for (let i = 0; i < 3; i += 1) {
        clock.t += 45_000;
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      // Checkpoint after 135s must succeed because serialized heartbeats renewed the 60s lease
      evaluation.text = '深度引用评价';
      evaluation.status = 'draft';
      await control.checkpoint({stage: 'evaluated', followResult, evaluations: [evaluation]});

      assert.equal(await control.canAct(), true);
      evaluation.status = 'posted';
      evaluation.publishedPostId = '889';
      evaluation.publishedPostUrl = 'https://x.com/me/status/889';
      return {state: 'followed', followResult, evaluations: [evaluation]};
    }
  });

  const res = await scheduler.run({accountId: 'acc-1'});
  assert.equal(res.ok, true);
  assert.equal(initialLeaseSpan, 60_000);
  assert.equal(res.counters.followed, 1);
  assert.equal(res.counters.quotePublished, 1);

  const [job] = await store.list({accountId: 'acc-1'});
  assert.equal(job.state, 'followed');
  assert.equal(job.followResult.succeeded, true);
  assert.equal(job.evaluations[0].status, 'posted');
});

test('periodic heartbeat renews short lease safely alongside checkpoint and canAct without orphan timers', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true, timeBudgetMinutes: 10});

  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '405',
    handle: 'heartbeatUser',
    sources: [{module: 'fans', url: 'https://x.com/hb', enabled: true}]
  });

  const scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    owner: 'worker-hb',
    leaseMs: 1_000,
    heartbeatMs: 15,
    canRun: async () => true,
    execute: async (job, _settings, control) => {
      // Wait for at least 2 real heartbeat intervals while advancing fake clock by 400ms each tick
      for (let i = 0; i < 3; i += 1) {
        clock.t += 400;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      // Total elapsed on clock is 1200ms > 1000ms initial leaseMs, but heartbeat renewed it!
      await control.checkpoint({
        stage: 'followed',
        followResult: {succeeded: true, alreadyFollowing: false, targetUserId: job.targetUserId, at: clock.t}
      });
      assert.equal(await control.canAct(), true);
      return {
        state: 'followed',
        followResult: {succeeded: true, alreadyFollowing: false, targetUserId: job.targetUserId, at: clock.t}
      };
    }
  });

  const res = await scheduler.run({accountId: 'acc-1'});
  assert.equal(res.ok, true);
  assert.equal(res.counters.followed, 1);

  const [settledJob] = await store.list({accountId: 'acc-1'});
  assert.equal(settledJob.state, 'followed');
  assert.ok(settledJob.lease.version >= 3);
});

test('successful follow persists as followed even when Grok evaluation or quote publish fails or throws', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true, grokEnabled: true, autoPublish: true});

  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '401',
    handle: 'evalThrows',
    sources: [{module: 'comments', url: 'https://x.com/p/1', enabled: true}]
  });
  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '402',
    handle: 'evalFails',
    sources: [{module: 'comments', url: 'https://x.com/p/2', enabled: true}]
  });

  const scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    canRun: async () => true,
    execute: async (job, _settings, control) => {
      assert.equal(await control.canAct(), true);
      await control.checkpoint({stage: 'following', followResult: {attemptedAt: clock.t, targetUserId: job.targetUserId}});
      const followResult = {succeeded: true, alreadyFollowing: false, targetUserId: job.targetUserId, at: clock.t};
      await control.checkpoint({stage: 'followed', followResult});

      const evaluation = {
        taskId: `acc-1:${job.targetUserId}`,
        followJobId: job.id,
        targetUserId: job.targetUserId,
        originalAuthorId: job.targetUserId,
        originalPostId: job.targetUserId,
        originalPostUrl: `https://x.com/i/status/${job.targetUserId}`,
        text: '',
        status: 'failed',
        reason: 'Grok 生成超时'
      };
      await control.checkpoint({stage: 'evaluated', followResult, evaluations: [evaluation]});

      if (job.handle === 'evalThrows') {
        throw new Error('quote composer unexpected crash');
      }
      return {
        state: 'uncertain',
        followResult,
        evaluations: [evaluation],
        reason: 'Grok 生成超时'
      };
    }
  });

  const res = await scheduler.run({accountId: 'acc-1'});
  assert.equal(res.ok, true);
  assert.equal(res.counters.followed, 2);
  assert.equal(res.counters.quoteFailed, 2);

  const jobs = await store.list({accountId: 'acc-1'});
  for (const job of jobs) {
    assert.equal(job.state, 'followed');
    assert.equal(job.followResult.succeeded, true);
    assert.equal(job.evaluations.length, 1);
    assert.equal(job.evaluations[0].status, 'failed');
  }
});

test('pre-action interruption settles retry, while interruption after attemptedAt or publishing settles uncertain or followed', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true});

  const preThrowJob = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '500',
    handle: 'preThrow',
    sources: [{module: 'fans', url: 'https://x.com/preThrow', enabled: true}]
  });
  const postAttemptJob = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '501',
    handle: 'mystery',
    sources: [{module: 'fans', url: 'https://x.com/mystery', enabled: true}]
  });
  const publishingJob = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '502',
    handle: 'pubInterrupted',
    sources: [{module: 'comments', url: 'https://x.com/pubInterrupted', enabled: true}]
  });

  const scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    canRun: async () => true,
    execute: async (job, _settings, control) => {
      assert.equal(await control.canAct(), true);
      if (job.id === preThrowJob.id) {
        // Pre-action checkpoint without attemptedAt or publishing
        await control.checkpoint({stage: 'inspecting'});
        throw new Error('tab crashed before follow click');
      }
      if (job.id === postAttemptJob.id) {
        await control.checkpoint({stage: 'following', followResult: {attemptedAt: clock.t, targetUserId: job.targetUserId}});
        throw new Error('network socket hang up after follow request sent');
      }
      // publishing stage without followSucceeded -> must settle uncertain, not retry
      await control.checkpoint({
        stage: 'publishing',
        evaluations: [{
          taskId: `acc-1:${job.id}`,
          followJobId: job.id,
          targetUserId: job.targetUserId,
          originalAuthorId: job.targetUserId,
          originalPostId: '777',
          originalPostUrl: 'https://x.com/i/status/777',
          text: '评',
          status: 'publishing'
        }]
      });
      throw new Error('interrupted during publishing');
    }
  });

  const res = await scheduler.run({accountId: 'acc-1'});
  assert.equal(res.counters.retried, 1);
  assert.equal(res.counters.uncertain, 2);

  const jobs = await store.list({accountId: 'acc-1'});
  const preJob = jobs.find(j => j.id === preThrowJob.id);
  const postJob = jobs.find(j => j.id === postAttemptJob.id);
  const pubJob = jobs.find(j => j.id === publishingJob.id);

  assert.equal(preJob.state, 'retry');
  assert.equal(preJob.stage, 'retry');
  assert.equal(preJob.followResult.retryCount, 1);

  assert.equal(postJob.state, 'uncertain');
  assert.equal(postJob.stage, 'verify');

  assert.equal(pubJob.state, 'uncertain');
  assert.equal(pubJob.stage, 'verify');
});

test('pause aborts active controller immediately, persists settings.enabled=false, and explicit manual run resumes paused account without enabling recurring scheduler', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: false});

  const job1 = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '601',
    handle: 'manualJob',
    sources: [{module: 'fans', url: 'https://x.com/manualJob', enabled: true}]
  });
  const job2 = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '602',
    handle: 'secondJob',
    sources: [{module: 'fans', url: 'https://x.com/secondJob', enabled: true}]
  });
  const job3 = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '603',
    handle: 'thirdJob',
    sources: [{module: 'fans', url: 'https://x.com/thirdJob', enabled: true}]
  });

  let accountValid = true;
  let signalAbortedOnPause = false;
  let scheduler;
  scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    owner: 'worker-renew',
    leaseMs: 1_000,
    canRun: async () => accountValid,
    execute: async (job, _settings, control) => {
      assert.equal(await control.canAct(), true);
      const afterRenew = (await store.list({accountId: 'acc-1'})).find(j => j.id === job.id);
      assert.ok(afterRenew.lease.version >= 2);

      await control.checkpoint({
        stage: 'following',
        followResult: {attemptedAt: clock.t, targetUserId: job.targetUserId}
      });

      await store.updateSources({accountId: 'acc-1', modules: {fans: false}});
      assert.equal(await control.canAct(), false);

      await store.updateSources({accountId: 'acc-1', modules: {fans: true}});
      assert.equal(await control.canAct(), true);

      accountValid = false;
      assert.equal(await control.canAct(), false);
      accountValid = true;

      if (job.id === job1.id) {
        control.signal.addEventListener('abort', () => {
          signalAbortedOnPause = true;
        }, {once: true});
        await scheduler.pause('acc-1');
        assert.equal(control.signal.aborted, true);
        assert.equal(signalAbortedOnPause, true);
        assert.equal(await control.canAct(), false);
      }

      if (job.id === job2.id) {
        // Pause again after job2 so we can also test resuming via settings.enabled=true for job3
        await scheduler.pause('acc-1');
      }

      return {
        state: 'followed',
        followResult: {succeeded: true, alreadyFollowing: false, targetUserId: job.targetUserId, at: clock.t}
      };
    }
  });

  // Scheduled run with enabled=false is a no-op
  const autoRes = await scheduler.run({accountId: 'acc-1', manual: false});
  assert.equal(autoRes.skipped, true);
  assert.equal(autoRes.counters.inspected, 0);

  // Manual run bypasses enabled=false, runs job1, pauses during job1 (aborting active controller), and does NOT start secondJob
  const manualRes = await scheduler.run({accountId: 'acc-1', manual: true});
  assert.equal(manualRes.ok, true);
  assert.equal(manualRes.paused, true);
  assert.equal(signalAbortedOnPause, true);
  assert.equal(manualRes.counters.inspected, 1);
  assert.equal(manualRes.counters.followed, 1);
  assert.equal((await store.getSettings('acc-1')).enabled, false);

  let jobs = await store.list({accountId: 'acc-1'});
  assert.equal(jobs.find(j => j.id === job1.id).state, 'followed');
  assert.equal(jobs.find(j => j.id === job2.id).state, 'pending');

  // While paused (and settings.enabled is false), scheduled alarm run is blocked
  const autoWhilePaused = await scheduler.run({accountId: 'acc-1', manual: false});
  assert.equal(autoWhilePaused.ok, false);
  assert.equal(autoWhilePaused.reason, 'paused');

  // Explicit manual run CAN resume paused account without enabling recurring scheduler (settings.enabled remains false)
  const manualResume = await scheduler.run({accountId: 'acc-1', manual: true});
  assert.equal(manualResume.ok, true);
  assert.equal(manualResume.counters.inspected, 1);
  assert.equal(manualResume.counters.followed, 1);
  assert.equal((await store.getSettings('acc-1')).enabled, false);
  jobs = await store.list({accountId: 'acc-1'});
  assert.equal(jobs.find(j => j.id === job2.id).state, 'followed');
  assert.equal(jobs.find(j => j.id === job3.id).state, 'pending');

  // User explicitly re-enables settings.enabled=true in UI -> next scheduled alarm run (manual: false) resumes!
  await store.saveSettings('acc-1', {enabled: true});
  const resumedAlarmRun = await scheduler.run({accountId: 'acc-1', manual: false});
  assert.equal(resumedAlarmRun.ok, true);
  assert.equal(resumedAlarmRun.paused, false);
  assert.equal(resumedAlarmRun.counters.inspected, 1);
  assert.equal(resumedAlarmRun.counters.followed, 1);
  assert.equal((await store.list({accountId: 'acc-1'})).find(j => j.id === job3.id).state, 'followed');

  // Verify pause propagates storage errors instead of swallowing them
  const origSaveSettings = store.saveSettings.bind(store);
  store.saveSettings = async () => {
    throw new Error('storage write failure');
  };
  await assert.rejects(() => scheduler.pause('acc-1'), /storage write failure/);
  store.saveSettings = origSaveSettings;
});

test('imported durable hold during active lease causes canAct and checkpoint to fail closed natively', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true});

  await store.enqueue({
    accountId: 'acc-1',
    handle: '@CollisionUser',
    sources: [{module: 'comments', url: 'https://x.com/p/c1', enabled: true}]
  });

  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '1000',
    handle: '@NextUser',
    sources: [{module: 'fans', url: 'https://x.com/f/next', enabled: true}]
  });

  const scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    owner: 'worker-collision',
    canRun: async () => true,
    execute: async (job, _settings, control) => {
      assert.equal(await control.canAct(), true);
      if (job.handle === 'CollisionUser') {
        // While job is running, a durable outcome is imported for the same user (sets importedHold on running job)
        await store.importOutcome({
          accountId: 'acc-1',
          targetUserId: '999',
          handle: 'CollisionUser',
          state: 'followed',
          followResult: {following: true},
          sources: [{module: 'fans', url: 'https://x.com/f/c1', enabled: false}]
        });
        // Native store + scheduler check: both canAct and checkpoint fail closed without any stubbing!
        assert.equal(await control.canAct(), false);
        await assert.rejects(() => control.checkpoint({stage: 'following'}), /checkpoint/);
        return {state: 'uncertain', reason: 'collision detected'};
      }
      return {
        state: 'followed',
        followResult: {succeeded: true, alreadyFollowing: false, targetUserId: job.targetUserId, at: clock.t}
      };
    }
  });

  const res = await scheduler.run({accountId: 'acc-1'});
  assert.equal(res.ok, true);
  assert.equal(res.counters.inspected, 2);
  assert.equal(res.counters.alreadyFollowing, 1);
  assert.equal(res.counters.followed, 1);
});

test('checkpoint throws when lease is lost or expired, and one-run-in-memory blocks concurrent run calls', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true});

  await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '701',
    handle: 'slow',
    sources: [{module: 'fans', url: 'https://x.com/slow', enabled: true}]
  });

  let releaseJob;
  const gate = new Promise(resolve => { releaseJob = resolve; });
  let concurrentResult;

  const scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    owner: 'worker-a',
    leaseMs: 50,
    canRun: async () => true,
    execute: async (_job, _settings, control) => {
      concurrentResult = await scheduler.run({accountId: 'acc-1', manual: true});
      clock.t += 100;
      await assert.rejects(
        () => control.checkpoint({stage: 'following'}),
        /checkpoint/
      );
      releaseJob();
      return {state: 'followed', followResult: {succeeded: true}};
    }
  });

  const mainRun = await scheduler.run({accountId: 'acc-1'});
  await gate;
  assert.equal(concurrentResult.ok, false);
  assert.equal(concurrentResult.reason, 'busy');
  assert.equal(mainRun.counters.followed, 0);
  assert.equal(mainRun.counters.failed, 1);
});

test('AbortController deadline aborts hung execution without infinite wait and settles pre-action timeout as retry', async () => {
  const {store, clock} = setupEnv();
  await store.saveSettings('acc-1', {enabled: true, timeBudgetMinutes: 1});

  const hungJob = await store.enqueue({
    accountId: 'acc-1',
    targetUserId: '801',
    handle: 'hung',
    sources: [{module: 'fans', url: 'https://x.com/hung', enabled: true}]
  });

  let signalAborted = false;
  const scheduler = createFollowQueueScheduler({
    store,
    now: () => clock.t,
    leaseMs: 25,
    canRun: async () => true,
    execute: async (_job, _settings, control) => {
      clock.t = control.deadline - 20;
      await new Promise(resolve => {
        control.signal.addEventListener('abort', () => {
          signalAborted = true;
          resolve();
        }, {once: true});
      });
      assert.equal(await control.canAct(), false);
      return new Promise(() => {});
    }
  });

  const origGetSettings = store.getSettings.bind(store);
  store.getSettings = async accountId => {
    const s = await origGetSettings(accountId);
    return {...s, timeBudgetMinutes: 1 / 2000};
  };

  const res = await scheduler.run({accountId: 'acc-1'});
  assert.equal(signalAborted, true);
  assert.equal(res.ok, true);
  assert.equal(res.counters.inspected, 1);
  assert.equal(res.counters.retried, 1);
  assert.equal(res.counters.failed, 0, 'cycle budget is not a profile failure');

  const [settled] = await store.list({accountId: 'acc-1'});
  assert.equal(settled.id, hungJob.id);
  assert.equal(settled.state, 'retry');
  assert.equal(settled.followResult?.retryCount || 0, 0, 'budget rollover must not consume retry allowance');
});
