// Preload module for the benchmark/evaluation scripts.
//
// The bench scripts used to run with `node --env-file=.env`, which exits with
// an error when `.env` is missing (i.e. on every fresh clone). Node 20 — which
// package.json still supports — has `--env-file` but not
// `--env-file-if-exists`, so this tiny loader is used instead:
//
//   node --import ./scripts/load-env.mjs --import tsx <script>
//
// It reads `.env.local` first and then `.env`, if present, and only fills in
// variables that are not already set, so an explicitly exported value wins.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ENV_FILES = [".env.local", ".env"];

for (const envFile of ENV_FILES) {
  const filePath = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(filePath)) continue;

  const contents = fs.readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    process.env[key] = value;
  }
}
