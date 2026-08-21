import fs from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function secretReference(value) {
  return typeof value === "string"
    && (value.startsWith("env:") || /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value));
}

function serverSecretPlaceholder(field) {
  return `secret:server:${field}`;
}

function deploymentSecretPlaceholder(deployment) {
  return `secret:deployment:${deployment.id}:api_key`;
}

function eachDeployment(config, callback) {
  for (const model of Object.values(config.models ?? {})) {
    for (const deployment of model.deployments ?? []) {
      callback(deployment);
    }
  }
}

export async function readRawConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(raw);
}

export function redactConfigSecrets(config) {
  const redacted = clone(config);
  for (const field of ["public_api_key", "admin_api_key"]) {
    const value = redacted.server?.[field];
    if (typeof value === "string" && value && !secretReference(value)) {
      redacted.server[field] = serverSecretPlaceholder(field);
    }
  }
  eachDeployment(redacted, (deployment) => {
    if (
      typeof deployment.api_key === "string"
      && deployment.api_key
      && !secretReference(deployment.api_key)
    ) {
      deployment.api_key = deploymentSecretPlaceholder(deployment);
    }
  });
  return redacted;
}

export function restoreSecretPlaceholders(nextConfig, previousConfig) {
  const restored = clone(nextConfig);
  for (const field of ["public_api_key", "admin_api_key"]) {
    if (
      restored.server?.[field] === serverSecretPlaceholder(field)
      && previousConfig.server?.[field]
    ) {
      restored.server[field] = previousConfig.server[field];
    }
  }

  const previousDeployments = new Map();
  eachDeployment(previousConfig, (deployment) => {
    previousDeployments.set(deployment.id, deployment);
  });
  eachDeployment(restored, (deployment) => {
    const previous = previousDeployments.get(deployment.id);
    if (
      previous
      && deployment.api_key === deploymentSecretPlaceholder(deployment)
      && previous.api_key
    ) {
      deployment.api_key = previous.api_key;
    }
  });
  return restored;
}

export async function writeValidatedConfig(configPath, nextConfig, loadConfigFn) {
  const absolutePath = path.resolve(configPath);
  const previousConfig = await readRawConfig(absolutePath);
  const restoredConfig = restoreSecretPlaceholders(nextConfig, previousConfig);
  const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(restoredConfig, null, 2)}\n`;

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(temporaryPath, serialized, { mode: 0o600 });
  let loadedConfig;
  try {
    loadedConfig = await loadConfigFn(temporaryPath);
    await fs.rename(temporaryPath, absolutePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }

  return {
    raw: restoredConfig,
    config: loadedConfig
  };
}
