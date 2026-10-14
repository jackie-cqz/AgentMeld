import path from "node:path";
import { defineConfig } from "drizzle-kit";
import { DATA_DIR, DATA_DIR_ENV, DATABASE_FILE, DB_PATH_ENV } from "./src/shared/constants";

/**
 * Resolve the SQLite file exactly like the application does, so `drizzle-kit`
 * can never target a different database than the running app.
 *
 * The app's resolution lives in `getDataDir()` (`src/db/client.ts`):
 *   `<AGENTMELD_DATA_DIR>/agentmeld.db`, defaulting to
 *   `./.agentmeld-data/agentmeld.db` relative to the current working directory.
 * It reads `AGENTMELD_DATA_DIR` only — no runtime code reads
 * `AGENTMELD_DB_PATH`.
 *
 * `AGENTMELD_DB_PATH` is therefore tolerated only when it resolves to the same
 * file as the app path (e.g. the documented `.agentmeld-data/agentmeld.db`
 * example). When it points somewhere else it would silently split the dev
 * database from the runtime database, so this config fails loudly instead of
 * letting the two diverge.
 */
function resolveDatabasePath(): string {
  const configuredDataDir = process.env[DATA_DIR_ENV];
  const dataDir = configuredDataDir
    ? path.resolve(configuredDataDir)
    : path.join(process.cwd(), DATA_DIR);
  const databasePath = path.join(dataDir, DATABASE_FILE);

  const configuredDatabasePath = process.env[DB_PATH_ENV];
  if (configuredDatabasePath) {
    const resolvedDatabasePath = path.resolve(configuredDatabasePath);
    if (resolvedDatabasePath !== databasePath) {
      throw new Error(
        `${DB_PATH_ENV}=${configuredDatabasePath} resolves to ${resolvedDatabasePath}, ` +
          `but AgentMeld reads its database from ${DATA_DIR_ENV} (${databasePath}). ` +
          `Set ${DATA_DIR_ENV} instead so drizzle-kit and the app cannot diverge.`
      );
    }
  }

  return databasePath;
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: resolveDatabasePath()
  }
});
