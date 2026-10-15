import { describe, expect, it, vi } from "vitest";
import { startAgentRun, abortRun } from "@/server/agent-runner";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getRun, listMessages } from "@/server/repositories";
import { newMessageId } from "@/shared/ids";
import { PiRuntimeError } from "./process";
import { runPiInvocation } from "./runtime";

vi.mock("./runtime", () => ({ runPiInvocation: vi.fn() }));

describe("Pi terminal ownership", () => {
  it("does not report successful cancellation when cleanup is unconfirmed", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const triggerMessage = createMessage({ id: newMessageId(), conversationId: conversation.id, role: "user", parts: [{ type: "text", content: "fixture" }], status: "complete", now: Date.now() });
    vi.mocked(runPiInvocation).mockImplementation(async function* (input) {
      yield { type: "part.start", conversationId: conversation.id, timestamp: 1, messageId: "", partIndex: 0, part: { type: "text", content: "Verification started" } };
      abortRun(input.runId);
      throw new PiRuntimeError("Could not confirm native process teardown", "cleanup_failed");
    });
    const handle = startAgentRun({ conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessage });
    await handle.promise;
    expect(getRun(handle.runId)).toMatchObject({ status: "failed", errorCategory: "cleanup_failed" });
    expect(listMessages(conversation.id).find(message => message.role === "agent")?.status).toBe("error");
  });
});
