import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authedRequest, pairTestOwner, resetTestAuth } from "@/test/auth-test-helper";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { createConversation } from "@/server/conversation-service";
import { createNewArtifact, getArtifactById } from "@/server/artifact-service";
import { eventBus } from "@/server/event-bus";

import { GET as getArtifacts, POST as postArtifacts } from "@/app/api/artifacts/route";
import { GET as getArtifact, PATCH as patchArtifact, DELETE as deleteArtifact } from "@/app/api/artifacts/[id]/route";
import { GET as previewArtifact } from "@/app/api/artifacts/[id]/preview/route";
import { POST as postArtifactVersion } from "@/app/api/artifacts/[id]/versions/route";
import { GET as previewArtifactFile } from "@/app/api/artifacts/[id]/preview/[...path]/route";

let tempDir: string;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-art-api-"));
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
    const res = await getArtifacts(authedRequest("http://localhost/api/test"));
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
    const req = authedRequest("http://localhost/api/test");
    const res = await getArtifact(req, { params: Promise.resolve({ id: "art_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns artifact with version chain", async () => {
    const art = createArtForTest();
    const req = authedRequest("http://localhost/api/test");
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
    const req = authedRequest("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteArtifact(req, { params: Promise.resolve({ id: "art_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("deletes and returns 204", async () => {
    const art = createArtForTest();
    const req = authedRequest("http://localhost/api/test", { method: "DELETE" });
    const res = await deleteArtifact(req, { params: Promise.resolve({ id: art.id }) });
    expect(res.status).toBe(204);
  });
});

describe("GET /api/artifacts/[id]/preview", () => {
  it("returns 404 for unknown id", async () => {
    const req = authedRequest("http://localhost/api/test");
    const res = await previewArtifact(req, { params: Promise.resolve({ id: "art_nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 for non-web_app artifact", async () => {
    const art = createArtForTest(); // document type
    const req = authedRequest("http://localhost/api/test");
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

    const req = authedRequest("http://localhost/api/test");
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
      authedRequest(`http://localhost/api/artifacts/${art.id}/preview`),
      { params: Promise.resolve({ id: art.id }) }
    );
    expect(await rootResponse.text()).toContain(`/preview/pages/`);

    const assetResponse = await previewArtifactFile(
      authedRequest(`http://localhost/api/artifacts/${art.id}/preview/pages/app.js`),
      { params: Promise.resolve({ id: art.id, path: ["pages", "app.js"] }) }
    );
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("Content-Type")).toContain("javascript");
    expect(await assetResponse.text()).toContain("previewReady");
  });
});

describe("the web artifact routes put their artifacts on the event bus", () => {
  // The room learns about an artifact from `artifact.create`; the adapters were
  // the only emitter, so anything created or edited on the web page was stored
  // silently. These assertions are deliberately about the EVENT'S CONTENT and
  // TIMING: "an event with this id appeared" also passes when the payload is a
  // fabrication, when it is published before the row exists, and when it is
  // published before the gate.
  function collect() {
    const seen: Array<{ id: string; conversationId: string; createdByAgentId: string | null }> = [];
    const unsubscribe = eventBus.subscribe((entry) => {
      if (entry.event.type === "artifact.create") {
        seen.push({
          id: entry.event.artifact.id,
          conversationId: entry.event.artifact.conversationId,
          createdByAgentId: entry.event.artifact.createdByAgentId
        });
      }
    });
    return { seen, unsubscribe };
  }

  function artifactBody(conversationId: string, title = "网页产物") {
    return {
      method: "POST" as const,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        type: "document",
        title,
        content: { type: "document", content: "# hi" }
      })
    };
  }

  it("publishes the row it actually stored, exactly once", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const { seen, unsubscribe } = collect();
    try {
      const response = await postArtifacts(
        authedRequest("http://localhost/api/artifacts", artifactBody(conversation.id))
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { artifact: { id: string; createdByAgentId: string | null } };

      expect(seen).toHaveLength(1);
      const persisted = getArtifactById(body.artifact.id);
      expect(persisted).not.toBeNull();
      expect(seen[0]).toEqual({
        id: persisted?.id,
        conversationId: conversation.id,
        createdByAgentId: persisted?.createdByAgentId ?? null
      });
    } finally {
      unsubscribe();
    }
  });

  it("publishes nothing when the request is not authenticated", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const { seen, unsubscribe } = collect();
    try {
      resetTestAuth();
      const response = await postArtifacts(
        new Request("http://localhost/api/artifacts", artifactBody(conversation.id))
      );
      expect(response.status).toBeGreaterThanOrEqual(401);
      expect(seen).toHaveLength(0);
    } finally {
      unsubscribe();
      pairTestOwner();
    }
  });

  it("publishes nothing when the body is rejected", async () => {
    const { seen, unsubscribe } = collect();
    try {
      const response = await postArtifacts(
        authedRequest("http://localhost/api/artifacts", artifactBody("conv_1", ""))
      );
      expect(response.status).toBe(400);
      expect(seen).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("publishes nothing when an edit changes nothing", async () => {
    // An empty PATCH used to create a new row and deliver a byte-identical
    // copy to the room.
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const original = createNewArtifact({
      conversationId: conversation.id,
      type: "document",
      title: "第一版",
      content: { type: "document", content: "# one" }
    });
    const { seen, unsubscribe } = collect();
    try {
      const response = await patchArtifact(
        authedRequest(`http://localhost/api/artifacts/${original.id}`, { method: "PATCH" }),
        { params: Promise.resolve({ id: original.id }) }
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { artifact: { id: string; version: number } };
      expect(body.artifact.id).toBe(original.id);
      expect(body.artifact.version).toBe(original.version);
      expect(seen).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("publishes on an edit, as a new version row", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const original = createNewArtifact({
      conversationId: conversation.id,
      type: "document",
      title: "第一版",
      content: { type: "document", content: "# one" }
    });
    const { seen, unsubscribe } = collect();
    try {
      const response = await patchArtifact(
        authedRequest(`http://localhost/api/artifacts/${original.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: { type: "document", content: "# two" } })
        }),
        { params: Promise.resolve({ id: original.id }) }
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { artifact: { id: string; parentArtifactId: string | null } };
      expect(body.artifact.id).not.toBe(original.id);
      expect(body.artifact.parentArtifactId).toBe(original.id);
      expect(seen).toHaveLength(1);
      expect(seen[0].id).toBe(body.artifact.id);
    } finally {
      unsubscribe();
    }
  });

  it("publishes on an explicit new version", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const original = createNewArtifact({
      conversationId: conversation.id,
      type: "document",
      title: "第一版",
      content: { type: "document", content: "# one" }
    });
    const { seen, unsubscribe } = collect();
    try {
      const response = await postArtifactVersion(
        authedRequest(`http://localhost/api/artifacts/${original.id}/versions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: { type: "document", content: "# three" } })
        }),
        { params: Promise.resolve({ id: original.id }) }
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { artifact: { id: string } };
      expect(seen).toHaveLength(1);
      expect(seen[0].id).toBe(body.artifact.id);
    } finally {
      unsubscribe();
    }
  });

  it("still succeeds when a listener throws", async () => {
    // The row is stored; a broken subscriber must not be reported to the caller
    // as a failed creation, or it would retry into a duplicate artifact.
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = eventBus.subscribe((entry) => {
      if (entry.event.type === "artifact.create") throw new Error("listener exploded");
    });
    try {
      const response = await postArtifacts(
        authedRequest("http://localhost/api/artifacts", artifactBody(conversation.id))
      );
      expect(response.status).toBe(201);
    } finally {
      boom();
      errors.mockRestore();
    }
  });
});

