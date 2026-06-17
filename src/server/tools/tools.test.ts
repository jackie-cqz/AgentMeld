import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDataDir, resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createConversation } from "@/server/conversation-service";
import { toolRegistry } from "@/server/tools/registry";
import type { ToolContext } from "@/server/tools/types";
import { clearPendingWritesForTests } from "@/server/pending-writes";
import { clearPendingBashForTests } from "@/server/pending-bash";

let tempDir: string;
let workspacePath: string;
let conversationId: string;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-tools-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  workspacePath = path.join(getDataDir(), "workspaces", "conv_tools_test");
  fs.mkdirSync(workspacePath, { recursive: true });

  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
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
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  eventBus.clearForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    conversationId,
    workspacePath,
    agentId: "ag_mock_builder",
    runId: "run_test",
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
});

describe("read_artifact", () => {
  it("returns error for non-existent artifact", async () => {
    const result = await toolRegistry.execute("read_artifact", { artifactId: "art_nonexistent" }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("write_artifact", () => {
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
