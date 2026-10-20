import { describe, expect, it, vi } from "vitest";
import type { PiInvocationInput } from "@/server/pi/types";

const captured = vi.hoisted(() => [] as PiInvocationInput[]);
vi.mock("@/server/pi/runtime", async () => {
  const { fixturePiInvocation } = await import("@/test/pi-runtime-fixture");
  return { runPiInvocation: (input: PiInvocationInput, signal: AbortSignal) => {
    captured.push(input);
    return fixturePiInvocation(input, signal);
  } };
});

import { executeConductor } from "@/server/conductor-service";
import { createConversation } from "@/server/conversation-service";
import { createMessage, createRun } from "@/server/repositories";
import { newMessageId, newRunId } from "@/shared/ids";

describe("Conductor context wiring", () => {
  it("passes the preceding discussion into the actual assess invocation", async () => {
    const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_conductor", "ag_mock_builder"] });
    createMessage({ id: newMessageId(), conversationId: conversation.id, role: "agent", agentId: "ag_mock_builder",
      parts: [{ type: "text", content: "Proposal two: compact sidebar" }], status: "complete", now: 1 });
    const triggerMessage = createMessage({ id: newMessageId(), conversationId: conversation.id, role: "user", origin: "human",
      parts: [{ type: "text", content: "Discuss the second proposal" }], status: "complete", now: 2 });
    const run = createRun({ id: newRunId(), conversationId: conversation.id, agentId: "ag_mock_conductor",
      triggerMessageId: triggerMessage.id, status: "running", now: Date.now() });
    const response = createMessage({ id: newMessageId(), conversationId: conversation.id, role: "agent", agentId: "ag_mock_conductor",
      runId: run.id, parts: [], status: "streaming", now: Date.now() });
    await executeConductor({ conversationId: conversation.id, conductorAgentId: "ag_mock_conductor", triggerMessage,
      availableAgentIds: conversation.agentIds, conductorRunId: run.id, messageId: response.id,
      provider: { providerId: "fixture", catalogProvider: "fixture", modelId: "fixture-model",
        endpoint: "http://127.0.0.1:1", credential: "fixture-only", revision: "fixture" } });
    const invocation = captured.at(-1)!;
    expect(invocation.history?.map(message => message.content).join("\n")).toContain("Proposal two: compact sidebar");
    expect(invocation.history?.map(message => message.content).join("\n")).not.toContain("Discuss the second proposal");
    expect(invocation.recentMessages.map(message => message.id)).toHaveLength(1);
  });
});
