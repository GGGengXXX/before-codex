import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadConfig, validateConfig } from "../src/config.js";
import { AccountStore } from "../src/accounts.js";
import { classifyUpstreamFailure } from "../src/classifier.js";
import { ensureEnvValues, loadEnvFile, parseEnv } from "../src/env.js";
import { createRelayServer } from "../src/server.js";
import { RuntimeState, createRuntimeState } from "../src/state.js";
import {
  extractOutputTextFromSse,
  extractOutputTextPartsFromSse,
  sseHasDoneMarker,
  sseHasTerminalEvent
} from "../src/upstream.js";

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
  assert.equal(sseHasTerminalEvent("data: [DONE]\n\n"), false);
  assert.equal(sseHasDoneMarker("data: [DONE]\n\n"), true);
  assert.equal(
    sseHasTerminalEvent('event: response.output_text.delta\ndata: {"delta":"hi"}\n\n'),
    false
  );
});

test("extracts output text from common Responses and chat SSE shapes", () => {
  assert.equal(
    extractOutputTextFromSse(
      [
        'data: {"type":"response.output_text.delta","delta":"hel"}',
        "",
        'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"lo"}]}}',
        "",
        'data: {"choices":[{"delta":{"content":"!"}}]}',
        ""
      ].join("\n")
    ),
    "hello!"
  );
});

test("extracts complete message items separately from response text deltas", () => {
  assert.deepEqual(
    extractOutputTextPartsFromSse(
      'event: response.output_item.done\ndata: ' + JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "message",
          content: [{ type: "output_text", text: "complete message" }]
        }
      }) + "\n\n" +
      'event: response.completed\ndata: ' + JSON.stringify({
        type: "response.completed",
        response: {
          output: [{ type: "message", content: [{ type: "output_text", text: "complete message" }] }]
        }
      }) + "\n\n"
    ),
    {
      deltaText: "",
      itemText: "complete message",
      completedText: "complete message"
    }
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

test("isolates local accounts, sessions, defaults, and profile credentials", async () => {
  const directory = await temporaryDirectory();
  const store = new AccountStore({
    filePath: path.join(directory, "accounts.json"),
    usersPath: path.join(directory, "users"),
    sessionsPath: path.join(directory, "sessions")
  });
  const baseConfig = configFor([{
    id: "shared-template",
    provider: "provider-a",
    base_url: "https://api.example.com/v1",
    model: "upstream-model",
    api_key: "global-secret"
  }]);

  const alice = await store.register("alice", "alice-password", baseConfig);
  const bob = await store.register("bob", "bob-password", baseConfig);
  assert.notEqual(alice.username, bob.username);
  const aliceRecord = await store.authenticatePassword("alice", "alice-password");
  assert.equal((await store.authenticateToken(aliceRecord.api_token)).username, "alice");
  assert.equal(await store.authenticateToken(bob.api_token), null);

  await store.setSession(aliceRecord, { RELAY_SESSION_ID: "terminal-a" });
  assert.equal(await store.sessionToken({ RELAY_SESSION_ID: "terminal-a" }), aliceRecord.api_token);
  assert.equal(await store.sessionToken({ RELAY_SESSION_ID: "terminal-b" }), null);
  await store.setDefault("bob");
  const bobRecord = await store.authenticatePassword("bob", "bob-password");
  assert.equal(await store.defaultToken(), bobRecord.api_token);

  const profile = JSON.parse(await fs.readFile(alice.config_path, "utf8"));
  assert.equal(profile.models.codex.deployments[0].api_key, "missing-user-api-key");
  assert.equal(profile.models.codex.deployments[0].enabled, false);

  const rotated = await store.rotateToken("alice");
  assert.equal(await store.authenticateToken(aliceRecord.api_token), null);
  assert.equal((await store.authenticateToken(rotated.api_token)).username, "alice");
  await store.delete("alice", "alice-password");
  assert.equal((await store.list()).some((item) => item.username === "alice"), false);
});

