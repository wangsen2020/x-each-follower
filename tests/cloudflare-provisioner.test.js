import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudflareTokenTemplate,
  createCloudflareProvisioner,
  CloudflareProvisionError,
  isValidWorkersDevOrigin,
  ACCOUNT_ID_REGEX,
  RESOURCE_NAME_REGEX,
  WEBHOOK_URL_REGEX,
  WEBHOOK_SECRET_REGEX,
  DNS_LABEL_REGEX
} from '../src/features/grok/cloudflare-provisioner.js';

const VALID_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const VALID_RESOURCE_NAME = 'xfollower-grok-abc12345';
const VALID_SETUP_ID = 'setup-uuid-987654';
const VALID_CLIENT_TOKEN = 'client-token-random-value-1234567890';
const VALID_DATABASE_ID = 'db-uuid-1111-2222-3333';
const VALID_ORIGIN = `https://${VALID_RESOURCE_NAME}.test-user.workers.dev`;
const VALID_WEBHOOK_URL = 'https://grok.com/webhook/automation/12345678-1234-1234-1234-123456789abc';
const VALID_WEBHOOK_SECRET = 'whsec_abcdefghijklmnopqrstuvwxyz0123456789+/=';
const DUMMY_WORKER_SOURCE = 'export default { async fetch() { return new Response("ok"); } };';
const DUMMY_SCHEMA = 'CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY);';

function mockFetcher(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options, calls);
  };
  return { fetchImpl, calls };
}

test('cloudflareTokenTemplate constructs valid official user token URL', () => {
  const defaultUrl = cloudflareTokenTemplate();
  const parsedDefault = new URL(defaultUrl);
  assert.equal(parsedDefault.origin, 'https://dash.cloudflare.com');
  assert.equal(parsedDefault.pathname, '/profile/api-tokens');
  assert.equal(parsedDefault.searchParams.get('accountId'), '*');
  assert.equal(parsedDefault.searchParams.get('name'), 'XFollower 接入部署');

  const permissions = JSON.parse(parsedDefault.searchParams.get('permissionGroupKeys'));
  assert.deepEqual(permissions, [
    { key: 'workers_scripts', type: 'edit' },
    { key: 'd1', type: 'edit' },
    { key: 'account_settings', type: 'read' }
  ]);

  const customUrl = cloudflareTokenTemplate({
    accountId: VALID_ACCOUNT_ID,
    name: 'Custom Provision'
  });
  const parsedCustom = new URL(customUrl);
  assert.equal(parsedCustom.searchParams.get('accountId'), VALID_ACCOUNT_ID);
  assert.equal(parsedCustom.searchParams.get('name'), 'Custom Provision');
});

test('regex validators enforce strict security constraints', () => {
  assert.ok(ACCOUNT_ID_REGEX.test(VALID_ACCOUNT_ID));
  assert.equal(ACCOUNT_ID_REGEX.test('invalid-account-id'), false);
  assert.equal(ACCOUNT_ID_REGEX.test(VALID_ACCOUNT_ID + 'a'), false);
  assert.equal(ACCOUNT_ID_REGEX.test(''), false);

  assert.ok(RESOURCE_NAME_REGEX.test(VALID_RESOURCE_NAME));
  assert.equal(RESOURCE_NAME_REGEX.test('xfollower-grok-short'), false);
  assert.equal(RESOURCE_NAME_REGEX.test('xfollower-grok-toolongnamemorethan16chars'), false);
  assert.equal(RESOURCE_NAME_REGEX.test('other-name-12345678'), false);

  assert.ok(WEBHOOK_URL_REGEX.test(VALID_WEBHOOK_URL));
  assert.equal(WEBHOOK_URL_REGEX.test('http://grok.com/webhook/automation/12345678-1234-1234-1234-123456789abc'), false);
  assert.equal(WEBHOOK_URL_REGEX.test('https://evil.com/webhook/automation/12345678-1234-1234-1234-123456789abc'), false);
  assert.equal(WEBHOOK_URL_REGEX.test('https://grok.com/webhook/automation/invalid-uuid'), false);
  assert.equal(WEBHOOK_URL_REGEX.test(VALID_WEBHOOK_URL + '?param=1'), false);

  assert.ok(WEBHOOK_SECRET_REGEX.test(VALID_WEBHOOK_SECRET));
  assert.equal(WEBHOOK_SECRET_REGEX.test('not_whsec_secret'), false);
  assert.equal(WEBHOOK_SECRET_REGEX.test('whsec_short'), false);

  assert.ok(isValidWorkersDevOrigin(VALID_ORIGIN, VALID_RESOURCE_NAME));
  assert.equal(isValidWorkersDevOrigin('http://' + VALID_RESOURCE_NAME + '.test.workers.dev', VALID_RESOURCE_NAME), false);
  assert.equal(isValidWorkersDevOrigin('https://wrong-name.test.workers.dev', VALID_RESOURCE_NAME), false);
  assert.equal(isValidWorkersDevOrigin(VALID_ORIGIN + '/extra/path', VALID_RESOURCE_NAME), false);
  assert.equal(isValidWorkersDevOrigin(VALID_ORIGIN + '?query=1', VALID_RESOURCE_NAME), false);
});

