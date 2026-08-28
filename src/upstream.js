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
const DSML_TOOL_CALLS_OPEN = "<\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>";
const DSML_TOOL_CALLS_CLOSE = "</\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>";
const DSML_INVOKE_OPEN = "<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke";
const DSML_INVOKE_CLOSE = "</\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>";
const DSML_PARAMETER_OPEN = "<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter";
const DSML_PARAMETER_CLOSE = "</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>";

function compatibilityEnabled(compatibility, key) {
  return compatibility?.[key] !== false;
}

function providerStatePassthroughEnabled(compatibility) {
  return compatibility?.passthrough_provider_state === true;
}

function decodeXmlText(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function parseDsmlToolCalls(text) {
  if (typeof text !== "string") {
    return null;
  }
  const openIndex = text.indexOf(DSML_TOOL_CALLS_OPEN);
  if (openIndex < 0 || !text.includes(DSML_TOOL_CALLS_CLOSE, openIndex)) {
    return null;
  }
  const closeIndex = text.indexOf(DSML_TOOL_CALLS_CLOSE, openIndex);
  const block = text.slice(openIndex + DSML_TOOL_CALLS_OPEN.length, closeIndex);
  const calls = [];
  const invokePattern = new RegExp(
    `${DSML_INVOKE_OPEN}\\s+name=(?:"([^"]+)"|'([^']+)')[^>]*>([\\s\\S]*?)${DSML_INVOKE_CLOSE}`,
    "g"
  );
  for (const match of block.matchAll(invokePattern)) {
    const name = match[1] || match[2];
    const parameters = {};
    const parameterPattern = new RegExp(
      `${DSML_PARAMETER_OPEN}\\s+name=(?:"([^"]+)"|'([^']+)')[^>]*>([\\s\\S]*?)${DSML_PARAMETER_CLOSE}`,
      "g"
    );
    for (const parameter of match[3].matchAll(parameterPattern)) {
      parameters[parameter[1] || parameter[2]] = decodeXmlText(parameter[3]);
    }
    calls.push({ name, arguments: JSON.stringify(parameters) });
  }
  if (calls.length === 0) {
    return null;
  }
  return {
    visibleText: `${text.slice(0, openIndex)}${text.slice(closeIndex + DSML_TOOL_CALLS_CLOSE.length)}`.trim(),
    calls
  };
}

function textWithDsmlCalls(value) {
  return extractOutputTextFromJson(value);
}

function responseTarget(value) {
  return value?.response && typeof value.response === "object" ? value.response : value;
}

function declaredToolNames(requestBody) {
  return new Set((requestBody?.tools || [])
    .map((tool) => tool?.name || tool?.function?.name)
    .filter((name) => typeof name === "string"));
}

function adaptDsmlCall(call, requestBody) {
  const declared = declaredToolNames(requestBody);
  if (declared.has(call.name)) {
    return call;
  }
  if (call.name !== "exec" || (declared.size > 0 && !declared.has("exec_command"))) {
    return call;
  }
  let argumentsText = call.arguments;
  try {
    const argumentsValue = JSON.parse(argumentsText);
    if (Object.hasOwn(argumentsValue, "input") && !Object.hasOwn(argumentsValue, "cmd")) {
      argumentsValue.cmd = argumentsValue.input;
      delete argumentsValue.input;
      argumentsText = JSON.stringify(argumentsValue);
    }
  } catch {
    // Keep the original arguments if the provider emitted non-JSON values.
  }
  return { ...call, name: "exec_command", arguments: argumentsText };
}

function addFunctionCallsToOutput(output, parsed, requestId, requestBody) {
  const calls = parsed.calls.map((rawCall, index) => {
    const call = adaptDsmlCall(rawCall, requestBody);
    const suffix = String(requestId || "relay").replace(/[^A-Za-z0-9]/g, "").slice(-24) || "relay";
    const id = `fc_${suffix}_${index + 1}`;
    return {
      type: "function_call",
      id,
      call_id: `call_${suffix}_${index + 1}`,
      name: call.name,
      arguments: call.arguments,
      status: "completed"
    };
  });
  return [...(Array.isArray(output) ? output : []), ...calls];
}

export function convertDsmlToolCalls(value, compatibility = {}, requestId = "relay", requestBody = null) {
  if (!compatibilityEnabled(compatibility, "convert_dsml_tool_calls") || !value || typeof value !== "object") {
    return value;
  }
  const text = textWithDsmlCalls(value);
  const parsed = parseDsmlToolCalls(text);
  if (!parsed) {
    return value;
  }
  const target = responseTarget(value);
  const converted = { ...value };
  const convertedTarget = target === value ? converted : { ...target };
  if (parsed.visibleText) {
    convertedTarget.output_text = parsed.visibleText;
  } else {
    delete convertedTarget.output_text;
  }
  convertedTarget.output = addFunctionCallsToOutput(
    parsed.visibleText
      ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: parsed.visibleText }] }]
      : [],
    parsed,
    requestId,
    requestBody
  );
  if (target === value) {
    return convertedTarget;
  }
  converted.response = convertedTarget;
  return converted;
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
  if (providerStatePassthroughEnabled(compatibility)) {
    return body;
  }
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

