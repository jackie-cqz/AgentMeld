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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-deploy-route-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
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
          "index.html": [
            "<link rel=\"stylesheet\" href=\"/assets/app.css\">",
            "<script type=\"module\" src=\"/assets/app.js\"></script>"
          ].join(""),
          "assets/app.css": ".hero{background:url('/assets/hero.svg')}",
          "assets/app.js": "window.deployed = true; const chunk = \"/assets/chunk.js\";"
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
    expect(rootResponse.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts allow-same-origin");
    expect(rootResponse.headers.get("Content-Security-Policy")).toContain("connect-src 'self' https:");
    const rootHtml = await rootResponse.text();
    expect(rootHtml).toContain(`<base href="/deployments/${deployment.id}/">`);
    expect(rootHtml).toContain(`href="/deployments/${deployment.id}/assets/app.css"`);
    expect(rootHtml).toContain(`src="/deployments/${deployment.id}/assets/app.js"`);

    const assetResponse = await getDeploymentFile(
      new Request(`http://localhost${deployment.previewPath}/assets/app.js`),
      { params: Promise.resolve({ id: deployment.id, path: ["assets", "app.js"] }) }
    );
    expect(assetResponse.status).toBe(200);
    const js = await assetResponse.text();
    expect(js).toContain("window.deployed");
    expect(js).toContain(`"/deployments/${deployment.id}/assets/chunk.js"`);

    const cssResponse = await getDeploymentFile(
      new Request(`http://localhost${deployment.previewPath}/assets/app.css`),
      { params: Promise.resolve({ id: deployment.id, path: ["assets", "app.css"] }) }
    );
    expect(await cssResponse.text()).toContain(`url('/deployments/${deployment.id}/assets/hero.svg')`);
  });

  it("returns 404 for private deployment metadata", async () => {
    const newPrivateResponse = await getDeploymentFile(
      new Request("http://localhost/deployments/dep_valid/.agentmeld/manifest.json"),
      { params: Promise.resolve({ id: "dep_valid", path: [".agentmeld", "manifest.json"] }) }
    );
    expect(newPrivateResponse.status).toBe(404);
  });
});