test('inspect verifies token and resolves single account or hint', async () => {
  const { fetchImpl, calls } = mockFetcher((url) => {
    if (url.endsWith('/user/tokens/verify')) {
      return Response.json({ success: true, result: { id: 'tok-1', status: 'active' } });
    }
    if (url.includes('/accounts')) {
      return Response.json({
        success: true,
        result: [{ id: VALID_ACCOUNT_ID, name: 'My Account' }]
      });
    }
    return Response.json({ success: false }, { status: 404 });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  const result = await provisioner.inspect('cf-token-secret-123');

  assert.equal(result.accountId, VALID_ACCOUNT_ID);
  assert.equal(result.accounts.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['Authorization'], 'Bearer cf-token-secret-123');
});

test('inspect handles multiple accounts and ambiguous accountId empty, matching hint resolves, mismatched hint throws', async () => {
  const secondId = 'fedcba9876543210fedcba9876543210';
  const { fetchImpl } = mockFetcher((url) => {
    if (url.endsWith('/user/tokens/verify')) {
      return Response.json({ success: true, result: { status: 'active' } });
    }
    if (url.includes('/accounts')) {
      return Response.json({
        success: true,
        result: [
          { id: VALID_ACCOUNT_ID, name: 'Account 1' },
          { id: secondId, name: 'Account 2' }
        ]
      });
    }
    return Response.json({ success: false }, { status: 404 });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });

  const ambiguous = await provisioner.inspect('token-123');
  assert.equal(ambiguous.accountId, '');
  assert.equal(ambiguous.accounts.length, 2);

  const hinted = await provisioner.inspect('token-123', secondId);
  assert.equal(hinted.accountId, secondId);

  await assert.rejects(
    provisioner.inspect('token-123', 'non-existent-account-id'),
    (err) => err instanceof CloudflareProvisionError && err.code === 'ACCOUNT_MISMATCH'
  );
});

test('sanitized errors never echo API tokens or secrets in messages or errors', async () => {
  const superSecretToken = 'super-secret-cf-token-999999999';
  const { fetchImpl } = mockFetcher(() => {
    return Response.json(
      {
        success: false,
        errors: [{ code: 10000, message: `Invalid bearer ${superSecretToken}` }]
      },
      { status: 401 }
    );
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  await assert.rejects(
    provisioner.inspect(superSecretToken),
    (err) => {
      assert.ok(err instanceof CloudflareProvisionError);
      assert.equal(err.status, 401);
      assert.equal(err.code, 'CF_10007' in err ? err.code : 'CF_10000');
      assert.equal(err.message.includes(superSecretToken), false);
      assert.equal(JSON.stringify(err).includes(superSecretToken), false);
      return true;
    }
  );
});

test('prepareResources throws WORKERS_ONBOARDING_REQUIRED if subdomain is missing', async () => {
  const { fetchImpl } = mockFetcher((url) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: false, errors: [{ code: 10007, message: 'Subdomain not found' }] }, { status: 404 });
    }
    return Response.json({ success: true });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  await assert.rejects(
    provisioner.prepareResources({
      token: 'valid-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN
    }),
    (err) => {
      assert.equal(err.code, 'WORKERS_ONBOARDING_REQUIRED');
      return true;
    }
  );
});

test('prepareResources executes full flow with checkpoint intent before POST D1 and multipart upload', async () => {
  const checkpoints = [];
  let preflightQueried = false;
  let d1Created = false;
  let schemaQueried = false;
  let workerUploaded = false;
  let subdomainEnabled = false;
  let uploadedMetadata = null;
  let uploadedWorkerSource = null;

  const { fetchImpl, calls } = mockFetcher(async (url, opts) => {
    if (url.endsWith('/workers/subdomain') && opts.method === 'GET') {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    if (url.includes('/d1/database') && opts.method === 'GET') {
      preflightQueried = true;
      return Response.json({ success: true, result: [] });
    }
    if (url.endsWith('/d1/database') && opts.method === 'POST') {
      d1Created = true;
      const body = JSON.parse(opts.body);
      assert.equal(body.name, VALID_RESOURCE_NAME);
      return Response.json({ success: true, result: { uuid: VALID_DATABASE_ID, name: VALID_RESOURCE_NAME } });
    }
    if (url.includes(`/d1/database/${VALID_DATABASE_ID}/query`) && opts.method === 'POST') {
      schemaQueried = true;
      const body = JSON.parse(opts.body);
      assert.equal(body.sql, DUMMY_SCHEMA);
      return Response.json({ success: true, result: [{ success: true, meta: {} }] });
    }
    if (url.endsWith(`/workers/scripts/${VALID_RESOURCE_NAME}/settings`) && opts.method === 'GET') {
      // 404 absent allows initial creation
      return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    }
    if (url.endsWith(`/workers/scripts/${VALID_RESOURCE_NAME}`) && opts.method === 'PUT') {
      workerUploaded = true;
      assert.ok(opts.body instanceof FormData);
      const metadataBlob = opts.body.get('metadata');
      const workerBlob = opts.body.get('worker.js');
      uploadedMetadata = JSON.parse(await metadataBlob.text());
      uploadedWorkerSource = await workerBlob.text();
      return Response.json({ success: true, result: {} });
    }
    if (url.endsWith(`/workers/scripts/${VALID_RESOURCE_NAME}/subdomain`) && opts.method === 'POST') {
      subdomainEnabled = true;
      const body = JSON.parse(opts.body);
      assert.deepEqual(body, { enabled: true, previews_enabled: false });
      return Response.json({ success: true, result: { enabled: true } });
    }
    return Response.json({ success: false }, { status: 404 });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  const result = await provisioner.prepareResources({
    token: 'test-token',
    accountId: VALID_ACCOUNT_ID,
    resourceName: VALID_RESOURCE_NAME,
    setupId: VALID_SETUP_ID,
    workerSource: DUMMY_WORKER_SOURCE,
    schema: DUMMY_SCHEMA,
    clientToken: VALID_CLIENT_TOKEN,
    onCheckpoint: async (cp) => {
      checkpoints.push(structuredClone(cp));
    }
  });

  assert.equal(result.workerName, VALID_RESOURCE_NAME);
  assert.equal(result.databaseId, VALID_DATABASE_ID);
  assert.equal(result.origin, `https://${VALID_RESOURCE_NAME}.my-team.workers.dev`);

  assert.ok(preflightQueried);
  assert.ok(d1Created);
  assert.ok(schemaQueried);
  assert.ok(workerUploaded);
  assert.ok(subdomainEnabled);

  // Assert creation intent recorded before POST D1 with preflightAbsent=true
  const firstCheckpoint = checkpoints[0];
  assert.equal(firstCheckpoint.step, 'd1_creating');
  assert.equal(firstCheckpoint.d1Intent, VALID_RESOURCE_NAME);
  assert.equal(firstCheckpoint.preflightAbsent, true);
  assert.equal(firstCheckpoint.databaseId, undefined);

  // Assert uploaded metadata bindings
  assert.equal(uploadedMetadata.main_module, 'worker.js');
  assert.equal(uploadedMetadata.compatibility_date, '2026-10-01');
  assert.deepEqual(uploadedMetadata.compatibility_flags, ['nodejs_compat']);
  assert.deepEqual(uploadedMetadata.bindings, [
    { type: 'd1', name: 'DB', id: VALID_DATABASE_ID },
    { type: 'secret_text', name: 'CLIENT_TOKEN', text: VALID_CLIENT_TOKEN },
    { type: 'plain_text', name: 'PUBLIC_BASE_URL', text: result.origin },
    { type: 'plain_text', name: 'BOT_NAME', text: 'XFollower 文本生成' },
    { type: 'plain_text', name: 'XFOLLOWER_SETUP_ID', text: VALID_SETUP_ID }
  ]);
  assert.equal(uploadedWorkerSource, DUMMY_WORKER_SOURCE);
});

test('prepareResources refuses to silently adopt an existing same-name DB when fresh run has no prior intent', async () => {
  const checkpoints = [];
  const { fetchImpl } = mockFetcher((url, opts) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    if (url.includes('/d1/database') && opts.method === 'GET') {
      return Response.json({ success: true, result: [{ uuid: 'old-existing-db', name: VALID_RESOURCE_NAME }] });
    }
    if (url.endsWith('/d1/database') && opts.method === 'POST') {
      return Response.json({ success: false, errors: [{ code: 7502, message: 'Database already exists' }] }, { status: 400 });
    }
    return Response.json({ success: true });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  await assert.rejects(
    provisioner.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      checkpoint: {}, // fresh start: no d1Intent
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN,
      onCheckpoint: async (cp) => checkpoints.push(cp)
    }),
    (err) => err.code === 'DATABASE_ALREADY_EXISTS'
  );
  assert.equal(checkpoints.length, 0, 'No checkpoint intent must be saved when preflight detects preexisting DB');
});

test('prepareResources recovers existing D1 without duplicate POST when checkpoint proves prior creation intent', async () => {
  let postCalled = false;
  let listQueried = false;

  const { fetchImpl } = mockFetcher((url, opts) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    if (url.includes('/d1/database') && opts.method === 'GET') {
      if (url.includes(VALID_DATABASE_ID)) {
        return Response.json({ success: true, result: { uuid: VALID_DATABASE_ID, name: VALID_RESOURCE_NAME } });
      }
      listQueried = true;
      return Response.json({
        success: true,
        result: [{ uuid: VALID_DATABASE_ID, name: VALID_RESOURCE_NAME }]
      });
    }
    if (url.endsWith('/d1/database') && opts.method === 'POST') {
      postCalled = true;
      return Response.json({ success: true });
    }
    if (url.includes('/query')) {
      return Response.json({ success: true, result: [{ success: true }] });
    }
    if (url.endsWith('/settings')) {
      return Response.json({ success: false }, { status: 404 });
    }
    if (opts.method === 'PUT' || (url.endsWith('/subdomain') && opts.method === 'POST')) {
      return Response.json({ success: true, result: {} });
    }
    return Response.json({ success: true });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  const result = await provisioner.prepareResources({
    token: 'test-token',
    accountId: VALID_ACCOUNT_ID,
    resourceName: VALID_RESOURCE_NAME,
    setupId: VALID_SETUP_ID,
    checkpoint: { d1Intent: VALID_RESOURCE_NAME, preflightAbsent: true }, // recovery checkpoint with intent and verified preflight absence
    workerSource: DUMMY_WORKER_SOURCE,
    schema: DUMMY_SCHEMA,
    clientToken: VALID_CLIENT_TOKEN
  });

  assert.ok(listQueried);
  assert.equal(postCalled, false, 'Must not issue duplicate POST D1 during recovery');
  assert.equal(result.databaseId, VALID_DATABASE_ID);
});

test('prepareResources refuses to overwrite an existing Worker script with different XFOLLOWER_SETUP_ID', async () => {
  const { fetchImpl } = mockFetcher((url, opts) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    if (url.includes('/d1/database') && opts.method === 'GET') {
      return Response.json({ success: true, result: [] });
    }
    if (url.endsWith('/d1/database') && opts.method === 'POST') {
      return Response.json({ success: true, result: { uuid: VALID_DATABASE_ID, name: VALID_RESOURCE_NAME } });
    }
    if (url.includes('/query')) {
      return Response.json({ success: true, result: [{ success: true }] });
    }
    if (url.endsWith('/settings')) {
      // Existing Worker script with different setup ID
      return Response.json({
        success: true,
        result: {
          bindings: [{ type: 'plain_text', name: 'XFOLLOWER_SETUP_ID', text: 'other-unrelated-setup-id' }]
        }
      });
    }
    return Response.json({ success: true });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  await assert.rejects(
    provisioner.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN
    }),
    (err) => err.code === 'WORKER_OWNERSHIP_CONFLICT'
  );
});

test('prepareResources resumes from failed upload without re-running D1 or schema', async () => {
  let d1Queried = false;
  let schemaQueried = false;
  let uploadCalled = false;

  const { fetchImpl } = mockFetcher((url, opts) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    if (url.includes(`/d1/database/${VALID_DATABASE_ID}`)) {
      d1Queried = true;
      return Response.json({ success: true, result: { uuid: VALID_DATABASE_ID, name: VALID_RESOURCE_NAME } });
    }
    if (url.includes('/query')) {
      schemaQueried = true;
      return Response.json({ success: true, result: [{ success: true }] });
    }
    if (url.endsWith('/settings')) {
      return Response.json({ success: false }, { status: 404 });
    }
    if (opts.method === 'PUT') {
      uploadCalled = true;
      return Response.json({ success: true, result: {} });
    }
    if (url.endsWith('/subdomain') && opts.method === 'POST') {
      return Response.json({ success: true, result: { enabled: true } });
    }
    return Response.json({ success: true });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  const result = await provisioner.prepareResources({
    token: 'test-token',
    accountId: VALID_ACCOUNT_ID,
    resourceName: VALID_RESOURCE_NAME,
    setupId: VALID_SETUP_ID,
    checkpoint: {
      databaseId: VALID_DATABASE_ID,
      schemaApplied: true
    },
    workerSource: DUMMY_WORKER_SOURCE,
    schema: DUMMY_SCHEMA,
    clientToken: VALID_CLIENT_TOKEN
  });

  assert.ok(d1Queried);
  assert.equal(schemaQueried, false, 'Schema must not be re-queried when checkpoint marked schemaApplied');
  assert.ok(uploadCalled);
  assert.equal(result.databaseId, VALID_DATABASE_ID);
});

test('configureWorker validates inputs, rechecks ownership, and uploads module with webhook secrets', async () => {
  let settingsChecked = false;
  let configuredUpload = false;
  let finalBindings = null;

  const { fetchImpl, calls } = mockFetcher(async (url, opts) => {
    if (url.endsWith(`/workers/scripts/${VALID_RESOURCE_NAME}/settings`)) {
      settingsChecked = true;
      return Response.json({
        success: true,
        result: {
          bindings: [{ type: 'plain_text', name: 'XFOLLOWER_SETUP_ID', text: VALID_SETUP_ID }]
        }
      });
    }
    if (url.endsWith(`/workers/scripts/${VALID_RESOURCE_NAME}`) && opts.method === 'PUT') {
      configuredUpload = true;
      const metadataBlob = opts.body.get('metadata');
      const metadata = JSON.parse(await metadataBlob.text());
      finalBindings = metadata.bindings;
      return Response.json({ success: true, result: {} });
    }
    return Response.json({ success: false }, { status: 404 });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  const result = await provisioner.configureWorker({
    token: 'test-token',
    accountId: VALID_ACCOUNT_ID,
    resourceName: VALID_RESOURCE_NAME,
    setupId: VALID_SETUP_ID,
    databaseId: VALID_DATABASE_ID,
    origin: VALID_ORIGIN,
    workerSource: DUMMY_WORKER_SOURCE,
    clientToken: VALID_CLIENT_TOKEN,
    webhookUrl: VALID_WEBHOOK_URL,
    webhookSecret: VALID_WEBHOOK_SECRET
  });

  assert.equal(result.origin, VALID_ORIGIN);
  assert.ok(settingsChecked);
  assert.ok(configuredUpload);

  // Assert secret bindings include WEBHOOK_URL and WEBHOOK_SECRET
  const webhookUrlBinding = finalBindings.find(b => b.name === 'WEBHOOK_URL');
  assert.deepEqual(webhookUrlBinding, {
    type: 'secret_text',
    name: 'WEBHOOK_URL',
    text: VALID_WEBHOOK_URL
  });

  const webhookSecretBinding = finalBindings.find(b => b.name === 'WEBHOOK_SECRET');
  assert.deepEqual(webhookSecretBinding, {
    type: 'secret_text',
    name: 'WEBHOOK_SECRET',
    text: VALID_WEBHOOK_SECRET
  });

  // Verify no calls were made to grok.com or external generation endpoints
  for (const call of calls) {
    assert.ok(call.url.startsWith('https://api.cloudflare.com/client/v4/'));
  }
});

test('configureWorker throws on ownership conflict or invalid webhook parameters', async () => {
  const { fetchImpl } = mockFetcher((url) => {
    if (url.endsWith('/settings')) {
      return Response.json({
        success: true,
        result: {
          bindings: [{ type: 'plain_text', name: 'XFOLLOWER_SETUP_ID', text: 'mismatched-setup-id' }]
        }
      });
    }
    return Response.json({ success: true });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });

  // Ownership mismatch throws
  await assert.rejects(
    provisioner.configureWorker({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      databaseId: VALID_DATABASE_ID,
      origin: VALID_ORIGIN,
      workerSource: DUMMY_WORKER_SOURCE,
      clientToken: VALID_CLIENT_TOKEN,
      webhookUrl: VALID_WEBHOOK_URL,
      webhookSecret: VALID_WEBHOOK_SECRET
    }),
    (err) => err.code === 'WORKER_OWNERSHIP_CONFLICT'
  );

  // Invalid webhook URL throws
  await assert.rejects(
    provisioner.configureWorker({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      databaseId: VALID_DATABASE_ID,
      origin: VALID_ORIGIN,
      workerSource: DUMMY_WORKER_SOURCE,
      clientToken: VALID_CLIENT_TOKEN,
      webhookUrl: 'https://malicious.org/webhook',
      webhookSecret: VALID_WEBHOOK_SECRET
    }),
    (err) => err.code === 'INVALID_WEBHOOK_URL'
  );

  // Invalid webhook secret throws
  await assert.rejects(
    provisioner.configureWorker({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      databaseId: VALID_DATABASE_ID,
      origin: VALID_ORIGIN,
      workerSource: DUMMY_WORKER_SOURCE,
      clientToken: VALID_CLIENT_TOKEN,
      webhookUrl: VALID_WEBHOOK_URL,
      webhookSecret: 'not-whsec-prefix'
    }),
    (err) => err.code === 'INVALID_WEBHOOK_SECRET'
  );
});

test('regression: an old unrelated same-name DB is not adopted on second run after a rejected creation', async () => {
  const checkpoints = [];
  let postCount = 0;
  const { fetchImpl } = mockFetcher((url, opts) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    if (url.includes('/d1/database') && opts.method === 'GET') {
      return Response.json({
        success: true,
        result: [{ uuid: 'unrelated-old-db-999', name: VALID_RESOURCE_NAME }]
      });
    }
    if (url.endsWith('/d1/database') && opts.method === 'POST') {
      postCount++;
      return Response.json({ success: false, errors: [{ code: 7502 }] }, { status: 400 });
    }
    return Response.json({ success: true });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });

  // Run 1: First attempt fails due to preflight detecting preexisting same-name DB
  await assert.rejects(
    provisioner.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      checkpoint: {},
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN,
      onCheckpoint: async (cp) => checkpoints.push(cp)
    }),
    (err) => err.code === 'DATABASE_ALREADY_EXISTS'
  );

  // Intent was NOT saved on rejected run
  assert.equal(checkpoints.length, 0);
  assert.equal(postCount, 0);

  // Run 2: Second attempt with the untouched/empty checkpoint must ALSO refuse, never adopting the preexisting DB
  await assert.rejects(
    provisioner.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      checkpoint: {},
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN,
      onCheckpoint: async (cp) => checkpoints.push(cp)
    }),
    (err) => err.code === 'DATABASE_ALREADY_EXISTS'
  );

  assert.equal(checkpoints.length, 0);
  assert.equal(postCount, 0);

  // Even if a caller fabricates d1Intent in checkpoint without preflightAbsent=true, recovery is strictly refused
  await assert.rejects(
    provisioner.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      checkpoint: { d1Intent: VALID_RESOURCE_NAME },
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN
    }),
    (err) => err.code === 'DATABASE_ADOPTION_REFUSED'
  );
});

