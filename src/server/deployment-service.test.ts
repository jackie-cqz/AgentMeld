import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { createNewArtifact } from "@/server/artifact-service";
import { createConversation } from "@/server/conversation-service";
import {
  deployArtifact,
  deployWorkspace,
  resolveDeploymentFile
} from "@/server/deployment-service";
import { updateSettings } from "@/server/settings-service";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-deploy-"));
  process.env.AGENTMELD_DATA_DIR = path.join(tempDir, "data");
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

describe("deployment-service", () => {
  it("preserves nested artifact files and returns a local preview", () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const artifact = createNewArtifact({
      conversationId: conversation.id,
      type: "web_app",
      title: "Nested app",
      content: {
        type: "web_app",
        files: {
          "index.html": "<script src=\"assets/app.js\"></script>",
          "assets/app.js": "window.ready = true;"
        },
        entry: "index.html"
      }
    });

    const result = deployArtifact(artifact.id, conversation.id);

    expect(result.status).toBe("ready");
    expect(result.previewPath).toBe(`/deployments/dep_${artifact.id}`);
    expect(result.sourceDownloadPath).toBeUndefined();
    const nestedFile = resolveDeploymentFile(result.id, "assets/app.js");
    expect(nestedFile).not.toBeNull();
    expect(fs.readFileSync(nestedFile!, "utf-8")).toContain("window.ready");
  });

  it("publishes to a configured deployment-specific directory", () => {
    const publishRoot = path.join(tempDir, "published");
    updateSettings({
      deploymentPublishEnabled: true,
      deploymentPublishDir: publishRoot,
      deploymentPublicBaseUrl: "https://example.com/apps/"
    });
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const artifact = createNewArtifact({
      conversationId: conversation.id,
      type: "web_app",
      title: "Published app",
      content: {
        type: "web_app",
        files: { "index.html": "<h1>Published</h1>" },
        entry: "index.html"
      }
    });

    const result = deployArtifact(artifact.id, conversation.id);

    expect(result.status).toBe("ready");
    expect(result.deploymentType).toBe("external_static");
    expect(result.previewPath).toBe(`https://example.com/apps/dep_${artifact.id}/`);
    expect(fs.existsSync(path.join(publishRoot, result.id, "index.html"))).toBe(true);
  });

  it("returns a visible failure when publishing settings are incomplete", () => {
    updateSettings({
      deploymentPublishEnabled: true,
      deploymentPublishDir: null,
      deploymentPublicBaseUrl: null
    });
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const artifact = createNewArtifact({
      conversationId: conversation.id,
      type: "web_app",
      title: "Broken publish",
      content: {
        type: "web_app",
        files: { "index.html": "<h1>Local still exists</h1>" },
        entry: "index.html"
      }
    });

    const result = deployArtifact(artifact.id, conversation.id);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("no publish directory");
  });

  it("rejects private metadata and traversal paths", () => {
    expect(resolveDeploymentFile("dep_valid", ".agentmeld/manifest.json")).toBeNull();
    expect(resolveDeploymentFile("dep_valid", "../secret.txt")).toBeNull();
  });
});

describe("deploying a workspace directory", () => {
  it("refuses a directory that is a symlink out of the workspace", () => {
    // The lexical check passes a link inside the workspace, and this function
    // READS the directory and publishes it — so host files would be published.
    const workspace = path.join(tempDir, "ws");
    const outside = path.join(tempDir, "outside");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "index.html"), "<p>host</p>");
    fs.writeFileSync(path.join(outside, "secret.txt"), "HOST SECRET");
    fs.symlinkSync(outside, path.join(workspace, "link"));

    const result = deployWorkspace(workspace, "link", "escaped");

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("escapes the workspace");
  });

  it("still deploys a real directory inside the workspace", () => {
    const workspace = path.join(tempDir, "ws2");
    fs.mkdirSync(path.join(workspace, "site"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "site", "index.html"), "<p>mine</p>");

    const result = deployWorkspace(workspace, "site", "mine");

    expect(result.status).toBe("ready");
  });
});
