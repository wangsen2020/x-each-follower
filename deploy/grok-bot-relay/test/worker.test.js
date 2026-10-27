import test from "node:test";
import assert from "node:assert/strict";
import { Webhook } from "standardwebhooks";
import worker, {
  timingSafeEqualStr,
  sha256Hex,
  isValidWebhookUrl,
  isValidPublicBaseUrl,
  verifyClientAuth,
  readJsonWithLimit,
  MAX_JOB_BODY_BYTES,
  MAX_CALLBACK_BODY_BYTES,
  MAX_RESULT_CHARS,
  MAX_PROMPT_BYTES,
  NO_CACHE_HEADERS
} from "../worker.js";
import { D1DatabaseMock } from "./d1-mock.js";

// Test credentials and configuration (all isolated mock values, no real credentials)
const TEST_CLIENT_TOKEN = "test_client_token_secret_12345";
const TEST_WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const TEST_WEBHOOK_URL = "https://grok.com/webhook/automation/bot-12345";
const TEST_PUBLIC_BASE_URL = "https://grok-relay.example.workers.dev";
const TEST_BOT_NAME = "Test Grok Bot";

function createMockEnv(overrides = {}) {
  const db = new D1DatabaseMock();
  return {
    DB: db,
    CLIENT_TOKEN: TEST_CLIENT_TOKEN,
    WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    WEBHOOK_URL: TEST_WEBHOOK_URL,
    PUBLIC_BASE_URL: TEST_PUBLIC_BASE_URL,
    BOT_NAME: TEST_BOT_NAME,
    ...overrides
  };
}

// Helper to make Request objects
function makeRequest(path, options = {}) {
  const url = `https://grok-relay.example.workers.dev${path}`;
  const headers = new Headers(options.headers || {});
  return new Request(url, {
    method: options.method || "GET",
    headers,
    body: options.body
  });
}

