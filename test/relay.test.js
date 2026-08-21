import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadConfig, validateConfig } from "../src/config.js";
import { classifyUpstreamFailure } from "../src/classifier.js";
import { ensureEnvValues, loadEnvFile, parseEnv } from "../src/env.js";
import { createRelayServer } from "../src/server.js";
import { RuntimeState, createRuntimeState } from "../src/state.js";
import { sseHasTerminalEvent } from "../src/upstream.js";

const execFileAsync = promisify(execFile);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function httpRequest(port, requestPath, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function request(port, body, headers = {}) {
  return httpRequest(port, "/v1/responses", "POST", body, headers);
}

function reloadRequest(port, headers = {}) {
  return httpRequest(port, "/admin/reload", "POST", undefined, headers);
}

function configFor(upstreams, options = {}) {
  return validateConfig({
    server: {
      host: "127.0.0.1",
      port: 0,
      ...(options.public_api_key ? { public_api_key: options.public_api_key } : {}),
      ...(options.admin_api_key ? { admin_api_key: options.admin_api_key } : {}),
      request_timeout_ms: options.request_timeout_ms ?? 5000,
      max_body_bytes: 1024 * 1024
    },
    routing: {
      max_attempts: options.max_attempts ?? 4,
      max_provider_fallbacks: 3,
      retry_backoff_ms: 0,
      cooldowns: {
        rate_limited_ms: 1000,
        transient_ms: 1000,
        auth_ms: 1000,
        billing_ms: 1000
      },
      ...(options.provider_error_rules
        ? { provider_error_rules: options.provider_error_rules }
        : {})
    },
    ...(options.state ? { state: options.state } : {}),
    models: {
      codex: {
        aliases: ["gpt-test"],
        deployments: upstreams
      }
    }
  });
}

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-relay-test-"));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

test("classifies quota errors as key-level failover", () => {
  const classification = classifyUpstreamFailure({
    status: 402,
    body: JSON.stringify({ error: { code: "insufficient_quota", message: "No balance" } })
  });
  assert.equal(classification.kind, "billing_or_quota");
  assert.equal(classification.rotateKey, true);
  assert.equal(classification.retryable, true);
});

test("recognizes terminal Responses SSE events", () => {
  assert.equal(
    sseHasTerminalEvent(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n'
    ),
    true
  );
  assert.equal(sseHasTerminalEvent("data: [DONE]\n\n"), true);
  assert.equal(
    sseHasTerminalEvent('event: response.output_text.delta\ndata: {"delta":"hi"}\n\n'),
    false
  );
});

test("parses dotenv-style environment files", () => {
  const values = parseEnv(`
    # local secrets
    RELAY_API_KEY=local-relay-key
    export RELAY_ADMIN_KEY="admin key"
    UPSTREAM_A_KEY_1='literal#key'
    UPSTREAM_A_KEY_2=value # comment
    MULTILINE="hello\\nworld"
  `);

  assert.equal(values.RELAY_API_KEY, "local-relay-key");
  assert.equal(values.RELAY_ADMIN_KEY, "admin key");
  assert.equal(values.UPSTREAM_A_KEY_1, "literal#key");
  assert.equal(values.UPSTREAM_A_KEY_2, "value");
  assert.equal(values.MULTILINE, "hello\nworld");
});

test("loads .env without overriding existing process environment", async () => {
  const directory = await temporaryDirectory();
  const envPath = path.join(directory, ".env");
  const previous = process.env.RELAY_ENV_TEST_VALUE;
  process.env.RELAY_ENV_TEST_VALUE = "from-shell";
  await fs.writeFile(
    envPath,
    [
      "RELAY_ENV_TEST_VALUE=from-file",
      "RELAY_ENV_TEST_NEW=created"
    ].join("\n")
  );

  try {
    const result = await loadEnvFile(envPath);

    assert.equal(result.loaded, true);
    assert.equal(process.env.RELAY_ENV_TEST_VALUE, "from-shell");
    assert.equal(process.env.RELAY_ENV_TEST_NEW, "created");
    assert.deepEqual(result.keys, ["RELAY_ENV_TEST_NEW"]);
  } finally {
    if (previous === undefined) {
      delete process.env.RELAY_ENV_TEST_VALUE;
    } else {
      process.env.RELAY_ENV_TEST_VALUE = previous;
    }
    delete process.env.RELAY_ENV_TEST_NEW;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("generates missing internal relay secrets in .env", async () => {
  const directory = await temporaryDirectory();
  const envPath = path.join(directory, ".env");
  const previous = {
    relayApi: process.env.RELAY_API_KEY,
    relayAdmin: process.env.RELAY_ADMIN_KEY
  };
  delete process.env.RELAY_API_KEY;
  delete process.env.RELAY_ADMIN_KEY;

  try {
    const result = await ensureEnvValues(envPath, ["RELAY_API_KEY", "RELAY_ADMIN_KEY"]);
    assert.equal(result.updated, true);
    assert.deepEqual(result.keys.sort(), ["RELAY_ADMIN_KEY", "RELAY_API_KEY"]);
    const values = parseEnv(await fs.readFile(envPath, "utf8"));
    assert.match(values.RELAY_API_KEY, /^relay-/);
    assert.match(values.RELAY_ADMIN_KEY, /^relay-/);
    assert.equal(process.env.RELAY_API_KEY, values.RELAY_API_KEY);
    assert.equal(process.env.RELAY_ADMIN_KEY, values.RELAY_ADMIN_KEY);
  } finally {
    for (const [key, value] of Object.entries({
      RELAY_API_KEY: previous.relayApi,
      RELAY_ADMIN_KEY: previous.relayAdmin
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("loads config with missing env secrets so the web console can initialize them", async () => {
  const directory = await temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  await writeJson(configPath, {
    server: {
      host: "127.0.0.1",
      port: 0,
      public_api_key: "env:RELAY_API_KEY",
      admin_api_key: "env:RELAY_ADMIN_KEY"
    },
    models: {
      codex: {
        deployments: [
          {
            id: "missing-key",
            provider: "provider-a",
            base_url: "http://127.0.0.1:1/v1",
            model: "upstream-model",
            api_key: "env:UPSTREAM_MISSING_KEY"
          }
        ]
      }
    }
  });
  const previous = {
    relayApi: process.env.RELAY_API_KEY,
    relayAdmin: process.env.RELAY_ADMIN_KEY,
    upstream: process.env.UPSTREAM_MISSING_KEY
  };
  delete process.env.RELAY_API_KEY;
  delete process.env.RELAY_ADMIN_KEY;
  delete process.env.UPSTREAM_MISSING_KEY;

  try {
    const loaded = await loadConfig(configPath);
    assert.equal(loaded.server.public_api_key, undefined);
    assert.equal(loaded.server.admin_api_key, undefined);
    assert.equal(loaded.models.codex.deployments[0].api_key, "missing-env:UPSTREAM_MISSING_KEY");
  } finally {
    for (const [key, value] of Object.entries({
      RELAY_API_KEY: previous.relayApi,
      RELAY_ADMIN_KEY: previous.relayAdmin,
      UPSTREAM_MISSING_KEY: previous.upstream
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("records usage and leaves reasoning controls untouched", async () => {
  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp-usage",
        model: upstreamBody.model,
        output: [],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18
        }
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({
    server: {
      host: "127.0.0.1",
      port: 0,
      request_timeout_ms: 5000,
      max_body_bytes: 1024 * 1024
    },
    routing: {
      max_attempts: 1,
      max_provider_fallbacks: 0,
      retry_backoff_ms: 0
    },
    models: {
      codex: {
        aliases: ["gpt-test"],
        deployments: [
          {
            id: "usage-deployment",
            provider: "provider-a",
            base_url: `http://127.0.0.1:${upstreamPort}/v1`,
            model: "default-upstream-model",
            api_key: "key",
            priority: 10,
            weight: 1
          }
        ]
      }
    }
  });
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      reasoning: { effort: "high" },
      stream: false
    });

    assert.equal(result.status, 200);
    assert.equal(upstreamBody.model, "default-upstream-model");
    assert.deepEqual(upstreamBody.reasoning, { effort: "high" });

    const status = JSON.parse((await httpRequest(relayPort, "/api/status", "GET")).body);
    assert.equal(status.deployments[0].token_usage.total_tokens, 18);
    assert.equal(status.deployments[0].last_request.requested_model, "gpt-test");
    assert.equal(status.deployments[0].last_request.logical_model, "codex");
    assert.equal(status.deployments[0].last_request.upstream_model, "default-upstream-model");
    assert.equal(status.deployments[0].last_request.response_text, "");
    assert.equal(status.recent_calls[0].upstream_model, "default-upstream-model");
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("sanitizes invalid reasoning items before replaying request history", async () => {
  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp-sanitized-request",
        output_text: "OK"
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "sanitize-request",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "key"
    }
  ], { max_attempts: 1 });
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: [
        {
          type: "message",
          id: "item_bad_message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }]
        },
        {
          type: "reasoning",
          id: "item_31ee91eb42252ff00aa0a9eb",
          summary: [{ type: "summary_text", text: "third party reasoning" }]
        },
        {
          type: "reasoning",
          id: "rs_valid",
          summary: [{ type: "summary_text", text: "official reasoning" }]
        }
      ],
      stream: false
    });

    assert.equal(result.status, 200);
    assert.equal(upstreamBody.model, "upstream-model");
    assert.equal(upstreamBody.input.length, 2);
    assert.equal(upstreamBody.input[0].type, "message");
    assert.equal("id" in upstreamBody.input[0], false);
    assert.equal(upstreamBody.input[1].id, "rs_valid");
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("sanitizes invalid reasoning items from non-stream Responses payloads", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp-sanitized-response",
        output: [
          {
            type: "reasoning",
            id: "item_bad_reasoning",
            summary: [{ type: "summary_text", text: "bad provider state" }]
          },
          {
            type: "message",
            id: "msg_ok",
            role: "assistant",
            content: [{ type: "output_text", text: "OK" }]
          }
        ],
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5
        }
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "sanitize-response",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "key"
    }
  ], { max_attempts: 1 });
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: false
    });
    const payload = JSON.parse(result.body);

    assert.equal(result.status, 200);
    assert.equal(payload.output.length, 1);
    assert.equal(payload.output[0].id, "msg_ok");
    assert.equal(result.body.includes("item_bad_reasoning"), false);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("sanitizes invalid reasoning items from Responses SSE events", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"reasoning","id":"item_bad_reasoning","summary":[]}}\n\n');
      res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","id":"msg_ok","role":"assistant","content":[]}}\n\n');
      res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-sse","output":[{"type":"reasoning","id":"item_bad_reasoning","summary":[]},{"type":"message","id":"msg_ok","role":"assistant","content":[]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n');
      res.end();
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "sanitize-sse",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "key"
    }
  ], { max_attempts: 1 });
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: true
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.includes("item_bad_reasoning"), false);
    assert.equal(result.body.includes("msg_ok"), true);
    assert.equal(result.body.includes("response.completed"), true);
    const status = JSON.parse((await httpRequest(relayPort, "/api/status", "GET")).body);
    assert.equal(status.deployments[0].token_usage.total_tokens, 2);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("admin test deployment records returned text in recent call logs", async () => {
  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp-test",
        output_text: "OK from test model",
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          total_tokens: 7
        }
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "testable-deployment",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-test-model",
      api_key: "key",
      priority: 10,
      weight: 1
    }
  ]);
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await httpRequest(
      relayPort,
      "/admin/test-deployment",
      "POST",
      { deployment_id: "testable-deployment", input: "ping" }
    );

    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.model, "upstream-test-model");
    assert.equal(payload.response_text, "OK from test model");
    assert.equal(upstreamBody.model, "upstream-test-model");
    assert.equal(upstreamBody.input, "ping");

    const recent = payload.status.recent_calls[0];
    assert.equal(recent.result, "success");
    assert.equal(recent.deployment_id, "testable-deployment");
    assert.equal(recent.response_text, "OK from test model");
    assert.equal(recent.usage.total_tokens, 7);

    const callsResult = await httpRequest(relayPort, "/admin/calls?offset=0&limit=10", "GET");
    assert.equal(callsResult.status, 200);
    const callsPayload = JSON.parse(callsResult.body);
    assert.equal(callsPayload.total, 1);
    assert.equal(callsPayload.calls[0].deployment_id, "testable-deployment");
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("shares cooldown, affinity, counters, and cursors across file-backed instances", async () => {
  const directory = await temporaryDirectory();
  const statePath = path.join(directory, "runtime-state.json");
  const config = configFor(
    [
      {
        id: "shared-deployment",
        provider: "provider-a",
        base_url: "http://127.0.0.1:1/v1",
        model: "upstream-model",
        api_key: "one",
        priority: 10,
        weight: 1
      }
    ],
    {
      state: {
        store: "file",
        file_path: statePath,
        lock_timeout_ms: 250,
        stale_lock_ms: 1000
      }
    }
  );
  const deployment = config.models.codex.deployments[0];
  const first = createRuntimeState(config);
  const second = createRuntimeState(config);
  const failure = {
    kind: "billing_or_quota",
    code: "insufficient_quota",
    message: "empty",
    status: 402
  };

  try {
    first.recordAttempt(deployment);
    first.recordFailure(deployment, failure, 60000);
    first.setAffinity("shared-response", deployment.id, 60000);
    second.recordAttempt(deployment);

    assert.equal(second.isAvailable(deployment), false);
    assert.equal(second.getAffinity("shared-response"), deployment.id);
    assert.equal(second.nextCursor("codex:10"), 0);
    assert.equal(first.nextCursor("codex:10"), 1);

    const snapshot = second.snapshot([deployment]);
    assert.equal(snapshot[0].attempts, 2);
    assert.equal(snapshot[0].failures, 1);
    assert.equal(snapshot[0].status, "cooling_down");
    assert.equal(snapshot[0].last_error.code, "insufficient_quota");
    assert.equal(await fs.stat(statePath).then(() => true), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("file-backed state uses a default path and persists usage", async () => {
  const directory = await temporaryDirectory();
  const previousCwd = process.cwd();
  process.chdir(directory);
  const config = configFor(
    [
      {
        id: "state-validation",
        provider: "provider-a",
        base_url: "http://127.0.0.1:1/v1",
        model: "upstream-model",
        api_key: "one"
      }
    ],
    { state: { store: "file" } }
  );
  const deployment = config.models.codex.deployments[0];
  try {
    assert.equal(config.state.file_path, ".codex-relay-state.json");
    const first = createRuntimeState(config);
    first.recordSuccess(deployment, {
      requested_model: "gpt-test",
      logical_model: "codex",
      upstream_model: "upstream-model",
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      duration_ms: 20,
      response_text: "ok"
    });
    const second = createRuntimeState(config);
    const snapshot = second.snapshot([deployment]);
    assert.equal(snapshot[0].token_usage.total_tokens, 5);
    assert.equal(second.usageSummary().week.total.total_tokens, 5);
    assert.equal(second.usageSummary().year.total.total_tokens, 5);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runtime call history supports pagination", () => {
  const state = new RuntimeState();
  const deployment = {
    id: "history-key",
    provider: "provider-a",
    base_url: "http://127.0.0.1:1/v1",
    model: "upstream-model",
    api_key: "one"
  };
  for (let index = 0; index < 25; index += 1) {
    state.recordSuccess(deployment, {
      request_id: `request-${index}`,
      requested_model: "gpt-test",
      logical_model: "codex",
      upstream_model: "upstream-model",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      duration_ms: 20,
      response_text: `ok-${index}`
    });
  }

  const firstPage = state.callHistory({ offset: 0, limit: 20 });
  const secondPage = state.callHistory({ offset: 20, limit: 20 });

  assert.equal(firstPage.total, 25);
  assert.equal(firstPage.calls.length, 20);
  assert.equal(firstPage.calls[0].request_id, "request-24");
  assert.equal(secondPage.offset, 20);
  assert.equal(secondPage.calls.length, 5);
  assert.equal(secondPage.calls[0].request_id, "request-4");
});

test("applies provider-specific error rules before generic classification", () => {
  const billing = classifyUpstreamFailure({
    status: 400,
    body: { error: { code: "credits_depleted", message: "provider says no credits" } },
    rules: {
      billing_codes: ["credits_depleted"]
    }
  });
  const rateLimited = classifyUpstreamFailure({
    status: 409,
    body: { error: { message: "temporarily busy" } },
    rules: {
      rate_limit_statuses: [409]
    }
  });

  assert.equal(billing.kind, "billing_or_quota");
  assert.equal(billing.rotateKey, true);
  assert.equal(rateLimited.kind, "rate_limited");
  assert.equal(rateLimited.rotateKey, true);
});

test("provider-specific non-retryable status prevents failover", async () => {
  let backupCalls = 0;
  const first = http.createServer((req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unsupported request" } }));
  });
  const backup = http.createServer((req, res) => {
    backupCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "should-not-run" }));
  });
  const firstPort = await listen(first);
  const backupPort = await listen(backup);
  const config = configFor(
    [
      {
        id: "provider-a-primary",
        provider: "provider-a",
        base_url: `http://127.0.0.1:${firstPort}/v1`,
        model: "upstream-model",
        api_key: "one",
        priority: 10,
        weight: 1
      },
      {
        id: "provider-a-backup",
        provider: "provider-a",
        base_url: `http://127.0.0.1:${backupPort}/v1`,
        model: "upstream-model",
        api_key: "two",
        priority: 10,
        weight: 1
      }
    ],
    {
      provider_error_rules: {
        "provider-a": {
          non_retryable_statuses: [409]
        }
      }
    }
  );
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello"
    });

    assert.equal(result.status, 409);
    assert.match(result.body, /unsupported request/);
    assert.equal(backupCalls, 0);
  } finally {
    await close(relay);
    await close(first);
    await close(backup);
  }
});

