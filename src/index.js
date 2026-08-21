import path from "node:path";
import process from "node:process";
import { loadConfig } from "./config.js";
import { ensureEnvValues, loadEnvFile } from "./env.js";
import { ConfigError } from "./errors.js";
import { createRelayServer } from "./server.js";
import { createRuntimeState } from "./state.js";

function envPathFromArgs() {
  const index = process.argv.indexOf("--env");
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return process.env.RELAY_ENV || path.resolve(".env");
}

function configPathFromArgs() {
  const index = process.argv.indexOf("--config");
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return process.env.RELAY_CONFIG || path.resolve("config.json");
}

function logStartup(config, configPath) {
  const deploymentCount = Object.values(config.models).reduce(
    (sum, model) => sum + model.deployments.length,
    0
  );
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      level: "info",
      event: "relay_started",
      listen: `${config.server.host}:${config.server.port}`,
      config: path.resolve(configPath),
      state_store: config.state.store,
      models: Object.keys(config.models),
      deployments: deploymentCount,
      auth: {
        public_api_key: Boolean(config.server.public_api_key),
        admin_api_key: Boolean(config.server.admin_api_key)
      }
    })
  );
}

const configPath = configPathFromArgs();
const envPath = envPathFromArgs();
try {
  const envResult = await loadEnvFile(envPath);
  if (envResult.loaded) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      level: "info",
      event: "env_loaded",
      path: envResult.path,
      keys: envResult.keys.length
    }));
  }
  const ensured = await ensureEnvValues(envPath, ["RELAY_API_KEY", "RELAY_ADMIN_KEY"]);
  if (ensured.updated) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      level: "info",
      event: "internal_env_generated",
      keys: ensured.keys.length
    }));
  }
  const config = await loadConfig(configPath);
  const state = createRuntimeState(config);
  const server = createRelayServer(config, state, { configPath, envPath });
  server.listen(config.server.port, config.server.host, () => {
    logStartup(config, configPath);
    console.log(`Codex Relay is ready at http://${config.server.host}:${config.server.port}`);
  });
  const shutdown = (signal) => {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      level: "info",
      event: "relay_stopping",
      signal
    }));
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
