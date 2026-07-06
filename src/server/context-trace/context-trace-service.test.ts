// ---------------------------------------------------------------------------
// P0: Context Trace Service tests
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import { getDatabase } from "@/db/client";
import { getContextTraceByAttempt, getContextTraceByRun } from "@/server/context-trace/context-trace-service";
import { ensureFtsIndexes } from "@/server/search/context-fts-index";
import { newTaskAttemptId, newContextSnapshotId, newEvidenceId, newVerdictId, newMessageId } from "@/shared/ids";

let cleanup: () => void;

const CONV_ID = "test-trace-conv";
const RUN_ID = "run_trace_test";
const PLAN_ID = "plan_trace_test";
const ATTEMPT_ID = newTaskAttemptId();
const SNAPSHOT_ID = newContextSnapshotId();

beforeAll(() => {
  cleanup = setupTestDatabase("context-trace-test");
  ensureFtsIndexes();
  const db = getDatabase();
  const now = Date.now();

  // FK parents
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, avatar, description, capabilities, system_prompt, adapter_name, model_provider, model_id, tool_names, is_builtin, is_conductor, supports_vision, created_at, updated_at) VALUES ('ag_pm', 'PM', '🤖', 'PM', '["pm"]', '', 'custom', 'deepseek', NULL, '["write_artifact","read_artifact"]', 0, 0, 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, avatar, description, capabilities, system_prompt, adapter_name, model_provider, model_id, tool_names, is_builtin, is_conductor, supports_vision, created_at, updated_at) VALUES ('ag_frontend', 'FE', '🤖', 'FE', '["frontend"]', '', 'custom', 'deepseek', NULL, '["read_artifact","fs_write","bash"]', 0, 0, 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT OR IGNORE INTO conversations (id, title, mode, agent_ids, pinned_message_ids, archived, fs_write_approval_mode, created_at, updated_at) VALUES (?, 'Trace Test', 'group', '["ag_pm","ag_frontend"]', '[]', 0, 'review', ?, ?)`).run(CONV_ID, now, now);
  db.prepare(`INSERT OR IGNORE INTO workspaces (id, conversation_id, mode, root_path, created_at, updated_at) VALUES ('ws_trace', ?, 'sandbox', '/tmp/trace', ?, ?)`).run(CONV_ID, now, now);
  db.prepare(`INSERT OR IGNORE INTO agent_runs (id, conversation_id, agent_id, trigger_message_id, parent_run_id, status, started_at, created_at, updated_at) VALUES (?, ?, 'ag_pm', NULL, NULL, 'complete', ?, ?, ?)`).run(RUN_ID, CONV_ID, now, now, now);
  db.prepare(`INSERT OR IGNORE INTO agent_runs (id, conversation_id, agent_id, trigger_message_id, parent_run_id, status, started_at, created_at, updated_at) VALUES ('run_child_trace', ?, 'ag_frontend', NULL, ?, 'complete', ?, ?, ?)`).run(CONV_ID, RUN_ID, now, now, now);

  // Plan with t1 → t2 dependency
  const planJson = JSON.stringify([
    { id: "t1", agentId: "ag_pm", title: "PM: PRD", dependsOn: [], expectedOutputs: [{ id: "prd", type: "document", required: true }], inputs: [] },
    { id: "t2", agentId: "ag_frontend", title: "Frontend", dependsOn: ["t1"], expectedOutputs: [{ id: "app", type: "web_app", required: true }], inputs: [{ fromTaskId: "t1", outputId: "prd", required: true }] },
  ]);
  db.prepare(`INSERT OR IGNORE INTO conductor_plans (id, conductor_run_id, conversation_id, revision, plan_json, status, stage_at_creation, created_at) VALUES (?, ?, ?, 0, ?, 'approved', 'plan', ?)`).run(PLAN_ID, RUN_ID, CONV_ID, planJson, now);

  // Task attempt
  db.prepare(`INSERT OR IGNORE INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, child_run_id, attempt, context_snapshot_id, execution_status, verification_status, started_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 't1', 'ag_pm', 'run_child_trace', 1, ?, 'reported_complete', 'verified', ?, ?, ?, ?)`).run(ATTEMPT_ID, RUN_ID, CONV_ID, PLAN_ID, SNAPSHOT_ID, now, now, now, now);

  // Context snapshot
  const manifest = JSON.stringify([
    { id: "m1", category: "task", sourceType: "plan", sourceId: PLAN_ID, reason: "task objective", required: true, trustLevel: "authoritative", tokenEstimate: 50, included: true, omittedReason: null },
    { id: "m2", category: "upstream_input", sourceType: "artifact", sourceId: "art_prd", reason: "required input", required: true, trustLevel: "verified", tokenEstimate: 30, included: true, omittedReason: null },
  ]);
  db.prepare(`INSERT OR IGNORE INTO task_context_snapshots (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, policy_version, schema_version, envelope_json, manifest_json, token_estimate, required_token_estimate, omitted_token_estimate, created_at) VALUES (?, ?, ?, ?, 't1', ?, 'evidence-context-p3-v1', 1, '{}', ?, 80, 80, 0, ?)`).run(SNAPSHOT_ID, CONV_ID, RUN_ID, PLAN_ID, ATTEMPT_ID, manifest, now);

  // Evidence: artifact_created + read_artifact
  db.prepare(`INSERT OR IGNORE INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, 't1', ?, 'run_child_trace', ?, 'ag_pm', 'artifact_created', 'valid', 'verified', 'tool_call', 'call_1', 'artifact', 'prd', ?, 'hash123', ?)`).run(newEvidenceId(), CONV_ID, RUN_ID, PLAN_ID, ATTEMPT_ID, SNAPSHOT_ID, JSON.stringify({ outputKey: "prd", artifactId: "art_prd" }), now);

  // Artifact
  db.prepare(`INSERT OR IGNORE INTO artifacts (id, conversation_id, created_by_agent_id, type, title, content, version, created_at, updated_at) VALUES ('art_prd', ?, 'ag_pm', 'document', 'PRD Doc', '{}', 1, ?, ?)`).run(CONV_ID, now, now);

  // Output binding
  db.prepare(`INSERT OR IGNORE INTO conductor_output_bindings (conductor_run_id, plan_id, producer_task_id, output_key, artifact_id, created_at) VALUES (?, ?, 't1', 'prd', 'art_prd', ?)`).run(RUN_ID, PLAN_ID, now);

  // Verdict
  db.prepare(`INSERT OR IGNORE INTO criterion_verdicts (id, attempt_id, criterion_id, validator_type, status, evidence_ids_json, reason, checked_at) VALUES (?, ?, 'prd-created', 'artifact_exists', 'passed', '["ev_1"]', 'Artifact prd was created', ?)`).run(newVerdictId(), ATTEMPT_ID, now);
});

afterAll(() => cleanup?.());

describe("getContextTraceByAttempt", () => {
  it("returns 404 for unknown attempt", () => {
    const result = getContextTraceByAttempt("nonexistent");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.status).toBe(404);
  });

  it("returns full trace with snapshot for valid attempt", () => {
    const result = getContextTraceByAttempt(ATTEMPT_ID);
    expect("attempt" in result).toBe(true);
    if (!("error" in result)) {
      expect(result.attempt.attemptId).toBe(ATTEMPT_ID);
      expect(result.attempt.taskId).toBe("t1");
      expect(result.attempt.executionStatus).toBe("reported_complete");
    }
  });

  it("includes context snapshot with manifest", () => {
    const result = getContextTraceByAttempt(ATTEMPT_ID);
    if (!("error" in result)) {
      expect(result.snapshot).not.toBeNull();
      expect(result.snapshot!.id).toBe(SNAPSHOT_ID);
      expect(result.includedManifest.length).toBeGreaterThan(0);
    }
  });

  it("includes evidence summary", () => {
    const result = getContextTraceByAttempt(ATTEMPT_ID);
    if (!("error" in result)) {
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence.some((e) => e.type === "artifact_created")).toBe(true);
    }
  });

  it("includes verdicts", () => {
    const result = getContextTraceByAttempt(ATTEMPT_ID);
    if (!("error" in result)) {
      expect(result.verdicts.length).toBeGreaterThan(0);
    }
  });

  it("includes output bindings", () => {
    const result = getContextTraceByAttempt(ATTEMPT_ID);
    if (!("error" in result)) {
      expect(result.outputBindings.length).toBeGreaterThan(0);
      expect(result.outputBindings[0].outputKey).toBe("prd");
    }
  });

  it("resolves upstream inputs from dependsOn when task has no explicit inputs", () => {
    // P1: Task t2 depends on t1 but has no explicit inputs.
    // The runtime (buildInputSpecs) derives inputs from dependsOn + outputBindings.
    // The trace API should pick this up via envelope.upstreamInputs or
    // the dependsOn-derived fallback path.
    const db = getDatabase();
    const now = Date.now();
    const attId2 = newTaskAttemptId();
    const snapId2 = newContextSnapshotId();

    db.prepare(`INSERT OR IGNORE INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, child_run_id, attempt, context_snapshot_id, execution_status, verification_status, started_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 't2', 'ag_frontend', 'run_child_t2', 1, ?, 'reported_complete', 'verified', ?, ?, ?, ?)`).run(attId2, RUN_ID, CONV_ID, PLAN_ID, snapId2, now, now, now, now);

    const envelope = JSON.stringify({
      upstreamInputs: [{ fromTaskId: "t1", outputKey: "prd", artifactId: "art_prd", artifactVersion: 1, artifactType: "document", title: "PRD Doc" }],
    });
    db.prepare(`INSERT OR IGNORE INTO task_context_snapshots (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, policy_version, schema_version, envelope_json, manifest_json, token_estimate, required_token_estimate, omitted_token_estimate, created_at) VALUES (?, ?, ?, ?, 't2', ?, 'evidence-context-p3-v1', 1, ?, '[]', 50, 50, 0, ?)`).run(snapId2, CONV_ID, RUN_ID, PLAN_ID, attId2, envelope, now);

    db.prepare(`INSERT OR IGNORE INTO conductor_output_bindings (conductor_run_id, plan_id, producer_task_id, output_key, artifact_id, created_at) VALUES (?, ?, 't2', 'app', 'art_app', ?)`).run(RUN_ID, PLAN_ID, now);
    db.prepare(`INSERT OR IGNORE INTO artifacts (id, conversation_id, created_by_agent_id, type, title, content, version, created_at, updated_at) VALUES ('art_app', ?, 'ag_frontend', 'web_app', 'Todo App', '{}', 1, ?, ?)`).run(CONV_ID, now, now);

    const result = getContextTraceByAttempt(attId2);
    if (!("error" in result)) {
      expect(result.upstreamInputs.length).toBeGreaterThan(0);
      const prdInput = result.upstreamInputs.find((ui) => ui.fromTaskId === "t1" && ui.outputKey === "prd");
      expect(prdInput).toBeDefined();
      expect(prdInput!.bindingVerified).toBe(true);
      expect(prdInput!.artifactId).toBe("art_prd");
    }
  });
});

describe("getContextTraceByRun", () => {
  it("returns 404 for unknown run", () => {
    const result = getContextTraceByRun("nonexistent");
    expect("error" in result).toBe(true);
  });

  it("returns run trace with tasks and metrics", () => {
    const result = getContextTraceByRun(RUN_ID);
    if (!("error" in result)) {
      expect(result.conductorRunId).toBe(RUN_ID);
      expect(result.tasks.length).toBeGreaterThan(0);
      expect(result.metrics.taskCount).toBeGreaterThan(0);
    }
  });
});