test("relay token command falls back to guest token without an active account session", async () => {
  const directory = await temporaryDirectory();
  const envPath = path.join(directory, ".env");
  const relayRoot = path.join(directory, ".codex-relay");
  await fs.mkdir(relayRoot, { recursive: true });
  await fs.writeFile(envPath, "RELAY_API_KEY=guest-relay-token\n");
  await writeJson(path.join(relayRoot, "accounts.json"), {
    version: 1,
    default_username: null,
    accounts: {
      alice: {
        username: "alice",
        api_token: "user-token"
      }
    }
  });

  try {
    const result = await execFileAsync(
      process.execPath,
      ["scripts/relay-token.mjs", envPath, "RELAY_API_KEY"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          HOME: directory,
          RELAY_SESSION_ID: "missing-session"
        }
      }
    );
    assert.equal(result.stdout, "guest-relay-token");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("web account endpoints register, login, set default, and delete accounts", async () => {
  const directory = await temporaryDirectory();
  const accountStore = new AccountStore({
    filePath: path.join(directory, "accounts.json"),
    usersPath: path.join(directory, "users"),
    sessionsPath: path.join(directory, "sessions")
  });
  const config = configFor([{
    id: "template",
    provider: "provider-a",
    base_url: "http://127.0.0.1:1/v1",
    model: "upstream-model",
    api_key: "template-key"
  }], { admin_api_key: "guest-admin" });
  const relay = createRelayServer(config, new RuntimeState(), {
    accountStore,
    logger: () => {},
    codexConfigPath: path.join(directory, "codex.toml")
  });
  const relayPort = await listen(relay);

  try {
    const registered = await httpRequest(
      relayPort,
      "/admin/account/register",
      "POST",
      { username: "alice", password: "alice-password" }
    );
    assert.equal(registered.status, 200, registered.body);
    const registeredPayload = JSON.parse(registered.body);
    assert.equal(registeredPayload.profile.username, "alice");
    assert.match(registeredPayload.api_token, /^user-/);

    const loggedIn = await httpRequest(
      relayPort,
      "/admin/account/login",
      "POST",
      { username: "alice", password: "alice-password" }
    );
    assert.equal(loggedIn.status, 200, loggedIn.body);
    const token = JSON.parse(loggedIn.body).api_token;

    const invalidLogin = await httpRequest(
      relayPort,
      "/admin/account/login",
      "POST",
      { username: "alice", password: "wrong-password" }
    );
    assert.equal(invalidLogin.status, 401, invalidLogin.body);
    assert.equal(JSON.parse(invalidLogin.body).error.type, "invalid_credentials");

    const defaulted = await httpRequest(
      relayPort,
      "/admin/account/default",
      "POST",
      undefined,
      { authorization: `Bearer ${token}` }
    );
    assert.equal(defaulted.status, 200, defaulted.body);
    assert.equal((await accountStore.read()).default_username, "alice");

    const deleted = await httpRequest(
      relayPort,
      "/admin/account/delete",
      "POST",
      { password: "alice-password" },
      { authorization: `Bearer ${token}` }
    );
    assert.equal(deleted.status, 200, deleted.body);
    assert.equal((await accountStore.list()).length, 0);
    assert.equal((await accountStore.read()).default_username, null);
  } finally {
    await close(relay);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("routes authenticated relay requests through the matching user profile", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "user-response", output_text: "user profile response" }));
  });
  const upstreamPort = await listen(upstream);
  const directory = await temporaryDirectory();
  const accountStore = new AccountStore({
    filePath: path.join(directory, "accounts.json"),
    usersPath: path.join(directory, "users"),
    sessionsPath: path.join(directory, "sessions")
  });
  const baseConfig = configFor([{
    id: "template",
    provider: "provider-a",
    base_url: `http://127.0.0.1:${upstreamPort}/v1`,
    model: "user-model",
    api_key: "template-key"
  }], { public_api_key: "global-key" });
  const publicAccount = await accountStore.register("alice", "alice-password", baseConfig);
  const record = await accountStore.authenticatePassword("alice", "alice-password");
  const profile = JSON.parse(await fs.readFile(publicAccount.config_path, "utf8"));
  profile.server.port = 0;
  profile.models.codex.deployments[0].enabled = true;
  profile.models.codex.deployments[0].api_key = "user-key";
  await fs.writeFile(publicAccount.config_path, JSON.stringify(profile, null, 2));

  const relayConfig = configFor([{
    id: "global-template",
    provider: "provider-a",
    base_url: `http://127.0.0.1:${upstreamPort}/v1`,
    model: "global-model",
    api_key: "global-upstream-key"
  }], { public_api_key: "global-key" });
  const relay = createRelayServer(relayConfig, new RuntimeState(), { accountStore, logger: () => {} });
  const relayPort = await listen(relay);
  try {
    const userResult = await request(relayPort, { model: "gpt-test", input: "hello" }, {
      authorization: `Bearer ${record.api_token}`
    });
    assert.equal(userResult.status, 200, userResult.body);
    assert.match(userResult.body, /user profile response/);

    const unauthorized = await request(relayPort, { model: "gpt-test", input: "hello" }, {
      authorization: "Bearer invalid-user-token"
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("keeps guest and account API/admin profiles isolated", async () => {
  let guestBody = null;
  let userBody = null;
  const guestUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      guestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "guest-response", output_text: "guest response" }));
    });
  });
  const userUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      userBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "user-response", output_text: "user response" }));
    });
  });
  const guestPort = await listen(guestUpstream);
  const userPort = await listen(userUpstream);
  const directory = await temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  const accountStore = new AccountStore({
    filePath: path.join(directory, "accounts.json"),
    usersPath: path.join(directory, "users"),
    sessionsPath: path.join(directory, "sessions")
  });
  const rawConfig = {
    server: {
      host: "127.0.0.1",
      port: 0,
      public_api_key: "guest-token",
      admin_api_key: "guest-admin",
      request_timeout_ms: 5000,
      max_body_bytes: 1024 * 1024
    },
    routing: {
      max_attempts: 1,
      max_provider_fallbacks: 0,
      retry_backoff_ms: 0,
      compatibility: {
        sanitize_request_items: true,
        sanitize_response_items: true,
        drop_invalid_reasoning_items: true,
        strip_invalid_request_item_ids: true
      }
    },
    state: {
      store: "file",
      file_path: path.join(directory, "guest-state.json")
    },
    models: {
      codex: {
        aliases: ["gpt-test"],
        deployments: [
          {
            id: "guest-deployment",
            provider: "guest-provider",
            base_url: `http://127.0.0.1:${guestPort}/v1`,
            model: "guest-model",
            api_key: "guest-upstream-key",
            priority: 10,
            weight: 1
          }
        ]
      }
    }
  };
  await writeJson(configPath, rawConfig);
  const config = await loadConfig(configPath);
  await accountStore.register("alice", "alice-password", config);
  const record = await accountStore.authenticatePassword("alice", "alice-password");
  const profile = JSON.parse(await fs.readFile(record.config_path, "utf8"));
  profile.models.codex.deployments[0] = {
    ...profile.models.codex.deployments[0],
    id: "user-deployment",
    provider: "user-provider",
    base_url: `http://127.0.0.1:${userPort}/v1`,
    model: "user-model",
    api_key: "user-upstream-key",
    enabled: true,
    priority: 10,
    weight: 1
  };
  await writeJson(record.config_path, profile);

  const relay = createRelayServer(config, createRuntimeState(config), {
    configPath,
    accountStore,
    logger: () => {},
    codexConfigPath: path.join(directory, "codex.toml")
  });
  const relayPort = await listen(relay);

  try {
    const guestResult = await request(relayPort, {
      model: "gpt-test",
      input: "hello guest"
    }, { authorization: "Bearer guest-token" });
    assert.equal(guestResult.status, 200, guestResult.body);
    assert.match(guestResult.body, /guest response/);
    assert.equal(guestBody.model, "guest-model");

    const userResult = await request(relayPort, {
      model: "gpt-test",
      input: [
        {
          type: "message",
          id: "item_200f953b826354e8132eb110",
          role: "user",
          content: [{ type: "input_text", text: "hello user" }]
        }
      ]
    }, { authorization: `Bearer ${record.api_token}` });
    assert.equal(userResult.status, 200, userResult.body);
    assert.match(userResult.body, /user response/);
    assert.equal(userBody.model, "user-model");
    assert.equal(userBody.input[0].type, "message");
    assert.equal("id" in userBody.input[0], false);

    const guestAdmin = await httpRequest(relayPort, "/admin/config", "GET", undefined, {
      authorization: "Bearer guest-admin"
    });
    const guestPayload = JSON.parse(guestAdmin.body);
    assert.equal(guestAdmin.status, 200);
    assert.equal(guestPayload.profile.kind, "guest");
    assert.equal(guestPayload.profile.can_shutdown, true);
    assert.equal(guestPayload.config.models.codex.deployments[0].id, "guest-deployment");

    const userAdmin = await httpRequest(relayPort, "/admin/config", "GET", undefined, {
      authorization: `Bearer ${record.api_token}`
    });
    const userPayload = JSON.parse(userAdmin.body);
    assert.equal(userAdmin.status, 200);
    assert.equal(userPayload.profile.kind, "account");
    assert.equal(userPayload.profile.username, "alice");
    assert.equal(userPayload.profile.can_shutdown, true);
    assert.equal(userPayload.config.models.codex.deployments[0].id, "user-deployment");

    userPayload.config.models.codex.deployments[0].priority = 3;
    const savedUser = await httpRequest(
      relayPort,
      "/admin/config",
      "PUT",
      { config: userPayload.config },
      { authorization: `Bearer ${record.api_token}` }
    );
    assert.equal(savedUser.status, 200);
    assert.equal(JSON.parse(await fs.readFile(record.config_path, "utf8")).models.codex.deployments[0].priority, 3);
    assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).models.codex.deployments[0].priority, 10);

    const guestCalls = JSON.parse((await httpRequest(relayPort, "/admin/calls", "GET", undefined, {
      authorization: "Bearer guest-admin"
    })).body);
    const userCalls = JSON.parse((await httpRequest(relayPort, "/admin/calls", "GET", undefined, {
      authorization: `Bearer ${record.api_token}`
    })).body);
    assert.equal(guestCalls.calls[0].deployment_id, "guest-deployment");
    assert.equal(userCalls.calls[0].deployment_id, "user-deployment");
  } finally {
    await close(relay);
    await close(guestUpstream);
    await close(userUpstream);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("does not send missing private profile credentials to upstream tests", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid upstream key" } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const directory = await temporaryDirectory();
  const accountStore = new AccountStore({
    filePath: path.join(directory, "accounts.json"),
    usersPath: path.join(directory, "users"),
    sessionsPath: path.join(directory, "sessions")
  });
  const config = configFor([{
    id: "template",
    provider: "provider-a",
    base_url: `http://127.0.0.1:${upstreamPort}/v1`,
    model: "upstream-model",
    api_key: "public-key"
  }], { public_api_key: "guest-token", admin_api_key: "guest-admin" });
  await accountStore.register("alice", "alice-password", config);
  const record = await accountStore.authenticatePassword("alice", "alice-password");
  const profile = JSON.parse(await fs.readFile(record.config_path, "utf8"));
  profile.models.codex.deployments[0].enabled = true;
  assert.equal(profile.models.codex.deployments[0].api_key, "missing-user-api-key");
  await writeJson(record.config_path, profile);
  const relay = createRelayServer(config, new RuntimeState(), {
    accountStore,
    logger: () => {}
  });
  const relayPort = await listen(relay);

  try {
    const result = await httpRequest(
      relayPort,
      "/admin/test-deployment",
      "POST",
      { deployment_id: "template" },
      { authorization: `Bearer ${record.api_token}` }
    );
    const payload = JSON.parse(result.body);
    assert.equal(result.status, 400);
    assert.equal(payload.error.type, "credential_not_configured");
    assert.equal(upstreamCalls, 0);

    const responseResult = await request(
      relayPort,
      { model: "gpt-test", input: "hello" },
      { authorization: `Bearer ${record.api_token}` }
    );
    const responsePayload = JSON.parse(responseResult.body);
    assert.equal(responseResult.status, 400, responseResult.body);
    assert.equal(responsePayload.error.type, "credential_not_configured");
    assert.equal(upstreamCalls, 0);
  } finally {
    await close(relay);
    await close(upstream);
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

test("estimates usage when upstream omits usage", async () => {
  const deployment = {
    id: "estimated-deployment",
    provider: "provider-a",
    base_url: "http://127.0.0.1:1/v1",
    model: "default-upstream-model",
    api_key: "key"
  };
  const state = new RuntimeState();
  state.recordSuccess(deployment, {
    request_id: "request-estimated",
    requested_model: "gpt-test",
    logical_model: "codex",
    upstream_model: "default-upstream-model",
    usage: null,
    response_text: "hello",
    request_text: "please reply with hello",
    duration_ms: 12
  });

  const snapshot = state.snapshot([deployment]);
  const recent = state.recentCalls(1)[0];
  const usageSummary = state.usageSummary();

  assert.equal(snapshot[0].token_usage.estimated_requests, 1);
  assert.equal(snapshot[0].token_usage.estimated_total_tokens > 0, true);
  assert.equal(recent.usage.estimated, true);
  assert.equal(recent.usage.estimated_reason, "upstream_usage_missing");
  assert.equal(usageSummary.week.total.estimated_total_tokens > 0, true);
});

test("does not overcount opaque response blobs as normal text", async () => {
  const deployment = {
    id: "opaque-response-deployment",
    provider: "provider-a",
    base_url: "http://127.0.0.1:1/v1",
    model: "default-upstream-model",
    api_key: "key"
  };
  const opaque = "f8HWO-J_mLIlX5jznYV_dD_DgFsfqobAp7e8wVfVXAKQyawH9z2x8E4Vdlhe5MB2".repeat(6);
  const state = new RuntimeState();
  state.recordSuccess(deployment, {
    request_id: "request-opaque",
    requested_model: "gpt-test",
    logical_model: "codex",
    upstream_model: "default-upstream-model",
    usage: null,
    request_text: "hello",
    response_text: opaque,
    duration_ms: 12
  });

  const recent = state.recentCalls(1)[0];
  assert.equal(recent.usage.output_tokens, 0);
  assert.equal(recent.usage.total_tokens, recent.usage.input_tokens);
  assert.equal(recent.usage.estimated_reason, "upstream_usage_missing_opaque_response");
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

test("strips previous_response_id only when deployment compatibility requests it", async () => {
  const upstreamBodies = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-strip-prev", output_text: "OK" }));
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "strip-prev",
      provider: "deepseek",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "deepseek-model",
      api_key: "key",
      priority: 1,
      compatibility: {
        strip_previous_response_id: true
      }
    },
    {
      id: "keep-prev",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "normal-model",
      api_key: "key",
      priority: 2
    }
  ], { max_attempts: 1 });
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const stripped = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      previous_response_id: "resp_previous"
    });

    assert.equal(stripped.status, 200);
    assert.equal(upstreamBodies[0].model, "deepseek-model");
    assert.equal("previous_response_id" in upstreamBodies[0], false);

    config.models.codex.deployments[0].enabled = false;
    const kept = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      previous_response_id: "resp_previous"
    });

    assert.equal(kept.status, 200);
    assert.equal(upstreamBodies[1].model, "normal-model");
    assert.equal(upstreamBodies[1].previous_response_id, "resp_previous");
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

