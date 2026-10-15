import { randomBytes, createHash } from "node:crypto";
import { ensureDatabase } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";
import { getRun } from "@/server/repositories";

/**
 * Trusted delegation (issue #24).
 *
 * One agent causing another to work is the most dangerous operation in the
 * system: it multiplies work, spend, and blast radius without a human in the
 * loop. The rule this module enforces is that it is a SEPARATE, verifiable
 * operation — never a side effect of a message that merely looks like a
 * request.
 *
 * Concretely, a child run (one with a parent) must present a one-time grant
 * that was issued for exactly this source → target → task → attempt, and the
 * grant is consumed the moment the child starts. That closes three holes at
 * once:
 *
 * - a replayed/duplicated dispatch attempt finds the grant already consumed;
 * - a grant issued for one task cannot start a different task or agent;
 * - nothing that merely mentions an agent in text can start delegated work,
 *   because text never mints a grant (see `dispatchTargets`: only a human
 *   message dispatches, and the conductor is the only grant issuer).
 *
 * Budget and state are checked at issue time, where the caller still has the
 * context to refuse: a parent run may only delegate while it is running, and
 * only within its outstanding-grant allowance.
 */

const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
/** How many unconsumed grants one parent run may hold at once. */
export const MAX_OUTSTANDING_GRANTS_PER_RUN = 8;

export interface DelegationGrant {
  id: string;
  correlationId: string;
  sourceRunId: string;
  sourceAgentId: string;
  targetAgentId: string;
  taskId: string;
  attempt: number;
  status: "issued" | "consumed" | "expired";
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  consumedByRunId: string | null;
}

interface DelegationRow {
  id: string;
  correlation_id: string;
  source_run_id: string;
  source_agent_id: string;
  target_agent_id: string;
  task_id: string;
  attempt: number;
  status: string;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
  consumed_by_run_id: string | null;
}

function mapRow(row: DelegationRow): DelegationGrant {
  return {
    id: row.id,
    correlationId: row.correlation_id,
    sourceRunId: row.source_run_id,
    sourceAgentId: row.source_agent_id,
    targetAgentId: row.target_agent_id,
    taskId: row.task_id,
    attempt: row.attempt,
    status: row.status as DelegationGrant["status"],
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedByRunId: row.consumed_by_run_id
  };
}

/**
 * A correlation id is a bearer capability, so it is stored hashed: a database
 * read must not hand someone a usable grant. 256 bits, like the owner
 * sessions — nobody enumerates it, so a fast hash is the right lookup key.
 */
function hashCorrelationId(correlationId: string): string {
  return createHash("sha256").update(correlationId).digest("hex");
}

export interface IssueDelegationInput {
  sourceRunId: string;
  sourceAgentId: string;
  targetAgentId: string;
  taskId: string;
  attempt: number;
  now?: number;
  ttlMs?: number;
}

export type IssueDelegationResult =
  | { ok: true; grant: DelegationGrant; correlationId: string }
  | { ok: false; error: string; code: "not_running" | "budget_exhausted" | "invalid" };

/**
 * Mint a one-time grant. The caller (the conductor's dispatch loop) holds the
 * parent run and the task identity; everything about the delegation is
 * decided here, not by the child.
 */
export function issueDelegation(input: IssueDelegationInput): IssueDelegationResult {
  ensureDatabase();
  const now = input.now ?? Date.now();

  if (!input.sourceRunId || !input.sourceAgentId || !input.targetAgentId || !input.taskId) {
    return { ok: false, error: "A delegation needs a source run, source agent, target agent and task.", code: "invalid" };
  }
  // State: a finished or failed parent must not spawn new work. Read from the
  // run row itself — a caller that says "it's running" is not evidence, and a
  // caller that has already decided to dispatch will say exactly that.
  const sourceRun = getRun(input.sourceRunId);
  if (!sourceRun) {
    return { ok: false, error: `Run ${input.sourceRunId} does not exist.`, code: "not_running" };
  }
  if (sourceRun.status !== "running") {
    return {
      ok: false,
      error: `Run ${input.sourceRunId} is ${sourceRun.status}; only a running run may delegate.`,
      code: "not_running"
    };
  }
  if (input.sourceAgentId !== sourceRun.agentId) {
    // The recorded source agent is checked, not just stored: a grant that
    // names an agent other than the run's own would make "who delegated this"
    // unanswerable.
    return {
      ok: false,
      error: "The source agent does not match the run that is delegating.",
      code: "invalid"
    };
  }

  // Expired grants stop being spendable at consume time; retiring them here
  // also keeps them out of the table's 'issued' population for good.
  getDatabase()
    .prepare("UPDATE delegations SET status = 'expired' WHERE status = 'issued' AND expires_at <= ?")
    .run(now);

  const outstanding = getDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM delegations WHERE source_run_id = ? AND status = 'issued' AND expires_at > ?"
    )
    .get(input.sourceRunId, now) as { count: number };
  if (outstanding.count >= MAX_OUTSTANDING_GRANTS_PER_RUN) {
    return {
      ok: false,
      error: `Run ${input.sourceRunId} already holds ${outstanding.count} unconsumed delegations (limit ${MAX_OUTSTANDING_GRANTS_PER_RUN}).`,
      code: "budget_exhausted"
    };
  }

  const correlationId = randomBytes(32).toString("base64url");
  const grant: DelegationGrant = {
    id: `dg_${randomBytes(8).toString("hex")}`,
    correlationId,
    sourceRunId: input.sourceRunId,
    sourceAgentId: input.sourceAgentId,
    targetAgentId: input.targetAgentId,
    taskId: input.taskId,
    attempt: input.attempt,
    status: "issued",
    issuedAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_GRANT_TTL_MS),
    consumedAt: null,
    consumedByRunId: null
  };

  getDatabase()
    .prepare(`
      INSERT INTO delegations (
        id, correlation_id, source_run_id, source_agent_id, target_agent_id,
        task_id, attempt, status, issued_at, expires_at, consumed_at, consumed_by_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, NULL, NULL)
    `)
    .run(
      grant.id,
      hashCorrelationId(correlationId),
      grant.sourceRunId,
      grant.sourceAgentId,
      grant.targetAgentId,
      grant.taskId,
      grant.attempt,
      grant.issuedAt,
      grant.expiresAt
    );

  return { ok: true, grant, correlationId };
}