test("1. Utility functions, crypto isolation & URL validation", async (t) => {
  await t.test("timingSafeEqualStr compares correctly in constant time", () => {
    assert.equal(timingSafeEqualStr("token123", "token123"), true);
    assert.equal(timingSafeEqualStr("token123", "token456"), false);
    assert.equal(timingSafeEqualStr("token123", "token12"), false);
    assert.equal(timingSafeEqualStr("token12", "token123"), false);
    assert.equal(timingSafeEqualStr("", ""), true);
    assert.equal(timingSafeEqualStr(null, "token"), false);
    assert.equal(timingSafeEqualStr("token", undefined), false);
  });

  await t.test("sha256Hex produces standard 64-char hex hash", async () => {
    const hash = await sha256Hex("hello world");
    assert.equal(hash, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  await t.test("isValidWebhookUrl validates HTTPS grok.com /webhook/automation/ endpoint", () => {
    // Valid cases
    assert.equal(isValidWebhookUrl("https://grok.com/webhook/automation/bot-abc-123"), true);
    assert.equal(isValidWebhookUrl("https://grok.com/webhook/automation/"), false);
    assert.equal(isValidWebhookUrl("https://GROK.COM/webhook/automation/bot1"), true);

    // Invalid cases: non-HTTPS
    assert.equal(isValidWebhookUrl("http://grok.com/webhook/automation/bot1"), false);

    // Invalid cases: non-grok.com
    assert.equal(isValidWebhookUrl("https://evil.com/webhook/automation/bot1"), false);
    assert.equal(isValidWebhookUrl("https://sub.grok.com/webhook/automation/bot1"), false);
    assert.equal(isValidWebhookUrl("https://grok-bot.example.com/api/webhook"), false);

    // Invalid cases: non-/webhook/automation/ path
    assert.equal(isValidWebhookUrl("https://grok.com/api/webhook"), false);
    assert.equal(isValidWebhookUrl("https://grok.com/webhook/automations/bot1"), false);
    assert.equal(isValidWebhookUrl("https://grok.com/webhook"), false);

    // Non-string or empty
    assert.equal(isValidWebhookUrl(""), false);
    assert.equal(isValidWebhookUrl(null), false);
    assert.equal(isValidWebhookUrl(undefined), false);
    assert.equal(isValidWebhookUrl("not-a-url"), false);
  });

  await t.test("isValidPublicBaseUrl validates HTTPS origin", () => {
    // Valid HTTPS origins
    assert.equal(isValidPublicBaseUrl("https://grok-relay.example.workers.dev"), true);
    assert.equal(isValidPublicBaseUrl("https://grok-relay.example.workers.dev/"), true);
    assert.equal(isValidPublicBaseUrl("https://my-relay.com"), true);
    assert.equal(isValidPublicBaseUrl("https://my-relay.com:8443"), true);

    // Invalid: HTTP
    assert.equal(isValidPublicBaseUrl("http://grok-relay.example.workers.dev"), false);

    // Invalid: contains subpath
    assert.equal(isValidPublicBaseUrl("https://grok-relay.example.workers.dev/relay"), false);
    assert.equal(isValidPublicBaseUrl("https://grok-relay.example.workers.dev/v1"), false);

    // Invalid: contains search or hash
    assert.equal(isValidPublicBaseUrl("https://grok-relay.example.workers.dev?query=1"), false);
    assert.equal(isValidPublicBaseUrl("https://grok-relay.example.workers.dev#anchor"), false);

    // Invalid: contains credentials
    assert.equal(isValidPublicBaseUrl("https://user:pass@grok-relay.example.workers.dev"), false);

    // Non-string or empty
    assert.equal(isValidPublicBaseUrl(""), false);
    assert.equal(isValidPublicBaseUrl(null), false);
    assert.equal(isValidPublicBaseUrl("invalid-origin"), false);
  });
});

test("2. GET /v1/health endpoint", async (t) => {
  await t.test("returns 401 when Authorization header is missing with no-cache", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/health");
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
    assert.equal(res.headers.get("Pragma"), "no-cache");
    const body = await res.json();
    assert.equal(body.code, "UNAUTHORIZED");
  });

  await t.test("returns 401 when Authorization token is invalid with no-cache", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/health", {
      headers: { Authorization: "Bearer wrong_token" }
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
    const body = await res.json();
    assert.equal(body.code, "UNAUTHORIZED");
  });

  await t.test("rejects missing or invalid configuration with 500", async () => {
    // Missing WEBHOOK_URL
    const envNoWebhook = createMockEnv({ WEBHOOK_URL: "" });
    const resNoWebhook = await worker.fetch(makeRequest("/v1/health", {
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    }), envNoWebhook);
    assert.equal(resNoWebhook.status, 500);
    const bodyNoWebhook = await resNoWebhook.json();
    assert.equal(bodyNoWebhook.code, "CONFIG_MISSING");

    // Invalid WEBHOOK_URL (not HTTPS grok.com /webhook/automation/ endpoint)
    const envBadWebhook = createMockEnv({ WEBHOOK_URL: "https://bad-host.com/webhook/automation/bot1" });
    const resBadWebhook = await worker.fetch(makeRequest("/v1/health", {
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    }), envBadWebhook);
    assert.equal(resBadWebhook.status, 500);
    const bodyBadWebhook = await resBadWebhook.json();
    assert.equal(bodyBadWebhook.code, "CONFIG_MISSING");

    // Missing WEBHOOK_SECRET
    const envNoSecret = createMockEnv({ WEBHOOK_SECRET: "" });
    const resNoSecret = await worker.fetch(makeRequest("/v1/health", {
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    }), envNoSecret);
    assert.equal(resNoSecret.status, 500);
    const bodyNoSecret = await resNoSecret.json();
    assert.equal(bodyNoSecret.code, "CONFIG_MISSING");

    // Missing or invalid PUBLIC_BASE_URL
    const envBadBaseUrl = createMockEnv({ PUBLIC_BASE_URL: "http://not-https-origin.com" });
    const resBadBaseUrl = await worker.fetch(makeRequest("/v1/health", {
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    }), envBadBaseUrl);
    assert.equal(resBadBaseUrl.status, 500);
    const bodyBadBaseUrl = await resBadBaseUrl.json();
    assert.equal(bodyBadBaseUrl.code, "CONFIG_MISSING");

    // Missing DB binding
    const envNoDb = createMockEnv({ DB: null });
    const resNoDb = await worker.fetch(makeRequest("/v1/health", {
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    }), envNoDb);
    assert.equal(resNoDb.status, 500);
    const bodyNoDb = await resNoDb.json();
    assert.equal(bodyNoDb.code, "MISSING_DB");
  });

  await t.test("rejects missing D1 schema with 500", async () => {
    // Uninitialized DB (schema.sql has not been run)
    const uninitializedDb = new D1DatabaseMock(false);
    const envUninitialized = createMockEnv({ DB: uninitializedDb });
    const res = await worker.fetch(makeRequest("/v1/health", {
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    }), envUninitialized);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
    const body = await res.json();
    assert.equal(body.code, "SCHEMA_MISSING");
  });

  await t.test("returns 200 with valid Bearer token and does not leak secrets, has no-cache", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/health", {
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
    assert.equal(res.headers.get("Pragma"), "no-cache");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.provider, "grok-bot");
    assert.equal(body.protocolVersion, 1);
    assert.equal(body.botName, TEST_BOT_NAME);
    assert.deepEqual(body.capabilities, ["health", "jobs", "callback"]);
    // Strict leak checks
    assert.equal(body.WEBHOOK_SECRET, undefined);
    assert.equal(body.CLIENT_TOKEN, undefined);
    assert.equal(body.secret, undefined);
  });

  await t.test("returns 405 Method Not Allowed for non-GET requests", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/health", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "GET");
  });
});

