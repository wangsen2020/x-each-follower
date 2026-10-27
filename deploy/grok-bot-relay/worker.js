/**
 * Grok Bot Relay Cloudflare Worker
 *
 * Implements the relay interface contract defined in docs plan 70:
 * - GET  /v1/health       - Authentication check & metadata (does not trigger generation)
 * - POST /v1/jobs         - Dispatches generation job to Grok Bot webhook with Standard Webhooks signature
 * - GET  /v1/jobs/:id     - Queries job status & result (never leaks tokens/secrets)
 * - POST /v1/callback     - Receives & validates generation result from Grok Bot
 */

import { Webhook } from "standardwebhooks";

// Body size and payload limits
export const MAX_JOB_BODY_BYTES = 128 * 1024; // 128 KB
export const MAX_CALLBACK_BODY_BYTES = 256 * 1024; // 256 KB
export const MAX_RESULT_CHARS = 100000; // 100,000 characters
export const MAX_PROMPT_BYTES = 100000; // 100,000 UTF-8 bytes to match client
export const MAX_PROMPT_CHARS = 100000; // legacy alias
export const JOB_ID_REGEX = /^[a-zA-Z0-9_\-\.:]{1,128}$/;

export const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache"
};

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let mismatch = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    mismatch |= bufA[i] ^ bufB[i];
  }
  return mismatch === 0;
}

/**
 * Computes SHA-256 hexadecimal hash string using Web Crypto API.
 */
export async function sha256Hex(text) {
  const enc = new TextEncoder();
  const data = enc.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies Bearer CLIENT_TOKEN authentication header.
 */
export function verifyClientAuth(request, env) {
  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1].trim();
  if (!env.CLIENT_TOKEN) return false;
  return timingSafeEqualStr(token, env.CLIENT_TOKEN);
}

/**
 * Validates that WEBHOOK_URL is an HTTPS URL on grok.com with a /webhook/automation/ endpoint.
 */
export function isValidWebhookUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return false;
  try {
    const parsed = new URL(urlStr.trim());
    if (parsed.protocol !== "https:") return false;
    if (parsed.hostname.toLowerCase() !== "grok.com") return false;
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return false;
    if (!/^\/webhook\/automation\/[a-zA-Z0-9-]+$/.test(parsed.pathname)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Validates that PUBLIC_BASE_URL is a valid HTTPS origin (no path beyond /, no query/hash, no credentials).
 */
export function isValidPublicBaseUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return false;
  try {
    const parsed = new URL(urlStr.trim());
    if (parsed.protocol !== "https:") return false;
    if (!parsed.hostname) return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.search || parsed.hash) return false;
    if (parsed.pathname !== "" && parsed.pathname !== "/") return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Helper to build JSON responses.
 */
export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...NO_CACHE_HEADERS,
      ...headers
    }
  });
}

/**
 * Safely reads and parses request body as JSON while strictly enforcing byte limits.
 */
export async function readJsonWithLimit(request, maxBytes) {
  // 1. Check Content-Length header if present
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      const err = new Error(`Content-Length ${contentLength} exceeds maximum limit of ${maxBytes} bytes`);
      err.status = 413;
      err.code = "PAYLOAD_TOO_LARGE";
      throw err;
    }
  }

  // 2. Read body chunks while enforcing byte limit
  if (!request.body) {
    const err = new Error("Request body is empty");
    err.status = 400;
    err.code = "INVALID_JSON";
    throw err;
  }

  let totalBytes = 0;
  const chunks = [];

  if (typeof request.body.getReader === "function") {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch (_) {}
          const err = new Error(`Body exceeds maximum limit of ${maxBytes} bytes`);
          err.status = 413;
          err.code = "PAYLOAD_TOO_LARGE";
          throw err;
        }
        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_) {}
    }
  } else if (typeof request.arrayBuffer === "function") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      const err = new Error(`Body exceeds maximum limit of ${maxBytes} bytes`);
      err.status = 413;
      err.code = "PAYLOAD_TOO_LARGE";
      throw err;
    }
    chunks.push(new Uint8Array(buf));
    totalBytes = buf.byteLength;
  }

  if (totalBytes === 0) {
    const err = new Error("Request body is empty");
    err.status = 400;
    err.code = "INVALID_JSON";
    throw err;
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder("utf-8").decode(combined);
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    const err = new Error("Malformed JSON payload");
    err.status = 400;
    err.code = "INVALID_JSON";
    throw err;
  }
}

