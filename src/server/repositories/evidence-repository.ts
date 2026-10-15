// ---------------------------------------------------------------------------
// P1: Evidence-aware repositories — task attempts, evidence, snapshots, verdicts
//
// Immutable constraints:
// - Evidence: INSERT only, never UPDATE payload. Invalidate via status/invalidated_at.
// - Context Snapshot: INSERT only, never UPDATE.
// - Retry does NOT delete old evidence.
// ---------------------------------------------------------------------------

import { getDatabase } from "@/db/client";

// ── Row mappers: SQLite returns snake_case, interfaces use camelCase ───────

type SnakeRow = Record<string, unknown>;

function mapAttemptRow(r: SnakeRow): TaskAttemptRecord {
  return {
    id: r.id as string,
    conductorRunId: r.conductor_run_id as string,
    conversationId: r.conversation_id as string,
    planId: r.plan_id as string,
    planRevision: r.plan_revision as number,
    taskId: r.task_id as string,
    agentId: r.agent_id as string,
    childRunId: (r.child_run_id as string) ?? null,
    attempt: r.attempt as number,
    contextSnapshotId: (r.context_snapshot_id as string) ?? null,
    executionStatus: r.execution_status as string,
    verificationStatus: r.verification_status as string,
    failureContextJson: (r.failure_context_json as string) ?? null,
    startedAt: (r.started_at as number) ?? null,
    finishedAt: (r.finished_at as number) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function mapEvidenceRow(r: SnakeRow): EvidenceRecord {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    conductorRunId: r.conductor_run_id as string,
    planId: r.plan_id as string,
    taskId: r.task_id as string,
    attemptId: r.attempt_id as string,
    childRunId: r.child_run_id as string,
    contextSnapshotId: r.context_snapshot_id as string,
    agentId: r.agent_id as string,
    type: r.type as string,
    status: r.status as string,
    trustLevel: r.trust_level as string,
    sourceKind: r.source_kind as string,
    sourceId: r.source_id as string,
    subjectType: r.subject_type as string,
    subjectId: r.subject_id as string,
    payloadJson: r.payload_json as string,
    contentHash: (r.content_hash as string) ?? null,
    invalidatedAt: (r.invalidated_at as number) ?? null,
    createdAt: r.created_at as number,
  };
}

function mapSnapshotRow(r: SnakeRow): ContextSnapshotRecord {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    conductorRunId: r.conductor_run_id as string,
    planId: r.plan_id as string,
    taskId: r.task_id as string,
    attemptId: r.attempt_id as string,
    policyVersion: r.policy_version as string,
    schemaVersion: r.schema_version as number,
    envelopeJson: r.envelope_json as string,
    manifestJson: r.manifest_json as string,
    tokenEstimate: r.token_estimate as number,
    requiredTokenEstimate: r.required_token_estimate as number,
    omittedTokenEstimate: r.omitted_token_estimate as number,
    createdAt: r.created_at as number,
  };
}

function mapVerdictRow(r: SnakeRow): VerdictRecord {
  return {
    id: r.id as string,
    attemptId: r.attempt_id as string,
    criterionId: r.criterion_id as string,
    validatorType: r.validator_type as string,
    status: r.status as string,
    evidenceIdsJson: r.evidence_ids_json as string,
    reason: r.reason as string,
    checkedAt: r.checked_at as number,
  };
}

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

/**
 * Undo the child-run pointer for an attempt whose run never came into being.
 *
 * `startTaskAttempt` runs before the child is started, so a delegation the
 * runner refused leaves task_attempts.child_run_id naming a run that does not
 * exist. That row is what an investigator reads; a dangling id reads as "the
 * run exists, go look for it".
 */
