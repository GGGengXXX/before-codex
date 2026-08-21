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
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*model_provider\s*=\s*"?([^"#\s]+)"?\s*(?:#.*)?$/);
    if (match) {
      return match[1];
    }
  }
  return null;
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
  if (/^\s*model_provider\s*=/m.test(content)) {
    return content.replace(/^\s*model_provider\s*=.*$/m, `model_provider = "${provider}"`);
  }
  return `model_provider = "${provider}"\n${content}`;
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
      relay_configured: /^\s*\[model_providers\.relay\]\s*$/m.test(content)
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        path: absolutePath,
        exists: false,
        model_provider: null,
        relay_configured: false
      };
    }
    throw error;
  }
}

export async function writeCodexModelProvider({
  modelProvider,
  relayBaseUrl,
  envKey = "RELAY_API_KEY",
  authCommand = null,
  configPath = defaultCodexConfigPath(),
  statePath = defaultCodexStatePath()
}) {
  if (!["openai", "relay"].includes(modelProvider)) {
    throw new Error('model_provider must be either "openai" or "relay"');
  }
  const absolutePath = path.resolve(configPath);
  let content = "";
  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  let nextContent = setTopLevelModelProvider(content, modelProvider);
  if (modelProvider === "relay") {
    nextContent = upsertRelayBlock(nextContent, {
      relayBaseUrl,
      envKey,
      authCommand
    });
  }
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${nextContent.trimEnd()}\n`, { mode: 0o600 });
  const codex = await readCodexConfig(absolutePath);
  codex.threads = await updateCodexThreadModelProviders(modelProvider, statePath);
  return codex;
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