/**
 * Route handlers
 */

async function handleHealth(request, env) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, 405, {
      Allow: "GET",
      ...NO_CACHE_HEADERS
    });
  }

  if (!verifyClientAuth(request, env)) {
    return jsonResponse({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401, NO_CACHE_HEADERS);
  }

  // Reject missing configuration
  if (
    !env.WEBHOOK_URL ||
    !isValidWebhookUrl(env.WEBHOOK_URL) ||
    !env.WEBHOOK_SECRET ||
    typeof env.WEBHOOK_SECRET !== "string" ||
    env.WEBHOOK_SECRET.trim().length === 0 ||
    !env.PUBLIC_BASE_URL ||
    !isValidPublicBaseUrl(env.PUBLIC_BASE_URL)
  ) {
    return jsonResponse({
      ok: false,
      error: "Relay is not properly configured",
      code: "CONFIG_MISSING"
    }, 500, NO_CACHE_HEADERS);
  }

  // Reject missing D1 database binding or schema
  if (!env.DB || typeof env.DB.prepare !== "function") {
    return jsonResponse({
      ok: false,
      error: "Database binding missing",
      code: "MISSING_DB"
    }, 500, NO_CACHE_HEADERS);
  }

  try {
    await env.DB.prepare("SELECT 1 FROM jobs LIMIT 1").first();
  } catch (_) {
    return jsonResponse({
      ok: false,
      error: "Database schema not initialized",
      code: "SCHEMA_MISSING"
    }, 500, NO_CACHE_HEADERS);
  }

  return jsonResponse({
    ok: true,
    provider: "grok-bot",
    protocolVersion: 1,
    botName: env.BOT_NAME || "Grok Bot",
    capabilities: ["health", "jobs", "callback"]
  }, 200, NO_CACHE_HEADERS);
}

