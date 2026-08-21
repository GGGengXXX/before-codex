import http from "node:http";
import crypto from "node:crypto";
import { classifyNetworkFailure, classifyUpstreamFailure, cooldownDuration } from "./classifier.js";
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
import {
  callUpstream,
  compatibilityForDeployment,
  createSseSanitizer,
  extractOutputTextFromJson,
  extractOutputTextFromSse,
  extractResponseIdFromJson,
  extractResponseIdFromSse,
  extractUsageFromJson,
  extractUsageFromSse,
  readText,
  responseHeaders,
  sanitizeResponsePayload,
  sseHasTerminalEvent
} from "./upstream.js";
import { renderAdminPage } from "./admin-page.js";
import { renderStatusPage } from "./status-page.js";

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

function findDeployment(config, deploymentId) {
  for (const [logicalModel, modelConfig] of Object.entries(config.models)) {
    const deployment = modelConfig.deployments.find((item) => item.id === deploymentId);
    if (deployment) {
      return { logicalModel, deployment };
    }
  }
  return null;
}

function testRequestBody(deployment, input) {
  return JSON.stringify({
    model: deployment.model,
    input: input || "Reply with OK in one short sentence.",
    stream: false
  });
}

function relayBaseUrl(config) {
  return `http://${config.server.host}:${config.server.port}/v1`;
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

function forwardResponse(res, upstream, bodyTextValue, requestIdValue, compatibility = {}) {
  let payload = bodyTextValue;
  try {
    payload = sanitizeResponsePayload(JSON.parse(bodyTextValue), compatibility);
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

async function relayResponses({
  req,
  res,
  config,
  state,
  router,
  body,
  requestIdValue,
  logger
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
    if (!providerNames.has(deployment.provider)) {
      if (providerNames.size >= 1 && providerNames.size > config.routing.max_provider_fallbacks) {
        break;
      }
      providerNames = new Set(providerNames).add(deployment.provider);
    }
    state.recordAttempt(deployment);
    const attemptStartedAt = Date.now();
    const attemptInfo = {
      number: attemptNumber + 1,
      deployment: deployment.id,
      provider: deployment.provider
    };
    attempts.push(attemptInfo);
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
          state.recordFailure(deployment, classification, duration);
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
            forwardResponse(res, upstream, errorBody, requestIdValue, compatibility);
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
            telemetryPayload = sanitizeResponsePayload(parsed, compatibility);
            state.setAffinity(
              extractResponseIdFromJson(telemetryPayload),
              deployment.id,
              config.routing.affinity_ttl_ms ?? 86400000
            );
          } catch {
            // A successful non-JSON response is still forwarded as-is.
          }
          state.recordSuccess(deployment, {
            request_id: requestIdValue,
            requested_model: requestedModel,
            logical_model: resolved.name,
            upstream_model: upstreamModel,
            usage: extractUsageFromJson(telemetryPayload),
            response_text: extractOutputTextFromJson(telemetryPayload),
            duration_ms: Date.now() - attemptStartedAt
          });
          logger("info", "upstream_success", {
            request_id: requestIdValue,
            deployment: deployment.id,
            provider: deployment.provider,
            model: upstreamModel,
            duration_ms: Date.now() - attemptStartedAt
          });
          forwardResponse(res, upstream, responseBody, requestIdValue, compatibility);
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
        let hasTerminalEvent = false;
        const sseSanitizer = createSseSanitizer(compatibility);
        while (!committed) {
          const { done, value } = await reader.read();
          if (done) {
            const chunk = sseSanitizer.flush();
            if (chunk) {
              firstChunk += chunk;
              streamTail = `${streamTail}${chunk}`.slice(-8192);
              hasTerminalEvent ||= sseHasTerminalEvent(streamTail);
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
          const chunk = sseSanitizer.push(rawChunk);
          if (chunk) {
            firstChunk += chunk;
            streamTail = `${streamTail}${chunk}`.slice(-8192);
            hasTerminalEvent ||= sseHasTerminalEvent(streamTail);
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
          state.recordFailure(
            deployment,
            classification,
            cooldownDuration(classification, config.routing)
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
            const chunk = sseSanitizer.push(rawChunk);
            if (!chunk) {
              continue;
            }
            streamTail = `${streamTail}${chunk}`.slice(-8192);
            hasTerminalEvent ||= sseHasTerminalEvent(streamTail);
            res.write(chunk);
          }
          const finalChunk = sseSanitizer.flush();
          if (finalChunk) {
            streamTail = `${streamTail}${finalChunk}`.slice(-8192);
            hasTerminalEvent ||= sseHasTerminalEvent(streamTail);
            res.write(finalChunk);
          }
          if (!hasTerminalEvent) {
            const classification = classifyNetworkFailure(
              new Error("upstream_stream_closed_after_commit")
            );
            attemptInfo.result = "stream_interrupted_after_commit";
            state.recordFailure(
              deployment,
              classification,
              cooldownDuration(classification, config.routing)
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
          res.end();
          attemptInfo.result = "success";
          state.recordSuccess(deployment, {
            request_id: requestIdValue,
            requested_model: requestedModel,
            logical_model: resolved.name,
            upstream_model: upstreamModel,
            usage: extractUsageFromSse(streamTail),
            response_text: extractOutputTextFromSse(streamTail),
            duration_ms: Date.now() - attemptStartedAt
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
            logger("info", "client_disconnected", {
              request_id: requestIdValue,
              deployment: deployment.id,
              provider: deployment.provider,
              duration_ms: Date.now() - attemptStartedAt
            });
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          const classification = classifyNetworkFailure(error);
          state.recordFailure(
            deployment,
            classification,
            cooldownDuration(classification, config.routing)
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
    codexStatePath = defaultCodexStatePath()
  } = {}
) {
  const router = new Router(config, state);
  let lastReloadAt = null;
  let reloadPromise = null;

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

  async function configPayload() {
    if (!configPath) {
      throw new RelayError("This server was not started with an editable config path", {
        code: "config_edit_unavailable",
        status: 503
      });
    }
    const rawConfig = await readRawConfig(configPath);
    return {
      config_path: configPath,
      reloaded_at: lastReloadAt,
      config: redactConfigSecrets(rawConfig),
      status: publicStatus(config, state, { includeEndpoint: true }),
      env: await envPayload(rawConfig),
      codex: await readCodexConfig(codexConfigPath)
    };
  }

  async function envPayload(rawConfig = null) {
    const sourceConfig = rawConfig ?? (configPath ? await readRawConfig(configPath) : config);
    const fileValues = envPath ? await readEnvFile(envPath) : {};
    const names = new Set([
      "RELAY_API_KEY",
      "RELAY_ADMIN_KEY",
      ...envReferences(sourceConfig),
      ...Object.keys(fileValues)
    ]);
    return {
      env_path: envPath,
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

  async function saveConfig(nextConfig) {
    if (!configPath) {
      throw new RelayError("This server was not started with an editable config path", {
        code: "config_edit_unavailable",
        status: 503
      });
    }
    try {
      const result = await writeValidatedConfig(configPath, nextConfig, loadConfigFn);
      replaceConfig(config, result.config);
      lastReloadAt = new Date().toISOString();
      return {
        save_status: "saved",
        reloaded_at: lastReloadAt,
        config_path: configPath,
        config: redactConfigSecrets(result.raw),
        env: await envPayload(result.raw),
        runtime: {
          models: Object.keys(config.models),
          deployments: deploymentCount(config)
        },
        status: publicStatus(config, state, { includeEndpoint: true }),
        codex: await readCodexConfig(codexConfigPath)
      };
    } catch (error) {
      throw new RelayError(`Configuration save failed: ${error.message}`, {
        code: "config_save_failed",
        status: error.name === "ConfigError" ? 400 : 500
      });
    }
  }

  async function testDeployment(body, requestIdValue) {
    const found = findDeployment(config, body.deployment_id);
    if (!found) {
      throw new RelayError(`Unknown deployment "${body.deployment_id}"`, {
        code: "deployment_not_found",
        status: 404
      });
    }
    const { deployment, logicalModel } = found;
    state.recordAttempt(deployment);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutMs = Math.min(config.server.request_timeout_ms, 30000);
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
      const durationMs = Date.now() - startedAt;
      if (!upstream.ok) {
        const classification = classifyUpstreamFailure({
          status: upstream.status,
          body: bodyText,
          headers: upstream.headers,
          rules: config.routing.provider_error_rules?.[deployment.provider]
        });
        state.recordFailure(
          deployment,
          classification,
          cooldownDuration(classification, config.routing),
          {
            log_call: true,
            request_id: requestIdValue,
            requested_model: deployment.model,
            logical_model: logicalModel,
            upstream_model: deployment.model,
            response_text: bodyText,
            duration_ms: durationMs
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
      state.recordSuccess(deployment, {
        request_id: requestIdValue,
        requested_model: deployment.model,
        logical_model: logicalModel,
        upstream_model: deployment.model,
        usage,
        response_text: responseText,
        duration_ms: durationMs
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
      state.recordFailure(
        deployment,
        classification,
        cooldownDuration(classification, config.routing),
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

  return http.createServer(async (req, res) => {
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
          bootstrapAdminToken: isLocalRequest(req) ? config.server.admin_api_key : ""
        });
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html)
        });
        res.end(html);
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
      if (req.method === "GET" && url.pathname === "/api/status") {
        if (!authorize(req, config.server.admin_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, {
          ...publicStatus(config, state, { includeEndpoint: true }),
          models: Object.keys(config.models)
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/config") {
        if (!authorize(req, config.server.admin_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, await configPayload());
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/calls") {
        if (!authorize(req, config.server.admin_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, state.callHistory?.(paginationFromUrl(url)) ?? {
          offset: 0,
          limit: 20,
          total: state.recentCalls?.(20).length ?? 0,
          calls: state.recentCalls?.(20) ?? []
        });
        return;
      }
      if (req.method === "PUT" && url.pathname === "/admin/config") {
        if (!authorize(req, config.server.admin_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const nextConfig = body.config ?? body;
        const result = await saveConfig(nextConfig);
        jsonResponse(res, 200, result);
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/env") {
        if (!authorize(req, config.server.admin_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        jsonResponse(res, 200, await envPayload());
        return;
      }
      if (req.method === "PUT" && url.pathname === "/admin/env") {
        if (!authorize(req, config.server.admin_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        if (!envPath) {
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
            env: await envPayload()
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
        if (!authorize(req, config.server.admin_api_key)) {
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
        if (!authorize(req, config.server.admin_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        try {
          const codex = await writeCodexModelProvider({
            modelProvider: body.model_provider,
            relayBaseUrl: body.relay_base_url || relayBaseUrl(config),
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
        if (!authorize(req, config.server.admin_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const result = await reload();
        jsonResponse(res, 200, {
          status: "reloaded",
          ...result
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/test-deployment") {
        if (!authorize(req, config.server.admin_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Admin bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        const result = await testDeployment(body, id);
        jsonResponse(res, 200, {
          request_id: id,
          ...result,
          status: publicStatus(config, state, { includeEndpoint: true })
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!authorize(req, config.server.public_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Bearer token required", request_id: id }
          });
          return;
        }
        const data = Object.entries(config.models).flatMap(([name, model]) => [
          {
            id: name,
            object: "model",
            created: 0,
            owned_by: "codex-relay"
          },
          ...model.aliases.map((alias) => ({
            id: alias,
            object: "model",
            created: 0,
            owned_by: "codex-relay"
          }))
        ]);
        jsonResponse(res, 200, { object: "list", data });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (!authorize(req, config.server.public_api_key)) {
          jsonResponse(res, 401, {
            error: { type: "unauthorized", message: "Bearer token required", request_id: id }
          });
          return;
        }
        const body = await readRequestBody(req, config.server.max_body_bytes);
        await relayResponses({
          req,
          res,
          config,
          state,
          router,
          body,
          requestIdValue: id,
          logger
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
}
