import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateAggregateFallback, type TaskResult } from "@/server/conductor-service";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getMessage } from "@/server/repositories";
import { eventBus } from "@/server/event-bus";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { StreamEvent } from "@/shared/types";
import { setupTestDatabase } from "@/test/test-database";

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-conductor-aggregate-");
});

afterAll(() => {
  cleanupDatabase?.();
});

const plan: ParsedTask[] = [{
  id: "t1",
  agentId: "ag_mock_builder",
  title: "Build app",
  prompt: "build it",
  dependsOn: [],
  inputs: [],
  expectedOutputs: [],
  acceptanceCriteria: [],
  maxAttempts: 1
}];

describe("conductor aggregate fallback", () => {
  afterEach(() => {
    eventBus.clearForTests();
  });

  it("persists the fallback summary onto the conductor's own message", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const messageId = "msg_conductor_aggregate";
    createMessage({
      id: messageId,
      conversationId: conversation.id,
      role: "agent",
      parts: [{ type: "tool_use", callId: "call_plan", toolName: "plan_tasks", args: {} }],
      status: "streaming",
      now: Date.now()
    });

    const results = new Map<string, TaskResult>([
      ["t1", { taskId: "t1", status: "complete", summary: "done" }]
    ]);

    const published: StreamEvent[] = [];
    const unsubscribe = eventBus.subscribe(({ event }) => published.push(event));
    try {
      await generateAggregateFallback(conversation.id, messageId, "run_conductor_1", results, plan);
    } finally {
      unsubscribe();
    }

    // Persisted to the conductor's message (not dropped, not a separate message).
    const stored = getMessage(messageId);
    expect(stored).not.toBeNull();
    const parts = stored?.parts ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "tool_use", callId: "call_plan" });
    expect(parts[1]).toMatchObject({ type: "text" });
    expect((parts[1] as { content: string }).content).toContain("Conductor 总结");
    expect((parts[1] as { content: string }).content).toContain("Build app");

    // Streamed live with the conductor's messageId, never the empty id the reducer drops.
    const start = published.find((event) => event.type === "part.start");
    expect(start).toMatchObject({ messageId, partIndex: 1 });
  });
});
