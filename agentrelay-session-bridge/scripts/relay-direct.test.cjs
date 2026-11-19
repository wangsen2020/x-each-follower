'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { deliver } = require('./relay-direct.cjs');

const sid = '11111111-1111-4111-8111-111111111111';
function setup(t, responses) {
  const receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-direct-test-'));
  t.after(() => fs.rmSync(receiptDir, { recursive: true, force: true }));
  const calls = [];
  return { calls, receiptDir, config: {}, request: async (pathname, body) => {
    const persisted = JSON.parse(fs.readFileSync(path.join(receiptDir, fs.readdirSync(receiptDir)[0]), 'utf8'));
    assert.ok(persisted.attempts.length > 0, 'send intent must be saved before network access');
    calls.push({ pathname, body });
    const res = responses.shift();
    if (res instanceof Error) throw res;
    assert.ok(res, 'unexpected extra request');
    return res;
  } };
}
const opts = (extra = {}) => ({ mode: 'reply', provider: 'codex', sessionId: sid, text: '[DONE] 来自 Harness：中文结果与 emoji ✅', ...extra });
const idle = () => ({ httpStatus: 409, body: { error: 'no_active_turn' } });

for (const provider of ['codex', 'antigravity', 'dsh']) {
  test(provider + ' native receipt sends UTF-8 and saves evidence', async t => {
    const dep = setup(t, [{ httpStatus: 200, body: { ok: true, status: 'steered', accepted: true, turnId: sid, requestId: sid } }]);
    const result = await deliver(opts({ provider, sessionId: provider === 'dsh' ? 'session-' + sid : sid }), dep);
    assert.equal(result.status, 'steered');
    assert.equal(dep.calls.length, 1);
    assert.equal(dep.calls[0].body.strict, true);
    assert.equal(dep.calls[0].body.text, opts().text);
    const saved = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    assert.equal(saved.text, opts().text);
    assert.equal(saved.status, 'steered');
  });
}

test('idle does not implicitly authorize wake', async t => {
  const dep = setup(t, [idle()]);
  const result = await deliver(opts(), dep);
  assert.equal(result.status, 'idle');
  assert.equal(dep.calls.length, 1);
});

test('authorized idle fallback queues exactly one receipt in the same existing session', async t => {
  const dep = setup(t, [idle()]);
  const first = dep.request;
  dep.request = async (pathname, body) => {
    if (pathname === '/steer') return first(pathname, body);
    const persisted = JSON.parse(fs.readFileSync(path.join(dep.receiptDir, fs.readdirSync(dep.receiptDir)[0]), 'utf8'));
    assert.equal(persisted.wakeJobId, body.jobId);
    dep.calls.push({ pathname, body });
    return { httpStatus: 202, body: { jobId: body.jobId, status: 'queued' } };
  };
  const result = await deliver(opts({ wakeOnIdle: true }), dep);
  assert.equal(result.status, 'queued');
  assert.equal(dep.calls.length, 2);
  assert.equal(dep.calls[1].pathname, '/codex/jobs');
  assert.equal(dep.calls[1].body.sessionId, sid);
  assert.equal(dep.calls[1].body.text, opts().text);
  assert.match(result.note, /execution.*unconfirmed/);
});

for (const [name, response] of [
  ['generic conflict', { httpStatus: 409, body: { error: 'session_busy' } }],
  ['server unavailable', { httpStatus: 503, body: { error: 'owner_unavailable' } }],
  ['incomplete success', { httpStatus: 200, body: { ok: true, status: 'steered' } }],
  ['network timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' })]
]) {
  test(name + ' never triggers a queue fallback or retry', async t => {
    const dep = setup(t, [response]);
    const result = await deliver(opts({ wakeOnIdle: true }), dep);
    assert.equal(result.status, 'unknown');
    assert.equal(dep.calls.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(result.receiptPath, 'utf8')).status, 'unknown');
  });
}

test('duplicate local operation ID cannot resend', async t => {
  const dep = setup(t, [idle()]);
  const options = opts({ operationId: crypto.randomUUID() });
  await deliver(options, dep);
  await assert.rejects(deliver(options, dep), { code: 'EEXIST' });
  assert.equal(dep.calls.length, 1);
});

test('dry-run has no filesystem or network effects', async t => {
  const dep = setup(t, []);
  const result = await deliver(opts({ dryRun: true, wakeOnIdle: true }), dep);
  assert.equal(result.sent, false);
  assert.equal(dep.calls.length, 0);
  assert.deepEqual(fs.readdirSync(dep.receiptDir), []);
});

test('steer mode cannot enable wake fallback', async t => {
  const dep = setup(t, []);
  await assert.rejects(deliver(opts({ mode: 'steer', wakeOnIdle: true }), dep), /only allowed for reply/);
  assert.equal(dep.calls.length, 0);
});

test('queue timeout preserves the job ID and never posts again', async t => {
  const dep = setup(t, [idle(), Object.assign(new Error('timeout'), { name: 'TimeoutError' })]);
  const result = await deliver(opts({ wakeOnIdle: true }), dep);
  assert.equal(result.status, 'unknown');
  assert.equal(dep.calls.length, 2);
  assert.ok(result.wakeJobId);
  const saved = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
  assert.equal(saved.wakeJobId, dep.calls[1].body.jobId);
});

test('successful active delivery never queues even with wake permission', async t => {
  const dep = setup(t, [{ httpStatus: 200, body: { ok: true, status: 'steered', turnId: sid } }]);
  const result = await deliver(opts({ wakeOnIdle: true }), dep);
  assert.equal(result.status, 'steered');
  assert.equal(dep.calls.length, 1);
});
