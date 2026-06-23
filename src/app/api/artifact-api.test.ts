import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { createConversation } from "@/server/conversation-service";
import { createNewArtifact } from "@/server/artifact-service";
import { eventBus } from "@/server/event-bus";

import { GET as getArtifacts, POST as postArtifacts } from "@/app/api/artifacts/route";
import { GET as getArtifact, PATCH as patchArtifact, DELETE as deleteArtifact } from "@/app/api/artifacts/[id]/route";
import { GET as previewArtifact } from "@/app/api/artifacts/[id]/preview/route";
import { GET as previewArtifactFile } from "@/app/api/artifacts/[id]/preview/[...path]/route";

let tempDir: string;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-art-api-"));
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

function jsonRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/test", {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
}

function createArtForTest() {
  const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
  return createNewArtifact({
    conversationId: conv.id,
    type: "document",
    title: "Test Artifact",
    content: { type: "document", content: "# Test\n\nHello world." }
  });
}

describe("GET /api/artifacts", () => {
  it("returns artifact list", async () => {
    createArtForTest();
    const res = await getArtifacts();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: unknown[] };
    expect(body.artifacts.length).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /api/artifacts", () => {
  it("rejects invalid body with 400", async () => {
    const req = jsonRequest("POST", { type: "invalid" });
    const res = await postArtifacts(req);
    expect(res.status).toBe(400);
  });

  it("creates an artifact and returns 201", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const req = jsonRequest("POST", {
      conversationId: conv.id,
      type: "document",
      title: "API Created",
      content: { type: "document", content: "body" }
    });
    const res = await postArtifacts(req);
    expect(res.status).toBe(201);
  });
});

describe("GET /api/artifacts/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await getArtifact(req, { params: Promise.resolve({ id: "art_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns artifact with version chain", async () => {
    const art = createArtForTest();
    const req = new Request("http://localhost/api/test");
    const res = await getArtifact(req, { params: Promise.resolve({ id: art.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact: { id: string }; versions: unknown[] };
    expect(body.artifact.id).toBe(art.id);
    expect(Array.isArray(body.versions)).toBe(true);
  });
});

describe("PATCH /api/artifacts/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const req = jsonRequest("PATCH", { title: "New" });
    const res = await patchArtifact(req, { params: Promise.resolve({ id: "art_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("creates a new version", async () => {
    const art = createArtForTest();
    const req = jsonRequest("PATCH", { title: "Updated Title" });
    const res = await patchArtifact(req, { params: Promise.resolve({ id: art.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact: { version: number; title: string } };
    expect(body.artifact.version).toBe(2);
    expect(body.artifact.title).toBe("Updated Title");
  });
});

describe("DELETE /api/artifacts/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const req = new Request("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteArtifact(req, { params: Promise.resolve({ id: "art_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("deletes and returns 204", async () => {
    const art = createArtForTest();
    const req = new Request("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteArtifact(req, { params: Promise.resolve({ id: art.id }) });
    expect(res.status).toBe(204);
  });
});

describe("GET /api/artifacts/[id]/preview", () => {
  it("returns 404 for unknown id", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await previewArtifact(req, { params: Promise.resolve({ id: "art_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 for non-web_app artifact", async () => {
    const art = createArtForTest(); // document type
    const req = new Request("http://localhost/api/test");
    const res = await previewArtifact(req, { params: Promise.resolve({ id: art.id }) });
    expect(res.status).toBe(400);
  });

  it("returns HTML with sandbox-safe CSP for web_app", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const art = createNewArtifact({
      conversationId: conv.id,
      type: "web_app",
      title: "Preview API Test",
      content: { type: "web_app", files: { "index.html": "<html><body><h1>Test</h1></body></html>" }, entry: "index.html" }
    });

    const req = new Request("http://localhost/api/test");
    const res = await previewArtifact(req, { params: Promise.resolve({ id: art.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("<h1>Test</h1>");

    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'unsafe-inline'");
  });

  it("serves nested assets and bases a nested entry at its directory", async () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const art = createNewArtifact({
      conversationId: conv.id,
      type: "web_app",
      title: "Nested Preview API Test",
      content: {
        type: "web_app",
        files: {
          "pages/index.html": "<html><head></head><body><script src=\"app.js\"></script></body></html>",
          "pages/app.js": "window.previewReady = true;"
        },
        entry: "pages/index.html"
      }
    });

    const rootResponse = await previewArtifact(
      new Request(`http://localhost/api/artifacts/${art.id}/preview`),
      { params: Promise.resolve({ id: art.id }) }
    );
    expect(await rootResponse.text()).toContain(`/preview/pages/`);

    const assetResponse = await previewArtifactFile(
      new Request(`http://localhost/api/artifacts/${art.id}/preview/pages/app.js`),
      { params: Promise.resolve({ id: art.id, path: ["pages", "app.js"] }) }
    );
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("Content-Type")).toContain("javascript");
    expect(await assetResponse.text()).toContain("previewReady");
  });
});
