import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ACCOUNT_VERSION = 1;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;

function emptyData() {
  return { version: ACCOUNT_VERSION, default_username: null, accounts: {} };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function profileConfigFrom(baseConfig, statePath) {
  const config = clone(baseConfig);
  config.server = { ...(config.server ?? {}) };
  delete config.server.public_api_key;
  delete config.server.admin_api_key;
  config.state = {
    ...(config.state ?? {}),
    store: "file",
    file_path: statePath
  };
  for (const model of Object.values(config.models ?? {})) {
    for (const deployment of model.deployments ?? []) {
      deployment.api_key = "missing-user-api-key";
      deployment.enabled = false;
    }
  }
  return config;
}

function accountRoot() {
  return path.join(os.homedir(), ".codex-relay");
}

export function defaultAccountsPath() {
  return path.join(accountRoot(), "accounts.json");
}

export function defaultUsersPath() {
  return path.join(accountRoot(), "users");
}

export function defaultSessionsPath() {
  return path.join(accountRoot(), "sessions");
}

export function sessionKey(environment = process.env) {
  return environment.RELAY_SESSION_ID
    || environment.ITERM_SESSION_ID
    || environment.TERM_SESSION_ID
    || environment.WT_SESSION
    || "default";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString("hex")
  };
}

function passwordMatches(password, record) {
  const actual = Buffer.from(hashPassword(password, record.password_salt).hash, "hex");
  const expected = Buffer.from(record.password_hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function safeUsername(username) {
  const value = String(username ?? "").trim();
  if (!USERNAME_PATTERN.test(value)) {
    throw new Error("Username must be 3-32 letters, numbers, _ or - and start with a letter or number");
  }
  return value;
}

function safePassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  return password;
}

function publicAccount(record) {
  return {
    username: record.username,
    created_at: record.created_at,
    last_login_at: record.last_login_at ?? null,
    config_path: record.config_path,
    state_path: record.state_path,
    is_default: Boolean(record.is_default)
  };
}

export class AccountStore {
  constructor({
    filePath = defaultAccountsPath(),
    usersPath = defaultUsersPath(),
    sessionsPath = defaultSessionsPath()
  } = {}) {
    this.filePath = path.resolve(filePath);
    this.usersPath = path.resolve(usersPath);
    this.sessionsPath = path.resolve(sessionsPath);
  }

  async read() {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      value.accounts ??= {};
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return emptyData();
      throw error;
    }
  }

  async write(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  async list() {
    const data = await this.read();
    return Object.values(data.accounts).map(publicAccount);
  }

  async register(username, password, baseConfig) {
    const name = safeUsername(username);
    const secret = safePassword(password);
    const data = await this.read();
    if (data.accounts[name]) throw new Error(`Account already exists: ${name}`);
    const stamp = new Date().toISOString();
    const userDir = path.join(this.usersPath, name);
    const configPath = path.join(userDir, "config.json");
    const statePath = path.join(userDir, "state.json");
    const config = profileConfigFrom(baseConfig, statePath);
    await fs.mkdir(userDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(configPath, 0o600);
    const passwordRecord = hashPassword(secret);
    const record = {
      username: name,
      password_salt: passwordRecord.salt,
      password_hash: passwordRecord.hash,
      api_token: `user-${crypto.randomBytes(32).toString("hex")}`,
      config_path: configPath,
      state_path: statePath,
      created_at: stamp,
      last_login_at: null,
      is_default: false
    };
    data.accounts[name] = record;
    await this.write(data);
    return publicAccount(record);
  }

  async authenticatePassword(username, password) {
    const name = safeUsername(username);
    const data = await this.read();
    const record = data.accounts[name];
    if (!record || !passwordMatches(safePassword(password), record)) {
      throw new Error("Invalid username or password");
    }
    record.last_login_at = new Date().toISOString();
    await this.write(data);
    return clone(record);
  }

  async authenticateToken(token) {
    if (!token) return null;
    const data = await this.read();
    return Object.values(data.accounts).find((record) => record.api_token === token) ?? null;
  }

  async rotateToken(username) {
    const name = safeUsername(username);
    const data = await this.read();
    const record = data.accounts[name];
    if (!record) throw new Error(`Unknown account: ${name}`);
    record.api_token = `user-${crypto.randomBytes(32).toString("hex")}`;
    await this.write(data);
    return clone(record);
  }

  async setSession(record, environment = process.env) {
    await fs.mkdir(this.sessionsPath, { recursive: true, mode: 0o700 });
    const filePath = path.join(this.sessionsPath, `${crypto.createHash("sha256").update(sessionKey(environment)).digest("hex")}.json`);
    await fs.writeFile(filePath, `${JSON.stringify({ username: record.username, api_token: record.api_token })}\n`, { mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    return filePath;
  }

  async clearSession(environment = process.env) {
    const filePath = path.join(this.sessionsPath, `${crypto.createHash("sha256").update(sessionKey(environment)).digest("hex")}.json`);
    await fs.rm(filePath, { force: true });
    return filePath;
  }

  async sessionToken(environment = process.env) {
    const filePath = path.join(this.sessionsPath, `${crypto.createHash("sha256").update(sessionKey(environment)).digest("hex")}.json`);
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")).api_token ?? null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async setDefault(username) {
    const name = safeUsername(username);
    const data = await this.read();
    if (!data.accounts[name]) throw new Error(`Unknown account: ${name}`);
    for (const record of Object.values(data.accounts)) record.is_default = false;
    data.accounts[name].is_default = true;
    data.default_username = name;
    await this.write(data);
    return publicAccount(data.accounts[name]);
  }

  async clearDefault() {
    const data = await this.read();
    data.default_username = null;
    for (const record of Object.values(data.accounts)) record.is_default = false;
    await this.write(data);
  }

  async defaultToken() {
    const data = await this.read();
    return data.accounts[data.default_username]?.api_token ?? null;
  }

  async delete(username, password) {
    const name = safeUsername(username);
    const record = await this.authenticatePassword(name, password);
    const data = await this.read();
    delete data.accounts[name];
    if (data.default_username === name) data.default_username = null;
    await this.write(data);
    await fs.rm(path.dirname(record.config_path), { recursive: true, force: true });
  }
}
