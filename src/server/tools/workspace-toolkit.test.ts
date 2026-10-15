import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fsReadTool } from "@/server/tools/fs-read";
import { fsGlobTool, fsSearchTool } from "@/server/tools/fs-search";
import { toolRegistry } from "@/server/tools/registry";
import { gitInspectTool } from "@/server/tools/git-inspect";
import { jobStartTool } from "@/server/tools/jobs";
import { startCommandJob, controlCommandJob, clearCommandJobsForTests, hasRunningJobs } from "@/server/tools/command-jobs";
import { EXTRACTOR_MAP, extractCommand } from "@/server/evidence/evidence-extractors";
import { safeWorkspacePath, toolProcessEnv } from "@/server/tools/workspace-access";
import type { ToolContext, ToolResult } from "@/server/tools/types";

let root: string;
let ctx: ToolContext;
function value(result: ToolResult): Record<string, unknown> { expect(result.ok, !result.ok ? result.error : "").toBe(true); if (!result.ok) throw new Error(result.error); return result.value as Record<string, unknown>; }
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-toolkit-"));
  ctx = { workspacePath: root, conversationId: "conv_toolkit", agentId: "ag_test", runId: "run_toolkit", abortSignal: new AbortController().signal };
});
afterEach(async () => { await clearCommandJobsForTests(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe("file discovery and paged reads", () => {
  it("finds files and literal matches without dependencies, ignored files or secrets", async () => {
    fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "src", "app.ts"), "first\nUnique.Token\nlast");
    fs.writeFileSync(path.join(root, "node_modules", "dep.ts"), "Unique.Token");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=Unique.Token");
    fs.writeFileSync(path.join(root, "ignored.ts"), "Unique.Token"); fs.writeFileSync(path.join(root, ".gitignore"), "ignored.ts\n");
    expect(value(await fsGlobTool.handler({ glob: "**/*.ts" }, ctx)).paths).toEqual(["src/app.ts"]);
    expect(value(await fsSearchTool.handler({ query: "unique.token" }, ctx)).matches).toEqual([{ path: "src/app.ts", line: 2, text: "Unique.Token" }]);
    expect(value(await fsSearchTool.handler({ query: "unique.token", caseSensitive: true }, ctx)).matches).toEqual([]);
  });
  it("bounds results, validates queries and rejects traversal/private paths", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "hit\nhit\nhit");
    const found = value(await fsSearchTool.handler({ query: "hit", limit: 2 }, ctx));
    expect(found.matches).toHaveLength(2); expect(found.truncated).toBe(true);
    for (const args of [{ query: "" }, { query: "x", path: ".." }, { query: "x", glob: "../*" }, { query: "x", limit: 201 }]) expect((await fsSearchTool.handler(args, ctx)).ok).toBe(false);
    fs.writeFileSync(path.join(root, ".env"), "private");
    expect((await fsReadTool.handler({ path: ".env" }, ctx)).ok).toBe(false);
  });
  it("preserves legacy raw text and returns accurate line/hash cursors", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "a\r\nb\r\nc\r\n");
    expect(value(await fsReadTool.handler({ path: "a.txt" }, ctx)).content).toBe("a\r\nb\r\nc\r\n");
    const page = value(await fsReadTool.handler({ path: "a.txt", startLine: 2, limit: 1, includeLineNumbers: true }, ctx));
    expect(page).toMatchObject({ content: "2: b\r", nextStartLine: 3, nextStartColumn: 1, totalLines: 4 }); expect(page.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await fsReadTool.handler({ path: "a.txt", startLine: 9 }, ctx)).ok).toBe(false);
  });
  it("continues a long single line without repeating or losing characters", async () => {
    const text = "x".repeat(120001); fs.writeFileSync(path.join(root, "long.txt"), text);
    let result = value(await fsReadTool.handler({ path: "long.txt" }, ctx)); let combined = String(result.content);
    while (result.hasMore) { result = value(await fsReadTool.handler({ path: "long.txt", startLine: result.nextStartLine, startColumn: result.nextStartColumn }, ctx)); combined += result.content; }
    expect(combined).toBe(text);
  });
  it("rejects realpath escapes via a directory link", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-outside-"));
    try { fs.writeFileSync(path.join(outside, "secret.txt"), "secret"); fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir"); expect(() => safeWorkspacePath(root, "escape/secret.txt")).toThrow(/escapes the workspace/); }
    finally { fs.rmSync(path.join(root, "escape"), { force: true, recursive: true }); fs.rmSync(outside, { force: true, recursive: true }); }
  });
  it("enforces admitted run permissions at registry execution, not just model schema", async () => {
    expect(await toolRegistry.execute("fs_glob", {}, { ...ctx, allowedToolNames: ["fs_read"] })).toMatchObject({ ok: false, code: "TOOL_PERMISSION_DENIED" });
  });
});

