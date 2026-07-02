// ---------------------------------------------------------------------------
// P1: Evidence-aware repositories — task attempts, evidence, snapshots, verdicts
//
// Immutable constraints:
// - Evidence: INSERT only, never UPDATE payload. Invalidate via status/invalidated_at.
// - Context Snapshot: INSERT only, never UPDATE.
// - Retry does NOT delete old evidence.
// ---------------------------------------------------------------------------

import { getDatabase } from "@/db/client";

// ── Task Attempts ──────────────────────────────────────────────────────────

export interface TaskAttemptRecord {
  id: string;
  conductorRunId: string;
  conversationId: string;
  planId: string;
  planRevision: number;
  taskId: string;
  agentId: string;
  childRunId?: string | null;
  attempt: number;
  contextSnapshotId?: string | null;
  executionStatus: string;
  verificationStatus: string;
  failureContextJson?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export function createTaskAttempt(record: TaskAttemptRecord) {
  getDatabase()
    .prepare(`
      INSERT INTO task_attempts (
        id, conductor_run_id, conversation_id, plan_id, plan_revision,
        task_id, agent_id, child_run_id, attempt, context_snapshot_id,
        execution_status, verification_status, failure_context_json,
        started_at, finished_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      record.id, record.conductorRunId, record.conversationId,
      record.planId, record.planRevision, record.taskId, record.agentId,
      record.childRunId ?? null, record.attempt, record.contextSnapshotId ?? null,
      record.executionStatus, record.verificationStatus,
      record.failureContextJson ?? null,
      record.startedAt ?? null, record.finishedAt ?? null,
      record.createdAt, record.updatedAt
    );
}

export function startTaskAttempt(attemptId: string, childRunId: string, now: number) {
  getDatabase()
    .prepare(`
      UPDATE task_attempts
      SET child_run_id = ?, execution_status = 'running', started_at = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(childRunId, now, now, attemptId);
}

export function finishTaskAttempt(
  attemptId: string,
  executionStatus: string,
  finishedAt: number
) {
  getDatabase()
    .prepare(`
      UPDATE task_attempts
      SET execution_status = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(executionStatus, finishedAt, finishedAt, attemptId);
}

export function updateTaskAttemptVerification(
  attemptId: string,
  verificationStatus: string,
  failureContextJson: string | null,
  now: number
) {
  getDatabase()
    .prepare(`
      UPDATE task_attempts
      SET verification_status = ?, failure_context_json = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(verificationStatus, failureContextJson, now, attemptId);
}

export function getTaskAttempt(attemptId: string): TaskAttemptRecord | undefined {
  return getDatabase()
    .prepare("SELECT * FROM task_attempts WHERE id = ?")
    .get(attemptId) as TaskAttemptRecord | undefined;
}

export function listTaskAttempts(
  conductorRunId: string,
  taskId: string
): TaskAttemptRecord[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM task_attempts WHERE conductor_run_id = ? AND task_id = ? ORDER BY attempt ASC"
    )
    .all(conductorRunId, taskId) as TaskAttemptRecord[];
}

// ── Evidence ───────────────────────────────────────────────────────────────

export interface EvidenceRecord {
  id: string;
  conversationId: string;
  conductorRunId: string;
  planId: string;
  taskId: string;
  attemptId: string;
  childRunId: string;
  contextSnapshotId: string;
  agentId: string;
  type: string;
  status: string;
  trustLevel: string;
  sourceKind: string;
  sourceId: string;
  subjectType: string;
  subjectId: string;
  payloadJson: string;
  contentHash: string | null;
  invalidatedAt: number | null;
  createdAt: number;
}

export function insertEvidence(record: EvidenceRecord) {
  getDatabase()
    .prepare(`
      INSERT INTO task_evidence (
        id, conversation_id, conductor_run_id, plan_id, task_id,
        attempt_id, child_run_id, context_snapshot_id, agent_id,
        type, status, trust_level, source_kind, source_id,
        subject_type, subject_id, payload_json, content_hash,
        invalidated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      record.id, record.conversationId, record.conductorRunId, record.planId,
      record.taskId, record.attemptId, record.childRunId,
      record.contextSnapshotId, record.agentId,
      record.type, record.status, record.trustLevel,
      record.sourceKind, record.sourceId,
      record.subjectType, record.subjectId,
      record.payloadJson, record.contentHash,
      record.invalidatedAt ?? null, record.createdAt
    );
}

export function getEvidence(evidenceId: string): EvidenceRecord | undefined {
  return getDatabase()
    .prepare("SELECT * FROM task_evidence WHERE id = ?")
    .get(evidenceId) as EvidenceRecord | undefined;
}

export function listEvidenceForAttempt(attemptId: string): EvidenceRecord[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM task_evidence WHERE attempt_id = ? ORDER BY created_at ASC"
    )
    .all(attemptId) as EvidenceRecord[];
}

export function listEvidenceForTask(
  conductorRunId: string,
  planId: string,
  taskId: string
): EvidenceRecord[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM task_evidence WHERE conductor_run_id = ? AND plan_id = ? AND task_id = ? ORDER BY created_at ASC"
    )
    .all(conductorRunId, planId, taskId) as EvidenceRecord[];
}

export function listEvidenceForChildRun(childRunId: string): EvidenceRecord[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM task_evidence WHERE child_run_id = ? ORDER BY created_at ASC"
    )
    .all(childRunId) as EvidenceRecord[];
}

export function invalidateEvidence(evidenceId: string, now: number) {
  getDatabase()
    .prepare(`
      UPDATE task_evidence SET status = 'invalid', invalidated_at = ? WHERE id = ?
    `)
    .run(now, evidenceId);
}

// ── Context Snapshots ──────────────────────────────────────────────────────

export interface ContextSnapshotRecord {
  id: string;
  conversationId: string;
  conductorRunId: string;
  planId: string;
  taskId: string;
  attemptId: string;
  policyVersion: string;
  schemaVersion: number;
  envelopeJson: string;
  manifestJson: string;
  tokenEstimate: number;
  requiredTokenEstimate: number;
  omittedTokenEstimate: number;
  createdAt: number;
}

export function insertContextSnapshot(record: ContextSnapshotRecord) {
  getDatabase()
    .prepare(`
      INSERT INTO task_context_snapshots (
        id, conversation_id, conductor_run_id, plan_id, task_id,
        attempt_id, policy_version, schema_version,
        envelope_json, manifest_json,
        token_estimate, required_token_estimate, omitted_token_estimate,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      record.id, record.conversationId, record.conductorRunId,
      record.planId, record.taskId, record.attemptId,
      record.policyVersion, record.schemaVersion,
      record.envelopeJson, record.manifestJson,
      record.tokenEstimate, record.requiredTokenEstimate,
      record.omittedTokenEstimate, record.createdAt
    );
}

export function getContextSnapshot(
  snapshotId: string
): ContextSnapshotRecord | undefined {
  return getDatabase()
    .prepare("SELECT * FROM task_context_snapshots WHERE id = ?")
    .get(snapshotId) as ContextSnapshotRecord | undefined;
}

export function listContextSnapshotsForTask(
  conductorRunId: string,
  planId: string,
  taskId: string
): ContextSnapshotRecord[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM task_context_snapshots WHERE conductor_run_id = ? AND plan_id = ? AND task_id = ? ORDER BY created_at ASC"
    )
    .all(conductorRunId, planId, taskId) as ContextSnapshotRecord[];
}

// ── Criterion Verdicts ─────────────────────────────────────────────────────

export interface VerdictRecord {
  id: string;
  attemptId: string;
  criterionId: string;
  validatorType: string;
  status: string;
  evidenceIdsJson: string;
  reason: string;
  checkedAt: number;
}

export function upsertCriterionVerdict(record: VerdictRecord) {
  getDatabase()
    .prepare(`
      INSERT OR REPLACE INTO criterion_verdicts (
        id, attempt_id, criterion_id, validator_type,
        status, evidence_ids_json, reason, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      record.id, record.attemptId, record.criterionId,
      record.validatorType, record.status,
      record.evidenceIdsJson, record.reason, record.checkedAt
    );
}

export function listCriterionVerdicts(attemptId: string): VerdictRecord[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM criterion_verdicts WHERE attempt_id = ? ORDER BY criterion_id ASC"
    )
    .all(attemptId) as VerdictRecord[];
}
