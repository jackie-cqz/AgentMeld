import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  addChannelConversationMember,
  claimChannelInboundMessage,
  createChannelConversation,
  createConversation,
  getChannelConversationByChat,
  getChannelInboundMessage,
  listChannelConversationMembers,
  setChannelInboundMessageId
} from "@/server/repositories";

/**
 * The state an inbound channel message needs: which conversation a chat maps
 * to, which agents have been seen there, and whether a given platform message
 * has already been taken in.
 *
 * The deduplication is the interesting part. It has to be one atomic step —
 * reading and then writing would let two concurrent deliveries of the same
 * message both proceed, which is exactly the case a duplicate is likely to
 * arrive in.
 */
describe("channel state repositories", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-repo-");
  });

  afterEach(() => {
    teardown();
  });

  function seedConversation(id: string) {
    createConversation({
      id,
      title: `conv ${id}`,
      mode: "group",
      agentIds: ["ag_pm"],
      fsWriteApprovalMode: "auto",
      now: Date.now()
    });
  }

  describe("chat to conversation mapping", () => {
    it("returns null for a chat that has not been seen", () => {
      expect(getChannelConversationByChat("feishu", "oc_unknown")).toBeNull();
    });

    it("round-trips a mapping", () => {
      seedConversation("conv_1");
      createChannelConversation({
        id: "cc_1",
        channel: "feishu",
        chatId: "oc_1",
        conversationId: "conv_1",
        now: 100
      });

      const found = getChannelConversationByChat("feishu", "oc_1");
      expect(found?.conversationId).toBe("conv_1");
      expect(found?.chatId).toBe("oc_1");
    });

    it("refuses a second conversation for the same chat", () => {
      // The inbound path cannot resolve an ambiguity, so this must be a
      // constraint rather than something callers are trusted to avoid.
      seedConversation("conv_1");
      seedConversation("conv_2");
      createChannelConversation({
        id: "cc_1",
        channel: "feishu",
        chatId: "oc_1",
        conversationId: "conv_1",
        now: 1
      });

      expect(() =>
        createChannelConversation({
          id: "cc_2",
          channel: "feishu",
          chatId: "oc_1",
          conversationId: "conv_2",
          now: 2
        })
      ).toThrow();
    });

    it("refuses to point two chats at one conversation", () => {
      seedConversation("conv_1");
      createChannelConversation({
        id: "cc_1",
        channel: "feishu",
        chatId: "oc_1",
        conversationId: "conv_1",
        now: 1
      });

      expect(() =>
        createChannelConversation({
          id: "cc_2",
          channel: "feishu",
          chatId: "oc_2",
          conversationId: "conv_1",
          now: 2
        })
      ).toThrow();
    });
  });

  describe("observed membership", () => {
    beforeEach(() => {
      seedConversation("conv_1");
      createChannelConversation({
        id: "cc_1",
        channel: "feishu",
        chatId: "oc_1",
        conversationId: "conv_1",
        now: 1
      });
    });

    it("records members in the order their bot was first seen", () => {
      addChannelConversationMember({ channelConversationId: "cc_1", agentId: "ag_pm", now: 10 });
      addChannelConversationMember({
        channelConversationId: "cc_1",
        agentId: "ag_designer",
        now: 20
      });

      expect(listChannelConversationMembers("cc_1")).toEqual(["ag_pm", "ag_designer"]);
    });

    it("is idempotent — seeing the same bot again is not new evidence", () => {
      addChannelConversationMember({ channelConversationId: "cc_1", agentId: "ag_pm", now: 10 });
      addChannelConversationMember({ channelConversationId: "cc_1", agentId: "ag_pm", now: 99 });

      const members = listChannelConversationMembers("cc_1");
      expect(members).toEqual(["ag_pm"]);
    });

    it("has no members until a bot is actually seen", () => {
      expect(listChannelConversationMembers("cc_1")).toEqual([]);
    });
  });

  describe("inbound message deduplication", () => {
    beforeEach(() => {
      seedConversation("conv_1");
      createChannelConversation({
        id: "cc_1",
        channel: "feishu",
        chatId: "oc_1",
        conversationId: "conv_1",
        now: 1
      });
    });

    const claim = (externalMessageId: string) => ({
      id: `cim_${externalMessageId}`,
      channel: "feishu",
      chatId: "oc_1",
      externalMessageId,
      conversationId: "conv_1",
      agentId: "ag_pm",
      now: 100
    });

    it("claims a message once and refuses the second delivery", () => {
      // This is the whole point: a redelivered event must not be processed
      // twice, and the platform does not promise exactly-once delivery.
      expect(claimChannelInboundMessage(claim("om_1"))).toBe(true);
      expect(claimChannelInboundMessage(claim("om_1"))).toBe(false);
    });

    it("treats the same id on another channel as a different message", () => {
      expect(claimChannelInboundMessage(claim("om_1"))).toBe(true);
      expect(
        claimChannelInboundMessage({ ...claim("om_1"), id: "cim_other", channel: "slack" })
      ).toBe(true);
    });

    it("records which local message the inbound row became", () => {
      claimChannelInboundMessage(claim("om_1"));
      setChannelInboundMessageId("cim_om_1", "msg_local_1");

      const row = getChannelInboundMessage("feishu", "om_1");
      expect(row?.messageId).toBe("msg_local_1");
      expect(row?.conversationId).toBe("conv_1");
    });

    it("leaves messageId null until the local message is written", () => {
      // The claim is the record of acceptance; writing the message can still
      // fail afterwards, and that gap should be visible rather than hidden.
      claimChannelInboundMessage(claim("om_2"));
      expect(getChannelInboundMessage("feishu", "om_2")?.messageId).toBeNull();
    });
  });
});
