/**
 * Cloudflare Provisioning Adapter for XFollower
 *
 * Implements bounded Cloudflare resource orchestration for Grok Bot relay:
 * - API Token Template URL generation
 * - Token & Account inspection
 * - D1 Database provisioning & schema initialization (with crash-recovery & ownership safety)
 * - Worker script deployment & subdomain configuration
 * - Webhook configuration
 *
 * Adheres strictly to:
 * - Browser-compatible ESM (fetch, FormData, Blob)
 * - Sanitized errors (only HTTP status and error codes; never leaks tokens or secrets)
 * - Strict resource naming and ownership validation
 */

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
export const DEFAULT_TIMEOUT_MS = 20000;

export const ACCOUNT_ID_REGEX = /^[0-9a-fA-F]{32}$/;
export const RESOURCE_NAME_REGEX = /^xfollower-grok-[a-z0-9]{8,16}$/;
export const WEBHOOK_URL_REGEX = /^https:\/\/grok\.com\/webhook\/automation\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const WEBHOOK_SECRET_REGEX = /^whsec_[A-Za-z0-9+/=_-]{16,}$/;
export const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Extracts and sanitizes error codes to numeric codes only.
 * Guaranteed never to interpolate arbitrary strings or objects, capped in length.
 */
function extractNumericCodes(errors, max = 10) {
  if (!Array.isArray(errors)) return [];
  const codes = [];
  for (const err of errors) {
    if (typeof err?.code === 'number' && Number.isSafeInteger(err.code)) {
      codes.push(err.code);
    } else if (typeof err?.code === 'string' && /^\d+$/.test(err.code.trim())) {
      codes.push(Number.parseInt(err.code.trim(), 10));
    }
    if (codes.length >= max) break;
  }
  return codes;
}

/**
 * Sanitized error that exposes only high-level steps, HTTP statuses, and API codes.
 * Guaranteed never to echo auth tokens, webhook secrets, or raw request/response bodies.
 */
export class CloudflareProvisionError extends Error {
  constructor(message, { code = 'PROVISION_ERROR', status = null, step = null } = {}) {
    super(message);
    this.name = 'CloudflareProvisionError';
    this.code = code;
    if (status !== null) this.status = status;
    if (step !== null) this.step = step;
  }
}

/**
 * Generates official user-token template URL.
 * Encodes permissions: workers_scripts edit, d1 edit, account_settings read.
 * Scoped to selected account or *.
 */
export function cloudflareTokenTemplate({ accountId = '', name = 'XFollower 接入部署' } = {}) {
  const permissions = [
    { key: 'workers_scripts', type: 'edit' },
    { key: 'd1', type: 'edit' },
    { key: 'account_settings', type: 'read' }
  ];
  const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
  url.searchParams.set('permissionGroupKeys', JSON.stringify(permissions));
  url.searchParams.set('accountId', accountId && accountId.trim() ? accountId.trim() : '*');
  url.searchParams.set('name', name);
  return url.toString();
}

/**
 * Validates origin string against expected resourceName and workers.dev format.
 * Validates that workers.dev subdomain is strictly one DNS label.
 */
