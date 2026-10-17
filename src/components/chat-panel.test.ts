import { describe, expect, it } from "vitest";
import { transcriptMessages } from "@/components/chat-panel";
import type { Message } from "@/shared/types";

/**
 * The transcript used to drop `role === "system"`, and that split the record:
 * the channel projection sends notices to the room on purpose (a failure nobody
 * hears about is the worst outcome), so a failed task was visible in Feishu and
 * nowhere on the desktop. This pins the policy in the direction it now has, so
 * the filter cannot come back unnoticed — nor the notices either.
 */
function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    conversationId: "conv_1",
    role: "agent",
    origin: "internal",
    agentId: "ag_pm",
    runId: null,
    parts: [{ type: "text", content: "answer" }],
    status: "complete",
    mentionedAgentIds: [],
    parentMessageId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as Message;
}

describe("what the transcript shows", () => {
  it("hides system notices", () => {
    const notice = message({ id: "msg_notice", role: "system", agentId: null });

    expect(transcriptMessages([message(), notice]).map((m) => m.id)).toEqual(["msg_1"]);
  });

  it("keeps user and agent messages in order", () => {
    const messages = [message({ id: "a", role: "user" }), message({ id: "b", role: "agent" })];

    expect(transcriptMessages(messages).map((m) => m.id)).toEqual(["a", "b"]);
  });
});
