import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests } from "@/db/client";
import { createRun } from "@/server/repositories";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conference-db-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
});

afterEach(() => {
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("database bootstrap", () => {
  it("creates all P1 tables and seeds builtin records", () => {
    ensureDatabase();

    const tableRows = getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map((row) => row.name));

    expect(tableNames.has("agents")).toBe(true);
    expect(tableNames.has("conversations")).toBe(true);
    expect(tableNames.has("messages")).toBe(true);
    expect(tableNames.has("artifacts")).toBe(true);
    expect(tableNames.has("workspaces")).toBe(true);
    expect(tableNames.has("attachments")).toBe(true);
    expect(tableNames.has("agent_runs")).toBe(true);
    expect(tableNames.has("conversation_context_summaries")).toBe(true);
    expect(tableNames.has("app_settings")).toBe(true);

    const agents = getDatabase()
      .prepare("SELECT adapter_name, is_orchestrator FROM agents")
      .all() as Array<{ adapter_name: string; is_orchestrator: number }>;
    expect(agents.some((agent) => agent.adapter_name === "custom")).toBe(true);
    expect(agents.some((agent) => agent.is_orchestrator === 1)).toBe(true);

    const settings = getDatabase().prepare("SELECT id FROM app_settings").get() as { id: string };
    expect(settings.id).toBe("singleton");
  });

  it("is idempotent and creates one workspace per seeded conversation", () => {
    ensureDatabase();
    ensureDatabase();

    const counts = getDatabase()
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM agents) AS agents,
            (SELECT COUNT(*) FROM conversations) AS conversations,
            (SELECT COUNT(*) FROM workspaces) AS workspaces
        `
      )
      .get() as { agents: number; conversations: number; workspaces: number };

    expect(counts.agents).toBeGreaterThanOrEqual(3);
    expect(counts.conversations).toBe(1);
    expect(counts.workspaces).toBe(counts.conversations);
  });

  it("supports inserting an agent run through the repository layer", () => {
    ensureDatabase();
    const conversation = getDatabase().prepare("SELECT id FROM conversations LIMIT 1").get() as { id: string };
    const agent = getDatabase().prepare("SELECT id FROM agents LIMIT 1").get() as { id: string };

    const run = createRun({
      id: "run_123456789abc",
      conversationId: conversation.id,
      agentId: agent.id,
      status: "running",
      now: Date.now()
    });

    expect(run.id).toBe("run_123456789abc");
    expect(run.status).toBe("running");
    expect(run.startedAt).toBeGreaterThan(0);
  });
});
