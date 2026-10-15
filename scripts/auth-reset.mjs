/**
 * Owner-session reset: the shell-access recovery path for #24 auth.
 *
 * An install pairs exactly once. If the owner loses every session (device
 * lost, sessions revoked, cookie store wiped), the gate stays closed to the
 * network on purpose — a reopened bootstrap window would let anyone nearby
 * pair themselves as owner. Recovery therefore requires shell access to the
 * machine running AgentMeld, which is the real trust boundary of a
 * local-first app:
 *
 *   pnpm run auth:reset
 *
 * Deletes every owner session row (the device token in app_settings is left
 * alone — rotate it from the settings UI). The next request finds an
 * unpaired install and the pairing flow starts fresh.
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);

function dataDir() {
  const custom = process.env.AGENTMELD_DATA_DIR;
  if (custom) return custom;
  return path.join(process.cwd(), ".agentmeld-data");
}

const dir = dataDir();
const dbPath = path.join(dir, "agentmeld.db");
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath} — nothing to reset.`);
  process.exit(1);
}

const Database = require("better-sqlite3");
const db = new Database(dbPath);
try {
  const info = db.prepare("DELETE FROM owner_sessions").run();
  console.log(`Removed ${info.changes} owner session(s). The install is unpaired; pair again from the app.`);
} finally {
  db.close();
}