export function isValidWorkersDevOrigin(origin, resourceName) {
  if (!origin || typeof origin !== 'string') return false;
  try {
    const url = new URL(origin.trim());
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password || url.search || url.hash || url.port) return false;
    if (url.pathname !== '/' && url.pathname !== '') return false;
    if (origin.trim().endsWith('/') && origin.trim() !== `https://${url.hostname}/`) return false;
    const hostname = url.hostname.toLowerCase();
    const parts = hostname.split('.');
    if (parts.length !== 4) return false;
    if (parts[0] !== resourceName.toLowerCase()) return false;
    if (!DNS_LABEL_REGEX.test(parts[1])) return false;
    if (parts[2] !== 'workers' || parts[3] !== 'dev') return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Executes a sanitized request against Cloudflare Client v4 API.
 */
async function cfRequest(fetchImpl, path, { method = 'GET', body, headers = {}, allow404 = false } = {}, { token, step = 'request' } = {}) {
  const url = path.startsWith('https://') ? path : `${CF_API_BASE}${path}`;
  const reqHeaders = { ...headers };
  if (token) {
    reqHeaders['Authorization'] = `Bearer ${token.trim()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res;
  let json = null;
  let is404Absent = false;

  try {
    res = await fetchImpl(url, {
      method,
      headers: reqHeaders,
      body,
      redirect: 'error',
      signal: controller.signal
    });

    if (allow404 && res.status === 404) {
      try {
        await res.text();
      } catch (_) {}
      is404Absent = true;
    } else {
      const contentType = res.headers?.get ? res.headers.get('content-type') : '';
      if (contentType && contentType.includes('application/json')) {
        try {
          json = await res.json();
        } catch (err) {
          if (err?.name === 'AbortError' || controller.signal.aborted) {
            throw err;
          }
          json = null;
        }
      } else {
        try {
          const text = await res.text();
          json = JSON.parse(text);
        } catch (err) {
          if (err?.name === 'AbortError' || controller.signal.aborted) {
            throw err;
          }
          json = null;
        }
      }
    }
  } catch (err) {
    const isTimeout = err?.name === 'AbortError' || controller.signal.aborted;
    throw new CloudflareProvisionError(
      `Network request failed at step '${step}': ${isTimeout ? 'timeout' : 'network_error'}`,
      {
        code: isTimeout ? 'TIMEOUT_ERROR' : 'NETWORK_ERROR',
        step
      }
    );
  } finally {
    clearTimeout(timer);
  }

  if (is404Absent) {
    return { absent: true, status: 404 };
  }

  if (!res.ok || !json || typeof json !== 'object' || json.success !== true) {
    if (res.ok) {
      const numericCodes = extractNumericCodes(json?.errors);
      const codeSuffix = numericCodes.length > 0 ? `, codes: ${numericCodes.join(',')}` : '';
      const mainCode = numericCodes.length > 0 ? `CF_${numericCodes[0]}` : 'INVALID_RESPONSE';
      throw new CloudflareProvisionError(
        `Cloudflare API returned invalid response envelope at step '${step}': HTTP ${res.status}${codeSuffix}`,
        {
          code: mainCode,
          status: res.status,
          step
        }
      );
    }

    const numericCodes = extractNumericCodes(json?.errors);
    const codeSuffix = numericCodes.length > 0 ? `, codes: ${numericCodes.join(',')}` : '';
    const mainCode = numericCodes.length > 0 ? `CF_${numericCodes[0]}` : `HTTP_${res.status}`;
    throw new CloudflareProvisionError(
      `Cloudflare API failed at step '${step}': HTTP ${res.status}${codeSuffix}`,
      {
        code: mainCode,
        status: res.status,
        step
      }
    );
  }

  return json;
}

/**
 * Creates a bounded Cloudflare provisioner instance.
 */
export function createCloudflareProvisioner({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a callable function');
  }

  /**
   * Verifies token and lists accounts.
   */
  async function inspect(token, accountHint = '') {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      throw new CloudflareProvisionError('Token is required and cannot be empty', {
        code: 'INVALID_TOKEN',
        step: 'inspect'
      });
    }

    const verifyData = await cfRequest(fetchImpl, '/user/tokens/verify', { method: 'GET' }, { token, step: 'verify_token' });
    if (verifyData.result?.status !== 'active') {
      throw new CloudflareProvisionError('API token is inactive or invalid', {
        code: 'TOKEN_INACTIVE',
        step: 'verify_token'
      });
    }

    const accountsData = await cfRequest(fetchImpl, '/accounts?per_page=50', { method: 'GET' }, { token, step: 'list_accounts' });
    const rawAccounts = Array.isArray(accountsData.result) ? accountsData.result : [];
    const accounts = rawAccounts.map(a => ({ id: a.id, name: a.name }));

    let accountId = '';
    const trimmedHint = typeof accountHint === 'string' ? accountHint.trim() : '';

    if (trimmedHint) {
      const matched = accounts.find(a => a.id === trimmedHint || a.name === trimmedHint);
      if (!matched) {
        throw new CloudflareProvisionError('Account hint does not match any accessible account', {
          code: 'ACCOUNT_MISMATCH',
          step: 'inspect'
        });
      }
      accountId = matched.id;
    } else {
      if (accounts.length === 1) {
        accountId = accounts[0].id;
      } else {
        accountId = '';
      }
    }

    return { accounts, accountId };
  }

  /**
   * Prepares D1 database, initial Worker upload without Webhook configuration, and subdomain.
   */
  async function prepareResources({
    token,
    accountId,
    resourceName,
    setupId,
    checkpoint = {},
    workerSource,
    schema,
    clientToken,
    onCheckpoint = async () => {}
  } = {}) {
    // 1. Strict validation
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      throw new CloudflareProvisionError('Token is required and cannot be empty', {
        code: 'INVALID_TOKEN',
        step: 'prepare'
      });
    }
    if (!accountId || typeof accountId !== 'string' || !ACCOUNT_ID_REGEX.test(accountId.trim())) {
      throw new CloudflareProvisionError('Account ID must be a 32-character hexadecimal string', {
        code: 'INVALID_ACCOUNT_ID',
        step: 'prepare'
      });
    }
    if (!resourceName || typeof resourceName !== 'string' || !RESOURCE_NAME_REGEX.test(resourceName.trim())) {
      throw new CloudflareProvisionError('Resource name must match pattern ^xfollower-grok-[a-z0-9]{8,16}$', {
        code: 'INVALID_RESOURCE_NAME',
        step: 'prepare'
      });
    }
    if (!setupId || typeof setupId !== 'string' || setupId.trim().length === 0) {
      throw new CloudflareProvisionError('setupId is required and cannot be empty', {
        code: 'INVALID_SETUP_ID',
        step: 'prepare'
      });
    }
    if (!workerSource || typeof workerSource !== 'string' || workerSource.trim().length === 0) {
      throw new CloudflareProvisionError('workerSource is required and cannot be empty', {
        code: 'INVALID_WORKER_SOURCE',
        step: 'prepare'
      });
    }
    if (!schema || typeof schema !== 'string' || schema.trim().length === 0) {
      throw new CloudflareProvisionError('schema SQL is required and cannot be empty', {
        code: 'INVALID_SCHEMA',
        step: 'prepare'
      });
    }
    if (!clientToken || typeof clientToken !== 'string' || clientToken.trim().length === 0) {
      throw new CloudflareProvisionError('clientToken is required and cannot be empty', {
        code: 'INVALID_CLIENT_TOKEN',
        step: 'prepare'
      });
    }

    const normAccountId = accountId.trim();
    const normResourceName = resourceName.trim();
    const normSetupId = setupId.trim();

    // 2. Read account workers/subdomain first
    let subdomainData;
    try {
      subdomainData = await cfRequest(
        fetchImpl,
        `/accounts/${encodeURIComponent(normAccountId)}/workers/subdomain`,
        { method: 'GET', allow404: true },
        { token, step: 'check_subdomain' }
      );
    } catch (err) {
      if (err.status === 404 || err.code === 'CF_10007' || err.code === 'HTTP_404') {
        throw new CloudflareProvisionError('Workers onboarding required: subdomain not set', {
          code: 'WORKERS_ONBOARDING_REQUIRED',
          status: 404,
          step: 'check_subdomain'
        });
      }
      throw err;
    }

    if (subdomainData.absent || !subdomainData.result?.subdomain) {
      throw new CloudflareProvisionError('Workers onboarding required: subdomain not set', {
        code: 'WORKERS_ONBOARDING_REQUIRED',
        status: 404,
        step: 'check_subdomain'
      });
    }

    const rawSubdomain = subdomainData.result.subdomain;
    if (typeof rawSubdomain !== 'string' || !rawSubdomain.trim()) {
      throw new CloudflareProvisionError('Workers onboarding required: subdomain not set', {
        code: 'WORKERS_ONBOARDING_REQUIRED',
        status: 404,
        step: 'check_subdomain'
      });
    }

    const accountSubdomain = rawSubdomain.trim().toLowerCase();
    if (!DNS_LABEL_REGEX.test(accountSubdomain)) {
      throw new CloudflareProvisionError('Account workers.dev subdomain must be a single DNS label', {
        code: 'INVALID_SUBDOMAIN',
        step: 'check_subdomain'
      });
    }

    const origin = `https://${normResourceName}.${accountSubdomain}.workers.dev`;

    // 3. D1 Database Provisioning or Recovery
    let databaseId = checkpoint.databaseId || null;
    const hasPriorCreationIntent = checkpoint.d1Intent === normResourceName;
    const hasPreflightAbsent = checkpoint.preflightAbsent === true;

    if (databaseId) {
      // Validate existing id matches API GET details
      const dbDetails = await cfRequest(
        fetchImpl,
        `/accounts/${encodeURIComponent(normAccountId)}/d1/database/${encodeURIComponent(databaseId)}`,
        { method: 'GET' },
        { token, step: 'get_d1_details' }
      );
      if (!dbDetails.result || dbDetails.result.name !== normResourceName) {
        throw new CloudflareProvisionError('Existing database name does not match requested resource name', {
          code: 'DATABASE_MISMATCH',
          step: 'get_d1_details'
        });
      }
    } else if (hasPriorCreationIntent) {
      // Recovery may adopt by exact name only when checkpoint proves preflight absence; otherwise refuse.
      if (!hasPreflightAbsent) {
        throw new CloudflareProvisionError('Cannot adopt database without verified preflight absence checkpoint', {
          code: 'DATABASE_ADOPTION_REFUSED',
          step: 'list_d1_recovery'
        });
      }

      // Recover from crash after intent was recorded
      const listData = await cfRequest(
        fetchImpl,
        `/accounts/${encodeURIComponent(normAccountId)}/d1/database?name=${encodeURIComponent(normResourceName)}`,
        { method: 'GET' },
        { token, step: 'list_d1_recovery' }
      );
      const items = Array.isArray(listData.result) ? listData.result : [];
      const found = items.find(db => db.name === normResourceName);
      if (found) {
        const foundId = found.uuid || found.id;
        const dbDetails = await cfRequest(
          fetchImpl,
          `/accounts/${encodeURIComponent(normAccountId)}/d1/database/${encodeURIComponent(foundId)}`,
          { method: 'GET' },
          { token, step: 'get_d1_details' }
        );
        if (dbDetails.result?.name === normResourceName) {
          databaseId = foundId;
          await onCheckpoint({
            ...checkpoint,
            step: 'd1_recovered',
            d1Intent: normResourceName,
            preflightAbsent: true,
            databaseId
          });
        }
      }
    }

    if (!databaseId) {
      if (!hasPriorCreationIntent) {
        // A first D1 create attempt must list exact-name DBs BEFORE saving creation intent.
        // Refuse preexisting same-name DB without saving any adoptable intent.
        const preflightData = await cfRequest(
          fetchImpl,
          `/accounts/${encodeURIComponent(normAccountId)}/d1/database?name=${encodeURIComponent(normResourceName)}`,
          { method: 'GET' },
          { token, step: 'preflight_d1_check' }
        );
        const existingItems = Array.isArray(preflightData.result) ? preflightData.result : [];
        const existingDb = existingItems.find(db => db.name === normResourceName);
        if (existingDb) {
          throw new CloudflareProvisionError('Database with same name already exists in account', {
            code: 'DATABASE_ALREADY_EXISTS',
            status: 409,
            step: 'preflight_d1_check'
          });
        }
      }

      // Persist preflightAbsent=true with d1Intent before POST
      await onCheckpoint({
        ...checkpoint,
        step: 'd1_creating',
        d1Intent: normResourceName,
        preflightAbsent: true
      });

      // On uncertain POST failure, retain intent for recovery but do not mislabel all failures as DATABASE_ALREADY_EXISTS; preserve original sanitized error.
      const createRes = await cfRequest(
        fetchImpl,
        `/accounts/${encodeURIComponent(normAccountId)}/d1/database`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: normResourceName })
        },
        { token, step: 'create_d1' }
      );

      databaseId = createRes.result?.uuid || createRes.result?.id;
      if (!databaseId) {
        throw new CloudflareProvisionError('Failed to obtain database ID from Cloudflare D1 response', {
          code: 'DATABASE_CREATE_FAILED',
          step: 'create_d1'
        });
      }

      await onCheckpoint({
        ...checkpoint,
        step: 'd1_created',
        d1Intent: normResourceName,
        preflightAbsent: true,
        databaseId
      });
    }

    // 4. Initialize schema via SQL query
    if (!checkpoint.schemaApplied) {
      const queryRes = await cfRequest(
        fetchImpl,
        `/accounts/${encodeURIComponent(normAccountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: schema })
        },
        { token, step: 'query_schema' }
      );

      // Handle Cloudflare success envelopes and per-statement D1 success
      if (!queryRes || !queryRes.result) {
        throw new CloudflareProvisionError('D1 schema query returned missing results', {
          code: 'D1_QUERY_STATEMENT_FAILED',
          step: 'query_schema'
        });
      }

      const statements = Array.isArray(queryRes.result) ? queryRes.result : [queryRes.result];
      if (statements.length === 0) {
        throw new CloudflareProvisionError('D1 schema query returned empty statement results', {
          code: 'D1_QUERY_STATEMENT_FAILED',
          step: 'query_schema'
        });
      }

      for (const stmt of statements) {
        if (!stmt || typeof stmt !== 'object' || stmt.success !== true) {
          throw new CloudflareProvisionError('D1 schema statement execution failed or missing success', {
            code: 'D1_QUERY_STATEMENT_FAILED',
            step: 'query_schema'
          });
        }
      }

      await onCheckpoint({
        ...checkpoint,
        step: 'schema_applied',
        d1Intent: normResourceName,
        preflightAbsent: true,
        databaseId,
        schemaApplied: true
      });
    }

    // 5. Worker Ownership Check
    const settingsRes = await cfRequest(
      fetchImpl,
      `/accounts/${encodeURIComponent(normAccountId)}/workers/scripts/${encodeURIComponent(normResourceName)}/settings`,
      { method: 'GET', allow404: true },
      { token, step: 'check_worker_settings' }
    );

    if (!settingsRes.absent) {
      const bindings = settingsRes.result?.bindings || [];
      const setupBinding = bindings.find(b => b.name === 'XFOLLOWER_SETUP_ID');
      if (!setupBinding || setupBinding.text !== normSetupId) {
        throw new CloudflareProvisionError('Worker script already exists and is not owned by this setup ID', {
          code: 'WORKER_OWNERSHIP_CONFLICT',
          step: 'check_worker_settings'
        });
      }
    }

    // 6. Upload Worker module (without WEBHOOK variables initially, so health intentionally not ready)
    const metadata = {
      main_module: 'worker.js',
      compatibility_date: '2026-10-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: [
        {
          type: 'd1',
          name: 'DB',
          id: databaseId
        },
        {
          type: 'secret_text',
          name: 'CLIENT_TOKEN',
          text: clientToken
        },
        {
          type: 'plain_text',
          name: 'PUBLIC_BASE_URL',
          text: origin
        },
        {
          type: 'plain_text',
          name: 'BOT_NAME',
          text: 'XFollower 文本生成'
        },
        {
          type: 'plain_text',
          name: 'XFOLLOWER_SETUP_ID',
          text: normSetupId
        }
      ]
    };

    const formData = new FormData();
    formData.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
      'metadata.json'
    );
    formData.append(
      'worker.js',
      new Blob([workerSource], { type: 'application/javascript+module' }),
      'worker.js'
    );

    await cfRequest(
      fetchImpl,
      `/accounts/${encodeURIComponent(normAccountId)}/workers/scripts/${encodeURIComponent(normResourceName)}`,
      {
        method: 'PUT',
        body: formData
      },
      { token, step: 'upload_worker_initial' }
    );

    await onCheckpoint({
      ...checkpoint,
      step: 'worker_uploaded',
      d1Intent: normResourceName,
      preflightAbsent: true,
      databaseId,
      schemaApplied: true,
      workerUploaded: true
    });

    // 7. Enable worker subdomain via POST /scripts/name/subdomain {enabled:true,previews_enabled:false}
    await cfRequest(
      fetchImpl,
      `/accounts/${encodeURIComponent(normAccountId)}/workers/scripts/${encodeURIComponent(normResourceName)}/subdomain`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, previews_enabled: false })
      },
      { token, step: 'enable_worker_subdomain' }
    );

    const result = {
      setupId: normSetupId,
      accountId: normAccountId,
      workerName: normResourceName,
      databaseId,
      origin
    };

    await onCheckpoint({
      ...checkpoint,
      step: 'prepared',
      d1Intent: normResourceName,
      preflightAbsent: true,
      ...result
    });

    return result;
  }

  /**
   * Finalizes Worker configuration with WEBHOOK_URL and WEBHOOK_SECRET bindings.
   */
  async function configureWorker({
    token,
    accountId,
    resourceName,
    setupId,
    databaseId,
    origin,
    workerSource,
    clientToken,
    webhookUrl,
    webhookSecret
  } = {}) {
    // 1. Strict validation
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      throw new CloudflareProvisionError('Token is required and cannot be empty', {
        code: 'INVALID_TOKEN',
        step: 'configure'
      });
    }
    if (!accountId || typeof accountId !== 'string' || !ACCOUNT_ID_REGEX.test(accountId.trim())) {
      throw new CloudflareProvisionError('Account ID must be a 32-character hexadecimal string', {
        code: 'INVALID_ACCOUNT_ID',
        step: 'configure'
      });
    }
    if (!resourceName || typeof resourceName !== 'string' || !RESOURCE_NAME_REGEX.test(resourceName.trim())) {
      throw new CloudflareProvisionError('Resource name must match pattern ^xfollower-grok-[a-z0-9]{8,16}$', {
        code: 'INVALID_RESOURCE_NAME',
        step: 'configure'
      });
    }
    if (!setupId || typeof setupId !== 'string' || setupId.trim().length === 0) {
      throw new CloudflareProvisionError('setupId is required and cannot be empty', {
        code: 'INVALID_SETUP_ID',
        step: 'configure'
      });
    }
    if (!databaseId || typeof databaseId !== 'string' || databaseId.trim().length === 0) {
      throw new CloudflareProvisionError('databaseId is required and cannot be empty', {
        code: 'INVALID_DATABASE_ID',
        step: 'configure'
      });
    }
    if (!workerSource || typeof workerSource !== 'string' || workerSource.trim().length === 0) {
      throw new CloudflareProvisionError('workerSource is required and cannot be empty', {
        code: 'INVALID_WORKER_SOURCE',
        step: 'configure'
      });
    }
    if (!clientToken || typeof clientToken !== 'string' || clientToken.trim().length === 0) {
      throw new CloudflareProvisionError('clientToken is required and cannot be empty', {
        code: 'INVALID_CLIENT_TOKEN',
        step: 'configure'
      });
    }

    const normAccountId = accountId.trim();
    const normResourceName = resourceName.trim();
    const normSetupId = setupId.trim();
    const normDatabaseId = databaseId.trim();
    const normOrigin = typeof origin === 'string' ? origin.trim().replace(/\/$/, '') : '';

    if (!isValidWorkersDevOrigin(normOrigin, normResourceName)) {
      throw new CloudflareProvisionError('Origin does not match expected workers.dev format for resource', {
        code: 'INVALID_ORIGIN',
        step: 'configure'
      });
    }

    const normWebhookUrl = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
    if (!WEBHOOK_URL_REGEX.test(normWebhookUrl)) {
      throw new CloudflareProvisionError('Webhook URL must be exact HTTPS grok.com/webhook/automation/UUID endpoint', {
        code: 'INVALID_WEBHOOK_URL',
        step: 'configure'
      });
    }

    const normWebhookSecret = typeof webhookSecret === 'string' ? webhookSecret.trim() : '';
    if (!WEBHOOK_SECRET_REGEX.test(normWebhookSecret)) {
      throw new CloudflareProvisionError('Webhook secret must be whsec base64 secret', {
        code: 'INVALID_WEBHOOK_SECRET',
        step: 'configure'
      });
    }

    // 2. Recheck Worker ownership
    const settingsRes = await cfRequest(
      fetchImpl,
      `/accounts/${encodeURIComponent(normAccountId)}/workers/scripts/${encodeURIComponent(normResourceName)}/settings`,
      { method: 'GET', allow404: true },
      { token, step: 'recheck_worker_settings' }
    );

    if (settingsRes.absent) {
      throw new CloudflareProvisionError('Worker script does not exist for configuration', {
        code: 'WORKER_NOT_FOUND',
        step: 'recheck_worker_settings'
      });
    }

    const bindings = settingsRes.result?.bindings || [];
    const setupBinding = bindings.find(b => b.name === 'XFOLLOWER_SETUP_ID');
    if (!setupBinding || setupBinding.text !== normSetupId) {
      throw new CloudflareProvisionError('Worker script is not owned by this setup ID', {
        code: 'WORKER_OWNERSHIP_CONFLICT',
        step: 'recheck_worker_settings'
      });
    }

    // 3. Full upload same module plus WEBHOOK_URL and WEBHOOK_SECRET secret bindings
    const metadata = {
      main_module: 'worker.js',
      compatibility_date: '2026-10-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: [
        {
          type: 'd1',
          name: 'DB',
          id: normDatabaseId
        },
        {
          type: 'secret_text',
          name: 'CLIENT_TOKEN',
          text: clientToken
        },
        {
          type: 'plain_text',
          name: 'PUBLIC_BASE_URL',
          text: normOrigin
        },
        {
          type: 'plain_text',
          name: 'BOT_NAME',
          text: 'XFollower 文本生成'
        },
        {
          type: 'plain_text',
          name: 'XFOLLOWER_SETUP_ID',
          text: normSetupId
        },
        {
          type: 'secret_text',
          name: 'WEBHOOK_URL',
          text: normWebhookUrl
        },
        {
          type: 'secret_text',
          name: 'WEBHOOK_SECRET',
          text: normWebhookSecret
        }
      ]
    };

    const formData = new FormData();
    formData.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
      'metadata.json'
    );
    formData.append(
      'worker.js',
      new Blob([workerSource], { type: 'application/javascript+module' }),
      'worker.js'
    );

    await cfRequest(
      fetchImpl,
      `/accounts/${encodeURIComponent(normAccountId)}/workers/scripts/${encodeURIComponent(normResourceName)}`,
      {
        method: 'PUT',
        body: formData
      },
      { token, step: 'upload_worker_configured' }
    );

    return { origin: normOrigin };
  }

  return {
    inspect,
    prepareResources,
    configureWorker
  };
}