test("strips invalid message item ids from non-stream Responses payloads", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp-invalid-message-id",
        output: [
          {
            type: "message",
            id: "item_200f953b826354e8132eb110",
            role: "assistant",
            content: [{ type: "output_text", text: "OK" }]
          }
        ]
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "sanitize-response-message-id",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "key"
    }
  ], { max_attempts: 1 });
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: false
    });
    const payload = JSON.parse(result.body);

    assert.equal(result.status, 200);
    assert.equal(payload.output[0].type, "message");
    assert.equal("id" in payload.output[0], false);
    assert.equal(result.body.includes("item_200f953b826354e8132eb110"), false);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("converts DSML tool calls from non-stream Responses payloads", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp-dsml",
        output_text: "before\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name=\"exec\">\n<｜｜DSML｜｜parameter name=\"input\" string=\"true\">abc</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>"
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([{
    id: "convert-dsml",
    provider: "provider-a",
    base_url: `http://127.0.0.1:${upstreamPort}/v1`,
    model: "upstream-model",
    api_key: "key"
  }], { max_attempts: 1 });
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);
  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      tools: [{ type: "function", name: "exec_command" }],
      stream: false
    });
    const payload = JSON.parse(result.body);
    assert.equal(result.status, 200);
    assert.equal(payload.output_text, "before");
    assert.equal(payload.output.at(-1).type, "function_call");
    assert.equal(payload.output.at(-1).name, "exec_command");
    assert.deepEqual(JSON.parse(payload.output.at(-1).arguments), { cmd: "abc" });
    assert.equal(result.body.includes("DSML"), false);
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

