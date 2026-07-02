// ---------------------------------------------------------------------------
// P1: Evidence collector tests
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ToolContext } from "@/server/tools/types";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockInsertEvidence = vi.fn();
const mockListForRun = vi.fn((_arg?: unknown) => []);
const mockListForAttempt = vi.fn((_arg?: unknown) => []);
const mockGetEvidence = vi.fn((_arg?: unknown) => undefined);

vi.mock("@/server/repositories/evidence-repository", () => ({
  insertEvidence: (arg: unknown) => mockInsertEvidence(arg),
  listEvidenceForChildRun: (arg: unknown) => mockListForRun(arg),
  listEvidenceForAttempt: (arg: unknown) => mockListForAttempt(arg),
  getEvidence: (arg: unknown) => mockGetEvidence(arg),
  // re-export types for dependent imports
}));

vi.mock("@/shared/ids", () => ({
  newEvidenceId: vi.fn(() => `ev_mock_${Math.random().toString(36).slice(2, 10)}`),
  newTaskAttemptId: vi.fn(() => "ta_mock"),
  newContextSnapshotId: vi.fn(() => "ctxsnap_mock"),
  newRunId: vi.fn(() => "run_mock"),
  newMessageId: vi.fn(() => "msg_mock"),
  newAgentId: vi.fn(() => "ag_mock"),
  newConversationId: vi.fn(() => "conv_mock"),
  newArtifactId: vi.fn(() => "art_mock"),
  newWorkspaceId: vi.fn(() => "ws_mock"),
  newAttachmentId: vi.fn(() => "att_mock"),
  newToolCallId: vi.fn(() => "call_mock"),
  newContextSummaryId: vi.fn(() => "ctx_mock"),
  newErrorMessageId: vi.fn(() => "msg_err_mock"),
}));

// Import after mocks are set up
import { captureEvidence } from "@/server/evidence/evidence-collector";
import { sanitizeText, sanitizeCommand, sanitizeOutput } from "@/server/evidence/evidence-sanitizer";
import { hashContent } from "@/server/evidence/evidence-hash";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "conv_test",
    workspacePath: "/tmp/test",
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

beforeEach(() => {
  mockInsertEvidence.mockClear();
  mockListForRun.mockClear();
  mockListForAttempt.mockClear();
  mockGetEvidence.mockClear();
  mockListForRun.mockReturnValue([]);
  mockListForAttempt.mockReturnValue([]);
});

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

// ── Evidence collector unit tests (mocked DB) ─────────────────────────────

describe("evidence-collector", () => {
  beforeEach(() => {
    mockInsertEvidence.mockClear();
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

    expect(mockInsertEvidence).toHaveBeenCalledTimes(1);
    const record = mockInsertEvidence.mock.calls[0][0];
    expect(record.type).toBe("file_written");
    expect(record.subjectId).toBe("src/App.tsx");
    expect(record.trustLevel).toBe("verified");
    expect(record.attemptId).toBe("ta_test_1");
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

    expect(mockInsertEvidence).toHaveBeenCalledTimes(1);
    const record = mockInsertEvidence.mock.calls[0][0];
    expect(record.type).toBe("command_executed");
    const payload = JSON.parse(record.payloadJson);
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

    expect(mockInsertEvidence).toHaveBeenCalledTimes(1);
    const record = mockInsertEvidence.mock.calls[0][0];
    expect(record.type).toBe("command_executed");
    expect(record.status).toBe("invalid");
  });

  it("skips capture when taskExecution is null (non-task runs)", async () => {
    const ctx: ToolContext = {
      conversationId: "conv_test",
      workspacePath: "/tmp/test",
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

    expect(mockInsertEvidence).not.toHaveBeenCalled();
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
    expect(mockInsertEvidence).not.toHaveBeenCalled();
  });

  it("two attempts of same task produce separate evidence with different attemptId", async () => {
    const ctx1 = makeCtx({ taskExecution: { ...makeCtx().taskExecution!, attemptId: "ta_1", attempt: 1 } });
    const ctx2 = makeCtx({ runId: "run_test_2", taskExecution: { ...makeCtx().taskExecution!, attemptId: "ta_2", attempt: 2 } });

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

    expect(mockInsertEvidence).toHaveBeenCalledTimes(2);
    expect(mockInsertEvidence.mock.calls[0][0].attemptId).toBe("ta_1");
    expect(mockInsertEvidence.mock.calls[1][0].attemptId).toBe("ta_2");
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

    expect(mockInsertEvidence).toHaveBeenCalledTimes(1);
    const record = mockInsertEvidence.mock.calls[0][0];
    expect(record.type).toBe("task_reported");
    expect(record.trustLevel).toBe("reported");
  });

  it("captures artifact_created with outputKey and artifactId", async () => {
    const ctx = makeCtx();
    await captureEvidence({
      toolName: "write_artifact",
      args: { type: "document", outputKey: "prd" },
      result: { ok: true, value: { artifactId: "art_prd_123" } },
      context: ctx,
      durationMs: 30,
    });

    expect(mockInsertEvidence).toHaveBeenCalledTimes(1);
    const record = mockInsertEvidence.mock.calls[0][0];
    expect(record.type).toBe("artifact_created");
    const payload = JSON.parse(record.payloadJson);
    expect(payload.outputKey).toBe("prd");
    expect(payload.artifactId).toBe("art_prd_123");
  });

  it("evidence insert failure does not throw (fire-and-forget)", async () => {
    mockInsertEvidence.mockImplementationOnce(() => { throw new Error("DB down"); });
    const ctx = makeCtx();

    // Must not throw
    await expect(
      captureEvidence({
        toolName: "fs_write",
        args: { path: "src/ok.ts", content: "ok" },
        result: { ok: true, value: {} },
        context: ctx,
        durationMs: 1,
      })
    ).resolves.toBeUndefined();
  });
});
