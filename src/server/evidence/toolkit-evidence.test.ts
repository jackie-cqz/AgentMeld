import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@/server/tools/types";
const mocks = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock("@/server/repositories/evidence-repository", async original => ({ ...await original<typeof import("@/server/repositories/evidence-repository")>(), insertEvidence: mocks.insert }));
import { captureEvidence } from "@/server/evidence/evidence-collector";
const context: ToolContext = { conversationId: "c", agentId: "a", workspacePath: ".", runId: "r", abortSignal: new AbortController().signal,
  taskExecution: { conductorRunId: "parent", planId: "plan", planRevision: 0, taskId: "t1", attemptId: "attempt", attempt: 1, contextSnapshotId: "snapshot" } };
beforeEach(() => mocks.insert.mockClear());
describe("toolkit evidence semantics", () => {
  it("records background launch as diagnostic, completion as command proof", async () => {
    await captureEvidence({ toolName: "job_start", args: { command: "npm run build" }, result: { ok: true, value: { jobId: "job_1", status: "running" } }, context, durationMs: 1 });
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ type: "job_status", status: "diagnostic" });
    await captureEvidence({ toolName: "job_completion", args: { command: "npm run build" }, result: { ok: true, value: { exitCode: 0, output: "built" } }, context, durationMs: 30, callId: "job_1" });
    expect(mocks.insert.mock.calls[1][0]).toMatchObject({ type: "command_executed", status: "valid", sourceId: "job_1", attemptId: "attempt" });
  });
  it("does not turn cancelled/null command results into passing evidence", async () => {
    await captureEvidence({ toolName: "job_completion", args: { command: "npm test" }, result: { ok: true, value: { exitCode: null, status: "cancelled" } }, context, durationMs: 20 });
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ type: "test_executed", status: "invalid" });
    expect(JSON.parse(mocks.insert.mock.calls[0][0].payloadJson)).toMatchObject({ exitCode: null });
  });
  it("keeps external sources reported and failed browser checks invalid", async () => {
    await captureEvidence({ toolName: "web_fetch", args: { url: "https://example.com" }, result: { ok: true, value: { url: "https://example.com", contentHash: "source-hash", retrievedAt: 1 } }, context, durationMs: 20 });
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ type: "web_source_read", trustLevel: "reported", contentHash: "source-hash" });
    await captureEvidence({ toolName: "browser_check", args: {}, result: { ok: true, value: { passed: false, errors: ["broken"] } }, context, durationMs: 20 });
    expect(mocks.insert.mock.calls[1][0]).toMatchObject({ type: "browser_checked", status: "invalid" });
  });
  it("only counts a replied peer consultation as valid agent_consulted evidence", async () => {
    await captureEvidence({ toolName: "consult_agent", args: { requestKey: "codename", targetAgentId: "ag_designer" }, result: { ok: true, value: { id: "consult_1", status: "replied", answer: "MELLOW-7741" } }, context, durationMs: 20, callId: "call_consult" });
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ type: "agent_consulted", status: "valid", sourceId: "call_consult" });
    await captureEvidence({ toolName: "consult_agent", args: { requestKey: "codename", targetAgentId: "ag_designer" }, result: { ok: true, value: { id: "consult_2", status: "declined", answer: null } }, context, durationMs: 20 });
    expect(mocks.insert.mock.calls[1][0]).toMatchObject({ type: "agent_consulted", status: "invalid" });
  });
});
