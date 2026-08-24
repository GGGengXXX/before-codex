import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { RelayError } from "./errors.js";

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_JOBS = 80;
const DEFAULT_PROMPT_LIMIT = 12000;
const DEFAULT_BACKEND = "app-server";
const DEFAULT_APP_SERVER_APPROVAL_POLICY = "never";
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval"
]);
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeWorkspaceRoots(roots) {
  const values = Array.isArray(roots) && roots.length ? roots : [process.cwd()];
  return values.map((root) => path.resolve(String(root)));
}

function resolveWorkspace(cwd, roots) {
  const requested = path.resolve(String(cwd || roots[0]));
  const allowed = roots.some((root) => {
    const relative = path.relative(root, requested);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new RelayError("Workspace is outside the allowed mobile roots", {
      code: "workspace_not_allowed",
      status: 400
    });
  }
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    throw new RelayError("Workspace directory does not exist", {
      code: "workspace_not_found",
      status: 400
    });
  }
  return requested;
}

function normalizePrompt(prompt, maxPromptChars) {
  const text = String(prompt ?? "").trim();
  if (!text) {
    throw new RelayError("Prompt is required", {
      code: "prompt_required",
      status: 400
    });
  }
  if (text.length > maxPromptChars) {
    throw new RelayError(`Prompt is too long. Limit is ${maxPromptChars} characters`, {
      code: "prompt_too_large",
      status: 413
    });
  }
  return text;
}

function eventSummary(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const type = value.type || value.event || value.method || "";
  const item = value.item || value.params?.item || null;
  if (item?.type === "agent_message" || item?.type === "agentMessage") {
    return item.text || "";
  }
  if (value.msg && typeof value.msg === "string") {
    return value.msg;
  }
  if (value.message && typeof value.message === "string") {
    return value.message;
  }
  return type ? String(type) : "";
}

function extractThreadId(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value.thread_id
    || value.threadId
    || value.thread?.id
    || value.params?.thread_id
    || value.params?.threadId
    || value.params?.thread?.id
    || null;
}

function extractAgentMessage(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const type = value.type || value.event || value.method || "";
  if (type === "agent_message_delta" || type === "item/agentMessage/delta") {
    return value.delta || value.text || value.params?.delta || "";
  }
  const item = value.item || value.params?.item || null;
  if (item?.type === "agent_message" || item?.type === "agentMessage") {
    return item.text || "";
  }
  if (type === "agent_message" || type === "agentMessage") {
    return value.text || value.params?.text || "";
  }
  return "";
}

function isAgentMessageDelta(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const type = value.type || value.event || value.method || "";
  return type === "agent_message_delta" || type === "item/agentMessage/delta";
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function createLineBuffer(onLine) {
  let buffer = "";
  return {
    write(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          onLine(line);
        }
      }
    },
    end() {
      const line = buffer.trim();
      buffer = "";
      if (line) {
        onLine(line);
      }
    }
  };
}

function normalizeBackend(value) {
  return value === "app-server" ? "app-server" : "exec";
}

function normalizeApprovalDecision(value) {
  return ["accept", "acceptForSession", "decline", "cancel"].includes(value)
    ? value
    : "decline";
}

function approvalTypeForMethod(method) {
  if (method === "item/commandExecution/requestApproval") {
    return "command";
  }
  if (method === "item/fileChange/requestApproval") {
    return "file_change";
  }
  if (method === "item/permissions/requestApproval") {
    return "permissions";
  }
  return "unknown";
}

function approvalPayload(approval) {
  return {
    id: approval.id,
    method: approval.method,
    type: approval.type,
    thread_id: approval.thread_id,
    turn_id: approval.turn_id,
    item_id: approval.item_id,
    approval_id: approval.approval_id,
    command: approval.command,
    cwd: approval.cwd,
    reason: approval.reason,
    created_at: approval.created_at,
    params: approval.params
  };
}

function approvalResponse(method, params, decision) {
  const normalized = normalizeApprovalDecision(decision);
  if (
    method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
  ) {
    return { decision: normalized };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: normalized === "accept" || normalized === "acceptForSession"
        ? params.permissions || {}
        : {},
      scope: normalized === "acceptForSession" ? "session" : "turn",
      strictAutoReview: null
    };
  }
  return {};
}