export function sanitizeResponsePayload(value, compatibility = {}, requestId = "relay", requestBody = null) {
  if (providerStatePassthroughEnabled(compatibility)) {
    return value;
  }
  if (!compatibilityEnabled(compatibility, "sanitize_response_items")) {
    return value;
  }
  const converted = convertDsmlToolCalls(value, compatibility, requestId, requestBody);
  const sanitized = sanitizeResponsesValue(converted, compatibility, {
    stripRequestIds: compatibilityEnabled(compatibility, "strip_invalid_response_item_ids")
  });
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

function sanitizeSseEvent(event, compatibility, requestId = "relay", requestBody = null) {
  if (providerStatePassthroughEnabled(compatibility)) {
    return event;
  }
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
  const sanitized = sanitizeResponsePayload(parsed, compatibility, requestId, requestBody);
  if (sanitized === null) {
    return "";
  }
  const nonDataLines = lines.filter((line) => !line.startsWith("data:"));
  return `${nonDataLines.join("\n")}${nonDataLines.length ? "\n" : ""}data: ${JSON.stringify(sanitized)}\n\n`;
}

function sseEventPayload(event) {
  const data = event.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try { return JSON.parse(data); } catch { return null; }
}

function sseDeltaText(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.delta === "string") return value.delta;
  if (typeof value.text === "string" && String(value.type || "").includes("text")) return value.text;
  return typeof value.choices?.[0]?.delta?.content === "string"
    ? value.choices[0].delta.content
    : "";
}