test('POST D1 failure preserves original sanitized error and retains d1Intent with preflightAbsent for recovery', async () => {
  const checkpoints = [];
  const { fetchImpl } = mockFetcher((url, opts) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    if (url.includes('/d1/database') && opts.method === 'GET') {
      return Response.json({ success: true, result: [] });
    }
    if (url.endsWith('/d1/database') && opts.method === 'POST') {
      return Response.json({
        success: false,
        errors: [{ code: 10013, message: 'Temporary rate limit' }]
      }, { status: 429 });
    }
    return Response.json({ success: true });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  await assert.rejects(
    provisioner.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      checkpoint: {},
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN,
      onCheckpoint: async (cp) => checkpoints.push(cp)
    }),
    (err) => {
      // Must NOT be mislabeled as DATABASE_ALREADY_EXISTS
      assert.notEqual(err.code, 'DATABASE_ALREADY_EXISTS');
      assert.equal(err.code, 'CF_10013');
      assert.equal(err.status, 429);
      return true;
    }
  );

  // Intent was retained before POST
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].step, 'd1_creating');
  assert.equal(checkpoints[0].d1Intent, VALID_RESOURCE_NAME);
  assert.equal(checkpoints[0].preflightAbsent, true);
});

test('sanitized errors only include numeric codes, never strings/objects, and cap code list length', async () => {
  const { fetchImpl } = mockFetcher(() => {
    return Response.json(
      {
        success: false,
        errors: [
          { code: 'MALICIOUS_STRING_OR_TOKEN' },
          { code: { nested: 'object' } },
          { code: 10001 },
          { code: 10002 },
          { code: 10003 },
          { code: 10004 },
          { code: 10005 },
          { code: 10006 },
          { code: 10007 },
          { code: 10008 },
          { code: 10009 },
          { code: 10010 },
          { code: 10011 },
          { code: 10012 }
        ]
      },
      { status: 400 }
    );
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  await assert.rejects(
    provisioner.inspect('test-token'),
    (err) => {
      assert.equal(err.code, 'CF_10001');
      assert.equal(err.message.includes('MALICIOUS_STRING_OR_TOKEN'), false);
      assert.equal(err.message.includes('object'), false);
      const matches = err.message.match(/codes: ([\d,]+)/);
      assert.ok(matches);
      const codes = matches[1].split(',');
      assert.equal(codes.length, 10);
      assert.equal(codes.includes('10011'), false);
      return true;
    }
  );
});

test('cfRequest rejects 200 responses with missing or malformed JSON success envelope', async () => {
  // Case A: 200 OK with HTML / malformed JSON
  const fetcherHtml = mockFetcher(() => {
    return new Response('<html>Bad Gateway</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  });
  const provHtml = createCloudflareProvisioner({ fetchImpl: fetcherHtml.fetchImpl });
  await assert.rejects(
    provHtml.inspect('test-token'),
    (err) => err.code === 'INVALID_RESPONSE' && err.status === 200
  );

  // Case B: 200 OK with JSON missing success: true
  const fetcherNoSuccess = mockFetcher(() => {
    return Response.json({ result: { status: 'active' } }, { status: 200 });
  });
  const provNoSuccess = createCloudflareProvisioner({ fetchImpl: fetcherNoSuccess.fetchImpl });
  await assert.rejects(
    provNoSuccess.inspect('test-token'),
    (err) => err.code === 'INVALID_RESPONSE' && err.status === 200
  );
});

test('prepareResources rejects empty or missing per-statement D1 results', async () => {
  // Case A: result is empty array
  const fetcherEmpty = mockFetcher((url, opts) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    if (url.includes('/d1/database') && opts.method === 'GET') {
      return Response.json({ success: true, result: [] });
    }
    if (url.endsWith('/d1/database') && opts.method === 'POST') {
      return Response.json({ success: true, result: { uuid: VALID_DATABASE_ID } });
    }
    if (url.includes('/query')) {
      return Response.json({ success: true, result: [] }); // empty results!
    }
    return Response.json({ success: true });
  });

  const provEmpty = createCloudflareProvisioner({ fetchImpl: fetcherEmpty.fetchImpl });
  await assert.rejects(
    provEmpty.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN
    }),
    (err) => err.code === 'D1_QUERY_STATEMENT_FAILED'
  );

  // Case B: statement missing success: true
  const fetcherMissingSuccess = mockFetcher((url, opts) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    if (url.includes('/d1/database') && opts.method === 'GET') {
      return Response.json({ success: true, result: [] });
    }
    if (url.endsWith('/d1/database') && opts.method === 'POST') {
      return Response.json({ success: true, result: { uuid: VALID_DATABASE_ID } });
    }
    if (url.includes('/query')) {
      return Response.json({ success: true, result: [{ meta: {} }] }); // missing success: true!
    }
    return Response.json({ success: true });
  });

  const provMissing = createCloudflareProvisioner({ fetchImpl: fetcherMissingSuccess.fetchImpl });
  await assert.rejects(
    provMissing.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN
    }),
    (err) => err.code === 'D1_QUERY_STATEMENT_FAILED'
  );
});

