import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";

export function setupTestDatabase(prefix: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
  ensureDatabase();

  return () => {
    resetBootstrapForTests();
    resetDatabaseForTests();
    delete process.env.AGENTMELD_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
}
