import assert from 'node:assert/strict';
import http from 'node:http';
import { AgentRelayClient } from './client.mjs';
let sends = 0;
const jobs = new Map();
const server = http.createServer(async (req, res) => {
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== 'Bearer fixture-token') return reply(401, { error: 'unauthorized' });
  if (req.url === '/health') return reply(200, { service: 'agent-relay', version: '1.3.0' });
  if (req.url === '/codex/sessions') return reply(200, { sessions: [{ id: 'one', name: 'Test' }, { id: 'one', name: 'Test' }] });
  if (req.method === 'POST' && req.url === '/codex/jobs') {
    let text = ''; for await (const b of req) text += b;
    const body = JSON.parse(text);
    if (jobs.has(body.jobId)) return reply(200, jobs.get(body.jobId));
    sends++; const job = { jobId: body.jobId, status: 'completed', result: { text: 'AGENTRELAY_OK' } }; jobs.set(body.jobId, job); return reply(202, job);
  }
  if (req.url.startsWith('/codex/jobs/')) return reply(200, jobs.get(req.url.split('/').at(-1)) || { status: 'unknown' });
  reply(404, { error: 'not_found' });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const c = new AgentRelayClient({ baseUrl, token: 'fixture-token' });
  assert.equal((await c.health()).version, '1.3.0');
  assert.equal((await c.sessions()).length, 1);
  const job = c.makeJob('one', 'test'); await c.submit(job); await c.submit(job);
  assert.equal((await c.wait(job.jobId)).result.text, 'AGENTRELAY_OK'); assert.equal(sends, 1);
  assert.equal((await c.wait('uncertain')).status, 'unknown'); assert.equal(sends, 1);
  await assert.rejects(new AgentRelayClient({ baseUrl, token: 'wrong' }).health(), e => e.status === 401);
  assert.throws(() => new AgentRelayClient({ baseUrl, token: 'x', provider: 'codex-acp' }), /experimental/);
  console.log('PASS: auth, listing/deduplication, one submission per job, polling, unknown/no resend, experimental opt-in. Mock HTTP only.');
} finally { await new Promise(r => server.close(r)); }
