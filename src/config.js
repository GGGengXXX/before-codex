import fs from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";

function resolveEnv(value, location) {
  if (typeof value !== "string") {
    return value;
  }

  const envMatch = value.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);
  if (envMatch) {
    const envName = envMatch[1];
    const resolved = process.env[envName];
    if (!resolved) {
      if (
        location === "$.server.public_api_key"
        || location === "$.server.admin_api_key"
      ) {
        return undefined;
      }
      if (location.endsWith(".api_key")) {
        return `missing-env:${envName}`;
      }
      throw new ConfigError(`Missing environment variable ${envName} at ${location}`);
    }
    return resolved;
  }

  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, envName) => {
    const resolved = process.env[envName];
    if (resolved === undefined) {
      throw new ConfigError(`Missing environment variable ${envName} at ${location}`);
    }
    return resolved;
  });
}

function resolveTree(value, location = "$") {
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveTree(item, `${location}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        resolveTree(child, `${location}.${key}`)
      ])
    );
  }
  return resolveEnv(value, location);
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function validateRuleList(value, field, { numbers = false } = {}) {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(`routing.provider_error_rules.*.${field} must be an array`);
  }
  const valid = numbers
    ? value.every((item) => Number.isInteger(item) && item >= 100 && item <= 599)
    : value.every((item) => typeof item === "string" && item.length > 0);
  if (!valid) {
    throw new ConfigError(
      `routing.provider_error_rules.*.${field} contains an invalid value`
    );
  }
}

function validateProviderErrorRules(rules) {
  if (rules === undefined) {
    return {};
  }
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    throw new ConfigError("routing.provider_error_rules must be an object");
  }
  for (const [provider, providerRules] of Object.entries(rules)) {
    if (!providerRules || typeof providerRules !== "object" || Array.isArray(providerRules)) {
      throw new ConfigError(
        `routing.provider_error_rules.${provider} must be an object`
      );
    }
    for (const field of [
      "billing_statuses",
      "rate_limit_statuses",
      "auth_statuses",
      "transient_statuses",
      "non_retryable_statuses"
    ]) {
      validateRuleList(providerRules[field], field, { numbers: true });
    }
    for (const field of [
      "billing_codes",
      "billing_messages",
      "rate_limit_codes",
      "rate_limit_messages",
      "auth_codes",
      "auth_messages",
      "transient_codes",
      "transient_messages"
    ]) {
      validateRuleList(providerRules[field], field);
    }
  }
  return rules;
}

function validateCompatibility(value, location, defaults = {}) {
  const result = { ...defaults };
  if (value === undefined) {
    return result;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${location} must be an object`);
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof enabled !== "boolean") {
      throw new ConfigError(`${location}.${key} must be a boolean`);
    }
    result[key] = enabled;
  }
  return result;
}

function validateDeployment(deployment, modelName, seenIds) {
  if (!deployment || typeof deployment !== "object") {
    throw new ConfigError(`models.${modelName}.deployments contains an invalid deployment`);
  }
  for (const field of ["id", "base_url", "model", "api_key"]) {
    if (typeof deployment[field] !== "string" || !deployment[field]) {
      throw new ConfigError(
        `Deployment ${deployment.id || "<unknown>"} in models.${modelName} requires ${field}`
      );
    }
  }
  try {
    new URL(deployment.base_url);
  } catch {
    throw new ConfigError(`Deployment ${deployment.id} has an invalid base_url`);
  }
  if (seenIds.has(deployment.id)) {
    throw new ConfigError(`Duplicate deployment id: ${deployment.id}`);
  }
  seenIds.add(deployment.id);
  deployment.provider ??= new URL(deployment.base_url).host;
  deployment.priority = numberOr(deployment.priority, 100);
  deployment.weight = Math.max(1, numberOr(deployment.weight, 1));
  deployment.enabled = deployment.enabled !== false;
  deployment.compatibility = validateCompatibility(
    deployment.compatibility,
    `Deployment ${deployment.id}.compatibility`
  );
  if (deployment.models !== undefined && !Array.isArray(deployment.models)) {
    throw new ConfigError(`Deployment ${deployment.id}.models must be an array`);
  }
}

