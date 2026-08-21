import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

function stripInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (!quote && char === "#" && /\s/.test(value[index - 1] ?? " ")) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed.at(-1) !== quote) {
    return stripInlineComment(trimmed).trim();
  }
  const inner = trimmed.slice(1, -1);
  if (quote === "'") {
    return inner;
  }
  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

export function parseEnv(content) {
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
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

function quoteEnvValue(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) {
    return text;
  }
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}

function collectEnvRefs(value, refs) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEnvRefs(item, refs);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      collectEnvRefs(child, refs);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  const direct = value.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);
  if (direct) {
    refs.add(direct[1]);
  }
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    refs.add(match[1]);
  }
}

export function envReferences(value) {
  const refs = new Set();
  collectEnvRefs(value, refs);
  return [...refs].sort();
}

export async function readEnvFile(envPath) {
  const absolutePath = path.resolve(envPath);
  try {
    return parseEnv(await fs.readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function updateEnvFile(envPath, values) {
  const absolutePath = path.resolve(envPath);
  const current = await readEnvFile(absolutePath);
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    if (value === null) {
      delete current[key];
    } else if (typeof value === "string" && value.length > 0) {
      current[key] = value;
    }
  }
  const body = Object.keys(current)
    .sort()
    .map((key) => `${key}=${quoteEnvValue(current[key])}`)
    .join("\n");
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, body ? `${body}\n` : "", { mode: 0o600 });
  return current;
}

export async function loadEnvFile(envPath, { override = false } = {}) {
  const absolutePath = path.resolve(envPath);
  let raw;
  try {
    raw = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { loaded: false, path: absolutePath, keys: [] };
    }
    throw error;
  }

  const values = parseEnv(raw);
  const keys = [];
  for (const [key, value] of Object.entries(values)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, path: absolutePath, keys };
}

export async function ensureEnvValues(envPath, names) {
  const values = await readEnvFile(envPath);
  const updates = {};
  for (const name of names) {
    if (!values[name] && !process.env[name]) {
      updates[name] = `relay-${crypto.randomBytes(24).toString("base64url")}`;
    }
  }
  if (Object.keys(updates).length === 0) {
    return { updated: false, keys: [] };
  }
  const nextValues = await updateEnvFile(envPath, updates);
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
  return {
    updated: true,
    keys: Object.keys(updates),
    values: nextValues
  };
}