test("3. Body byte limits & Request validation (128KB jobs, 100000 bytes prompt)", async (t) => {
  await t.test("rejects POST /v1/jobs with Content-Length exceeding 128KB", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        "Content-Length": (MAX_JOB_BODY_BYTES + 100).toString(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jobId: "job_large", prompt: "x".repeat(100) })
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.code, "PAYLOAD_TOO_LARGE");
  });

  await t.test("rejects POST /v1/jobs with stream body exceeding 128KB", async () => {
    const env = createMockEnv();
    const largePrompt = "a".repeat(MAX_JOB_BODY_BYTES + 50);
    const req = makeRequest("/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jobId: "job_stream", prompt: largePrompt })
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.code, "PAYLOAD_TOO_LARGE");
  });

  await t.test("rejects POST /v1/jobs with prompt exceeding 100,000 UTF-8 bytes", async () => {
    const env = createMockEnv();
    // 100,001 single-byte characters
    const overPrompt = "a".repeat(MAX_PROMPT_BYTES + 1);
    const req = makeRequest("/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jobId: "job_prompt_over", prompt: overPrompt })
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "INVALID_PROMPT");
  });

  await t.test("rejects POST /v1/jobs with multi-byte prompt exceeding 100,000 UTF-8 bytes", async () => {
    const env = createMockEnv();
    // Each Chinese character is 3 UTF-8 bytes. 33,334 * 3 = 100,002 bytes (> 100,000)
    const chineseOverPrompt = "字".repeat(33334);
    assert.ok(new TextEncoder().encode(chineseOverPrompt).length > MAX_PROMPT_BYTES);
    const req = makeRequest("/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jobId: "job_chinese_over", prompt: chineseOverPrompt })
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "INVALID_PROMPT");
  });

  await t.test("rejects POST /v1/jobs with malformed JSON", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: "{ not valid json: true"
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "INVALID_JSON");
  });

  await t.test("rejects POST /v1/jobs with invalid or missing jobId", async () => {
    const env = createMockEnv();
    const badJobIds = ["", "   ", "bad/path/job", "job with space", "job?query=1", "../../traversal"];
    for (const badId of badJobIds) {
      const req = makeRequest("/v1/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ jobId: badId, prompt: "write a tweet" })
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 400, `Expected 400 for bad jobId: ${badId}`);
      const data = await res.json();
      assert.equal(data.code, "INVALID_JOB_ID");
    }
  });

  await t.test("rejects POST /v1/jobs with empty or whitespace prompt", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jobId: "job_123", prompt: "   " })
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "INVALID_PROMPT");
  });
});