export function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new ConfigError("Configuration must be a JSON object");
  }
  config.server ??= {};
  config.routing ??= {};
  config.state ??= {};
  config.models ??= {};
  if (!config.state || typeof config.state !== "object" || Array.isArray(config.state)) {
    throw new ConfigError("state must be an object");
  }
  config.server.host ??= "127.0.0.1";
  config.server.port = numberOr(config.server.port, 8787);
  config.server.request_timeout_ms = numberOr(config.server.request_timeout_ms, 120000);
  config.server.max_body_bytes = numberOr(config.server.max_body_bytes, 10485760);
  config.state.store ??= "file";
  if (!["memory", "file"].includes(config.state.store)) {
    throw new ConfigError("state.store must be either memory or file");
  }
  if (config.state.store === "file") {
    config.state.file_path ??= ".codex-relay-state.json";
    config.state.lock_timeout_ms = Math.max(
      1,
      numberOr(config.state.lock_timeout_ms, 1000)
    );
    config.state.stale_lock_ms = Math.max(
      1,
      numberOr(config.state.stale_lock_ms, 5000)
    );
  }
  config.routing.max_attempts = Math.max(1, numberOr(config.routing.max_attempts, 4));
  config.routing.max_provider_fallbacks = Math.max(
    0,
    numberOr(config.routing.max_provider_fallbacks, 2)
  );
  config.routing.retry_backoff_ms = Math.max(0, numberOr(config.routing.retry_backoff_ms, 250));
  config.routing.affinity_ttl_ms = Math.max(
    0,
    numberOr(config.routing.affinity_ttl_ms, 86400000)
  );
  config.routing.provider_error_rules = validateProviderErrorRules(
    config.routing.provider_error_rules
  );
  config.routing.compatibility = validateCompatibility(
    config.routing.compatibility,
    "routing.compatibility",
    {
      sanitize_request_items: true,
      sanitize_response_items: true,
      drop_invalid_reasoning_items: true,
      strip_invalid_request_item_ids: true,
      strip_invalid_response_item_ids: true,
      convert_dsml_tool_calls: true
    }
  );
  config.routing.cooldowns ??= {};
  config.routing.cooldowns.rate_limited_ms = numberOr(
    config.routing.cooldowns.rate_limited_ms,
    10000
  );
  config.routing.cooldowns.transient_ms = numberOr(
    config.routing.cooldowns.transient_ms,
    30000
  );
  config.routing.cooldowns.auth_ms = numberOr(config.routing.cooldowns.auth_ms, 3600000);
  config.routing.cooldowns.billing_ms = numberOr(config.routing.cooldowns.billing_ms, 3600000);

  const seenIds = new Set();
  const modelEntries = Object.entries(config.models);
  if (modelEntries.length === 0) {
    throw new ConfigError("At least one model with one deployment is required");
  }

  for (const [modelName, modelConfig] of modelEntries) {
    if (!modelConfig || !Array.isArray(modelConfig.deployments)) {
      throw new ConfigError(`models.${modelName}.deployments must be an array`);
    }
    if (modelConfig.deployments.length === 0) {
      throw new ConfigError(`models.${modelName}.deployments cannot be empty`);
    }
    modelConfig.aliases ??= [];
    if (!Array.isArray(modelConfig.aliases)) {
      throw new ConfigError(`models.${modelName}.aliases must be an array`);
    }
    for (const deployment of modelConfig.deployments) {
      validateDeployment(deployment, modelName, seenIds);
    }
  }

  return config;
}

export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  let raw;
  try {
    raw = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ConfigError(
        `Config file not found: ${absolutePath}. Copy config.example.json to config.json first.`
      );
    }
    throw new ConfigError(`Cannot read config file ${absolutePath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${absolutePath}: ${error.message}`);
  }
  return validateConfig(resolveTree(parsed));
}

export function resolveModelConfig(config, requestedModel) {
  if (config.models[requestedModel]) {
    return { name: requestedModel, config: config.models[requestedModel] };
  }
  for (const [name, modelConfig] of Object.entries(config.models)) {
    if (modelConfig.aliases?.includes(requestedModel)) {
      return { name, config: modelConfig };
    }
  }
  const entries = Object.entries(config.models);
  if (entries.length === 1) {
    const [name, modelConfig] = entries[0];
    return { name, config: modelConfig, defaulted: true };
  }
  return null;
}
