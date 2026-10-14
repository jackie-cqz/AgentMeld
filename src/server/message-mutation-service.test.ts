import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import { createConversation, sendMessage } from "@/server/conversation-service";
import { eventBus } from "@/server/event-bus";
import { editMessage, withdrawMessage } from "@/server/message-mutation-service";
import { clearPendingBashForTests } from "@/server/pending-bash";
import { getMessage } from "@/server/repositories";

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-mutation-");
});

afterAll(() => {
  cleanupDatabase?.();
});

beforeEach(() => {
  eventBus.clearForTests();
});

afterEach(() => {
  clearPendingBashForTests();
  eventBus.clearForTests();
});

describe("editMessage", () => {
  it("carries a bot origin across the withdraw-and-resend", async () => {
    // Editing withdraws the message and sends a new one. If the new send fell
    // back to the default origin, an edit would launder a bot-authored message
    // into a human one and start a run the original could not start.
    const conversation = createConversation({
      mode: "group",
      agentIds: ["ag_mock_conductor", "ag_mock_builder"]
    });

    const sent = await sendMessage({
      conversationId: conversation.id,
      content: "bot echo",
      origin: "bot"
    });
    expect(sent.runIds).toHaveLength(0);

    const edited = await editMessage(sent.message.id, "bot echo, edited");

    expect(edited.message.origin).toBe("bot");
    expect(getMessage(edited.message.id)?.origin).toBe("bot");
    expect(edited.runIds).toHaveLength(0);
  });

  it("still dispatches when a human edits their own message", async () => {
    const conversation = createConversation({
      mode: "group",
      agentIds: ["ag_mock_conductor", "ag_mock_builder"]
    });

    const sent = await sendMessage({
      conversationId: conversation.id,
      content: "hello",
      origin: "human"
    });
    expect(sent.runIds).toHaveLength(1);

    const edited = await editMessage(sent.message.id, "hello, edited");

    expect(edited.message.origin).toBe("human");
    expect(edited.runIds).toHaveLength(1);
  });
});

describe("withdrawMessage", () => {
  it("accepts a bot-authored message, because it is user-role", async () => {
    // Documents current behaviour rather than asserting it is desirable: the
    // guard is `role === "user"`, and a bot echo has that role, so a channel
    // echo could anchor the bulk delete that withdrawal performs. Flagged for
    // the channel work; pinned here so a change is deliberate.
    const conversation = createConversation({
      mode: "group",
      agentIds: ["ag_mock_conductor", "ag_mock_builder"]
    });

    const sent = await sendMessage({
      conversationId: conversation.id,
      content: "bot echo",
      origin: "bot"
    });

    expect(() => withdrawMessage(sent.message.id)).not.toThrow();
    expect(getMessage(sent.message.id)).toBeNull();
  });
});