function dsmlToolCallSse({ calls, visibleText, responseId, requestId, usage, requestBody }) {
  const events = [];
  if (visibleText) {
    events.push(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: visibleText })}\n\n`);
  }
  const suffix = String(requestId || "relay").replace(/[^A-Za-z0-9]/g, "").slice(-24) || "relay";
  const output = calls.map((rawCall, index) => {
    const call = adaptDsmlCall(rawCall, requestBody);
    const id = `fc_${suffix}_${index + 1}`;
    const item = { type: "function_call", id, call_id: `call_${suffix}_${index + 1}`, name: call.name, arguments: call.arguments, status: "completed" };
    events.push(`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } })}\n\n`);
    events.push(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: id, output_index: index, delta: call.arguments })}\n\n`);
    events.push(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: id, output_index: index, arguments: call.arguments })}\n\n`);
    events.push(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`);
    return item;
  });
  events.push(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: responseId, object: "response", status: "completed", output, ...(usage ? { usage } : {}) } })}\n\n`);
  return events.join("");
}

export function createSseSanitizer(compatibility = {}, requestId = "relay", requestBody = null) {
  if (providerStatePassthroughEnabled(compatibility)) {
    return {
      push(chunk) {
        return chunk;
      },
      flush() {
        return "";
      }
    };
  }

  let buffer = "";
  let pending = [];
  let pendingText = "";
  let dsmlDetected = false;
  const marker = DSML_TOOL_CALLS_OPEN;
  const flushPending = () => {
    const output = pending.join("");
    pending = [];
    pendingText = "";
    return output;
  };
  const convertPending = () => {
    const parsed = parseDsmlToolCalls(pendingText);
    if (!parsed) return flushPending();
    const responseId = extractResponseIdFromSse(pending.join("")) || `resp_${String(requestId).replace(/[^A-Za-z0-9]/g, "") || "relay"}`;
    const usage = extractUsageFromSse(pending.join(""));
    pending = [];
    pendingText = "";
    dsmlDetected = false;
    return dsmlToolCallSse({ calls: parsed.calls, visibleText: parsed.visibleText, responseId, requestId, usage, requestBody });
  };
  const processEvent = (event) => {
    const sanitized = sanitizeSseEvent(event, compatibility, requestId, requestBody);
    if (!sanitized) return "";
    const payload = sseEventPayload(sanitized);
    const delta = sseDeltaText(payload);
    if (!dsmlDetected && (pendingText || delta).includes(marker)) {
      dsmlDetected = true;
    }
    if (dsmlDetected || (delta && marker.startsWith((pendingText + delta).slice(-marker.length)))) {
      pending.push(sanitized);
      pendingText += delta;
      if (dsmlDetected && (sseHasTerminalEvent(sanitized) || sseHasDoneMarker(sanitized))) {
        return convertPending();
      }
      return "";
    }
    if (pending.length) {
      const before = flushPending();
      return before + sanitized;
    }
    return sanitized;
  };
  return {
    push(chunk) {
      buffer += chunk;
      let output = "";
      while (true) {
        const next = splitSseEvent(buffer);
        if (!next) {
          break;
        }
        output += processEvent(next.event);
        buffer = next.rest;
      }
      return output;
    },
    flush() {
      if (!buffer) {
        return dsmlDetected ? convertPending() : flushPending();
      }
      const output = processEvent(buffer);
      buffer = "";
      return output + (dsmlDetected ? convertPending() : flushPending());
    }
  };
}

export function requestBodyForDeployment(body, deployment, compatibility = {}) {
  const rewritten = { ...sanitizeRequestBody(body, compatibility), model: deployment.model };
  if (compatibility?.strip_previous_response_id === true) {
    delete rewritten.previous_response_id;
  }
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
  if (Array.isArray(value.response?.output)) {
    return value.response.output
      .map((item) => textFromContent(item.content))
      .filter(Boolean)
      .join("");
  }
  if (typeof value.choices?.[0]?.message?.content === "string") {
    return value.choices[0].message.content;
  }
  if (typeof value.choices?.[0]?.delta?.content === "string") {
    return value.choices[0].delta.content;
  }
  if (value.item && typeof value.item === "object") {
    return textFromContent(value.item.content);
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
        ?? value.choices?.[0]?.delta?.content
        ?? value.output_text
        ?? value.response?.output_text
        ?? extractOutputTextFromJson(value)
        ?? "";
    } catch {
      // SSE chunks can contain partial JSON while the stream is in flight.
    }
  }
  return output;
}

export function extractOutputTextDeltaFromSse(text) {
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
      if (value.type === "response.output_text.delta" && typeof value.delta === "string") {
        output += value.delta;
      } else if (typeof value.choices?.[0]?.delta?.content === "string") {
        output += value.choices[0].delta.content;
      }
    } catch {
      // Ignore incomplete SSE JSON while the stream is in flight.
    }
  }
  return output;
}

// Some Responses-compatible providers omit output_text.delta and only emit the
// completed message item or the final response object. Keep these fallbacks
// separate from deltas so the server can avoid counting the same text twice.
export function extractOutputTextPartsFromSse(text) {
  let deltaText = "";
  let itemText = "";
  let completedText = "";
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
      if (value.type === "response.output_text.delta" && typeof value.delta === "string") {
        deltaText += value.delta;
      } else if (typeof value.choices?.[0]?.delta?.content === "string") {
        deltaText += value.choices[0].delta.content;
      } else if (value.type === "response.output_text.done" && typeof value.text === "string") {
        itemText += value.text;
      } else if (value.type === "response.output_item.added" || value.type === "response.output_item.done") {
        itemText += extractOutputTextFromJson(value);
      } else if (value.type === "response.completed" || value.type === "response.done") {
        completedText = extractOutputTextFromJson(value.response ?? value) || completedText;
      }
    } catch {
      // Ignore incomplete SSE JSON while the stream is in flight.
    }
  }
  return { deltaText, itemText, completedText };
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
  );
}

export function sseHasDoneMarker(text) {
  return /(?:^|\r?\n)data:\s*\[DONE\]\s*(?:\r?\n|$)/m.test(text);
}

function fallbackResponseId(requestId) {
  return `resp_${String(requestId ?? "relay").replace(/[^A-Za-z0-9]/g, "")}`;
}

function outputFromText(outputText) {
  return outputText
    ? [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: outputText }]
      }]
    : [];
}

function completedResponsePayload({ response, responseId, requestId, outputText, usage } = {}) {
  const completedResponse = response && typeof response === "object"
    ? { ...response }
    : {};
  completedResponse.id ||= responseId || fallbackResponseId(requestId);
  completedResponse.object ||= "response";
  completedResponse.created_at ||= Math.floor(Date.now() / 1000);
  completedResponse.status = "completed";
  if (!Array.isArray(completedResponse.output) || (completedResponse.output.length === 0 && outputText)) {
    completedResponse.output = outputFromText(outputText);
  }
  if (completedResponse.usage === undefined) {
    completedResponse.usage = usage ?? null;
  }
  return completedResponse;
}

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function fallbackItemId(type, requestId, index) {
  const suffix = String(requestId || "relay").replace(/[^A-Za-z0-9]/g, "").slice(-24) || "relay";
  const prefix = {
    message: "msg",
    function_call: "fc",
    custom_tool_call: "ctc",
    reasoning: "rs"
  }[type] || "item";
  return `${prefix}_${suffix}_${index + 1}`;
}

function fallbackCallId(requestId, index) {
  const suffix = String(requestId || "relay").replace(/[^A-Za-z0-9]/g, "").slice(-24) || "relay";
  return `call_${suffix}_${index + 1}`;
}

function stringValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeOutputItem(item, requestId, index) {
  if (!item || typeof item !== "object") {
    return {
      type: "message",
      id: fallbackItemId("message", requestId, index),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: String(item ?? "") }]
    };
  }

  const normalized = { ...item };
  const type = typeof normalized.type === "string" ? normalized.type : "message";
  normalized.type = type;
  normalized.id ||= fallbackItemId(type, requestId, index);

  if (type === "message") {
    normalized.role ||= "assistant";
    normalized.status ||= "completed";
    normalized.content = Array.isArray(normalized.content)
      ? normalized.content.map((part) => (part && typeof part === "object" ? { ...part } : part))
      : [];
  } else if (type === "function_call") {
    normalized.call_id ||= fallbackCallId(requestId, index);
    normalized.arguments = stringValue(normalized.arguments);
    normalized.status ||= "completed";
  } else if (type === "custom_tool_call") {
    normalized.call_id ||= fallbackCallId(requestId, index);
    normalized.input = stringValue(normalized.input ?? normalized.arguments);
    delete normalized.arguments;
    normalized.status ||= "completed";
  }

  return normalized;
}

function outputItemForAddedEvent(item) {
  const added = { ...item };
  if (item.type === "message") {
    added.status = "in_progress";
    added.content = [];
  } else if (item.type === "function_call") {
    added.status = "in_progress";
    added.arguments = "";
  } else if (item.type === "custom_tool_call") {
    added.status = "in_progress";
    added.input = "";
  }
  return added;
}

function outputTextParts(item) {
  if (!Array.isArray(item.content)) {
    return [];
  }
  return item.content
    .map((part, contentIndex) => ({ part, contentIndex }))
    .filter(({ part }) => part?.type === "output_text" && typeof part.text === "string");
}

export function synthesizeResponseCompletedSse({ response, responseId, requestId, outputText, usage } = {}) {
  const completedResponse = completedResponsePayload({ response, responseId, requestId, outputText, usage });
  return sseEvent("response.completed", {
    type: "response.completed",
    response: completedResponse
  });
}

export function synthesizeResponseSseFromJson({ response, responseId, requestId, outputText, usage } = {}) {
  const completedResponse = completedResponsePayload({ response, responseId, requestId, outputText, usage });
  const output = completedResponse.output.map((item, index) => normalizeOutputItem(item, requestId, index));
  completedResponse.output = output;

  const events = [];
  let sequenceNumber = 0;
  const pushEvent = (type, payload) => {
    sequenceNumber += 1;
    events.push(sseEvent(type, {
      ...payload,
      sequence_number: sequenceNumber
    }));
  };

  pushEvent("response.created", {
    type: "response.created",
    response: {
      ...completedResponse,
      status: "in_progress",
      output: []
    }
  });

  output.forEach((item, outputIndex) => {
    pushEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: outputItemForAddedEvent(item)
    });

    if (item.type === "message") {
      for (const { part, contentIndex } of outputTextParts(item)) {
        pushEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: part.text
        });
        pushEvent("response.output_text.done", {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          text: part.text
        });
      }
    } else if (item.type === "function_call") {
      pushEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments
      });
      pushEvent("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        name: item.name,
        arguments: item.arguments
      });
    } else if (item.type === "custom_tool_call") {
      pushEvent("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        item_id: item.id,
        output_index: outputIndex,
        delta: item.input
      });
      pushEvent("response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done",
        item_id: item.id,
        output_index: outputIndex,
        input: item.input
      });
    }

    pushEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item
    });
  });

  pushEvent("response.completed", {
    type: "response.completed",
    response: completedResponse
  });
  events.push("data: [DONE]\n\n");
  return events.join("");
}

export function synthesizeResponseFailedSse({ responseId, requestId, message, code = "upstream_stream_interrupted" } = {}) {
  const fallbackId = `resp_${String(requestId ?? "relay").replace(/[^A-Za-z0-9]/g, "")}`;
  const response = {
    id: responseId || fallbackId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "failed",
    error: {
      code,
      message: message || "Upstream stream ended before a terminal Responses event."
    },
    output: []
  };
  return `event: response.failed\ndata: ${JSON.stringify({
    type: "response.failed",
    response
  })}\n\n`;
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
