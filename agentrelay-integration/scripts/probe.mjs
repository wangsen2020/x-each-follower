#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AgentRelayClient } from './client.mjs';
const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: { url: { type: 'string' }, provider: { type: 'string' }, session: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, receipt: { type: 'string' }, experimental: { type: 'boolean' } } });
const output = value => console.log(JSON.stringify(value, null, 2));
let receiptPath;
try {
  const command = positionals[0];
  const client = new AgentRelayClient({ baseUrl: flags.url || process.env.AGENTRELAY_URL, token: process.env.AGENTRELAY_TOKEN, provider: flags.provider || process.env.AGENTRELAY_PROVIDER || 'codex', experimental: flags.experimental });
  if (command === 'health') output({ service: await client.health(), engine: await client.engineHealth() });
  else if (command === 'sessions') output({ sessions: await client.sessions() });
  else if (command === 'create') {
    if (!flags.name) throw new Error('create requires --name');
    output(await client.createSession(flags.name));
  } else if (command === 'send' || command === 'resume') {
    let receipt;
    if (command === 'resume') {
      if (!flags.receipt) throw new Error('resume requires --receipt');
      receiptPath = path.resolve(flags.receipt); receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (receipt.baseUrl !== client.baseUrl || receipt.provider !== client.provider) throw new Error('Receipt binding differs; specify the original --url and --provider');
    } else {
      if (!flags.session) throw new Error('send requires --session from the sessions list');
      const text = flags.file ? fs.readFileSync(flags.file, 'utf8') : flags.text || 'Reply exactly AGENTRELAY_OK. Do not use tools.';
      const job = client.makeJob(flags.session, text);
      receipt = { format: 1, baseUrl: client.baseUrl, provider: client.provider, job, state: 'prepared' };
      receiptPath = path.resolve(flags.receipt || path.join(os.tmpdir(), `agentrelay-probe-${job.jobId}.json`));
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
      output({ receipt: receiptPath, jobId: job.jobId });
      await client.submit(job); // Deliberately no POST retry.
    }
    const result = await client.wait(receipt.job.jobId);
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, state: result.status, result }, null, 2), { mode: 0o600 });
    output(result);
    if (result.status !== 'completed') process.exitCode = 2;
  } else throw new Error('Usage: probe.mjs health|sessions|create|send|resume [--provider codex|grokbot|antigravity]');
} catch (error) {
  output({ error: error.code || 'probe_failed', message: error.message, ...(receiptPath ? { receipt: receiptPath, recovery: 'Query the original job ID. Do not generate a replacement send.' } : {}) });
  process.exitCode = 1;
}
