import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createConversation, deleteConversation } from "@/server/conversation-service";
import { clearPendingWritesForTests } from "@/server/pending-writes";
import { clearPendingBashForTests } from "@/server/pending-bash";
import { clearPendingPlansForTests } from "@/server/dispatch-plan-manager";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-edge-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
  clearPendingPlansForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  eventBus.clearForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
  clearPendingPlansForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation edge cases", () => {
  it("creating two separate single conversations works", () => {
    const c1 = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const c2 = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    expect(c1.id).not.toBe(c2.id);
  });

  it("group conversation requires title defaults to auto-generated", () => {
    const conv = createConversation({
      mode: "group",
      agentIds: ["ag_mock_orchestrator", "ag_mock_builder"]
    });
    expect(conv.title).toBeTruthy();
  });

  it("conversation with custom title preserves it", () => {
    const conv = createConversation({
      title: "我的项目",
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });
    expect(conv.title).toBe("我的项目");
  });

  it("trimming whitespace from title", () => {
    const conv = createConversation({
      title: "  整洁标题  ",
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });
    expect(conv.title).toBe("整洁标题");
  });

  it("fsWriteApprovalMode defaults to auto", () => {
    const conv = createConversation({
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });
    expect(conv.fsWriteApprovalMode).toBe("auto");
  });

  it("auto approval mode can be set", () => {
    const conv = createConversation({
      mode: "single",
      agentIds: ["ag_mock_builder"],
      fsWriteApprovalMode: "auto"
    });
    expect(conv.fsWriteApprovalMode).toBe("auto");
  });

  it("creating a conversation creates a workspace directory on disk", () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const wsDir = path.join(tempDir, "workspaces", conv.id);
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("deleting a conversation removes the workspace", () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const wsDir = path.join(tempDir, "workspaces", conv.id);
    expect(fs.existsSync(wsDir)).toBe(true);

    deleteConversation(conv.id);
    expect(fs.existsSync(wsDir)).toBe(false);
  });
});