async function handleCreateJob(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, 405, {
      Allow: "POST",
      ...NO_CACHE_HEADERS
    });
  }

  if (!verifyClientAuth(request, env)) {
    return jsonResponse({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401, NO_CACHE_HEADERS);
  }

  let body;
  try {
    body = await readJsonWithLimit(request, MAX_JOB_BODY_BYTES);
  } catch (err) {
    return jsonResponse(
      { error: err.message, code: err.code || "BAD_REQUEST" },
      err.status || 400,
      NO_CACHE_HEADERS
    );
  }

  const { jobId, prompt } = body || {};

  // Validate jobId
  if (typeof jobId !== "string" || !JOB_ID_REGEX.test(jobId.trim())) {
    return jsonResponse(
      { error: "Invalid or missing jobId: must be 1-128 alphanumeric, underscore, dot, colon, or hyphen characters", code: "INVALID_JOB_ID" },
      400,
      NO_CACHE_HEADERS
    );
  }

  // Validate prompt: UTF-8 100,000 bytes max to match client
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return jsonResponse(
      { error: "Invalid or missing prompt: must be non-empty string", code: "INVALID_PROMPT" },
      400,
      NO_CACHE_HEADERS
    );
  }

  const promptBytes = new TextEncoder().encode(prompt).length;
  if (promptBytes > MAX_PROMPT_BYTES) {
    return jsonResponse(
      { error: `Invalid prompt: exceeds maximum limit of ${MAX_PROMPT_BYTES} UTF-8 bytes`, code: "INVALID_PROMPT" },
      400,
      NO_CACHE_HEADERS
    );
  }

  const promptHash = await sha256Hex(prompt);

  // Check if job already exists (idempotency check)
  const existing = await env.DB.prepare(
    "SELECT job_id, prompt_hash, status, result, reason_code, updated_at FROM jobs WHERE job_id = ?"
  ).bind(jobId).first();

  if (existing) {
    if (existing.prompt_hash === promptHash) {
      // Idempotent retry: return existing status without re-dispatching webhook
      return jsonResponse({
        jobId: existing.job_id,
        status: existing.status,
        result: existing.result ?? null,
        reasonCode: existing.reason_code ?? null,
        updatedAt: existing.updated_at
      }, existing.status === "completed" || existing.status === "failed" ? 200 : 202, NO_CACHE_HEADERS);
    } else {
      // Conflict: same jobId with different prompt
      return jsonResponse(
        { error: "Job ID conflict: existing job has different prompt", code: "JOB_ID_CONFLICT" },
        409,
        NO_CACHE_HEADERS
      );
    }
  }

  // Generate one-time callback token
  const tokenBytes = new Uint8Array(24);
  crypto.getRandomValues(tokenBytes);
  const callbackToken = "cbt_" + Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const callbackTokenHash = await sha256Hex(callbackToken);
  const now = Date.now();

  // Insert job with initial status 'dispatching'
  try {
    await env.DB.prepare(
      "INSERT INTO jobs (job_id, prompt_hash, prompt, status, callback_hash, created_at, updated_at) VALUES (?, ?, ?, 'dispatching', ?, ?, ?)"
    ).bind(jobId, promptHash, prompt, callbackTokenHash, now, now).run();
  } catch (insertErr) {
    // Handle concurrent insert race
    const raced = await env.DB.prepare(
      "SELECT job_id, prompt_hash, status, result, reason_code, updated_at FROM jobs WHERE job_id = ?"
    ).bind(jobId).first();
    if (raced) {
      if (raced.prompt_hash === promptHash) {
        return jsonResponse({
          jobId: raced.job_id,
          status: raced.status,
          result: raced.result ?? null,
          reasonCode: raced.reason_code ?? null,
          updatedAt: raced.updated_at
        }, raced.status === "completed" || raced.status === "failed" ? 200 : 202, NO_CACHE_HEADERS);
      } else {
        return jsonResponse(
          { error: "Job ID conflict: existing job has different prompt", code: "JOB_ID_CONFLICT" },
          409,
          NO_CACHE_HEADERS
        );
      }
    }
    throw insertErr;
  }

  // Validate WEBHOOK_URL is HTTPS grok.com /webhook/automation/ endpoint before dispatch
  // and validate PUBLIC_BASE_URL is HTTPS origin
  if (!env.WEBHOOK_URL || !env.WEBHOOK_SECRET || !isValidWebhookUrl(env.WEBHOOK_URL) || !isValidPublicBaseUrl(env.PUBLIC_BASE_URL)) {
    const updateTime = Date.now();
    const reasonCode = (!env.WEBHOOK_URL || !env.WEBHOOK_SECRET || !env.PUBLIC_BASE_URL)
      ? "CONFIG_MISSING_WEBHOOK"
      : (!isValidWebhookUrl(env.WEBHOOK_URL) ? "CONFIG_INVALID_WEBHOOK" : "CONFIG_INVALID_PUBLIC_BASE_URL");
    await env.DB.prepare(
      "UPDATE jobs SET status = 'unknown', reason_code = ?, updated_at = ? WHERE job_id = ? AND status = 'dispatching'"
    ).bind(reasonCode, updateTime, jobId).run();
    return jsonResponse({
      jobId,
      status: "unknown",
      error: "Relay webhook or public base URL is not configured or invalid",
      code: "RELAY_NOT_CONFIGURED"
    }, 202, NO_CACHE_HEADERS);
  }

  // Fixed destination callback URL from validated origin
  const baseUrl = new URL(env.PUBLIC_BASE_URL.trim()).origin;
  const callbackUrl = `${baseUrl}/v1/callback`;

  // Contract: webhook payload must be jobId text callback callbackToken. text is original prompt.
  const webhookPayload = {
    jobId,
    text: prompt,
    callback: callbackUrl,
    callbackToken
  };
  const payloadString = JSON.stringify(webhookPayload);

  // Sign with official standardwebhooks package
  const wh = new Webhook(env.WEBHOOK_SECRET);
  const msgId = `msg_${crypto.randomUUID()}`;
  const dispatchDate = new Date();
  const signature = wh.sign(msgId, dispatchDate, payloadString);

  let dispatchSuccess = false;
  let dispatchReason = null;

  try {
    const resp = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": msgId,
        "webhook-timestamp": Math.floor(dispatchDate.getTime() / 1000).toString(),
        "webhook-signature": signature
      },
      body: payloadString,
      redirect: "manual",
      signal: AbortSignal.timeout(20000)
    });

    // Only 202 is accepted
    if (resp.status === 202) {
      dispatchSuccess = true;
    } else {
      dispatchReason = `HTTP_${resp.status}`;
    }
  } catch (fetchErr) {
    // Network interruption / timeout / redirect error
    dispatchReason = fetchErr?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR";
  }

  const updateTime = Date.now();

  if (dispatchSuccess) {
    // Webhook delivered successfully!
    // Callback race safety: ONLY update if status is still 'dispatching'
    await env.DB.prepare(
      "UPDATE jobs SET status = 'accepted', updated_at = ? WHERE job_id = ? AND status = 'dispatching'"
    ).bind(updateTime, jobId).run();
  } else {
    // Non-202 status, timeout, or network failure: update to 'unknown' (never overwrite completed)
    await env.DB.prepare(
      "UPDATE jobs SET status = 'unknown', reason_code = ?, updated_at = ? WHERE job_id = ? AND status = 'dispatching'"
    ).bind(dispatchReason, updateTime, jobId).run();
  }

  // Fetch current status to report back
  const current = await env.DB.prepare(
    "SELECT status, result, reason_code, updated_at FROM jobs WHERE job_id = ?"
  ).bind(jobId).first();

  return jsonResponse({
    jobId,
    status: current?.status || (dispatchSuccess ? "accepted" : "unknown"),
    result: current?.result ?? null,
    reasonCode: current?.reason_code ?? null,
    updatedAt: current?.updated_at ?? updateTime
  }, 202, NO_CACHE_HEADERS);
}

