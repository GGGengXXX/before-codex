import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { AccountStore } from "./accounts.js";
import { classifyUpstreamFailure } from "./classifier.js";
import {
  defaultCodexConfigPath,
  defaultCodexStatePath,
  readCodexConfig,
  relayTokenAuthCommand,
  writeCodexModelProvider
} from "./codex-config.js";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { extractOutputTextFromJson, extractUsageFromJson } from "./upstream.js";
import { createRuntimeState } from "./state.js";

const ansi = {
  reset: "\x1b[0m", bold: "\x1b[1m", cyan: "\x1b[36m", blue: "\x1b[34m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", magenta: "\x1b[35m",
  gray: "\x1b[90m", white: "\x1b[37m"
};

function color(name, value) {
  if (process.env.NO_COLOR) return String(value);
  return `${ansi[name] ?? ""}${value}${ansi.reset}`;
}

function bold(value) { return color("bold", value); }

function truncate(value, limit = 72) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function mask(value) {
  const text = String(value ?? "");
  if (!text) return "<empty>";
  if (text.startsWith("env:") || text.startsWith("missing-env:")) return text;
  if (text === "missing-user-api-key") return "<not configured>";
  return `${"*".repeat(Math.min(12, Math.max(4, text.length - 4)))}${text.slice(-4)}`;
}

function banner() {
  return [
    color("cyan", "  ____            _             ____      _           "),
    color("cyan", " / ___|  ___   __| | _____  __ |  _ \\ ___| | __ _ _   _"),
    color("cyan", " \\___ \\ / _ \\ / _` |/ _ \\ \\/ / | |_) / _ \\ |/ _` | | | |"),
    color("cyan", "  ___) | (_) | (_| |  __/>  <  |  _ <  __/ | (_| | |_| |"),
    color("cyan", " |____/ \\___/ \\__,_|\\___/_/\\_\\ |_| \\_\\___|_|\\__,_|\\__, |"),
    color("cyan", "                                                     |___/"),
    color("gray", "  Codex Relay  /  local multi-user gateway")
  ].join("\n");
}

function configPathFromArgs() {
  const index = process.argv.indexOf("--config");
  return path.resolve(index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : process.env.RELAY_CONFIG || "config.json");
}

function sessionLabel() {
  return process.env.RELAY_SESSION_ID || process.env.ITERM_SESSION_ID || process.env.TERM_SESSION_ID || process.env.WT_SESSION || "default";
}

function currentDeployments(config) {
  return Object.entries(config.models).flatMap(([modelName, model]) => model.deployments.map((deployment) => ({ modelName, model, deployment })));
}

function emptyGuestRecord(configPath) { return { username: "Guest", config_path: configPath, guest: true }; }

