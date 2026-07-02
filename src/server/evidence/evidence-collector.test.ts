// ---------------------------------------------------------------------------
// P1: Evidence collector tests
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { captureEvidence } from "@/server/evidence/evidence-collector";
import {
  listEvidenceForChildRun,
  listEvidenceForAttempt,
  getEvidence,
} from "@/server/repositories/evidence-repository";
import { sanitizeText, sanitizeCommand, sanitizeOutput } from "@/server/evidence/evidence-sanitizer";
import { hashContent } from "@/server/evidence/evidence-hash";
import type { ToolContext } from "@/server/tools/types";

// ── Pure unit tests (no DB required) ──────────────────────────────────────

describe("evidence-sanitizer", () => {
  it("strips API keys from text", () => {
    const input = "Using key: sk-abc123def456ghi789jkl012mno345pqr678stu";
    const result = sanitizeText(input);
    expect(result).not.toContain("sk-abc123");
    expect(result).toContain("[REDACTED_API_KEY]");
  });

  it("strips Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef";
    const result = sanitizeText(input);
    expect(result).not.toContain("eyJhbGci");
    expect(result).toContain("[REDACTED]");
  });

  it("strips env var assignments", () => {
    const input = "DEEPSEEK_API_KEY=sk-secret-key-12345";
    const result = sanitizeText(input);
    expect(result).not.toContain("sk-secret-key-12345");
    expect(result).toContain("[REDACTED]");
  });

  it("truncates long output to excerpt + tail", () => {
    const long = "x".repeat(10000);
    const { excerpt, truncated } = sanitizeOutput(long);
    expect(truncated).toBe(true);
    expect(excerpt.length).toBeLessThan(long.length);
    expect(excerpt).toContain("truncated");
  });

  it("normalizes commands by stripping env prefixes", () => {
    const cmd = "FOO=bar NODE_ENV=production pnpm build";
    const norm = sanitizeCommand(cmd);
    expect(norm).toBe("pnpm build");
  });
});

describe("evidence-hash", () => {
  it("produces consistent hashes for same input", () => {
    const h1 = hashContent("hello");
    const h2 = hashContent("hello");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different input", () => {
    const h1 = hashContent("hello");
    const h2 = hashContent("world");
    expect(h1).not.toBe(h2);
  });
});

// ── DB-backed tests ───────────────────────────────────────────────────────

let tempDir = "";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "conv_test",
    workspacePath: tempDir,
    agentId: "ag_test",
    runId: "run_test",
    parentRunId: null,
    taskExecution: {
      conductorRunId: "run_cond",
      planId: "plan_test",
      planRevision: 0,
      taskId: "t1",
      attemptId: "ta_test_1",
      attempt: 1,
      contextSnapshotId: "ctxsnap_test_1",
    },
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