test('cfRequest abort timer stays active until body has been consumed', async () => {
  const fetchImpl = async () => {
    return {
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      async json() {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
    };
  };

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  await assert.rejects(
    provisioner.inspect('test-token'),
    (err) => err.code === 'TIMEOUT_ERROR'
  );
});

test('DNS_LABEL_REGEX validates single DNS label and rejects invalid labels', () => {
  assert.ok(DNS_LABEL_REGEX.test('my-team'));
  assert.ok(DNS_LABEL_REGEX.test('a'));
  assert.ok(DNS_LABEL_REGEX.test('123'));
  assert.equal(DNS_LABEL_REGEX.test(''), false);
  assert.equal(DNS_LABEL_REGEX.test('-abc'), false);
  assert.equal(DNS_LABEL_REGEX.test('abc-'), false);
  assert.equal(DNS_LABEL_REGEX.test('a.b'), false);
  assert.equal(DNS_LABEL_REGEX.test('a'.repeat(64)), false);
});

test('prepareResources validates workers.dev subdomain is one DNS label and rejects multi-label subdomains', async () => {
  const fetcherMultiLabel = mockFetcher((url) => {
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my.bad.subdomain' } });
    }
    return Response.json({ success: true });
  });

  const provMulti = createCloudflareProvisioner({ fetchImpl: fetcherMultiLabel.fetchImpl });
  await assert.rejects(
    provMulti.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN
    }),
    (err) => err.code === 'INVALID_SUBDOMAIN'
  );
});

