import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createConversation, sendMessage } from "@/server/conversation-service";
import { getWorkspaceForConversation, listAgents } from "@/server/repositories";
import type { AgentBenchmarkCase } from "@/server/context-metrics/benchmark-types";
import type { Message } from "@/shared/types";
import { setupTestDatabase } from "@/test/test-database";

import { ConversationDriver, resolveRoleAgentIds } from "./conversation-driver";

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-benchmark-driver-");
});

afterAll(() => {
  cleanupDatabase?.();
});

describe("ConversationDriver", () => {
  it("maps benchmark roles to the seeded Agent group", () => {
    const roles = resolveRoleAgentIds(["pm", "ui", "frontend", "reviewer"], listAgents());
    expect(roles).toEqual({
      pm: "ag_pm",
      ui: "ag_designer",
      frontend: "ag_mock_builder",
      reviewer: "ag_reviewer",
    });
  });

  it("creates a group workspace and sends the Case prompt", async () => {
    const send = vi.fn(async (input: Parameters<typeof sendMessage>[0]) => ({
      message: fakeMessage(input.conversationId, input.content),
      runIds: ["run_conductor_benchmark"],
    })) as unknown as typeof sendMessage;
    const driver = new ConversationDriver({
      listAgents,
      createConversation,
      sendMessage: send,
      getWorkspaceForConversation,
    });

    const started = await driver.startCase(createCase());

    expect(started.conductorRunId).toBe("run_conductor_benchmark");
    expect(started.agentIds).toEqual(expect.arrayContaining([
      "ag_mock_conductor",
      "ag_pm",
      "ag_mock_builder",
    ]));
    expect(started.workspacePath).toContain(started.conversationId);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: "Build the benchmark app." }));
  });
});

function createCase(): AgentBenchmarkCase {
  return {
    schemaVersion: 1,
    id: "driver-case",
    title: "Driver Case",
    description: "Driver integration fixture.",
    category: "collaboration",
    prompt: "Build the benchmark app.",
    expectedRoles: ["pm", "frontend"],
    assertions: [{ id: "pm-ran", type: "role_executed", role: "pm", required: true }],
    limits: { maxDurationMs: 1000 },
    tags: ["smoke"],
  };
}

function fakeMessage(conversationId: string, content: string): Message {
  const now = Date.now();
  return {
    id: "msg_benchmark",
    conversationId,
    role: "user",
    agentId: null,
    runId: null,
    parts: [{ type: "text", content }],
    status: "complete",
    mentionedAgentIds: [],
    parentMessageId: null,
    createdAt: now,
    updatedAt: now,
  };
}