test("strips invalid message item ids from Responses SSE events", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","id":"item_200f953b826354e8132eb110","role":"assistant","content":[{"type":"output_text","text":"OK"}]}}\n\n');
      res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-sse-message-id","output":[{"type":"message","id":"item_200f953b826354e8132eb110","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}}\n\n');
      res.end();
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "sanitize-sse-message-id",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "key"
    }
  ], { max_attempts: 1 });
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: true
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.includes("item_200f953b826354e8132eb110"), false);
    assert.equal(result.body.includes("response.completed"), true);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("converts DSML tool calls from Responses SSE events", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "<｜｜DSML｜｜tool_calls>" })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: '<｜｜DSML｜｜invoke name="exec">' })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: '<｜｜DSML｜｜parameter name="input">abc</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>' })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([{
    id: "convert-dsml-sse",
    provider: "provider-a",
    base_url: `http://127.0.0.1:${upstreamPort}/v1`,
    model: "upstream-model",
    api_key: "key"
  }], { max_attempts: 1 });
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);
  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      tools: [{ type: "function", name: "exec_command" }],
      stream: true
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.includes("DSML"), false);
    assert.equal(result.body.includes('"type":"function_call"'), true);
    assert.equal(result.body.includes("response.completed"), true);
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

test("captures raw upstream JSON on demand without putting it in the call list", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp-raw",
        output_text: "raw response",
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        provider_private: { trace: "kept in raw response" }
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const rawDirectory = await temporaryDirectory();
  const codexStatePath = path.join(rawDirectory, "codex.sqlite");
  const rolloutPath = path.join(rawDirectory, "rollout.jsonl");
  await execFileAsync("sqlite3", [
    codexStatePath,
    "create table threads (id text primary key, rollout_path text);"
      + " insert into threads values ('thread-raw-test', '" + rolloutPath + "');"
  ]);
  const config = configFor([{
    id: "raw-deployment",
    provider: "provider-a",
    base_url: "http://127.0.0.1:" + upstreamPort + "/v1",
    model: "raw-model",
    api_key: "key"
  }], { max_attempts: 1 });
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, {
    logger: () => {},
    rawResponseDir: rawDirectory,
    codexStatePath
  });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: false
    }, { "x-codex-thread-id": "thread-raw-test" });
    assert.equal(result.status, 200);

    const callsPayload = JSON.parse((await httpRequest(relayPort, "/admin/calls?offset=0&limit=10", "GET")).body);
    const call = callsPayload.calls[0];
    assert.equal(call.thread_id, "thread-raw-test");
    assert.equal(call.rollout_path, rolloutPath);
    assert.equal(call.raw_response_available, true);
    assert.equal(call.raw_response_path.startsWith(rawDirectory), true);
    assert.equal(Object.hasOwn(call, "provider_private"), false);

    const rawPayload = JSON.parse(
      (await httpRequest(relayPort, "/admin/calls/" + call.raw_response_id + "/raw", "GET")).body
    );
    assert.equal(rawPayload.is_json, true);
    assert.equal(rawPayload.json.provider_private.trace, "kept in raw response");
    assert.match(rawPayload.raw_text, /provider_private/);
  } finally {
    await close(relay);
    await close(upstream);
    await fs.rm(rawDirectory, { recursive: true, force: true });
  }
});

