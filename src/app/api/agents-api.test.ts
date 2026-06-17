import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createAgent } from "@/server/agent-service";

import { GET as getAgents, POST as postAgents } from "@/app/api/agents/route";
import { GET as getAgent, PATCH as patchAgent, DELETE as deleteAgent } from "@/app/api/agents/[id]/route";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-agent-api-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
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

function createTestAgent() {
  return createAgent({
    name: "API Test Agent",
    adapterName: "custom",
    modelId: "gpt-4.1-mini"
  });
}

describe("GET /api/agents", () => {
  it("returns agents list", async () => {
    const res = await getAgents();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents.length).toBeGreaterThanOrEqual(3); // built-in + any created
  });
});

describe("POST /api/agents", () => {
  it("rejects invalid body with 400", async () => {
    const req = jsonRequest("POST", { name: "" });
    const res = await postAgents(req);
    expect(res.status).toBe(400);
  });

  it("creates an agent and returns 201", async () => {
    const req = jsonRequest("POST", {
      name: "New API Agent",
      adapterName: "custom",
      modelProvider: "openai",
      modelId: "gpt-4.1-mini"
    });
    const res = await postAgents(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { id: string; name: string } };
    expect(body.agent.id).toMatch(/^ag_/);
    expect(body.agent.name).toBe("New API Agent");
  });

  it("accepts full agent config", async () => {
    const req = jsonRequest("POST", {
      name: "Full Config",
      adapterName: "custom",
      modelProvider: "deepseek",
      modelId: "deepseek-chat",
      apiKey: "sk-test",
      toolNames: ["fs_read", "bash"]
    });
    const res = await postAgents(req);
    expect(res.status).toBe(201);
  });
});

describe("GET /api/agents/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await getAgent(req, { params: Promise.resolve({ id: "ag_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns the agent", async () => {
    const agent = createTestAgent();
    const req = new Request("http://localhost/api/test");
    const res = await getAgent(req, { params: Promise.resolve({ id: agent.id }) });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/agents/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const req = jsonRequest("PATCH", { name: "Nope" });
    const res = await patchAgent(req, { params: Promise.resolve({ id: "ag_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("updates agent name", async () => {
    const agent = createTestAgent();
    const req = jsonRequest("PATCH", { name: "Renamed Agent" });
    const res = await patchAgent(req, { params: Promise.resolve({ id: agent.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { name: string } };
    expect(body.agent.name).toBe("Renamed Agent");
  });

  it("allows editing model on built-in agent", async () => {
    const listRes = await getAgents();
    const { agents } = (await listRes.json()) as { agents: Array<{ id: string; isBuiltin: boolean }> };
    const builtin = agents.find((a) => a.isBuiltin);
    expect(builtin).toBeDefined();

    const req = jsonRequest("PATCH", { modelId: "gpt-4.1-mini" });
    const res = await patchAgent(req, { params: Promise.resolve({ id: builtin!.id }) });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/agents/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const req = new Request("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteAgent(req, { params: Promise.resolve({ id: "ag_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("deletes a non-builtin agent and returns 204", async () => {
    const agent = createTestAgent();
    const req = new Request("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteAgent(req, { params: Promise.resolve({ id: agent.id }) });
    expect(res.status).toBe(204);
  });

  it("returns 400 for built-in agent deletion", async () => {
    const listRes = await getAgents();
    const { agents } = (await listRes.json()) as { agents: Array<{ id: string; isBuiltin: boolean }> };
    const builtin = agents.find((a) => a.isBuiltin);
    expect(builtin).toBeDefined();

    const req = new Request("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteAgent(req, { params: Promise.resolve({ id: builtin!.id }) });
    expect(res.status).toBe(400);
  });
});
