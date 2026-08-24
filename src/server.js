import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { classifyNetworkFailure, classifyUpstreamFailure, cooldownDuration } from "./classifier.js";
import { AccountStore } from "./accounts.js";
import { loadConfig } from "./config.js";
import { readRawConfig, redactConfigSecrets, writeValidatedConfig } from "./config-store.js";
import {
  defaultCodexConfigPath,
  defaultCodexStatePath,
  readCodexConfig,
  relayTokenAuthCommand,
  writeCodexModelProvider
} from "./codex-config.js";
import {
  envReferences,
  readEnvFile,
  updateEnvFile
} from "./env.js";
import { errorPayload, RelayError } from "./errors.js";
import { Router } from "./router.js";
import { createRawResponseStore } from "./raw-store.js";
import { createRuntimeState } from "./state.js";
import { MobileJobManager, MobileSessionProcessManager } from "./mobile-control.js";
import {
  callUpstream,
  compatibilityForDeployment,
  createSseSanitizer,
  extractOutputTextFromJson,
  extractOutputTextPartsFromSse,
  extractOutputTextFromSse,
  extractResponseIdFromJson,
  extractResponseIdFromSse,
  extractUsageFromJson,
  extractUsageFromSse,
  readText,
  responseHeaders,
  sanitizeResponsePayload,
  sseHasDoneMarker,
  sseHasTerminalEvent,
  synthesizeResponseCompletedSse,
  synthesizeResponseFailedSse
} from "./upstream.js";
import { renderAdminPage } from "./admin-page.js";
import { renderMobilePage } from "./mobile-page.js";
import { renderStatusPage } from "./status-page.js";

const execFileAsync = promisify(execFile);

function requestId() {
  return crypto.randomUUID();
}

function jsonResponse(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function textResponse(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new RelayError("Request body is too large", {
        code: "request_too_large",
        status: 413
      });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new RelayError(`Request body must be valid JSON: ${error.message}`, {
      code: "invalid_json",
      status: 400
    });
  }
}

function bearerToken(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function authorize(req, expected) {
  return !expected || bearerToken(req) === expected;
}

function uniqueDeployments(config) {
  return Object.values(config.models).flatMap((model) => model.deployments);
}

function deploymentCount(config) {
  return uniqueDeployments(config).length;
}

function replaceConfig(target, nextConfig) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, nextConfig);
}

function publicStatus(config, state, options = {}) {
  const deployments = uniqueDeployments(config);
  return {
    status: deployments.some((deployment) => state.isAvailable(deployment)) ? "ready" : "degraded",
    deployments: state.snapshot(deployments, options),
    recent_calls: state.recentCalls?.(20) ?? [],
    usage: state.usageSummary?.() ?? null
  };
}

function mobileOptionsFromConfig(config) {
  const mobile = config.lan_control ?? {};
  return {
    workspaceRoots: mobile.workspace_roots,
    maxActiveRunsPerUser: mobile.max_active_runs_per_user,
    maxPromptChars: mobile.max_prompt_chars,
    maxEventsPerJob: mobile.max_events_per_job,
    maxJobs: mobile.max_jobs,
    defaultSandbox: mobile.default_sandbox,
    defaultModel: mobile.default_model,
    skipGitRepoCheck: mobile.skip_git_repo_check,
    defaultBackend: mobile.execution_backend,
    appServerApprovalPolicy: mobile.app_server_approval_policy,
    appServerApprovalsReviewer: mobile.app_server_approvals_reviewer,
    codexBin: mobile.codex_bin
  };
}

function profilePayload(kind, account, configPathValue, options = {}) {
  return {
    kind,
    username: account?.username ?? null,
    config_path: configPathValue ?? null,
    can_shutdown: Boolean(options.canShutdown)
  };
}

function adminProfilePayload(context) {
  return profilePayload(context.kind, context.account, context.configPath, { canShutdown: true });
}

function findDeployment(config, deploymentId) {
  for (const [logicalModel, modelConfig] of Object.entries(config.models)) {
    const deployment = modelConfig.deployments.find((item) => item.id === deploymentId);
    if (deployment) {
      return { logicalModel, deployment };
    }
  }
  return null;
}

function credentialConfigured(deployment) {
  const apiKey = String(deployment?.api_key ?? "");
  return Boolean(
    apiKey
    && apiKey !== "missing-user-api-key"
    && !apiKey.startsWith("missing-env:")
    && !apiKey.startsWith("secret:deployment:")
  );
}

function testRequestBody(deployment, input) {
  return JSON.stringify({
    model: deployment.model,
    input: input || "Reply with OK in one short sentence.",
    stream: false
  });
}

function hardTestRequestBody(deployment, input) {
  const prompt = input || [
    "You are running a Codex Relay compatibility hard test.",
    "Use streaming Responses semantics and finish normally.",
    "If tool calling is supported, call hard_test_echo once with message HARD_TEST_OK.",
    "If you cannot call tools, reply with HARD_TEST_NO_TOOL in plain text.",
    "Keep the response short."
  ].join("\n");
  return JSON.stringify({
    model: deployment.model,
    input: prompt,
    stream: true,
    tools: [
      {
        type: "function",
        name: "hard_test_echo",
        description: "Echo a short hard-test message to prove structured tool calls work.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"],
          additionalProperties: false
        }
      }
    ]
  });
}

function deploymentHeaders(deployment) {
  const headers = new Headers({
    "authorization": `Bearer ${deployment.api_key}`,
    "content-type": "application/json",
    "user-agent": "codex-relay/0.1"
  });
  for (const [name, value] of Object.entries(deployment.headers ?? {})) {
    headers.set(name, value);
  }
  return headers;
}

function responseFailedEventDetected(text) {
  return /(?:^|\r?\n)event:\s*response\.(?:failed|incomplete)\s*(?:\r?\n|$)/m.test(text)
    || /"type"\s*:\s*"response\.(?:failed|incomplete)"/.test(text)
    || /"status"\s*:\s*"(?:failed|incomplete)"/.test(text);
}

function toolCallDetected(text) {
  return /"type"\s*:\s*"(?:function_call|custom_tool_call)"/.test(text)
    || /response\.function_call_arguments/.test(text)
    || /"tool_calls"\s*:/.test(text)
    || /<[^>]*tool_calls[^>]*>/i.test(text)
    || /hard_test_echo/.test(text);
}

async function readStreamingBody(response, { signal, maxBytes }) {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: "", chunks: 0, bytes: 0, first_chunk_ms: null };
  }
  const startedAt = Date.now();
  const decoder = new TextDecoder();
  let text = "";
  let chunks = 0;
  let bytes = 0;
  let firstChunkMs = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (firstChunkMs === null) {
      firstChunkMs = Date.now() - startedAt;
    }
    chunks += 1;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new RelayError("Hard test response exceeded the configured size limit", {
        code: "upstream_response_too_large",
        status: 502
      });
    }
    text += decoder.decode(value, { stream: true });
    if (signal?.aborted) {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    }
  }
  text += decoder.decode();
  return { text, chunks, bytes, first_chunk_ms: firstChunkMs };
}

function relayBaseUrl(config) {
  const listenHost = String(config.server.host ?? "127.0.0.1");
  const host = ["0.0.0.0", "::", "[::]"].includes(listenHost)
    ? "127.0.0.1"
    : listenHost;
  return `http://${host}:${config.server.port}/v1`;
}

function isLocalRequest(req) {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function paginationFromUrl(url) {
  return {
    offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
    limit: Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20))
  };
}

function rawResponseDirectory(config, configPath, explicitDirectory = null) {
  if (explicitDirectory) {
    return explicitDirectory;
  }
  if (config.server?.raw_response_dir) {
    return config.server.raw_response_dir;
  }
  if (config.state?.store === "file" && config.state.file_path) {
    return `${path.resolve(config.state.file_path)}.raw`;
  }
  if (configPath) {
    return path.join(path.dirname(path.resolve(configPath)), ".codex-relay-raw");
  }
  return path.join(os.tmpdir(), `codex-relay-raw-${process.pid}`);
}

function validThreadId(value) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(text) ? text : null;
}

