import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authedRequest, pairTestOwner, resetTestAuth } from "@/test/auth-test-helper";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createAgent } from "@/server/agent-service";

import { GET as getAgents, POST as postAgents } from "@/app/api/agents/route";
import { GET as getAgent, PATCH as patchAgent, DELETE as deleteAgent } from "@/app/api/agents/[id]/route";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-agent-api-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  resetTestAuth();
  eventBus.clearForTests();
  ensureDatabase();
  pairTestOwner();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  resetTestAuth();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function jsonRequest(method: string, body?: unknown): Request {
  return authedRequest("http://localhost/api/test", {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
}

function createTestAgent() {
  return createAgent({
    name: "API Test Agent",
    adapterName: "pi",
    modelId: "gpt-4.1-mini"
  });
}

describe("GET /api/agents", () => {
  it("returns agents list", async () => {
    const res = await getAgents(authedRequest("http://localhost/api/test"));
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
      adapterName: "pi",
      modelProvider: "openai",
      modelId: "gpt-4.1-mini"
    });
    const res = await postAgents(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { id: string; name: string } };
    expect(body.agent.id).toMatch(/^ag_/);
    expect(body.agent.name).toBe("New API Agent");
  });

  it("creates a saved opencode Agent and returns 201", async () => {
    const req = jsonRequest("POST", {
      name: "OpenCode API Agent",
      adapterName: "opencode",
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash"
    });
    const res = await postAgents(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { adapterName: string } };
    expect(body.agent.adapterName).toBe("opencode");
  });

  it("rejects a retired engine as a new choice", async () => {
    const res = await postAgents(jsonRequest("POST", {
      name: "Retired API Agent",
      adapterName: "claude-code",
      modelId: "gpt-4.1-mini"
    }));
    expect(res.status).toBe(400);
  });

  it("persists the configured window and thinking effort", async () => {
    const created = await postAgents(jsonRequest("POST", {
      name: "Windowed API Agent",
      adapterName: "pi",
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash",
      contextWindow: 10_000,
      reasoningEffort: "high"
    }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { agent: { id: string; contextWindow: number | null; reasoningEffort: string | null } };
    expect(body.agent.contextWindow).toBe(10_000);
    expect(body.agent.reasoningEffort).toBe("high");

    const cleared = await patchAgent(jsonRequest("PATCH", { contextWindow: null, reasoningEffort: null }), {
      params: Promise.resolve({ id: body.agent.id })
    });
    expect(cleared.status).toBe(200);
    const after = (await cleared.json()) as { agent: { contextWindow: number | null; reasoningEffort: string | null } };
    expect(after.agent.contextWindow).toBeNull();
    expect(after.agent.reasoningEffort).toBeNull();
  });

  it("persists the model's vision capability, defaulting to capable when absent", async () => {
    const legacy = await postAgents(jsonRequest("POST", {
      name: "Legacy API Agent", adapterName: "pi", modelProvider: "deepseek", modelId: "deepseek-v4-flash"
    }));
    const legacyBody = (await legacy.json()) as { agent: { id: string; supportsVision: boolean } };
    expect(legacyBody.agent.supportsVision).toBe(true);

    const created = await postAgents(jsonRequest("POST", {
      name: "Text-only API Agent", adapterName: "pi", modelProvider: "deepseek",
      modelId: "deepseek-v4-flash", supportsVision: false
    }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { agent: { id: string; supportsVision: boolean } };
    expect(body.agent.supportsVision).toBe(false);

    const patched = await patchAgent(jsonRequest("PATCH", { supportsVision: true }), {
      params: Promise.resolve({ id: body.agent.id })
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { agent: { supportsVision: boolean } }).agent.supportsVision).toBe(true);
  });

  it("accepts full agent config", async () => {
    const req = jsonRequest("POST", {
      name: "Full Config",
      adapterName: "pi",
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
    const req = authedRequest("http://localhost/api/test");
    const res = await getAgent(req, { params: Promise.resolve({ id: "ag_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns the agent", async () => {
    const agent = createTestAgent();
    const req = authedRequest("http://localhost/api/test");
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
    const listRes = await getAgents(authedRequest("http://localhost/api/test"));
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
    const req = authedRequest("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteAgent(req, { params: Promise.resolve({ id: "ag_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("deletes a non-builtin agent and returns 204", async () => {
    const agent = createTestAgent();
    const req = authedRequest("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteAgent(req, { params: Promise.resolve({ id: agent.id }) });
    expect(res.status).toBe(204);
  });

  it("returns 400 for built-in agent deletion", async () => {
    const listRes = await getAgents(authedRequest("http://localhost/api/test"));
    const { agents } = (await listRes.json()) as { agents: Array<{ id: string; isBuiltin: boolean }> };
    const builtin = agents.find((a) => a.isBuiltin);
    expect(builtin).toBeDefined();

    const req = authedRequest("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteAgent(req, { params: Promise.resolve({ id: builtin!.id }) });
    expect(res.status).toBe(400);
  });
});
