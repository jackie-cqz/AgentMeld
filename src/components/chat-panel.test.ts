import { describe, expect, it } from "vitest";
import { isNoticeMessage, transcriptMessages } from "@/components/chat-panel";
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
  it("keeps system notices", () => {
    const notice = message({ id: "msg_notice", role: "system", agentId: null });

    const shown = transcriptMessages([message(), notice]);

    expect(shown.map((m) => m.id)).toEqual(["msg_1", "msg_notice"]);
  });

  it("keeps every message, in order", () => {
    const messages = [
      message({ id: "a", role: "user" }),
      message({ id: "b", role: "agent" }),
      message({ id: "c", role: "system", agentId: null })
    ];

    expect(transcriptMessages(messages).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("recognises only system messages as notices", () => {
    expect(isNoticeMessage(message({ role: "system" }))).toBe(true);
    expect(isNoticeMessage(message({ role: "agent" }))).toBe(false);
    expect(isNoticeMessage(message({ role: "user" }))).toBe(false);
  });
});