describe("run-owned background jobs", () => {
  function start(script: string, timeout = 5000) { return startCommandJob(process.execPath, ["-e", script], root, "npm run test", ctx, timeout); }
  it("collects terminal code and paginates logs", async () => {
    const job = start("process.stdout.write('x'.repeat(25000))"); expect(job.status).toBe("running"); expect(hasRunningJobs(ctx.runId)).toBe(true);
    const done = await controlCommandJob("wait", job.jobId, 0, 5000, ctx);
    expect(done).toMatchObject({ status: "completed", exitCode: 0, nextOffset: 10000, hasMoreOutput: true });
    expect((await controlCommandJob("read", job.jobId, 20000, 0, ctx)).output).toHaveLength(5000);
    expect(hasRunningJobs(ctx.runId)).toBe(false);
  });
  it("refuses cross-run/agent/conversation controls", async () => {
    const job = start("setTimeout(()=>{},5000)");
    for (const overrides of [{ runId: "other" }, { conversationId: "other" }, { agentId: "other" }, { workspacePath: path.dirname(root) }]) await expect(controlCommandJob("cancel", job.jobId, 0, 0, { ...ctx, ...overrides })).rejects.toThrow(/not found/);
    expect((await controlCommandJob("cancel", job.jobId, 0, 5000, ctx)).status).toBe("cancelled");
  });
  it("times out and cancels without inventing a successful exit code", async () => {
    const job = start("setTimeout(()=>{},10000)", 50);
    expect(await controlCommandJob("wait", job.jobId, 0, 5000, ctx)).toMatchObject({ status: "timed_out", exitCode: null, timedOut: true });
    const evidence = extractCommand(ctx, { command: "npm test" }, { ok: true, value: { exitCode: null, timedOut: true } }, 100);
    expect(evidence).toMatchObject({ status: "invalid", payload: { exitCode: null } });
  });
  it("aborts jobs, bounds concurrency and does not inherit API credentials", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "private-key"); expect(toolProcessEnv().DEEPSEEK_API_KEY).toBeUndefined(); expect(toolProcessEnv().NODE_ENV).toBeUndefined();
    const controller = new AbortController(); ctx.abortSignal = controller.signal;
    const one = start("setTimeout(()=>{},10000)"); start("setTimeout(()=>{},10000)");
    expect(() => start("process.exit(0)")).toThrow(/limit/); controller.abort();
    expect((await controlCommandJob("wait", one.jobId, 0, 5000, ctx)).status).toBe("cancelled");
  });
  it("shares the bash source-mutation policy and requires controls", async () => {
    expect(await jobStartTool.handler({ command: 'Set-Content app.ts "bad"' }, ctx)).toMatchObject({ ok: false, category: "security_policy" });
    expect(await jobStartTool.handler({ command: "npm run build" }, { ...ctx, allowedToolNames: ["job_start"] })).toMatchObject({ ok: false });
    expect(EXTRACTOR_MAP.job_start(ctx, {}, { ok: true, value: { status: "running", jobId: "job_test" } }, 0)).toMatchObject({ type: "job_status", status: "diagnostic" });
    start("setTimeout(()=>{},10000)");
    expect(await toolRegistry.execute("report_task_result", { status: "complete", summary: "done" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("still running") });
  });
  it("uses the declared build script through the actual approved command path", async () => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "node -e \"console.log('verified-build')\"" } }));
    const job = value(await jobStartTool.handler({ command: "npm run build" }, ctx));
    const done = await controlCommandJob("wait", String(job.jobId), 0, 10000, ctx);
    expect(done).toMatchObject({ exitCode: 0, status: "completed" }); expect(done.output).toContain("verified-build");
  }, 15000);
});

describe("read-only Git inspection", () => {
  it("rejects repository config includes before invoking Git", async () => {
    expect(spawnSync("git", ["init", root], { windowsHide: true }).status).toBe(0);
    for (const section of ["[include]", '[includeIf "gitdir:*"]', "[INCLUDE]"]) {
      fs.writeFileSync(path.join(root, ".git", "config"), `${section}\npath = ../private-config\n`);
      expect(await gitInspectTool.handler({ action: "status" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("config includes") });
    }
  });

  it("reads repository status/diff but cannot execute arbitrary actions", async () => {
    expect(spawnSync("git", ["init", root], { windowsHide: true }).status).toBe(0);
    fs.writeFileSync(path.join(root, "app.txt"), "new file");
    expect(value(await gitInspectTool.handler({ action: "status" }, ctx)).output).toContain("app.txt");
    expect((await gitInspectTool.handler({ action: "reset" }, ctx)).ok).toBe(false);
    expect((await gitInspectTool.handler({ action: "status", path: ".." }, ctx)).ok).toBe(false);
  });
  it("does not climb into a host repository or follow a .git file", async () => {
    expect(spawnSync("git", ["init", root], { windowsHide: true }).status).toBe(0); const nested = path.join(root, "workspace"); fs.mkdirSync(nested);
    expect((await gitInspectTool.handler({ action: "status" }, { ...ctx, workspacePath: nested })).ok).toBe(false);
    fs.writeFileSync(path.join(nested, ".git"), `gitdir: ${path.join(root, ".git")}`);
    expect((await gitInspectTool.handler({ action: "status" }, { ...ctx, workspacePath: nested })).ok).toBe(false);
  });
});
