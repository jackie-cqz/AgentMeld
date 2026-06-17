import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { getAdapter, clearRegistryForTests } from "@/server/adapters/registry";
import type { AdapterInput } from "@/server/adapters/types";
import { updateSettings, getSettings, resolveApiKey } from "@/server/settings-service";

let tempDir: string;

function buildInput(overrides?: Partial<AdapterInput>): AdapterInput {
  return {
    conversationId: "conv_test",
    runId: "run_test",
    agent: {
      id: "ag_test_ds",
      name: "DS Test", avatar: "🤖", description: "",
      capabilities: [], adapterName: "custom", modelProvider: "deepseek",
      modelId: "deepseek-chat", apiKey: null, apiBaseUrl: null,
      systemPrompt: "You are helpful.", toolNames: [],
      isBuiltin: false, isOrchestrator: false, supportsVision: false,
      createdAt: 1, updatedAt: 1
    },
    conversation: {
      id: "conv_test", title: "T", mode: "single",
      agentIds: ["ag_test_ds"], fsWriteApprovalMode: "auto",
      pinnedMessageIds: [], archived: false, createdAt: 1, updatedAt: 1
    },
    workspace: {
      id: "ws_test", conversationId: "conv_test", mode: "sandbox",
      rootPath: tempDir, boundPath: null, createdAt: 1, updatedAt: 1
    },
    triggerMessage: {
      id: "msg_t", conversationId: "conv_test", role: "user", agentId: null, runId: null,
      parts: [{ type: "text", content: "Hello" }], status: "complete",
      mentionedAgentIds: [], parentMessageId: null, createdAt: 1, updatedAt: 1
    },
    recentMessages: [], toolNames: [],
    systemPrompt: "You are helpful.", workspacePath: tempDir, apiKey: null,
    ...overrides
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-smoke-"));
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
  delete process.env.DEEPSEEK_API_KEY;
  eventBus.clearForTests();
  clearRegistryForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function collectEvents(input: AdapterInput): Promise<unknown[]> {
  const adapter = getAdapter("custom");
  const events: unknown[] = [];
  for await (const e of adapter.run(input, new AbortController().signal)) {
    events.push(e);
  }
  return events;
}

describe("DeepSeek smoke tests", () => {
  it("no API key → yields clear error in part text", async () => {
    // Ensure no key configured anywhere
    delete process.env.DEEPSEEK_API_KEY;

    const events = await collectEvents(buildInput());

    const textContent = events
      .filter((e) => (e as { type: string }).type === "part.start")
      .map((e) => (e as { part: { type: string; content: string } }).part?.content ?? "")
      .join(" ");

    const deltaText = events
      .filter((e) => (e as { type: string }).type === "part.delta")
      .map((e) => (e as { delta: { text: string } }).delta?.text ?? "")
      .join("");

    const fullText = textContent + deltaText;

    expect(fullText).toContain("No API key");
  });

  it("environment variable DeepSeek key is resolved via resolveApiKey", () => {
    process.env.DEEPSEEK_API_KEY = "sk-env-test-key";
    const settings = getSettings();
    const key = resolveApiKey("deepseek", null, settings);
    expect(key).toBe("sk-env-test-key");
  });

  it("saved settings key is resolved", () => {
    updateSettings({ deepseekApiKey: "sk-settings-key" });
    const settings = getSettings();
    const key = resolveApiKey("deepseek", null, settings);
    expect(key).toBe("sk-settings-key");
  });

  it("adapter registered as 'custom'", () => {
    const adapter = getAdapter("custom");
    expect(adapter.name).toBe("custom");
  });

  it("custom adapter produces events even without key", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const events = await collectEvents(buildInput());
    expect(events.length).toBeGreaterThan(0);

    // Should have at least part.start, part.delta, run.usage
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("part.start");
    expect(types).toContain("run.usage");
  });

  it("custom adapter respects AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const adapter = getAdapter("custom");
    const events: unknown[] = [];
    for await (const e of adapter.run(buildInput(), ctrl.signal)) {
      events.push(e);
    }
    // Should stop quickly
    expect(events.length).toBeLessThan(10);
  });
});
