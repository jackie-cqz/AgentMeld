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
  db.prepare("UPDATE agent_runs SET usage = ? WHERE id = ?").run(JSON.stringify({ inputTokens: 100, outputTokens: 20 }), RUN_ID);
  db.prepare("UPDATE agent_runs SET usage = ? WHERE id = ?").run(JSON.stringify({ inputTokens: 200, outputTokens: 40 }), "run_child_m1");
  db.prepare("UPDATE agent_runs SET usage = ? WHERE id = ?").run(JSON.stringify({ inputTokens: 300, outputTokens: 60 }), "run_child_m2");

  const pmParts = JSON.stringify([
    { type: "tool_use", callId: "call_1", toolName: "write_artifact", args: {}, argumentRepair: { applied: true, kinds: ["syntax_repaired"] } },
    { type: "tool_result", callId: "call_1", result: { artifactId: "art_prd" } },
  ]);
  const frontendParts = JSON.stringify([
    { type: "tool_use", callId: "call_2", toolName: "read_artifact", args: { artifactId: "art_prd" } },
    { type: "tool_result", callId: "call_2", result: { artifactId: "art_prd" } },
    { type: "tool_use", callId: "call_3", toolName: "write_artifact", args: {} },
    { type: "tool_result", callId: "call_3", result: { artifactId: "art_app" } },
    { type: "tool_use", callId: "call_4", toolName: "bash", args: { command: "pnpm build" } },
    { type: "tool_result", callId: "call_4", result: { exitCode: 0 } },
    { type: "tool_use", callId: "call_5", toolName: "deploy_workspace", args: {} },
    { type: "tool_result", callId: "call_5", result: { status: "ready" } },
  ]);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, agent_id, run_id, parts, status, mentioned_agent_ids, created_at, updated_at) VALUES ('msg_metrics_pm', ?, 'assistant', 'ag_pm', 'run_child_m1', ?, 'complete', '[]', ?, ?)`).run(CONV_ID, pmParts, now, now);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, agent_id, run_id, parts, status, mentioned_agent_ids, created_at, updated_at) VALUES ('msg_metrics_fe', ?, 'assistant', 'ag_frontend', 'run_child_m2', ?, 'complete', '[]', ?, ?)`).run(CONV_ID, frontendParts, now, now);
  db.prepare(`INSERT INTO pending_approvals (id, conversation_id, agent_id, run_id, approval_type, status, payload_json, created_at, updated_at) VALUES ('approval_metrics_1', ?, 'ag_frontend', 'run_child_m2', 'bash', 'approved', '{}', ?, ?)`).run(CONV_ID, now, now);

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
      expect(result.raw.toolCallCount).toBe(5);
      expect(result.raw.failedToolCallCount).toBe(0);
      expect(result.raw.approvalRequestCount).toBe(1);
      expect(result.raw.jsonRepairCount).toBe(1);
      expect(result.raw.inputTokens).toBe(600);
      expect(result.raw.outputTokens).toBe(120);
      expect(result.raw.modelRunCount).toBe(3);
      expect(result.sources.runIds).toEqual(expect.arrayContaining([RUN_ID, "run_child_m1", "run_child_m2"]));
      expect(result.sources.taskAttemptIds).toHaveLength(2);
      expect(result.sources.contextSnapshotIds).toHaveLength(2);
      expect(result.sources.evidenceIds).toHaveLength(5);
      expect(result.sources.messageIds).toEqual(expect.arrayContaining(["msg_metrics_pm", "msg_metrics_fe"]));
      expect(result.sources.messageIds).toHaveLength(2);
      expect(result.sources.approvalIds).toEqual(["approval_metrics_1"]);
    }
  });

  it("computes derived rates from raw metrics", () => {
    const raw: ContextQualityRunMetrics = {
      runId: "test",
      taskCount: 2, attemptCount: 2, completedTaskCount: 2, failedTaskCount: 0,
      verifiedInputCount: 2, missingRequiredInputCount: 0,
      upstreamInputReadCount: 1, upstreamInputUnreadCount: 1,
      contextIncludedItemCount: 2, contextOmittedItemCount: 1,
      contextOmittedByBudgetCount: 0, staleRejectedCount: 1, staleFactLeakageCount: 0,
      unverifiedRejectedCount: 0, unrelatedRejectedCount: 0,
      contextOmittedReasonCounts: { stale: 1 },
      evidenceCount: 5, toolCallCount: 5, failedToolCallCount: 0,
      verifiedOutputBindingCount: 2, rejectedOutputClaimCount: 0, unverifiedOutputPropagationCount: 0,
      approvalRequestCount: 1, jsonRepairCount: 1,
      inputTokens: 600, outputTokens: 120, modelRunCount: 3,
      verifiedTaskCount: 2, rejectedTaskCount: 0, needsReviewTaskCount: 0,
      artifactCreatedCount: 2, webAppOutputCount: 1, deploymentReadyCount: 1,
    };
    const rates = computeDerivedRates(raw);
    expect(rates.upstreamInputHitRate).toBe(1); // 2/2
    expect(rates.upstreamArtifactReadRate).toBe(0.5); // 1/2
    expect(rates.contextOmissionRate).toBeGreaterThan(0); // 1/3
    expect(rates.toolFailureRate).toBe(0); // 0/5
    expect(rates.deploymentSuccessRate).toBe(1); // 1/1 web apps
    expect(rates.taskCompletionRate).toBe(1); // 2/2
  });

  it("derived rates handle zero denominators", () => {
    const empty: ContextQualityRunMetrics = {
      runId: "empty", taskCount: 0, attemptCount: 0, completedTaskCount: 0, failedTaskCount: 0,
      verifiedInputCount: 0, missingRequiredInputCount: 0,
      upstreamInputReadCount: 0, upstreamInputUnreadCount: 0,
      contextIncludedItemCount: 0, contextOmittedItemCount: 0,
      contextOmittedByBudgetCount: 0, staleRejectedCount: 0, staleFactLeakageCount: 0,
      unverifiedRejectedCount: 0, unrelatedRejectedCount: 0,
      contextOmittedReasonCounts: {},
      evidenceCount: 0, toolCallCount: 0, failedToolCallCount: 0,
      verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0, unverifiedOutputPropagationCount: 0,
      approvalRequestCount: 0, jsonRepairCount: 0,
      inputTokens: 0, outputTokens: 0, modelRunCount: 0,
      verifiedTaskCount: 0, rejectedTaskCount: 0, needsReviewTaskCount: 0,
      artifactCreatedCount: 0, webAppOutputCount: 0, deploymentReadyCount: 0,
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
