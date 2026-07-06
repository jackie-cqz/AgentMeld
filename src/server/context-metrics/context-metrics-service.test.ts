// ---------------------------------------------------------------------------
// P3: Context Metrics Service tests
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import { getDatabase } from "@/db/client";
import { computeRunMetrics, computeDerivedRates } from "@/server/context-metrics/context-metrics-service";
import { newTaskAttemptId, newContextSnapshotId, newEvidenceId } from "@/shared/ids";
import type { ContextQualityRunMetrics } from "@/server/context-metrics/context-metrics-types";

let cleanup: () => void;

const CONV_ID = "test-metrics-conv";
const RUN_ID = "run_metrics_test";
const PLAN_ID = "plan_metrics_test";

beforeAll(() => {
  cleanup = setupTestDatabase("context-metrics-test");
  const db = getDatabase();
  const now = Date.now();

  db.prepare(`INSERT OR IGNORE INTO agents (id, name, avatar, description, capabilities, system_prompt, adapter_name, model_provider, model_id, tool_names, is_builtin, is_conductor, supports_vision, created_at, updated_at) VALUES ('ag_pm', 'PM', '🤖', 'PM', '["pm"]', '', 'custom', 'deepseek', NULL, '["write_artifact","read_artifact"]', 0, 0, 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, avatar, description, capabilities, system_prompt, adapter_name, model_provider, model_id, tool_names, is_builtin, is_conductor, supports_vision, created_at, updated_at) VALUES ('ag_frontend', 'FE', '🤖', 'FE', '["frontend"]', '', 'custom', 'deepseek', NULL, '["read_artifact","fs_write","bash","deploy_workspace"]', 0, 0, 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT OR IGNORE INTO conversations (id, title, mode, agent_ids, pinned_message_ids, archived, fs_write_approval_mode, created_at, updated_at) VALUES (?, 'Metrics Test', 'group', '["ag_pm","ag_frontend"]', '[]', 0, 'review', ?, ?)`).run(CONV_ID, now, now);
  db.prepare(`INSERT OR IGNORE INTO workspaces (id, conversation_id, mode, root_path, created_at, updated_at) VALUES ('ws_metrics', ?, 'sandbox', '/tmp/metrics', ?, ?)`).run(CONV_ID, now, now);
  db.prepare(`INSERT OR IGNORE INTO agent_runs (id, conversation_id, agent_id, trigger_message_id, parent_run_id, status, started_at, created_at, updated_at) VALUES (?, ?, 'ag_pm', NULL, NULL, 'complete', ?, ?, ?)`).run(RUN_ID, CONV_ID, now, now, now);
  db.prepare(`INSERT OR IGNORE INTO agent_runs (id, conversation_id, agent_id, trigger_message_id, parent_run_id, status, started_at, created_at, updated_at) VALUES ('run_child_m1', ?, 'ag_pm', NULL, ?, 'complete', ?, ?, ?)`).run(CONV_ID, RUN_ID, now, now, now);
  db.prepare(`INSERT OR IGNORE INTO agent_runs (id, conversation_id, agent_id, trigger_message_id, parent_run_id, status, started_at, created_at, updated_at) VALUES ('run_child_m2', ?, 'ag_frontend', NULL, ?, 'complete', ?, ?, ?)`).run(CONV_ID, RUN_ID, now, now, now);

  const planJson = JSON.stringify([
    { id: "t1", agentId: "ag_pm", title: "PM: PRD", dependsOn: [], expectedOutputs: [{ id: "prd", type: "document", required: true }], inputs: [] },
    { id: "t2", agentId: "ag_frontend", title: "Frontend", dependsOn: ["t1"], expectedOutputs: [{ id: "app", type: "web_app", required: true }], inputs: [{ fromTaskId: "t1", outputId: "prd", required: true }] },
  ]);
  db.prepare(`INSERT OR IGNORE INTO conductor_plans (id, conductor_run_id, conversation_id, revision, plan_json, status, stage_at_creation, created_at) VALUES (?, ?, ?, 0, ?, 'approved', 'plan', ?)`).run(PLAN_ID, RUN_ID, CONV_ID, planJson, now);

  // Attempt t1 — completed + verified
  const attId1 = newTaskAttemptId();
  const snapId1 = newContextSnapshotId();
  db.prepare(`INSERT OR IGNORE INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, child_run_id, attempt, context_snapshot_id, execution_status, verification_status, started_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 't1', 'ag_pm', 'run_child_m1', 1, ?, 'reported_complete', 'verified', ?, ?, ?, ?)`).run(attId1, RUN_ID, CONV_ID, PLAN_ID, snapId1, now, now, now, now);

  // Attempt t2 — completed + verified
  const attId2 = newTaskAttemptId();
  const snapId2 = newContextSnapshotId();
  db.prepare(`INSERT OR IGNORE INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, child_run_id, attempt, context_snapshot_id, execution_status, verification_status, started_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 't2', 'ag_frontend', 'run_child_m2', 1, ?, 'reported_complete', 'verified', ?, ?, ?, ?)`).run(attId2, RUN_ID, CONV_ID, PLAN_ID, snapId2, now, now, now, now);

  // Snapshots with manifest
  const manifest1 = JSON.stringify([
    { included: true, omittedReason: null },
    { included: true, omittedReason: null },
    { included: false, omittedReason: "stale" },
  ]);
  db.prepare(`INSERT OR IGNORE INTO task_context_snapshots (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, policy_version, schema_version, envelope_json, manifest_json, token_estimate, required_token_estimate, omitted_token_estimate, created_at) VALUES (?, ?, ?, ?, 't1', ?, 'evidence-context-p3-v1', 1, '{}', ?, 100, 80, 20, ?)`).run(snapId1, CONV_ID, RUN_ID, PLAN_ID, attId1, manifest1, now);
  db.prepare(`INSERT OR IGNORE INTO task_context_snapshots (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, policy_version, schema_version, envelope_json, manifest_json, token_estimate, required_token_estimate, omitted_token_estimate, created_at) VALUES (?, ?, ?, ?, 't2', ?, 'evidence-context-p3-v1', 1, '{}', ?, 50, 50, 0, ?)`).run(snapId2, CONV_ID, RUN_ID, PLAN_ID, attId2, '[]', now);

  // Evidence: t1 artifact_created + t2 read_artifact + t2 artifact_created + t2 deployment
  db.prepare(`INSERT OR IGNORE INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, 't1', ?, 'run_child_m1', ?, 'ag_pm', 'artifact_created', 'valid', 'verified', 'tool_call', 'call_1', 'artifact', 'prd', ?, 'hash1', ?)`).run(newEvidenceId(), CONV_ID, RUN_ID, PLAN_ID, attId1, snapId1, JSON.stringify({ outputKey: "prd", artifactId: "art_prd" }), now);
  db.prepare(`INSERT OR IGNORE INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, 't2', ?, 'run_child_m2', ?, 'ag_frontend', 'artifact_read', 'valid', 'verified', 'tool_call', 'call_2', 'artifact', 'art_prd', ?, 'hash2', ?)`).run(newEvidenceId(), CONV_ID, RUN_ID, PLAN_ID, attId2, snapId2, JSON.stringify({ artifactId: "art_prd" }), now);
  db.prepare(`INSERT OR IGNORE INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, 't2', ?, 'run_child_m2', ?, 'ag_frontend', 'artifact_created', 'valid', 'verified', 'tool_call', 'call_3', 'artifact', 'app', ?, 'hash3', ?)`).run(newEvidenceId(), CONV_ID, RUN_ID, PLAN_ID, attId2, snapId2, JSON.stringify({ outputKey: "app", artifactId: "art_app" }), now);
  db.prepare(`INSERT OR IGNORE INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, 't2', ?, 'run_child_m2', ?, 'ag_frontend', 'command_executed', 'valid', 'verified', 'tool_call', 'call_4', 'command', 'pnpm build', ?, 'hash4', ?)`).run(newEvidenceId(), CONV_ID, RUN_ID, PLAN_ID, attId2, snapId2, JSON.stringify({ command: "pnpm build", exitCode: 0 }), now);
  db.prepare(`INSERT OR IGNORE INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, 't2', ?, 'run_child_m2', ?, 'ag_frontend', 'deployment_created', 'valid', 'verified', 'tool_call', 'call_5', 'deployment', 'app_preview', ?, 'hash5', ?)`).run(newEvidenceId(), CONV_ID, RUN_ID, PLAN_ID, attId2, snapId2, JSON.stringify({}), now);

  // Artifacts
  db.prepare(`INSERT OR IGNORE INTO artifacts (id, conversation_id, created_by_agent_id, type, title, content, version, created_at, updated_at) VALUES ('art_prd', ?, 'ag_pm', 'document', 'PRD Doc', '{}', 1, ?, ?)`).run(CONV_ID, now, now);
  db.prepare(`INSERT OR IGNORE INTO artifacts (id, conversation_id, created_by_agent_id, type, title, content, version, created_at, updated_at) VALUES ('art_app', ?, 'ag_frontend', 'web_app', 'Todo App', '{}', 1, ?, ?)`).run(CONV_ID, now, now);

  // Output bindings
  db.prepare(`INSERT OR IGNORE INTO conductor_output_bindings (conductor_run_id, plan_id, producer_task_id, output_key, artifact_id, created_at) VALUES (?, ?, 't1', 'prd', 'art_prd', ?)`).run(RUN_ID, PLAN_ID, now);
  db.prepare(`INSERT OR IGNORE INTO conductor_output_bindings (conductor_run_id, plan_id, producer_task_id, output_key, artifact_id, created_at) VALUES (?, ?, 't2', 'app', 'art_app', ?)`).run(RUN_ID, PLAN_ID, now);
});

