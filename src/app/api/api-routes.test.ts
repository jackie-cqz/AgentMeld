import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";

// API route handlers
import { GET as getConversations, POST as postConversations } from "@/app/api/conversations/route";
import {
  GET as getConversation,
  PATCH as patchConversation,
  DELETE as deleteConversation
} from "@/app/api/conversations/[id]/route";
import { POST as postMessage } from "@/app/api/conversations/[id]/messages/route";
import { POST as abortRun } from "@/app/api/runs/[id]/abort/route";

let tempDir: string;
let conversationId: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conference-api-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
  eventBus.clearForTests();
});

afterEach(() => {
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function jsonRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/test", {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
}

// ---------------------------------------------------------------------------
// Conversations API
// ---------------------------------------------------------------------------

describe("POST /api/conversations", () => {
  it("rejects invalid body with 400", async () => {
    const req = jsonRequest("POST", { mode: "invalid" });
    const res = await postConversations(req);
    expect(res.status).toBe(400);
  });

  it("creates a conversation and returns 201", async () => {
    const req = jsonRequest("POST", {
      mode: "single",
      agentIds: ["ag_mock_builder"],
      title: "API Test"
    });
    const res = await postConversations(req);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { conversation: { id: string; title: string } };
    expect(body.conversation.id).toMatch(/^conv_/);
    expect(body.conversation.title).toBe("API Test");
    conversationId = body.conversation.id;
  });

  it("accepts empty body and uses defaults", async () => {
    const req = jsonRequest("POST", {});
    const res = await postConversations(req);
    expect(res.status).toBe(201);
  });
});

describe("GET /api/conversations", () => {
  it("returns the conversation list", async () => {
    // Create one first
    await postConversations(jsonRequest("POST", {
      mode: "single",
      agentIds: ["ag_mock_builder"]
    }));

    const res = await getConversations();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Single Conversation API
// ---------------------------------------------------------------------------

describe("GET /api/conversations/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await getConversation(req, { params: Promise.resolve({ id: "conv_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns the conversation payload", async () => {
    const createRes = await postConversations(jsonRequest("POST", {
      mode: "single",
      agentIds: ["ag_mock_builder"]
    }));
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    const req = new Request("http://localhost/api/test");
    const res = await getConversation(req, { params: Promise.resolve({ id: conversation.id }) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { conversation: { id: string }; messages: unknown[] };
    expect(body.conversation.id).toBe(conversation.id);
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

describe("PATCH /api/conversations/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const req = jsonRequest("PATCH", { title: "Nope" });
    const res = await patchConversation(req, { params: Promise.resolve({ id: "conv_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("rejects invalid body with 400", async () => {
    const createRes = await postConversations(jsonRequest("POST", {
      mode: "single",
      agentIds: ["ag_mock_builder"]
    }));
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    const req = jsonRequest("PATCH", { pinnedMessageIds: "not-an-array" });
    const res = await patchConversation(req, { params: Promise.resolve({ id: conversation.id }) });
    expect(res.status).toBe(400);
  });

  it("updates title and returns 200", async () => {
    const createRes = await postConversations(jsonRequest("POST", {
      mode: "single",
      agentIds: ["ag_mock_builder"]
    }));
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    const req = jsonRequest("PATCH", { title: "Updated Title" });
    const res = await patchConversation(req, { params: Promise.resolve({ id: conversation.id }) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { conversation: { title: string } };
    expect(body.conversation.title).toBe("Updated Title");
  });
});

describe("DELETE /api/conversations/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const req = new Request("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteConversation(req, { params: Promise.resolve({ id: "conv_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("deletes and returns 204", async () => {
    const createRes = await postConversations(jsonRequest("POST", {
      mode: "single",
      agentIds: ["ag_mock_builder"]
    }));
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    const req = new Request("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteConversation(req, { params: Promise.resolve({ id: conversation.id }) });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Messages API
// ---------------------------------------------------------------------------

describe("POST /api/conversations/[id]/messages", () => {
  it("rejects empty content with 400", async () => {
    const req = jsonRequest("POST", { content: "" });
    const res = await postMessage(req, { params: Promise.resolve({ id: "conv_test" }) });
    expect(res.status).toBe(400);
  });

  it("rejects content exceeding 8000 chars with 400", async () => {
    const req = jsonRequest("POST", { content: "x".repeat(8001) });
    const res = await postMessage(req, { params: Promise.resolve({ id: "conv_test" }) });
    expect(res.status).toBe(400);
  });

  it("sends a message and returns 202 with run ids", async () => {
    const createRes = await postConversations(jsonRequest("POST", {
      mode: "single",
      agentIds: ["ag_mock_builder"]
    }));
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    const req = jsonRequest("POST", { content: "Hello world" });
    const res = await postMessage(req, { params: Promise.resolve({ id: conversation.id }) });
    expect(res.status).toBe(202);

    const body = (await res.json()) as { message: { id: string }; runIds: string[] };
    expect(body.message.id).toMatch(/^msg_/);
    expect(body.runIds.length).toBe(1);
    expect(body.runIds[0]).toMatch(/^run_/);
  });

  it("passes mentionedAgentIds through", async () => {
    const createRes = await postConversations(jsonRequest("POST", {
      mode: "group",
      agentIds: ["ag_mock_orchestrator", "ag_mock_builder"]
    }));
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    const req = jsonRequest("POST", {
      content: "Hello",
      mentionedAgentIds: ["ag_mock_builder"]
    });
    const res = await postMessage(req, { params: Promise.resolve({ id: conversation.id }) });
    expect(res.status).toBe(202);

    const body = (await res.json()) as { message: { mentionedAgentIds: string[] } };
    expect(body.message.mentionedAgentIds).toContain("ag_mock_builder");
  });
});

// ---------------------------------------------------------------------------
// Abort API
// ---------------------------------------------------------------------------

describe("POST /api/runs/[id]/abort", () => {
  it("returns 404 for unknown run id", async () => {
    const req = new Request("http://localhost/api/test", { method: "POST" });
    const res = await abortRun(req, { params: Promise.resolve({ id: "run_nonexistent" }) });
    expect(res.status).toBe(404);
  });
});
