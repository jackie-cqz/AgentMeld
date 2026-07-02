import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import {
  createConversation
} from "@/server/conversation-service";
import { eventBus } from "@/server/event-bus";
import {
  createNewArtifact,
  createNewArtifactVersion,
  getAllArtifacts,
  getArtifactById,
  getArtifactVersionFamily,
  getArtifactsForConversation,
  getVersionChain,
  ensureWebAppPreview
} from "@/server/artifact-service";
import type { ArtifactContent } from "@/shared/types";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-art-"));
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

describe("artifact-service", () => {
  describe("createNewArtifact", () => {
    it("creates a document artifact", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });

      const art = createNewArtifact({
        conversationId: conv.id,
        type: "document",
        title: "Test Document",
        content: { type: "document", format: "markdown", content: "# Hello" }
      });

      expect(art.id).toMatch(/^art_/);
      expect(art.type).toBe("document");
      expect(art.title).toBe("Test Document");
      expect(art.version).toBe(1);
    });

    it("creates a web_app artifact", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });

      const art = createNewArtifact({
        conversationId: conv.id,
        type: "web_app",
        title: "Test App",
        content: { type: "web_app", files: { "index.html": "<h1>Hi</h1>" }, entry: "index.html" }
      });

      expect(art.type).toBe("web_app");
      expect((art.content as Extract<ArtifactContent, { type: "web_app" }>).files).toHaveProperty("index.html");
    });

    it("creates an image artifact", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });

      const art = createNewArtifact({
        conversationId: conv.id,
        type: "image",
        title: "Screenshot",
        content: { type: "image", url: "https://example.com/img.png", alt: "test" }
      });

      expect(art.type).toBe("image");
    });
  });

  describe("getArtifactById", () => {
    it("returns the artifact by id", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      const art = createNewArtifact({
        conversationId: conv.id,
        type: "document",
        title: "Doc",
        content: { type: "document", content: "text" }
      });

      const found = getArtifactById(art.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe("Doc");
    });

    it("returns null for unknown id", () => {
      expect(getArtifactById("art_nonexistent")).toBeNull();
    });
  });

  describe("getArtifactsForConversation", () => {
    it("returns artifacts scoped to a conversation", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      createNewArtifact({ conversationId: conv.id, type: "document", title: "A", content: { type: "document", content: "a" } });
      createNewArtifact({ conversationId: conv.id, type: "document", title: "B", content: { type: "document", content: "b" } });

      const arts = getArtifactsForConversation(conv.id);
      expect(arts).toHaveLength(2);
    });
  });

  describe("getAllArtifacts", () => {
    it("returns artifacts across all conversations", () => {
      const conv1 = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      const conv2 = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });

      createNewArtifact({ conversationId: conv1.id, type: "document", title: "A1", content: { type: "document", content: "a" } });
      createNewArtifact({ conversationId: conv2.id, type: "document", title: "A2", content: { type: "document", content: "b" } });

      const all = getAllArtifacts();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("createNewArtifactVersion", () => {
    it("creates a new version with incremented version number", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      const v1 = createNewArtifact({
        conversationId: conv.id,
        type: "document",
        title: "Doc v1",
        content: { type: "document", content: "v1 content" }
      });

      const v2 = createNewArtifactVersion(v1.id, {
        title: "Doc v2",
        content: { type: "document", content: "v2 content" }
      });

      expect(v2).not.toBeNull();
      expect(v2!.version).toBe(2);
      expect(v2!.parentArtifactId).toBe(v1.id);
      expect(v2!.title).toBe("Doc v2");
    });

    it("returns null for non-existent artifact", () => {
      const result = createNewArtifactVersion("art_nonexistent", { title: "Nope" });
      expect(result).toBeNull();
    });
  });

  describe("getVersionChain", () => {
    it("returns the full version chain", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      const v1 = createNewArtifact({
        conversationId: conv.id, type: "document", title: "V1",
        content: { type: "document", content: "c1" }
      });
      const v2 = createNewArtifactVersion(v1.id, {
        title: "V2", content: { type: "document", content: "c2" }
      });

      const chain = getVersionChain(v2!.id);
      expect(chain.length).toBe(2);
      expect(chain[0].id).toBe(v2!.id);
      expect(chain[1].id).toBe(v1.id);
    });
  });

  describe("getArtifactVersionFamily", () => {
    it("returns root, current, latest, and descendants from any selected version", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      const v1 = createNewArtifact({
        conversationId: conv.id,
        type: "document",
        title: "V1",
        content: { type: "document", content: "c1" }
      });
      const v2 = createNewArtifactVersion(v1.id, {
        title: "V2",
        content: { type: "document", content: "c2" }
      })!;
      const v3 = createNewArtifactVersion(v2.id, {
        title: "V3",
        content: { type: "document", content: "c3" }
      })!;

      const family = getArtifactVersionFamily(v2.id);

      expect(family?.rootId).toBe(v1.id);
      expect(family?.currentId).toBe(v2.id);
      expect(family?.latestId).toBe(v3.id);
      expect(family?.versions.map((version) => version.id)).toEqual([v1.id, v2.id, v3.id]);
    });
  });

  describe("ensureWebAppPreview", () => {
    it("writes web_app files to the preview directory", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      const art = createNewArtifact({
        conversationId: conv.id,
        type: "web_app",
        title: "Preview Test",
        content: { type: "web_app", files: { "index.html": "<h1>Hi</h1>" }, entry: "index.html" }
      });

      const previewDir = ensureWebAppPreview(art);

      expect(fs.existsSync(previewDir)).toBe(true);
      const html = fs.readFileSync(path.join(previewDir, "index.html"), "utf-8");
      expect(html).toBe("<h1>Hi</h1>");
    });

    it("preserves nested file paths", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      const art = createNewArtifact({
        conversationId: conv.id,
        type: "web_app",
        title: "Nested Preview",
        content: {
          type: "web_app",
          files: {
            "index.html": "<script src=\"assets/app.js\"></script>",
            "assets/app.js": "document.body.dataset.ready = 'true';"
          },
          entry: "index.html"
        }
      });

      const previewDir = ensureWebAppPreview(art);

      expect(fs.readFileSync(path.join(previewDir, "assets", "app.js"), "utf-8"))
        .toContain("dataset.ready");
    });

    it("rejects unsafe file paths", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      const art = createNewArtifact({
        conversationId: conv.id,
        type: "web_app",
        title: "Unsafe Preview",
        content: {
          type: "web_app",
          files: { "index.html": "<h1>Hi</h1>", "../evil.js": "bad" },
          entry: "index.html"
        }
      });

      expect(() => ensureWebAppPreview(art)).toThrow("unsafe file path");
    });

    it("throws for non-web_app artifacts", () => {
      const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
      const art = createNewArtifact({
        conversationId: conv.id,
        type: "document",
        title: "Not a web app",
        content: { type: "document", content: "text" }
      });

      expect(() => ensureWebAppPreview(art)).toThrow("not a web_app");
    });
  });
});
