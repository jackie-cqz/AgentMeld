import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as getDeploymentFile } from "@/app/deployments/[id]/[[...path]]/route";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { createNewArtifact } from "@/server/artifact-service";
import { createConversation } from "@/server/conversation-service";
import { deployArtifact } from "@/server/deployment-service";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-deploy-route-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /deployments/[id]/[[...path]]", () => {
  it("serves the root entry and nested assets", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const artifact = createNewArtifact({
      conversationId: conversation.id,
      type: "web_app",
      title: "Route app",
      content: {
        type: "web_app",
        files: {
          "index.html": "<script src=\"assets/app.js\"></script>",
          "assets/app.js": "window.deployed = true;"
        },
        entry: "index.html"
      }
    });
    const deployment = deployArtifact(artifact.id, conversation.id);

    const rootResponse = await getDeploymentFile(
      new Request(`http://localhost${deployment.previewPath}`),
      { params: Promise.resolve({ id: deployment.id, path: undefined }) }
    );
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");

    const assetResponse = await getDeploymentFile(
      new Request(`http://localhost${deployment.previewPath}/assets/app.js`),
      { params: Promise.resolve({ id: deployment.id, path: ["assets", "app.js"] }) }
    );
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toContain("window.deployed");
  });

  it("returns 404 for private deployment metadata", async () => {
    const response = await getDeploymentFile(
      new Request("http://localhost/deployments/dep_valid/.agent-conference/manifest.json"),
      { params: Promise.resolve({ id: "dep_valid", path: [".agent-conference", "manifest.json"] }) }
    );
    expect(response.status).toBe(404);
  });
});
