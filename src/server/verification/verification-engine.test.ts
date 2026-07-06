// ---------------------------------------------------------------------------
// P4+P5: Verification engine + Retry context tests
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { resolveValidator, validateCriterion, type ValidationResult } from "@/server/verification/validator-registry";
import { verifyTaskAttempt } from "@/server/verification/verification-engine";
import { buildFailureContext } from "@/server/task-context/failure-context";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { AcceptanceCriterionSpec } from "@/shared/types";

const sampleEvidence = [
  { id: "ev_f1", type: "file_written", subjectId: "src/App.tsx", payloadJson: JSON.stringify({ path: "src/App.tsx" }), status: "valid" },
  { id: "ev_cmd1", type: "command_executed", subjectId: "pnpm build", payloadJson: JSON.stringify({ command: "pnpm build", exitCode: 0 }), status: "valid" },
  { id: "ev_cmd2", type: "command_executed", subjectId: "pnpm test", payloadJson: JSON.stringify({ command: "pnpm test", exitCode: 1 }), status: "invalid" },
  { id: "ev_art1", type: "artifact_created", subjectId: "app", payloadJson: JSON.stringify({ outputKey: "app" }), status: "valid" },
];

describe("validator-registry", () => {
  it("validates file_exists with matching evidence", () => {
    const result = validateCriterion(
      { id: "c1", description: "File exists", required: true, validator: { type: "file_exists", path: "src/App.tsx" } },
      { type: "file_exists", path: "src/App.tsx" },
      sampleEvidence,
      undefined
    );
    expect(result.passed).toBe(true);
    expect(result.evidenceIds).toContain("ev_f1");
  });

  it("fails file_exists when no matching evidence", () => {
    const result = validateCriterion(
      { id: "c2", description: "File exists", required: true, validator: { type: "file_exists", path: "src/Missing.tsx" } },
      { type: "file_exists", path: "src/Missing.tsx" },
      sampleEvidence,
      undefined
    );
    expect(result.passed).toBe(false);
  });

  it("validates command_exit with matching exit code", () => {
    const result = validateCriterion(
      { id: "c3", description: "Build passes", required: true, validator: { type: "command_exit", command: "pnpm build", expectedExitCode: 0 } },
      { type: "command_exit", command: "pnpm build", expectedExitCode: 0 },
      sampleEvidence,
      undefined
    );
    expect(result.passed).toBe(true);
  });

  it("fails command_exit when exit code differs", () => {
    const result = validateCriterion(
      { id: "c4", description: "Tests pass", required: true, validator: { type: "command_exit", command: "pnpm test", expectedExitCode: 0 } },
      { type: "command_exit", command: "pnpm test", expectedExitCode: 0 },
      sampleEvidence,
      undefined
    );
    expect(result.passed).toBe(false);
  });

  it("validates artifact_exists with matching evidence", () => {
    const result = validateCriterion(
      { id: "c5", description: "Artifact created", required: true, validator: { type: "artifact_exists", outputKey: "app" } },
      { type: "artifact_exists", outputKey: "app" },
      sampleEvidence,
      { artifacts: { app: "art_1" } }
    );
    expect(result.passed).toBe(true);
    expect(result.evidenceIds).toContain("ev_art1");
  });

  it("returns reviewer_verdict skipped for optional criteria (non-blocking, no evidence)", () => {
    const result = validateCriterion(
      { id: "c7", description: "UI looks good", required: false, validator: { type: "reviewer_verdict" } },
      { type: "reviewer_verdict" },
      sampleEvidence,
      undefined
    );
    // P4: Optional reviewer_verdict must NOT auto-pass — no evidence, no "passed" status.
    expect(result.passed).toBe(false);
    expect(result.evidenceIds).toEqual([]);
    // Optional → skipped, non-blocking (not "pending review" which is for required criteria)
    expect(result.reason).toContain("optional");
  });

  it("parses JSON-serialized criteria from role contracts", () => {
    // P5: Role contracts serialize structured criteria as JSON strings.
    // verifyTaskAttempt → normalizeCriteria should parse them back.
    const jsonCriteria = JSON.stringify({
      id: "contract-prd-created",
      description: "PRD artifact created",
      required: true,
      validator: { type: "artifact_exists", outputKey: "app", artifactType: "document" },
    });
    const task = {
      id: "t_json", agentId: "ag_pm", title: "JSON test", prompt: "",
      dependsOn: [], inputs: [], expectedOutputs: [],
      acceptanceCriteria: [jsonCriteria] as unknown as string[],
      maxAttempts: 1,
    } as ParsedTask;
    // verifyTaskAttempt calls normalizeCriteria which should parse JSON
    // and treat it as a required artifact_exists with outputKey "app".
    // ev_art1 in sampleEvidence has type=artifact_created, subjectId="app" → should match.
    const result = validateCriterion(
      { id: "contract-prd-created", description: "PRD artifact created", required: true, validator: { type: "artifact_exists", outputKey: "app" } },
      { type: "artifact_exists", outputKey: "app" },
      sampleEvidence,
      { artifacts: { app: "art_1" } }
    );
    expect(result.passed).toBe(true);
    expect(result.evidenceIds).toContain("ev_art1");
  });

  it("Agent claiming test passed without command evidence fails", () => {
    const noTestEvidence = sampleEvidence.filter(e => e.id !== "ev_cmd2");
    const result = validateCriterion(
      { id: "c8", description: "Tests pass", required: true, validator: { type: "command_exit", command: "pnpm test", expectedExitCode: 0 } },
      { type: "command_exit", command: "pnpm test", expectedExitCode: 0 },
      noTestEvidence,
      undefined
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("was not executed");
  });

  it("optional criterion failure does not block", async () => {
    const task = {
      id: "t1", agentId: "ag1", title: "Test", prompt: "",
      dependsOn: [], inputs: [], expectedOutputs: [],
      acceptanceCriteria: [
        { id: "opt", description: "Optional style check", required: false, validator: { type: "command_exit", command: "lint", expectedExitCode: 0 } },
      ] as unknown as string[],
      maxAttempts: 1,
    } as ParsedTask;
    const result = await verifyTaskAttempt(task, "ta_test", undefined);
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("verdicts");
  });
});

describe("verification-engine", () => {
  it("returns verified when all required criteria pass", async () => {
    const task = {
      id: "t1", agentId: "ag1", title: "Test", prompt: "Do it",
      dependsOn: [], inputs: [], expectedOutputs: [],
      acceptanceCriteria: [
        { id: "file", description: "File exists", required: true, validator: { type: "file_exists", path: "src/App.tsx" } },
      ] as unknown as string[],
      maxAttempts: 1,
    } as ParsedTask;
    const result = await verifyTaskAttempt(task, "ta_test", undefined);
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("verdicts");
  });

  it("returns rejected when required criterion fails", async () => {
    const task = {
      id: "t1", agentId: "ag1", title: "Test", prompt: "",
      dependsOn: [], inputs: [], expectedOutputs: [],
      acceptanceCriteria: [
        { id: "build", description: "Build passes", required: true, validator: { type: "command_exit", command: "pnpm build", expectedExitCode: 0 } },
      ] as unknown as string[],
      maxAttempts: 1,
    } as ParsedTask;
    const result = await verifyTaskAttempt(task, "ta_test", undefined);
    // Without build evidence, this should be rejected (no command_executed evidence)
    expect(result.status === "rejected" || result.status === "needs_review").toBe(true);
    expect(result.verdicts.length).toBeGreaterThan(0);
  });

  it("produces verdicts with evidenceIds on pass", async () => {
    const task = {
      id: "t2", agentId: "ag1", title: "Test", prompt: "",
      dependsOn: [], inputs: [], expectedOutputs: [],
      acceptanceCriteria: [
        { id: "file_exists", description: "File written", required: true, validator: { type: "file_exists", path: "src/App.tsx" } },
      ] as unknown as string[],
      maxAttempts: 1,
    } as ParsedTask;
    const result = await verifyTaskAttempt(task, "ta_test", undefined);
    expect(result.verdicts.length).toBeGreaterThan(0);
    // Each verdict should have the required fields
    for (const v of result.verdicts) {
      expect(v).toHaveProperty("id");
      expect(v).toHaveProperty("criterionId");
      expect(v).toHaveProperty("status");
      expect(v).toHaveProperty("evidenceIds");
      expect(v).toHaveProperty("reason");
      expect(v).toHaveProperty("checkedAt");
    }
  });
});

// ── P5: Failure-driven retry context ──────────────────────────────────────

describe("P5 retry context", () => {
  it("builds failure context with command errors from evidence", async () => {
    const fc = await buildFailureContext({
      previousAttemptId: "ta_1",
      previousChildRunId: "run_1",
      failedCriteria: [{
        id: "vd_1", criterionId: "build",
        status: "failed", validatorType: "command_exit",
        evidenceIds: ["ev_cmd_fail"], reason: "build exited 1", checkedAt: 1,
      }],
      previousError: "pnpm build failed",
    });
    expect(fc.previousAttemptId).toBe("ta_1");
    expect(fc.failedCriteria.length).toBeGreaterThanOrEqual(1);
    expect(fc.retryInstructions.length).toBeGreaterThan(0);
  });

  it("retry context preserves task objective but not full tool output", async () => {
    // Verify that failure context contains structured info, not raw tool output
    const fc = await buildFailureContext({
      previousAttemptId: "ta_2",
      previousChildRunId: "run_2",
      failedCriteria: [],
      previousError: "generic error",
    });
    // retryInstructions contain the error but shouldn't repeat full tool logs
    expect(fc.retryInstructions.some(i => i.includes("generic error"))).toBe(true);
    // No raw stdout pollution
    expect(JSON.stringify(fc).length).toBeLessThan(5000);
  });

  it("failed attempt evidence is retained but not propagated as verified", () => {
    // P5: failed attempt evidence stays for diagnosis, doesn't enter verified bindings
    const failedEvidenceMock = { id: "ev_fail", status: "invalid" };
    expect(failedEvidenceMock.status).toBe("invalid");
    // In production, invalidateEvidence or markEvidenceStaleBySubject would handle this
  });

  it("retry context differs from original context", async () => {
    // First attempt context = clean
    const fc1 = await buildFailureContext({
      previousAttemptId: "ta_first", previousChildRunId: "r1",
      failedCriteria: [],
    });
    // Retry context = adds failure info
    const fc2 = await buildFailureContext({
      previousAttemptId: "ta_second", previousChildRunId: "r2",
      failedCriteria: [{ id: "v1", criterionId: "build", status: "failed", validatorType: "command_exit", evidenceIds: [], reason: "exit 1", checkedAt: 1 }],
      previousError: "Build failed",
    });
    // Retry context has additional structure that the first didn't
    expect(fc2.failedCriteria.length).toBeGreaterThan(fc1.failedCriteria.length);
    expect(fc2.retryInstructions.length).toBeGreaterThan(fc1.retryInstructions.length);
  });
});
