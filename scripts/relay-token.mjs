import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const rawValue = match[2].trim();
    const quote = rawValue[0];
    values[match[1]] =
      (quote === "'" || quote === '"') && rawValue.at(-1) === quote
        ? rawValue.slice(1, -1)
        : rawValue.replace(/\s+#.*$/, "");
  }
  return values;
}

const envPath = path.resolve(
  process.argv[2] ?? process.env.RELAY_ENV ?? path.join(process.cwd(), ".env")
);
const keyName = process.argv[3] ?? "RELAY_API_KEY";

function sessionKey() {
  return process.env.RELAY_SESSION_ID
    || process.env.ITERM_SESSION_ID
    || process.env.TERM_SESSION_ID
    || process.env.WT_SESSION
    || "default";
}

function sessionFile() {
  const digest = crypto.createHash("sha256").update(sessionKey()).digest("hex");
  return path.join(os.homedir(), ".codex-relay", "sessions", `${digest}.json`);
}

function accountState() {
  const filePath = path.join(os.homedir(), ".codex-relay", "accounts.json");
  try {
    const value = JSON.parse(fs.readFileSync(sessionFile(), "utf8"));
    return { token: value.api_token, hasAccounts: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    const values = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      token: values.accounts?.[values.default_username]?.api_token,
      hasAccounts: Object.keys(values.accounts ?? {}).length > 0
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { token: null, hasAccounts: false };
}

try {
  const account = accountState();
  if (account.token) {
    process.stdout.write(account.token);
    process.exit(0);
  }
  const values = parseEnv(fs.readFileSync(envPath, "utf8"));
  const value = values[keyName] ?? process.env[keyName];
  if (!value) {
    if (account.hasAccounts) {
      console.error("No active Codex Relay account session. Run: npm run cli login or npm run cli default");
      process.exit(1);
    }
    console.error(`Missing ${keyName} in ${envPath}`);
    process.exit(1);
  }
  process.stdout.write(value);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
