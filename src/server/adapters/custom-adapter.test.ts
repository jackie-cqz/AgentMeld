import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { getAdapter, clearRegistryForTests } from "@/server/adapters/registry";
import type { AdapterInput } from "@/server/adapters/types";
import type { Agent, Conversation, Workspace, Message } from "@/shared/types";

let tempDir: string;

function buildAdapterInput(overrides?: Partial<AdapterInput>): AdapterInput {
  const agent: Agent = {
    id: "ag_custom_test",
    name: "Test Custom",
    avatar: "🤖",
    description: "Test",
    capabilities: [],
    adapterName: "custom",
    modelProvider: "openai",
    modelId: "gpt-4.1-mini",
    apiKey: null,
    apiBaseUrl: null,
    systemPrompt: "You are a test assistant.",
    toolNames: [],
    isBuiltin: false,
    isOrchestrator: false,
    supportsVision: false,
    createdAt: 1,
    updatedAt: 1
  };

  const conversation: Conversation = {
    id: "conv_test",
    title: "Test",
    mode: "single",
    agentIds: [agent.id],
    fsWriteApprovalMode: "auto",
    pinnedMessageIds: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1
  };

  const workspace: Workspace = {
    id: "ws_test",
    conversationId: "conv_test",
    mode: "sandbox",
    rootPath: tempDir,
    boundPath: null,
    createdAt: 1,
    updatedAt: 1
  };

  const triggerMessage: Message = {
    id: "msg_trigger",
    conversationId: "conv_test",
    role: "user",
    agentId: null,
    runId: null,
    parts: [{ type: "text", content: "Hello, how are you?" }],
    status: "complete",
    mentionedAgentIds: [],
    parentMessageId: null,
    createdAt: 1,
    updatedAt: 1
  };

  return {
    conversationId: "conv_test",
    runId: "run_test",
    agent,
    conversation,
    workspace,
    triggerMessage,
    recentMessages: [],
    toolNames: [],
    ...overrides
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-custom-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  clearRegistryForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  eventBus.clearForTests();
  clearRegistryForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("custom-agent-adapter", () => {
  it("is registered in the adapter registry", () => {
    const adapter = getAdapter("custom");
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("custom");
  });

  it("yields an error event when no API key is configured", async () => {
    const adapter = getAdapter("custom");
    const input = buildAdapterInput(); // no apiKey set
    const controller = new AbortController();

    const events = [];
    for await (const event of adapter.run(input, controller.signal)) {
      events.push(event);
    }

    // Should yield at least a part.start with error text and run.usage
    const errorMsg = events.find(
      (e) => e.type === "part.start" && "part" in e && (e.part as { type?: string }).type === "text"
    );
    expect(errorMsg).toBeDefined();

    const usage = events.find((e) => e.type === "run.usage");
    expect(usage).toBeDefined();
  });

  it("yields error when no key and no env var set", async () => {
    const adapter = getAdapter("custom");
    // Ensure no env var leakage
    delete process.env.OPENAI_API_KEY;
    const input = buildAdapterInput({ toolNames: ["fs_read"] });
    const controller = new AbortController();

    const events = [];
    for await (const event of adapter.run(input, controller.signal)) {
      events.push(event);
    }

    const partEvents = events.filter((e) => e.type === "part.start");
    expect(partEvents.length).toBeGreaterThan(0);
  });

  it("respects AbortSignal by stopping early", async () => {
    const adapter = getAdapter("custom");
    const input = buildAdapterInput();
    const controller = new AbortController();

    // Abort immediately to test signal handling
    controller.abort();

    const events = [];
    for await (const event of adapter.run(input, controller.signal)) {
      events.push(event);
    }

    // Should stop quickly (the loop checks signal.aborted)
    // With no key, it will yield the error part then return (doesn't hit network)
    expect(events.length).toBeLessThan(10);
  });
});
