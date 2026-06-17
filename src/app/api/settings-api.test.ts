import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { GET, PATCH } from "@/app/api/settings/route";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-settings-api-"));
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
  return new Request("http://localhost/api/settings", {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
}

describe("GET /api/settings", () => {
  it("returns settings with masked keys", async () => {
    // Set a key first
    await PATCH(jsonRequest("PATCH", { openaiApiKey: "sk-proj-abc123456789" }));

    const res = await GET();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { settings: { openaiApiKey: string | null } };
    // Key should be masked — only last 4 chars visible
    expect(body.settings.openaiApiKey).not.toBe("sk-proj-abc123456789");
    expect(body.settings.openaiApiKey).toContain("6789");
  });

  it("returns null keys as null in response", async () => {
    const res = await GET();
    const body = (await res.json()) as { settings: { deepseekApiKey: string | null } };
    expect(body.settings.deepseekApiKey).toBeNull();
  });
});

describe("PATCH /api/settings", () => {
  it("rejects invalid body with 400", async () => {
    const req = jsonRequest("PATCH", { openaiApiKey: 123 }); // should be string|null
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("updates multiple keys at once", async () => {
    const req = jsonRequest("PATCH", {
      openaiApiKey: "sk-openai-123",
      deepseekApiKey: "sk-ds-456"
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { settings: { openaiApiKey: string | null; deepseekApiKey: string | null } };
    expect(body.settings.openaiApiKey).toBe("sk-openai-123");
    expect(body.settings.deepseekApiKey).toBe("sk-ds-456");
  });

  it("allows setting key to null to clear it", async () => {
    await PATCH(jsonRequest("PATCH", { openaiApiKey: "sk-abc" }));
    await PATCH(jsonRequest("PATCH", { openaiApiKey: null }));

    const res = await GET();
    const body = (await res.json()) as { settings: { openaiApiKey: string | null } };
    expect(body.settings.openaiApiKey).toBeNull();
  });

  it("allows updating non-key fields", async () => {
    const req = jsonRequest("PATCH", {
      companionMode: "lan",
      deploymentPublishEnabled: true
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { settings: { companionMode: string; deploymentPublishEnabled: boolean } };
    expect(body.settings.companionMode).toBe("lan");
    expect(body.settings.deploymentPublishEnabled).toBe(true);
  });
});
