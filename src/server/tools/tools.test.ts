import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDataDir, resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createConversation } from "@/server/conversation-service";
import { getArtifact } from "@/server/repositories";
import { toolRegistry } from "@/server/tools/registry";
import type { ToolContext } from "@/server/tools/types";
import { clearPendingWritesForTests } from "@/server/pending-writes";
import { clearPendingBashForTests } from "@/server/pending-bash";
import { getAllPendingBashCommands, rejectPendingBash } from "@/server/pending-bash";
import {
  clearAllToolEvidenceForTests,
  getRunToolEvidence
} from "@/server/dispatch-tool-evidence";

let tempDir: string;
let workspacePath: string;
let conversationId: string;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-tools-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  workspacePath = path.join(getDataDir(), "workspaces", "conv_tools_test");
  fs.mkdirSync(workspacePath, { recursive: true });

  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
  clearAllToolEvidenceForTests();
  ensureDatabase();

  // Create a conversation with auto approval for fs_write tests
  const conv = createConversation({
    mode: "single",
    agentIds: ["ag_mock_builder"]
  });
  // Override to auto mode for testing
  const { getDatabase } = await import("@/db/client");
  getDatabase().prepare("UPDATE conversations SET fs_write_approval_mode = ? WHERE id = ?").run("auto", conv.id);
  conversationId = conv.id;

  // Create test files
  fs.writeFileSync(path.join(workspacePath, "readme.txt"), "Hello World");
  fs.writeFileSync(path.join(workspacePath, "data.json"), JSON.stringify({ key: "value" }));
  fs.mkdirSync(path.join(workspacePath, "subdir"));
  fs.writeFileSync(path.join(workspacePath, "subdir", "nested.txt"), "nested content");
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
  clearAllToolEvidenceForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    conversationId,
    workspacePath,
    agentId: "ag_mock_builder",
    runId: "run_test",
    parentRunId: "run_parent",
    abortSignal: new AbortController().signal,
    ...overrides
  };
}