test('paths encode databaseId and accountId preventing path injection', async () => {
  const injectedDbId = '../injected-db-id/extra';
  const { fetchImpl, calls } = mockFetcher((url) => {
    if (url.includes(encodeURIComponent(injectedDbId))) {
      return Response.json({ success: true, result: { name: VALID_RESOURCE_NAME } });
    }
    if (url.endsWith('/workers/subdomain')) {
      return Response.json({ success: true, result: { subdomain: 'my-team' } });
    }
    return Response.json({ success: false }, { status: 404 });
  });

  const provisioner = createCloudflareProvisioner({ fetchImpl });
  try {
    await provisioner.prepareResources({
      token: 'test-token',
      accountId: VALID_ACCOUNT_ID,
      resourceName: VALID_RESOURCE_NAME,
      setupId: VALID_SETUP_ID,
      checkpoint: { databaseId: injectedDbId },
      workerSource: DUMMY_WORKER_SOURCE,
      schema: DUMMY_SCHEMA,
      clientToken: VALID_CLIENT_TOKEN
    });
  } catch (_) {}

  const dbCall = calls.find(c => c.url.includes('d1/database/'));
  assert.ok(dbCall);
  assert.ok(dbCall.url.includes('..%2Finjected-db-id%2Fextra'));
  assert.equal(dbCall.url.includes('../injected-db-id'), false);
});