export function clearTaskAttemptChildRun(attemptId: string, now: number) {
  getDatabase()
    .prepare(`
      UPDATE task_attempts
      SET child_run_id = NULL, updated_at = ?
      WHERE id = ?
    `)
    .run(now, attemptId);
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

/** 'queued' and 'running' are the only non-terminal execution states an attempt has. */
function isNonTerminal(executionStatus: string): boolean {
  return executionStatus === "queued" || executionStatus === "running";
}

/**
 * Finish one attempt as failed, but ONLY while it is still non-terminal.
 *
 * Used on the error path of `runChildTask`. A throw after the attempt was already
 * finished (output binding, FTS rebuild, the blocked-envelope branch) must not rewrite
 * a correct terminal row as failed, so the current row is read back first and a
 * terminal row is left alone. Returns whether a write happened.
 */
export function failOpenTaskAttempt(attemptId: string, error: string, now: number): boolean {
  const row = getTaskAttempt(attemptId);
  if (!row || !isNonTerminal(row.executionStatus)) return false;
  finishTaskAttempt(attemptId, "failed", now);
  updateTaskAttemptVerification(attemptId, "rejected", JSON.stringify({ error }), now);
  return true;
}

/**
 * Retire attempt rows that no live writer will ever finish.
 *
 * CAUTION — only call this from the process-start recovery path, and only after every
 * run still marked 'running' has been force-failed. That precondition, not the
 * `status <> 'running'` clause below, is what keeps a live attempt from being retired:
 * `recoverOrphanedRuns` marks every 'running' run interrupted before calling this, so by
 * then the clause matches every row regardless. In a single process `ensureDatabase` is
 * memoized and its first call necessarily precedes any run, so this only ever sees rows
 * whose owner is genuinely gone. A second caller — a periodic sweep, or another process
 * sharing the data directory — must pass the run ids to retire explicitly rather than
 * re-deriving "not running", or it will retire attempts that are still in flight.
 *
 * Rows of this shape have three sources: the retry loop writing only `execution_status`
 * (fixed for the happy path, but a throw inside `runChildTask` leaves the in-flight
 * attempt behind), a clarifying-question meta-attempt written as 'running' by builds
 * older than the terminal-write fix, and any run interrupted mid-flight.
 *
 * A conductor meta-attempt is a pure evidence container, not an in-flight attempt:
 * `reported_complete` is its success token (what `finishTaskAttempt` writes) and it never
 * gets verdicts, so its verification status is left as it is. It is identified by
 * `task_id = 'conductor' AND attempt = 0` — the id alone is not sufficient, because plan
 * task ids come from the model and `validatePlan` does not reserve that word. A child
 * attempt that never finished is genuinely failed.
 *
 * `finished_at` is only filled when absent — an already-finished row must not be
 * re-timestamped by a repair pass.
 */
export function retireNonTerminalAttempts(now: number): number {
  const result = getDatabase()
    .prepare(`
      UPDATE task_attempts
      SET execution_status = CASE WHEN task_id = 'conductor' AND attempt = 0 THEN 'reported_complete' ELSE 'failed' END,
          verification_status = CASE WHEN task_id = 'conductor' AND attempt = 0 THEN verification_status ELSE 'rejected' END,
          failure_context_json = CASE
            WHEN task_id = 'conductor' AND attempt = 0 THEN failure_context_json
            ELSE COALESCE(failure_context_json, '{"error":"attempt was left non-terminal by a run that had already stopped"}')
          END,
          finished_at = COALESCE(finished_at, ?),
          updated_at = ?
      WHERE execution_status IN ('queued', 'running')
        AND conductor_run_id IN (SELECT id FROM agent_runs WHERE status <> 'running')
    `)
    .run(now, now) as { changes?: number };
  return result.changes ?? 0;
}

export function getTaskAttempt(attemptId: string): TaskAttemptRecord | undefined {
  const row = getDatabase()
    .prepare("SELECT * FROM task_attempts WHERE id = ?")
    .get(attemptId) as SnakeRow | undefined;
  return row ? mapAttemptRow(row) : undefined;
}

export function getTaskAttemptByChildRun(childRunId: string): TaskAttemptRecord | undefined {
  const row = getDatabase()
    .prepare("SELECT * FROM task_attempts WHERE child_run_id = ? LIMIT 1")
    .get(childRunId) as SnakeRow | undefined;
  return row ? mapAttemptRow(row) : undefined;
}

export function listTaskAttempts(
  conductorRunId: string,
  taskId: string
): TaskAttemptRecord[] {
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM task_attempts WHERE conductor_run_id = ? AND task_id = ? ORDER BY attempt ASC"
    )
    .all(conductorRunId, taskId) as SnakeRow[];
  return rows.map(mapAttemptRow);
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
  const row = getDatabase()
    .prepare("SELECT * FROM task_evidence WHERE id = ?")
    .get(evidenceId) as SnakeRow | undefined;
  return row ? mapEvidenceRow(row) : undefined;
}

export function listEvidenceForAttempt(attemptId: string): EvidenceRecord[] {
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM task_evidence WHERE attempt_id = ? ORDER BY created_at ASC"
    )
    .all(attemptId) as SnakeRow[];
  return rows.map(mapEvidenceRow);
}

export function listEvidenceForTask(
  conductorRunId: string,
  planId: string,
  taskId: string
): EvidenceRecord[] {
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM task_evidence WHERE conductor_run_id = ? AND plan_id = ? AND task_id = ? ORDER BY created_at ASC"
    )
    .all(conductorRunId, planId, taskId) as SnakeRow[];
  return rows.map(mapEvidenceRow);
}

export function listEvidenceForChildRun(childRunId: string): EvidenceRecord[] {
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM task_evidence WHERE child_run_id = ? ORDER BY created_at ASC"
    )
    .all(childRunId) as SnakeRow[];
  return rows.map(mapEvidenceRow);
}

export function invalidateEvidence(evidenceId: string, now: number) {
  getDatabase()
    .prepare(`
      UPDATE task_evidence SET status = 'invalid', invalidated_at = ? WHERE id = ?
    `)
    .run(now, evidenceId);
}

/**
 * P5: Mark all existing evidence for a subject as stale within a conversation.
 * Called when a retry produces new evidence for the same file/artifact/command,
 * so downstream consumers only see the latest evidence.
 */
export function markEvidenceStaleBySubject(
  conversationId: string,
  subjectType: string,
  subjectId: string,
  supersedingEvidenceId: string,
  now: number
): void {
  getDatabase()
    .prepare(`
      UPDATE task_evidence
      SET status = 'stale', invalidated_at = ?
      WHERE conversation_id = ?
        AND subject_type = ?
        AND subject_id = ?
        AND status = 'valid'
        AND id != ?
    `)
    .run(now, conversationId, subjectType, subjectId, supersedingEvidenceId);
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
  const row = getDatabase()
    .prepare("SELECT * FROM task_context_snapshots WHERE id = ?")
    .get(snapshotId) as SnakeRow | undefined;
  return row ? mapSnapshotRow(row) : undefined;
}

export function listContextSnapshotsForTask(
  conductorRunId: string,
  planId: string,
  taskId: string
): ContextSnapshotRecord[] {
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM task_context_snapshots WHERE conductor_run_id = ? AND plan_id = ? AND task_id = ? ORDER BY created_at ASC"
    )
    .all(conductorRunId, planId, taskId) as SnakeRow[];
  return rows.map(mapSnapshotRow);
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
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM criterion_verdicts WHERE attempt_id = ? ORDER BY criterion_id ASC"
    )
    .all(attemptId) as SnakeRow[];
  return rows.map(mapVerdictRow);
}
