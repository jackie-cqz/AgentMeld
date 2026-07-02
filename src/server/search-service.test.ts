import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { createConversation } from "@/server/conversation-service";
import { createMessage, updateMessageParts, updateMessageStatus } from "@/server/repositories";
import { searchMessages } from "@/server/search-service";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-search-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("search-service", () => {
  it("searches completed text parts without indexing tool content", () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    createMessage({
      id: "msg_search_text",
      conversationId: conversation.id,
      role: "user",
      parts: [
        { type: "text", content: "我们需要完成渲染管线设计" },
        { type: "tool_result", callId: "call_1", result: "secret-tool-only" }
      ],
      status: "complete",
      now: 10
    });

    const textResult = searchMessages({ query: "渲染管线" });
    const toolResult = searchMessages({ query: "secret-tool-only", fallback: "like" });

    expect(textResult.hits.map((hit) => hit.messageId)).toContain("msg_search_text");
    expect(textResult.hits[0].snippetHtml).toContain("<mark>");
    expect(toolResult.total).toBe(0);
  });

  it("supports role and conversation filters", () => {
    const first = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const second = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    createMessage({
      id: "msg_search_user",
      conversationId: first.id,
      role: "user",
      parts: [{ type: "text", content: "shared searchable phrase" }],
      status: "complete",
      now: 10
    });
    createMessage({
      id: "msg_search_agent",
      conversationId: second.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [{ type: "text", content: "shared searchable phrase" }],
      status: "complete",
      now: 20
    });

    expect(searchMessages({ query: "searchable", conversationId: first.id }).hits)
      .toHaveLength(1);
    expect(searchMessages({ query: "searchable", role: "agent" }).hits[0].messageId)
      .toBe("msg_search_agent");
  });

  it("uses LIKE fallback for short Chinese queries", () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    createMessage({
      id: "msg_short_chinese",
      conversationId: conversation.id,
      role: "user",
      parts: [{ type: "text", content: "切换模型以后继续测试" }],
      status: "complete",
      now: 10
    });

    const result = searchMessages({ query: "模型", fallback: "like" });

    expect(result.mode).toBe("like");
    expect(result.hits[0].messageId).toBe("msg_short_chinese");
    expect(result.hits[0].snippetHtml).not.toContain("<mark>");
  });

  it("indexes a streaming message only after it becomes terminal", () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    createMessage({
      id: "msg_streaming_search",
      conversationId: conversation.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [{ type: "text", content: "partial response" }],
      status: "streaming",
      now: 10
    });

    expect(searchMessages({ query: "partial", fallback: "like" }).total).toBe(0);
    updateMessageParts("msg_streaming_search", [{ type: "text", content: "completed searchable response" }], 20);
    updateMessageStatus("msg_streaming_search", "complete", 21);

    expect(searchMessages({ query: "searchable" }).hits[0].messageId).toBe("msg_streaming_search");
  });

  it("removes deleted messages from the FTS index", () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    createMessage({
      id: "msg_delete_search",
      conversationId: conversation.id,
      role: "user",
      parts: [{ type: "text", content: "temporary searchable content" }],
      status: "complete",
      now: 10
    });
    expect(searchMessages({ query: "temporary" }).total).toBe(1);

    getDatabase().prepare("DELETE FROM messages WHERE id = ?").run("msg_delete_search");

    expect(searchMessages({ query: "temporary" }).total).toBe(0);
  });

  it("returns INVALID_QUERY for unsupported FTS syntax", () => {
    expect(searchMessages({ query: "(unclosed" }).error).toBe("INVALID_QUERY");
  });
});