async function saveValidatedJson(filePath, value) {
  const absolutePath = path.resolve(filePath);
  const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await loadConfig(temporaryPath);
    await fs.rename(temporaryPath, absolutePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function pageRow(selected, label, detail = "") {
  const pointer = selected ? color("green", ">") : " ";
  const title = selected ? color("green", bold(label)) : label;
  return ` ${pointer} ${title}${detail ? ` ${color("gray", detail)}` : ""}`;
}

function formFieldValue(field) {
  if (field.type === "toggle") return field.value ? "ON" : "OFF";
  if (field.secret) return mask(field.value);
  return field.value === "" ? color("gray", "<empty>") : truncate(field.value, 82);
}

function editableValue(field) {
  if (field.type === "toggle") return field.value ? "ON" : "OFF";
  const value = String(field.value ?? "");
  const cursor = Math.max(0, Math.min(field.cursor ?? value.length, value.length));
  const shown = field.secret ? "*".repeat(value.length) : value;
  return `${shown.slice(0, cursor)}${color("yellow", "|")}${shown.slice(cursor)}` || color("yellow", "|");
}

function formatTokens(usage) {
  if (!usage) return "-";
  return `${Number(usage.total_tokens ?? 0).toLocaleString()} tok${usage.estimated ? color("yellow", " estimated") : ""}`;
}

function formatStatus(status) {
  if (status === "healthy") return color("green", "healthy");
  if (status === "disabled") return color("gray", "disabled");
  if (status === "cooling_down") return color("yellow", "cooling");
  return color("red", status || "unknown");
}

function enterKey(key) { return key?.name === "return" || key?.name === "enter"; }
function escapeKey(key) { return key?.name === "escape" || key?.sequence === "\x1b"; }

class RelayCli {
  constructor({ store, baseConfig, configPath, record = null, initialScreen = null }) {
    this.store = store;
    this.baseConfig = baseConfig;
    this.configPath = configPath;
    this.record = record;
    this.initialScreen = initialScreen;
    this.screen = initialScreen || (record ? "home" : "auth");
    this.backStack = [];
    this.cursor = 0;
    this.logPage = 0;
    this.logPageSize = 8;
    this.logDetail = null;
    this.detailView = "summary";
    this.dashboardRange = "week";
    this.form = null;
    this.config = baseConfig;
    this.state = createRuntimeState(baseConfig);
    this.deployments = [];
    this.snapshots = [];
    this.calls = [];
    this.callTotal = 0;
    this.provider = null;
    this.lastTest = null;
    this.status = { type: "info", text: "Ready" };
    this.busy = false;
    this.handlingKey = false;
    this.keyQueue = [];
    this.closed = false;
    this.resolveRun = null;
    this.onKeypress = null;
  }

  async prepare() {
    if (this.record) await this.refresh();
    if (this.initialScreen === "register") this.beginAuth("register");
    if (this.initialScreen === "login") this.beginAuth("login");
  }

  async refresh() {
    this.config = await loadConfig(this.record.config_path);
    this.state = createRuntimeState(this.config);
    this.deployments = currentDeployments(this.config);
    this.snapshots = this.state.snapshot(this.deployments);
    this.provider = (await readCodexConfig()).model_provider;
    const history = this.state.callHistory({ offset: this.logPage * this.logPageSize, limit: this.logPageSize });
    this.calls = history.calls;
    this.callTotal = history.total;
  }

  setStatus(text, type = "info") { this.status = { text, type }; }

  cursorLimit() {
    if (this.screen === "auth") return 3;
    if (this.screen === "home") return 7;
    if (this.screen === "apis") return this.deployments.length;
    if (this.screen === "routes") return Math.max(0, Object.keys(this.config.models ?? {}).length - 1);
    if (this.screen === "logs") return Math.max(0, this.calls.length - 1);
    if (this.screen === "provider") return 1;
    if (this.screen === "account") return this.record?.guest ? 2 : 3;
    return 0;
  }

  open(screen, context = null) {
    this.backStack.push(this.screen);
    this.screen = screen;
    this.cursor = 0;
    if (context) Object.assign(this, context);
  }

  back() {
    if (this.form) this.form = null;
    this.screen = this.backStack.pop() || (this.record ? "home" : "auth");
    this.cursor = 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (input.isTTY && input.setRawMode) input.setRawMode(false);
    input.pause();
    if (this.onKeypress) input.off("keypress", this.onKeypress);
    output.write("\x1b[?25h\x1b[0m\n");
    this.resolveRun?.();
  }

  async run() {
    if (!input.isTTY || !output.isTTY || !input.setRawMode) {
      output.write(`${banner()}\n\n${color("yellow", "This interface needs an interactive terminal. Run npm run cli directly in a TTY.")}\n`);
      return;
    }
    await this.prepare();
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    await new Promise((resolve) => {
      this.resolveRun = resolve;
      this.onKeypress = (str, key) => {
        if (this.closed || this.busy) return;
        this.keyQueue.push({ str, key });
        this.processKeyQueue();
      };
      input.on("keypress", this.onKeypress);
      this.render();
    });
  }

  async processKeyQueue() {
    if (this.handlingKey || this.closed) return;
    this.handlingKey = true;
    try {
      while (this.keyQueue.length > 0 && !this.closed) {
        const { str, key } = this.keyQueue.shift();
        try {
          await this.handleKey(str, key);
        } catch (error) {
          this.setStatus(error.message, "error");
        }
        if (!this.closed) this.render();
      }
    } finally {
      this.handlingKey = false;
    }
  }

  render() {
    if (this.closed) return;
    output.write(`\x1b[2J\x1b[H\x1b[?25l${[banner(), "", this.renderPage(), "", this.renderStatus(), this.renderFooter()].join("\n")}\n`);
  }

  renderStatus() {
    const prefix = this.busy ? color("yellow", "... ") : "";
    const statusColor = this.status.type === "error" ? "red" : this.status.type === "success" ? "green" : "gray";
    return `${prefix}${color(statusColor, this.status.text)}`;
  }

  renderFooter() {
    if (this.screen === "form") return color("gray", "↑↓ fields  ←→ cursor  Enter next  Ctrl+S save  Ctrl+X clear  Esc cancel");
    if (["logs", "call-detail"].includes(this.screen)) return color("gray", "↑↓ select  ←→ page/view  Enter open  Esc back  q quit");
    return color("gray", "↑↓ select  Enter open  Esc back  q quit");
  }

  renderPage() {
    switch (this.screen) {
      case "auth": return this.renderAuth();
      case "form": return this.renderForm();
      case "home": return this.renderHome();
      case "apis": return this.renderApis();
      case "routes": return this.renderRoutes();
      case "logs": return this.renderLogs();
      case "call-detail": return this.renderCallDetail();
      case "dashboard": return this.renderDashboard();
      case "provider": return this.renderProvider();
      case "account": return this.renderAccount();
      case "test-result": return this.renderTestResult();
      default: return color("red", `Unknown page: ${this.screen}`);
    }
  }

  renderAuth() {
    const options = [
      ["Continue as Guest", "Use the shared config without signing in"],
      ["Log in", "Open a saved account for this terminal"],
      ["Register", "Create a separate API profile"],
      ["Exit", "Leave the relay control panel"]
    ];
    return [bold("Welcome"), color("gray", `Terminal session: ${sessionLabel()}`), "", ...options.map(([label, detail], index) => pageRow(this.cursor === index, label, detail))].join("\n");
  }

  renderHome() {
    const options = [
      ["Overview", "Usage, latency and model comparison"],
      ["APIs & keys", `${this.deployments.length} deployments configured`],
      ["Routes / aliases", `${Object.keys(this.config.models ?? {}).length} logical models`],
      ["Recent logs", `${this.callTotal} recorded calls`],
      ["Codex provider", this.provider || "not detected"],
      ["Account & session", this.record?.guest ? "Guest profile" : `Signed in as ${this.record?.username}`],
      ["Reload relay", "Apply the current profile without restarting"],
      ["Quit", "Close the CLI"]
    ];
    return [bold(`Control center  ${color("gray", this.record?.guest ? "Guest" : this.record?.username)}`), color("gray", `${this.configPath}  ·  ${this.config.server.host}:${this.config.server.port}`), "", ...options.map(([label, detail], index) => pageRow(this.cursor === index, label, detail))].join("\n");
  }

  renderApis() {
    const rows = this.deployments.map((item, index) => {
      const snapshot = this.snapshots[index] || {};
      const detail = `${snapshot.provider || item.deployment.provider} · ${item.deployment.model} · p${item.deployment.priority ?? 100}/w${item.deployment.weight ?? 1} · ${formatStatus(snapshot.status)}`;
      return pageRow(this.cursor === index, item.deployment.id, detail);
    });
    rows.push(pageRow(this.cursor === this.deployments.length, "+ Add API", "Create another URL + key deployment"));
    return [bold("APIs & keys"), color("gray", "Enter edits an API  ·  t tests it  ·  a adds a deployment"), "", ...rows].join("\n");
  }

  renderRoutes() {
    const names = Object.keys(this.config.models ?? {});
    return [bold("Routes / aliases"), color("gray", "A route is the model name Codex sends to the relay"), "", ...names.map((name, index) => {
      const route = this.config.models[name];
      return pageRow(this.cursor === index, name, route.aliases?.length ? route.aliases.join(", ") : "no aliases");
    })].join("\n");
  }

  renderLogs() {
    const pageCount = Math.max(1, Math.ceil(this.callTotal / this.logPageSize));
    const rows = this.calls.map((call, index) => {
      const status = call.result === "success" ? color("green", "OK") : color("red", "FAIL");
      const time = String(call.at || "").replace("T", " ").slice(0, 19);
      return pageRow(this.cursor === index, time || "unknown time", `${status} · ${call.upstream_model || "-"} · ${call.duration_ms ?? "-"}ms · ${formatTokens(call.usage)}`);
    });
    return [bold("Recent logs"), color("gray", `Page ${this.logPage + 1}/${pageCount}  ·  ${this.callTotal} calls  ·  Enter opens detail`), "", ...(rows.length ? rows : [color("gray", "  No calls recorded for this profile")])].join("\n");
  }

  renderCallDetail() {
    const call = this.logDetail;
    if (!call) return color("gray", "No call selected");
    if (this.detailView === "json") return [bold("Call detail  /  JSON"), "", JSON.stringify(call, null, 2)].join("\n");
    const status = call.result === "success" ? color("green", "SUCCESS") : color("red", "FAILURE");
    return [bold("Call detail  /  Summary"), "", `  ${bold("Result")}       ${status}`, `  ${bold("Deployment")}   ${call.deployment_id || "-"}`, `  ${bold("Provider")}     ${call.provider || "-"}`, `  ${bold("Model")}        ${call.upstream_model || "-"}`, `  ${bold("Duration")}     ${call.duration_ms ?? "-"} ms`, `  ${bold("Usage")}        ${formatTokens(call.usage)}`, `  ${bold("Request ID")}   ${call.request_id || "-"}`, "", `  ${bold("Response")}`, `  ${truncate(call.response_text || call.error?.message || "<empty>", 110)}`, "", color("gray", "Press j for JSON view · s for summary view")].join("\n");
  }

  renderDashboard() {
    const usage = this.state.usageSummary()[this.dashboardRange];
    const total = usage?.total ?? {};
    const models = Object.entries(usage?.models ?? {}).sort(([, left], [, right]) => (right.total_tokens ?? 0) - (left.total_tokens ?? 0)).slice(0, 8);
    const maxTokens = Math.max(1, ...models.map(([, value]) => value.total_tokens ?? 0));
    const bars = models.length ? models.map(([name, value]) => {
      const size = Math.max(1, Math.round(((value.total_tokens ?? 0) / maxTokens) * 24));
      return `  ${truncate(name, 20).padEnd(20)} ${color("cyan", "#".repeat(size).padEnd(24))} ${formatTokens(value)} · ${value.avg_latency_ms ?? 0}ms`;
    }) : [color("gray", "  No usage yet")];
    return [bold("Overview"), color("gray", "←→ changes range"), "", `  ${color("cyan", "Range")}       ${this.dashboardRange}`, `  ${color("green", "Calls")}       ${total.calls ?? 0}  (${total.failures ?? 0} failures)`, `  ${color("yellow", "Tokens")}      ${(total.total_tokens ?? 0).toLocaleString()}${total.estimated_calls ? color("yellow", `  · ${total.estimated_calls} estimated`) : ""}`, `  ${color("magenta", "Avg latency")} ${total.avg_latency_ms ?? 0} ms`, "", bold("Models"), ...bars].join("\n");
  }

  renderProvider() {
    const options = ["openai", "relay"];
    return [bold("Codex provider"), color("gray", "Enter applies the selected provider and updates Codex threads"), "", ...options.map((name, index) => pageRow(this.cursor === index, name, name === this.provider ? "current" : "")), "", color("gray", `config: ${defaultCodexConfigPath()}`), color("gray", `state:  ${defaultCodexStatePath()}`)].join("\n");
  }

  renderAccount() {
    const guest = this.record?.guest;
    const options = guest ? ["Log in", "Register", "Back"] : ["Set as default", "Log out", "Delete account", "Back"];
    return [bold("Account & session"), color("gray", guest ? "Guest mode does not require credentials" : `Signed in as ${this.record.username}`), "", ...options.map((label, index) => pageRow(this.cursor === index, label)), "", color("gray", `session: ${sessionLabel()}`)].join("\n");
  }

  renderTestResult() {
    const result = this.lastTest;
    if (!result) return color("gray", "No test result");
    return [bold("Test API  /  Result"), "", `  ${bold("Status")}       ${result.ok ? color("green", "PASSED") : color("red", "FAILED")}`, `  ${bold("Deployment")}   ${result.deploymentId}`, `  ${bold("Provider")}     ${result.provider}`, `  ${bold("Model")}        ${result.model}`, `  ${bold("Duration")}     ${result.durationMs} ms`, `  ${bold("Usage")}        ${formatTokens(result.usage)}`, "", `  ${bold(result.ok ? "Response" : "Error")}`, `  ${truncate(result.ok ? result.responseText : result.error, 110)}`, "", color("gray", "Press Esc to return to APIs")].join("\n");
  }

  renderForm() {
    const form = this.form;
    if (!form) return color("gray", "No form open");
    return [bold(form.title), form.subtitle ? color("gray", form.subtitle) : "", "", ...form.fields.map((field, index) => {
      const selected = index === form.index;
      const value = selected ? editableValue(field) : formFieldValue(field);
      const hint = field.hint ? color("gray", `  ${field.hint}`) : "";
      return ` ${selected ? color("green", ">") : " "} ${`${field.label}:`.padEnd(16)} ${value}${hint}`;
    })].join("\n");
  }

  beginAuth(kind, backPage = "auth") {
    const fields = kind === "login"
      ? [{ key: "username", label: "Username", value: "", cursor: 0 }, { key: "password", label: "Password", value: "", cursor: 0, secret: true }]
      : [{ key: "username", label: "Username", value: "", cursor: 0, hint: "3-32 letters, numbers, _ or -" }, { key: "password", label: "Password", value: "", cursor: 0, secret: true, hint: "at least 8 characters" }, { key: "repeat", label: "Repeat password", value: "", cursor: 0, secret: true }];
    this.form = { title: kind === "login" ? "Log in" : "Register", subtitle: kind === "login" ? "Credentials stay local to this relay" : "Create a profile with its own API keys and logs", kind, index: 0, fields, backPage: "auth" };
    this.screen = "form";
    this.backStack = [backPage];
  }

  beginApiForm(index = null) {
    const item = index === null ? null : this.deployments[index];
    const deployment = item?.deployment;
    const firstModel = Object.keys(this.config.models ?? {})[0];
    this.form = {
      title: deployment ? `Edit API  /  ${deployment.id}` : "Add API",
      subtitle: "The API key is stored only in this profile",
      kind: deployment ? "edit-api" : "add-api",
      index: 0,
      modelName: item?.modelName || firstModel,
      deploymentId: deployment?.id || null,
      fields: [
        { key: "id", label: "API id", value: deployment?.id || `api-${Date.now()}`, cursor: deployment?.id?.length ?? 0 },
        { key: "provider", label: "Provider", value: deployment?.provider || "custom", cursor: (deployment?.provider || "custom").length },
        { key: "base_url", label: "Base URL", value: deployment?.base_url || "", cursor: deployment?.base_url?.length ?? 0 },
        { key: "model", label: "Upstream model", value: deployment?.model || "", cursor: deployment?.model?.length ?? 0 },
        { key: "api_key", label: "API key", value: deployment?.api_key || "", cursor: deployment?.api_key?.length ?? 0, secret: true, hint: "Ctrl+X clears it" },
        { key: "priority", label: "Priority", value: String(deployment?.priority ?? 100), cursor: String(deployment?.priority ?? 100).length, hint: "lower runs first" },
        { key: "weight", label: "Weight", value: String(deployment?.weight ?? 1), cursor: String(deployment?.weight ?? 1).length, hint: "same-priority share" },
        { key: "enabled", label: "Enabled", value: deployment?.enabled !== false, type: "toggle" }
      ],
      backPage: "apis"
    };
    this.openFormFrom("apis");
  }

  beginRouteForm(name) {
    const route = this.config.models[name];
    const aliases = (route.aliases || []).join(", ");
    this.form = { title: `Edit route  /  ${name}`, subtitle: "Aliases are model names Codex may send to the relay", kind: "route", index: 0, routeName: name, fields: [{ key: "aliases", label: "Codex aliases", value: aliases, cursor: aliases.length, hint: "comma separated" }], backPage: "routes" };
    this.openFormFrom("routes");
  }

  beginDeleteApiForm(index) {
    const item = this.deployments[index];
    if (!item) return;
    this.form = {
      title: `Remove API  /  ${item.deployment.id}`,
      subtitle: "This removes the deployment from the current profile",
      kind: "delete-api",
      index: 0,
      modelName: item.modelName,
      deploymentId: item.deployment.id,
      fields: [{ key: "confirm", label: "Confirm removal", value: false, type: "toggle", hint: "toggle ON, then Ctrl+S" }],
      backPage: "apis"
    };
    this.openFormFrom("apis");
  }

  openFormFrom(page) { this.backStack = [page]; this.screen = "form"; this.cursor = 0; }

  async submitForm() {
    const form = this.form;
    const values = Object.fromEntries(form.fields.map((field) => [field.key, field.value]));
    this.busy = true;
    this.setStatus("Saving...", "info");
    this.render();
    try {
      if (form.kind === "login") {
        const record = await this.store.authenticatePassword(values.username, values.password);
        await this.store.setSession(record);
        this.record = record;
        this.form = null; this.backStack = []; this.screen = "home";
        await this.refresh();
        this.setStatus(`Signed in as ${record.username}`, "success");
      } else if (form.kind === "register") {
        if (values.password !== values.repeat) throw new Error("Passwords do not match");
        const account = await this.store.register(values.username, values.password, this.baseConfig);
        const record = await this.store.authenticatePassword(values.username, values.password);
        await this.store.setSession(record);
        this.record = record;
        this.form = null; this.backStack = []; this.screen = "home";
        await this.refresh();
        this.setStatus(`Account ${account.username} created`, "success");
      } else if (form.kind === "delete-account") {
        await this.store.delete(this.record.username, values.password);
        await this.store.clearSession();
        this.record = emptyGuestRecord(this.configPath);
        this.form = null; this.backStack = []; this.screen = "auth";
        this.setStatus("Account deleted", "success");
      } else if (form.kind === "delete-api") {
        if (!values.confirm) throw new Error("Toggle Confirm removal ON before saving");
        const config = await loadConfig(this.record.config_path);
        const model = config.models[form.modelName];
        if (!model) throw new Error("Route no longer exists; reload and try again");
        if (model.deployments.length <= 1) throw new Error("A route must keep at least one deployment");
        const originalLength = model.deployments.length;
        model.deployments = model.deployments.filter((item) => item.id !== form.deploymentId);
        if (model.deployments.length === originalLength) throw new Error("Deployment no longer exists; reload and try again");
        await saveValidatedJson(this.record.config_path, config);
        const reloaded = await this.tryReloadRelay();
        this.form = null; this.backStack = []; this.screen = "apis";
        await this.refresh();
        this.setStatus(reloaded ? `Removed ${form.deploymentId} and reloaded relay` : `Removed ${form.deploymentId}`, "success");
      } else if (form.kind === "edit-api" || form.kind === "add-api") {
        const config = await loadConfig(this.record.config_path);
        if (form.kind === "edit-api" && values.id !== form.deploymentId) throw new Error("API id cannot be changed while editing; remove and add a new API instead");
        const model = config.models[form.modelName];
        if (!model) throw new Error(`Unknown route: ${form.modelName}`);
        const deployment = form.kind === "edit-api" ? model.deployments.find((item) => item.id === form.deploymentId) : null;
        if (form.kind === "edit-api" && !deployment) throw new Error("Deployment no longer exists; reload and try again");
        const next = deployment || {};
        Object.assign(next, { id: values.id, provider: values.provider, base_url: values.base_url, model: values.model, api_key: values.api_key, priority: Number(values.priority), weight: Math.max(1, Number(values.weight)), enabled: Boolean(values.enabled) });
        if (!Number.isFinite(next.priority) || !Number.isFinite(next.weight)) throw new Error("Priority and weight must be numbers");
        if (!deployment) model.deployments.push(next);
        await saveValidatedJson(this.record.config_path, config);
        const reloaded = await this.tryReloadRelay();
        this.form = null; this.backStack = []; this.screen = "apis";
        await this.refresh();
        this.setStatus(reloaded ? `Saved ${next.id} and reloaded relay` : `Saved ${next.id}; relay is not running`, "success");
      } else if (form.kind === "route") {
        const config = await loadConfig(this.record.config_path);
        const route = config.models[form.routeName];
        if (!route) throw new Error("Route no longer exists; reload and try again");
        route.aliases = String(values.aliases).split(",").map((value) => value.trim()).filter(Boolean);
        await saveValidatedJson(this.record.config_path, config);
        const reloaded = await this.tryReloadRelay();
        this.form = null; this.backStack = []; this.screen = "routes";
        await this.refresh();
        this.setStatus(reloaded ? `Saved route ${form.routeName} and reloaded relay` : `Saved route ${form.routeName}`, "success");
      }
    } catch (error) {
      this.setStatus(error.message, "error");
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async tryReloadRelay() {
    const token = this.record?.guest ? process.env.RELAY_ADMIN_KEY : this.record?.api_token;
    if (!token) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${this.config.server.port}/admin/reload`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      return response.ok;
    } catch { return false; }
  }

  async testDeployment(index) {
    const item = this.deployments[index];
    if (!item || this.busy) return;
    const deployment = item.deployment;
    this.busy = true;
    this.setStatus(`Testing ${deployment.id}... upstream request may take a moment`, "info");
    this.render();
    const startedAt = Date.now();
    const requestText = "Reply with OK in one short sentence.";
    let result;
    try {
      const response = await fetch(`${deployment.base_url.replace(/\/+$/, "")}/responses`, { method: "POST", headers: { authorization: `Bearer ${deployment.api_key}`, "content-type": "application/json", "user-agent": "codex-relay-cli/0.1" }, body: JSON.stringify({ model: deployment.model, input: requestText, stream: false }) });
      const body = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      const durationMs = Date.now() - startedAt;
      const responseText = extractOutputTextFromJson(parsed) || body;
      if (!response.ok) {
        const classification = classifyUpstreamFailure({ status: response.status, body, headers: response.headers, rules: this.config.routing.provider_error_rules?.[deployment.provider] });
        this.state.recordFailure(deployment, classification, 0, { log_call: true, requested_model: deployment.model, logical_model: item.modelName, upstream_model: deployment.model, response_text: body, duration_ms: durationMs });
        result = { ok: false, deploymentId: deployment.id, provider: deployment.provider, model: deployment.model, durationMs, error: `${response.status} ${classification.message}` };
      } else {
        const usage = extractUsageFromJson(parsed);
        this.state.recordSuccess(deployment, { requested_model: deployment.model, logical_model: item.modelName, upstream_model: deployment.model, request_text: requestText, usage, response_text: responseText, duration_ms: durationMs });
        result = { ok: true, deploymentId: deployment.id, provider: deployment.provider, model: deployment.model, durationMs, usage, responseText };
      }
    } catch (error) {
      result = { ok: false, deploymentId: deployment.id, provider: deployment.provider, model: deployment.model, durationMs: Date.now() - startedAt, error: error.message };
    }
    this.lastTest = result;
    this.screen = "test-result";
    this.backStack = ["apis"];
    this.cursor = 0;
    this.busy = false;
    this.setStatus(result.ok ? "API test passed" : "API test failed", result.ok ? "success" : "error");
    await this.refresh();
    this.render();
  }

  async reloadRelay() {
    this.busy = true;
    this.setStatus("Reloading relay profile...", "info");
    this.render();
    const reloaded = await this.tryReloadRelay();
    this.busy = false;
    this.setStatus(reloaded ? "Relay reloaded" : "Relay is not running or rejected the reload", reloaded ? "success" : "error");
  }

  async applyProvider() {
    const provider = ["openai", "relay"][this.cursor];
    this.busy = true;
    this.setStatus(`Switching Codex to ${provider}...`, "info");
    this.render();
    try {
      const listenHost = String(this.config.server.host ?? "127.0.0.1");
      const relayHost = ["0.0.0.0", "::", "[::]"].includes(listenHost) ? "127.0.0.1" : listenHost;
      const result = await writeCodexModelProvider({ modelProvider: provider, relayBaseUrl: `http://${relayHost}:${this.config.server.port}/v1`, authCommand: relayTokenAuthCommand(process.env.RELAY_ENV || ".env"), configPath: defaultCodexConfigPath(), statePath: defaultCodexStatePath() });
      this.provider = result.model_provider || provider;
      this.setStatus(`Codex provider switched to ${this.provider}; updated ${result.threads?.updated ?? 0} threads`, "success");
    } catch (error) {
      this.setStatus(error.message, "error");
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async handleKey(str, key = {}) {
    if (key.ctrl && key.name === "c") return this.close();
    if (this.busy) return;
    if (this.screen === "form") return this.handleFormKey(str, key);
    if (key.name === "q") return this.close();
    if (escapeKey(key)) {
      if (["home", "auth"].includes(this.screen)) return this.close();
      if (this.screen === "test-result") { this.screen = "apis"; this.backStack = []; this.cursor = 0; return; }
      this.back();
      return;
    }
    if (key.name === "up") { this.cursor = Math.max(0, this.cursor - 1); return; }
    if (key.name === "down") { this.cursor = Math.min(this.cursorLimit(), this.cursor + 1); return; }
    if (this.screen === "auth") return this.handleAuthKey(key);
    if (this.screen === "home") return this.handleHomeKey(key);
    if (this.screen === "apis") return this.handleApisKey(str, key);
    if (this.screen === "routes") return this.handleRoutesKey(key);
    if (this.screen === "logs") return this.handleLogsKey(key);
    if (this.screen === "call-detail") return this.handleCallDetailKey(key);
    if (this.screen === "dashboard") return this.handleDashboardKey(key);
    if (this.screen === "provider") return this.handleProviderKey(key);
    if (this.screen === "account") return this.handleAccountKey(key);
    if (this.screen === "test-result") return this.back();
  }

  async handleAuthKey(key) {
    if (!enterKey(key)) return;
    if (this.cursor === 0) {
      this.record = emptyGuestRecord(this.configPath);
      await this.refresh(); this.screen = "home"; this.backStack = [];
      this.setStatus("Guest profile active", "success");
    } else if (this.cursor === 1) this.beginAuth("login");
    else if (this.cursor === 2) this.beginAuth("register");
    else this.close();
  }

  async handleHomeKey(key) {
    if (!enterKey(key)) return;
    const actions = ["dashboard", "apis", "routes", "logs", "provider", "account", "reload", "quit"];
    const action = actions[this.cursor];
    if (action === "quit") return this.close();
    if (action === "reload") return this.reloadRelay();
    this.open(action);
  }

  async handleApisKey(str, key) {
    if (key.name === "a") return this.beginApiForm();
    if (key.name === "t") return this.testDeployment(this.cursor);
    if (key.name === "e") return this.beginApiForm(this.cursor);
    if (key.name === "d") return this.beginDeleteApiForm(this.cursor);
    if (!enterKey(key)) return;
    if (this.cursor === this.deployments.length) return this.beginApiForm();
    if (this.deployments[this.cursor]) return this.beginApiForm(this.cursor);
  }

  async handleRoutesKey(key) {
    if (!enterKey(key)) return;
    const name = Object.keys(this.config.models ?? {})[this.cursor];
    if (name) this.beginRouteForm(name);
  }

  async handleLogsKey(key) {
    const pageCount = Math.max(1, Math.ceil(this.callTotal / this.logPageSize));
    if (key.name === "right" || key.name === "pagedown") {
      this.logPage = Math.min(pageCount - 1, this.logPage + 1); this.cursor = 0; await this.refresh(); return;
    }
    if (key.name === "left" || key.name === "pageup") {
      this.logPage = Math.max(0, this.logPage - 1); this.cursor = 0; await this.refresh(); return;
    }
    if (enterKey(key) && this.calls[this.cursor]) {
      this.logDetail = this.calls[this.cursor]; this.detailView = "summary"; this.open("call-detail");
    }
  }

  async handleCallDetailKey(key) {
    if (key.name === "j") this.detailView = "json";
    if (key.name === "s") this.detailView = "summary";
    if (key.name === "left" || key.name === "right") this.detailView = this.detailView === "summary" ? "json" : "summary";
  }

  async handleDashboardKey(key) {
    const ranges = ["week", "month", "year"];
    if (key.name === "left") this.dashboardRange = ranges[Math.max(0, ranges.indexOf(this.dashboardRange) - 1)];
    if (key.name === "right") this.dashboardRange = ranges[Math.min(ranges.length - 1, ranges.indexOf(this.dashboardRange) + 1)];
  }

  async handleProviderKey(key) { if (enterKey(key) && this.cursor < 2) return this.applyProvider(); }

  async handleAccountKey(key) {
    if (!enterKey(key)) return;
    if (this.record?.guest) {
      if (this.cursor === 0) return this.beginAuth("login", "account");
      if (this.cursor === 1) return this.beginAuth("register", "account");
      return this.back();
    }
    if (this.cursor === 0) {
      await this.store.setDefault(this.record.username);
      this.setStatus(`${this.record.username} is now the default guest profile`, "success");
    } else if (this.cursor === 1) {
      await this.store.clearSession(); this.record = emptyGuestRecord(this.configPath); await this.refresh(); this.screen = "home"; this.backStack = [];
      this.setStatus("Logged out; Guest profile active", "success");
    } else if (this.cursor === 2) this.beginDeleteForm();
    else this.back();
  }

  beginDeleteForm() {
    this.form = { title: "Delete account", subtitle: "This removes the account profile, API keys and logs from this machine", kind: "delete-account", index: 0, fields: [{ key: "password", label: "Password", value: "", cursor: 0, secret: true }], backPage: "account" };
    this.openFormFrom("account");
  }

  async handleFormKey(str, key) {
    const form = this.form;
    if (!form) return;
    if (key.ctrl && key.name === "x") {
      const field = form.fields[form.index];
      if (field.type !== "toggle") { field.value = ""; field.cursor = 0; }
      return;
    }
    if (escapeKey(key)) { this.form = null; this.back(); return; }
    if (key.name === "up") { form.index = Math.max(0, form.index - 1); return; }
    if (key.name === "down" || key.name === "tab") { form.index = Math.min(form.fields.length - 1, form.index + 1); return; }
    const field = form.fields[form.index];
    if (field.type === "toggle") {
      if (key.name === "left" || key.name === "right" || key.name === "space" || enterKey(key)) field.value = !field.value;
      return;
    }
    const value = String(field.value ?? "");
    if (key.name === "left") field.cursor = Math.max(0, (field.cursor ?? value.length) - 1);
    else if (key.name === "right") field.cursor = Math.min(value.length, (field.cursor ?? value.length) + 1);
    else if (key.name === "backspace") {
      const cursor = field.cursor ?? value.length;
      if (cursor > 0) { field.value = value.slice(0, cursor - 1) + value.slice(cursor); field.cursor = cursor - 1; }
    } else if (key.name === "delete") {
      const cursor = field.cursor ?? value.length; field.value = value.slice(0, cursor) + value.slice(cursor + 1);
    } else if (enterKey(key)) {
      if (form.index === form.fields.length - 1) return this.submitForm();
      form.index += 1;
    } else if (key.ctrl && key.name === "s") return this.submitForm();
    else if (!key.ctrl && !key.meta && typeof str === "string" && str.length > 0) {
      const cursor = field.cursor ?? value.length; field.value = value.slice(0, cursor) + str + value.slice(cursor); field.cursor = cursor + str.length;
    }
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: npm run cli [register|login|logout|default]");
    console.log("       npm run cli");
    console.log("\nUse arrow keys to navigate, Enter to open, Esc to go back, and Ctrl+C to exit.");
    return;
  }
  const store = new AccountStore();
  await loadEnvFile(process.env.RELAY_ENV || path.resolve(".env"));
  const configPath = configPathFromArgs();
  const baseConfig = await loadConfig(configPath);
  const command = ["register", "login", "logout", "default"].find((value) => process.argv.includes(value));
  if (command === "logout") { await store.clearSession(); console.log("Logged out."); return; }
  if (command === "default") {
    const token = await store.sessionToken();
    const record = await store.authenticateToken(token);
    if (!record) throw new Error("Log in first, then run npm run cli default");
    await store.setDefault(record.username); console.log(`Default account enabled: ${record.username}`); return;
  }
  const token = await store.sessionToken();
  const record = await store.authenticateToken(token);
  const cli = new RelayCli({ store, baseConfig, configPath, record, initialScreen: command || null });
  await cli.run();
}

main().catch((error) => {
  if (input.isTTY && input.setRawMode) input.setRawMode(false);
  console.error(color("red", `\n${error.message}`));
  process.exitCode = 1;
});