async function handleGetJob(request, env, jobId) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, 405, {
      Allow: "GET",
      ...NO_CACHE_HEADERS
    });
  }

  if (!verifyClientAuth(request, env)) {
    return jsonResponse({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401, NO_CACHE_HEADERS);
  }

  if (!JOB_ID_REGEX.test(jobId)) {
    return jsonResponse({ error: "Invalid jobId format", code: "INVALID_JOB_ID" }, 400, NO_CACHE_HEADERS);
  }

  const job = await env.DB.prepare(
    "SELECT job_id, status, result, reason_code, updated_at FROM jobs WHERE job_id = ?"
  ).bind(jobId).first();

  if (!job) {
    return jsonResponse({ error: "Job not found", code: "NOT_FOUND" }, 404, NO_CACHE_HEADERS);
  }

  return jsonResponse({
    jobId: job.job_id,
    status: job.status,
    result: job.result ?? null,
    reasonCode: job.reason_code ?? null,
    updatedAt: job.updated_at
  }, 200, NO_CACHE_HEADERS);
}

async function handleCallback(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, 405, {
      Allow: "POST",
      ...NO_CACHE_HEADERS
    });
  }

  let body;
  try {
    body = await readJsonWithLimit(request, MAX_CALLBACK_BODY_BYTES);
  } catch (err) {
    return jsonResponse(
      { error: err.message, code: err.code || "BAD_REQUEST" },
      err.status || 400,
      NO_CACHE_HEADERS
    );
  }

  // Callback still uses jobId token result
  const { jobId, token, result, reasonCode } = body || {};

  // Validate jobId
  if (typeof jobId !== "string" || !JOB_ID_REGEX.test(jobId.trim())) {
    return jsonResponse(
      { error: "Invalid or missing jobId", code: "INVALID_JOB_ID" },
      400,
      NO_CACHE_HEADERS
    );
  }

  // Validate callback token
  if (typeof token !== "string" || token.length < 1 || token.length > 256) {
    return jsonResponse(
      { error: "Invalid or missing token", code: "INVALID_TOKEN" },
      400,
      NO_CACHE_HEADERS
    );
  }

  // Validate result and reasonCode
  const hasResult = result !== undefined;
  const hasReason = reasonCode !== undefined;

  if (!hasResult && !hasReason) {
    return jsonResponse(
      { error: "Callback must provide either result or reasonCode", code: "INVALID_RESULT" },
      400,
      NO_CACHE_HEADERS
    );
  }

  if (hasResult) {
    if (typeof result !== "string") {
      return jsonResponse(
        { error: "Invalid result type: must be a string", code: "INVALID_RESULT" },
        400,
        NO_CACHE_HEADERS
      );
    }
    if (result.trim().length === 0) {
      return jsonResponse(
        { error: "Result cannot be empty", code: "INVALID_RESULT" },
        400,
        NO_CACHE_HEADERS
      );
    }
    if (result.length > MAX_RESULT_CHARS) {
      return jsonResponse(
        { error: `Result exceeds maximum length of ${MAX_RESULT_CHARS} characters`, code: "PAYLOAD_TOO_LARGE" },
        413,
        NO_CACHE_HEADERS
      );
    }
  }

  if (hasReason) {
    if (typeof reasonCode !== "string" || reasonCode.trim().length === 0 || reasonCode.length > 128) {
      return jsonResponse(
        { error: "Invalid reasonCode: must be a non-empty string under 128 characters", code: "INVALID_RESULT" },
        400,
        NO_CACHE_HEADERS
      );
    }
  }

  // Query existing job
  const job = await env.DB.prepare(
    "SELECT job_id, status, callback_hash, result, reason_code FROM jobs WHERE job_id = ?"
  ).bind(jobId).first();

  if (!job) {
    return jsonResponse({ error: "Job not found", code: "NOT_FOUND" }, 404, NO_CACHE_HEADERS);
  }

  // Verify callback token hash with constant-time equality
  const incomingTokenHash = await sha256Hex(token);
  if (!timingSafeEqualStr(incomingTokenHash, job.callback_hash)) {
    return jsonResponse({ error: "Invalid callback token", code: "UNAUTHORIZED" }, 401, NO_CACHE_HEADERS);
  }

  const now = Date.now();

  // Case 1: Result provided (Completion)
  if (hasResult) {
    // If already completed:
    if (job.status === "completed") {
      if (job.result === result) {
        // Idempotent duplicate callback
        return jsonResponse({ ok: true, jobId, status: "completed" }, 200, NO_CACHE_HEADERS);
      } else {
        // Conflict with previous result
        return jsonResponse(
          { error: "Callback conflict: job already completed with different result", code: "CALLBACK_CONFLICT" },
          409,
          NO_CACHE_HEADERS
        );
      }
    }

    // If already marked failed:
    if (job.status === "failed") {
      return jsonResponse(
        { error: "Callback conflict: job already marked as failed", code: "CALLBACK_CONFLICT" },
        409,
        NO_CACHE_HEADERS
      );
    }

    // Transition from dispatching/accepted/unknown to completed
    const updateRes = await env.DB.prepare(
      "UPDATE jobs SET status = 'completed', result = ?, reason_code = NULL, updated_at = ? WHERE job_id = ? AND callback_hash = ? AND status IN ('dispatching', 'accepted', 'unknown')"
    ).bind(result, now, jobId, job.callback_hash).run();

    if (updateRes.meta?.changes === 1) {
      return jsonResponse({ ok: true, jobId, status: "completed" }, 200, NO_CACHE_HEADERS);
    } else {
      // Concurrent update race: re-check
      const fresh = await env.DB.prepare(
        "SELECT status, result FROM jobs WHERE job_id = ?"
      ).bind(jobId).first();
      if (fresh?.status === "completed" && fresh.result === result) {
        return jsonResponse({ ok: true, jobId, status: "completed" }, 200, NO_CACHE_HEADERS);
      }
      return jsonResponse({ error: "Callback conflict", code: "CALLBACK_CONFLICT" }, 409, NO_CACHE_HEADERS);
    }
  }

  // Case 2: ReasonCode provided (Failure)
  if (hasReason) {
    if (job.status === "failed") {
      if (job.reason_code === reasonCode) {
        return jsonResponse({ ok: true, jobId, status: "failed" }, 200, NO_CACHE_HEADERS);
      } else {
        return jsonResponse(
          { error: "Callback conflict: job already failed with different reason", code: "CALLBACK_CONFLICT" },
          409,
          NO_CACHE_HEADERS
        );
      }
    }

    if (job.status === "completed") {
      return jsonResponse(
        { error: "Callback conflict: job is already completed", code: "CALLBACK_CONFLICT" },
        409,
        NO_CACHE_HEADERS
      );
    }

    const updateRes = await env.DB.prepare(
      "UPDATE jobs SET status = 'failed', reason_code = ?, updated_at = ? WHERE job_id = ? AND callback_hash = ? AND status IN ('dispatching', 'accepted', 'unknown')"
    ).bind(reasonCode, now, jobId, job.callback_hash).run();

    if (updateRes.meta?.changes === 1) {
      return jsonResponse({ ok: true, jobId, status: "failed" }, 200, NO_CACHE_HEADERS);
    } else {
      const fresh = await env.DB.prepare(
        "SELECT status, reason_code FROM jobs WHERE job_id = ?"
      ).bind(jobId).first();
      if (fresh?.status === "failed" && fresh.reason_code === reasonCode) {
        return jsonResponse({ ok: true, jobId, status: "failed" }, 200, NO_CACHE_HEADERS);
      }
      return jsonResponse({ error: "Callback conflict", code: "CALLBACK_CONFLICT" }, 409, NO_CACHE_HEADERS);
    }
  }

  return jsonResponse({ error: "Bad request", code: "BAD_REQUEST" }, 400, NO_CACHE_HEADERS);
}

