import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function defaultCodexConfigPath() {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function defaultCodexStatePath() {
  return path.join(os.homedir(), ".codex", "state_5.sqlite");
}

export function relayTokenAuthCommand(envPath) {
  return {
    command: "node",
    args: [
      path.resolve("scripts/relay-token.mjs"),
      path.resolve(envPath ?? ".env"),
      "RELAY_API_KEY"
    ]
  };
}

function parseTopLevelModelProvider(content) {
  return parseTopLevelValue(content, "model_provider");
}

function parseTopLevelValue(content, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^#\\s]+))\\s*(?:#.*)?$`);
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(pattern);
    if (match) {
      const value = match[1] ?? match[2];
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    }
  }
  return null;
}

function setTopLevelValue(content, key, value) {
  const serialized = typeof value === "string" ? JSON.stringify(value) : String(value);
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`);
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    if (pattern.test(lines[index])) {
      lines[index] = `${key} = ${serialized}`;
      return lines.join("\n");
    }
  }
  return `${key} = ${serialized}\n${content}`;
}

function setTableValue(content, tableName, key, value) {
  const lines = content.split(/\r?\n/);
  const serialized = typeof value === "string" ? JSON.stringify(value) : String(value);
  let tableStart = -1;
  let tableEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const table = lines[index].match(/^\s*\[([^\]]+)\]\s*$/)?.[1] ?? null;
    if (table === tableName) {
      tableStart = index;
      continue;
    }
    if (tableStart >= 0 && table) {
      tableEnd = index;
      break;
    }
  }
  if (tableStart < 0) {
    return `${content.trimEnd()}\n\n[${tableName}]\n${key} = ${serialized}\n`;
  }
  const keyPattern = new RegExp(`^\\s*${key}\\s*=.*$`);
  for (let index = tableStart + 1; index < tableEnd; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = `${key} = ${serialized}`;
      return `${lines.join("\n").trimEnd()}\n`;
    }
  }
  lines.splice(tableEnd, 0, `${key} = ${serialized}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

function relayProviderBlock({ relayBaseUrl, envKey, authCommand = null }) {
  const lines = [
    "[model_providers.relay]",
    'name = "Codex Relay"',
    `base_url = "${relayBaseUrl}"`,
    'wire_api = "responses"'
  ];
  if (authCommand) {
    lines.push(
      "",
      "[model_providers.relay.auth]",
      `command = "${authCommand.command}"`,
      `args = [${authCommand.args.map((arg) => JSON.stringify(arg)).join(", ")}]`
    );
  } else {
    lines.splice(3, 0, `env_key = "${envKey}"`);
  }
  return lines.join("\n");
}

function setTopLevelModelProvider(content, provider) {
  return setTopLevelValue(content, "model_provider", provider);
}

function upsertRelayBlock(content, options) {
  const block = relayProviderBlock(options);
  const lines = content.split(/\r?\n/);
  const kept = [];
  let skippingRelay = false;
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1] ?? null;
    if (table === "model_providers.relay" || table === "model_providers.relay.auth") {
      skippingRelay = true;
      continue;
    }
    if (skippingRelay && table) {
      skippingRelay = false;
    }
    if (!skippingRelay) {
      kept.push(line);
    }
  }
  return `${kept.join("\n").trimEnd()}\n\n${block}\n`;
}

export async function readCodexConfig(configPath = defaultCodexConfigPath()) {
  const absolutePath = path.resolve(configPath);
  try {
    const content = await fs.readFile(absolutePath, "utf8");
    return {
      path: absolutePath,
      exists: true,
      model_provider: parseTopLevelModelProvider(content),
      approval_policy: parseTopLevelValue(content, "approval_policy"),
      sandbox_mode: parseTopLevelValue(content, "sandbox_mode"),
      network_access: parseTableValue(content, "sandbox_workspace_write", "network_access"),
      relay_configured: /^\s*\[model_providers\.relay\]\s*$/m.test(content)
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        path: absolutePath,
        exists: false,
        model_provider: null,
        approval_policy: null,
        sandbox_mode: null,
        network_access: null,
        relay_configured: false
      };
    }
    throw error;
  }
}

