import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDatabase } from "@/db/client";
import { createAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { buildHistoryFor } from "@/server/conversation-context";
import { createMessage } from "@/server/repositories";
import { buildRunHistory } from "@/server/run-context";
import { reportContextTruncation } from "@/server/system-notice";
import { setupTestDatabase } from "@/test/test-database";
import { newMessageId } from "@/shared/ids";

/**
 * Issue #88: the context mode is chosen once, every mode is window-bounded, and
 * nothing is dropped without a count the caller can surface.
 */
describe("conversation context modes", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-context-modes-");
  });

  afterEach(() => {
    teardown();
  });

  function windowedAgent(contextWindow = 1_000_000) {
    return createAgent({
      name: "Context fixture",
      adapterName: "pi",
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash",
      contextWindow,
      toolNames: ["fs_read"],
    });
  }

  function seedMessages(conversationId: string, count: number, chars: number, prefix = "msg") {
    const now = Date.now();
    const created: string[] = [];
    for (let index = 0; index < count; index++) {
      const id = `${prefix}_${newMessageId()}`;
      createMessage({
        id,
        conversationId,
        role: "user",
        origin: "human",
        parts: [{ type: "text", content: `${prefix}-${index} ${"x".repeat(chars)}` }],
        status: "complete",
        now: now + index,
      });
      created.push(id);
    }
    return created;
  }

  function insertFact(conversationId: string, value: string) {
    const now = Date.now();
    getDatabase().prepare(`
      INSERT INTO conversation_facts (
        id, conversation_id, definition_id, canonical_key, value_json, value_type,
        status, trust_level, confidence, resolution_method, source_type, source_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `fact_${newMessageId()}`, conversationId, "builtin_project_goal", "project.goal",
      JSON.stringify(value), "string", "active", "verified", 1, "definition_id",
      "human", "msg_source", now, now,
    );
  }

  async function waitForCompactionJob(conversationId: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = getDatabase()
        .prepare("SELECT status FROM context_compaction_jobs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(conversationId) as { status: string } | undefined;
      if (row && !["queued", "running"].includes(row.status)) return row;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Compaction job did not settle.");
  }

  it("defaults a conversation to raw and keeps that choice on the row", () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });

    expect(conversation.contextMode).toBe("raw");
    const stored = getDatabase().prepare("SELECT context_mode FROM conversations WHERE id = ?")
      .get(conversation.id) as { context_mode: string };
    expect(stored.context_mode).toBe("raw");
  });

  it("injects verified facts only when the conversation is created as evidence", async () => {
    const agent = windowedAgent();
    const evidence = createConversation({ mode: "single", agentIds: [agent.id], contextMode: "evidence" });
    const raw = createConversation({ mode: "single", agentIds: [agent.id], contextMode: "raw" });
    seedMessages(evidence.id, 1, 20, "evidence");
    seedMessages(raw.id, 1, 20, "raw");
    insertFact(evidence.id, "Ship the evidence context mode");
    insertFact(raw.id, "Ship the evidence context mode");

    const evidenceContext = await buildRunHistory({
      agent, conversationId: evidence.id, systemTokens: 0, currentTurnTokens: 0,
    });
    const rawContext = await buildRunHistory({
      agent, conversationId: raw.id, systemTokens: 0, currentTurnTokens: 0,
    });

    expect(evidenceContext.messages.some((message) => message.content.includes("<current_platform_facts>"))).toBe(true);
    expect(evidenceContext.messages.some((message) => message.content.includes("project.goal"))).toBe(true);
    expect(rawContext.messages.some((message) => message.content.includes("<current_platform_facts>"))).toBe(false);
  });

  it("starts app-level compaction at 80% of the configured window", async () => {
    const agent = windowedAgent(10_000);
    const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
    // 12 messages × ~1,000 tokens ≈ 12,000 tokens; 80% of 10,000 is reachable.
    seedMessages(conversation.id, 12, 4_000, "wide");

    const context = await buildRunHistory({
      agent, conversationId: conversation.id, systemTokens: 0, currentTurnTokens: 0,
    });
    await waitForCompactionJob(conversation.id);

    expect(context.compactionTriggered).toBe(true);
    const jobs = getDatabase().prepare("SELECT COUNT(*) AS count FROM context_compaction_jobs WHERE conversation_id = ?")
      .get(conversation.id) as { count: number };
    expect(jobs.count).toBe(1);
  });

  it("does not compact while the history is under the 80% threshold", async () => {
    const agent = windowedAgent(10_000);
    const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
    seedMessages(conversation.id, 3, 40, "small");

    const context = await buildRunHistory({
      agent, conversationId: conversation.id, systemTokens: 0, currentTurnTokens: 0,
    });

    expect(context.compactionTriggered).toBe(false);
    const jobs = getDatabase().prepare("SELECT COUNT(*) AS count FROM context_compaction_jobs WHERE conversation_id = ?")
      .get(conversation.id) as { count: number };
    expect(jobs.count).toBe(0);
  });

  it("reports truncation as a count and surfaces it instead of dropping silently", async () => {
    const agent = windowedAgent(10_000);
    const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
    seedMessages(conversation.id, 3, 6_000, "huge");

    const context = await buildRunHistory({
      agent, conversationId: conversation.id, systemTokens: 0, currentTurnTokens: 0,
    });

    expect(context.droppedMessageCount).toBeGreaterThan(0);
    reportContextTruncation(conversation.id, context.droppedMessageCount, context.contextWindow);

    const notice = getDatabase()
      .prepare("SELECT role, parts FROM messages WHERE conversation_id = ? AND role = 'system' ORDER BY created_at DESC LIMIT 1")
      .get(conversation.id) as { role: string; parts: string };
    expect(notice.role).toBe("system");
    const text = (JSON.parse(notice.parts) as Array<{ content: string }>).map((part) => part.content).join("\n");
    expect(text).toContain(`裁剪最旧的 ${context.droppedMessageCount} 条消息`);
  });

  it("no longer caps history at 20 turns", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    seedMessages(conversation.id, 32, 4, "turn");

    const history = await buildHistoryFor("ag_mock_builder", conversation.id);

    expect(history).toHaveLength(32);
    expect(history[0].content.startsWith("turn-0")).toBe(true);
  });
});
