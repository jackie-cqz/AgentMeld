import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { setupTestDatabase } from "@/test/test-database";
import { resolveChannelConversation } from "@/server/channels/feishu/conversation-binding";
import {
  getChannelConversationByChat,
  getConversation,
  getWorkspaceForConversation,
  listChannelConversationMembers
} from "@/server/repositories";

/**
 * A channel conversation is discovered, not configured: no granted scope can
 * list a chat's bots, so the agents in a group are exactly those whose bot has
 * been seen there. These tests pin that the conversation is created once, that
 * it grows as other bots are observed, and that an observed agent becomes a
 * participant — without which routing to it would be impossible.
 */
describe("resolveChannelConversation", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-conv-");
  });

  afterEach(() => {
    teardown();
  });

  const first = {
    channel: "feishu" as const,
    chatId: "oc_group_1",
    chatType: "group" as const,
    receivingAgentId: "ag_pm",
    now: 100
  };

  it("creates a conversation the first time a chat is seen", () => {
    const { channelConversation, created } = resolveChannelConversation(first);

    expect(created).toBe(true);
    expect(channelConversation.chatId).toBe("oc_group_1");

    const conversation = getConversation(channelConversation.conversationId);
    expect(conversation?.agentIds).toEqual(["ag_pm"]);
    expect(conversation?.mode).toBe("group");
  });

  it("gives the new conversation a workspace, or every run in it fails", () => {
    // A conversation without a workspace answers "⚠️ Workspace not found." and
    // never runs anything. This is not hypothetical: routing went in without it
    // and the first real agent run in a channel conversation died on exactly
    // that. The service's createConversation does this, but its rules do not fit
    // here — it demands two agents for a group, and a discovered group starts
    // with the one whose bot spoke first.
    const { channelConversation } = resolveChannelConversation(first);

    const workspace = getWorkspaceForConversation(channelConversation.conversationId);
    expect(workspace).not.toBeNull();
    expect(fs.existsSync(workspace!.rootPath)).toBe(true);
  });

  it("maps the chat so a later message finds it again", () => {
    const { channelConversation } = resolveChannelConversation(first);

    expect(getChannelConversationByChat("feishu", "oc_group_1")?.id).toBe(channelConversation.id);
  });

  it("reuses the conversation instead of creating a second one", () => {
    const a = resolveChannelConversation(first);
    const b = resolveChannelConversation({ ...first, now: 200 });

    expect(b.created).toBe(false);
    expect(b.channelConversation.id).toBe(a.channelConversation.id);
  });

  it("keeps separate conversations for separate chats", () => {
    const a = resolveChannelConversation(first);
    const b = resolveChannelConversation({ ...first, chatId: "oc_group_2", now: 200 });

    expect(b.created).toBe(true);
    expect(b.channelConversation.conversationId).not.toBe(a.channelConversation.conversationId);
  });

  it("adds an agent whose bot is seen later, as a member and as a participant", () => {
    // The heart of it: membership is evidence. Without the participant half the
    // agent would belong to the chat but not to the conversation, and routing
    // would never reach it.
    const { channelConversation } = resolveChannelConversation(first);

    resolveChannelConversation({
      ...first,
      receivingAgentId: "ag_designer",
      now: 200
    });

    expect(listChannelConversationMembers(channelConversation.id)).toEqual(["ag_pm", "ag_designer"]);
    expect(getConversation(channelConversation.conversationId)?.agentIds).toEqual([
      "ag_pm",
      "ag_designer"
    ]);
  });

  it("does not duplicate an agent that is seen again", () => {
    const { channelConversation } = resolveChannelConversation(first);

    resolveChannelConversation({ ...first, now: 200 });
    resolveChannelConversation({ ...first, now: 300 });

    expect(listChannelConversationMembers(channelConversation.id)).toEqual(["ag_pm"]);
    expect(getConversation(channelConversation.conversationId)?.agentIds).toEqual(["ag_pm"]);
  });

  it("keeps a one-to-one chat single", () => {
    const { channelConversation } = resolveChannelConversation({
      ...first,
      chatId: "oc_p2p_1",
      chatType: "p2p"
    });

    expect(getConversation(channelConversation.conversationId)?.mode).toBe("single");
  });

  it("titles the conversation from the chat id rather than guessing at content", () => {
    // The account cannot read a chat's name either, so anything friendlier here
    // would be invented. A rename is the user's call.
    const { channelConversation } = resolveChannelConversation(first);
    const title = getConversation(channelConversation.conversationId)?.title ?? "";

    expect(title).toContain("飞书群");
    expect(title).toContain("up_1");
  });
});
