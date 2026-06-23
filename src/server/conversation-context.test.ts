import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createConversation, sendMessage } from "@/server/conversation-service";
import {
  buildCompactionPrompt,
  buildHistoryFor,
  getContextBudgetPreview,
  runCompaction
} from "@/server/conversation-context";
import { createMessage } from "@/server/repositories";
import { updateSettings } from "@/server/settings-service";
import { newMessageId } from "@/shared/ids";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-ctx-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation-context — buildHistoryFor", () => {
  it("returns empty array for a conversation with no messages", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const history = await buildHistoryFor("ag_mock_builder", conv.id);
    expect(history).toEqual([]);
  });

  it("includes previous user and agent messages in order", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });

    // Manually insert a user + agent message pair
    const now = Date.now();
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "Hello" }],
      status: "complete",
      now: now - 2000
    });
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [{ type: "text", content: "Hi! How can I help?" }],
      status: "complete",
      now: now - 1000
    });

    // Send a new trigger message (excluded)
    const result = await sendMessage({ conversationId: conv.id, content: "trigger" });

    const history = await buildHistoryFor("ag_mock_builder", conv.id, {
      excludeMessageId: result.message.id
    });

    expect(history.length).toBe(2);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("Hello");
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toContain("Hi!");
  });

  it("filters out thinking/tool_use/tool_result from history", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const now = Date.now();

    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "build" }],
      status: "complete",
      now: now - 1000
    });
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [
        { type: "thinking", content: "I need to analyze..." },
        { type: "text", content: "I will build it." },
        { type: "tool_use", callId: "c1", toolName: "fs_read", args: {} },
        { type: "tool_result", callId: "c1", result: "file content" }
      ],
      status: "complete",
      now
    });

    const history = await buildHistoryFor("ag_mock_builder", conv.id);

    // Only public text should survive; thinking/tool_use/tool_result dropped
    const assistantMsg = history.find((h) => h.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain("I will build it.");
    expect(assistantMsg!.content).not.toContain("analyze");
    expect(assistantMsg!.content).not.toContain("fs_read");
  });

  it("folds artifact_ref into placeholder text", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const now = Date.now();

    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "create artifact" }],
      status: "complete",
      now: now - 1000
    });
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [
        { type: "text", content: "Done." },
        { type: "artifact_ref", artifactId: "art_nonexistent", title: "My Doc", artifactType: "document" }
      ],
      status: "complete",
      now
    });

    const history = await buildHistoryFor("ag_mock_builder", conv.id);

    const assistantMsg = history.find((h) => h.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain("Done.");
    expect(assistantMsg!.content).toContain("[产物:");
    expect(assistantMsg!.content).toContain("art_nonexistent");
  });

  it("handles group chat — other agent messages as user role with prefix", async () => {
    // Create a group conversation with two agents
    const conv = createConversation({
      mode: "group",
      agentIds: ["ag_mock_conductor", "ag_mock_builder"]
    });
    const now = Date.now();

    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "group task" }],
      status: "complete",
      now: now - 2000
    });
    // Message from the builder (another agent from conductor's perspective)
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [{ type: "text", content: "I completed the analysis." }],
      status: "complete",
      now: now - 1000
    });

    // Build history from conductor's perspective
    const history = await buildHistoryFor("ag_mock_conductor", conv.id);

    // The builder's message should appear as user role with [agentId] prefix
    const otherMsg = history.find((h) => h.role === "user" && h.content.includes("ag_mock_builder"));
    expect(otherMsg).toBeDefined();
    expect(otherMsg!.content).toContain("[ag_mock_builder]");
    expect(otherMsg!.content).toContain("I completed the analysis.");
  });

  it("excludes message by excludeMessageId", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const now = Date.now();

    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "msg1" }],
      status: "complete",
      now: now - 3000
    });
    createMessage({
      id: "msg_exclude_me",
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "msg2 exclude" }],
      status: "complete",
      now: now - 2000
    });
    createMessage({
      id: newMessageId(),
      conversationId: conv.id,
      role: "user",
      parts: [{ type: "text", content: "msg3" }],
      status: "complete",
      now: now - 1000
    });

    const history = await buildHistoryFor("ag_mock_builder", conv.id, {
      excludeMessageId: "msg_exclude_me"
    });

    const contents = history.map((h) => h.content);
    expect(contents.some((c) => c.includes("msg1"))).toBe(true);
    expect(contents.some((c) => c.includes("msg2"))).toBe(false);
    expect(contents.some((c) => c.includes("msg3"))).toBe(true);
  });

  it("returns empty array for non-existent conversation", async () => {
    const history = await buildHistoryFor("ag_test", "conv_nonexistent");
    expect(history).toEqual([]);
  });

  it("gracefully handles buildHistoryFor errors by returning empty (tested via agent-runner)", async () => {
    // Verify the function doesn't throw on missing data
    const history = await buildHistoryFor("ag_test", "conv_fake_id");
    expect(Array.isArray(history)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P8: buildCompactionPrompt
// ---------------------------------------------------------------------------

describe("buildCompactionPrompt", () => {
  const sampleMessages = [
    { role: "user", content: "帮我做一个番茄时钟" },
    { role: "assistant", agentName: "Conductor", content: "正在分析任务..." },
    {
      role: "assistant",
      agentName: "PM 小灰",
      content: "PRD 已完成 [产物: 番茄钟 PRD (art_001)]"
    },
    { role: "user", content: "不错，继续" }
  ];

  it("returns systemPrompt with required output sections", () => {
    const { systemPrompt } = buildCompactionPrompt(sampleMessages);
    expect(systemPrompt).toContain("conversation archivist");
    expect(systemPrompt).toContain("## 用户请求");
    expect(systemPrompt).toContain("## 任务与结果");
    expect(systemPrompt).toContain("## 产物");
    expect(systemPrompt).toContain("## 文件");
    expect(systemPrompt).toContain("## 待办");
    expect(systemPrompt).toContain("1500 characters");
  });

  it("returns userPrompt with all message content", () => {
    const { userPrompt } = buildCompactionPrompt(sampleMessages);
    expect(userPrompt).toContain("帮我做一个番茄时钟");
    expect(userPrompt).toContain("[Conductor]");
    expect(userPrompt).toContain("[PM 小灰]");
    expect(userPrompt).toContain("art_001");
    expect(userPrompt).toContain("New messages to compress (4 messages)");
  });

  it("includes existing summary when provided", () => {
    const { userPrompt } = buildCompactionPrompt(
      sampleMessages,
      "Previous: user requested a tomato clock."
    );
    expect(userPrompt).toContain("Previous summary for context");
    expect(userPrompt).toContain("tomato clock");
  });

  it("handles empty message array", () => {
    const { systemPrompt, userPrompt } = buildCompactionPrompt([]);
    expect(systemPrompt).toBeTruthy();
    expect(userPrompt).toContain("(0 messages)");
  });

  it("labels user messages with [用户] prefix", () => {
    const { userPrompt } = buildCompactionPrompt([{ role: "user", content: "hello" }]);
    expect(userPrompt).toContain("[用户] hello");
  });

  it("labels assistant messages with agentName prefix", () => {
    const { userPrompt } = buildCompactionPrompt([
      { role: "assistant", agentName: "前端工程师", content: "done" }
    ]);
    expect(userPrompt).toContain("[前端工程师] done");
  });

  it("omits label for assistant messages without agentName", () => {
    const { userPrompt } = buildCompactionPrompt([{ role: "assistant", content: "done" }]);
    expect(userPrompt).not.toContain("[undefined]");
  });
});

describe("context budget and compaction", () => {
  it("reports summary, pinned, recent, and omitted message counts", () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    for (let index = 0; index < 25; index++) {
      createMessage({
        id: `msg_budget_${index}`,
        conversationId: conv.id,
        role: "user",
        parts: [{ type: "text", content: `message ${index}` }],
        status: "complete",
        now: index + 1
      });
    }
    getDatabase().prepare("UPDATE conversations SET pinned_message_ids = ? WHERE id = ?")
      .run(JSON.stringify(["msg_budget_0"]), conv.id);

    const preview = getContextBudgetPreview(conv.id);

    expect(preview).toMatchObject({
      summaryIncluded: false,
      pinnedMessageCount: 1,
      recentMessageCount: 20,
      omittedMessageCount: 4,
      totalCompleteMessages: 25
    });
    expect(preview!.estimatedTokens).toBeGreaterThan(0);
  });

  it("publishes an explicit error when no compaction API key is configured", async () => {
    const events: string[] = [];
    const unsubscribe = eventBus.subscribe(({ event }) => events.push(event.type));

    await expect(runCompaction(
      "conv_missing_key",
      [{ role: "user", content: "important context" }],
      "msg_last",
      1,
      1
    )).rejects.toThrow("缺少 deepseek API Key");

    unsubscribe();
    expect(events).toEqual([
      "compaction.start",
      "compaction.progress",
      "compaction.error"
    ]);
  });

  it("uses the corrected OpenAI endpoint for compaction", async () => {
    updateSettings({ openaiApiKey: "sk-test" });
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "## 用户请求\n- 测试" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    try {
      await runCompaction(
        conversation.id,
        [{ role: "user", content: "test" }],
        "msg_last",
        1,
        1,
        "openai",
        "gpt-4o"
      );
      expect(requestedUrl).toBe("https://api.openai.com/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
