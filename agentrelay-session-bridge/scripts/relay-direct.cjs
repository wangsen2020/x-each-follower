'use strict';
// Single-shot native receipt delivery. No retry; optional idle-only queue fallback.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PROVIDERS = new Set(['codex', 'antigravity', 'dsh']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function readConfig() {
  const file = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'AgentRelay/config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!cfg.token) throw new Error('AgentRelay token is missing');
  const host = !cfg.host || cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('This helper only connects to the local AgentRelay host');
  return { baseUrl: `http://${host === '::1' ? '[::1]' : host}:${cfg.port || 8787}`, token: cfg.token };
}

function classify(provider, response) {
  const { httpStatus, body } = response;
  if (httpStatus === 409 && body?.error === 'no_active_turn') return 'idle';
  if (httpStatus === 200 && body?.ok === true && body?.status === 'steered') {
    if (provider === 'codex' ? Boolean(body.turnId) : body.accepted === true) return 'steered';
  }
  if ([400, 401, 403, 404, 413, 429].includes(httpStatus)) return 'rejected';
  return 'unknown';
}

async function deliver(options, dependencies = {}) {
  const { mode, provider, sessionId, text } = options;
  if (!['steer', 'reply'].includes(mode)) throw new Error('mode must be steer or reply');
  if (!PROVIDERS.has(provider)) throw new Error('provider must be codex, antigravity or dsh');
  if (!sessionId || !text?.trim()) throw new Error('session and non-empty text are required');
  if (!(provider === 'dsh' ? /^(?:session-)?[0-9a-f-]{36}$/i : UUID).test(sessionId)) throw new Error('Invalid session ID');
  if (options.wakeOnIdle && mode !== 'reply') throw new Error('wake-on-idle is only allowed for reply');
  const operationId = options.operationId || crypto.randomUUID();
  if (!UUID.test(operationId)) throw new Error('operation-id must be a UUID');
  const requestBody = { provider, sessionId, text, strict: true, requestId: operationId, clientUserMessageId: operationId };
  if (options.dryRun) return { status: 'dry-run', mode, operationId, requestBody, wakeOnIdle: Boolean(options.wakeOnIdle), sent: false };

  const cfg = dependencies.config || readConfig();
  const request = dependencies.request || (async (pathname, body) => {
    const res = await fetch(cfg.baseUrl + pathname, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(25000)
    });
    const raw = await res.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { unparsedResponse: raw.slice(0, 2000) }; }
    return { httpStatus: res.status, body: parsed };
  });

  const receiptDir = dependencies.receiptDir || path.join(os.tmpdir(), 'agentrelay-direct-receipts');
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, operationId + '.json');
  const receipt = {
    operationId, mode, provider, sessionId, createdAt: new Date().toISOString(),
    messageSha256: crypto.createHash('sha256').update(text).digest('hex'),
    text, wakeOnIdle: Boolean(options.wakeOnIdle), status: 'unknown', attempts: []
  };
  // Reserve before sending. An existing receipt is evidence to inspect, never permission to replay.
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
  const post = async (pathname, body) => {
    const attempt = { pathname, requestBody: body, startedAt: new Date().toISOString(), status: 'unknown' };
    receipt.attempts.push(attempt);
    save();
    const response = await request(pathname, body);
    Object.assign(attempt, response, { finishedAt: new Date().toISOString() });
    save();
    return response;
  };
  try {
    const direct = await post('/steer', requestBody);
    receipt.status = classify(provider, direct);
    receipt.attempts.at(-1).status = receipt.status;
    if (receipt.status === 'idle' && options.wakeOnIdle) {
      receipt.wakeJobId = crypto.randomUUID();
      receipt.status = 'unknown';
      save();
      const queued = await post(`/${provider}/jobs`, { jobId: receipt.wakeJobId, sessionId, text, timeoutMs: 300000 });
      const accepted = [200, 202].includes(queued.httpStatus) && queued.body?.jobId === receipt.wakeJobId &&
        ['queued', 'running', 'completed'].includes(queued.body.status);
      receipt.status = accepted ? 'queued' : ([400, 401, 403, 404, 409, 413, 429].includes(queued.httpStatus) ? 'rejected' : 'unknown');
      receipt.attempts.at(-1).status = receipt.status;
      if (accepted) receipt.wakeJobStatus = queued.body.status;
    }
  } catch (error) {
    receipt.status = 'unknown';
    // Do not echo exception bodies, config, or headers that could disclose credentials.
    receipt.error = { name: error.name || 'Error', code: error.code || 'DELIVERY_UNKNOWN' };
  }
  receipt.finishedAt = new Date().toISOString();
  save();
  return { status: receipt.status, operationId, provider, sessionId, receiptPath,
    wakeJobId: receipt.wakeJobId, wakeJobStatus: receipt.wakeJobStatus,
    attempts: receipt.attempts.map(({ pathname, httpStatus, body }) => ({ pathname, httpStatus, body })),
    note: receipt.status === 'queued' ? 'Result notification queued; execution and goal completion remain unconfirmed.' : undefined };
}

async function main(argv) {
  const opts = { mode: argv[0] };
  const names = { '--provider': 'provider', '--session': 'sessionId', '--file': 'file', '--text': 'text', '--operation-id': 'operationId' };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (names[key]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing value for ' + key);
      opts[names[key]] = argv[++i];
    } else if (key === '--wake-on-idle') opts.wakeOnIdle = true;
    else if (key === '--dry-run') opts.dryRun = true;
    else throw new Error('Unknown argument: ' + key);
  }
  if (opts.file && opts.text !== undefined) throw new Error('Use file or text, not both');
  if (opts.file) opts.text = fs.readFileSync(opts.file, 'utf8').replace(/^\uFEFF/, '');
  const result = await deliver(opts);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = ['steered', 'queued', 'dry-run'].includes(result.status) ? 0 : result.status === 'idle' ? 3 : 2;
}

module.exports = { classify, deliver };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ status: 'local-error', message: error.code === 'EEXIST' ? 'Receipt already exists; inspect the original operation, do not resend.' : error.message }));
  process.exitCode = 2;
});
