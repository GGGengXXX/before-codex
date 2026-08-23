import fs from "node:fs";
import path from "node:path";

const RECENT_CALL_LIMIT = 500;
const USAGE_RETENTION_DAYS = 370;
const CHARS_PER_ESTIMATED_TOKEN = 4;
const MIN_ESTIMATED_INPUT_TOKENS = 1;

function emptyStateData() {
  return {
    version: 2,
    deployments: {},
    affinity: {},
    cursors: {},
    recent_calls: [],
    daily_usage: {}
  };
}

function defaultDeploymentState() {
  return {
    status: "healthy",
    cooldown_until: 0,
    attempts: 0,
    successes: 0,
    failures: 0,
    last_error: null,
    last_used_at: null,
    last_request: null,
    token_usage: {
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      estimated_requests: 0,
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
      estimated_total_tokens: 0
    }
  };
}

function normalizeData(value) {
  const data = value && typeof value === "object" ? value : emptyStateData();
  const previousVersion = Number(data.version) || 1;
  data.version = 2;
  data.deployments = data.deployments && typeof data.deployments === "object"
    ? data.deployments
    : {};
  data.affinity = data.affinity && typeof data.affinity === "object" ? data.affinity : {};
  data.cursors = data.cursors && typeof data.cursors === "object" ? data.cursors : {};
  data.recent_calls = Array.isArray(data.recent_calls) ? data.recent_calls : [];
  data.daily_usage = data.daily_usage && typeof data.daily_usage === "object"
    ? data.daily_usage
    : {};
  if (previousVersion < 2) {
    migrateEstimatedUsage(data);
  }
  return data;
}

function ensureDeploymentState(data, deploymentId) {
  data.deployments[deploymentId] ??= defaultDeploymentState();
  const tokenUsage = data.deployments[deploymentId].token_usage ?? {};
  for (const key of [
    "requests",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "estimated_requests",
    "estimated_input_tokens",
    "estimated_output_tokens",
    "estimated_total_tokens"
  ]) {
    tokenUsage[key] ??= 0;
  }
  data.deployments[deploymentId].token_usage = tokenUsage;
  data.deployments[deploymentId].last_request ??= null;
  return data.deployments[deploymentId];
}