test("fails over from a billing failure to a healthy deployment", async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const first = http.createServer((req, res) => {
    firstCalls += 1;
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "insufficient_quota", message: "empty" } }));
  });
  const second = http.createServer((req, res) => {
    secondCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp-good", object: "response", output_text: "hello" }));
  });
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const config = configFor([
    {
      id: "bad-key",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${firstPort}/v1`,
      model: "upstream-model",
      api_key: "bad",
      priority: 10,
      weight: 1
    },
    {
      id: "good-key",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${secondPort}/v1`,
      model: "upstream-model",
      api_key: "good",
      priority: 10,
      weight: 1
    }
  ]);
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello"
    });

    assert.equal(result.status, 200);
    assert.match(result.body, /resp-good/);
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 1);
  } finally {
    await close(relay);
    await close(first);
    await close(second);
  }
});

test("fails over before committing a Responses SSE stream", async () => {
  const first = http.createServer((req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "temporary" } }));
  });
  const second = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.flushHeaders();
    res.write("event: response.created\n");
    res.write('data: {"id":"resp-stream","type":"response.created"}\n\n');
    res.write("event: response.completed\n");
    res.end('data: {"id":"resp-stream","type":"response.completed"}\n\n');
  });
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const config = configFor([
    {
      id: "unstable",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${firstPort}/v1`,
      model: "upstream-model",
      api_key: "one",
      priority: 10,
      weight: 1
    },
    {
      id: "stream-good",
      provider: "provider-b",
      base_url: `http://127.0.0.1:${secondPort}/v1`,
      model: "upstream-model",
      api_key: "two",
      priority: 20,
      weight: 1
    }
  ]);
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: true
    });

    assert.equal(result.status, 200);
    assert.match(result.headers["content-type"], /text\/event-stream/);
    assert.match(result.body, /response\.created/);
    assert.match(result.body, /resp-stream/);
  } finally {
    await close(relay);
    await close(first);
    await close(second);
  }
});