/**
 * Worker Main Fetch Handler
 */
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400"
          }
        });
      }

      // Route: GET /v1/health
      if (pathname === "/" && request.method === "GET") {
        return jsonResponse({service:"XFollower Grok Bot 中转",protocolVersion:1,message:"请在 XFollower 系统设置的 Grok Bot 向导中绑定此地址与连接 Token。生成测试通过后才启用备用通道。"});
      }
      if (pathname === "/v1/health") {
        return await handleHealth(request, env);
      }

      // Route: POST /v1/jobs
      if (pathname === "/v1/jobs") {
        return await handleCreateJob(request, env);
      }

      // Route: GET /v1/jobs/:id
      if (pathname.startsWith("/v1/jobs/")) {
        const jobId = pathname.slice("/v1/jobs/".length);
        if (!jobId || jobId.includes("/")) {
          return jsonResponse({ error: "Not found", code: "NOT_FOUND" }, 404, NO_CACHE_HEADERS);
        }
        return await handleGetJob(request, env, jobId);
      }

      // Route: POST /v1/callback
      if (pathname === "/v1/callback") {
        return await handleCallback(request, env);
      }

      return jsonResponse({ error: "Not found", code: "NOT_FOUND" }, 404, NO_CACHE_HEADERS);
    } catch (unhandledErr) {
      return jsonResponse(
        {
          error: "Internal server error",
          code: "INTERNAL_ERROR"
        },
        500,
        NO_CACHE_HEADERS
      );
    }
  }
};
