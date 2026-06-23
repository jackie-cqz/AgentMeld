import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { recoverOrphanedRuns } from "@/server/run-recovery";
import { createRun, getRun, createMessage } from "@/server/repositories";
import { createConversation } from "@/server/conversation-service";
import { eventBus } from "@/server/event-bus";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-recov-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("run-recovery", () => {
  // Shared fixture: need a real conversation + agent for FK constraints
  let convId: string;
  const agentId = "ag_mock_conductor";

  beforeEach(() => {
    const conv = createConversation({ mode: "single", agentIds: [agentId] });
    convId = conv.id;
  });

  it("marks orphaned running runs as interrupted", () => {
    const now = Date.now();
    const runId = "run_orphan_1";

    createRun({
      id: runId,
      conversationId: convId,
      agentId,
      triggerMessageId: null,
      parentRunId: null,
      status: "running",
      now
    });

    const before = getRun(runId);
    expect(before?.status).toBe("running");

    recoverOrphanedRuns();

    const after = getRun(runId);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("interrupted");
    expect(after?.interrupted).toBe(true);
  });

  it("does not touch completed runs", () => {
    const now = Date.now();
    createRun({
      id: "run_complete_1",
      conversationId: convId,
      agentId,
      triggerMessageId: null,
      parentRunId: null,
      status: "complete",
      now: now - 1000
    });

    recoverOrphanedRuns();

    const run = getRun("run_complete_1");
    expect(run?.status).toBe("complete");
    expect(run?.interrupted).toBe(false);
  });

  it("handles no orphaned runs gracefully", () => {
    recoverOrphanedRuns();
  });
});