test("4. POST /v1/jobs contract, dispatch validation & only 202 accepted", async (t) => {
  await t.test("validates WEBHOOK_URL is HTTPS grok.com /webhook/automation/ endpoint before dispatch", async () => {
    const env = createMockEnv({ WEBHOOK_URL: "https://invalid-host.com/api" });
    const req = makeRequest("/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jobId: "job_bad_webhook", prompt: "Test prompt" })
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.jobId, "job_bad_webhook");
    assert.equal(data.status, "unknown");

    const row = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind("job_bad_webhook").first();
    assert.equal(row.status, "unknown");
    assert.equal(row.reason_code, "CONFIG_INVALID_WEBHOOK");
  });

  await t.test("validates PUBLIC_BASE_URL is HTTPS origin before dispatch", async () => {
    const env = createMockEnv({ PUBLIC_BASE_URL: "http://non-https-origin.com" });
    const req = makeRequest("/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jobId: "job_bad_base_url", prompt: "Test prompt" })
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.status, "unknown");

    const row = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind("job_bad_base_url").first();
    assert.equal(row.status, "unknown");
    assert.equal(row.reason_code, "CONFIG_INVALID_PUBLIC_BASE_URL");
  });

  await t.test("dispatches exact contract payload {jobId, text, callback, callbackToken} with Standard Webhooks signature and manual redirect rejection & timeout", async () => {
    const env = createMockEnv();

    let capturedUrl = null;
    let capturedOptions = null;
    let capturedHeaders = null;
    let capturedBody = null;

    // Mock global fetch to capture webhook dispatch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      capturedHeaders = options.headers;
      capturedBody = options.body;
      // Only 202 is accepted!
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    };

    try {
      const originalPrompt = "Generate an insightful tweet about TypeScript";
      const req = makeRequest("/v1/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jobId: "job_test_001",
          prompt: originalPrompt
        })
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 202);
      assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
      const resData = await res.json();
      assert.equal(resData.jobId, "job_test_001");
      assert.equal(resData.status, "accepted");

      // Verify destination is strictly env.WEBHOOK_URL
      assert.equal(capturedUrl, TEST_WEBHOOK_URL);

      // Verify redirect: "manual" and signal (timeout)
      assert.equal(capturedOptions.redirect, "manual");
      assert.ok(capturedOptions.signal, "fetch must have timeout signal");

      // Verify Standard Webhooks headers
      assert.ok(capturedHeaders["webhook-id"], "Missing webhook-id header");
      assert.ok(capturedHeaders["webhook-timestamp"], "Missing webhook-timestamp header");
      assert.ok(capturedHeaders["webhook-signature"], "Missing webhook-signature header");

      // Verify Standard Webhooks signature
      const wh = new Webhook(TEST_WEBHOOK_SECRET);
      const verifiedPayload = wh.verify(capturedBody, capturedHeaders);
      assert.ok(verifiedPayload);

      // CRITICAL CONTRACT CHECK:
      // Webhook payload must be: jobId, text, callback, callbackToken
      // text is original prompt.
      assert.equal(verifiedPayload.jobId, "job_test_001");
      assert.equal(verifiedPayload.text, originalPrompt);
      assert.equal(verifiedPayload.callback, `${TEST_PUBLIC_BASE_URL}/v1/callback`);
      assert.ok(typeof verifiedPayload.callbackToken === "string" && verifiedPayload.callbackToken.startsWith("cbt_"));
      assert.equal(verifiedPayload.prompt, undefined, "prompt key must not be sent, text must be used");
      assert.equal(verifiedPayload.token, undefined, "token key must not be sent, callbackToken must be used");
      assert.equal(verifiedPayload.callbackUrl, undefined, "callbackUrl key must not be sent, callback must be used");

      // Verify D1 record
      const dbRow = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind("job_test_001").first();
      assert.ok(dbRow);
      assert.equal(dbRow.status, "accepted");
      assert.equal(dbRow.callback_hash, await sha256Hex(verifiedPayload.callbackToken));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("only 202 is accepted: HTTP 200 from webhook records unknown and HTTP_200", async () => {
    const env = createMockEnv();

    const originalFetch = globalThis.fetch;
    // Webhook returns 200 instead of 202
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

    try {
      const req = makeRequest("/v1/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jobId: "job_status_200",
          prompt: "Test prompt expecting 202"
        })
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 202);
      const resData = await res.json();
      assert.equal(resData.status, "unknown");

      const row = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind("job_status_200").first();
      assert.equal(row.status, "unknown");
      assert.equal(row.reason_code, "HTTP_200");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("timeout 20s records unknown with TIMEOUT reason", async () => {
    const env = createMockEnv();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      throw err;
    };

    try {
      const req = makeRequest("/v1/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jobId: "job_timeout",
          prompt: "Test timeout prompt"
        })
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 202);
      const resData = await res.json();
      assert.equal(resData.status, "unknown");

      const row = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind("job_timeout").first();
      assert.equal(row.status, "unknown");
      assert.equal(row.reason_code, "TIMEOUT");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("5. POST /v1/jobs Idempotency & Conflict handling", async (t) => {
  await t.test("idempotent replay with same jobId and same prompt returns status without re-dispatching", async () => {
    const env = createMockEnv();
    let dispatchCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      dispatchCount++;
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    };

    try {
      const payload = { jobId: "job_idempotent_1", prompt: "Hello world prompt" };

      // First call
      const req1 = makeRequest("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
        body: JSON.stringify(payload)
      });
      const res1 = await worker.fetch(req1, env);
      assert.equal(res1.status, 202);
      assert.equal(dispatchCount, 1);

      // Second call (identical)
      const req2 = makeRequest("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
        body: JSON.stringify(payload)
      });
      const res2 = await worker.fetch(req2, env);
      assert.equal(res2.status, 202);
      const data2 = await res2.json();
      assert.equal(data2.jobId, "job_idempotent_1");
      assert.equal(data2.status, "accepted");
      // Must NOT dispatch webhook again!
      assert.equal(dispatchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("conflict: same jobId with different prompt returns 409", async () => {
    const env = createMockEnv();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ accepted: true }), { status: 202 });

    try {
      // First call
      const req1 = makeRequest("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
        body: JSON.stringify({ jobId: "job_conflict_1", prompt: "Prompt A" })
      });
      const res1 = await worker.fetch(req1, env);
      assert.equal(res1.status, 202);

      // Second call with different prompt
      const req2 = makeRequest("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
        body: JSON.stringify({ jobId: "job_conflict_1", prompt: "Prompt B (Different)" })
      });
      const res2 = await worker.fetch(req2, env);
      assert.equal(res2.status, 409);
      const data2 = await res2.json();
      assert.equal(data2.code, "JOB_ID_CONFLICT");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("6. Unknown dispatch handling (network interruption & 5xx)", async (t) => {
  await t.test("records unknown status on network interruption without blind retry", async () => {
    const env = createMockEnv();

    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      throw new Error("Network timeout or connection reset");
    };

    try {
      const req = makeRequest("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
        body: JSON.stringify({ jobId: "job_net_err", prompt: "Test prompt" })
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 202);
      const data = await res.json();
      assert.equal(data.jobId, "job_net_err");
      assert.equal(data.status, "unknown");

      // Verify D1 state is unknown with reason code
      const row = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind("job_net_err").first();
      assert.equal(row.status, "unknown");
      assert.equal(row.reason_code, "NETWORK_ERROR");

      // Re-submitting the same job does NOT re-dispatch
      const reqRepeat = makeRequest("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
        body: JSON.stringify({ jobId: "job_net_err", prompt: "Test prompt" })
      });
      const resRepeat = await worker.fetch(reqRepeat, env);
      assert.equal(resRepeat.status, 202);
      const dataRepeat = await resRepeat.json();
      assert.equal(dataRepeat.status, "unknown");
      assert.equal(callCount, 1); // No blind re-dispatch
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("records unknown status on HTTP 500 response from webhook", async () => {
    const env = createMockEnv();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });

    try {
      const req = makeRequest("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
        body: JSON.stringify({ jobId: "job_http_500", prompt: "Test prompt" })
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 202);
      const data = await res.json();
      assert.equal(data.status, "unknown");

      const row = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind("job_http_500").first();
      assert.equal(row.status, "unknown");
      assert.equal(row.reason_code, "HTTP_500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("7. Callback processing & Strict result validation (limit 100000 chars)", async (t) => {
  await t.test("completes job with valid callback and returns 200 (jobId, token, result)", async () => {
    const env = createMockEnv();
    const rawToken = "cbt_valid_token_1234567890abcdef";
    const tokenHash = await sha256Hex(rawToken);

    // Pre-insert accepted job into D1
    await env.DB.prepare(
      "INSERT INTO jobs (job_id, prompt_hash, prompt, status, callback_hash, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)"
    ).bind("job_cb_success", "hash1", "prompt 1", tokenHash, Date.now(), Date.now()).run();

    // Callback uses jobId, token, result
    const callbackReq = makeRequest("/v1/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "job_cb_success",
        token: rawToken,
        result: "Generated post: Top 5 AI trends in 2026."
      })
    });

    const res = await worker.fetch(callbackReq, env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.status, "completed");

    // Verify D1 row
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind("job_cb_success").first();
    assert.equal(row.status, "completed");
    assert.equal(row.result, "Generated post: Top 5 AI trends in 2026.");
  });

  await t.test("rejects callback with result exceeding 100,000 characters", async () => {
    const env = createMockEnv();
    const rawToken = "cbt_valid_token_limit_test";
    const tokenHash = await sha256Hex(rawToken);

    await env.DB.prepare(
      "INSERT INTO jobs (job_id, prompt_hash, prompt, status, callback_hash, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)"
    ).bind("job_cb_limit", "hash1", "prompt 1", tokenHash, Date.now(), Date.now()).run();

    const overResult = "x".repeat(MAX_RESULT_CHARS + 1);
    const callbackReq = makeRequest("/v1/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "job_cb_limit",
        token: rawToken,
        result: overResult
      })
    });

    const res = await worker.fetch(callbackReq, env);
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.code, "PAYLOAD_TOO_LARGE");
  });

  await t.test("accepts callback with result exactly 100,000 characters", async () => {
    const env = createMockEnv();
    const rawToken = "cbt_valid_token_limit_exact";
    const tokenHash = await sha256Hex(rawToken);

    await env.DB.prepare(
      "INSERT INTO jobs (job_id, prompt_hash, prompt, status, callback_hash, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)"
    ).bind("job_cb_exact", "hash1", "prompt 1", tokenHash, Date.now(), Date.now()).run();

    const exactResult = "a".repeat(MAX_RESULT_CHARS);
    const callbackReq = makeRequest("/v1/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "job_cb_exact",
        token: rawToken,
        result: exactResult
      })
    });

    const res = await worker.fetch(callbackReq, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "completed");
  });

  await t.test("rejects callback with wrong callback token", async () => {
    const env = createMockEnv();
    const tokenHash = await sha256Hex("correct_token");

    await env.DB.prepare(
      "INSERT INTO jobs (job_id, prompt_hash, prompt, status, callback_hash, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)"
    ).bind("job_cb_auth", "hash1", "prompt 1", tokenHash, Date.now(), Date.now()).run();

    const req = makeRequest("/v1/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "job_cb_auth",
        token: "wrong_token",
        result: "Generated text"
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
    const data = await res.json();
    assert.equal(data.code, "UNAUTHORIZED");
  });

  await t.test("rejects callback for nonexistent jobId with 404", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "job_nonexistent",
        token: "any_token",
        result: "Generated text"
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 404);
  });

  await t.test("rejects callback with non-string result", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "job_cb_invalid_type",
        token: "token123",
        result: { text: "should not be an object" }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "INVALID_RESULT");
  });

  await t.test("rejects callback with empty result", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "job_cb_empty_res",
        token: "token123",
        result: "    "
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "INVALID_RESULT");
  });

  await t.test("rejects callback with oversized body exceeding 256KB", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/callback", {
      method: "POST",
      headers: {
        "Content-Length": (MAX_CALLBACK_BODY_BYTES + 500).toString(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jobId: "job_cb_oversized", token: "tok", result: "x" })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.code, "PAYLOAD_TOO_LARGE");
  });

  await t.test("idempotent duplicate callback returns 200; conflicting callback returns 409", async () => {
    const env = createMockEnv();
    const rawToken = "cbt_token_dup_test";
    const tokenHash = await sha256Hex(rawToken);

    await env.DB.prepare(
      "INSERT INTO jobs (job_id, prompt_hash, prompt, status, callback_hash, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)"
    ).bind("job_dup_cb", "hash1", "prompt 1", tokenHash, Date.now(), Date.now()).run();

    // 1st callback: completes job
    const req1 = makeRequest("/v1/callback", {
      method: "POST",
      body: JSON.stringify({ jobId: "job_dup_cb", token: rawToken, result: "Original result" })
    });
    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 200);

    // 2nd callback: identical result -> idempotent 200 OK
    const req2 = makeRequest("/v1/callback", {
      method: "POST",
      body: JSON.stringify({ jobId: "job_dup_cb", token: rawToken, result: "Original result" })
    });
    const res2 = await worker.fetch(req2, env);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.ok, true);

    // 3rd callback: different result -> 409 Conflict
    const req3 = makeRequest("/v1/callback", {
      method: "POST",
      body: JSON.stringify({ jobId: "job_dup_cb", token: rawToken, result: "Different conflicting result" })
    });
    const res3 = await worker.fetch(req3, env);
    assert.equal(res3.status, 409);
    const data3 = await res3.json();
    assert.equal(data3.code, "CALLBACK_CONFLICT");
  });

  await t.test("handles failure callback and failure idempotency", async () => {
    const env = createMockEnv();
    const rawToken = "cbt_token_fail_test";
    const tokenHash = await sha256Hex(rawToken);

    await env.DB.prepare(
      "INSERT INTO jobs (job_id, prompt_hash, prompt, status, callback_hash, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)"
    ).bind("job_fail_cb", "hash1", "prompt 1", tokenHash, Date.now(), Date.now()).run();

    // 1st callback with reasonCode
    const req1 = makeRequest("/v1/callback", {
      method: "POST",
      body: JSON.stringify({ jobId: "job_fail_cb", token: rawToken, reasonCode: "BOT_RATE_LIMITED" })
    });
    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.status, "failed");

    // Check D1
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind("job_fail_cb").first();
    assert.equal(row.status, "failed");
    assert.equal(row.reason_code, "BOT_RATE_LIMITED");

    // 2nd duplicate failure callback -> idempotent 200
    const req2 = makeRequest("/v1/callback", {
      method: "POST",
      body: JSON.stringify({ jobId: "job_fail_cb", token: rawToken, reasonCode: "BOT_RATE_LIMITED" })
    });
    const res2 = await worker.fetch(req2, env);
    assert.equal(res2.status, 200);

    // 3rd conflicting failure callback -> 409
    const req3 = makeRequest("/v1/callback", {
      method: "POST",
      body: JSON.stringify({ jobId: "job_fail_cb", token: rawToken, reasonCode: "DIFFERENT_REASON" })
    });
    const res3 = await worker.fetch(req3, env);
    assert.equal(res3.status, 409);
  });
});

