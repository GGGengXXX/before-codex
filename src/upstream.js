import { classifyNetworkFailure } from "./classifier.js";
import { RelayError } from "./errors.js";

function joinUrl(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
}

function copyRequestHeaders(request) {
  const headers = new Headers();
  for (const name of ["accept", "openai-beta", "x-stainless-os", "x-stainless-package-version"]) {
    const value = request.headers[name];
    if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}

function abortSignalFor(request, response, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let clientDisconnected = false;
  const abortForClient = () => {
    clientDisconnected = true;
    controller.abort();
  };
  const onAborted = () => abortForClient();
  const onResponseClose = () => {
    if (!response.writableEnded) {
      abortForClient();
    }
  };
  const cleanup = () => {
    clearTimeout(timer);
    request.removeListener("aborted", onAborted);
    response.removeListener("close", onResponseClose);
  };
  // `close` is also emitted after a normal request body upload. `aborted`
  // is the signal that the client actually cancelled the request.
  request.once("aborted", onAborted);
  response.once("close", onResponseClose);
  return {
    signal: controller.signal,
    cleanup,
    isClientDisconnected: () => clientDisconnected
  };
}

const INVALID_REASONING_TYPES = new Set(["reasoning", "compaction"]);

function compatibilityEnabled(compatibility, key) {
  return compatibility?.[key] !== false;
}

export function compatibilityForDeployment(config, deployment) {
  return {
    ...(config.routing?.compatibility ?? {}),
    ...(deployment.compatibility ?? {})
  };
}

function hasValidReasoningId(value) {
  return typeof value?.id === "string" && value.id.startsWith("rs");
}

function isInvalidReasoningItem(value, compatibility = {}) {
  return Boolean(
    compatibilityEnabled(compatibility, "drop_invalid_reasoning_items")
    && value
    && typeof value === "object"
    && INVALID_REASONING_TYPES.has(value.type)
    && !hasValidReasoningId(value)
  );
}

function expectedItemIdPrefix(type) {
  if (type === "message") {
    return "msg";
  }
  if (type === "function_call") {
    return "fc";
  }
  if (type === "function_call_output") {
    return "fco";
  }
  return null;
}

function stripInvalidRequestItemId(value, compatibility) {
  if (!compatibilityEnabled(compatibility, "strip_invalid_request_item_ids")) {
    return value;
  }
  const prefix = expectedItemIdPrefix(value.type);
  if (!prefix || typeof value.id !== "string" || value.id.startsWith(prefix)) {
    return value;
  }
  const { id: _id, ...rest } = value;
  return rest;
}

const DROP_ITEM = Symbol("drop-item");

function sanitizeResponsesValue(value, compatibility, { stripRequestIds = false } = {}) {
  if (isInvalidReasoningItem(value, compatibility)) {
    return DROP_ITEM;
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const sanitized = sanitizeResponsesValue(item, compatibility, { stripRequestIds });
      if (sanitized !== DROP_ITEM) {
        items.push(sanitized);
      }
    }
    return items;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  let output = value;
  if (stripRequestIds) {
    output = stripInvalidRequestItemId(output, compatibility);
  }

  const entries = [];
  for (const [key, child] of Object.entries(output)) {
    const sanitized = sanitizeResponsesValue(child, compatibility, { stripRequestIds });
    if (sanitized === DROP_ITEM) {
      if (key === "item") {
        return DROP_ITEM;
      }
      continue;
    }
    entries.push([key, sanitized]);
  }
  return Object.fromEntries(entries);
}

export function sanitizeRequestBody(body, compatibility = {}) {
  if (!compatibilityEnabled(compatibility, "sanitize_request_items")) {
    return body;
  }
  const sanitized = { ...body };
  if (Array.isArray(body.input)) {
    sanitized.input = sanitizeResponsesValue(body.input, compatibility, {
      stripRequestIds: true
    });
  }
  return sanitized;
}

export function sanitizeResponsePayload(value, compatibility = {}) {
  if (!compatibilityEnabled(compatibility, "sanitize_response_items")) {
    return value;
  }
  const sanitized = sanitizeResponsesValue(value, compatibility);
  return sanitized === DROP_ITEM ? null : sanitized;
}

function splitSseEvent(buffer) {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) {
    return null;
  }
  const end = match.index + match[0].length;
  return {
    event: buffer.slice(0, end),
    rest: buffer.slice(end)
  };
}

function sanitizeSseEvent(event, compatibility) {
  if (!compatibilityEnabled(compatibility, "sanitize_response_items")) {
    return event;
  }
  const lines = event.replace(/\r?\n\r?\n$/, "").split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) {
    return event;
  }
  const rawData = dataLines.join("\n");
  if (!rawData.trim() || rawData.trim() === "[DONE]") {
    return event;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return event;
  }
  const sanitized = sanitizeResponsePayload(parsed, compatibility);
  if (sanitized === null) {
    return "";
  }
  const nonDataLines = lines.filter((line) => !line.startsWith("data:"));
  return `${nonDataLines.join("\n")}${nonDataLines.length ? "\n" : ""}data: ${JSON.stringify(sanitized)}\n\n`;
}

