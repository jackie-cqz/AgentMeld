import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authedRequest, pairTestOwner, resetTestAuth } from "@/test/auth-test-helper";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { GET, PATCH } from "@/app/api/settings/route";
import { getSettings } from "@/server/settings-service";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-settings-api-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  resetTestAuth();
  eventBus.clearForTests();
  ensureDatabase();
  pairTestOwner();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetBootstrapForTests();
  resetClientForTests();
  resetTestAuth();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function jsonRequest(method: string, body?: unknown): Request {
  return authedRequest("http://localhost/api/settings", {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
}

describe("GET /api/settings", () => {
  it("returns settings with masked keys", async () => {
    // Set a key first
    await PATCH(jsonRequest("PATCH", { openaiApiKey: "test-openai-key-6789" }));

    const res = await GET(authedRequest("http://localhost/api/test"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      settings: { openaiApiKey: string | null };
      keySources: { openai: string };
    };
    // Key should be masked — only last 4 chars visible
    expect(body.settings.openaiApiKey).not.toBe("test-openai-key-6789");
    expect(body.settings.openaiApiKey).toContain("6789");
    expect(body.keySources.openai).toBe("app_settings");
  });

  it("returns null keys as null in response", async () => {
    const res = await GET(authedRequest("http://localhost/api/test"));
    const body = (await res.json()) as { settings: { deepseekApiKey: string | null } };
    expect(body.settings.deepseekApiKey).toBeNull();
  });
});

describe("PATCH /api/settings", () => {
  it("returns confirmed credential sources without exposing the new key", async () => {
    const response = await PATCH(jsonRequest("PATCH", { deepseekApiKey: "test-provider-1234" }));
    const body = await response.json();
    expect(body.keySources.deepseek).toBe("app_settings");
    expect(body.settings.deepseekApiKey).toMatch(/^\*+1234$/);
    expect(JSON.stringify(body)).not.toContain("test-provider-1234");
  });

  it("reports environment fallback after a local credential is removed", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-environment-fallback-secret");
    await PATCH(jsonRequest("PATCH", { deepseekApiKey: "test-local-secret" }));
    const response = await PATCH(jsonRequest("PATCH", { deepseekApiKey: null }));
    const body = await response.json();
    expect(body.settings.deepseekApiKey).toBeNull();
    expect(body.keySources.deepseek).toBe("environment");
    expect(JSON.stringify(body)).not.toContain("test-environment-fallback-secret");
  });

  it("a single-provider save retains unrelated credentials and publishing settings", async () => {
    await PATCH(jsonRequest("PATCH", { openaiApiKey: "test-openai-retained", deploymentPublishEnabled: true, deploymentPublishDir: "test-publish" }));
    await PATCH(jsonRequest("PATCH", { deepseekApiKey: "test-deepseek-added" }));
    expect(getSettings()).toMatchObject({ openaiApiKey: "test-openai-retained", deepseekApiKey: "test-deepseek-added", deploymentPublishEnabled: true, deploymentPublishDir: "test-publish" });
  });

  it("rejects invalid body with 400", async () => {
    const req = jsonRequest("PATCH", { openaiApiKey: 123 }); // should be string|null
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("updates multiple keys at once and returns them masked", async () => {
    const req = jsonRequest("PATCH", {
      openaiApiKey: "sk-openai-123",
      deepseekApiKey: "sk-ds-456"
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { settings: { openaiApiKey: string | null; deepseekApiKey: string | null } };
    // PATCH must not echo raw secrets back to the caller.
    expect(body.settings.openaiApiKey).not.toBe("sk-openai-123");
    expect(body.settings.deepseekApiKey).not.toBe("sk-ds-456");
    expect(body.settings.openaiApiKey).toContain("123");
    expect(body.settings.deepseekApiKey).toContain("456");

    expect(getSettings().openaiApiKey).toBe("sk-openai-123");
    expect(getSettings().deepseekApiKey).toBe("sk-ds-456");
  });

  it("does not leak stored keys when PATCHed with an empty body", async () => {
    await PATCH(jsonRequest("PATCH", { deepseekApiKey: "sk-SETTINGS-LEAK-1234" }));

    const res = await PATCH(jsonRequest("PATCH", {}));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { settings: { deepseekApiKey: string | null } };
    expect(body.settings.deepseekApiKey).not.toBe("sk-SETTINGS-LEAK-1234");
    expect(body.settings.deepseekApiKey).toMatch(/^\*+1234$/);
  });

  it("allows setting key to null to clear it", async () => {
    await PATCH(jsonRequest("PATCH", { openaiApiKey: "sk-abc" }));
    await PATCH(jsonRequest("PATCH", { openaiApiKey: null }));

    const res = await GET(authedRequest("http://localhost/api/test"));
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

  it("does not overwrite a stored key when the masked value is submitted", async () => {
    await PATCH(jsonRequest("PATCH", { deepseekApiKey: "test-deepseek-api-key" }));
    const maskedResponse = await GET(authedRequest("http://localhost/api/test"));
    const maskedBody = (await maskedResponse.json()) as { settings: { deepseekApiKey: string } };

    await PATCH(jsonRequest("PATCH", { deepseekApiKey: maskedBody.settings.deepseekApiKey }));

    expect(getSettings().deepseekApiKey).toBe("test-deepseek-api-key");
  });
});
