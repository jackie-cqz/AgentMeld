import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createConversation, sendMessage } from "@/server/conversation-service";
import { buildHistoryFor } from "@/server/conversation-context";
import { createMessage } from "@/server/repositories";
import { newMessageId } from "@/shared/ids";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-ctx-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation-context — buildHistoryFor", () => {
  it("returns empty array for a conversation with no messages", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const history = await buildHistoryFor("ag_mock_builder", conv.id);
    expect(history).toEqual([]);
  });

  it("includes previous user and agent messages in order", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });

    // Manually insert a user + agent message pair
    const now = Date.now();
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "Hello" }],
      status: "complete",
      now: now - 2000
    });
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [{ type: "text", content: "Hi! How can I help?" }],
      status: "complete",
      now: now - 1000
    });

    // Send a new trigger message (excluded)
    const result = sendMessage({ conversationId: conv.id, content: "trigger" });

    const history = await buildHistoryFor("ag_mock_builder", conv.id, {
      excludeMessageId: result.message.id
    });

    expect(history.length).toBe(2);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("Hello");
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toContain("Hi!");
  });

  it("filters out thinking/tool_use/tool_result from history", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const now = Date.now();

    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "build" }],
      status: "complete",
      now: now - 1000
    });
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [
        { type: "thinking", content: "I need to analyze..." },
        { type: "text", content: "I will build it." },
        { type: "tool_use", callId: "c1", toolName: "fs_read", args: {} },
        { type: "tool_result", callId: "c1", result: "file content" }
      ],
      status: "complete",
      now
    });

    const history = await buildHistoryFor("ag_mock_builder", conv.id);

    // Only public text should survive; thinking/tool_use/tool_result dropped
    const assistantMsg = history.find((h) => h.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain("I will build it.");
    expect(assistantMsg!.content).not.toContain("analyze");
    expect(assistantMsg!.content).not.toContain("fs_read");
  });

  it("folds artifact_ref into placeholder text", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const now = Date.now();

    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "create artifact" }],
      status: "complete",
      now: now - 1000
    });
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [
        { type: "text", content: "Done." },
        { type: "artifact_ref", artifactId: "art_nonexistent", title: "My Doc", artifactType: "document" }
      ],
      status: "complete",
      now
    });

    const history = await buildHistoryFor("ag_mock_builder", conv.id);

    const assistantMsg = history.find((h) => h.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain("Done.");
    expect(assistantMsg!.content).toContain("[产物:");
    expect(assistantMsg!.content).toContain("art_nonexistent");
  });

  it("handles group chat — other agent messages as user role with prefix", async () => {
    // Create a group conversation with two agents
    const conv = createConversation({
      mode: "group",
      agentIds: ["ag_mock_orchestrator", "ag_mock_builder"]
    });
    const now = Date.now();

    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "group task" }],
      status: "complete",
      now: now - 2000
    });
    // Message from the builder (another agent from orchestrator's perspective)
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [{ type: "text", content: "I completed the analysis." }],
      status: "complete",
      now: now - 1000
    });

    // Build history from orchestrator's perspective
    const history = await buildHistoryFor("ag_mock_orchestrator", conv.id);

    // The builder's message should appear as user role with [agentId] prefix
    const otherMsg = history.find((h) => h.role === "user" && h.content.includes("ag_mock_builder"));
    expect(otherMsg).toBeDefined();
    expect(otherMsg!.content).toContain("[ag_mock_builder]");
    expect(otherMsg!.content).toContain("I completed the analysis.");
  });

  it("excludes message by excludeMessageId", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const now = Date.now();

    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "msg1" }],
      status: "complete",
      now: now - 3000
    });
    const msg2 = createMessage({
      id: "msg_exclude_me",
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "msg2 exclude" }],
      status: "complete",
      now: now - 2000
    });
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "msg3" }],
      status: "complete",
      now: now - 1000
    });

    const history = await buildHistoryFor("ag_mock_builder", conv.id, {
      excludeMessageId: "msg_exclude_me"
    });

    const contents = history.map((h) => h.content);
    expect(contents.some((c) => c.includes("msg1"))).toBe(true);
    expect(contents.some((c) => c.includes("msg2"))).toBe(false);
    expect(contents.some((c) => c.includes("msg3"))).toBe(true);
  });

  it("returns empty array for non-existent conversation", async () => {
    const history = await buildHistoryFor("ag_test", "conv_nonexistent");
    expect(history).toEqual([]);
  });

  it("gracefully handles buildHistoryFor errors by returning empty (tested via agent-runner)", async () => {
    // Verify the function doesn't throw on missing data
    const history = await buildHistoryFor("ag_test", "conv_fake_id");
    expect(Array.isArray(history)).toBe(true);
  });
});
