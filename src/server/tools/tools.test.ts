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

describe("the fs_* tools refuse a symlink out of the workspace", () => {
  // The lexical guard (resolveSafePath + startsWith) passes a symlink inside
  // the workspace that points anywhere, and the tools used it until a review
  // read /etc/passwd through one. The claim in the prompt is now backed by the
  // same realpath rule the file browser uses.
  it("does not read through a symlink to a file outside", async () => {
    const outside = path.join(tempDir, "outside-secret.txt");
    fs.writeFileSync(outside, "host secret");
    fs.symlinkSync(outside, path.join(workspacePath, "leak.txt"));

    const result = await toolRegistry.get("fs_read")!.handler({ path: "leak.txt" }, ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("escapes the workspace");
  });

  it("does not write through a symlink to a file outside", async () => {
    const outside = path.join(tempDir, "outside-victim.txt");
    fs.writeFileSync(outside, "original");
    fs.symlinkSync(outside, path.join(workspacePath, "escape.txt"));

    const result = await toolRegistry.get("fs_write")!.handler(
      { path: "escape.txt", content: "OVERWRITTEN BY AGENT" },
      ctx()
    );

    expect(result.ok).toBe(false);
    // The host file is untouched, not merely reported as an error.
    expect(fs.readFileSync(outside, "utf-8")).toBe("original");
  });

  it("does not create a file under a symlinked-out directory", async () => {
    const outsideDir = path.join(tempDir, "outside-dir");
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, path.join(workspacePath, "escape-dir"));

    const result = await toolRegistry.get("fs_write")!.handler(
      { path: "escape-dir/new.txt", content: "x" },
      ctx()
    );

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(outsideDir, "new.txt"))).toBe(false);
  });

  it("refuses a dangling symlink, which is where a write would land", async () => {
    // existsSync FOLLOWS the link, so a link whose target does not exist reads
    // as "not created yet" and the ancestor rule passes — while the write
    // creates the file wherever the link points.
    const outsideTarget = path.join(tempDir, "outside-created.txt");
    fs.symlinkSync(outsideTarget, path.join(workspacePath, "dangling.txt"));

    const result = await toolRegistry.get("fs_write")!.handler(
      { path: "dangling.txt", content: "ESCAPED" },
      ctx()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("dangling symlink");
    expect(fs.existsSync(outsideTarget)).toBe(false);
  });

  it("still allows a symlink that stays inside", async () => {
    fs.writeFileSync(path.join(workspacePath, "real.txt"), "inside");
    fs.symlinkSync(path.join(workspacePath, "real.txt"), path.join(workspacePath, "alias.txt"));

    const result = await toolRegistry.get("fs_read")!.handler({ path: "alias.txt" }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { content: string }).content).toContain("inside");
  });
});