test("admin sessions joins Codex threads with linked calls and uses a fixed RPM window", async () => {
  const directory = await temporaryDirectory();
  const codexStatePath = path.join(directory, "state_5.sqlite");
  const alphaRollout = path.join(directory, "alpha-rollout.jsonl");
  const betaRollout = path.join(directory, "beta-rollout.jsonl");
  const now = Date.now();
  await execFileAsync("sqlite3", [
    codexStatePath,
    "create table threads (id text primary key, rollout_path text, title text, preview text, cwd text, model_provider text, model text, reasoning_effort text, thread_source text, updated_at_ms integer, recency_at_ms integer);"
      + " insert into threads values ('thread-alpha', '" + alphaRollout + "', 'Alpha build session', 'Review the relay dashboard', '/tmp/alpha-project', 'relay', 'deepseek-v4', 'high', 'cli', " + now + ", " + now + ");"
      + " insert into threads values ('thread-beta', '" + betaRollout + "', 'Beta idle session', 'Older work', '/tmp/beta-project', 'openai', 'gpt-5.5', 'low', 'cli', " + (now - 3600000) + ", " + (now - 3600000) + ");"
  ]);
  const deployment = {
    id: "session-test-deployment",
    provider: "provider-a",
    base_url: "http://127.0.0.1:1/v1",
    model: "deepseek-v4",
    api_key: "key"
  };
  const state = new RuntimeState();
  state.recordSuccess(deployment, {
    request_id: "session-alpha-1",
    thread_id: "thread-alpha",
    requested_model: "gpt-5.5",
    logical_model: "codex",
    upstream_model: "deepseek-v4",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    duration_ms: 40,
    response_text: "alpha one"
  });
  state.recordSuccess(deployment, {
    request_id: "session-alpha-2",
    thread_id: "thread-alpha",
    requested_model: "gpt-5.5",
    logical_model: "codex",
    upstream_model: "deepseek-v4",
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    duration_ms: 45,
    response_text: "alpha two"
  });
  state.recordSuccess(deployment, {
    request_id: "session-unlinked",
    requested_model: "gpt-5.5",
    logical_model: "codex",
    upstream_model: "deepseek-v4",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    duration_ms: 20,
    response_text: "unlinked"
  });
  const config = configFor([deployment]);
  const relay = createRelayServer(config, state, {
    logger: () => {},
    codexStatePath
  });
  const relayPort = await listen(relay);

  try {
    const result = await httpRequest(
      relayPort,
      "/admin/sessions?q=Alpha%20%2Ftmp%2Falpha&window=15&sort=recent&offset=0&limit=10",
      "GET"
    );
    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body);
    assert.equal(payload.sqlite_available, true);
    assert.equal(payload.total, 1);
    assert.equal(payload.active_sessions, 1);
    assert.equal(payload.requests_last_window, 2);
    assert.equal(payload.aggregate_rpm, 0.13);
    assert.equal(payload.unlinked_calls, 1);
    assert.equal(payload.sessions[0].id, "thread-alpha");
    assert.equal(payload.sessions[0].title, "Alpha build session");
    assert.equal(payload.sessions[0].rollout_path, alphaRollout);
    assert.equal(payload.sessions[0].request_count, 2);
    assert.equal(payload.sessions[0].requests_last_window, 2);
    assert.equal(payload.sessions[0].rpm, 0.13);
    assert.equal(payload.sessions[0].total_tokens, 45);
    assert.equal(payload.sessions[0].recent_calls.length, 2);
  } finally {
    await close(relay);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("admin sessions shows Codex threads with persisted token usage even without linked Relay calls", async () => {
  const directory = await temporaryDirectory();
  const codexStatePath = path.join(directory, "state_5.sqlite");
  const now = Date.now();
  await execFileAsync("sqlite3", [
    codexStatePath,
    "create table threads (id text primary key, rollout_path text, title text, preview text, cwd text, model_provider text, model text, reasoning_effort text, thread_source text, updated_at_ms integer, recency_at_ms integer, tokens_used integer);"
      + " insert into threads values ('thread-persisted', '/tmp/persisted-rollout.jsonl', 'Persisted session', 'Used before Relay was enabled', '/tmp/project', 'relay', 'deepseek-v4', 'high', 'cli', " + now + ", " + now + ", 123456);"
  ]);
  const deployment = {
    id: "session-persisted-deployment",
    provider: "provider-a",
    base_url: "http://127.0.0.1:1/v1",
    model: "deepseek-v4",
    api_key: "key"
  };
  const relay = createRelayServer(configFor([deployment]), new RuntimeState(), {
    logger: () => {},
    codexStatePath
  });
  const relayPort = await listen(relay);

  try {
    const result = await httpRequest(relayPort, "/admin/sessions?sort=tokens&offset=0&limit=10", "GET");
    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body);
    assert.equal(payload.sqlite_available, true);
    assert.equal(payload.total, 1);
    assert.equal(payload.sessions[0].id, "thread-persisted");
    assert.equal(payload.sessions[0].request_count, 0);
    assert.equal(payload.sessions[0].total_tokens, 123456);
    assert.equal(payload.sessions[0].codex_total_tokens, 123456);
    assert.equal(payload.sessions[0].token_source, "codex_sqlite");
  } finally {
    await close(relay);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("local admin can gracefully shut down the relay from the web console", async () => {
  const config = configFor([{
    id: "shutdown-deployment",
    provider: "provider-a",
    base_url: "http://127.0.0.1:1/v1",
    model: "shutdown-model",
    api_key: "key"
  }], { admin_api_key: "shutdown-admin-key" });
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const unauthorized = await httpRequest(relayPort, "/admin/shutdown", "POST");
    assert.equal(unauthorized.status, 401);

    const result = await httpRequest(
      relayPort,
      "/admin/shutdown",
      "POST",
      undefined,
      { authorization: "Bearer shutdown-admin-key" }
    );
    assert.equal(result.status, 202);
    assert.equal(JSON.parse(result.body).status, "shutting_down");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(relay.listening, false);
  } finally {
    if (relay.listening) {
      await close(relay);
    }
  }
});

test("authenticated account can gracefully shut down the shared relay", async () => {
  const directory = await temporaryDirectory();
  const accountStore = new AccountStore({
    filePath: path.join(directory, "accounts.json"),
    usersPath: path.join(directory, "users"),
    sessionsPath: path.join(directory, "sessions")
  });
  const config = configFor([{
    id: "account-shutdown-deployment",
    provider: "provider-a",
    base_url: "http://127.0.0.1:1/v1",
    model: "shutdown-model",
    api_key: "key"
  }], { admin_api_key: "shutdown-admin-key" });
  await accountStore.register("alice", "alice-password", config);
  const account = await accountStore.authenticatePassword("alice", "alice-password");
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {}, accountStore });
  const relayPort = await listen(relay);

  try {
    const result = await httpRequest(
      relayPort,
      "/admin/shutdown",
      "POST",
      undefined,
      { authorization: "Bearer " + account.api_token }
    );
    assert.equal(result.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(relay.listening, false);
  } finally {
    if (relay.listening) {
      await close(relay);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("admin hard test sends a streaming tool-capability probe", async () => {
  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.write('event: response.created\ndata: {"id":"resp-hard","type":"response.created"}\n\n');
      res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_hard","call_id":"call_hard","name":"hard_test_echo","arguments":"{\\"message\\":\\"HARD_TEST_OK\\"}","status":"completed"}}\n\n');
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-hard","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":6,"total_tokens":11}}}\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "hard-testable-deployment",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-hard-model",
      api_key: "key"
    }
  ]);
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await httpRequest(
      relayPort,
      "/admin/test-deployment",
      "POST",
      { deployment_id: "hard-testable-deployment", mode: "hard" }
    );
    const payload = JSON.parse(result.body);

    assert.equal(result.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.model, "upstream-hard-model");
    assert.equal(payload.diagnostics.mode, "hard");
    assert.equal(payload.diagnostics.stream, true);
    assert.equal(payload.diagnostics.terminal_detected, true);
    assert.equal(payload.diagnostics.tool_call_detected, true);
    assert.equal(payload.diagnostics.chunks >= 1, true);
    assert.equal(upstreamBody.model, "upstream-hard-model");
    assert.equal(upstreamBody.stream, true);
    assert.equal(upstreamBody.tools[0].name, "hard_test_echo");
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("admin hard test reports timeout when streaming probe never reaches a terminal event", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.write('event: response.created\ndata: {"id":"resp-hard-timeout","type":"response.created"}\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "hard-timeout-deployment",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-hard-model",
      api_key: "key"
    }
  ], {
    request_timeout_ms: 60,
    max_attempts: 1
  });
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await httpRequest(
      relayPort,
      "/admin/test-deployment",
      "POST",
      { deployment_id: "hard-timeout-deployment", mode: "hard" }
    );
    const payload = JSON.parse(result.body);

    assert.equal(result.status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "upstream_timeout");
    assert.equal(payload.diagnostics.mode, "hard");
    assert.equal(payload.diagnostics.terminal_detected, false);
    assert.match(payload.response_text, /timed out/);
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
  assert.equal(firstPage.page, 0);
  assert.equal(firstPage.total_pages, 2);
  assert.equal(secondPage.offset, 20);
  assert.equal(secondPage.calls.length, 5);
  assert.equal(secondPage.calls[0].request_id, "request-4");
  assert.equal(secondPage.page, 1);
  assert.equal(state.callHistory({ offset: 200, limit: 20 }).page, 1);
});

test("exposes Codex-compatible model list fields", async () => {
  const config = configFor([
    {
      id: "model-list-upstream",
      provider: "provider-a",
      base_url: "http://127.0.0.1:1/v1",
      model: "upstream-model",
      api_key: "key"
    }
  ], { public_api_key: "public" });
  const relay = createRelayServer(config, new RuntimeState(), { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await httpRequest(relayPort, "/v1/models", "GET", undefined, {
      authorization: "Bearer public"
    });
    const payload = JSON.parse(result.body);

    assert.equal(result.status, 200);
    assert.equal(payload.object, "list");
    assert.ok(Array.isArray(payload.data));
    assert.ok(Array.isArray(payload.models));
    assert.equal(payload.data.length, payload.models.length);
    assert.equal(payload.data[0].id, "codex");
    assert.equal(payload.data[0].slug, "codex");
    assert.equal(payload.data[0].display_name, "codex");
    assert.ok(Array.isArray(payload.data[0].supported_reasoning_levels));
    assert.ok(payload.data[0].supported_reasoning_levels.length > 0);
    assert.match(payload.data[0].base_instructions, /Codex/);
    assert.match(payload.data[0].model_messages.instructions_template, /Codex/);
    assert.equal(payload.models[0].id, "codex");
    assert.equal(payload.models[0].slug, "codex");
    assert.equal(payload.models[0].display_name, "codex");
    assert.equal(payload.models[0].tool_mode, "code_mode_only");
  } finally {
    await close(relay);
  }
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

test("logs retryable failover attempts before the final success", async () => {
  const first = http.createServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "insufficient_quota", message: "empty" } }));
  });
  const second = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp-good", object: "response", output_text: "hello" }));
  });
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const config = configFor([
    {
      id: "log-bad-key",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${firstPort}/v1`,
      model: "upstream-model",
      api_key: "bad",
      priority: 10,
      weight: 1
    },
    {
      id: "log-good-key",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${secondPort}/v1`,
      model: "upstream-model",
      api_key: "good",
      priority: 10,
      weight: 1
    }
  ]);
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello"
    });

    assert.equal(result.status, 200);
    const recent = state.recentCalls(5);
    assert.equal(recent[0].result, "success");
    assert.equal(recent[0].deployment_id, "log-good-key");
    assert.equal(recent[1].result, "failure");
    assert.equal(recent[1].deployment_id, "log-bad-key");
    assert.match(recent[1].response_text || "", /insufficient_quota|empty/);
  } finally {
    await close(relay);
    await close(first);
    await close(second);
  }
});

