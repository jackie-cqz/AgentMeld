import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { setupTestDatabase } from "@/test/test-database";
import {
  pruneObservedAgents,
  resolveChannelConversation,
  syncChatMembership,
  syncChatMembershipKeeping
} from "@/server/channels/feishu/conversation-binding";
import {
  getChannelConversationByChat,
  getConversation,
  getWorkspaceForConversation,
  listChannelConversationMembers,
  upsertChannelBinding
} from "@/server/repositories";

/**
 * A channel conversation is discovered, not configured: no granted scope can
 * list a chat's bots, so the agents in a group are exactly those whose bot has
 * been seen there. These tests pin that the conversation is created once, that
 * it grows as other bots are observed, and that an observed agent becomes a
 * participant — without which routing to it would be impossible.
 */
describe("a roster that shrinks", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-prune-");
  });

  afterEach(() => {
    teardown();
  });

  const sorted = (ids: string[]) => [...ids].sort();

  function seedChat(agentIds: string[]) {
    const { channelConversation } = resolveChannelConversation({
      channel: "feishu",
      chatId: "oc_1",
      chatType: "group",
      receivingAgentId: agentIds[0],
      now: 1
    });
    for (const agentId of agentIds.slice(1)) {
      resolveChannelConversation({
        channel: "feishu",
        chatId: "oc_1",
        chatType: "group",
        receivingAgentId: agentId,
        now: 1
      });
    }
    return channelConversation;
  }

  /** A binding with a bot id, so the agent can be matched against the chat. */
  function identify(agentId: string, openId: string) {
    upsertChannelBinding({
      id: `cb_${agentId}_${openId}`,
      agentId,
      channel: "feishu",
      appId: `cli_${agentId}_${openId}`,
      appSecret: "s",
      botOpenId: openId,
      boundByOpenId: "ou_user",
      now: 1
    });
  }

  it("drops an observed agent that is no longer in the chat", () => {
    const channelConversation = seedChat(["ag_pm", "ag_designer"]);
    // "Not in the list" is only evidence about an agent we can match to a bot.
    identify("ag_pm", "ou_bot_pm");
    identify("ag_designer", "ou_bot_designer");

    const removed = pruneObservedAgents(channelConversation.id, ["ag_pm"]);

    expect(removed).toEqual(["ag_designer"]);
    expect(sorted(listChannelConversationMembers(channelConversation.id))).toEqual(["ag_pm"]);
  });

  it("leaves the conversation's participants alone", () => {
    // `agentIds` is who may speak in the conversation, a choice a person can
    // also make on the web. A bot leaving the group is not that.
    const channelConversation = seedChat(["ag_pm", "ag_designer"]);
    pruneObservedAgents(channelConversation.id, ["ag_pm"]);
    expect(getConversation(channelConversation.conversationId)?.agentIds).toContain("ag_designer");
  });

  it("keeps every agent when the channel cannot say who is in the chat", async () => {
    const channelConversation = seedChat(["ag_pm", "ag_designer"]);

    // No capability: nothing is learned, nothing is dropped.
    expect(await syncChatMembership({}, channelConversation.id, "oc_1")).toEqual([]);
    // A failed call: same.
    expect(
      await syncChatMembership(
        { getChatBots: () => Promise.reject(new Error("api down")) },
        channelConversation.id,
        "oc_1"
      )
    ).toEqual([]);
    // An empty answer is not evidence that everyone left.
    expect(
      await syncChatMembership({ getChatBots: async () => [] }, channelConversation.id, "oc_1")
    ).toEqual([]);
    // A list of bots none of which we can match says nothing about OUR agents
    // either — pruning on it would empty the roster over an id format we simply
    // do not recognise.
    expect(
      await syncChatMembership(
        { getChatBots: async () => [{ id: "ou_someone_else", idType: "open_id", name: "Other", isBot: true }] },
        channelConversation.id,
        "oc_1"
      )
    ).toEqual([]);
    expect(sorted(listChannelConversationMembers(channelConversation.id))).toEqual(["ag_designer", "ag_pm"]);
  });

  it("keeps a member it cannot match to a bot, even when its bot IS in the list", async () => {
    // The rule the function documents: no identification, no evidence, no
    // deletion. `ag_pm` has a binding but no bot id (an identity lookup that
    // failed once), so nothing said it left — and its bot is in the list.
    const channelConversation = seedChat(["ag_pm", "ag_designer"]);
    identify("ag_designer", "ou_bot_designer");

    const removed = await syncChatMembership(
      {
        getChatBots: async () => [
          { id: "ou_bot_designer", idType: "open_id", name: "D", isBot: true },
          { id: "ou_bot_pm", idType: "open_id", name: "P", isBot: true }
        ]
      },
      channelConversation.id,
      "oc_1"
    );

    expect(removed).toEqual([]);
    expect(sorted(listChannelConversationMembers(channelConversation.id))).toEqual([
      "ag_designer",
      "ag_pm"
    ]);
  });

  it("keeps the agent it was just told about, even when the list disagrees", async () => {
    // joinChannelConversation followed by the reconciliation could delete the
    // agent that was just recorded: the bot was added a moment ago and may not
    // be in the list yet, or its binding may have no open id to match on.
    const channelConversation = seedChat(["ag_pm", "ag_designer"]);
    upsertChannelBinding({
      id: "cb_designer_keep",
      agentId: "ag_designer",
      channel: "feishu",
      appId: "cli_designer_keep",
      appSecret: "s",
      botOpenId: "ou_bot_designer",
      boundByOpenId: "ou_user",
      now: 1
    });

    const removed = await syncChatMembershipKeeping(
      { getChatBots: async () => [{ id: "ou_bot_designer", idType: "open_id", name: "D", isBot: true }] },
      channelConversation.id,
      "oc_1",
      ["ag_pm"]
    );

    expect(removed).toEqual([]);
    expect(sorted(listChannelConversationMembers(channelConversation.id))).toEqual([
      "ag_designer",
      "ag_pm"
    ]);
  });

  it("does not trust a non-array answer", async () => {
    const channelConversation = seedChat(["ag_pm", "ag_designer"]);
    for (const answer of [null, { id: "ou_bot_pm" }, "ou_bot_pm", 42]) {
      expect(
        await syncChatMembership(
          { getChatBots: async () => answer as never },
          channelConversation.id,
          "oc_1"
        ),
        JSON.stringify(answer)
      ).toEqual([]);
    }
    expect(sorted(listChannelConversationMembers(channelConversation.id))).toEqual([
      "ag_designer",
      "ag_pm"
    ]);
  });

  it("only drops agents it can positively identify among the chat's bots", async () => {
    // Two agents with known bot ids: one is in the chat, the other is not.
    const channelConversation = seedChat(["ag_pm", "ag_designer"]);
    for (const [agentId, appId, openId] of [
      ["ag_pm", "cli_pm_prune", "ou_bot_pm"],
      ["ag_designer", "cli_designer_prune", "ou_bot_designer"]
    ]) {
      // botOpenId goes through the upsert: the table is keyed on
      // (agent_id, channel), so a binding the fixture already seeded keeps its
      // own id and an update by an invented id would match nothing.
      upsertChannelBinding({
        id: `cb_${agentId}`,
        agentId,
        channel: "feishu",
        appId,
        appSecret: "s",
        botOpenId: openId,
        boundByOpenId: "ou_user",
        now: 1
      });
    }

    const removed = await syncChatMembership(
      { getChatBots: async () => [{ id: "ou_bot_designer", idType: "open_id", name: "Designer", isBot: true }] },
      channelConversation.id,
      "oc_1"
    );

    // ag_pm is identifiable and absent from the list -> dropped.
    expect(removed).toEqual(["ag_pm"]);
    // ag_designer was in the list -> kept.
    expect(sorted(listChannelConversationMembers(channelConversation.id))).toEqual(["ag_designer"]);
  });

});

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