describe("tool registry", () => {
  it("has all workspace tools registered", () => {
    const names = toolRegistry.listNames();
    expect(names).toContain("bash");
    expect(names).toContain("fs_list");
    expect(names).toContain("fs_mkdir");
    expect(names).toContain("fs_read");
    expect(names).toContain("fs_write");
    expect(names).toContain("fs_patch");
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

describe("fs_mkdir", () => {
  it("creates nested directories inside the workspace", async () => {
    const result = await toolRegistry.execute("fs_mkdir", { path: "nested/dir" }, ctx());
    expect(result.ok).toBe(true);
    expect(fs.statSync(path.join(workspacePath, "nested", "dir")).isDirectory()).toBe(true);
  });

  it("rejects paths outside the workspace", async () => {
    const result = await toolRegistry.execute("fs_mkdir", { path: "../../../outside" }, ctx());
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
  it("rejects rewriting an existing file with identical content", async () => {
    fs.writeFileSync(path.join(workspacePath, "unchanged.txt"), "same content");

    const result = await toolRegistry.execute(
      "fs_write",
      { path: "unchanged.txt", content: "same content" },
      ctx()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_OP_WRITE");
      expect(result.error).toContain("already has the requested content");
      expect(result.error).toContain("do not retry the same write");
    }
  });

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
    const escapedPath = path.resolve(workspacePath, "../../../etc/danger.txt");
    const result = await toolRegistry.execute(
      "fs_write",
      { path: "../../../etc/danger.txt", content: "x" },
      ctx()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("WORKSPACE_PATH_ESCAPE");
      expect(result.category).toBe("security_policy");
    }
    expect(fs.existsSync(escapedPath)).toBe(false);
  });
});

describe("fs_patch", () => {
  it("rejects a no-op replacement instead of reporting a false successful edit", async () => {
    fs.writeFileSync(path.join(workspacePath, "noop.ts"), "const value = 1;\n");

    const result = await toolRegistry.execute(
      "fs_patch",
      { path: "noop.ts", oldText: "const value = 1;", newText: "const value = 1;" },
      ctx()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_OP_PATCH");
      expect(result.error).toContain("identical");
    }
    expect(fs.readFileSync(path.join(workspacePath, "noop.ts"), "utf-8")).toBe("const value = 1;\n");
  });

  it("replaces one exact snippet without rewriting unrelated content", async () => {
    fs.writeFileSync(
      path.join(workspacePath, "component.ts"),
      "const color = \"blue\";\nconst untouched = true;\n"
    );

    const result = await toolRegistry.execute(
      "fs_patch",
      {
        path: "component.ts",
        oldText: "const color = \"blue\";",
        newText: "const color = \"green\";"
      },
      ctx()
    );

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspacePath, "component.ts"), "utf-8"))
      .toBe("const color = \"green\";\nconst untouched = true;\n");
    if (result.ok) {
      expect(result.value).toEqual(expect.objectContaining({
        path: "component.ts",
        replacements: 1,
        applied: "auto"
      }));
    }
    expect(getRunToolEvidence("run_test").fileWrites).toContainEqual({
      path: "component.ts",
      absolutePath: path.join(workspacePath, "component.ts"),
      action: "modified"
    });
  });

  it("rejects missing or ambiguous oldText", async () => {
    fs.writeFileSync(path.join(workspacePath, "repeated.ts"), "item\nitem\n");

    const missing = await toolRegistry.execute(
      "fs_patch",
      { path: "repeated.ts", oldText: "absent", newText: "value" },
      ctx()
    );
    const ambiguous = await toolRegistry.execute(
      "fs_patch",
      { path: "repeated.ts", oldText: "item", newText: "value" },
      ctx()
    );

    expect(missing.ok).toBe(false);
    expect(ambiguous.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("not found");
    if (!ambiguous.ok) expect(ambiguous.error).toContain("matched 2 locations");
    expect(fs.readFileSync(path.join(workspacePath, "repeated.ts"), "utf-8")).toBe("item\nitem\n");
  });

  it("supports intentional replaceAll", async () => {
    fs.writeFileSync(path.join(workspacePath, "tokens.css"), "red red red");

    const result = await toolRegistry.execute(
      "fs_patch",
      {
        path: "tokens.css",
        oldText: "red",
        newText: "blue",
        replaceAll: true
      },
      ctx()
    );

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspacePath, "tokens.css"), "utf-8")).toBe("blue blue blue");
    if (result.ok) {
      expect(result.value).toEqual(expect.objectContaining({ replacements: 3 }));
    }
  });

  it("rejects missing files and paths outside the workspace", async () => {
    const missing = await toolRegistry.execute(
      "fs_patch",
      { path: "missing.ts", oldText: "a", newText: "b" },
      ctx()
    );
    const outside = await toolRegistry.execute(
      "fs_patch",
      { path: "../../../outside.ts", oldText: "a", newText: "b" },
      ctx()
    );

    expect(missing.ok).toBe(false);
    expect(outside.ok).toBe(false);
  });
});