afterAll(() => cleanup?.());

describe("computeRunMetrics", () => {
  it("returns 404 for unknown run", () => {
    const result = computeRunMetrics("nonexistent");
    expect("error" in result).toBe(true);
  });

  it("computes raw metrics for valid run", () => {
    const result = computeRunMetrics(RUN_ID);
    if (!("error" in result)) {
      expect(result.raw.taskCount).toBe(2);
      expect(result.raw.attemptCount).toBe(2);
      expect(result.raw.completedTaskCount).toBe(2);
      expect(result.raw.failedTaskCount).toBe(0);
      expect(result.raw.verifiedInputCount).toBeGreaterThan(0);
      expect(result.raw.evidenceCount).toBeGreaterThan(0);
      expect(result.raw.verifiedOutputBindingCount).toBe(2);
      expect(result.raw.artifactCreatedCount).toBe(2);
      expect(result.raw.deploymentReadyCount).toBe(1);
    }
  });

  it("computes derived rates from raw metrics", () => {
    const raw: ContextQualityRunMetrics = {
      runId: "test",
      taskCount: 2, attemptCount: 2, completedTaskCount: 2, failedTaskCount: 0,
      verifiedInputCount: 2, missingRequiredInputCount: 0,
      upstreamInputReadCount: 1, upstreamInputUnreadCount: 1,
      contextIncludedItemCount: 2, contextOmittedItemCount: 1,
      contextOmittedByBudgetCount: 0, staleRejectedCount: 1,
      unverifiedRejectedCount: 0, unrelatedRejectedCount: 0,
      evidenceCount: 5, toolCallCount: 5, failedToolCallCount: 0,
      verifiedOutputBindingCount: 2, rejectedOutputClaimCount: 0,
      artifactCreatedCount: 2, deploymentReadyCount: 1,
    };
    const rates = computeDerivedRates(raw);
    expect(rates.upstreamInputHitRate).toBe(1); // 2/2
    expect(rates.upstreamArtifactReadRate).toBe(0.5); // 1/2
    expect(rates.contextOmissionRate).toBeGreaterThan(0); // 1/3
    expect(rates.toolFailureRate).toBe(0); // 0/5
    expect(rates.deploymentSuccessRate).toBe(0.5); // 1/2
    expect(rates.taskCompletionRate).toBe(1); // 2/2
  });

  it("derived rates handle zero denominators", () => {
    const empty: ContextQualityRunMetrics = {
      runId: "empty", taskCount: 0, attemptCount: 0, completedTaskCount: 0, failedTaskCount: 0,
      verifiedInputCount: 0, missingRequiredInputCount: 0,
      upstreamInputReadCount: 0, upstreamInputUnreadCount: 0,
      contextIncludedItemCount: 0, contextOmittedItemCount: 0,
      contextOmittedByBudgetCount: 0, staleRejectedCount: 0,
      unverifiedRejectedCount: 0, unrelatedRejectedCount: 0,
      evidenceCount: 0, toolCallCount: 0, failedToolCallCount: 0,
      verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0,
      artifactCreatedCount: 0, deploymentReadyCount: 0,
    };
    const rates = computeDerivedRates(empty);
    expect(rates.upstreamInputHitRate).toBe(0);
    expect(rates.toolFailureRate).toBe(0);
    expect(rates.deploymentSuccessRate).toBe(0);
  });

  it("includes context manifest stats", () => {
    const result = computeRunMetrics(RUN_ID);
    if (!("error" in result)) {
      expect(result.raw.contextIncludedItemCount).toBeGreaterThan(0);
      expect(result.raw.staleRejectedCount).toBeGreaterThan(0);
    }
  });
});