test("fails over when an upstream SSE stream closes before the first event", async () => {
  let backupCalls = 0;
  const first = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.end();
  });
  const second = http.createServer((req, res) => {
    backupCalls += 1;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.end('data: {"id":"resp-empty-fallback","type":"response.completed"}\n\n');
  });
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const config = configFor(
    [
      {
        id: "empty-stream",
        provider: "provider-a",
        base_url: `http://127.0.0.1:${firstPort}/v1`,
        model: "upstream-model",
        api_key: "one",
        priority: 10,
        weight: 1
      },
      {
        id: "empty-stream-backup",
        provider: "provider-b",
        base_url: `http://127.0.0.1:${secondPort}/v1`,
        model: "upstream-model",
        api_key: "two",
        priority: 20,
        weight: 1
      }
    ],
    { max_attempts: 2 }
  );
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: true
    });

    assert.equal(result.status, 200);
    assert.match(result.body, /resp-empty-fallback/);
    assert.equal(backupCalls, 1);
  } finally {
    await close(relay);
    await close(first);
    await close(second);
  }
});

test("fails over when the first SSE event exceeds the upstream timeout", async () => {
  let firstClosed = false;
  const first = http.createServer((req, res) => {
    res.on("close", () => {
      firstClosed = true;
    });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.flushHeaders();
    setTimeout(() => res.end(), 200);
  });
  const second = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.end('data: {"id":"resp-timeout-fallback","type":"response.completed"}\n\n');
  });
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const config = configFor(
    [
      {
        id: "slow-stream",
        provider: "provider-a",
        base_url: `http://127.0.0.1:${firstPort}/v1`,
        model: "upstream-model",
        api_key: "one",
        priority: 10,
        weight: 1
      },
      {
        id: "slow-stream-backup",
        provider: "provider-b",
        base_url: `http://127.0.0.1:${secondPort}/v1`,
        model: "upstream-model",
        api_key: "two",
        priority: 20,
        weight: 1
      }
    ],
    {
      max_attempts: 2,
      request_timeout_ms: 60
    }
  );
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: true
    });

    assert.equal(result.status, 200);
    assert.match(result.body, /resp-timeout-fallback/);
    assert.equal(firstClosed, true);
  } finally {
    await close(relay);
    await close(first);
    await close(second);
  }
});