export function createSseSanitizer(compatibility = {}) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let output = "";
      while (true) {
        const next = splitSseEvent(buffer);
        if (!next) {
          break;
        }
        output += sanitizeSseEvent(next.event, compatibility);
        buffer = next.rest;
      }
      return output;
    },
    flush() {
      if (!buffer) {
        return "";
      }
      const output = sanitizeSseEvent(buffer, compatibility);
      buffer = "";
      return output;
    }
  };
}

export function requestBodyForDeployment(body, deployment, compatibility = {}) {
  const rewritten = { ...sanitizeRequestBody(body, compatibility), model: deployment.model };
  return JSON.stringify(rewritten);
}

export async function callUpstream({
  request,
  response,
  body,
  deployment,
  compatibility,
  stream,
  timeoutMs
}) {
  const {
    signal,
    cleanup,
    isClientDisconnected
  } = abortSignalFor(request, response, timeoutMs);
  const headers = copyRequestHeaders(request);
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${deployment.api_key}`);
  headers.set("user-agent", "codex-relay/0.1");
  for (const [name, value] of Object.entries(deployment.headers ?? {})) {
    headers.set(name, value);
  }

  try {
    const response = await fetch(joinUrl(deployment.base_url, "responses"), {
      method: "POST",
      headers,
      body: requestBodyForDeployment(body, deployment, compatibility),
      signal
    });
    return { response, cleanup, isClientDisconnected };
  } catch (error) {
    cleanup();
    if (error.name === "AbortError" && (request.aborted || isClientDisconnected())) {
      throw new RelayError("Client disconnected before the upstream response completed", {
        code: "client_disconnected",
        status: 499
      });
    }
    throw Object.assign(error, { relayClassification: classifyNetworkFailure(error) });
  }
}

export function responseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of upstream.headers) {
    if (!["connection", "keep-alive", "transfer-encoding", "content-length"].includes(name)) {
      headers[name] = value;
    }
  }
  return headers;
}

export function extractResponseIdFromJson(value) {
  return typeof value?.id === "string" ? value.id : null;
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value.input_tokens ?? value.prompt_tokens ?? 0;
  const output = value.output_tokens ?? value.completion_tokens ?? 0;
  const total = value.total_tokens ?? input + output;
  if (![input, output, total].some((item) => Number.isFinite(item))) {
    return null;
  }
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    total_tokens: Number.isFinite(total) ? total : 0
  };
}

export function extractUsageFromJson(value) {
  return normalizeUsage(value?.usage) ?? normalizeUsage(value?.response?.usage);
}

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text ?? item?.content ?? item?.value ?? "")
      .filter(Boolean)
      .join("");
  }
  return content?.text ?? content?.content ?? content?.value ?? "";
}

export function extractOutputTextFromJson(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (typeof value.output_text === "string") {
    return value.output_text;
  }
  if (typeof value.response?.output_text === "string") {
    return value.response.output_text;
  }
  if (typeof value.choices?.[0]?.message?.content === "string") {
    return value.choices[0].message.content;
  }
  if (Array.isArray(value.output)) {
    return value.output
      .map((item) => textFromContent(item.content))
      .filter(Boolean)
      .join("");
  }
  return "";
}

export function extractUsageFromSse(text) {
  let usage = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      const value = JSON.parse(payload);
      usage = extractUsageFromJson(value) ?? usage;
    } catch {
      // SSE chunks can contain partial JSON while the stream is in flight.
    }
  }
  return usage;
}

export function extractOutputTextFromSse(text) {
  let output = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      const value = JSON.parse(payload);
      output += value.delta
        ?? value.text
        ?? value.output_text
        ?? value.response?.output_text
        ?? "";
    } catch {
      // SSE chunks can contain partial JSON while the stream is in flight.
    }
  }
  return output;
}

export function extractResponseIdFromSse(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      const value = JSON.parse(payload);
      if (typeof value.id === "string") {
        return value.id;
      }
      if (typeof value.response?.id === "string") {
        return value.response.id;
      }
    } catch {
      // The first network chunk may contain a partial JSON event.
    }
  }
  return null;
}

export function sseHasTerminalEvent(text) {
  return (
    /(?:^|\r?\n)event:\s*response\.(?:completed|failed|incomplete)\s*(?:\r?\n|$)/m.test(text)
    || /"type"\s*:\s*"response\.(?:completed|failed|incomplete)"/.test(text)
    || /(?:^|\r?\n)data:\s*\[DONE\]\s*(?:\r?\n|$)/m.test(text)
  );
}

export async function readText(response, maxBytes = 10 * 1024 * 1024) {
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new RelayError("Upstream response exceeded the configured size limit", {
      code: "upstream_response_too_large",
      status: 502
    });
  }
  return Buffer.from(bytes).toString("utf8");
}