test("routes unknown requested models to the only configured logical model", async () => {
  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-defaulted", object: "response", output_text: "hello" }));
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "default-model-route",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "real-upstream-model",
      api_key: "one",
      priority: 10,
      weight: 1
    }
  ]);
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-5.6-luna",
      input: "hello"
    });
    const recent = state.recentCalls(5);

    assert.equal(result.status, 200);
    assert.equal(upstreamBody.model, "real-upstream-model");
    assert.equal(recent[0].requested_model, "gpt-5.6-luna");
    assert.equal(recent[0].logical_model, "codex");
  } finally {
    await close(relay);
    await close(upstream);
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
    assert.match(result.body, /response\.failed/);
    assert.doesNotMatch(result.body, /response\.completed/);
    assert.equal(backupCalls, 0);
    assert.equal(snapshot[0].status, "cooling_down");
    assert.equal(snapshot[0].last_error.kind, "upstream_transient");
  } finally {
    await close(relay);
    await close(first);
    await close(second);
  }
});

test("reports a failed stream when upstream aborts after invisible reasoning only", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.write('event: response.created\ndata: {"id":"resp-reasoning-abort","type":"response.created"}\n\n');
      res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_reasoning_abort","summary":[]}}\n\n');
      setTimeout(() => res.destroy(), 20);
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "reasoning-abort-stream",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "one"
    }
  ], { max_attempts: 1 });
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "continue the work",
      stream: true
    });
    const snapshot = state.snapshot(config.models.codex.deployments);
    const recent = state.recentCalls(1)[0];

    assert.equal(result.status, 200);
    assert.match(result.body, /resp-reasoning-abort/);
    assert.match(result.body, /response\.failed/);
    assert.doesNotMatch(result.body, /response\.completed/);
    assert.equal(snapshot[0].status, "cooling_down");
    assert.equal(snapshot[0].last_error.kind, "upstream_transient");
    assert.equal(recent.result, "failure");
    assert.match(recent.response_text, /terminated|upstream_stream_closed_after_commit/);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("reports upstream_timeout when a committed SSE stream reaches the request timeout", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.write('event: response.created\ndata: {"id":"resp-committed-timeout","type":"response.created"}\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "committed-timeout-stream",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "one"
    }
  ], {
    max_attempts: 1,
    request_timeout_ms: 60
  });
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "continue the work",
      stream: true
    });
    const snapshot = state.snapshot(config.models.codex.deployments);
    const recent = state.recentCalls(1)[0];

    assert.equal(result.status, 200);
    assert.match(result.body, /response\.failed/);
    assert.match(result.body, /upstream_timeout/);
    assert.match(result.body, /timed out/);
    assert.doesNotMatch(result.body, /response\.completed/);
    assert.equal(snapshot[0].last_error.code, "upstream_timeout");
    assert.equal(recent.result, "failure");
    assert.match(recent.response_text, /timed out/);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("synthesizes response.completed when upstream ends with only DONE", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.write('event: response.created\ndata: {"id":"resp-done-only","type":"response.created"}\n\n');
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "done-only-stream",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "one"
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
    const recent = state.recentCalls(1)[0];

    assert.equal(result.status, 200);
    assert.match(result.body, /data: \[DONE\]/);
    assert.match(result.body, /response\.completed/);
    assert.equal(recent.result, "success");
    assert.equal(recent.response_text, "hello");
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("does not synthesize a duplicate terminal event for large completed events", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.write('event: response.created\ndata: {"id":"resp-large-completed","type":"response.created"}\n\n');
      res.end(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp-large-completed",
          status: "completed",
          instructions: "x".repeat(12000),
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }
      })}\n\n`);
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "large-completed-stream",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "one"
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
    assert.equal(result.body.match(/event: response\.completed/g).length, 1);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("estimates streamed output from text deltas instead of the telemetry tail", async () => {
  const output = "x".repeat(9000);
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.write(
        "event: response.output_text.delta\ndata: "
        + JSON.stringify({ type: "response.output_text.delta", delta: output })
        + "\n\n"
      );
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-estimated-stream","output":[]}}\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([{
    id: "estimated-stream-output",
    provider: "provider-a",
    base_url: "http://127.0.0.1:" + upstreamPort + "/v1",
    model: "upstream-model",
    api_key: "one"
  }]);
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);
  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: true
    });
    const recent = state.recentCalls(1)[0];
    assert.equal(result.status, 200);
    assert.equal(recent.usage.estimated, true);
    assert.equal(recent.usage.output_tokens, 2250);
    assert.equal(recent.usage.output_tokens > 2048, true);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("estimates streamed output from a complete message item when deltas are missing", async () => {
  const output = "word ".repeat(1800);
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.write(
        "event: response.output_item.done\ndata: "
        + JSON.stringify({
          type: "response.output_item.done",
          item: { type: "message", content: [{ type: "output_text", text: output }] }
        })
        + "\n\n"
      );
      res.end(
        "event: response.completed\ndata: "
        + JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-estimated-item",
            output: [{ type: "message", content: [{ type: "output_text", text: output }] }]
          }
        })
        + "\n\n"
      );
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([{
    id: "estimated-item-output",
    provider: "provider-a",
    base_url: "http://127.0.0.1:" + upstreamPort + "/v1",
    model: "upstream-model",
    api_key: "one"
  }]);
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);
  try {
    const result = await request(relayPort, {
      model: "gpt-test",
      input: "hello",
      stream: true
    });
    const recent = state.recentCalls(1)[0];
    assert.equal(result.status, 200);
    assert.equal(recent.usage.estimated, true);
    assert.equal(recent.usage.output_tokens, 2250);
    assert.equal(recent.response_text.length, 4003);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("logs streamed output when the client closes after receiving data", async () => {
  let upstreamClosed = false;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.write("event: response.created\n");
    res.write('data: {"id":"resp-client-close","type":"response.created"}\n\n');
    res.write("event: response.output_text.delta\n");
    res.write('data: {"type":"response.output_text.delta","delta":"Hello from stream"}\n\n');
    const keepAlive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 20);
    res.on("close", () => {
      upstreamClosed = true;
      clearInterval(keepAlive);
    });
  });
  const upstreamPort = await listen(upstream);
  const config = configFor([
    {
      id: "client-close-stream",
      provider: "provider-a",
      base_url: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "upstream-model",
      api_key: "one",
      priority: 10,
      weight: 1
    }
  ]);
  const state = new RuntimeState();
  const relay = createRelayServer(config, state, { logger: () => {} });
  const relayPort = await listen(relay);

  try {
    let body = "";
    await withTimeout(new Promise((resolve, reject) => {
      let settled = false;
      function finish(error) {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }

      const client = http.request(
        {
          host: "127.0.0.1",
          port: relayPort,
          path: "/v1/responses",
          method: "POST",
          headers: { "content-type": "application/json" }
        },
        (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
            if (body.includes("Hello from stream")) {
              response.destroy();
              client.destroy();
              finish();
            }
          });
          response.on("end", () => finish());
          response.on("error", () => finish());
        }
      );
      client.on("error", (error) => {
        if (body.includes("Hello from stream")) {
          finish();
          return;
        }
        finish(error);
      });
      client.end(JSON.stringify({
        model: "gpt-test",
        input: "hello",
        stream: true
      }));
    }), 1000);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const recent = state.recentCalls(5);

    assert.equal(upstreamClosed, true);
    assert.equal(recent[0].result, "success");
    assert.equal(recent[0].deployment_id, "client-close-stream");
    assert.equal(recent[0].response_text, "Hello from stream");
  } finally {
    await close(relay);
    await close(upstream);
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