test("does not fail over after an SSE stream has committed its first event", async () => {
  let backupCalls = 0;
  const first = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.write('data: {"id":"resp-partial","type":"response.created"}\n\n');
    setTimeout(() => res.destroy(), 20);
  });
  const second = http.createServer((req, res) => {
    backupCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "should-not-run" }));
  });
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const config = configFor([
    {
      id: "partial-stream",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${firstPort}/v1`,
      model: "upstream-model",
      api_key: "one",
      priority: 10,
      weight: 1
    },
    {
      id: "partial-stream-backup",
      provider: "provider-b",
      base_url: `http://127.0.0.1:${secondPort}/v1`,
      model: "upstream-model",
      api_key: "two",
      priority: 20,
      weight: 1
    }
  ]);
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: true
    });
    const snapshot = state.snapshot(config.models.codex.deployments);

    assert.equal(result.status, 200);
    assert.match(result.body, /resp-partial/);
    assert.equal(backupCalls, 0);
    assert.equal(snapshot[0].status, "cooling_down");
    assert.equal(snapshot[0].last_error.kind, "upstream_transient");
  } finally {
    await close(relay);
    await close(first);
    await close(second);
  }
});

test("times out while reading a non-stream upstream response body", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    setTimeout(() => res.end(JSON.stringify({ id: "too-late" })), 250);
  });
  const port = await listen(upstream);
  const config = configFor(
    [
      {
        id: "slow-body",
        provider: "provider-a",
        base_url: `http://127.0.0.1:${port}/v1`,
        model: "upstream-model",
        api_key: "one",
        priority: 10,
        weight: 1
      }
    ],
    {
      max_attempts: 1,
      request_timeout_ms: 60
    }
  );
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello"
    });
    const snapshot = state.snapshot(config.models.codex.deployments);

    assert.equal(result.status, 502);
    assert.match(result.body, /upstream_exhausted/);
    assert.equal(snapshot[0].last_error.code, "upstream_timeout");
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("aborting the client request cancels the upstream without retrying", async () => {
  let upstreamStartedResolve;
  let upstreamAbortedResolve;
  const upstreamStarted = new Promise((resolve) => {
    upstreamStartedResolve = resolve;
  });
  const upstreamAborted = new Promise((resolve) => {
    upstreamAbortedResolve = resolve;
  });
  const upstream = http.createServer((req, res) => {
    upstreamStartedResolve();
    req.on("aborted", () => upstreamAbortedResolve());
  });
  const upstreamPort = await listen(upstream);
  const config = configFor(
    [
      {
        id: "cancel-primary",
        provider: "provider-a",
        base_url: `http://127.0.0.1:${upstreamPort}/v1`,
        model: "upstream-model",
        api_key: "one",
        priority: 10,
        weight: 1
      },
      {
        id: "cancel-backup",
        provider: "provider-b",
        base_url: `http://127.0.0.1:${upstreamPort}/v1`,
        model: "upstream-model",
        api_key: "two",
        priority: 20,
        weight: 1
      }
    ],
    {
      max_attempts: 2,
      request_timeout_ms: 1000
    }
  );
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const client = http.request({
      host: "127.0.0.1",
      port: relayPort,
      path: "/v1/responses",
      method: "POST",
      headers: { "content-type": "application/json" }
    });
    client.on("error", () => {});
    client.end(JSON.stringify({ model: "gpt-test", input: "cancel me" }));
    await withTimeout(upstreamStarted, 1000);
    client.destroy();
    await withTimeout(upstreamAborted, 1000);

    const snapshot = state.snapshot(config.models.codex.deployments);
    assert.equal(snapshot[0].attempts, 1);
    assert.equal(snapshot[0].failures, 0);
    assert.equal(snapshot[1].attempts, 0);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("keeps Responses affinity on the successful deployment", async () => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: calls === 1 ? "resp-affinity" : "resp-follow-up",
        object: "response",
        output_text: "ok"
      })
    );
  });
  const port = await listen(upstream);
  const config = configFor([
    {
      id: "sticky-deployment",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${port}/v1`,
      model: "upstream-model",
      api_key: "one",
      priority: 10,
      weight: 1
    },
    {
      id: "backup-deployment",
      provider: "provider-b",
      base_url: `http://127.0.0.1:${port}/v1`,
      model: "upstream-model",
      api_key: "two",
      priority: 20,
      weight: 1
    }
  ]);
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const first = await request(relayPort, {
      model: "gpt-test",
      input: "first"
    });
    const second = await request(relayPort, {
      model: "gpt-test",
      previous_response_id: "resp-affinity",
      input: "second"
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(second.body, /resp-follow-up/);
    assert.equal(calls, 2);
    assert.equal(state.getAffinity("resp-affinity"), "sticky-deployment");
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("public status does not expose upstream endpoints", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "status-response" }));
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "status-deployment",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "one",
      priority: 10,
      weight: 1
    }
  ]);
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const response = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${relayPort}/api/status/public`, (result) => {
        const chunks = [];
        result.on("data", (chunk) => chunks.push(chunk));
        result.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      }).on("error", reject);
    });
    assert.equal(response.deployments[0].id, "status-deployment");
    assert.equal("base_url" in response.deployments[0], false);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("reloads config without replacing runtime state", async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const first = http.createServer((req, res) => {
    firstCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "from-first" }));
  });
  const second = http.createServer((req, res) => {
    secondCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "from-second" }));
  });
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const config = configFor(
    [
      {
        id: "reload-deployment",
        provider: "provider-a",
        base_url: `http://127.0.0.1:${firstPort}/v1`,
        model: "upstream-model",
        api_key: "one",
        priority: 10,
        weight: 1
      }
    ],
    { admin_api_key: "admin" }
  );
  const nextConfig = JSON.parse(JSON.stringify(config));
  nextConfig.models.codex.deployments[0].base_url = `http://127.0.0.1:${secondPort}/v1`;
  const directory = await temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  await writeJson(configPath, nextConfig);
  const state = new RuntimeState();
  state.setAffinity("keep-affinity", "reload-deployment", 60000);
  const relay = createRelayServer(config, state, {
    configPath,
    logger: () => {}
  });
  const relayPort = await listen(relay);

  try {
    const unauthorized = await reloadRequest(relayPort);
    assert.equal(unauthorized.status, 401);

    const reloaded = await reloadRequest(relayPort, {
      authorization: "Bearer admin"
    });
    const reloadBody = JSON.parse(reloaded.body);
    assert.equal(reloaded.status, 200);
    assert.equal(reloadBody.status, "reloaded");
    assert.equal(reloadBody.deployments, 1);
    assert.equal(state.getAffinity("keep-affinity"), "reload-deployment");

    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello"
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /from-second/);
    assert.equal(firstCalls, 0);
    assert.equal(secondCalls, 1);
  } finally {
    await close(relay);
    await close(first);
    await close(second);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("keeps the previous config when reload fails", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "old-config-still-active" }));
  });
  const upstreamPort = await listen(upstream);
  const config = configFor(
    [
      {
        id: "stable-deployment",
        provider: "provider-a",
        base_url: `http://127.0.0.1:${upstreamPort}/v1`,
        model: "upstream-model",
        api_key: "one",
        priority: 10,
        weight: 1
      }
    ],
    { admin_api_key: "admin" }
  );
  const directory = await temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  await fs.writeFile(configPath, "{ invalid json");
  const relay = createRelayServer(config, new RuntimeState(), {
    configPath,
    logger: () => {}
  });
  const relayPort = await listen(relay);

  try {
    const reload = await reloadRequest(relayPort, {
      authorization: "Bearer admin"
    });
    const reloadBody = JSON.parse(reload.body);
    assert.equal(reload.status, 400);
    assert.equal(reloadBody.error.type, "config_reload_failed");

    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello"
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /old-config-still-active/);
    assert.equal(upstreamCalls, 1);
  } finally {
    await close(relay);
    await close(upstream);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("admin config API redacts direct secrets and saves with hot reload", async () => {
  const directory = await temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  const rawConfig = {
    server: {
      host: "127.0.0.1",
      port: 0,
      admin_api_key: "admin-secret",
      request_timeout_ms: 5000,
      max_body_bytes: 1024 * 1024
    },
    routing: {
      max_attempts: 2,
      max_provider_fallbacks: 1,
      retry_backoff_ms: 0
    },
    models: {
      codex: {
        aliases: ["gpt-test"],
        deployments: [
          {
            id: "direct-secret",
            provider: "provider-a",
            base_url: "http://127.0.0.1:1/v1",
            model: "upstream-model",
            api_key: "real-upstream-key",
            priority: 10,
            weight: 1
          }
        ]
      }
    }
  };
  await writeJson(configPath, rawConfig);
  const config = validateConfig(JSON.parse(JSON.stringify(rawConfig)));
  const relay = createRelayServer(config, new RuntimeState(), {
    configPath,
    logger: () => {},
    codexConfigPath: path.join(directory, "codex.toml")
  });
  const relayPort = await listen(relay);

  try {
    const loaded = await httpRequest(relayPort, "/admin/config", "GET", undefined, {
      authorization: "Bearer admin-secret"
    });
    assert.equal(loaded.status, 200);
    const payload = JSON.parse(loaded.body);
    assert.equal(payload.config.server.admin_api_key, "secret:server:admin_api_key");
    assert.equal(
      payload.config.models.codex.deployments[0].api_key,
      "secret:deployment:direct-secret:api_key"
    );
    assert.doesNotMatch(loaded.body, /real-upstream-key/);

    payload.config.models.codex.deployments[0].priority = 7;
    const saved = await httpRequest(
      relayPort,
      "/admin/config",
      "PUT",
      { config: payload.config },
      { authorization: "Bearer admin-secret" }
    );
    assert.equal(saved.status, 200);
    const savedPayload = JSON.parse(saved.body);
    assert.equal(savedPayload.config.models.codex.deployments[0].priority, 7);
    assert.equal(config.models.codex.deployments[0].priority, 7);

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(written.server.admin_api_key, "admin-secret");
    assert.equal(written.models.codex.deployments[0].api_key, "real-upstream-key");
    assert.equal(written.models.codex.deployments[0].priority, 7);
  } finally {
    await close(relay);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("admin env API saves secrets and reloads runtime configuration", async () => {
  const directory = await temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  const envPath = path.join(directory, ".env");
  const rawConfig = {
    server: {
      host: "127.0.0.1",
      port: 0,
      public_api_key: "env:RELAY_API_KEY",
      admin_api_key: "env:RELAY_ADMIN_KEY",
      request_timeout_ms: 5000,
      max_body_bytes: 1024 * 1024
    },
    routing: {
      max_attempts: 1,
      max_provider_fallbacks: 0,
      retry_backoff_ms: 0
    },
    models: {
      codex: {
        aliases: ["gpt-test"],
        deployments: [
          {
            id: "env-managed-key",
            provider: "provider-a",
            base_url: "http://127.0.0.1:1/v1",
            model: "upstream-model",
            api_key: "env:UPSTREAM_ENV_MANAGED_KEY",
            priority: 10,
            weight: 1
          }
        ]
      }
    }
  };
  const previous = {
    relayApi: process.env.RELAY_API_KEY,
    relayAdmin: process.env.RELAY_ADMIN_KEY,
    upstream: process.env.UPSTREAM_ENV_MANAGED_KEY
  };
  delete process.env.RELAY_API_KEY;
  delete process.env.RELAY_ADMIN_KEY;
  delete process.env.UPSTREAM_ENV_MANAGED_KEY;
  await writeJson(configPath, rawConfig);
  const config = await loadConfig(configPath);
  const relay = createRelayServer(config, new RuntimeState(), {
    configPath,
    envPath,
    logger: () => {},
    codexConfigPath: path.join(directory, "codex.toml")
  });
  const relayPort = await listen(relay);

  try {
    assert.equal(config.server.admin_api_key, undefined);
    assert.equal(config.models.codex.deployments[0].api_key, "missing-env:UPSTREAM_ENV_MANAGED_KEY");

    const saved = await httpRequest(
      relayPort,
      "/admin/env",
      "PUT",
      {
        values: {
          RELAY_API_KEY: "relay-key",
          RELAY_ADMIN_KEY: "admin-secret",
          UPSTREAM_ENV_MANAGED_KEY: "upstream-secret"
        }
      }
    );
    assert.equal(saved.status, 200);
    assert.equal(config.server.admin_api_key, "admin-secret");
    assert.equal(config.models.codex.deployments[0].api_key, "upstream-secret");

    const unauthorized = await httpRequest(relayPort, "/admin/config", "GET");
    assert.equal(unauthorized.status, 401);

    const authorized = await httpRequest(relayPort, "/admin/config", "GET", undefined, {
      authorization: "Bearer admin-secret"
    });
    assert.equal(authorized.status, 200);
    const payload = JSON.parse(authorized.body);
    assert.equal(
      payload.env.keys.find((item) => item.name === "UPSTREAM_ENV_MANAGED_KEY").configured,
      true
    );
    assert.equal(payload.env.keys.find((item) => item.name === "RELAY_API_KEY").internal, true);
    assert.equal(payload.env.keys.find((item) => item.name === "RELAY_ADMIN_KEY").internal, true);
    assert.equal(payload.env.keys.find((item) => item.name === "UPSTREAM_ENV_MANAGED_KEY").internal, false);
    assert.doesNotMatch(authorized.body, /upstream-secret/);
    assert.match(await fs.readFile(envPath, "utf8"), /UPSTREAM_ENV_MANAGED_KEY=upstream-secret/);
  } finally {
    await close(relay);
    for (const [key, value] of Object.entries({
      RELAY_API_KEY: previous.relayApi,
      RELAY_ADMIN_KEY: previous.relayAdmin,
      UPSTREAM_ENV_MANAGED_KEY: previous.upstream
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("admin codex config endpoint switches between openai and relay", async () => {
  const directory = await temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  const codexConfigPath = path.join(directory, "codex.toml");
  const codexStatePath = path.join(directory, "state_5.sqlite");
  const rawConfig = {
    server: {
      host: "127.0.0.1",
      port: 8787,
      admin_api_key: "admin-secret",
      request_timeout_ms: 5000,
      max_body_bytes: 1024 * 1024
    },
    routing: {
      max_attempts: 1,
      max_provider_fallbacks: 0,
      retry_backoff_ms: 0
    },
    models: {
      codex: {
        aliases: ["gpt-test"],
        deployments: [
          {
            id: "provider-key",
            provider: "provider-a",
            base_url: "http://127.0.0.1:1/v1",
            model: "upstream-model",
            api_key: "key",
            priority: 10,
            weight: 1
          }
        ]
      }
    }
  };
  await writeJson(configPath, rawConfig);
  await execFileAsync("sqlite3", [
    codexStatePath,
    [
      "CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL);",
      "INSERT INTO threads (id, model_provider) VALUES ('one', 'openai'), ('two', 'openai');"
    ].join(" ")
  ]);
  const relay = createRelayServer(
    validateConfig(JSON.parse(JSON.stringify(rawConfig))),
    new RuntimeState(),
    {
      configPath,
      codexConfigPath,
      codexStatePath,
      logger: () => {}
    }
  );
  const relayPort = await listen(relay);

  try {
    const relayResult = await httpRequest(
      relayPort,
      "/admin/codex-config",
      "POST",
      { model_provider: "relay" },
      { authorization: "Bearer admin-secret" }
    );
    assert.equal(relayResult.status, 200);
    const relayPayload = JSON.parse(relayResult.body);
    assert.equal(relayPayload.codex.threads.updated, 2);
    assert.equal(
      (await execFileAsync("sqlite3", [codexStatePath, "SELECT DISTINCT model_provider FROM threads;"]))
        .stdout.trim(),
      "relay"
    );
    const relayAgainResult = await httpRequest(
      relayPort,
      "/admin/codex-config",
      "POST",
      { model_provider: "relay" },
      { authorization: "Bearer admin-secret" }
    );
    assert.equal(relayAgainResult.status, 200);
    const relayContent = await fs.readFile(codexConfigPath, "utf8");
    assert.match(relayContent, /model_provider = "relay"/);
    assert.match(relayContent, /\[model_providers\.relay\]/);
    assert.match(relayContent, /\[model_providers\.relay\.auth\]/);
    assert.equal(relayContent.match(/\[model_providers\.relay\]/g).length, 1);
    assert.equal(relayContent.match(/\[model_providers\.relay\.auth\]/g).length, 1);
    assert.doesNotMatch(relayContent, /env_key = "RELAY_API_KEY"/);

    const openaiResult = await httpRequest(
      relayPort,
      "/admin/codex-config",
      "POST",
      { model_provider: "openai" },
      { authorization: "Bearer admin-secret" }
    );
    assert.equal(openaiResult.status, 200);
    assert.match(await fs.readFile(codexConfigPath, "utf8"), /model_provider = "openai"/);
    assert.equal(
      (await execFileAsync("sqlite3", [codexStatePath, "SELECT DISTINCT model_provider FROM threads;"]))
        .stdout.trim(),
      "openai"
    );
  } finally {
    await close(relay);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
