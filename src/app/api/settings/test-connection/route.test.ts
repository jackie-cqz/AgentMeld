import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/settings/test-connection/route";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { updateSettings } from "@/server/settings-service";

let tempDir: string;
let originalFetch: typeof fetch;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-connection-test-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  ensureDatabase();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("POST /api/settings/test-connection", () => {
  it("returns a visible error when the key is missing", async () => {
    const response = await POST(jsonRequest({ provider: "deepseek" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("tests the provider without storing the supplied key", async () => {
    let authorization = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(JSON.stringify({
        choices: [{ message: { content: "OK" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const response = await POST(jsonRequest({
      provider: "deepseek",
      apiKey: "sk-ephemeral",
      modelId: "deepseek-chat"
    }));

    expect(response.status).toBe(200);
    expect(authorization).toBe("Bearer sk-ephemeral");
    expect(updateSettings({}).deepseekApiKey).toBeNull();
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/settings/test-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}
