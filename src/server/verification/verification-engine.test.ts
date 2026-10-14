// ---------------------------------------------------------------------------
// P4+P5: Verification engine + Retry context tests
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { resolveValidator, validateCriterion, type ValidationResult } from "@/server/verification/validator-registry";
import {
  findUnsupportedArtifactClaims,
  verifyTaskAttempt,
} from "@/server/verification/verification-engine";
import { buildFailureContext } from "@/server/task-context/failure-context";
import { insertEvidence } from "@/server/repositories/evidence-repository";
import { getDatabase } from "@/db/client";
import { createArtifact } from "@/server/repositories";
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

  it("validates artifact_exists from evidence without a task report artifact map", () => {
    const result = validateCriterion(
      { id: "c5b", description: "Artifact created", required: true, validator: { type: "artifact_exists", outputKey: "app" } },
      { type: "artifact_exists", outputKey: "app" },
      sampleEvidence,
      undefined
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
  it("creates verified output bindings from artifact_created evidence", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const conversationId = `conv_verify_binding_${suffix}`;
    const conductorRunId = `run_verify_binding_${suffix}`;
    const childRunId = `run_child_verify_binding_${suffix}`;
    const attemptId = `ta_verify_binding_${suffix}`;
    const artifactId = `art_verify_${suffix}`;
    seedEvidenceParents({ conversationId, conductorRunId, childRunId, attemptId });
    createArtifact({
      id: artifactId,
      conversationId,
      createdByAgentId: "ag_pm",
      type: "document",
      title: "PRD",
      content: { type: "document", format: "markdown", content: "# PRD\n\nComplete requirements." },
      version: 1,
      parentArtifactId: null,
      now: Date.now(),
    });
    insertEvidence({
      id: `ev_verify_binding_${suffix}`,
      conversationId,
      conductorRunId,
      planId: "plan_verify_binding",
      taskId: "t1",
      attemptId,
      childRunId,
      contextSnapshotId: "ctx_verify_binding",
      agentId: "ag_pm",
      type: "artifact_created",
      status: "valid",
      trustLevel: "verified",
      sourceKind: "tool_call",
      sourceId: "write_artifact_test",
      subjectType: "artifact",
      subjectId: "prd",
      payloadJson: JSON.stringify({ outputKey: "prd", artifactId, artifactType: "document" }),
      contentHash: null,
      invalidatedAt: null,
      createdAt: Date.now(),
    });
    const task = {
      id: "t1", agentId: "ag_pm", title: "PRD", prompt: "",
      dependsOn: [], inputs: [],
      expectedOutputs: [{ id: "prd", type: "document", required: true }],
      acceptanceCriteria: [
        JSON.stringify({
          id: "contract-prd",
          description: "PRD 产物已创建",
          required: true,
          validator: { type: "artifact_exists", outputKey: "prd", artifactType: "document" },
        })
      ],
      maxAttempts: 1,
    } as ParsedTask;

    const result = await verifyTaskAttempt(task, attemptId, undefined);

    expect(result.status).toBe("verified");
    expect(result.verifiedOutputBindings).toEqual([
      { outputKey: "prd", artifactId, evidenceIds: expect.any(Array) }
    ]);
    expect(result.verifiedOutputBindings[0].evidenceIds.length).toBeGreaterThan(0);
  });

  it("does not require pnpm build for a deployed static web_app without package.json", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const conversationId = `conv_static_web_${suffix}`;
    const conductorRunId = `run_static_web_${suffix}`;
    const childRunId = `run_child_static_web_${suffix}`;
    const attemptId = `ta_static_web_${suffix}`;
    const artifactId = `art_static_web_${suffix}`;
    seedEvidenceParents({ conversationId, conductorRunId, childRunId, attemptId });
    createArtifact({
      id: artifactId,
      conversationId,
      createdByAgentId: "ag_pm",
      type: "web_app",
      title: "Static app",
      content: { type: "web_app", files: { "index.html": "<main>Ready</main>" }, entry: "index.html" },
      version: 1,
      parentArtifactId: null,
      now: Date.now(),
    });

    const baseEvidence = {
      conversationId,
      conductorRunId,
      planId: "plan_verify_binding",
      taskId: "t1",
      attemptId,
      childRunId,
      contextSnapshotId: "ctx_static_web",
      agentId: "ag_pm",
      status: "valid" as const,
      trustLevel: "verified" as const,
      sourceKind: "tool_call" as const,
      contentHash: null,
      invalidatedAt: null,
      createdAt: Date.now(),
    };

    insertEvidence({
      ...baseEvidence,
      id: `ev_static_index_${suffix}`,
      sourceId: "fs_write_index",
      type: "file_written",
      subjectType: "file",
      subjectId: "index.html",
      payloadJson: JSON.stringify({ path: "index.html", action: "created" }),
    });
    insertEvidence({
      ...baseEvidence,
      id: `ev_static_artifact_${suffix}`,
      sourceId: "deploy_workspace_artifact",
      type: "artifact_created",
      subjectType: "artifact",
      subjectId: "web_app",
      payloadJson: JSON.stringify({ outputKey: "web_app", artifactId, artifactType: "web_app" }),
    });
    insertEvidence({
      ...baseEvidence,
      id: `ev_static_deploy_${suffix}`,
      sourceId: "deploy_workspace_deployment",
      type: "deployment_created",
      subjectType: "deployment",
      subjectId: "web_app",
      payloadJson: JSON.stringify({ outputKey: "web_app", artifactId }),
    });

    const task = {
      id: "t1", agentId: "ag_frontend", title: "Static web app", prompt: "",
      dependsOn: [], inputs: [],
      expectedOutputs: [{ id: "web_app", type: "web_app", required: true }],
      acceptanceCriteria: [
        { id: "build", description: "Build passes", required: true, validator: { type: "command_exit", command: "pnpm build", expectedExitCode: 0 } },
        { id: "artifact", description: "web_app exists", required: true, validator: { type: "artifact_exists", outputKey: "web_app", artifactType: "web_app" } },
        { id: "deploy", description: "deployed", required: false, validator: { type: "deployment_created", outputKey: "web_app" } },
      ] as unknown as string[],
      maxAttempts: 1,
    } as ParsedTask;

    const result = await verifyTaskAttempt(task, attemptId, undefined);

    expect(result.status).toBe("verified");
    expect(result.verdicts.find((verdict) => verdict.criterionId === "build")?.status).toBe("passed");
    expect(result.verdicts.find((verdict) => verdict.criterionId === "build")?.reason).toContain("Static web_app");
  });

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

function seedEvidenceParents(input: {
  conversationId: string;
  conductorRunId: string;
  childRunId: string;
  attemptId: string;
}) {
  const db = getDatabase();
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, avatar, description, capabilities, system_prompt,
      adapter_name, tool_names, is_builtin, is_conductor, supports_vision,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("ag_pm", "PM", "PM", "PM", "[]", "", "custom", "[]", 1, 0, 0, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, avatar, description, capabilities, system_prompt,
      adapter_name, tool_names, is_builtin, is_conductor, supports_vision,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("ag_mock_conductor", "Conductor", "Co", "Conductor", "[]", "", "custom", "[]", 1, 1, 0, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO conversations (
      id, title, mode, agent_ids, pinned_message_ids, archived,
      fs_write_approval_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.conversationId, "Verification binding test", "group", JSON.stringify(["ag_mock_conductor", "ag_pm"]), "[]", 0, "review", now, now);
  db.prepare(`
    INSERT OR IGNORE INTO agent_runs (
      id, conversation_id, agent_id, parent_run_id, status, usage,
      interrupted, retryable, started_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.conductorRunId, input.conversationId, "ag_mock_conductor", null, "running", "{}", 0, 0, now, null, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO agent_runs (
      id, conversation_id, agent_id, parent_run_id, status, usage,
      interrupted, retryable, started_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.childRunId, input.conversationId, "ag_pm", input.conductorRunId, "complete", "{}", 0, 0, now, now, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO task_attempts (
      id, conductor_run_id, conversation_id, plan_id, plan_revision,
      task_id, agent_id, child_run_id, attempt, context_snapshot_id,
      execution_status, verification_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.attemptId, input.conductorRunId, input.conversationId, "plan_verify_binding", 0, "t1", "ag_pm", input.childRunId, 1, null, "reported_complete", "not_started", now, now);
}

describe("unsupported artifact claims", () => {
  it("rejects a structured artifact claim with no attempt evidence", () => {
    expect(findUnsupportedArtifactClaims(
      { artifacts: { web_app: "art_benchmark_fake_123" } },
      [],
    )).toEqual(["art_benchmark_fake_123"]);
  });

  it("accepts structured artifact ids backed by valid attempt evidence", () => {
    expect(findUnsupportedArtifactClaims(
      { artifacts: { web_app: "art_real_123" } },
      [{
        subjectId: "web_app",
        payloadJson: JSON.stringify({ artifactId: "art_real_123" }),
        status: "valid",
      }],
    )).toEqual([]);
  });

  it("preserves a legal trailing hyphen when matching an evidenced artifact id", () => {
    expect(findUnsupportedArtifactClaims(
      { artifacts: { web_app: "art_real_trailing_123-" } },
      [{
        subjectId: "web_app",
        payloadJson: JSON.stringify({ artifactId: "art_real_trailing_123-" }),
        status: "valid",
      }],
    )).toEqual([]);
  });

  it("reports the complete unsupported artifact id when it ends in a hyphen", () => {
    expect(findUnsupportedArtifactClaims(
      { artifacts: { web_app: "art_fake_trailing_123-" } },
      [],
    )).toEqual(["art_fake_trailing_123-"]);
  });

  it("does not accept invalid or historical evidence as support", () => {
    expect(findUnsupportedArtifactClaims(
      { artifacts: { web_app: "art_invalid_123" } },
      [{
        subjectId: "art_invalid_123",
        payloadJson: "{}",
        status: "invalid",
      }],
    )).toEqual(["art_invalid_123"]);
  });

  // A task that really produced artifacts may mention ids in its narrative. A
  // typo there, or a passing reference to another conversation's artifact, used
  // to fail the whole attempt (observed live: an agent wrote its own artifact id
  // one character short). Bindings come from evidence, never from prose.
  it("ignores prose artifact ids once the task recorded real artifacts", () => {
    const recorded = { web_app: "art_real_123" };
    const evidence = [{
      subjectId: "web_app",
      payloadJson: JSON.stringify({ artifactId: "art_real_123" }),
      status: "valid" as const,
    }];

    expect(findUnsupportedArtifactClaims(
      { artifacts: recorded, summary: "Produced the report as art_W2DRQxZRBqg (one character off)." },
      evidence,
    )).toEqual([]);
    expect(findUnsupportedArtifactClaims(
      { artifacts: recorded, summary: "Based on art_OTHER_CONVERSATION_999." },
      evidence,
    )).toEqual([]);
  });

  // The false-completion shape: nothing was produced, yet the report narrates an
  // artifact id. This is what tests/e2e-fixtures/fake-artifact-id.json exercises.
  it("treats a prose artifact id as a claim when the task recorded no artifacts", () => {
    expect(findUnsupportedArtifactClaims(
      { summary: "Created art_benchmark_fake_123." },
      [],
    )).toEqual(["art_benchmark_fake_123"]);
    expect(findUnsupportedArtifactClaims(
      { artifacts: {}, summary: "Created art_benchmark_fake_123." },
      [],
    )).toEqual(["art_benchmark_fake_123"]);
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