function parseTableValue(content, tableName, key) {
  const lines = content.split(/\r?\n/);
  let inTable = false;
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1] ?? null;
    if (table) {
      inTable = table === tableName;
      continue;
    }
    if (inTable) {
      const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`));
      if (match) return match[1] === "true";
    }
  }
  return null;
}

function validateCodexSettings({ modelProvider, approvalPolicy, sandboxMode, networkAccess }) {
  if (modelProvider !== undefined && !["openai", "relay"].includes(modelProvider)) {
    throw new Error('model_provider must be either "openai" or "relay"');
  }
  if (approvalPolicy !== undefined && !["untrusted", "on-failure", "on-request", "never"].includes(approvalPolicy)) {
    throw new Error("approval_policy must be one of untrusted, on-failure, on-request, never");
  }
  if (sandboxMode !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(sandboxMode)) {
    throw new Error("sandbox_mode must be one of read-only, workspace-write, danger-full-access");
  }
  if (networkAccess !== undefined && typeof networkAccess !== "boolean") {
    throw new Error("network_access must be a boolean");
  }
}

export async function writeCodexConfig({
  modelProvider,
  approvalPolicy,
  sandboxMode,
  networkAccess,
  relayBaseUrl,
  envKey = "RELAY_API_KEY",
  authCommand = null,
  configPath = defaultCodexConfigPath(),
  statePath = defaultCodexStatePath()
}) {
  if (
    modelProvider === undefined
    && approvalPolicy === undefined
    && sandboxMode === undefined
    && networkAccess === undefined
  ) {
    throw new Error("At least one Codex setting is required");
  }
  validateCodexSettings({ modelProvider, approvalPolicy, sandboxMode, networkAccess });
  const absolutePath = path.resolve(configPath);
  let content = "";
  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let nextContent = content;
  if (modelProvider !== undefined) {
    nextContent = setTopLevelModelProvider(nextContent, modelProvider);
    if (modelProvider === "relay") {
      nextContent = upsertRelayBlock(nextContent, { relayBaseUrl, envKey, authCommand });
    }
  }
  if (approvalPolicy !== undefined) nextContent = setTopLevelValue(nextContent, "approval_policy", approvalPolicy);
  if (sandboxMode !== undefined) nextContent = setTopLevelValue(nextContent, "sandbox_mode", sandboxMode);
  if (networkAccess !== undefined) nextContent = setTableValue(nextContent, "sandbox_workspace_write", "network_access", networkAccess);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${nextContent.trimEnd()}\n`, { mode: 0o600 });
  const codex = await readCodexConfig(absolutePath);
  if (modelProvider !== undefined) codex.threads = await updateCodexThreadModelProviders(modelProvider, statePath);
  return codex;
}

export async function writeCodexModelProvider({
  modelProvider,
  relayBaseUrl,
  envKey = "RELAY_API_KEY",
  authCommand = null,
  configPath = defaultCodexConfigPath(),
  statePath = defaultCodexStatePath()
}) {
  return writeCodexConfig({
    modelProvider,
    relayBaseUrl,
    envKey,
    authCommand,
    configPath,
    statePath
  });
}

export async function updateCodexThreadModelProviders(modelProvider, statePath = defaultCodexStatePath()) {
  if (!["openai", "relay"].includes(modelProvider)) {
    throw new Error('model_provider must be either "openai" or "relay"');
  }
  const absolutePath = path.resolve(statePath);
  try {
    await fs.access(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        path: absolutePath,
        exists: false,
        updated: 0,
        skipped: true
      };
    }
    throw error;
  }

  const countSql = "SELECT COUNT(*) FROM threads;";
  const updateSql = `UPDATE threads SET model_provider='${modelProvider}'; SELECT changes();`;
  const before = await execFileAsync("sqlite3", [absolutePath, countSql]);
  const result = await execFileAsync("sqlite3", [absolutePath, updateSql]);
  const total = Number(before.stdout.trim()) || 0;
  const updated = Number(result.stdout.trim().split(/\s+/).at(-1)) || 0;
  return {
    path: absolutePath,
    exists: true,
    total,
    updated,
    skipped: false
  };
}