function threadIdFromValue(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const key of ["thread_id", "threadId", "conversation_id", "conversationId", "session_id", "sessionId"]) {
    const candidate = validThreadId(value[key]);
    if (candidate) {
      return candidate;
    }
  }
  for (const key of ["metadata", "request_metadata", "client_metadata", "turn_metadata"]) {
    const candidate = threadIdFromValue(value[key]);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function threadIdFromRequest(req, body) {
  const bodyThreadId = threadIdFromValue(body);
  if (bodyThreadId) {
    return bodyThreadId;
  }
  for (const name of [
    "x-codex-thread-id",
    "x-thread-id",
    "x-conversation-id",
    "x-openai-thread-id",
    "x-openai-conversation-id",
    "x-session-id",
    "x-codex-session-id"
  ]) {
    const candidate = validThreadId(req.headers[name]);
    if (candidate) {
      return candidate;
    }
  }
  for (const name of ["x-codex-turn-metadata", "x-codex-metadata"]) {
    const value = req.headers[name];
    if (!value) {
      continue;
    }
    try {
      const candidate = threadIdFromValue(JSON.parse(value));
      if (candidate) {
        return candidate;
      }
    } catch {
      // Ignore non-JSON metadata headers.
    }
  }
  return null;
}

async function rolloutPathForThread(threadId, statePath) {
  if (!threadId || !statePath) {
    return null;
  }
  try {
    const sql = `SELECT rollout_path FROM threads WHERE id='${threadId.replaceAll("'", "''")}' LIMIT 1;`;
    const result = await execFileAsync("sqlite3", [statePath, sql], { maxBuffer: 1024 * 1024 });
    const rolloutPath = result.stdout.trim();
    return rolloutPath || null;
  } catch {
    return null;
  }
}

function timestampMs(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  if (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoTimestamp(value) {
  const milliseconds = timestampMs(value);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

function clippedSessionText(value, limit = 320) {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

async function readCodexThreads(statePath) {
  if (!statePath) {
    return { available: false, threads: [] };
  }
  try {
    const result = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", statePath, "SELECT * FROM threads;"],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    const parsed = JSON.parse(result.stdout.trim() || "[]");
    return { available: true, threads: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { available: false, threads: [] };
  }
}

function sessionCallPayload(call) {
  return {
    result: call.result ?? "success",
    request_id: call.request_id ?? null,
    thread_id: call.thread_id ?? null,
    at: call.at ?? null,
    provider: call.provider ?? null,
    deployment_id: call.deployment_id ?? null,
    requested_model: call.requested_model ?? null,
    logical_model: call.logical_model ?? null,
    upstream_model: call.upstream_model ?? null,
    duration_ms: call.duration_ms ?? null,
    usage: call.usage ?? null,
    response_text: clippedSessionText(call.response_text, 1200),
    error: call.error ?? null,
    raw_response_id: call.raw_response_id ?? null,
    raw_response_available: Boolean(call.raw_response_available),
    rollout_path: call.rollout_path ?? null
  };
}

function sessionFieldText(session) {
  const callFields = (session.recent_calls || []).flatMap((call) => [
    call.request_id,
    call.deployment_id,
    call.provider,
    call.requested_model,
    call.logical_model,
    call.upstream_model,
    call.result
  ]);
  return [
    session.id,
    session.title,
    session.preview,
    session.first_user_message,
    session.cwd,
    session.model_provider,
    session.model,
    session.reasoning_effort,
    session.thread_source,
    session.rollout_path,
    ...callFields
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function roundMetric(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

async function sessionActivityPayload({
  state,
  statePath,
  search = "",
  sort = "recent",
  limit = 20,
  offset = 0,
  windowMinutes = 15
} = {}) {
  const safeWindowMinutes = Math.min(1440, Math.max(1, Number(windowMinutes) || 15));
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const allowedSorts = new Set(["recent", "requests", "rpm", "tokens"]);
  const safeSort = allowedSorts.has(sort) ? sort : "recent";
  const now = Date.now();
  const windowStart = now - safeWindowMinutes * 60 * 1000;
  const threadResult = await readCodexThreads(statePath);
  const sessions = new Map();
  const calls = state?.recentCalls?.(500) ?? [];

  function ensureSession(id, values = {}) {
    if (!id) {
      return null;
    }
    let session = sessions.get(id);
    if (!session) {
      session = {
        id,
        title: "Untitled session",
        preview: "",
        first_user_message: "",
        cwd: "",
        model_provider: "",
        model: "",
        reasoning_effort: "",
        thread_source: "",
        archived: false,
        rollout_path: null,
        last_active_ms: 0,
        calls: [],
        codex_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        estimated_requests: 0,
        estimated_input_tokens: 0,
        estimated_output_tokens: 0,
        estimated_total_tokens: 0
      };
      sessions.set(id, session);
    }
    Object.assign(session, Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")
    ));
    return session;
  }

  for (const thread of threadResult.threads) {
    const id = String(thread.id ?? "").trim();
    if (!id) {
      continue;
    }
    const lastActiveMs = Math.max(
      timestampMs(thread.recency_at_ms),
      timestampMs(thread.updated_at_ms),
      timestampMs(thread.recency_at),
      timestampMs(thread.updated_at),
      timestampMs(thread.created_at)
    );
    ensureSession(id, {
      title: clippedSessionText(thread.title, 180) || clippedSessionText(thread.preview, 180) || "Untitled session",
      preview: clippedSessionText(thread.preview),
      first_user_message: clippedSessionText(thread.first_user_message),
      cwd: clippedSessionText(thread.cwd, 260),
      model_provider: clippedSessionText(thread.model_provider, 80),
      model: clippedSessionText(thread.model, 120),
      reasoning_effort: clippedSessionText(thread.reasoning_effort, 40),
      thread_source: clippedSessionText(thread.thread_source, 80),
      codex_total_tokens: Number(thread.tokens_used) || 0,
      archived: Boolean(Number(thread.archived) || thread.archived === true),
      rollout_path: clippedSessionText(thread.rollout_path, 520) || null,
      last_active_ms: lastActiveMs
    });
  }

  let unlinkedCalls = 0;
  for (const call of calls) {
    const threadId = String(call.thread_id ?? "").trim();
    if (!threadId) {
      unlinkedCalls += 1;
      continue;
    }
    const session = ensureSession(threadId);
    if (session.title === "Untitled session") {
      session.title = "Relay-linked session";
    }
    if (!session.model_provider) {
      session.model_provider = "relay";
    }
    if (!session.rollout_path && call.rollout_path) {
      session.rollout_path = clippedSessionText(call.rollout_path, 520);
    }
    const callAtMs = timestampMs(call.at);
    session.calls.push(call);
    session.last_active_ms = Math.max(session.last_active_ms, callAtMs);
    const usage = call.usage ?? {};
    session.input_tokens += Number(usage.input_tokens) || 0;
    session.output_tokens += Number(usage.output_tokens) || 0;
    session.total_tokens += Number(usage.total_tokens) || 0;
    if (usage.estimated) {
      session.estimated_requests += 1;
      session.estimated_input_tokens += Number(usage.input_tokens) || 0;
      session.estimated_output_tokens += Number(usage.output_tokens) || 0;
      session.estimated_total_tokens += Number(usage.total_tokens) || 0;
    }
    if (!session.rollout_path && call.rollout_path) {
      session.rollout_path = clippedSessionText(call.rollout_path, 520);
    }
    if ((!session.model || session.model === "") && call.upstream_model) {
      session.model = call.upstream_model;
    }
  }

  const normalizedSessions = [...sessions.values()].map((session) => {
    const sortedCalls = [...session.calls].sort((a, b) => timestampMs(b.at) - timestampMs(a.at));
    const recentWindowCalls = sortedCalls.filter((call) => {
      const at = timestampMs(call.at);
      return at >= windowStart && at <= now;
    });
    const requestCount = sortedCalls.length;
    const firstRequestMs = requestCount ? timestampMs(sortedCalls[requestCount - 1].at) : 0;
    const lastRequestMs = requestCount ? timestampMs(sortedCalls[0].at) : 0;
    const observedMinutes = requestCount > 1
      ? Math.max((lastRequestMs - firstRequestMs) / 60000, 1)
      : 0;
    const relayTotalTokens = session.total_tokens;
    const codexTotalTokens = session.codex_total_tokens;
    const totalTokens = Math.max(relayTotalTokens, codexTotalTokens);
    const tokenSource = codexTotalTokens > 0 && relayTotalTokens > 0
      ? "both"
      : codexTotalTokens > 0
        ? "codex_sqlite"
        : relayTotalTokens > 0
          ? "relay_usage"
          : "none";
    return {
      id: session.id,
      title: session.title || "Untitled session",
      preview: session.preview,
      first_user_message: session.first_user_message,
      cwd: session.cwd,
      model_provider: session.model_provider,
      model: session.model,
      reasoning_effort: session.reasoning_effort,
      thread_source: session.thread_source,
      archived: session.archived,
      rollout_path: session.rollout_path,
      last_active_at: isoTimestamp(session.last_active_ms),
      last_request_at: isoTimestamp(lastRequestMs),
      first_request_at: isoTimestamp(firstRequestMs),
      request_count: requestCount,
      requests_last_window: recentWindowCalls.length,
      window_minutes: safeWindowMinutes,
      rpm: roundMetric(recentWindowCalls.length / safeWindowMinutes),
      observed_minutes: roundMetric(observedMinutes),
      observed_rpm: observedMinutes ? roundMetric(requestCount / observedMinutes) : 0,
      input_tokens: session.input_tokens,
      output_tokens: session.output_tokens,
      total_tokens: totalTokens,
      relay_total_tokens: relayTotalTokens,
      codex_total_tokens: codexTotalTokens,
      token_source: tokenSource,
      estimated: session.estimated_requests > 0,
      estimated_requests: session.estimated_requests,
      estimated_input_tokens: session.estimated_input_tokens,
      estimated_output_tokens: session.estimated_output_tokens,
      estimated_total_tokens: session.estimated_total_tokens,
      recent_calls: sortedCalls.slice(0, 8).map(sessionCallPayload)
    };
  });

  const keywords = String(search ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const activeOrTokenizedSessions = normalizedSessions.filter((session) =>
    session.request_count > 0 || session.total_tokens > 0
  );
  const filteredSessions = activeOrTokenizedSessions.filter((session) => {
    const text = sessionFieldText(session);
    return keywords.every((keyword) => text.includes(keyword));
  });
  const sortValue = (session) => {
    if (safeSort === "requests") return session.request_count;
    if (safeSort === "rpm") return session.rpm;
    if (safeSort === "tokens") return session.total_tokens;
    return session.last_active_at ? timestampMs(session.last_active_at) : 0;
  };
  filteredSessions.sort((a, b) => sortValue(b) - sortValue(a) || timestampMs(b.last_active_at) - timestampMs(a.last_active_at));

  const total = filteredSessions.length;
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const page = Math.min(Math.floor(safeOffset / safeLimit), totalPages - 1);
  const effectiveOffset = page * safeLimit;
  const pageSessions = filteredSessions.slice(effectiveOffset, effectiveOffset + safeLimit);
  const linkedCalls = filteredSessions.reduce((sum, session) => sum + session.request_count, 0);
  const requestsLastWindow = filteredSessions.reduce((sum, session) => sum + session.requests_last_window, 0);
  return {
    offset: effectiveOffset,
    limit: safeLimit,
    page,
    total_pages: totalPages,
    total,
    search: String(search ?? "").trim(),
    sort: safeSort,
    window_minutes: safeWindowMinutes,
    generated_at: new Date(now).toISOString(),
    sqlite_available: threadResult.available,
    session_count: pageSessions.length,
    active_sessions: filteredSessions.filter((session) => session.requests_last_window > 0).length,
    linked_calls: linkedCalls,
    unlinked_calls: unlinkedCalls,
    requests_last_window: requestsLastWindow,
    aggregate_rpm: roundMetric(requestsLastWindow / safeWindowMinutes),
    sessions: pageSessions
  };
}

async function captureRawResponse(rawStore, logger, {
  requestIdValue,
  storageId = requestIdValue,
  bodyText,
  contentType,
  stream
}) {
  if (!rawStore) {
    return null;
  }
  try {
    return await rawStore.save({
      requestId: requestIdValue,
      storageId,
      bodyText,
      contentType,
      stream
    });
  } catch (error) {
    logger("warn", "raw_response_capture_failed", {
      request_id: requestIdValue,
      message: error.message
    });
    return null;
  }
}

function codexModelMetadata(slug, priority = 10) {
  return {
    id: slug,
    slug,
    name: slug,
    display_name: slug,
    description: "Configured through Codex Relay.",
    base_instructions:
      "You are Codex, a coding agent. Follow the user's instructions and keep responses concise.",
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth" },
      { effort: "high", description: "Greater reasoning depth" },
      { effort: "xhigh", description: "Extra reasoning depth" }
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    model_messages: {
      instructions_template:
        "You are Codex, a coding agent. Follow the user's instructions and keep responses concise.",
      instructions_variables: null,
      approvals: null,
      collaboration_modes: null,
      auto_review: null,
      permissions: null,
      token_budget: null
    },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272000,
    max_context_window: 272000,
    comp_hash: "relay",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: true,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    object: "model",
    created: 0,
    owned_by: "codex-relay"
  };
}

function log(level, event, data = {}) {
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    level,
    event,
    ...data
  }));
}

function clientDisconnectedError() {
  return new RelayError("Client disconnected before the upstream response completed", {
    code: "client_disconnected",
    status: 499
  });
}

function forwardResponse(res, upstream, bodyTextValue, requestIdValue, compatibility = {}, requestBody = null) {
  let payload = bodyTextValue;
  try {
    payload = sanitizeResponsePayload(JSON.parse(bodyTextValue), compatibility, requestIdValue, requestBody);
  } catch {
    // Preserve non-JSON upstream bodies.
  }
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(upstream.status, {
    ...responseHeaders(upstream),
    "content-length": Buffer.byteLength(body),
    "x-relay-request-id": requestIdValue
  });
  res.end(body);
}

function nearRequestTimeout(elapsedMs, timeoutMs) {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return false;
  }
  const graceMs = Math.min(1000, Math.max(50, timeoutMs * 0.1));
  return elapsedMs >= timeoutMs - graceMs;
}

function timeoutLikeStreamError(error, elapsedMs, timeoutMs) {
  if (error?.name === "AbortError") {
    return true;
  }
  const text = `${error?.name ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return nearRequestTimeout(elapsedMs, timeoutMs)
    && /abort|timeout|terminated|closed|econnreset/.test(text);
}

function classifyStreamFailureAfterCommit(error, elapsedMs, timeoutMs) {
  if (timeoutLikeStreamError(error, elapsedMs, timeoutMs)) {
    const timeoutError = new Error(
      `Upstream stream timed out after ${elapsedMs}ms before a terminal Responses event.`
    );
    timeoutError.name = "AbortError";
    return classifyNetworkFailure(timeoutError);
  }
  return classifyNetworkFailure(error);
}

function requestTextFromBody(body) {
  if (typeof body?.input === "string") {
    return body.input;
  }
  if (Array.isArray(body?.input)) {
    return body.input
      .map((item) => typeof item === "string" ? item : JSON.stringify(item))
      .join("\n");
  }
  if (typeof body?.prompt === "string") {
    return body.prompt;
  }
  if (Array.isArray(body?.messages)) {
    return body.messages
      .map((item) => item?.content ?? item?.text ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function relayResponses({
  req,
  res,
  config,
  state,
  router,
  body,
  requestIdValue,
  logger,
  rawStore,
  threadId = null,
  rolloutPath = null
}) {
  const requestedModel = body.model;
  if (typeof requestedModel !== "string" || !requestedModel) {
    throw new RelayError("The request must include a model", {
      code: "model_required",
      status: 400
    });
  }
  const resolved = router.model(requestedModel);
  if (!resolved) {
    throw new RelayError(
      `Unknown model "${requestedModel}". Check /v1/models or add it to the config.`,
      { code: "model_not_configured", status: 404 }
    );
  }

  const stream = body.stream === true;
  const attempted = new Set();
  const attempts = [];
  const startedAt = Date.now();
  let providerNames = new Set();
  let lastFailure = null;

  for (let attemptNumber = 0; attemptNumber < config.routing.max_attempts; attemptNumber += 1) {
    const { candidates } = router.candidates({
      requestedModel,
      previousResponseId: body.previous_response_id,
      attempted
    });
    const deployment = candidates[0];
    if (!deployment) {
      break;
    }
    attempted.add(deployment.id);
    const attemptStartedAt = Date.now();
    const attemptInfo = {
      number: attemptNumber + 1,
      deployment: deployment.id,
      provider: deployment.provider
    };
    attempts.push(attemptInfo);
    if (!credentialConfigured(deployment)) {
      const classification = {
        kind: "credential_missing",
        retryable: true,
        rotateKey: true,
        cooldown: null,
        status: 400,
        code: "credential_not_configured",
        message: `Deployment "${deployment.id}" does not have a configured API key`
      };
      lastFailure = classification;
      attemptInfo.result = classification.kind;
      state.recordFailure(deployment, classification, 0, {
        log_call: true,
        request_id: requestIdValue,
        requested_model: requestedModel,
        logical_model: resolved.name,
        upstream_model: deployment.model,
        response_text: classification.message,
        duration_ms: 0,
        thread_id: threadId,
        rollout_path: rolloutPath
      });
      continue;
    }
    if (!providerNames.has(deployment.provider)) {
      if (providerNames.size >= 1 && providerNames.size > config.routing.max_provider_fallbacks) {
        break;
      }
      providerNames = new Set(providerNames).add(deployment.provider);
    }
    state.recordAttempt(deployment);
    const upstreamModel = deployment.model;
    const compatibility = compatibilityForDeployment(config, deployment);

    let upstreamCall = null;
    try {
      upstreamCall = await callUpstream({
        request: req,
        response: res,
        body,
        deployment,
        compatibility,
        stream,
        timeoutMs: config.server.request_timeout_ms
      });
      const upstream = upstreamCall.response;

      try {
        if (!upstream.ok) {
          const errorBody = await readText(upstream, config.server.max_body_bytes);
          const classification = classifyUpstreamFailure({
            status: upstream.status,
            body: errorBody,
            headers: upstream.headers,
            rules: config.routing.provider_error_rules?.[deployment.provider]
          });
          const duration = cooldownDuration(classification, config.routing);
          state.recordFailure(deployment, classification, duration, {
            log_call: true,
            request_id: requestIdValue,
            requested_model: requestedModel,
            logical_model: resolved.name,
            upstream_model: upstreamModel,
            response_text: errorBody,
            duration_ms: Date.now() - attemptStartedAt,
            thread_id: threadId,
            rollout_path: rolloutPath
          });
          lastFailure = classification;
          attemptInfo.result = classification.kind;
          attemptInfo.status = upstream.status;
          logger("warn", "upstream_failure", {
            request_id: requestIdValue,
            deployment: deployment.id,
            provider: deployment.provider,
            status: upstream.status,
            kind: classification.kind
          });
          if (!classification.retryable) {
            forwardResponse(res, upstream, errorBody, requestIdValue, compatibility, body);
            return;
          }
          continue;
        }

        if (!stream) {
          const responseBody = await readText(upstream, config.server.max_body_bytes);
          attemptInfo.result = "success";
          let parsed = null;
          let telemetryPayload = null;
          try {
            parsed = JSON.parse(responseBody);
            telemetryPayload = sanitizeResponsePayload(parsed, compatibility, requestIdValue, body);
            state.setAffinity(
              extractResponseIdFromJson(telemetryPayload),
              deployment.id,
              config.routing.affinity_ttl_ms ?? 86400000
            );
          } catch {
            // A successful non-JSON response is still forwarded as-is.
          }
          const rawCapture = await captureRawResponse(rawStore, logger, {
            requestIdValue,
            storageId: requestIdValue + "-attempt-" + (attemptNumber + 1),
            bodyText: responseBody,
            contentType: upstream.headers.get("content-type") || "",
            stream: false
          });
          state.recordSuccess(deployment, {
            request_id: requestIdValue,
            requested_model: requestedModel,
            logical_model: resolved.name,
            upstream_model: upstreamModel,
            request_text: requestTextFromBody(body),
            usage: extractUsageFromJson(telemetryPayload),
            response_text: extractOutputTextFromJson(telemetryPayload),
            duration_ms: Date.now() - attemptStartedAt,
            thread_id: threadId,
            rollout_path: rolloutPath,
            raw_response_id: rawCapture?.id,
            raw_response_path: rawCapture?.path,
            raw_response_bytes: rawCapture?.bytes
          });
          logger("info", "upstream_success", {
            request_id: requestIdValue,
            deployment: deployment.id,
            provider: deployment.provider,
            model: upstreamModel,
            duration_ms: Date.now() - attemptStartedAt
          });
          forwardResponse(res, upstream, responseBody, requestIdValue, compatibility, body);
          return;
        }

        const reader = upstream.body?.getReader();
        if (!reader) {
          throw new RelayError("Upstream returned an empty stream", {
            code: "empty_upstream_stream",
            status: 502
          });
        }
        let committed = false;
        let firstChunk = "";
        let streamTail = "";
        let rawStreamText = "";
        let streamOutputText = "";
        let streamOutputItemText = "";
        let streamOutputCompletedText = "";
        const appendStreamOutputText = (chunk) => {
          const parts = extractOutputTextPartsFromSse(chunk);
          if (parts.deltaText) {
            streamOutputText += parts.deltaText;
          }
          if (parts.itemText) {
            streamOutputItemText += parts.itemText;
          }
          if (parts.completedText) {
            streamOutputCompletedText = parts.completedText;
          }
        };
        let hasTerminalEvent = false;
        let hasDoneMarker = false;
        const sseSanitizer = createSseSanitizer(compatibility, requestIdValue, body);
        while (!committed) {
          const { done, value } = await reader.read();
          if (done) {
            const chunk = sseSanitizer.flush();
            if (chunk) {
              firstChunk += chunk;
              streamTail = `${streamTail}${chunk}`.slice(-8192);
              appendStreamOutputText(chunk);
              hasTerminalEvent ||= sseHasTerminalEvent(chunk) || sseHasTerminalEvent(streamTail);
              hasDoneMarker ||= sseHasDoneMarker(chunk) || sseHasDoneMarker(streamTail);
              if (chunk.trim()) {
                committed = true;
                state.setAffinity(
                  extractResponseIdFromSse(firstChunk),
                  deployment.id,
                  config.routing.affinity_ttl_ms ?? 86400000
                );
                res.writeHead(upstream.status, {
                  ...responseHeaders(upstream),
                  "x-relay-request-id": requestIdValue
                });
                res.write(firstChunk);
              }
            }
            break;
          }
          const rawChunk = Buffer.from(value).toString("utf8");
          rawStreamText += rawChunk;
          const chunk = sseSanitizer.push(rawChunk);
          if (chunk) {
            firstChunk += chunk;
            streamTail = `${streamTail}${chunk}`.slice(-8192);
            appendStreamOutputText(chunk);
            hasTerminalEvent ||= sseHasTerminalEvent(chunk) || sseHasTerminalEvent(streamTail);
            hasDoneMarker ||= sseHasDoneMarker(chunk) || sseHasDoneMarker(streamTail);
          }
          if (chunk.trim()) {
            committed = true;
            state.setAffinity(
              extractResponseIdFromSse(firstChunk),
              deployment.id,
              config.routing.affinity_ttl_ms ?? 86400000
            );
            res.writeHead(upstream.status, {
              ...responseHeaders(upstream),
              "x-relay-request-id": requestIdValue
            });
            res.write(firstChunk);
            break;
          }
        }
        if (!committed) {
          if (req.aborted) {
            throw clientDisconnectedError();
          }
          await reader.cancel();
          const classification = classifyNetworkFailure(
            new Error("upstream_stream_closed_before_first_event")
          );
          const rawCapture = await captureRawResponse(rawStore, logger, {
            requestIdValue,
            storageId: requestIdValue + "-attempt-" + (attemptNumber + 1),
            bodyText: rawStreamText,
            contentType: upstream.headers.get("content-type") || "text/event-stream",
            stream: true
          });
          state.recordFailure(
            deployment,
            classification,
            cooldownDuration(classification, config.routing),
            {
              log_call: true,
              request_id: requestIdValue,
              requested_model: requestedModel,
              logical_model: resolved.name,
              upstream_model: upstreamModel,
              response_text: "upstream_stream_closed_before_first_event",
              duration_ms: Date.now() - attemptStartedAt,
              thread_id: threadId,
              rollout_path: rolloutPath,
              raw_response_id: rawCapture?.id,
              raw_response_path: rawCapture?.path,
              raw_response_bytes: rawCapture?.bytes
            }
          );
          lastFailure = classification;
          attemptInfo.result = "stream_interrupted_before_commit";
          continue;
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const rawChunk = Buffer.from(value).toString("utf8");
            rawStreamText += rawChunk;
            const chunk = sseSanitizer.push(rawChunk);
            if (!chunk) {
              continue;
            }
            streamTail = `${streamTail}${chunk}`.slice(-8192);
            appendStreamOutputText(chunk);
            hasTerminalEvent ||= sseHasTerminalEvent(chunk) || sseHasTerminalEvent(streamTail);
            hasDoneMarker ||= sseHasDoneMarker(chunk) || sseHasDoneMarker(streamTail);
            res.write(chunk);
          }
          const finalChunk = sseSanitizer.flush();
          if (finalChunk) {
            streamTail = `${streamTail}${finalChunk}`.slice(-8192);
            appendStreamOutputText(finalChunk);
            hasTerminalEvent ||= sseHasTerminalEvent(finalChunk) || sseHasTerminalEvent(streamTail);
            hasDoneMarker ||= sseHasDoneMarker(finalChunk) || sseHasDoneMarker(streamTail);
            res.write(finalChunk);
          }
          const missingTerminalEvent = !hasTerminalEvent;
          const telemetryStreamTail = streamTail;
          if (missingTerminalEvent && hasDoneMarker) {
            const syntheticCompleted = synthesizeResponseCompletedSse({
              responseId: extractResponseIdFromSse(streamTail) ?? extractResponseIdFromSse(firstChunk),
              requestId: requestIdValue,
              outputText: streamOutputText || extractOutputTextFromSse(streamTail),
              usage: extractUsageFromSse(streamTail)
            });
            streamTail = `${streamTail}${syntheticCompleted}`.slice(-8192);
            hasTerminalEvent = true;
            res.write(syntheticCompleted);
          }
          if (missingTerminalEvent && !hasDoneMarker) {
            const elapsedMs = Date.now() - attemptStartedAt;
            const classification = classifyStreamFailureAfterCommit(
              new Error("upstream_stream_closed_after_commit"),
              elapsedMs,
              config.server.request_timeout_ms
            );
            const failedMessage = classification.code === "upstream_timeout"
              ? `Upstream stream timed out after ${elapsedMs}ms before a terminal Responses event.`
              : "Upstream stream closed before a terminal Responses event.";
            const syntheticFailed = synthesizeResponseFailedSse({
              responseId: extractResponseIdFromSse(streamTail) ?? extractResponseIdFromSse(firstChunk),
              requestId: requestIdValue,
              message: failedMessage,
              code: classification.code
            });
            streamTail = `${streamTail}${syntheticFailed}`.slice(-8192);
            hasTerminalEvent = true;
            res.write(syntheticFailed);
            attemptInfo.result = "stream_interrupted_after_commit";
            const rawCapture = await captureRawResponse(rawStore, logger, {
              requestIdValue,
              storageId: requestIdValue + "-attempt-" + (attemptNumber + 1),
              bodyText: rawStreamText,
              contentType: upstream.headers.get("content-type") || "text/event-stream",
              stream: true
            });
            state.recordFailure(
              deployment,
              classification,
              cooldownDuration(classification, config.routing),
              {
                log_call: true,
                request_id: requestIdValue,
                requested_model: requestedModel,
                logical_model: resolved.name,
                upstream_model: upstreamModel,
                response_text: failedMessage,
                duration_ms: Date.now() - attemptStartedAt,
                thread_id: threadId,
                rollout_path: rolloutPath,
                raw_response_id: rawCapture?.id,
                raw_response_path: rawCapture?.path,
                raw_response_bytes: rawCapture?.bytes
              }
            );
            logger("error", "stream_interrupted_after_commit", {
              request_id: requestIdValue,
              deployment: deployment.id,
              provider: deployment.provider,
              code: classification.code,
              duration_ms: Date.now() - attemptStartedAt
            });
            res.end();
            return;
          }
          const rawCapture = await captureRawResponse(rawStore, logger, {
            requestIdValue,
            storageId: requestIdValue + "-attempt-" + (attemptNumber + 1),
            bodyText: rawStreamText,
            contentType: upstream.headers.get("content-type") || "text/event-stream",
            stream: true
          });
          res.end();
          attemptInfo.result = "success";
          state.recordSuccess(deployment, {
            request_id: requestIdValue,
            requested_model: requestedModel,
            logical_model: resolved.name,
            upstream_model: upstreamModel,
            request_text: requestTextFromBody(body),
            usage: extractUsageFromSse(telemetryStreamTail),
            response_text: streamOutputText || streamOutputItemText || streamOutputCompletedText ||
              extractOutputTextFromSse(telemetryStreamTail),
            response_text_is_stream_delta: Boolean(
              streamOutputText || streamOutputItemText || streamOutputCompletedText
            ),
            duration_ms: Date.now() - attemptStartedAt,
            thread_id: threadId,
            rollout_path: rolloutPath,
            raw_response_id: rawCapture?.id,
            raw_response_path: rawCapture?.path,
            raw_response_bytes: rawCapture?.bytes
          });
          logger("info", "upstream_stream_success", {
            request_id: requestIdValue,
            deployment: deployment.id,
            provider: deployment.provider,
            model: upstreamModel,
            duration_ms: Date.now() - attemptStartedAt
          });
        } catch (error) {
          if (req.aborted || upstreamCall.isClientDisconnected()) {
            const responseText = streamOutputText || streamOutputItemText || streamOutputCompletedText ||
              extractOutputTextFromSse(streamTail);
            const rawCapture = await captureRawResponse(rawStore, logger, {
              requestIdValue,
              storageId: requestIdValue + "-attempt-" + (attemptNumber + 1),
              bodyText: rawStreamText,
              contentType: "text/event-stream",
              stream: true
            });
            attemptInfo.result = "success";
            state.recordSuccess(deployment, {
              request_id: requestIdValue,
              requested_model: requestedModel,
              logical_model: resolved.name,
              upstream_model: upstreamModel,
              request_text: requestTextFromBody(body),
              usage: extractUsageFromSse(streamTail),
              response_text: responseText || streamTail ||
                "Client closed the stream after receiving upstream data.",
              response_text_is_stream_delta: Boolean(
                streamOutputText || streamOutputItemText || streamOutputCompletedText
              ),
              duration_ms: Date.now() - attemptStartedAt,
              thread_id: threadId,
              rollout_path: rolloutPath,
              raw_response_id: rawCapture?.id,
              raw_response_path: rawCapture?.path,
              raw_response_bytes: rawCapture?.bytes
            });
            logger("info", "client_disconnected_after_stream_commit", {
              request_id: requestIdValue,
              deployment: deployment.id,
              provider: deployment.provider,
              model: upstreamModel,
              response_text_detected: Boolean(responseText),
              terminal_event_detected: hasTerminalEvent,
              duration_ms: Date.now() - attemptStartedAt
            });
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          const elapsedMs = Date.now() - attemptStartedAt;
          const classification = classifyStreamFailureAfterCommit(
            error,
            elapsedMs,
            config.server.request_timeout_ms
          );
          const failedMessage = classification.code === "upstream_timeout"
            ? `Upstream stream timed out after ${elapsedMs}ms before a terminal Responses event.`
            : error.message;
          if (!hasTerminalEvent && !res.destroyed) {
            const syntheticFailed = synthesizeResponseFailedSse({
              responseId: extractResponseIdFromSse(streamTail) ?? extractResponseIdFromSse(firstChunk),
              requestId: requestIdValue,
              message: failedMessage,
              code: classification.code
            });
            streamTail = `${streamTail}${syntheticFailed}`.slice(-8192);
            hasTerminalEvent = true;
            res.write(syntheticFailed);
          }
          const rawCapture = await captureRawResponse(rawStore, logger, {
            requestIdValue,
            storageId: requestIdValue + "-attempt-" + (attemptNumber + 1),
            bodyText: rawStreamText,
            contentType: "text/event-stream",
            stream: true
          });
          state.recordFailure(
            deployment,
            classification,
            cooldownDuration(classification, config.routing),
            {
              log_call: true,
              request_id: requestIdValue,
              requested_model: requestedModel,
              logical_model: resolved.name,
              upstream_model: upstreamModel,
              response_text: failedMessage,
              duration_ms: Date.now() - attemptStartedAt,
              thread_id: threadId,
              rollout_path: rolloutPath,
              raw_response_id: rawCapture?.id,
              raw_response_path: rawCapture?.path,
              raw_response_bytes: rawCapture?.bytes
            }
          );
          logger("error", "stream_interrupted_after_commit", {
            request_id: requestIdValue,
            deployment: deployment.id,
            provider: deployment.provider,
            code: classification.code,
            duration_ms: Date.now() - attemptStartedAt
          });
          res.end();
        }
        return;
      } finally {
        upstreamCall.cleanup();
      }
    } catch (error) {
      if (req.aborted || upstreamCall?.isClientDisconnected()) {
        throw clientDisconnectedError();
      }
      if (error instanceof RelayError) {
        throw error;
      }
      const classification = error.relayClassification ?? classifyNetworkFailure(error);
      state.recordFailure(
        deployment,
        classification,
        cooldownDuration(classification, config.routing)
      );
      lastFailure = classification;
      attemptInfo.result = classification.kind;
      logger("warn", "upstream_network_failure", {
        request_id: requestIdValue,
        deployment: deployment.id,
        provider: deployment.provider,
        code: classification.code
      });
    }

    if (config.routing.retry_backoff_ms > 0 && attemptNumber < config.routing.max_attempts - 1) {
      const delay = config.routing.retry_backoff_ms * 2 ** attemptNumber;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 5000)));
    }
  }

  if (
    lastFailure?.code === "credential_not_configured"
    && attempts.length > 0
    && attempts.every((attempt) => attempt.result === "credential_missing")
  ) {
    throw new RelayError(lastFailure.message, {
      code: "credential_not_configured",
      status: 400,
      details: { attempts }
    });
  }

  throw new RelayError(
    `All configured upstream deployments failed for "${requestedModel}"`,
    {
      code: "upstream_exhausted",
      status: 502,
      details: {
        attempts,
        last_failure: lastFailure
      }
    }
  );
}

export function createRelayServer(
  config,
  state,
  {
    logger = log,
    configPath = null,
    loadConfigFn = loadConfig,
    envPath = null,
    codexConfigPath = defaultCodexConfigPath(),
    codexStatePath = defaultCodexStatePath(),
    accountStore = new AccountStore(),
    rawResponseDir = null,
    mobileJobManager = null,
    mobileSessionProcessManager = null
  } = {}
) {
  const router = new Router(config, state);
  const rawStore = createRawResponseStore(rawResponseDirectory(config, configPath, rawResponseDir));
  const mobileJobs = mobileJobManager ?? new MobileJobManager(mobileOptionsFromConfig(config));
  const mobileSessionProcesses = mobileSessionProcessManager
    ?? new MobileSessionProcessManager(mobileOptionsFromConfig(config));
  let lastReloadAt = null;
  let reloadPromise = null;

  function guestContext() {
    return {
      kind: "guest",
      config,
      state,
      router,
      account: null,
      configPath,
      envPath,
      reloadable: Boolean(configPath),
      editable: Boolean(configPath)
    };
  }

  async function contextForAccount(account) {
    const userConfig = await loadConfig(account.config_path);
    const userState = createRuntimeState(userConfig);
    return {
      kind: "account",
      config: userConfig,
      state: userState,
      router: new Router(userConfig, userState),
      account,
      configPath: account.config_path,
      envPath: null,
      reloadable: true,
      editable: true
    };
  }

  async function apiContext(req) {
    const token = bearerToken(req);
    if (config.server.public_api_key && token === config.server.public_api_key) {
      return guestContext();
    }
    const account = await accountStore.authenticateToken(token);
    if (account) {
      return contextForAccount(account);
    }
    if (!config.server.public_api_key) {
      return guestContext();
    }
    return null;
  }

  async function adminContext(req) {
    const token = bearerToken(req);
    if (config.server.admin_api_key && token === config.server.admin_api_key) {
      return guestContext();
    }
    const account = await accountStore.authenticateToken(token);
    if (account) {
      return contextForAccount(account);
    }
    if (!config.server.admin_api_key) {
      return guestContext();
    }
    return null;
  }

  async function mobileAccount(req) {
    const account = await accountStore.authenticateToken(bearerToken(req));
    return account || null;
  }

  async function requireMobileAccount(req, requestIdValue) {
    const account = await mobileAccount(req);
    if (!account) {
      throw new RelayError("Account bearer token required", {
        code: "unauthorized",
        status: 401,
        request_id: requestIdValue
      });
    }
    return account;
  }

  function mobileAccountPayload(account) {
    return {
      username: account.username,
      config_path: account.config_path,
      state_path: account.state_path,
      is_default: Boolean(account.is_default)
    };
  }

  function writeSseEvent(res, event) {
    res.write(`id: ${event.sequence}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  async function reload() {
    if (!configPath) {
      throw new RelayError("This server was not started with a reloadable config path", {
        code: "reload_unavailable",
        status: 503
      });
    }
    if (!reloadPromise) {
      reloadPromise = (async () => {
        try {
          const nextConfig = await loadConfigFn(configPath);
          replaceConfig(config, nextConfig);
          mobileJobs.updateOptions(mobileOptionsFromConfig(config));
          mobileSessionProcesses.updateOptions(mobileOptionsFromConfig(config));
          lastReloadAt = new Date().toISOString();
          return {
            reloaded_at: lastReloadAt,
            models: Object.keys(config.models),
            deployments: deploymentCount(config)
          };
        } catch (error) {
          throw new RelayError(`Configuration reload failed: ${error.message}`, {
            code: "config_reload_failed",
            status: error.name === "ConfigError" ? 400 : 500
          });
        } finally {
          reloadPromise = null;
        }
      })();
    }
    return reloadPromise;
  }

  async function configPayload(context = guestContext()) {
    if (!context.configPath) {
      throw new RelayError("This server was not started with an editable config path", {
        code: "config_edit_unavailable",
        status: 503
      });
    }
    const rawConfig = await readRawConfig(context.configPath);
    return {
      profile: adminProfilePayload(context),
      config_path: context.configPath,
      reloaded_at: context.kind === "guest" ? lastReloadAt : null,
      config: redactConfigSecrets(rawConfig),
      status: publicStatus(context.config, context.state, { includeEndpoint: true }),
      env: await envPayload(rawConfig, context),
      codex: await readCodexConfig(codexConfigPath),
      scope: await scopePayload()
    };
  }

  async function scopePayload() {
    const data = await accountStore.read();
    return {
      global: {
        kind: data.default_username ? "account" : "guest",
        username: data.default_username ?? null
      },
      sessions: await accountStore.listSessions()
    };
  }

  async function applyScope(context, value = {}) {
    const { mode, sessionId } = validateScope(value);
    if (mode === "global") {
      if (context.account) {
        await accountStore.setDefault(context.account.username);
      } else {
        await accountStore.clearDefault();
      }
    } else if (context.account) {
      await accountStore.setSessionKey(context.account, sessionId);
    } else {
      await accountStore.setGuestSession(sessionId);
    }
    const data = await accountStore.read();
    return {
      mode,
      session_id: mode === "terminal" ? sessionId : null,
      kind: context.account ? "account" : "guest",
      username: context.account?.username ?? null,
      global: {
        kind: data.default_username ? "account" : "guest",
        username: data.default_username ?? null
      },
      sessions: await accountStore.listSessions()
    };
  }

  function validateScope(value = {}) {
    const mode = String(value.mode ?? value.scope ?? "global").trim().toLowerCase();
    if (!["global", "terminal"].includes(mode)) {
      throw new RelayError('Scope must be either "global" or "terminal"', {
        code: "invalid_scope",
        status: 400
      });
    }
    const sessionId = String(value.session_id ?? "").trim();
    if (mode === "terminal" && !sessionId) {
      throw new RelayError("A terminal session ID is required for Terminal scope", {
        code: "session_id_required",
        status: 400
      });
    }
    return { mode, sessionId };
  }

  async function envPayload(rawConfig = null, context = guestContext()) {
    const sourceConfig = rawConfig ?? (context.configPath ? await readRawConfig(context.configPath) : context.config);
    const activeEnvPath = context.kind === "guest" ? context.envPath : null;
    const fileValues = activeEnvPath ? await readEnvFile(activeEnvPath) : {};
    const names = new Set([
      ...(context.kind === "guest" ? ["RELAY_API_KEY", "RELAY_ADMIN_KEY"] : []),
      ...envReferences(sourceConfig),
      ...Object.keys(fileValues)
    ]);
    return {
      env_path: activeEnvPath,
      keys: [...names].sort().map((name) => {
        const inFile = Object.prototype.hasOwnProperty.call(fileValues, name);
        const inProcess = process.env[name] !== undefined;
        return {
          name,
          configured: Boolean(fileValues[name] || process.env[name]),
          source: inFile ? "file" : inProcess ? "shell" : "missing",
          internal: name === "RELAY_API_KEY" || name === "RELAY_ADMIN_KEY"
        };
      })
    };
  }

  async function saveConfig(nextConfig, context = guestContext()) {
    if (!context.configPath) {
      throw new RelayError("This server was not started with an editable config path", {
        code: "config_edit_unavailable",
        status: 503
      });
    }
    try {
      const result = await writeValidatedConfig(context.configPath, nextConfig, loadConfigFn);
      if (context.kind === "guest") {
        replaceConfig(config, result.config);
        mobileJobs.updateOptions(mobileOptionsFromConfig(config));
        mobileSessionProcesses.updateOptions(mobileOptionsFromConfig(config));
        lastReloadAt = new Date().toISOString();
      } else {
        context.config = result.config;
        context.state = createRuntimeState(result.config);
        context.router = new Router(result.config, context.state);
      }
      return {
        profile: adminProfilePayload(context),
        save_status: "saved",
        reloaded_at: context.kind === "guest" ? lastReloadAt : new Date().toISOString(),
        config_path: context.configPath,
        config: redactConfigSecrets(result.raw),
        env: await envPayload(result.raw, context),
        runtime: {
          models: Object.keys(result.config.models),
          deployments: deploymentCount(result.config)
        },
        status: publicStatus(result.config, context.state, { includeEndpoint: true }),
        codex: await readCodexConfig(codexConfigPath)
      };
    } catch (error) {
      throw new RelayError(`Configuration save failed: ${error.message}`, {
        code: "config_save_failed",
        status: error.name === "ConfigError" ? 400 : 500
      });
    }
  }

  async function reloadContext(context) {
    if (context.kind === "guest") {
      return reload();
    }
    const nextConfig = await loadConfigFn(context.configPath);
    return {
      reloaded_at: new Date().toISOString(),
      models: Object.keys(nextConfig.models),
      deployments: deploymentCount(nextConfig)
    };
  }

  async function hardTestDeployment(body, requestIdValue, context = { config, state }) {
    const activeConfig = context.config;
    const activeState = context.state;
    const found = findDeployment(activeConfig, body.deployment_id);
    if (!found) {
      throw new RelayError(`Unknown deployment "${body.deployment_id}"`, {
        code: "deployment_not_found",
        status: 404
      });
    }
    const { deployment, logicalModel } = found;
    if (!credentialConfigured(deployment)) {
      throw new RelayError(`Deployment "${deployment.id}" does not have a configured API key`, {
        code: "credential_not_configured",
        status: 400
      });
    }

    activeState.recordAttempt(deployment);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutMs = Number(body.timeout_ms) > 0
      ? Math.min(Number(body.timeout_ms), activeConfig.server.request_timeout_ms)
      : activeConfig.server.request_timeout_ms;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upstream = null;
    let streamText = "";
    try {
      upstream = await fetch(`${deployment.base_url.replace(/\/+$/, "")}/responses`, {
        method: "POST",
        headers: deploymentHeaders(deployment),
        body: hardTestRequestBody(deployment, body.input),
        signal: controller.signal
      });
      const contentType = upstream.headers.get("content-type") || "";
      const readResult = await readStreamingBody(upstream, {
        signal: controller.signal,
        maxBytes: activeConfig.server.max_body_bytes
      });
      streamText = readResult.text;
      const rawCapture = await captureRawResponse(rawStore, logger, {
        requestIdValue,
        bodyText: streamText,
        contentType,
        stream: true
      });
      const durationMs = Date.now() - startedAt;
      const terminalDetected = sseHasTerminalEvent(streamText) || sseHasDoneMarker(streamText);
      const failedDetected = responseFailedEventDetected(streamText);
      const toolDetected = toolCallDetected(streamText);
      const outputText = extractOutputTextFromSse(streamText) || streamText;
      const usage = extractUsageFromSse(streamText);
      const diagnostics = {
        mode: "hard",
        stream: true,
        terminal_detected: terminalDetected,
        failed_event_detected: failedDetected,
        done_marker_detected: sseHasDoneMarker(streamText),
        tool_call_detected: toolDetected,
        first_chunk_ms: readResult.first_chunk_ms,
        chunks: readResult.chunks,
        bytes: readResult.bytes,
        content_type: contentType,
        timeout_ms: timeoutMs
      };

      if (!upstream.ok) {
        const classification = classifyUpstreamFailure({
          status: upstream.status,
          body: streamText,
          headers: upstream.headers,
          rules: activeConfig.routing.provider_error_rules?.[deployment.provider]
        });
        activeState.recordFailure(deployment, classification, cooldownDuration(classification, activeConfig.routing), {
          log_call: true,
          request_id: requestIdValue,
          requested_model: deployment.model,
          logical_model: logicalModel,
          upstream_model: deployment.model,
          response_text: streamText,
          duration_ms: durationMs,
          raw_response_id: rawCapture?.id,
          raw_response_path: rawCapture?.path,
          raw_response_bytes: rawCapture?.bytes
        });
        return {
          ok: false,
          deployment_id: deployment.id,
          provider: deployment.provider,
          model: deployment.model,
          status: upstream.status,
          duration_ms: durationMs,
          usage,
          diagnostics,
          error: classification,
          response_text: streamText.slice(0, 4000)
        };
      }

      if (!terminalDetected || failedDetected) {
        const classification = {
          kind: "upstream_transient",
          retryable: true,
          rotateKey: false,
          cooldown: "transient",
          status: 502,
          code: failedDetected ? "hard_test_response_failed" : "hard_test_missing_terminal_event",
          message: failedDetected
            ? "Hard test stream returned response.failed or response.incomplete."
            : "Hard test stream ended without response.completed, response.failed, response.incomplete, or [DONE]."
        };
        activeState.recordFailure(deployment, classification, cooldownDuration(classification, activeConfig.routing), {
          log_call: true,
          request_id: requestIdValue,
          requested_model: deployment.model,
          logical_model: logicalModel,
          upstream_model: deployment.model,
          usage,
          response_text: outputText,
          duration_ms: durationMs,
          raw_response_id: rawCapture?.id,
          raw_response_path: rawCapture?.path,
          raw_response_bytes: rawCapture?.bytes
        });
        return {
          ok: false,
          deployment_id: deployment.id,
          provider: deployment.provider,
          model: deployment.model,
          status: upstream.status,
          duration_ms: durationMs,
          usage,
          diagnostics,
          error: classification,
          response_text: outputText.slice(0, 4000)
        };
      }

      activeState.recordSuccess(deployment, {
        request_id: requestIdValue,
        requested_model: deployment.model,
        logical_model: logicalModel,
        upstream_model: deployment.model,
        request_text: requestTextFromBody({ input: body.input || "Codex Relay hard test" }),
        usage,
        response_text: outputText,
        duration_ms: durationMs,
        raw_response_id: rawCapture?.id,
        raw_response_path: rawCapture?.path,
        raw_response_bytes: rawCapture?.bytes
      });
      return {
        ok: true,
        deployment_id: deployment.id,
        provider: deployment.provider,
        model: deployment.model,
        status: upstream.status,
        duration_ms: durationMs,
        usage,
        diagnostics,
        warnings: toolDetected ? [] : ["No structured tool call was detected; streaming completed, but tool-calling compatibility is not proven."],
        response_text: outputText.slice(0, 4000)
      };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const classification = error instanceof RelayError
        ? {
            kind: "request_or_capability",
            retryable: false,
            rotateKey: false,
            cooldown: null,
            status: error.status,
            code: error.code,
            message: error.message
          }
        : classifyStreamFailureAfterCommit(error, elapsedMs, timeoutMs);
      const failedMessage = classification.code === "upstream_timeout"
        ? `Hard test stream timed out after ${elapsedMs}ms before a terminal Responses event.`
        : error.message;
      activeState.recordFailure(deployment, classification, cooldownDuration(classification, activeConfig.routing), {
        log_call: true,
        request_id: requestIdValue,
        requested_model: deployment.model,
        logical_model: logicalModel,
        upstream_model: deployment.model,
        response_text: failedMessage,
        duration_ms: elapsedMs
      });
      return {
        ok: false,
        deployment_id: deployment.id,
        provider: deployment.provider,
        model: deployment.model,
        duration_ms: elapsedMs,
        diagnostics: {
          mode: "hard",
          stream: true,
          terminal_detected: false,
          failed_event_detected: false,
          done_marker_detected: false,
          tool_call_detected: toolCallDetected(streamText),
          timeout_ms: timeoutMs
        },
        error: classification,
        response_text: failedMessage
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function testDeployment(body, requestIdValue, context = { config, state }) {
    if (body.mode === "hard") {
      return hardTestDeployment(body, requestIdValue, context);
    }
    const activeConfig = context.config;
    const activeState = context.state;
    const found = findDeployment(activeConfig, body.deployment_id);
    if (!found) {
      throw new RelayError(`Unknown deployment "${body.deployment_id}"`, {
        code: "deployment_not_found",
        status: 404
      });
    }
    const { deployment, logicalModel } = found;
    if (!credentialConfigured(deployment)) {
      throw new RelayError(`Deployment "${deployment.id}" does not have a configured API key`, {
        code: "credential_not_configured",
        status: 400
      });
    }
    activeState.recordAttempt(deployment);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutMs = Math.min(activeConfig.server.request_timeout_ms, 30000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upstream = null;
    let bodyText = "";
    try {
      upstream = await fetch(`${deployment.base_url.replace(/\/+$/, "")}/responses`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${deployment.api_key}`,
          "content-type": "application/json",
          "user-agent": "codex-relay/0.1"
        },
        body: testRequestBody(deployment, body.input),
        signal: controller.signal
      });
      bodyText = await upstream.text();
      let parsed = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // Some upstreams return text for errors; keep it as a preview.
      }
      const rawCapture = await captureRawResponse(rawStore, logger, {
        requestIdValue,
        bodyText,
        contentType: upstream.headers.get("content-type") || "",
        stream: false
      });
      const durationMs = Date.now() - startedAt;
      if (!upstream.ok) {
        const classification = classifyUpstreamFailure({
          status: upstream.status,
          body: bodyText,
          headers: upstream.headers,
          rules: activeConfig.routing.provider_error_rules?.[deployment.provider]
        });
        activeState.recordFailure(
          deployment,
          classification,
          cooldownDuration(classification, activeConfig.routing),
          {
            log_call: true,
            request_id: requestIdValue,
            requested_model: deployment.model,
            logical_model: logicalModel,
            upstream_model: deployment.model,
            response_text: bodyText,
            duration_ms: durationMs,
            raw_response_id: rawCapture?.id,
            raw_response_path: rawCapture?.path,
            raw_response_bytes: rawCapture?.bytes
          }
        );
        return {
          ok: false,
          deployment_id: deployment.id,
          provider: deployment.provider,
          model: deployment.model,
          status: upstream.status,
          duration_ms: durationMs,
          error: classification,
          response_text: bodyText.slice(0, 4000)
        };
      }
      const responseText = extractOutputTextFromJson(parsed) || bodyText;
      const usage = extractUsageFromJson(parsed);
      activeState.recordSuccess(deployment, {
        request_id: requestIdValue,
        requested_model: deployment.model,
        logical_model: logicalModel,
        upstream_model: deployment.model,
        request_text: requestTextFromBody(body),
        usage,
        response_text: responseText,
        duration_ms: durationMs,
        raw_response_id: rawCapture?.id,
        raw_response_path: rawCapture?.path,
        raw_response_bytes: rawCapture?.bytes
      });
      return {
        ok: true,
        deployment_id: deployment.id,
        provider: deployment.provider,
        model: deployment.model,
        status: upstream.status,
        duration_ms: durationMs,
        usage,
        response_text: responseText.slice(0, 4000)
      };
    } catch (error) {
      const classification = classifyNetworkFailure(error);
      const durationMs = Date.now() - startedAt;
      activeState.recordFailure(
        deployment,
        classification,
        cooldownDuration(classification, activeConfig.routing),
        {
          log_call: true,
          request_id: requestIdValue,
          requested_model: deployment.model,
          logical_model: logicalModel,
          upstream_model: deployment.model,
          response_text: error.message,
          duration_ms: durationMs
        }
      );
      return {
        ok: false,
        deployment_id: deployment.id,
        provider: deployment.provider,
        model: deployment.model,
        duration_ms: durationMs,
        error: classification,
        response_text: error.message
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const server = http.createServer(async (req, res) => {
    const id = requestId();
    res.setHeader("x-relay-request-id", id);
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/") {
        const html = renderStatusPage();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html)
        });
        res.end(html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin") {
        const html = renderAdminPage({
          bootstrapAdminToken: isLocalRequest(req) ? config.server.admin_api_key : "",
          canShutdown: isLocalRequest(req)
        });
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html)
        });
        res.end(html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/mobile") {
        const html = renderMobilePage();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html)
        });
        res.end(html);
        return;
      }
      if (req.method === "POST" && url.pathname === "/mobile/login") {
        const body = await readRequestBody(req, config.server.max_body_bytes);
        let record;
        try {
          record = await accountStore.authenticatePassword(body.username, body.password);
        } catch (error) {
          throw new RelayError("Invalid username or password", {
            code: "invalid_credentials",
            status: 401,
            cause: error
          });
        }
        jsonResponse(res, 200, {
          profile: profilePayload("account", record, record.config_path),
          account: mobileAccountPayload(record),
          api_token: record.api_token
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/mobile/logout") {
        const account = await accountStore.authenticateToken(bearerToken(req));
        if (!account) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Account bearer token required", request_id: id }
          });
          return;
        }
        await accountStore.logout(account, process.env, { clearSession: false });
        jsonResponse(res, 200, {
          status: "logged_out",
          profile: profilePayload("guest", null, configPath),
          token_revoked: true
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/mobile/api/me") {
        const account = await requireMobileAccount(req, id);
        jsonResponse(res, 200, {
          profile: profilePayload("account", account, account.config_path),
          account: mobileAccountPayload(account),
          active_jobs: mobileJobs.activeJobsFor(account.username).length,
          active_session_processes: mobileSessionProcesses.activeProcessesFor(account.username).length,
          options: mobileJobs.optionsPayload()
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/mobile/api/status") {
        const account = await requireMobileAccount(req, id);
        const context = await contextForAccount(account);
        jsonResponse(res, 200, {
          profile: profilePayload("account", account, account.config_path),
          account: mobileAccountPayload(account),
          ...publicStatus(context.config, context.state, { includeEndpoint: true }),
          models: Object.keys(context.config.models)
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/mobile/api/sessions") {
        const account = await requireMobileAccount(req, id);
        const context = await contextForAccount(account);
        const pagination = paginationFromUrl(url);
        const sessions = await sessionActivityPayload({
          state: context.state,
          statePath: codexStatePath,
          search: url.searchParams.get("q") ?? "",
          sort: url.searchParams.get("sort") ?? "recent",
          limit: pagination.limit,
          offset: pagination.offset,
          windowMinutes: url.searchParams.get("window") ?? 15
        });
        jsonResponse(res, 200, {
          ...sessions,
          processes: mobileSessionProcesses.listProcesses(account.username)
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/mobile/api/session-processes") {
        const account = await requireMobileAccount(req, id);
        jsonResponse(res, 200, {
          processes: mobileSessionProcesses.listProcesses(account.username)
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/mobile/api/session-processes") {
        const account = await requireMobileAccount(req, id);
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const relaySessionId = `mobile-${account.username}`;
        await accountStore.setSession(account, { RELAY_SESSION_ID: relaySessionId });
        const process = mobileSessionProcesses.startProcess(account.username, {
          ...body,
          relay_session_id: relaySessionId
        });
        jsonResponse(res, 201, process);
        return;
      }
      const mobileSessionCommandMatch = req.method === "POST"
        ? url.pathname.match(/^\/mobile\/api\/session-processes\/([^/]+)\/commands$/)
        : null;
      if (mobileSessionCommandMatch) {
        const account = await requireMobileAccount(req, id);
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const processId = decodeURIComponent(mobileSessionCommandMatch[1]);
        const process = await mobileSessionProcesses.sendCommand(
          account.username,
          processId,
          body.prompt
        );
        jsonResponse(res, 200, process);
        return;
      }
      const mobileSessionInterruptMatch = req.method === "POST"
        ? url.pathname.match(/^\/mobile\/api\/session-processes\/([^/]+)\/interrupt$/)
        : null;
      if (mobileSessionInterruptMatch) {
        const account = await requireMobileAccount(req, id);
        const processId = decodeURIComponent(mobileSessionInterruptMatch[1]);
        jsonResponse(res, 200, mobileSessionProcesses.interruptProcess(account.username, processId));
        return;
      }
      const mobileSessionStopMatch = req.method === "POST"
        ? url.pathname.match(/^\/mobile\/api\/session-processes\/([^/]+)\/stop$/)
        : null;
      if (mobileSessionStopMatch) {
        const account = await requireMobileAccount(req, id);
        const processId = decodeURIComponent(mobileSessionStopMatch[1]);
        jsonResponse(res, 200, mobileSessionProcesses.stopProcess(account.username, processId));
        return;
      }
      const mobileSessionApprovalMatch = req.method === "POST"
        ? url.pathname.match(/^\/mobile\/api\/session-processes\/([^/]+)\/approvals\/([^/]+)$/)
        : null;
      if (mobileSessionApprovalMatch) {
        const account = await requireMobileAccount(req, id);
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const processId = decodeURIComponent(mobileSessionApprovalMatch[1]);
        const approvalId = decodeURIComponent(mobileSessionApprovalMatch[2]);
        const process = mobileSessionProcesses.resolveApproval(
          account.username,
          processId,
          approvalId,
          body.decision
        );
        jsonResponse(res, 200, process);
        return;
      }
      const mobileSessionEventsMatch = req.method === "GET"
        ? url.pathname.match(/^\/mobile\/api\/session-processes\/([^/]+)\/events$/)
        : null;
      if (mobileSessionEventsMatch) {
        const account = await requireMobileAccount(req, id);
        const processId = decodeURIComponent(mobileSessionEventsMatch[1]);
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const process = mobileSessionProcesses.getProcess(account.username, processId);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "x-accel-buffering": "no"
        });
        res.write(`: mobile session process ${process.id}\n\n`);
        for (const event of process.events.filter((item) => item.sequence > after)) {
          writeSseEvent(res, event);
        }
        if (["failed", "stopped"].includes(process.status)) {
          res.end();
          return;
        }
        const unsubscribe = mobileSessionProcesses.subscribe(account.username, processId, (event) => {
          if (res.destroyed) {
            unsubscribe();
            return;
          }
          writeSseEvent(res, event);
          if (["session_stopped", "session_failed"].includes(event.type)) {
            setTimeout(() => {
              unsubscribe();
              if (!res.destroyed) {
                res.end();
              }
            }, 25);
          }
        });
        req.on("close", unsubscribe);
        return;
      }
      const mobileSessionMatch = req.method === "GET"
        ? url.pathname.match(/^\/mobile\/api\/session-processes\/([^/]+)$/)
        : null;
      if (mobileSessionMatch) {
        const account = await requireMobileAccount(req, id);
        const processId = decodeURIComponent(mobileSessionMatch[1]);
        jsonResponse(res, 200, mobileSessionProcesses.processPayload(
          mobileSessionProcesses.getProcess(account.username, processId)
        ));
        return;
      }
      if (req.method === "GET" && url.pathname === "/mobile/api/jobs") {
        const account = await requireMobileAccount(req, id);
        jsonResponse(res, 200, {
          jobs: mobileJobs.listJobs(account.username)
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/mobile/api/jobs") {
        const account = await requireMobileAccount(req, id);
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const relaySessionId = `mobile-${account.username}`;
        await accountStore.setSession(account, { RELAY_SESSION_ID: relaySessionId });
        const job = mobileJobs.startJob(account.username, {
          ...body,
          relay_session_id: relaySessionId
        });
        jsonResponse(res, 201, job);
        return;
      }
      const mobileJobInterruptMatch = req.method === "POST"
        ? url.pathname.match(/^\/mobile\/api\/jobs\/([^/]+)\/interrupt$/)
        : null;
      if (mobileJobInterruptMatch) {
        const account = await requireMobileAccount(req, id);
        const jobId = decodeURIComponent(mobileJobInterruptMatch[1]);
        const job = mobileJobs.interruptJob(account.username, jobId);
        jsonResponse(res, 200, job);
        return;
      }
      const mobileApprovalMatch = req.method === "POST"
        ? url.pathname.match(/^\/mobile\/api\/jobs\/([^/]+)\/approvals\/([^/]+)$/)
        : null;
      if (mobileApprovalMatch) {
        const account = await requireMobileAccount(req, id);
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const jobId = decodeURIComponent(mobileApprovalMatch[1]);
        const approvalId = decodeURIComponent(mobileApprovalMatch[2]);
        const job = mobileJobs.resolveApproval(
          account.username,
          jobId,
          approvalId,
          body.decision
        );
        jsonResponse(res, 200, job);
        return;
      }
      const mobileJobEventsMatch = req.method === "GET"
        ? url.pathname.match(/^\/mobile\/api\/jobs\/([^/]+)\/events$/)
        : null;
      if (mobileJobEventsMatch) {
        const account = await requireMobileAccount(req, id);
        const jobId = decodeURIComponent(mobileJobEventsMatch[1]);
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const job = mobileJobs.getJob(account.username, jobId);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "x-accel-buffering": "no"
        });
        res.write(`: mobile job ${job.id}\n\n`);
        for (const event of job.events.filter((item) => item.sequence > after)) {
          writeSseEvent(res, event);
        }
        if (!["queued", "running", "cancelling"].includes(job.status)) {
          res.end();
          return;
        }
        const unsubscribe = mobileJobs.subscribe(account.username, jobId, (event) => {
          if (res.destroyed) {
            unsubscribe();
            return;
          }
          writeSseEvent(res, event);
          if (["job_completed", "job_failed", "job_cancelled"].includes(event.type)) {
            setTimeout(() => {
              unsubscribe();
              if (!res.destroyed) {
                res.end();
              }
            }, 25);
          }
        });
        req.on("close", unsubscribe);
        return;
      }
      const mobileJobMatch = req.method === "GET"
        ? url.pathname.match(/^\/mobile\/api\/jobs\/([^/]+)$/)
        : null;
      if (mobileJobMatch) {
        const account = await requireMobileAccount(req, id);
        const jobId = decodeURIComponent(mobileJobMatch[1]);
        jsonResponse(res, 200, mobileJobs.jobPayload(
          mobileJobs.getJob(account.username, jobId)
        ));
        return;
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        jsonResponse(res, 200, { status: "ok", request_id: id });
        return;
      }
      if (req.method === "GET" && url.pathname === "/readyz") {
        const status = publicStatus(config, state);
        jsonResponse(res, status.status === "ready" ? 200 : 503, {
          status: status.status,
          request_id: id
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/status/public") {
        jsonResponse(res, 200, publicStatus(config, state));
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/account/register") {
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const account = await accountStore.register(body.username, body.password, config);
        const record = await accountStore.authenticatePassword(body.username, body.password);
        jsonResponse(res, 200, {
          profile: profilePayload("account", record, record.config_path),
          account,
          api_token: record.api_token
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/account/login") {
        const body = await readRequestBody(req, config.server.max_body_bytes);
        let record;
        try {
          record = await accountStore.authenticatePassword(body.username, body.password);
        } catch (error) {
          throw new RelayError("Invalid username or password", {
            code: "invalid_credentials",
            status: 401,
            cause: error
          });
        }
        jsonResponse(res, 200, {
          profile: profilePayload("account", record, record.config_path),
          account: {
            username: record.username,
            created_at: record.created_at,
            last_login_at: record.last_login_at ?? null,
            config_path: record.config_path,
            state_path: record.state_path,
            is_default: Boolean(record.is_default)
          },
          api_token: record.api_token
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/account/logout") {
        const account = await accountStore.authenticateToken(bearerToken(req));
        if (!account) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Account bearer token required", request_id: id }
          });
          return;
        }
        await accountStore.logout(account, process.env, { clearSession: false });
        jsonResponse(res, 200, {
          status: "logged_out",
          profile: profilePayload("guest", null, configPath),
          token_revoked: true
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/account/default") {
        const context = await adminContext(req);
        if (!context?.account) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Account bearer token required", request_id: id }
          });
          return;
        }
        const account = await accountStore.setDefault(context.account.username);
        jsonResponse(res, 200, {
          profile: profilePayload("account", context.account, context.account.config_path),
          account
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/account/delete") {
        const context = await adminContext(req);
        if (!context?.account) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Account bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        await accountStore.delete(context.account.username, body.password);
        jsonResponse(res, 200, {
          status: "deleted",
          profile: profilePayload("guest", null, configPath)
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, {
          profile: adminProfilePayload(context),
          ...publicStatus(context.config, context.state, { includeEndpoint: true }),
          models: Object.keys(context.config.models)
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/config") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, await configPayload(context));
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/scope") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, {
          profile: adminProfilePayload(context),
          scope: await scopePayload()
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/scope") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        jsonResponse(res, 200, {
          status: "applied",
          profile: adminProfilePayload(context),
          scope: await applyScope(context, body)
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/calls") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, context.state.callHistory?.(paginationFromUrl(url)) ?? {
          offset: 0,
          limit: 20,
          total: context.state.recentCalls?.(20).length ?? 0,
          page: 0,
          total_pages: 1,
          calls: context.state.recentCalls?.(20) ?? []
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/sessions") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const pagination = paginationFromUrl(url);
        jsonResponse(res, 200, await sessionActivityPayload({
          state: context.state,
          statePath: codexStatePath,
          search: url.searchParams.get("q") ?? "",
          sort: url.searchParams.get("sort") ?? "recent",
          limit: pagination.limit,
          offset: pagination.offset,
          windowMinutes: url.searchParams.get("window") ?? 15
        }));
        return;
      }
      const rawCallMatch = req.method === "GET"
        ? url.pathname.match(/^\/admin\/calls\/([^/]+)\/raw$/)
        : null;
      if (rawCallMatch) {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const rawResponseId = decodeURIComponent(rawCallMatch[1]);
        const call = context.state.recentCalls?.(500).find((item) =>
          item.raw_response_id === rawResponseId || item.request_id === rawResponseId
        );
        if (!call) {
          jsonResponse(res, 404, {
            error: { type: "call_not_found", message: "Call is not available in this profile", request_id: id }
          });
          return;
        }
        try {
          const raw = await rawStore.load(rawResponseId);
          let parsed = null;
          let isJson = false;
          try {
            parsed = JSON.parse(raw.raw_text);
            isJson = true;
          } catch {
            // Streaming responses are returned as their original SSE text.
          }
          jsonResponse(res, 200, {
            request_id: raw.request_id,
            raw_id: raw.raw_id,
            captured_at: raw.captured_at,
            content_type: raw.content_type,
            stream: raw.stream,
            is_json: isJson,
            json: isJson ? parsed : null,
            raw_text: raw.raw_text
          });
        } catch (error) {
          if (error.code === "ENOENT") {
            jsonResponse(res, 404, {
              error: { type: "raw_response_unavailable", message: "Raw response was not captured for this call", request_id: id }
            });
            return;
          }
          throw error;
        }
        return;
      }
      if (req.method === "PUT" && url.pathname === "/admin/config") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const nextConfig = body.config ?? body;
        if (body.scope) validateScope(body.scope);
        const result = await saveConfig(nextConfig, context);
        if (body.scope) {
          result.scope = await applyScope(context, body.scope);
        }
        jsonResponse(res, 200, result);
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/env") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, await envPayload(null, context));
        return;
      }
      if (req.method === "PUT" && url.pathname === "/admin/env") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        if (context.kind !== "guest" || !envPath) {
          throw new RelayError("This server was not started with an editable env path", {
            code: "env_edit_unavailable",
            status: 503
          });
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const values = body.values ?? {};
        try {
          await updateEnvFile(envPath, values);
          for (const [key, value] of Object.entries(values)) {
            if (typeof value === "string" && value.length > 0) {
              process.env[key] = value;
            }
          }
          const result = await reload();
          jsonResponse(res, 200, {
            status: "saved",
            ...result,
            env: await envPayload(null, context)
          });
        } catch (error) {
          throw new RelayError(`Environment save failed: ${error.message}`, {
            code: "env_save_failed",
            status: 400
          });
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/codex-config") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, {
          codex: await readCodexConfig(codexConfigPath)
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/codex-config") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        try {
          const codex = await writeCodexModelProvider({
            modelProvider: body.model_provider,
            relayBaseUrl: body.relay_base_url || relayBaseUrl(context.config),
            authCommand: body.auth_command === undefined
              ? relayTokenAuthCommand(envPath)
              : body.auth_command,
            envKey: body.env_key || "RELAY_API_KEY",
            configPath: codexConfigPath,
            statePath: codexStatePath
          });
          jsonResponse(res, 200, { codex });
        } catch (error) {
          throw new RelayError(`Codex config update failed: ${error.message}`, {
            code: "codex_config_update_failed",
            status: 400
          });
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/reload") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const result = await reloadContext(context);
        jsonResponse(res, 200, {
          status: "reloaded",
          profile: adminProfilePayload(context),
          ...result
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/shutdown") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 202, { status: "shutting_down", request_id: id });
        setTimeout(() => {
          server.close((error) => {
            if (error) {
              logger("error", "relay_shutdown_failed", {
                request_id: id,
                message: error.message
              });
              return;
            }
            logger("info", "relay_stopped", { request_id: id });
          });
          server.closeIdleConnections?.();
        }, 25);
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/test-deployment") {
        const context = await adminContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const result = await testDeployment(body, id, context);
        jsonResponse(res, 200, {
          request_id: id,
          ...result,
          status: publicStatus(context.config, context.state, { includeEndpoint: true })
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const context = await apiContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Bearer token required", request_id: id }
          });
          return;
        }
        const data = Object.entries(context.config.models).flatMap(([name, model], index) => [
          codexModelMetadata(name, index + 1),
          ...model.aliases.map((alias) => codexModelMetadata(alias, index + 1))
        ]);
        jsonResponse(res, 200, { object: "list", data, models: data });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const context = await apiContext(req);
        if (!context) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, context.config.server.max_body_bytes);
        const threadId = threadIdFromRequest(req, body);
        await relayResponses({
          req,
          res,
          config: context.config,
          state: context.state,
          router: context.router,
          body,
          requestIdValue: id,
          logger,
          rawStore,
          threadId,
          rolloutPath: await rolloutPathForThread(threadId, codexStatePath)
        });
        return;
      }
      textResponse(res, 404, "Not found");
    } catch (error) {
      const status = error.status ?? 500;
      logger("error", "request_failed", {
        request_id: id,
        status,
        code: error.code ?? "internal_error",
        message: error.message
      });
      if (req.aborted || status === 499) {
        if (!res.destroyed) {
          res.destroy();
        }
        return;
      }
      if (!res.headersSent) {
        jsonResponse(res, status, errorPayload(error, id));
      } else {
        res.end();
      }
    }
  });
  return server;
}
