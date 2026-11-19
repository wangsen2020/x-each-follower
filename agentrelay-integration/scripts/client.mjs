export class RelayError extends Error {
  constructor(message, status = 0, code = 'network_error') { super(message); this.status = status; this.code = code; }
}
const stable = ['grokbot', 'codex', 'antigravity'];
export class AgentRelayClient {
  constructor({ baseUrl = 'http://127.0.0.1:8787', token, provider = 'codex', experimental = false, requestTimeoutMs = 10000 }) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use a plain AgentRelay base URL without credentials or path');
    if (!token || typeof token !== 'string') throw new Error('AgentRelay token is required');
    if (!stable.includes(provider) && !(experimental && ['codex-acp', 'antigravity-acp'].includes(provider))) throw new Error('Unknown provider or experimental provider not enabled');
    this.baseUrl = url.origin; this.token = token; this.provider = provider; this.requestTimeoutMs = requestTimeoutMs;
  }
  async request(method, route, body) {
    let response;
    try {
      response = await fetch(this.baseUrl + route, { method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(this.requestTimeoutMs), headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new RelayError('Request interrupted; query the original job ID before considering another send'); }
    let data;
    try { data = await response.json(); } catch { throw new RelayError('Non-JSON service response; verify the address', response.status, 'invalid_response'); }
    if (!response.ok) {
      const code = /^[a-zA-Z0-9_-]{1,80}$/.test(data.error || '') ? data.error : 'http_error';
      throw new RelayError(`AgentRelay HTTP ${response.status}: ${code}`, response.status, code);
    }
    return data;
  }
  health() { return this.request('GET', '/health'); }
  engineHealth() { return this.request('GET', `/${this.provider}/health`); }
  async sessions() {
    const result = await this.request('GET', `/${this.provider}/sessions`);
    if (!Array.isArray(result.sessions)) throw new RelayError('Invalid sessions response', 0, 'invalid_response');
    return [...new Map(result.sessions.filter(s => typeof s.id === 'string').map(s => [s.id, s])).values()];
  }
  createSession(name) {
    if (this.provider === 'grokbot') throw new Error('Grok Bot has no create API; choose an existing bot');
    return this.request('POST', `/${this.provider}/sessions`, { name });
  }
  makeJob(sessionId, text, { timeoutMs = 120000, jobId = crypto.randomUUID() } = {}) { return { jobId, sessionId, text, timeoutMs }; }
  submit(job) { return this.request('POST', `/${this.provider}/jobs`, job); }
  job(jobId) { return this.request('GET', `/${this.provider}/jobs/${encodeURIComponent(jobId)}`); }
  async wait(jobId, { waitMs = 180000, pollMs = 1000, onStatus = () => {} } = {}) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const result = await this.job(jobId); onStatus(result);
      if (['completed', 'failed', 'unknown'].includes(result.status)) return result;
      if (!['queued', 'running'].includes(result.status)) throw new RelayError('Unknown job status; preserve the original ID', 0, 'invalid_response');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new RelayError('Stopped waiting; the server task may still be running. Resume querying this job ID.', 0, 'wait_timeout');
  }
}
