#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PROVIDERS = ['antigravity', 'codex', 'dsh', 'grok-cli', 'grokbot', 'workbuddy'];
const RECEIPT_DIR = path.join(os.tmpdir(), 'agentrelay-bridge-receipts');

function loadRelayConfig() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const configPath = path.join(appData, 'AgentRelay', 'config.json');
  let fileCfg = {};
  if (fs.existsSync(configPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // ignore parse errors
    }
  }
  const host = fileCfg.host || '127.0.0.1';
  const port = Number(fileCfg.port) || 8787;
  const baseUrl = (process.env.AGENTRELAY_URL || `http://${host}:${port}`).replace(/\/+$/, '');
  const token = String(process.env.AGENTRELAY_TOKEN || fileCfg.token || '').trim();
  if (!token) {
    throw new Error(`未找到 AgentRelay Token（已检查 ${configPath} 与环境变量 AGENTRELAY_TOKEN）`);
  }
  return { baseUrl, token, configPath };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function relayFetch(cfg, pathname, options = {}) {
  const res = await fetch(`${cfg.baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function listProviderSessions(cfg, provider) {
  const data = await relayFetch(cfg, `/${provider}/sessions`);
  const list = Array.isArray(data.sessions) ? data.sessions : Array.isArray(data.bots) ? data.bots : [];
  return list.map(s => ({
    provider,
    id: s.id,
    name: s.name || s.title || '',
    updatedAt: s.updatedAt || null
  }));
}

async function resolveProviderForSession(cfg, sessionId, preferredProvider = 'auto') {
  if (preferredProvider && preferredProvider !== 'auto') {
    return { provider: preferredProvider, session: { id: sessionId } };
  }
  for (const provider of PROVIDERS) {
    try {
      const sessions = await listProviderSessions(cfg, provider);
      const found = sessions.find(s => s.id === sessionId);
      if (found) return { provider, session: found };
    } catch {
      // try next provider
    }
  }
  throw new Error(`在 antigravity / codex / dsh / grokbot 中均未找到会话 ID: ${sessionId}`);
}

function saveReceipt(receipt) {
  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  const file = path.join(RECEIPT_DIR, `${receipt.jobId}.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2), 'utf8');
  return file;
}

function loadReceipt(jobId) {
  const file = path.join(RECEIPT_DIR, `${jobId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function pollJob(cfg, provider, jobId, timeoutMs = 300000, pollMs = 3000) {
  const started = Date.now();
  while (true) {
    const data = await relayFetch(cfg, `/${provider}/jobs/${encodeURIComponent(jobId)}`);
    const status = data.status;
    if (status === 'completed') {
      const text = typeof data.result === 'string' ? data.result : data.result?.text || '';
      return { ok: true, jobId, provider, status, text, raw: data };
    }
    if (status === 'failed' || status === 'cancelled') {
      return {
        ok: false,
        jobId,
        provider,
        status,
        error: data.error || 'JOB_FAILED',
        message: data.message || '目标会话执行失败',
        raw: data
      };
    }
    if (Date.now() - started >= timeoutMs) {
      return {
        ok: false,
        jobId,
        provider,
        status: status || 'running',
        timeout: true,
        message: `等待超过 ${timeoutMs}ms，任务仍在运行，稍后可执行 status --job ${jobId} --wait 继续查询`
      };
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  const cfg = loadRelayConfig();

  if (cmd === 'sessions') {
    const targetProviders = args.provider && args.provider !== 'all' ? [args.provider] : PROVIDERS;
    const keyword = String(args.search || '').toLowerCase();
    const all = [];
    for (const p of targetProviders) {
      try {
        const list = await listProviderSessions(cfg, p);
        for (const item of list) {
          if (!keyword || item.id.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword)) {
            all.push(item);
          }
        }
      } catch (e) {
        all.push({ provider: p, error: e.message });
      }
    }
    console.log(JSON.stringify({ baseUrl: cfg.baseUrl, count: all.length, sessions: all }, null, 2));
    return;
  }

  if (cmd === 'send') {
    const sessionId = String(args.session || '').trim();
    if (!sessionId) throw new Error('请通过 --session <会话ID> 指定目标会话');
    let text = '';
    if (args.file) {
      text = fs.readFileSync(path.resolve(String(args.file)), 'utf8');
    } else if (args.text) {
      text = String(args.text);
    } else {
      throw new Error('请通过 --text "<内容>" 或 --file <文件路径> 提供要发送的消息');
    }
    if (args.from) {
      text = `【来自会话 ${args.from} 的跨项目协同消息】\n\n${text}`;
    }

    const { provider, session } = await resolveProviderForSession(cfg, sessionId, args.provider || 'auto');
    const jobId = String(args.job || crypto.randomUUID());
    const timeoutMs = Number(args.timeout) || 300000;
    const receiptPath = saveReceipt({
      jobId,
      provider,
      sessionId,
      sessionName: session.name || '',
      from: args.from || '',
      createdAt: new Date().toISOString()
    });

    const body = provider === 'grokbot'
      ? { jobId, bot: sessionId, text, timeoutMs }
      : { jobId, sessionId, text, timeoutMs };

    const postRes = await relayFetch(cfg, `/${provider}/jobs`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    if (args['no-wait']) {
      console.log(JSON.stringify({
        ok: true,
        submitted: true,
        jobId,
        provider,
        sessionId,
        sessionName: session.name || '',
        status: postRes.status || 'queued',
        receiptPath
      }, null, 2));
      return;
    }

    const finalRes = await pollJob(cfg, provider, jobId, timeoutMs);
    console.log(JSON.stringify({
      ...finalRes,
      sessionId,
      sessionName: session.name || '',
      receiptPath
    }, null, 2));
    if (!finalRes.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'status') {
    const jobId = String(args.job || '').trim();
    if (!jobId) throw new Error('请通过 --job <jobId> 指定要查询的任务 ID');
    const receipt = loadReceipt(jobId);
    const provider = args.provider || receipt?.provider || 'antigravity';
    if (args.wait) {
      const timeoutMs = Number(args.timeout) || 300000;
      const finalRes = await pollJob(cfg, provider, jobId, timeoutMs);
      console.log(JSON.stringify(finalRes, null, 2));
      if (!finalRes.ok) process.exitCode = 1;
      return;
    }
    const data = await relayFetch(cfg, `/${provider}/jobs/${encodeURIComponent(jobId)}`);
    console.log(JSON.stringify({
      jobId,
      provider,
      status: data.status,
      text: typeof data.result === 'string' ? data.result : data.result?.text || '',
      raw: data
    }, null, 2));
    return;
  }

  console.log(`Usage:
  node scripts/relay-bridge.mjs sessions [--provider all|antigravity|codex|dsh|grokbot] [--search <keyword_or_id>]
  node scripts/relay-bridge.mjs send --session <sessionId> [--from <myConversationId>] [--provider auto|antigravity|codex|dsh|grokbot] (--text "<message>" | --file <path>) [--no-wait] [--timeout 300000]
  node scripts/relay-bridge.mjs status --job <jobId> [--provider antigravity|codex|dsh|grokbot] [--wait]`);
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err.message, status: err.status || null }, null, 2));
  process.exit(1);
});