export function appServerSandboxPolicy(sandbox, cwd) {
  if (sandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (sandbox === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: cwd ? [cwd] : [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

export function appServerThreadParams(job) {
  return {
    cwd: job.cwd,
    model: job.model || null,
    sandbox: job.sandbox || null,
    approvalPolicy: job.approval_policy || null,
    approvalsReviewer: job.approvals_reviewer || null,
    serviceName: "codex-relay-mobile",
    ephemeral: false
  };
}

export function appServerTurnParams(job, threadId) {
  return {
    threadId,
    cwd: job.cwd,
    input: [{ type: "text", text: job.prompt }],
    model: job.model || null,
    sandboxPolicy: appServerSandboxPolicy(job.sandbox, job.cwd),
    approvalPolicy: job.approval_policy || null,
    approvalsReviewer: job.approvals_reviewer || null
  };
}

class JsonRpcLineClient {
  constructor(child, {
    onNotification = () => {},
    onRequest = () => {},
    onStderr = () => {},
    onClose = () => {},
    requestTimeoutMs = 10000
  } = {}) {
    this.child = child;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onStderr = onStderr;
    this.onClose = onClose;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    const stdout = createLineBuffer((line) => this.handleLine(line));
    const stderr = createLineBuffer((line) => onStderr(line));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => stderr.write(chunk));
    child.on("error", (error) => this.closeWithError(error));
    child.on("close", (exitCode, signal) => {
      stdout.end();
      stderr.end();
      this.closed = true;
      this.rejectPending(new Error(`app-server exited with code ${exitCode ?? "unknown"}`));
      onClose({ exitCode, signal });
    });
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) {
      return Promise.reject(new Error("app-server transport is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`app-server request timed out: ${method}`));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        }
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = undefined) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      message.params = params;
    }
    this.write(message);
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  write(message) {
    if (this.closed || !this.child.stdin?.writable) {
      throw new Error("app-server stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    const message = parseJsonLine(line);
    if (!message || typeof message !== "object") {
      this.onStderr(line);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.onRequest(message);
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      this.onNotification(message);
      return;
    }
    this.onStderr(JSON.stringify(message));
  }

  closeWithError(error) {
    this.closed = true;
    this.rejectPending(error);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPending(new Error("app-server transport closed"));
    this.child.kill("SIGTERM");
  }
}

export function codexExecArgs({
  prompt,
  cwd,
  model = null,
  sandbox = "workspace-write",
  threadId = null,
  skipGitRepoCheck = false
}) {
  const args = ["exec"];
  if (threadId) {
    args.push("resume", "--json");
    if (model) {
      args.push("--model", model);
    }
    if (skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }
    args.push(threadId, prompt);
    return args;
  }
  args.push("--json", "--cd", cwd);
  if (sandbox) {
    args.push("--sandbox", sandbox);
  }
  if (model) {
    args.push("--model", model);
  }
  if (skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  args.push(prompt);
  return args;
}

export function createCodexExecRunner({ codexBin = "codex", env = process.env, spawnFn = spawn } = {}) {
  return ({ job, emit }) => new Promise((resolve) => {
    const args = codexExecArgs({
      prompt: job.prompt,
      cwd: job.cwd,
      model: job.model,
      sandbox: job.sandbox,
      threadId: job.thread_id,
      skipGitRepoCheck: job.skip_git_repo_check
    });
    const child = spawnFn(codexBin, args, {
      cwd: job.cwd,
      env: {
        ...env,
        ...(job.relay_session_id ? { RELAY_SESSION_ID: job.relay_session_id } : {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    job.process = child;
    emit("process_started", { pid: child.pid, command: codexBin, args });

    const stdout = createLineBuffer((line) => {
      const parsed = parseJsonLine(line);
      if (parsed) {
        emit("codex_event", parsed);
        return;
      }
      emit("stdout", { text: line });
    });
    const stderr = createLineBuffer((line) => emit("stderr", { text: line }));

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => stderr.write(chunk));
    child.on("error", (error) => {
      stdout.end();
      stderr.end();
      resolve({ ok: false, error, exitCode: null, signal: null });
    });
    child.on("close", (exitCode, signal) => {
      stdout.end();
      stderr.end();
      resolve({
        ok: exitCode === 0,
        error: null,
        exitCode,
        signal
      });
    });
  });
}

export function createCodexAppServerRunner({
  codexBin = "codex",
  env = process.env,
  spawnFn = spawn,
  requestTimeoutMs = 10000
} = {}) {
  return async ({ job, emit }) => {
    const args = ["app-server", "--stdio"];
    const child = spawnFn(codexBin, args, {
      cwd: job.cwd,
      env: {
        ...env,
        ...(job.relay_session_id ? { RELAY_SESSION_ID: job.relay_session_id } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    job.process = child;
    emit("process_started", { pid: child.pid, command: codexBin, args, backend: "app-server" });

    let completed = false;
    let closeResult = null;
    let resolveTurn;
    const turnCompleted = new Promise((resolve) => {
      resolveTurn = resolve;
    });

    const client = new JsonRpcLineClient(child, {
      requestTimeoutMs,
      onStderr: (line) => emit("stderr", { text: line }),
      onNotification: (message) => {
        const params = message.params || {};
        const event = {
          type: message.method,
          method: message.method,
          ...params,
          params,
          emittedAtMs: message.emittedAtMs ?? null
        };
        emit("codex_event", event);
        if (message.method === "thread/started" && params.thread?.id && !job.thread_id) {
          job.thread_id = params.thread.id;
        }
        if (message.method === "turn/started" && params.turn?.id && !job.turn_id) {
          job.turn_id = params.turn.id;
        }
        if (message.method === "turn/completed") {
          const turn = params.turn || {};
          const status = turn.status || "completed";
          if (
            (!job.thread_id || params.threadId === job.thread_id)
            && (!job.turn_id || turn.id === job.turn_id)
            && TERMINAL_TURN_STATUSES.has(status)
          ) {
            completed = true;
            resolveTurn({
              ok: status === "completed",
              error: turn.error ? new Error(turn.error.message || JSON.stringify(turn.error)) : null,
              exitCode: status === "completed" ? 0 : 1,
              signal: status === "interrupted" ? "SIGTERM" : null
            });
          }
        }
      },
      onRequest: (message) => {
        if (!APPROVAL_METHODS.has(message.method)) {
          client.respond(message.id, {});
          return;
        }
        const params = message.params || {};
        const approval = {
          id: String(message.id),
          request_id: message.id,
          method: message.method,
          type: approvalTypeForMethod(message.method),
          thread_id: params.threadId || job.thread_id,
          turn_id: params.turnId || job.turn_id,
          item_id: params.itemId || null,
          approval_id: params.approvalId || null,
          command: params.command || null,
          cwd: params.cwd || null,
          reason: params.reason || null,
          created_at: nowIso(),
          params,
          resolve: (decision) => client.respond(
            message.id,
            approvalResponse(message.method, params, decision)
          )
        };
        job.pending_approvals.set(approval.id, approval);
        emit("approval_requested", approvalPayload(approval));
      },
      onClose: (result) => {
        closeResult = result;
        if (!completed) {
          resolveTurn({
            ok: false,
            error: new Error(`app-server exited with code ${result.exitCode ?? "unknown"}`),
            exitCode: result.exitCode,
            signal: result.signal
          });
        }
      }
    });

    job.interrupt = () => {
      if (job.thread_id && job.turn_id) {
        client.request("turn/interrupt", {
          threadId: job.thread_id,
          turnId: job.turn_id
        }, { timeoutMs: 5000 }).catch((error) => {
          emit("stderr", { text: error.message });
        });
      } else {
        child.kill("SIGTERM");
      }
    };

    try {
      await client.request("initialize", {
        clientInfo: {
          name: "codex-relay-mobile",
          title: "Codex Relay Mobile",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      });
      client.notify("initialized");

      const threadMethod = job.thread_id ? "thread/resume" : "thread/start";
      const threadParams = job.thread_id
        ? { ...appServerThreadParams(job), threadId: job.thread_id }
        : appServerThreadParams(job);
      const threadResponse = await client.request(threadMethod, threadParams);
      const threadId = threadResponse?.thread?.id || job.thread_id;
      if (!threadId) {
        throw new Error("app-server did not return a thread id");
      }
      job.thread_id = threadId;
      emit("app_server_thread", {
        method: threadMethod,
        thread_id: threadId,
        cwd: threadResponse?.cwd || job.cwd,
        model: threadResponse?.model || job.model
      });

      const turnResponse = await client.request("turn/start", appServerTurnParams(job, threadId));
      job.turn_id = turnResponse?.turn?.id || job.turn_id;
      emit("app_server_turn", {
        thread_id: threadId,
        turn_id: job.turn_id,
        status: turnResponse?.turn?.status || null
      });

      return await turnCompleted;
    } catch (error) {
      return {
        ok: false,
        error,
        exitCode: closeResult?.exitCode ?? null,
        signal: closeResult?.signal ?? null
      };
    } finally {
      for (const approval of job.pending_approvals.values()) {
        emit("approval_expired", approvalPayload(approval));
      }
      job.pending_approvals.clear();
      job.interrupt = null;
      client.close();
    }
  };
}

class MobileSessionProcess {
  constructor({
    owner,
    id,
    threadId,
    title = "",
    cwd,
    model = null,
    sandbox = "workspace-write",
    approvalPolicy = DEFAULT_APP_SERVER_APPROVAL_POLICY,
    approvalsReviewer = null,
    relaySessionId = null,
    codexBin = "codex",
    env = process.env,
    spawnFn = spawn,
    requestTimeoutMs = 10000,
    maxEvents = DEFAULT_MAX_EVENTS
  }) {
    this.owner = owner;
    this.id = id;
    this.title = title || threadId || id;
    this.thread_id = threadId || null;
    this.cwd = cwd;
    this.model = model || null;
    this.sandbox = sandbox || "workspace-write";
    this.approval_policy = approvalPolicy || DEFAULT_APP_SERVER_APPROVAL_POLICY;
    this.approvals_reviewer = approvalsReviewer || null;
    this.relay_session_id = relaySessionId || null;
    this.codexBin = codexBin;
    this.env = env;
    this.spawnFn = spawnFn;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxEvents = maxEvents;
    this.status = "starting";
    this.started_at = nowIso();
    this.updated_at = this.started_at;
    this.stopped_at = null;
    this.error = null;
    this.process = null;
    this.client = null;
    this.sequence = 0;
    this.events = [];
    this.pending_approvals = new Map();
    this.active_turn_id = null;
    this.current_response = "";
    this.final_response = "";
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  event(type, payload = {}) {
    this.sequence += 1;
    this.updated_at = nowIso();
    const event = {
      sequence: this.sequence,
      at: this.updated_at,
      type,
      payload,
      summary: type === "codex_event" ? eventSummary(payload) : ""
    };
    const threadId = extractThreadId(payload);
    if (threadId && !this.thread_id) {
      this.thread_id = threadId;
    }
    const message = extractAgentMessage(payload);
    if (message) {
      this.current_response = isAgentMessageDelta(payload)
        ? `${this.current_response}${message}`
        : message;
      this.final_response = this.current_response;
    }
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.emitter.emit("event", event);
    return event;
  }

  subscribe(listener) {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  payload({ includeEvents = true, after = 0 } = {}) {
    const events = includeEvents
      ? this.events.filter((event) => event.sequence > after)
      : undefined;
    return {
      id: this.id,
      owner: this.owner,
      status: this.status,
      title: this.title,
      thread_id: this.thread_id,
      active_turn_id: this.active_turn_id,
      cwd: this.cwd,
      model: this.model,
      sandbox: this.sandbox,
      approval_policy: this.approval_policy,
      approvals_reviewer: this.approvals_reviewer,
      started_at: this.started_at,
      updated_at: this.updated_at,
      stopped_at: this.stopped_at,
      error: this.error,
      current_response: this.current_response,
      final_response: this.final_response,
      pending_approvals: [...this.pending_approvals.values()].map(approvalPayload),
      event_count: this.events.length,
      ...(includeEvents ? { events } : {})
    };
  }

  start() {
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.startAppServer();
    return this.readyPromise;
  }

  startAppServer() {
    const args = ["app-server", "--stdio"];
    const child = this.spawnFn(this.codexBin, args, {
      cwd: this.cwd,
      env: {
        ...this.env,
        ...(this.relay_session_id ? { RELAY_SESSION_ID: this.relay_session_id } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;
    this.event("process_started", { pid: child.pid, command: this.codexBin, args, backend: "app-server" });
    const client = new JsonRpcLineClient(child, {
      requestTimeoutMs: this.requestTimeoutMs,
      onStderr: (line) => this.event("stderr", { text: line }),
      onNotification: (message) => this.handleNotification(message),
      onRequest: (message) => this.handleRequest(message),
      onClose: (result) => this.handleClose(result)
    });
    this.client = client;
    this.initialize().catch((error) => this.failStartup(error));
  }

  async initialize() {
    await this.client.request("initialize", {
      clientInfo: {
        name: "codex-relay-mobile-session",
        title: "Codex Relay Mobile Session",
        version: "0.1.0"
      },
      capabilities: { experimentalApi: true }
    });
    this.client.notify("initialized");
    const params = {
      cwd: this.cwd,
      model: this.model,
      sandbox: this.sandbox,
      approvalPolicy: this.approval_policy,
      approvalsReviewer: this.approvals_reviewer,
      serviceName: "codex-relay-mobile",
      ephemeral: false
    };
    const response = this.thread_id
      ? await this.client.request("thread/resume", { ...params, threadId: this.thread_id })
      : await this.client.request("thread/start", params);
    this.thread_id = response?.thread?.id || this.thread_id;
    if (!this.thread_id) {
      throw new Error("app-server did not return a thread id");
    }
    this.status = "ready";
    this.event("session_ready", {
      thread_id: this.thread_id,
      cwd: response?.cwd || this.cwd,
      model: response?.model || this.model
    });
    this.readyResolve?.(this);
  }

  failStartup(error) {
    this.status = "failed";
    this.error = error.message;
    this.event("session_failed", { error: error.message });
    this.readyReject?.(error);
    this.stopped_at = nowIso();
    this.client?.close();
    this.process?.kill("SIGTERM");
    this.client = null;
    this.process = null;
  }

  handleNotification(message) {
    const params = message.params || {};
    const event = {
      type: message.method,
      method: message.method,
      ...params,
      params,
      emittedAtMs: message.emittedAtMs ?? null
    };
    this.event("codex_event", event);
    if (message.method === "thread/started" && params.thread?.id && !this.thread_id) {
      this.thread_id = params.thread.id;
    }
    if (message.method === "turn/started" && params.turn?.id) {
      this.active_turn_id = params.turn.id;
      this.status = "running";
      this.event("command_running", {
        thread_id: this.thread_id,
        turn_id: this.active_turn_id
      });
    }
    if (message.method === "turn/completed") {
      const turn = params.turn || {};
      if (!this.active_turn_id || turn.id === this.active_turn_id) {
        const status = turn.status || "completed";
        const failed = status === "failed";
        this.active_turn_id = null;
        this.status = "ready";
        this.error = failed ? turn.error?.message || "Turn failed" : null;
        this.event(failed ? "command_failed" : "command_completed", {
          thread_id: params.threadId || this.thread_id,
          turn_id: turn.id || null,
          status,
          error: turn.error || null
        });
      }
    }
  }

  handleRequest(message) {
    if (!APPROVAL_METHODS.has(message.method)) {
      this.client.respond(message.id, {});
      return;
    }
    const params = message.params || {};
    const approval = {
      id: String(message.id),
      request_id: message.id,
      method: message.method,
      type: approvalTypeForMethod(message.method),
      thread_id: params.threadId || this.thread_id,
      turn_id: params.turnId || this.active_turn_id,
      item_id: params.itemId || null,
      approval_id: params.approvalId || null,
      command: params.command || null,
      cwd: params.cwd || null,
      reason: params.reason || null,
      created_at: nowIso(),
      params,
      resolve: (decision) => this.client.respond(
        message.id,
        approvalResponse(message.method, params, decision)
      )
    };
    this.pending_approvals.set(approval.id, approval);
    this.event("approval_requested", approvalPayload(approval));
  }

  handleClose(result) {
    if (this.status !== "stopped") {
      this.status = this.status === "failed" ? "failed" : "stopped";
      this.stopped_at = nowIso();
      this.event("session_stopped", {
        exit_code: result.exitCode,
        signal: result.signal
      });
    }
    this.process = null;
    this.client = null;
  }

  async sendCommand(prompt, maxPromptChars) {
    const text = normalizePrompt(prompt, maxPromptChars);
    await this.start();
    if (this.status !== "ready") {
      throw new RelayError("This mobile session is not ready for a new command", {
        code: "mobile_session_not_ready",
        status: 409
      });
    }
    this.status = "running";
    this.current_response = "";
    this.final_response = "";
    this.event("command_submitted", { prompt: text, thread_id: this.thread_id });
    const response = await this.client.request("turn/start", {
      threadId: this.thread_id,
      cwd: this.cwd,
      input: [{ type: "text", text }],
      model: this.model,
      sandboxPolicy: appServerSandboxPolicy(this.sandbox, this.cwd),
      approvalPolicy: this.approval_policy,
      approvalsReviewer: this.approvals_reviewer
    });
    this.active_turn_id = response?.turn?.id || this.active_turn_id;
    this.event("app_server_turn", {
      thread_id: this.thread_id,
      turn_id: this.active_turn_id,
      status: response?.turn?.status || null
    });
    return this.payload();
  }

  interrupt() {
    if (!this.client || !this.active_turn_id || !this.thread_id) {
      return this.payload();
    }
    this.event("command_interrupting", {
      thread_id: this.thread_id,
      turn_id: this.active_turn_id
    });
    this.client.request("turn/interrupt", {
      threadId: this.thread_id,
      turnId: this.active_turn_id
    }, { timeoutMs: 5000 }).catch((error) => {
      this.event("stderr", { text: error.message });
    });
    return this.payload();
  }

  resolveApproval(approvalId, decision) {
    const approval = this.pending_approvals.get(approvalId);
    if (!approval) {
      throw new RelayError("Mobile session approval request was not found", {
        code: "mobile_session_approval_not_found",
        status: 404
      });
    }
    const normalized = normalizeApprovalDecision(decision);
    approval.resolve(normalized);
    this.pending_approvals.delete(approvalId);
    this.event("approval_resolved", {
      ...approvalPayload(approval),
      decision: normalized
    });
    return this.payload();
  }

  stop() {
    this.status = "stopped";
    this.stopped_at = nowIso();
    for (const approval of this.pending_approvals.values()) {
      this.event("approval_expired", approvalPayload(approval));
    }
    this.pending_approvals.clear();
    this.client?.close();
    this.process?.kill("SIGTERM");
    this.client = null;
    this.process = null;
    this.event("session_stopped", {});
    return this.payload();
  }
}

export class MobileSessionProcessManager {
  constructor({
    workspaceRoots = null,
    maxPromptChars = DEFAULT_PROMPT_LIMIT,
    maxEventsPerJob = DEFAULT_MAX_EVENTS,
    maxJobs = DEFAULT_MAX_JOBS,
    defaultSandbox = "workspace-write",
    defaultModel = null,
    appServerApprovalPolicy = DEFAULT_APP_SERVER_APPROVAL_POLICY,
    appServerApprovalsReviewer = null,
    codexBin = "codex",
    env = process.env,
    spawnFn = spawn
  } = {}) {
    this.env = env;
    this.spawnFn = spawnFn;
    this.processes = new Map();
    this.updateOptions({
      workspaceRoots,
      maxPromptChars,
      maxEventsPerJob,
      maxJobs,
      defaultSandbox,
      defaultModel,
      appServerApprovalPolicy,
      appServerApprovalsReviewer,
      codexBin
    });
  }

  updateOptions({
    workspaceRoots = null,
    maxPromptChars = DEFAULT_PROMPT_LIMIT,
    maxEventsPerJob = DEFAULT_MAX_EVENTS,
    maxJobs = DEFAULT_MAX_JOBS,
    defaultSandbox = "workspace-write",
    defaultModel = null,
    appServerApprovalPolicy = DEFAULT_APP_SERVER_APPROVAL_POLICY,
    appServerApprovalsReviewer = null,
    codexBin = "codex"
  } = {}) {
    this.workspaceRoots = normalizeWorkspaceRoots(workspaceRoots);
    this.maxPromptChars = Math.max(1, Number(maxPromptChars) || DEFAULT_PROMPT_LIMIT);
    this.maxEventsPerJob = Math.max(20, Number(maxEventsPerJob) || DEFAULT_MAX_EVENTS);
    this.maxJobs = Math.max(10, Number(maxJobs) || DEFAULT_MAX_JOBS);
    this.defaultSandbox = defaultSandbox || "workspace-write";
    this.defaultModel = defaultModel || null;
    this.appServerApprovalPolicy = appServerApprovalPolicy || DEFAULT_APP_SERVER_APPROVAL_POLICY;
    this.appServerApprovalsReviewer = appServerApprovalsReviewer || null;
    this.codexBin = codexBin || "codex";
    for (const process of this.processes.values()) {
      process.maxEvents = this.maxEventsPerJob;
      if (process.events.length > process.maxEvents) {
        process.events.splice(0, process.events.length - process.maxEvents);
      }
    }
    this.pruneProcesses();
  }

  listProcesses(owner) {
    return [...this.processes.values()]
      .filter((process) => process.owner === owner)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((process) => process.payload({ includeEvents: false }));
  }

  activeProcessesFor(owner) {
    return [...this.processes.values()].filter((process) =>
      process.owner === owner && !["failed", "stopped"].includes(process.status)
    );
  }

  getProcess(owner, id) {
    const process = this.processes.get(id);
    if (!process || process.owner !== owner) {
      throw new RelayError("Mobile session process was not found", {
        code: "mobile_session_process_not_found",
        status: 404
      });
    }
    return process;
  }

  startProcess(owner, input = {}) {
    const threadId = String(input.thread_id || input.threadId || "").trim();
    const existing = [...this.processes.values()].find((process) =>
      process.owner === owner
      && threadId
      && process.thread_id === threadId
      && !["failed", "stopped"].includes(process.status)
    );
    if (existing) {
      return existing.payload();
    }
    const cwd = resolveWorkspace(input.cwd, this.workspaceRoots);
    const process = new MobileSessionProcess({
      owner,
      id: crypto.randomUUID(),
      threadId: threadId || null,
      title: String(input.title || input.name || threadId || "Mobile session").slice(0, 120),
      cwd,
      model: input.model || this.defaultModel,
      sandbox: input.sandbox || this.defaultSandbox,
      approvalPolicy: input.approval_policy || this.appServerApprovalPolicy,
      approvalsReviewer: input.approvals_reviewer || this.appServerApprovalsReviewer,
      relaySessionId: input.relay_session_id || null,
      codexBin: this.codexBin,
      env: this.env,
      spawnFn: this.spawnFn,
      maxEvents: this.maxEventsPerJob
    });
    this.processes.set(process.id, process);
    this.pruneProcesses();
    process.start().catch(() => {});
    return process.payload();
  }

  async sendCommand(owner, id, prompt) {
    const process = this.getProcess(owner, id);
    await process.sendCommand(prompt, this.maxPromptChars);
    return process.payload();
  }

  interruptProcess(owner, id) {
    return this.getProcess(owner, id).interrupt();
  }

  stopProcess(owner, id) {
    return this.getProcess(owner, id).stop();
  }

  resolveApproval(owner, id, approvalId, decision) {
    return this.getProcess(owner, id).resolveApproval(approvalId, decision);
  }

  subscribe(owner, id, listener) {
    return this.getProcess(owner, id).subscribe(listener);
  }

  processPayload(process, options = {}) {
    return process.payload(options);
  }

  pruneProcesses() {
    const processes = [...this.processes.values()].sort((a, b) =>
      String(b.updated_at).localeCompare(String(a.updated_at))
    );
    for (const process of processes.slice(this.maxJobs)) {
      if (["failed", "stopped"].includes(process.status)) {
        this.processes.delete(process.id);
      }
    }
  }
}

export class MobileJobManager {
  constructor({
    runner = null,
    appServerRunner = null,
    codexBin = "codex",
    env = process.env,
    workspaceRoots = null,
    maxActiveRunsPerUser = 1,
    maxPromptChars = DEFAULT_PROMPT_LIMIT,
    maxEventsPerJob = DEFAULT_MAX_EVENTS,
    maxJobs = DEFAULT_MAX_JOBS,
    defaultSandbox = "workspace-write",
    defaultModel = null,
    skipGitRepoCheck = false,
    defaultBackend = DEFAULT_BACKEND,
    appServerApprovalPolicy = DEFAULT_APP_SERVER_APPROVAL_POLICY,
    appServerApprovalsReviewer = null
  } = {}) {
    this.runner = runner ?? createCodexExecRunner({ codexBin, env });
    this.appServerRunner = appServerRunner ?? createCodexAppServerRunner({ codexBin, env });
    this.jobs = new Map();
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(200);
    this.updateOptions({
      workspaceRoots,
      maxActiveRunsPerUser,
      maxPromptChars,
      maxEventsPerJob,
      maxJobs,
      defaultSandbox,
      defaultModel,
      skipGitRepoCheck,
      defaultBackend,
      appServerApprovalPolicy,
      appServerApprovalsReviewer
    });
  }

  updateOptions({
    workspaceRoots = null,
    maxActiveRunsPerUser = 1,
    maxPromptChars = DEFAULT_PROMPT_LIMIT,
    maxEventsPerJob = DEFAULT_MAX_EVENTS,
    maxJobs = DEFAULT_MAX_JOBS,
    defaultSandbox = "workspace-write",
    defaultModel = null,
    skipGitRepoCheck = false,
    defaultBackend = DEFAULT_BACKEND,
    appServerApprovalPolicy = DEFAULT_APP_SERVER_APPROVAL_POLICY,
    appServerApprovalsReviewer = null
  } = {}) {
    this.workspaceRoots = normalizeWorkspaceRoots(workspaceRoots);
    this.maxActiveRunsPerUser = Math.max(1, Number(maxActiveRunsPerUser) || 1);
    this.maxPromptChars = Math.max(1, Number(maxPromptChars) || DEFAULT_PROMPT_LIMIT);
    this.maxEventsPerJob = Math.max(20, Number(maxEventsPerJob) || DEFAULT_MAX_EVENTS);
    this.maxJobs = Math.max(10, Number(maxJobs) || DEFAULT_MAX_JOBS);
    this.defaultSandbox = defaultSandbox || "workspace-write";
    this.defaultModel = defaultModel || null;
    this.skipGitRepoCheck = Boolean(skipGitRepoCheck);
    this.defaultBackend = normalizeBackend(defaultBackend);
    this.appServerApprovalPolicy = appServerApprovalPolicy || DEFAULT_APP_SERVER_APPROVAL_POLICY;
    this.appServerApprovalsReviewer = appServerApprovalsReviewer || null;
    for (const job of this.jobs.values()) {
      if (job.events.length > this.maxEventsPerJob) {
        job.events.splice(0, job.events.length - this.maxEventsPerJob);
      }
    }
    this.pruneJobs();
  }

  optionsPayload() {
    return {
      workspace_roots: this.workspaceRoots,
      max_active_runs_per_user: this.maxActiveRunsPerUser,
      max_prompt_chars: this.maxPromptChars,
      default_sandbox: this.defaultSandbox,
      default_model: this.defaultModel,
      execution_backend: this.defaultBackend,
      app_server_approval_policy: this.appServerApprovalPolicy,
      app_server_approvals_reviewer: this.appServerApprovalsReviewer
    };
  }

  activeJobsFor(owner) {
    return [...this.jobs.values()].filter((job) =>
      job.owner === owner && ["queued", "running"].includes(job.status)
    );
  }

  listJobs(owner) {
    return [...this.jobs.values()]
      .filter((job) => job.owner === owner)
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      .map((job) => this.jobPayload(job, { includeEvents: false }));
  }

  getJob(owner, id) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) {
      throw new RelayError("Mobile job was not found", {
        code: "mobile_job_not_found",
        status: 404
      });
    }
    return job;
  }

  jobPayload(job, { includeEvents = true, after = 0 } = {}) {
    const events = includeEvents
      ? job.events.filter((event) => event.sequence > after)
      : undefined;
    return {
      id: job.id,
      owner: job.owner,
      status: job.status,
      title: job.title,
      prompt: job.prompt,
      cwd: job.cwd,
      backend: job.backend,
      model: job.model,
      sandbox: job.sandbox,
      approval_policy: job.approval_policy,
      approvals_reviewer: job.approvals_reviewer,
      thread_id: job.thread_id,
      turn_id: job.turn_id,
      started_at: job.started_at,
      updated_at: job.updated_at,
      completed_at: job.completed_at,
      exit_code: job.exit_code,
      signal: job.signal,
      error: job.error,
      final_response: job.final_response,
      pending_approvals: [...job.pending_approvals.values()].map(approvalPayload),
      event_count: job.events.length,
      ...(includeEvents ? { events } : {})
    };
  }

  startJob(owner, input = {}) {
    if (this.activeJobsFor(owner).length >= this.maxActiveRunsPerUser) {
      throw new RelayError("A Codex mobile job is already running for this user", {
        code: "mobile_job_limit",
        status: 409
      });
    }
    const prompt = normalizePrompt(input.prompt, this.maxPromptChars);
    const cwd = resolveWorkspace(input.cwd, this.workspaceRoots);
    const backend = normalizeBackend(input.backend || this.defaultBackend);
    const id = crypto.randomUUID();
    const job = {
      id,
      owner,
      status: "queued",
      title: String(input.title || prompt).trim().slice(0, 80),
      prompt,
      cwd,
      backend,
      model: input.model || this.defaultModel,
      sandbox: input.sandbox || this.defaultSandbox,
      approval_policy: input.approval_policy || this.appServerApprovalPolicy,
      approvals_reviewer: input.approvals_reviewer || this.appServerApprovalsReviewer,
      thread_id: input.thread_id || null,
      turn_id: input.turn_id || null,
      relay_session_id: input.relay_session_id || null,
      skip_git_repo_check: input.skip_git_repo_check ?? this.skipGitRepoCheck,
      started_at: nowIso(),
      updated_at: nowIso(),
      completed_at: null,
      exit_code: null,
      signal: null,
      error: null,
      final_response: "",
      process: null,
      interrupt: null,
      pending_approvals: new Map(),
      sequence: 0,
      events: []
    };
    this.jobs.set(id, job);
    this.pruneJobs();
    this.emit(job, "job_created", {
      cwd: job.cwd,
      backend: job.backend,
      model: job.model,
      sandbox: job.sandbox,
      thread_id: job.thread_id
    });
    this.runJob(job);
    return this.jobPayload(job);
  }

  interruptJob(owner, id) {
    const job = this.getJob(owner, id);
    if (!["queued", "running"].includes(job.status)) {
      return this.jobPayload(job);
    }
    job.status = "cancelling";
    job.updated_at = nowIso();
    this.emit(job, "job_cancelling", {});
    if (job.interrupt) {
      job.interrupt();
    } else {
      job.process?.kill("SIGTERM");
    }
    return this.jobPayload(job);
  }

  resolveApproval(owner, id, approvalId, decision) {
    const job = this.getJob(owner, id);
    const approval = job.pending_approvals.get(approvalId);
    if (!approval) {
      throw new RelayError("Mobile approval request was not found", {
        code: "mobile_approval_not_found",
        status: 404
      });
    }
    const normalized = normalizeApprovalDecision(decision);
    try {
      approval.resolve(normalized);
    } catch (error) {
      throw new RelayError(`Failed to resolve mobile approval: ${error.message}`, {
        code: "mobile_approval_resolve_failed",
        status: 502,
        cause: error
      });
    }
    job.pending_approvals.delete(approvalId);
    this.emit(job, "approval_resolved", {
      ...approvalPayload(approval),
      decision: normalized
    });
    return this.jobPayload(job);
  }

  subscribe(owner, id, listener) {
    const job = this.getJob(owner, id);
    const eventName = `job:${job.id}`;
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }

  emit(job, type, payload = {}) {
    job.sequence += 1;
    job.updated_at = nowIso();
    const event = {
      sequence: job.sequence,
      at: job.updated_at,
      type,
      payload,
      summary: type === "codex_event" ? eventSummary(payload) : ""
    };
    const threadId = extractThreadId(payload);
    if (threadId && !job.thread_id) {
      job.thread_id = threadId;
    }
    const message = extractAgentMessage(payload);
    if (message) {
      job.final_response = isAgentMessageDelta(payload)
        ? `${job.final_response}${message}`
        : message;
    }
    job.events.push(event);
    if (job.events.length > this.maxEventsPerJob) {
      job.events.splice(0, job.events.length - this.maxEventsPerJob);
    }
    this.emitter.emit(`job:${job.id}`, event);
    return event;
  }

  async runJob(job) {
    job.status = "running";
    job.updated_at = nowIso();
    this.emit(job, "job_started", {});
    try {
      const runner = job.backend === "app-server" ? this.appServerRunner : this.runner;
      const result = await runner({
        job,
        emit: (type, payload) => this.emit(job, type, payload)
      });
      job.exit_code = result.exitCode;
      job.signal = result.signal;
      if (result.ok) {
        job.status = "completed";
        this.emit(job, "job_completed", {
          exit_code: result.exitCode,
          signal: result.signal
        });
      } else if (job.status === "cancelling") {
        job.status = "cancelled";
        job.error = result.error?.message || `Codex exited with code ${result.exitCode ?? "unknown"}`;
        this.emit(job, "job_cancelled", {
          exit_code: result.exitCode,
          signal: result.signal,
          error: job.error
        });
      } else {
        job.status = "failed";
        job.error = result.error?.message || `Codex exited with code ${result.exitCode ?? "unknown"}`;
        this.emit(job, "job_failed", {
          exit_code: result.exitCode,
          signal: result.signal,
          error: job.error
        });
      }
    } catch (error) {
      job.status = job.status === "cancelling" ? "cancelled" : "failed";
      job.error = error.message;
      this.emit(job, job.status === "cancelled" ? "job_cancelled" : "job_failed", { error: error.message });
    } finally {
      job.completed_at = nowIso();
      job.updated_at = job.completed_at;
      job.process = null;
    }
  }

  pruneJobs() {
    const jobs = [...this.jobs.values()].sort((a, b) =>
      String(b.started_at).localeCompare(String(a.started_at))
    );
    for (const job of jobs.slice(this.maxJobs)) {
      if (!["queued", "running", "cancelling"].includes(job.status)) {
        this.jobs.delete(job.id);
      }
    }
  }
}