describe("bash", () => {
  it("runs arbitrary scripts instead of classifying them as non-verification", async () => {
    // Issue #79: bash is a general development tool. A script that is not a
    // build/test/lint command used to be rejected by the verification-only gate;
    // it now runs and reports its own exit code.
    const result = await toolRegistry.execute("bash", { command: "node -e \"console.log('arbitrary-ok')\"" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { output: string }).output).toContain("arbitrary-ok");
  }, 10000);

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

  it("rejects destructive workspace cleanup commands before approval", async () => {
    const command = process.platform === "win32"
      ? 'Remove-Item -Force "todo-app/src/App.css" -ErrorAction SilentlyContinue; if (Test-Path "todolist") { Remove-Item -Recurse -Force "todolist" }; if (Test-Path "todo-app/src/assets") { Remove-Item -Recurse -Force "todo-app/src/assets" }; Write-Host "Cleaned up."'
      : "rm -rf todo-app/src/assets";

    const result = await toolRegistry.execute("bash", { command }, ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("blocked");
    expect(getAllPendingBashCommands()).toHaveLength(0);
  });

  it("executes verification commands", async () => {
    fs.writeFileSync(
      path.join(workspacePath, "package.json"),
      JSON.stringify({ scripts: { build: "node -e \"console.log('build-ok')\"" } })
    );

    const cmd = "npm run build";
    const result = await toolRegistry.execute("bash", { command: cmd }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { exitCode: number; output: string };
      expect(value.exitCode).toBe(0);
      expect(value.output).toContain("build-ok");
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

  it("allows read-only dependency list verification", async () => {
    fs.writeFileSync(
      path.join(workspacePath, "package.json"),
      JSON.stringify({ name: "dependency-list-test", version: "1.0.0" })
    );

    const result = await toolRegistry.execute("bash", { command: "npm ls" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { exitCode: number }).exitCode).toBe(0);
    }
    expect(getAllPendingBashCommands()).toHaveLength(0);
  }, 10000);

  it("runs a script the workspace does not declare and lets npm report it", async () => {
    // Issue #79: `npm run <script>` is no longer checked against the nearest
    // package.json. It is an ordinary command now; npm's own error is the
    // feedback, not a platform policy error.
    fs.writeFileSync(
      path.join(workspacePath, "package.json"),
      JSON.stringify({ scripts: { build: "node -e \"console.log('ok')\"" } })
    );

    const result = await toolRegistry.execute("bash", { command: "npm run build-evil" }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { exitCode: number }).exitCode).not.toBe(0);
    expect(getAllPendingBashCommands()).toHaveLength(0);
  }, 10000);

  it("still accepts scripts the project declares, including suffixed names", async () => {
    fs.writeFileSync(
      path.join(workspacePath, "package.json"),
      JSON.stringify({ scripts: { "build:prod": "node -e \"console.log('prod-ok')\"" } })
    );

    const result = await toolRegistry.execute("bash", { command: "npm run build:prod" }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { output: string }).output).toContain("prod-ok");
    }
  }, 10000);

  it("runs a project script after changing into its directory", async () => {
    fs.mkdirSync(path.join(workspacePath, "app"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "app", "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"console.log('app-test-ok')\"" } })
    );

    const declared = await toolRegistry.execute("bash", { command: "cd app && npm run test" }, ctx());
    expect(declared.ok).toBe(true);
    if (declared.ok) expect((declared.value as { output: string }).output).toContain("app-test-ok");
  }, 20000);

  it("does not claim a script is undeclared when there is no package.json", async () => {
    // Nothing to enforce against, so the command must run and let npm's own
    // ENOENT be the feedback — not a policy error naming an undeclared script.
    const result = await toolRegistry.execute("bash", { command: "npm run build" }, ctx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { exitCode: number };
      expect(value.exitCode).not.toBe(0);
    }
  }, 20000);

  it("runs `npm run -w <dir>` without consulting a manifest", async () => {
    // Issue #79 removed the declared-script lookup, so whether npm finds a
    // configured workspace is npm's business, not the sandbox's.
    fs.writeFileSync(
      path.join(workspacePath, "package.json"),
      JSON.stringify({ scripts: { dev: "node -e \"console.log('dev')\"" } })
    );
    fs.mkdirSync(path.join(workspacePath, "web"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "web", "package.json"),
      JSON.stringify({ scripts: { build: "node -e \"console.log('web-build-ok')\"" } })
    );

    const result = await toolRegistry.execute("bash", { command: "npm run build -w web" }, ctx());

    expect(result.ok).toBe(true);
  }, 20000);

  it("allows shell inspection commands instead of requiring fs_list/fs_read", async () => {
    const cmd = process.platform === "win32" ? "Get-ChildItem" : "ls";
    const result = await toolRegistry.execute("bash", { command: cmd }, ctx());
    expect(result.ok).toBe(true);
  });

  it("rejects empty command", async () => {
    const result = await toolRegistry.execute("bash", { command: "" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("requires approval for dependency installation commands", async () => {
    const promise = toolRegistry.execute("bash", { command: "pnpm install" }, ctx());
    const pending = getAllPendingBashCommands();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.command).toBe("pnpm install");

    rejectPendingBash(pending[0]!.id);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("rejected");
    expect(getAllPendingBashCommands()).toHaveLength(0);
  });

  it("blocks pnpm dependency mutation in a workspace nested under the host project", async () => {
    const nestedWorkspace = path.join(process.cwd(), ".agentmeld-data", "workspaces", "conv_nested_test");
    const result = await toolRegistry.execute(
      "bash",
      { command: "pnpm install" },
      ctx({ workspacePath: nestedWorkspace })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Use npm install");
      expect(result.error).toContain("root node_modules");
    }
    expect(getAllPendingBashCommands()).toHaveLength(0);
  });

  it("allows source creation, in-place edits and redirects that the old policy rejected", async () => {
    // Benchmark regression (issue #79): a builder agent ran `mkdir` / `cat >` /
    // `sed -i` 18 times, every call was refused, and no source was written.
    // These are ordinary development commands now.
    const createCommand = process.platform === "win32"
      ? "New-Item -ItemType Directory -Force src | Out-Null; Set-Content -Path src/App.css -Value 'body { color: red; }'"
      : "mkdir -p src && cat > src/App.css <<'EOF'\nbody { color: red; }\nEOF";
    const createResult = await toolRegistry.execute("bash", { command: createCommand }, ctx());
    expect(createResult.ok, !createResult.ok ? createResult.error : "").toBe(true);
    expect(fs.readFileSync(path.join(workspacePath, "src", "App.css"), "utf-8")).toContain("color: red");

    const inPlaceCommand = process.platform === "win32"
      ? "(Get-Content src/App.css) -replace 'red', 'blue' | Set-Content src/App.css"
      : `sed -i${process.platform === "darwin" ? " ''" : ""} 's/red/blue/' src/App.css`;
    const editResult = await toolRegistry.execute("bash", { command: inPlaceCommand }, ctx());
    expect(editResult.ok, !editResult.ok ? editResult.error : "").toBe(true);
    expect(fs.readFileSync(path.join(workspacePath, "src", "App.css"), "utf-8")).toContain("blue");

    const redirectResult = await toolRegistry.execute("bash", { command: "node -e \"console.log('redirected')\" > build.log" }, ctx());
    expect(redirectResult.ok, !redirectResult.ok ? redirectResult.error : "").toBe(true);
    expect(fs.readFileSync(path.join(workspacePath, "build.log"), "utf-8")).toContain("redirected");
  }, 20000);
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

  it("requires a declared outputKey before creating a dispatched artifact", async () => {
    const taskContext = ctx({
      taskContract: {
        acceptanceCriteria: [],
        expectedOutputs: [{ outputKey: "prd", type: "document", required: true }]
      }
    });

    const missingKey = await toolRegistry.execute("write_artifact", {
      type: "document",
      title: "PRD",
      content: "# PRD"
    }, taskContext);
    expect(missingKey.ok).toBe(false);
    if (!missingKey.ok) expect(missingKey.error).toContain("outputKey is required");

    const wrongType = await toolRegistry.execute("write_artifact", {
      type: "web_app",
      title: "PRD",
      content: "<h1>PRD</h1>",
      outputKey: "prd"
    }, taskContext);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.error).toContain("does not match expected type");

    const valid = await toolRegistry.execute("write_artifact", {
      type: "document",
      title: "PRD",
      content: "# PRD",
      outputKey: "prd"
    }, taskContext);
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect((valid.value as { outputKey?: string }).outputKey).toBe("prd");
    }
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
    }, ctx({
      taskContract: {
        acceptanceCriteria: [],
        expectedOutputs: [{ outputKey: "web_app", type: "web_app", required: true }]
      }
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as {
        artifactId: string;
        previewPath: string;
        sourceType: string;
        version: number;
        outputKey?: string;
      };
      const artifact = getArtifact(value.artifactId);

      expect(value.sourceType).toBe("workspace");
      expect(value.outputKey).toBe("web_app");
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