export interface ConsumeDelegationInput {
  correlationId: string;
  sourceRunId: string;
  targetAgentId: string;
  taskId: string;
  attempt: number;
  /** The child run being started, when the caller has already chosen its id. */
  childRunId?: string | null;
  now?: number;
}

export type ConsumeDelegationResult =
  | { ok: true; grant: DelegationGrant }
  | { ok: false; error: string; code: "unknown" | "consumed" | "expired" | "mismatch" };

/**
 * Spend a grant to start the child run it names. Every field is verified
 * against what was issued: a grant for task A cannot start task B, and one
 * source run cannot spend another run's grant.
 *
 * One-time is enforced twice on purpose: the status check above, and the
 * `WHERE status = 'issued'` in the update itself, in the same shape as
 * `resolveApproval`. Consumption is synchronous today, so a test cannot make
 * two spends interleave and the second layer is not reachable from a test —
 * it is there so that a future async or multi-process caller cannot double
 * spend. The tests pin the observable property (the second spend fails); they
 * do not claim to drive the SQL guard.
 */
export function consumeDelegation(input: ConsumeDelegationInput): ConsumeDelegationResult {
  ensureDatabase();
  const now = input.now ?? Date.now();

  const row = getDatabase()
    .prepare("SELECT * FROM delegations WHERE correlation_id = ?")
    .get(hashCorrelationId(input.correlationId)) as DelegationRow | undefined;
  if (!row) return { ok: false, error: "Unknown delegation.", code: "unknown" };
  const grant = mapRow(row);

  if (grant.status === "consumed") {
    return { ok: false, error: "This delegation was already used.", code: "consumed" };
  }
  if (grant.status !== "issued") {
    return { ok: false, error: `This delegation is ${grant.status}.`, code: "unknown" };
  }
  if (grant.expiresAt <= now) {
    getDatabase().prepare("UPDATE delegations SET status = 'expired' WHERE id = ? AND status = 'issued'").run(grant.id);
    return { ok: false, error: "This delegation expired.", code: "expired" };
  }
  if (
    grant.sourceRunId !== input.sourceRunId ||
    grant.targetAgentId !== input.targetAgentId ||
    grant.taskId !== input.taskId ||
    grant.attempt !== input.attempt
  ) {
    // Deliberately no detail about WHICH field differs: the caller is about to
    // be refused, and spelling out the grant's contents turns a probing
    // attempt into a disclosure.
    return { ok: false, error: "This delegation was issued for a different run, agent, task or attempt.", code: "mismatch" };
  }

  const result = getDatabase()
    .prepare(
      "UPDATE delegations SET status = 'consumed', consumed_at = ?, consumed_by_run_id = ? WHERE id = ? AND status = 'issued'"
    )
    .run(now, input.childRunId ?? null, grant.id) as { changes?: number };
  if ((result.changes ?? 0) === 0) {
    return { ok: false, error: "This delegation was already used.", code: "consumed" };
  }

  return { ok: true, grant: { ...grant, status: "consumed", consumedAt: now, consumedByRunId: input.childRunId ?? null } };
}

export function getDelegationByCorrelationId(correlationId: string): DelegationGrant | undefined {
  ensureDatabase();
  const row = getDatabase()
    .prepare("SELECT * FROM delegations WHERE correlation_id = ?")
    .get(hashCorrelationId(correlationId)) as DelegationRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function clearDelegationsForTests(): void {
  ensureDatabase();
  getDatabase().prepare("DELETE FROM delegations").run();
}