test("8. Callback race condition: Callback arrives before webhook fetch finishes", async (t) => {
  await t.test("callback arriving during 'dispatching' completes the job and is NOT overwritten by subsequent fetch completion", async () => {
    const env = createMockEnv();
    const jobId = "job_race_first";
    const prompt = "Explain quantum computing";

    const originalFetch = globalThis.fetch;
    let callbackTokenSent = null;

    // Simulate callback arriving while fetch is running!
    globalThis.fetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      callbackTokenSent = payload.callbackToken;

      // In the middle of fetch, simulate Grok Bot executing and calling /v1/callback immediately
      // Callback still uses jobId, token, result
      const callbackReq = makeRequest("/v1/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          token: callbackTokenSent,
          result: "Quantum computing uses qubits."
        })
      });

      const cbRes = await worker.fetch(callbackReq, env);
      assert.equal(cbRes.status, 200, "Callback during dispatching must succeed");

      // Verify DB is now 'completed'
      const checkDuring = await env.DB.prepare("SELECT status FROM jobs WHERE job_id = ?").bind(jobId).first();
      assert.equal(checkDuring.status, "completed");

      // Return 202 from webhook fetch
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    };

    try {
      const req = makeRequest("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
        body: JSON.stringify({ jobId, prompt })
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 202);
      const resData = await res.json();
      // Job was completed by callback, so response reflects 'completed'
      assert.equal(resData.status, "completed");

      // Status in D1 MUST remain 'completed', NOT overwritten with 'accepted'!
      const finalDb = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
      assert.equal(finalDb.status, "completed");
      assert.equal(finalDb.result, "Quantum computing uses qubits.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("callback arriving during 'dispatching' with network failure is NOT overwritten with 'unknown'", async () => {
    const env = createMockEnv();
    const jobId = "job_race_net_err";
    const prompt = "Explain relativity";

    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, options) => {
      const payload = JSON.parse(options.body);

      // Bot callback arrives first
      const callbackReq = makeRequest("/v1/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          token: payload.callbackToken,
          result: "E=mc^2"
        })
      });
      await worker.fetch(callbackReq, env);

      // Fetch connection throws network error after sending payload
      throw new Error("Connection reset after payload delivered");
    };

    try {
      const req = makeRequest("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
        body: JSON.stringify({ jobId, prompt })
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 202);
      const resData = await res.json();
      assert.equal(resData.status, "completed");

      // Must NOT be overwritten to unknown!
      const finalDb = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
      assert.equal(finalDb.status, "completed");
      assert.equal(finalDb.result, "E=mc^2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("9. GET /v1/jobs/:id query endpoint", async (t) => {
  await t.test("returns 401 without valid Bearer token, has no-cache", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/jobs/test_id");
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  });

  await t.test("returns 404 for nonexistent job", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/jobs/nonexistent_123", {
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 404);
  });

  await t.test("returns job details without leaking internal hashes or callback token", async () => {
    const env = createMockEnv();
    const rawToken = "cbt_secret_callback_token";
    const tokenHash = await sha256Hex(rawToken);

    await env.DB.prepare(
      "INSERT INTO jobs (job_id, prompt_hash, prompt, status, callback_hash, result, reason_code, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?, NULL, ?, ?)"
    ).bind("job_query_test", "prompt_hash_123", "Secret prompt", tokenHash, "Final result text", 1000, 2000).run();

    const req = makeRequest("/v1/jobs/job_query_test", {
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` }
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
    assert.equal(res.headers.get("Pragma"), "no-cache");
    const data = await res.json();

    assert.equal(data.jobId, "job_query_test");
    assert.equal(data.status, "completed");
    assert.equal(data.result, "Final result text");
    assert.equal(data.reasonCode, null);
    assert.equal(data.updatedAt, 2000);

    // CRITICAL: Ensure zero secret leakage
    assert.equal(data.callback_hash, undefined);
    assert.equal(data.callbackHash, undefined);
    assert.equal(data.token, undefined);
    assert.equal(data.prompt_hash, undefined);
    assert.equal(data.prompt, undefined);
  });
});

test("10. General HTTP routing & CORS preflight", async (t) => {
  await t.test("handles OPTIONS preflight with CORS headers", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/jobs", { method: "OPTIONS" });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  await t.test("returns 404 for unknown route", async () => {
    const env = createMockEnv();
    const req = makeRequest("/v1/unknown_route");
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 404);
  });
});
