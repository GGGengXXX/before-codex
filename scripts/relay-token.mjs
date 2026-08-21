import fs from "node:fs";
import path from "node:path";

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

try {
  const values = parseEnv(fs.readFileSync(envPath, "utf8"));
  const value = values[keyName] ?? process.env[keyName];
  if (!value) {
    console.error(`Missing ${keyName} in ${envPath}`);
    process.exit(1);
  }
  process.stdout.write(value);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
