import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/search/route";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { createConversation } from "@/server/conversation-service";
import { createMessage } from "@/server/repositories";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-search-api-"));
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

describe("GET /api/search", () => {
  it("validates required query", async () => {
    const response = await GET(new Request("http://localhost/api/search"));
    expect(response.status).toBe(400);
  });

  it("returns searchable message metadata", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    createMessage({
      id: "msg_api_search",
      conversationId: conversation.id,
      role: "agent",
      agentId: "ag_mock_builder",
      parts: [{ type: "text", content: "render pipeline implementation details" }],
      status: "complete",
      now: 10
    });

    const response = await GET(new Request("http://localhost/api/search?q=render*&role=agent"));
    const body = await response.json() as {
      ok: boolean;
      data: { hits: Array<{ messageId: string; conversationTitle: string }>; total: number };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.hits[0]).toMatchObject({
      messageId: "msg_api_search",
      conversationTitle: conversation.title
    });
  });

  it("supports LIKE fallback and pagination", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    for (let index = 0; index < 3; index++) {
      createMessage({
        id: `msg_model_${index}`,
        conversationId: conversation.id,
        role: "user",
        parts: [{ type: "text", content: `模型配置记录 ${index}` }],
        status: "complete",
        now: 10 + index
      });
    }

    const response = await GET(new Request("http://localhost/api/search?q=%E6%A8%A1%E5%9E%8B&fallback=like&limit=1&offset=1"));
    const body = await response.json() as {
      data: { hits: unknown[]; total: number; mode: string };
    };

    expect(body.data.total).toBe(3);
    expect(body.data.hits).toHaveLength(1);
    expect(body.data.mode).toBe("like");
  });
});
