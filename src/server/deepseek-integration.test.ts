import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createConversation, sendMessage } from "@/server/conversation-service";
import { createDeepSeekMockServer } from "@/server/deepseek-mock-server";
import { getRun, listMessages } from "@/server/repositories";
import { updateAgent } from "@/server/agent-service";

let tempDir: string;
let mockServer: ReturnType<typeof createDeepSeekMockServer>;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-int-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(async () => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  if (mockServer) await mockServer.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("DeepSeek mock server", () => {
  it("returns text stream for default scenario", async () => {
    mockServer = createDeepSeekMockServer({ port: 19801 });
    await mockServer.start();

    const res = await fetch(`${mockServer.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true })
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Pomodoro Timer");
    expect(text).toContain("[DONE]");
  });

  it("returns 401 for auth error scenario", async () => {
    mockServer = createDeepSeekMockServer({ port: 19802, scenario: "401" });
    await mockServer.start();

    const res = await fetch(`${mockServer.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true })
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns 429 with Retry-After", async () => {
    mockServer = createDeepSeekMockServer({ port: 19803, scenario: "429" });
    await mockServer.start();

    const res = await fetch(`${mockServer.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true })
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("returns 500 for server error", async () => {
    mockServer = createDeepSeekMockServer({ port: 19804, scenario: "500" });
    await mockServer.start();

    const res = await fetch(`${mockServer.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true })
    });
    expect(res.status).toBe(500);
  });

  it("returns empty choices for empty scenario", async () => {
    mockServer = createDeepSeekMockServer({ port: 19805, scenario: "empty" });
    await mockServer.start();

    const res = await fetch(`${mockServer.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true })
    });
    const text = await res.text();
    expect(text).not.toContain("content");
  });

  it("returns tool calls when tools are provided", async () => {
    mockServer = createDeepSeekMockServer({ port: 19806, scenario: "tool-call" });
    await mockServer.start();

    const res = await fetch(`${mockServer.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat", messages: [{ role: "user", content: "list files" }],
        tools: [{ type: "function", function: { name: "fs_list", parameters: {} } }], stream: true
      })
    });
    const text = await res.text();
    expect(text).toContain("fs_list");
    expect(text).toContain("tool_calls");
  });

  it("returns reasoning content", async () => {
    mockServer = createDeepSeekMockServer({ port: 19807, scenario: "reasoning" });
    await mockServer.start();

    const res = await fetch(`${mockServer.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true })
    });
    const text = await res.text();
    expect(text).toContain("reasoning_content");
    expect(text).toContain("pomodoro");
  });

  it("includes usage in final chunk", async () => {
    mockServer = createDeepSeekMockServer({ port: 19808 });
    await mockServer.start();

    const res = await fetch(`${mockServer.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true })
    });
    const text = await res.text();
    expect(text).toContain("prompt_tokens");
    expect(text).toContain("completion_tokens");
  });
});

describe("DeepSeek adapter integration", () => {
  it("runs message → run → stream → message end without real API key", async () => {
    mockServer = createDeepSeekMockServer({ port: 19810 });
    await mockServer.start();

    updateAgent("ag_mock_builder", {
      apiKey: "test-key",
      apiBaseUrl: `${mockServer.url}/v1`,
      toolNames: []
    });
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const sent = await sendMessage({
      conversationId: conv.id,
      content: "Build a pomodoro timer"
    });
    expect(sent.runIds).toHaveLength(1);

    const run = await waitForRun(sent.runIds[0]);
    expect(run.status).toBe("complete");
    expect(run.usage).toMatchObject({
      modelId: "deepseek-chat",
      inputTokens: 100,
      outputTokens: 50
    });

    const agentMessage = listMessages(conv.id).find((message) => message.runId === run.id);
    expect(agentMessage?.status).toBe("complete");
    expect(agentMessage?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          content: expect.stringContaining("Pomodoro Timer")
        })
      ])
    );
  });
});

async function waitForRun(runId: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = getRun(runId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for run ${runId}.`);
}
