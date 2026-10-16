import { describe, expect, it } from "vitest";
import { getDatabase } from "@/db/client";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getAgent, updateConversation } from "@/server/repositories";
import { newMessageId } from "@/shared/ids";
import { buildHistoryFor } from "@/server/conversation-context";
import { buildCollaborationHistory } from "./conversation-context";
import { resolveFacts } from "@/server/context-facts/fact-service";

function world() {
  const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_conductor", "ag_mock_builder"] });
  const agent = getAgent("ag_mock_conductor")!;
  let clock = Date.now() - 100_000;
  const message = (content: string, role: "user" | "agent" = "user") => createMessage({
    id: newMessageId(), conversationId: conversation.id, role, agentId: role === "agent" ? "ag_mock_builder" : null,
    parts: [{ type: "text", content }], status: "complete", now: clock += 100,
  });
  return { conversation, agent, message };
}

describe("bounded collaboration history", () => {
  it("injects only active facts with source and trust, not superseded or other-conversation facts", async () => {
    const { agent, conversation, message } = world();
    const previous = message("Use green");
    resolveFacts(conversation.id, [{ definitionId: "builtin_ui_primary_color", value: "#00ff00", confidence: 1 }], "message", previous.id);
    const triggerMessage = message("Use blue instead");
    resolveFacts(conversation.id, [{ definitionId: "builtin_ui_primary_color", value: "#0000ff", confidence: 1 }], "message", triggerMessage.id);
    const other = world();
    resolveFacts(other.conversation.id, [{ definitionId: "builtin_ui_primary_color", value: "#ff0000", confidence: 1 }], "message", other.message("Other color").id);
    const result = await buildCollaborationHistory({ agent, triggerMessage, systemPrompt: "Coordinate" });
    const facts = result.history.find(item => item.content.startsWith("<current_platform_facts>"))!.content;
    expect(facts).toContain("#0000ff");
    expect(facts).not.toContain("#00ff00");
    expect(facts).not.toContain("#ff0000");
    expect(facts).toContain(triggerMessage.id);
    expect(facts).toContain('"trustLevel":');
  });

  it("provides preceding peer discussion but not the current trigger or later messages", async () => {
    const { agent, message } = world();
    message("Please propose two layouts");
    message("Second proposal uses a compact sidebar", "agent");
    const triggerMessage = message("Use the second proposal");
    message("Future instruction must not leak");
    const result = await buildCollaborationHistory({ agent, triggerMessage, systemPrompt: "Coordinate this team" });
    const text = result.history.map(item => item.content).join("\n");
    expect(text).toContain("compact sidebar");
    expect(text).not.toContain("Use the second proposal");
    expect(text).not.toContain("Future instruction");
    expect(result.recentMessages).toHaveLength(2);
  });

  it("bounds optional history and retains the most recent relevant conversation", async () => {
    const { agent, message } = world();
    for (let i = 0; i < 30; i++) message(`history-${i} ${"x".repeat(8000)}`);
    const triggerMessage = message("Continue");
    const result = await buildCollaborationHistory({ agent, triggerMessage, systemPrompt: "Coordinate" });
    const text = result.history.map(item => item.content).join("\n");
    expect(text).toContain("history-29");
    expect(text).not.toContain("history-0 ");
    expect(result.estimatedTokens).toBeLessThan(13_000);
  });

  it("keeps mandatory pins and a preceding summary", async () => {
    const { agent, conversation, message } = world();
    const pinned = message("Preserve accessibility");
    const covered = message("Original design discussion");
    const triggerMessage = message("Continue");
    updateConversation(conversation.id, { pinnedMessageIds: [pinned.id], now: Date.now() });
    getDatabase().prepare(`INSERT INTO conversation_context_summaries
      (id, conversation_id, summary, covered_until_message_id, covered_until_created_at, source_message_count, token_estimate, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(newMessageId(), conversation.id, "Selected compact layout", covered.id, covered.createdAt, 2, 10, Date.now());
    const result = await buildCollaborationHistory({ agent, triggerMessage, systemPrompt: "Coordinate" });
    expect(result.history.map(item => item.content).join("\n")).toContain("Selected compact layout");
    expect(result.history.map(item => item.content).join("\n")).toContain("Preserve accessibility");
  });

  it("does not inject a summary that already covers a later user turn", async () => {
    const { agent, conversation, message } = world();
    message("Earlier choice");
    const triggerMessage = message("Continue");
    const future = message("Later choice");
    getDatabase().prepare(`INSERT INTO conversation_context_summaries
      (id, conversation_id, summary, covered_until_message_id, covered_until_created_at, source_message_count, token_estimate, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(newMessageId(), conversation.id, "Future summary", future.id, future.createdAt, 3, 10, Date.now());
    const history = await buildHistoryFor(agent.id, conversation.id, { beforeMessageId: triggerMessage.id });
    expect(history.map(item => item.content).join("\n")).toBe("Earlier choice");
  });

  it("fails explicitly rather than dropping mandatory context on overflow", async () => {
    const { agent, message } = world();
    const triggerMessage = message("Continue");
    await expect(buildCollaborationHistory({ agent, triggerMessage, systemPrompt: "x".repeat(300_000) })).rejects.toMatchObject({ category: "context_overflow" });
  });

  it("rejects a context boundary from another conversation", async () => {
    const { agent, conversation } = world();
    await expect(buildHistoryFor(agent.id, conversation.id, { beforeMessageId: "missing" })).rejects.toThrow("does not belong");
  });
});
