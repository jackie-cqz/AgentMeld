import { describe, expect, it } from "vitest";
import { mockAdapter } from "@/server/adapters/mock-adapter";
import type { AdapterInput } from "@/server/adapters/types";
import type { StreamEvent } from "@/shared/types";

function buildInput(overrides?: Partial<AdapterInput>): AdapterInput {
  return {
    conversationId: "conv_test",
    runId: "run_test",
    agent: {
      id: "ag_mock_builder",
      name: "前端工程师",
      avatar: "🛠️",
      description: "前端",
      capabilities: [],
      adapterName: "mock",
      modelProvider: null,
      modelId: "mock-builder",
      apiKey: null,
      apiBaseUrl: null,
      systemPrompt: "",
      toolNames: [],
      isBuiltin: true,
      isOrchestrator: false,
      supportsVision: false,
      createdAt: 1,
      updatedAt: 1
    },
    conversation: {
      id: "conv_test",
      title: "Test",
      mode: "group",
      agentIds: ["ag_mock_builder"],
      fsWriteApprovalMode: "review",
      pinnedMessageIds: [],
      archived: false,
      createdAt: 1,
      updatedAt: 1
    },
    workspace: {
      id: "ws_test",
      conversationId: "conv_test",
      mode: "sandbox",
      rootPath: "/tmp/ws",
      boundPath: null,
      createdAt: 1,
      updatedAt: 1
    },
    triggerMessage: {
      id: "msg_trigger",
      conversationId: "conv_test",
      role: "user",
      agentId: null,
      runId: null,
      parts: [{ type: "text", content: "帮我写前端代码" }],
      status: "complete",
      mentionedAgentIds: [],
      parentMessageId: null,
      createdAt: 1,
      updatedAt: 1
    },
    recentMessages: [],
    toolNames: [],
    ...overrides
  };
}

async function collectEvents(input: AdapterInput, maxEvents = 50): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const controller = new AbortController();
  for await (const event of mockAdapter.run(input, controller.signal)) {
    events.push(event);
    if (events.length >= maxEvents) break;
  }
  return events;
}

describe("mock-adapter", () => {
  it("has the name 'mock'", () => {
    expect(mockAdapter.name).toBe("mock");
  });

  it("produces thinking part events (start → delta* → end)", async () => {
    const events = await collectEvents(buildInput());

    const thinkingStart = events.find((e) => e.type === "part.start" && e.partIndex === 0);
    expect(thinkingStart).toBeDefined();
    if (thinkingStart?.type === "part.start") {
      expect(thinkingStart.part.type).toBe("thinking");
    }

    const thinkingDeltas = events.filter((e) => e.type === "part.delta" && e.partIndex === 0);
    expect(thinkingDeltas.length).toBeGreaterThan(0);

    const thinkingEnd = events.find((e) => e.type === "part.end" && e.partIndex === 0);
    expect(thinkingEnd).toBeDefined();
  });

  it("produces text part events (start → delta* → end)", async () => {
    const events = await collectEvents(buildInput());

    const textStart = events.find((e) => e.type === "part.start" && e.partIndex === 1);
    expect(textStart).toBeDefined();
    if (textStart?.type === "part.start") {
      expect(textStart.part.type).toBe("text");
    }

    const textDeltas = events.filter((e) => e.type === "part.delta" && e.partIndex === 1);
    expect(textDeltas.length).toBeGreaterThan(0);

    const textEnd = events.find((e) => e.type === "part.end" && e.partIndex === 1);
    expect(textEnd).toBeDefined();
  });

  it("produces a tool.call event", async () => {
    const events = await collectEvents(buildInput());

    const toolCall = events.find((e) => e.type === "tool.call");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "tool.call") {
      expect(toolCall.toolName).toBe("read_artifact");
      expect(toolCall.callId).toBe("call_mock_demo");
    }
  });

  it("produces a matching tool.result event", async () => {
    const events = await collectEvents(buildInput());

    const toolResult = events.find((e) => e.type === "tool.result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool.result") {
      expect(toolResult.callId).toBe("call_mock_demo");
      expect(toolResult.isError).toBe(false);
    }
  });

  it("produces an artifact.create for frontend agent", async () => {
    const events = await collectEvents(buildInput());

    const artifactEvent = events.find((e) => e.type === "artifact.create");
    expect(artifactEvent).toBeDefined();
    if (artifactEvent?.type === "artifact.create") {
      expect(artifactEvent.artifact.type).toBe("document");
    }
  });

  it("does NOT produce artifact.create for non-frontend agent", async () => {
    const input = buildInput({
      agent: {
        ...buildInput().agent,
        id: "ag_other",
        name: "通用助手"
      }
    });

    const events = await collectEvents(input);
    const artifactEvent = events.find((e) => e.type === "artifact.create");
    expect(artifactEvent).toBeUndefined();
  });

  it("produces run.usage event", async () => {
    const events = await collectEvents(buildInput());

    const usageEvent = events.find((e) => e.type === "run.usage");
    expect(usageEvent).toBeDefined();
  });

  it("stops producing events when abort signal is triggered", async () => {
    const controller = new AbortController();
    const input = buildInput();

    const events: StreamEvent[] = [];
    const iterator = mockAdapter.run(input, controller.signal);

    // Collect first event then abort
    const first = await iterator.next();
    if (!first.done) events.push(first.value);
    controller.abort();

    // Collect remaining (should stop quickly)
    for await (const event of iterator) {
      events.push(event);
    }

    // Should have stopped early — way fewer events than a full run
    expect(events.length).toBeLessThan(20);
  });
});