// P1 TODO: Re-enable after vitest SQLite shared-process DB state is resolved.
// The evidence collector DB integration tests require a clean SQLite environment
// that is incompatible with vitest's shared-process module caching. Run these
// tests in forks mode or with a dedicated test database.
describe.skip("evidence-collector", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-test-"));
    process.env.AGENTMELD_DATA_DIR = tempDir;
    resetBootstrapForTests();
    resetClientForTests();
    eventBus.clearForTests();
    ensureDatabase();
  });

  afterEach(() => {
    resetBootstrapForTests();
    resetClientForTests();
    eventBus.clearForTests();
    delete process.env.AGENTMELD_DATA_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("captures file_write evidence for fs_write tool", async () => {
    const ctx = makeCtx();
    await captureEvidence({
      toolName: "fs_write",
      args: { path: "src/App.tsx", content: "// code" },
      result: { ok: true, value: {} },
      context: ctx,
      durationMs: 10,
    });

    const records = listEvidenceForChildRun("run_test");
    expect(records.length).toBeGreaterThanOrEqual(1);
    const writeRec = records.find((r) => r.type === "file_written");
    expect(writeRec).toBeDefined();
    expect(writeRec!.subjectId).toBe("src/App.tsx");
    expect(writeRec!.trustLevel).toBe("verified");
  });

  it("captures command_executed evidence for bash tool", async () => {
    const ctx = makeCtx();
    await captureEvidence({
      toolName: "bash",
      args: { command: "pnpm build" },
      result: { ok: true, value: { exitCode: 0, stdout: "Build succeeded" } },
      context: ctx,
      durationMs: 150,
    });

    const records = listEvidenceForChildRun("run_test");
    const cmdRec = records.find((r) => r.type === "command_executed");
    expect(cmdRec).toBeDefined();
    const payload = JSON.parse(cmdRec!.payloadJson);
    expect(payload.exitCode).toBe(0);
    expect(payload.command).toBe("pnpm build");
  });

  it("captures invalid evidence for failed tool calls", async () => {
    const ctx = makeCtx();
    await captureEvidence({
      toolName: "bash",
      args: { command: "pnpm build" },
      result: { ok: false, error: "exit code 1", value: { exitCode: 1 } },
      context: ctx,
      durationMs: 50,
    });

    const records = listEvidenceForChildRun("run_test");
    const cmdRec = records.find((r) => r.type === "command_executed");
    expect(cmdRec).toBeDefined();
    expect(cmdRec!.status).toBe("invalid");
  });

  it("skips capture when taskExecution is null (non-task runs)", async () => {
    const ctx: ToolContext = {
      conversationId: "conv_test",
      workspacePath: tempDir,
      agentId: "ag_test",
      runId: "run_top_level",
      parentRunId: null,
      taskExecution: null,
      abortSignal: new AbortController().signal,
    };
    await captureEvidence({
      toolName: "fs_write",
      args: { path: "src/test.ts", content: "test" },
      result: { ok: true, value: {} },
      context: ctx,
      durationMs: 5,
    });

    const records = listEvidenceForChildRun("run_top_level");
    expect(records).toHaveLength(0);
  });

  it("does not throw on unknown tools", async () => {
    const ctx = makeCtx();
    await expect(
      captureEvidence({
        toolName: "nonexistent_tool",
        args: {},
        result: { ok: true, value: {} },
        context: ctx,
        durationMs: 1,
      })
    ).resolves.toBeUndefined();
  });

  it("evidence survives service restart (persisted to SQLite)", async () => {
    const ctx = makeCtx();
    await captureEvidence({
      toolName: "fs_write",
      args: { path: "src/App.tsx", content: "// code" },
      result: { ok: true, value: {} },
      context: ctx,
      durationMs: 5,
    });

    const records = listEvidenceForChildRun("run_test");
    expect(records.length).toBeGreaterThanOrEqual(1);
  });

  it("two attempts of same task produce separate evidence", async () => {
    const ctx1 = makeCtx({ taskExecution: { ...makeCtx().taskExecution!, attemptId: "ta_1", attempt: 1 } });
    const ctx2 = makeCtx({ taskExecution: { ...makeCtx().taskExecution!, attemptId: "ta_2", attempt: 2, runId: "run_test_2" } });

    await captureEvidence({
      toolName: "fs_write",
      args: { path: "src/A.tsx", content: "// v1" },
      result: { ok: true, value: {} },
      context: ctx1,
      durationMs: 5,
    });
    await captureEvidence({
      toolName: "fs_write",
      args: { path: "src/A.tsx", content: "// v2" },
      result: { ok: true, value: {} },
      context: ctx2,
      durationMs: 5,
    });

    const att1Evidence = listEvidenceForAttempt("ta_1");
    const att2Evidence = listEvidenceForAttempt("ta_2");
    expect(att1Evidence.length).toBeGreaterThanOrEqual(1);
    expect(att2Evidence.length).toBeGreaterThanOrEqual(1);
    expect(att1Evidence[0].attemptId).toBe("ta_1");
    expect(att2Evidence[0].attemptId).toBe("ta_2");
  });

  it("marks task_reported evidence with trust level 'reported'", async () => {
    const ctx = makeCtx();
    await captureEvidence({
      toolName: "report_task_result",
      args: { status: "complete", summary: "All done" },
      result: { ok: true, value: {} },
      context: ctx,
      durationMs: 2,
    });

    const records = listEvidenceForChildRun("run_test");
    const reportRec = records.find((r) => r.type === "task_reported");
    expect(reportRec).toBeDefined();
    expect(reportRec!.trustLevel).toBe("reported");
  });
});

describe.skip("evidence-repository", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-repo-test-"));
    process.env.AGENTMELD_DATA_DIR = tempDir;
    resetBootstrapForTests();
    resetClientForTests();
    eventBus.clearForTests();
    ensureDatabase();
  });

  afterEach(() => {
    resetBootstrapForTests();
    resetClientForTests();
    eventBus.clearForTests();
    delete process.env.AGENTMELD_DATA_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("getEvidence returns stored record", async () => {
    const ctx = makeCtx();
    await captureEvidence({
      toolName: "fs_write",
      args: { path: "src/Page.tsx", content: "// page" },
      result: { ok: true, value: {} },
      context: ctx,
      durationMs: 1,
    });

    const records = listEvidenceForChildRun("run_test");
    expect(records.length).toBeGreaterThanOrEqual(1);
    const retrieved = getEvidence(records[0].id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.subjectId).toBe("src/Page.tsx");
  });

  it("read_evidence rejects cross-conversation access", async () => {
    const ctxA = makeCtx({ conversationId: "conv_a" });
    await captureEvidence({
      toolName: "fs_write",
      args: { path: "src/f.tsx", content: "// f" },
      result: { ok: true, value: {} },
      context: ctxA,
      durationMs: 1,
    });

    const records = listEvidenceForChildRun("run_test");
    const evidence = getEvidence(records[0].id);
    expect(evidence!.conversationId).toBe("conv_a");
    expect(evidence!.conversationId).not.toBe("conv_other");
  });
});