describe("tool registry", () => {
  it("has all 6 MVP tools registered", () => {
    const names = toolRegistry.listNames();
    expect(names).toContain("bash");
    expect(names).toContain("fs_list");
    expect(names).toContain("fs_read");
    expect(names).toContain("fs_write");
    expect(names).toContain("read_artifact");
    expect(names).toContain("write_artifact");
  });

  it("resolve returns tools for valid names", () => {
    const tools = toolRegistry.resolve(["fs_read", "fs_list"]);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("fs_read");
  });

  it("resolve throws for unknown tool name", () => {
    expect(() => toolRegistry.resolve(["nonexistent"])).toThrow("Unknown tool: nonexistent");
  });

  it("execute returns error for unknown tool", async () => {
    const result = await toolRegistry.execute("nope", {}, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("fs_list", () => {
  it("lists workspace root contents", async () => {
    const result = await toolRegistry.execute("fs_list", { path: "." }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { entries: Array<{ name: string; type: string }>; count: number };
      expect(value.count).toBeGreaterThanOrEqual(3); // readme.txt, data.json, subdir
      expect(value.entries.some((e) => e.name === "readme.txt" && e.type === "file")).toBe(true);
      expect(value.entries.some((e) => e.name === "subdir" && e.type === "directory")).toBe(true);
    }
  });

  it("lists subdirectory contents", async () => {
    const result = await toolRegistry.execute("fs_list", { path: "subdir" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { entries: Array<{ name: string }>; count: number };
      expect(value.count).toBe(1);
      expect(value.entries[0].name).toBe("nested.txt");
    }
  });

  it("rejects path outside workspace", async () => {
    const result = await toolRegistry.execute("fs_list", { path: "../../../etc" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("rejects non-directory path", async () => {
    const result = await toolRegistry.execute("fs_list", { path: "readme.txt" }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("fs_read", () => {
  it("reads a text file within workspace", async () => {
    const result = await toolRegistry.execute("fs_read", { path: "readme.txt" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { content: string; size: number; truncated: boolean };
      expect(value.content).toBe("Hello World");
      expect(value.size).toBe(11);
      expect(value.truncated).toBe(false);
    }
  });

  it("rejects path outside workspace", async () => {
    const result = await toolRegistry.execute("fs_read", { path: "../../../etc/passwd" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("rejects non-existent file", async () => {
    const result = await toolRegistry.execute("fs_read", { path: "nonexistent.txt" }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("fs_write", () => {
  it("writes a file in auto mode", async () => {
    const result = await toolRegistry.execute(
      "fs_write",
      { path: "output.txt", content: "generated content" },
      ctx()
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { applied: string };
      expect(value.applied).toBe("auto");
    }

    // Verify file was written
    const written = fs.readFileSync(path.join(workspacePath, "output.txt"), "utf-8");
    expect(written).toBe("generated content");
    expect(getRunToolEvidence("run_test").fileWrites).toContainEqual({
      path: "output.txt",
      absolutePath: path.join(workspacePath, "output.txt"),
      action: "created"
    });
  });

  it("writes to a nested path creating parent directories", async () => {
    const result = await toolRegistry.execute(
      "fs_write",
      { path: "deep/nested/file.txt", content: "deep" },
      ctx()
    );
    expect(result.ok).toBe(true);

    const written = fs.readFileSync(path.join(workspacePath, "deep/nested/file.txt"), "utf-8");
    expect(written).toBe("deep");
  });

  it("rejects content exceeding 100 KB", async () => {
    const huge = "x".repeat(100_001);
    const result = await toolRegistry.execute("fs_write", { path: "big.txt", content: huge }, ctx());
    expect(result.ok).toBe(false);
  });

  it("rejects path outside workspace", async () => {
    const result = await toolRegistry.execute(
      "fs_write",
      { path: "../../../etc/danger.txt", content: "x" },
      ctx()
    );
    expect(result.ok).toBe(false);
  });
});

describe("bash", () => {
  it("rejects banned commands", async () => {
    const result = await toolRegistry.execute("bash", {
      command: process.platform === "win32"
        ? "Remove-Item -Recurse -Force C:\\Windows"
        : "sudo rm -rf /"
    }, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("blocked");
    }
  });

  it("executes a simple echo command", async () => {
    const cmd = process.platform === "win32"
      ? "Write-Output hello"
      : "echo hello";
    const result = await toolRegistry.execute("bash", { command: cmd }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { exitCode: number; output: string };
      expect(value.exitCode).toBe(0);
      expect(value.output).toContain("hello");
    }
    expect(getRunToolEvidence("run_test").commands).toEqual([
      expect.objectContaining({
        command: cmd,
        exitCode: 0,
        timedOut: false,
        isError: false
      })
    ]);
  }, 10000);

  it("executes in the workspace directory", async () => {
    const cmd = process.platform === "win32"
      ? "Get-Location"
      : "pwd";
    const result = await toolRegistry.execute("bash", { command: cmd }, ctx());
    expect(result.ok).toBe(true);
  }, 10000);

  it("rejects empty command", async () => {
    const result = await toolRegistry.execute("bash", { command: "" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("requires approval for dependency installation commands", async () => {
    const execution = toolRegistry.execute("bash", { command: "pnpm install" }, ctx());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = getAllPendingBashCommands();
    expect(pending).toHaveLength(1);
    rejectPendingBash(pending[0].id);

    const result = await execution;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("rejected");
  });
});

describe("read_artifact", () => {
  it("returns error for non-existent artifact", async () => {
    const result = await toolRegistry.execute("read_artifact", { artifactId: "art_nonexistent" }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("write_artifact", () => {
  it("creates a document artifact from direct markdown content", async () => {
    const result = await toolRegistry.execute("write_artifact", {
      type: "document",
      title: "Direct Markdown",
      content: "# Direct\n\nMarkdown body"
    }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { artifactId: string };
      const artifact = getArtifact(value.artifactId);
      expect(artifact?.content).toEqual({
        type: "document",
        format: "markdown",
        content: "# Direct\n\nMarkdown body"
      });
    }
  });

  it("creates a document artifact", async () => {
    const result = await toolRegistry.execute("write_artifact", {
      type: "document",
      title: "Test Doc",
      content: { content: "# Hello\n\nWorld" }
    }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { artifactId: string; type: string };
      expect(value.artifactId).toMatch(/^art_/);
      expect(value.type).toBe("document");
    }
  });

  it("rejects write_artifact with empty args", async () => {
    const result = await toolRegistry.execute("write_artifact", {}, ctx());
    expect(result.ok).toBe(false);
  });

  it("normalizes stringified structured document content", async () => {
    const result = await toolRegistry.execute("write_artifact", {
      type: "document",
      title: "Style guide",
      content: JSON.stringify({
        format: "markdown",
        content: "# Style guide\n\nStructured content."
      })
    }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const artifact = getArtifact((result.value as { artifactId: string }).artifactId);
      expect(artifact?.content).toEqual({
        type: "document",
        format: "markdown",
        content: "# Style guide\n\nStructured content."
      });
    }
  });

  it("creates a web_app artifact from html string", async () => {
    const result = await toolRegistry.execute("write_artifact", {
      type: "web_app",
      title: "Test App",
      content: "<html><body><h1>Hi</h1></body></html>"
    }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { type: string };
      expect(value.type).toBe("web_app");
    }
  });
});

describe("deploy_workspace", () => {
  it("returns a failed deployment record for a deployable call that cannot be materialized", async () => {
    const emptyPath = path.join(workspacePath, "empty-dist");
    fs.mkdirSync(emptyPath, { recursive: true });

    const result = await toolRegistry.execute("deploy_workspace", {
      path: "empty-dist",
      title: "Broken Workspace App"
    }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { status: string; error?: string; id: string };
      expect(value.id).toMatch(/^dep_failed_/);
      expect(value.status).toBe("failed");
      expect(value.error).toContain("index.html");
    }
  });

  it("creates a web_app artifact that appears in the artifact library", async () => {
    const distPath = path.join(workspacePath, "dist");
    fs.mkdirSync(distPath, { recursive: true });
    fs.writeFileSync(
      path.join(distPath, "index.html"),
      "<!doctype html><html><body>Workspace app<script src=\"assets/app.js\"></script></body></html>"
    );
    fs.mkdirSync(path.join(distPath, "assets"), { recursive: true });
    fs.writeFileSync(path.join(distPath, "assets", "app.js"), "window.workspaceApp = true;");

    const result = await toolRegistry.execute("deploy_workspace", {
      path: "dist",
      title: "Workspace App"
    }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as {
        artifactId: string;
        previewPath: string;
        sourceType: string;
        version: number;
      };
      const artifact = getArtifact(value.artifactId);

      expect(value.sourceType).toBe("workspace");
      expect(value.version).toBe(1);
      expect(artifact?.conversationId).toBe(conversationId);
      expect(artifact?.createdByAgentId).toBe("ag_mock_builder");
      expect(artifact?.type).toBe("web_app");
      expect(artifact?.title).toBe("Workspace App");
      expect(artifact?.content.type).toBe("web_app");
      if (artifact?.content.type === "web_app") {
        expect(artifact.content.files["index.html"]).toContain("Workspace app");
        expect(artifact.content.files["index.html"]).not.toContain("window.location.replace");
        expect(artifact.content.files["assets/app.js"]).toContain("workspaceApp");
        expect(artifact.content.deploymentPreviewPath).toBe(value.previewPath);
        expect(artifact.content.sourceType).toBe("workspace");
      }
    }
  });
});

describe("deploy_artifact", () => {
  it("returns a failed deployment record when the artifact does not exist", async () => {
    const result = await toolRegistry.execute("deploy_artifact", {
      artifactId: "art_missing"
    }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { status: string; error?: string; id: string };
      expect(value.id).toMatch(/^dep_failed_/);
      expect(value.status).toBe("failed");
      expect(value.error).toContain("not found");
    }
  });
});