function deploymentAvailable(data, deployment, now = Date.now()) {
  if (deployment.enabled === false) {
    return false;
  }
  const state = ensureDeploymentState(data, deployment.id);
  if (state.cooldown_until > now) {
    return false;
  }
  return true;
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

function clippedText(value, limit = 4000) {
  if (typeof value !== "string" || !value) {
    return "";
  }
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function estimateTokensFromText(value) {
  if (typeof value !== "string" || !value.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(value.length / CHARS_PER_ESTIMATED_TOKEN));
}

function looksOpaqueText(value) {
  if (typeof value !== "string") {
    return false;
  }
  const text = value.trim();
  if (text.length < 128 || /\s/.test(text)) {
    return false;
  }
  return /^[A-Za-z0-9+/=_-]+$/.test(text);
}

function usageWithEstimate(usage, metadata = {}) {
  if (usage?.total_tokens) {
    return { ...usage, estimated: usage.estimated === true };
  }
  const opaqueResponse = metadata.response_text_is_stream_delta === true
    ? false
    : looksOpaqueText(metadata.response_text);
  const outputTokens = opaqueResponse
    ? 0
    : estimateTokensFromText(metadata.response_text);
  const inputTokens = Math.max(
    MIN_ESTIMATED_INPUT_TOKENS,
    estimateTokensFromText(metadata.request_text)
  );
  if (!outputTokens && !inputTokens) {
    return null;
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated: true,
    estimated_reason: opaqueResponse
      ? "upstream_usage_missing_opaque_response"
      : "upstream_usage_missing"
  };
}

function addEstimatedUsageToBucket(bucket, usage) {
  bucket.input_tokens = (bucket.input_tokens ?? 0) + (usage.input_tokens ?? 0);
  bucket.output_tokens = (bucket.output_tokens ?? 0) + (usage.output_tokens ?? 0);
  bucket.total_tokens = (bucket.total_tokens ?? 0) + (usage.total_tokens ?? 0);
  bucket.estimated_calls = (bucket.estimated_calls ?? 0) + 1;
  bucket.estimated_input_tokens =
    (bucket.estimated_input_tokens ?? 0) + (usage.input_tokens ?? 0);
  bucket.estimated_output_tokens =
    (bucket.estimated_output_tokens ?? 0) + (usage.output_tokens ?? 0);
  bucket.estimated_total_tokens =
    (bucket.estimated_total_tokens ?? 0) + (usage.total_tokens ?? 0);
}

function migrateEstimatedUsage(data) {
  const deploymentStates = data.deployments;
  for (const call of data.recent_calls) {
    if (call.result !== "success" || call.usage) {
      continue;
    }
    const usage = usageWithEstimate(null, {
      response_text: call.response_text,
      request_text: ""
    });
    if (!usage) {
      continue;
    }
    call.usage = usage;
    const deploymentState = deploymentStates[call.deployment_id];
    if (deploymentState) {
      const tokenUsage = deploymentState.token_usage ?? {};
      tokenUsage.estimated_requests = (tokenUsage.estimated_requests ?? 0) + 1;
      tokenUsage.estimated_input_tokens =
        (tokenUsage.estimated_input_tokens ?? 0) + usage.input_tokens;
      tokenUsage.estimated_output_tokens =
        (tokenUsage.estimated_output_tokens ?? 0) + usage.output_tokens;
      tokenUsage.estimated_total_tokens =
        (tokenUsage.estimated_total_tokens ?? 0) + usage.total_tokens;
      tokenUsage.input_tokens = (tokenUsage.input_tokens ?? 0) + usage.input_tokens;
      tokenUsage.output_tokens = (tokenUsage.output_tokens ?? 0) + usage.output_tokens;
      tokenUsage.total_tokens = (tokenUsage.total_tokens ?? 0) + usage.total_tokens;
      deploymentState.token_usage = tokenUsage;
    }
    const key = typeof call.at === "string" ? call.at.slice(0, 10) : dayKey();
    const bucket = ensureUsageBucket(data, key);
    bucket.calls = bucket.calls ?? 0;
    bucket.models ??= {};
    addEstimatedUsageToBucket(bucket, usage);
    const model = call.upstream_model ?? "unknown";
    bucket.models[model] ??= emptyUsageBucket();
    addEstimatedUsageToBucket(bucket.models[model], usage);
  }
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function emptyUsageBucket() {
  return {
    calls: 0,
    failures: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    estimated_calls: 0,
    estimated_input_tokens: 0,
    estimated_output_tokens: 0,
    estimated_total_tokens: 0,
    latency_ms: 0,
    latency_count: 0,
    models: {}
  };
}

function ensureUsageBucket(data, key) {
  data.daily_usage[key] ??= emptyUsageBucket();
  data.daily_usage[key].models ??= {};
  return data.daily_usage[key];
}

function addUsage(target, usage, durationMs, { failed = false } = {}) {
  target.calls += 1;
  target.failures += failed ? 1 : 0;
  target.input_tokens += usage?.input_tokens ?? 0;
  target.output_tokens += usage?.output_tokens ?? 0;
  target.total_tokens += usage?.total_tokens ?? 0;
  if (usage?.estimated) {
    target.estimated_calls += 1;
    target.estimated_input_tokens += usage.input_tokens ?? 0;
    target.estimated_output_tokens += usage.output_tokens ?? 0;
    target.estimated_total_tokens += usage.total_tokens ?? 0;
  }
  if (Number.isFinite(durationMs)) {
    target.latency_ms += durationMs;
    target.latency_count += 1;
  }
}

function recordUsageDay(data, metadata, { failed = false } = {}) {
  const key = dayKey();
  const model = metadata.upstream_model ?? "unknown";
  const bucket = ensureUsageBucket(data, key);
  bucket.models[model] ??= emptyUsageBucket();
  addUsage(bucket, metadata.usage, metadata.duration_ms, { failed });
  addUsage(bucket.models[model], metadata.usage, metadata.duration_ms, { failed });
  pruneUsageDays(data);
}

function pruneUsageDays(data, keepDays = USAGE_RETENTION_DAYS) {
  const keys = Object.keys(data.daily_usage).sort();
  const extra = keys.length - keepDays;
  if (extra <= 0) {
    return;
  }
  for (const key of keys.slice(0, extra)) {
    delete data.daily_usage[key];
  }
}

function dateKeys(days) {
  const keys = [];
  const now = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - offset);
    keys.push(dayKey(date));
  }
  return keys;
}

function mergeUsage(target, source) {
  target.calls += source?.calls ?? 0;
  target.failures += source?.failures ?? 0;
  target.input_tokens += source?.input_tokens ?? 0;
  target.output_tokens += source?.output_tokens ?? 0;
  target.total_tokens += source?.total_tokens ?? 0;
  target.estimated_calls += source?.estimated_calls ?? 0;
  target.estimated_input_tokens += source?.estimated_input_tokens ?? 0;
  target.estimated_output_tokens += source?.estimated_output_tokens ?? 0;
  target.estimated_total_tokens += source?.estimated_total_tokens ?? 0;
  target.latency_ms += source?.latency_ms ?? 0;
  target.latency_count += source?.latency_count ?? 0;
}

function usageRange(data, days) {
  const total = emptyUsageBucket();
  const models = {};
  const buckets = dateKeys(days).map((key) => {
    const bucket = data.daily_usage[key] ?? emptyUsageBucket();
    mergeUsage(total, bucket);
    for (const [model, usage] of Object.entries(bucket.models ?? {})) {
      models[model] ??= emptyUsageBucket();
      mergeUsage(models[model], usage);
    }
    return {
      date: key,
      calls: bucket.calls ?? 0,
      failures: bucket.failures ?? 0,
      input_tokens: bucket.input_tokens ?? 0,
      output_tokens: bucket.output_tokens ?? 0,
      total_tokens: bucket.total_tokens ?? 0,
      estimated_calls: bucket.estimated_calls ?? 0,
      estimated_input_tokens: bucket.estimated_input_tokens ?? 0,
      estimated_output_tokens: bucket.estimated_output_tokens ?? 0,
      estimated_total_tokens: bucket.estimated_total_tokens ?? 0,
      avg_latency_ms: bucket.latency_count
        ? Math.round(bucket.latency_ms / bucket.latency_count)
        : 0
    };
  });
  return {
    days,
    buckets,
    total: {
      calls: total.calls,
      failures: total.failures,
      input_tokens: total.input_tokens,
      output_tokens: total.output_tokens,
      total_tokens: total.total_tokens,
      estimated_calls: total.estimated_calls,
      estimated_input_tokens: total.estimated_input_tokens,
      estimated_output_tokens: total.estimated_output_tokens,
      estimated_total_tokens: total.estimated_total_tokens,
      avg_latency_ms: total.latency_count
        ? Math.round(total.latency_ms / total.latency_count)
        : 0
    },
    models: Object.fromEntries(
      Object.entries(models).map(([model, usage]) => [
        model,
        {
          calls: usage.calls,
          failures: usage.failures,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          total_tokens: usage.total_tokens,
          estimated_calls: usage.estimated_calls,
          estimated_input_tokens: usage.estimated_input_tokens,
          estimated_output_tokens: usage.estimated_output_tokens,
          estimated_total_tokens: usage.estimated_total_tokens,
          avg_latency_ms: usage.latency_count
            ? Math.round(usage.latency_ms / usage.latency_count)
            : 0
        }
      ])
    )
  };
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export class MemoryStateStore {
  constructor() {
    this.data = emptyStateData();
  }

  read(callback) {
    return callback(this.data);
  }

  update(callback) {
    return callback(this.data);
  }
}

export class FileStateStore {
  constructor(filePath, {
    lockTimeoutMs = 1000,
    staleLockMs = 5000
  } = {}) {
    if (!filePath) {
      throw new Error("File state store requires a file path");
    }
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
  }

  read(callback) {
    return callback(this.readData());
  }

  update(callback) {
    const release = this.acquireLock();
    try {
      const data = this.readData();
      const result = callback(data);
      this.writeData(data);
      return result;
    } finally {
      release();
    }
  }

  readData() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return normalizeData(JSON.parse(raw));
    } catch (error) {
      if (error.code === "ENOENT") {
        return emptyStateData();
      }
      throw new Error(`Cannot read state file ${this.filePath}: ${error.message}`);
    }
  }

  writeData(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalizeData(data), null, 2)}\n`);
    fs.renameSync(temporaryPath, this.filePath);
  }

  acquireLock() {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const startedAt = Date.now();
    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        fs.writeFileSync(
          path.join(this.lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
        );
        return () => fs.rmSync(this.lockPath, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        this.removeStaleLock();
        if (Date.now() - startedAt > this.lockTimeoutMs) {
          throw new Error(`Timed out waiting for state lock ${this.lockPath}`);
        }
        sleepSync(25);
      }
    }
  }

  removeStaleLock() {
    try {
      const stat = fs.statSync(this.lockPath);
      if (Date.now() - stat.mtimeMs > this.staleLockMs) {
        fs.rmSync(this.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export class RuntimeState {
  constructor(store = new MemoryStateStore()) {
    this.store = store;
  }

  ensureDeployment(deploymentId) {
    return this.store.update((data) => ensureDeploymentState(data, deploymentId));
  }

  isAvailable(deployment, now = Date.now()) {
    return this.store.read((data) => deploymentAvailable(data, deployment, now));
  }

  recordAttempt(deployment) {
    this.store.update((data) => {
      const state = ensureDeploymentState(data, deployment.id);
      state.attempts += 1;
      state.last_used_at = new Date().toISOString();
    });
  }

  recordSuccess(deployment, metadata = {}) {
    this.store.update((data) => {
      const state = ensureDeploymentState(data, deployment.id);
      state.successes += 1;
      state.status = "healthy";
      state.cooldown_until = 0;
      state.last_error = null;
      const usage = usageWithEstimate(metadata.usage ?? null, metadata);
      state.token_usage.requests += 1;
      if (usage) {
        state.token_usage.input_tokens += usage.input_tokens ?? 0;
        state.token_usage.output_tokens += usage.output_tokens ?? 0;
        state.token_usage.total_tokens += usage.total_tokens ?? 0;
        if (usage.estimated) {
          state.token_usage.estimated_requests += 1;
          state.token_usage.estimated_input_tokens += usage.input_tokens ?? 0;
          state.token_usage.estimated_output_tokens += usage.output_tokens ?? 0;
          state.token_usage.estimated_total_tokens += usage.total_tokens ?? 0;
        }
      }
      state.last_request = {
        result: "success",
        request_id: metadata.request_id ?? null,
        thread_id: metadata.thread_id ?? null,
        rollout_path: metadata.rollout_path ?? null,
        requested_model: metadata.requested_model ?? null,
        logical_model: metadata.logical_model ?? null,
        upstream_model: metadata.upstream_model ?? deployment.model,
        duration_ms: metadata.duration_ms ?? null,
        usage,
        response_text: clippedText(metadata.response_text),
        raw_response_id: metadata.raw_response_id ?? null,
        raw_response_path: metadata.raw_response_path ?? null,
        raw_response_available: Boolean(metadata.raw_response_path),
        raw_response_bytes: metadata.raw_response_bytes ?? 0,
        at: new Date().toISOString()
      };
      data.recent_calls.unshift({
        result: "success",
        deployment_id: deployment.id,
        provider: deployment.provider,
        ...state.last_request
      });
      data.recent_calls = data.recent_calls.slice(0, RECENT_CALL_LIMIT);
      recordUsageDay(data, state.last_request);
    });
  }

  recordFailure(deployment, classification, durationMs, metadata = {}) {
    this.store.update((data) => {
      const state = ensureDeploymentState(data, deployment.id);
      state.failures += 1;
      state.status = "cooling_down";
      state.cooldown_until = Math.max(state.cooldown_until, Date.now() + durationMs);
      state.last_error = {
        kind: classification.kind,
        code: classification.code,
        message: classification.message,
        status: classification.status,
        at: new Date().toISOString()
      };
      if (metadata.log_call) {
        const failedCall = {
          result: "failure",
          deployment_id: deployment.id,
          provider: deployment.provider,
          request_id: metadata.request_id ?? null,
          thread_id: metadata.thread_id ?? null,
          rollout_path: metadata.rollout_path ?? null,
          requested_model: metadata.requested_model ?? null,
          logical_model: metadata.logical_model ?? null,
          upstream_model: metadata.upstream_model ?? deployment.model,
          duration_ms: metadata.duration_ms ?? null,
          usage: null,
          response_text: clippedText(metadata.response_text),
          raw_response_id: metadata.raw_response_id ?? null,
          raw_response_path: metadata.raw_response_path ?? null,
          raw_response_available: Boolean(metadata.raw_response_path),
          raw_response_bytes: metadata.raw_response_bytes ?? 0,
          error: state.last_error,
          at: new Date().toISOString()
        };
        data.recent_calls.unshift(failedCall);
        data.recent_calls = data.recent_calls.slice(0, RECENT_CALL_LIMIT);
        recordUsageDay(data, failedCall, { failed: true });
      }
    });
  }

  nextCursor(key) {
    return this.store.update((data) => {
      const current = data.cursors[key] ?? 0;
      data.cursors[key] = current + 1;
      return current;
    });
  }

  setAffinity(responseId, deploymentId, ttlMs) {
    if (!responseId) {
      return;
    }
    this.store.update((data) => {
      data.affinity[responseId] = {
        deployment_id: deploymentId,
        expires_at: Date.now() + ttlMs
      };
    });
  }

  getAffinity(responseId) {
    if (!responseId) {
      return null;
    }
    return this.store.read((data) => {
      const value = data.affinity[responseId];
      if (!value) {
        return null;
      }
      if (value.expires_at <= Date.now()) {
        return null;
      }
      return value.deployment_id;
    });
  }

  snapshot(deployments, { includeEndpoint = false } = {}) {
    return this.store.read((data) => deployments.map((deployment) => {
      const state = data.deployments[deployment.id] ?? defaultDeploymentState();
      const item = {
        id: deployment.id,
        provider: deployment.provider,
        model: deployment.model,
        enabled: deployment.enabled !== false,
        credential_configured: credentialConfigured(deployment),
        status:
          deployment.enabled === false
            ? "disabled"
            : deploymentAvailable(data, deployment)
              ? "healthy"
              : state.status,
        cooldown_until: state.cooldown_until || null,
        attempts: state.attempts,
        successes: state.successes,
        failures: state.failures,
        last_error: state.last_error,
        last_used_at: state.last_used_at,
        last_request: state.last_request,
        token_usage: state.token_usage
      };
      if (includeEndpoint) {
        item.base_url = new URL(deployment.base_url).origin;
      }
      return item;
    }));
  }

  recentCalls(options = 20) {
    const normalizedOptions = typeof options === "number"
      ? { limit: options, offset: 0 }
      : options ?? {};
    const offset = Math.max(0, Number(normalizedOptions.offset) || 0);
    const limit = Math.min(
      RECENT_CALL_LIMIT,
      Math.max(1, Number(normalizedOptions.limit) || 20)
    );
    return this.store.read((data) => {
      const calls = normalizeData(data).recent_calls;
      return calls.slice(offset, offset + limit);
    });
  }

  callHistory({ offset = 0, limit = 20 } = {}) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    return this.store.read((data) => {
      const calls = normalizeData(data).recent_calls;
      const totalPages = Math.max(1, Math.ceil(calls.length / safeLimit));
      const page = Math.min(Math.floor(safeOffset / safeLimit), totalPages - 1);
      const effectiveOffset = page * safeLimit;
      return {
        offset: effectiveOffset,
        limit: safeLimit,
        total: calls.length,
        page,
        total_pages: totalPages,
        calls: calls.slice(effectiveOffset, effectiveOffset + safeLimit)
      };
    });
  }

  usageSummary() {
    return this.store.read((data) => {
      const normalized = normalizeData(data);
      return {
        week: usageRange(normalized, 7),
        month: usageRange(normalized, 30),
        year: usageRange(normalized, 365)
      };
    });
  }
}

export function createRuntimeState(config) {
  const stateConfig = config.state ?? {};
  if (stateConfig.store === "file") {
    return new RuntimeState(
      new FileStateStore(stateConfig.file_path, {
        lockTimeoutMs: stateConfig.lock_timeout_ms,
        staleLockMs: stateConfig.stale_lock_ms
      })
    );
  }
  return new RuntimeState();
}
