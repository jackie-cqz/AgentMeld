// ---------------------------------------------------------------------------
// P1: read_evidence — allow agents to retrieve sanitized evidence details
//
// Evidence summaries are injected into task context, but full (sanitized)
// details remain in the SQLite Ledger. Agents call this tool to fetch
// specific evidence by ID when they need more context (e.g. error output).
// ---------------------------------------------------------------------------

import type { ToolDef, ToolContext, ToolResult } from "@/server/tools/types";
import {
  getEvidence,
  insertEvidence,
  listEvidenceForAttempt,
  type EvidenceRecord,
} from "@/server/repositories/evidence-repository";
import { sanitizeText } from "@/server/evidence/evidence-sanitizer";
import { newEvidenceId } from "@/shared/ids";
import { getDatabase } from "@/db/client";

const MAX_RESPONSE_LENGTH = 8192;
const DEFAULT_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 5;

export const readEvidenceTool: ToolDef = {
  name: "read_evidence",
  description:
    "Read sanitized evidence details from the Evidence Ledger. " +
    "Supports reading by evidenceId, or listing evidence for the current task attempt. " +
    "Use 'page' and 'pageSize' for paginated listing. " +
    "Returns cleaned payload only — secrets and raw binary data are never included.",
  parameters: {
    type: "object",
    properties: {
      evidenceId: {
        type: "string",
        description: "Specific evidence ID to read (e.g. ev_xxx). Takes precedence over listing.",
      },
      page: {
        type: "number",
        description: "Page number for listing evidence (1-based). Only used when evidenceId is not provided.",
      },
      pageSize: {
        type: "number",
        description: `Number of evidence items per page (1-${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE}).`,
      },
    },
  },
  handler: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
    const evidenceId = getStr(args, "evidenceId");

    // ── Single evidence read ────────────────────────────────────────────
    if (evidenceId) {
      const record = getEvidence(evidenceId);
      if (!record) {
        return { ok: false, error: `Evidence "${evidenceId}" not found.` };
      }

      // Security: cross-conversation check
      if (record.conversationId !== ctx.conversationId) {
        return { ok: false, error: "Access denied: evidence belongs to a different conversation." };
      }

      // P1 access control: must be the producer task, a direct downstream task,
      // or a failure-context referenced task within the same conductor run
      const accessError = checkEvidenceAccess(record, ctx);
      if (accessError) {
        return { ok: false, error: accessError };
      }

      // Audit: record evidence_read
      recordEvidenceRead(ctx, record);

      return formatEvidenceResponse(record);
    }

    // ── Paginated listing ───────────────────────────────────────────────
    if (ctx.taskExecution) {
      const page = Math.max(1, getNum(args, "page") ?? 1);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, getNum(args, "pageSize") ?? DEFAULT_PAGE_SIZE));

      const allEvidence = listEvidenceForAttempt(ctx.taskExecution.attemptId);
      const total = allEvidence.length;
      const totalPages = Math.ceil(total / pageSize);
      const start = (page - 1) * pageSize;
      const pageItems = allEvidence.slice(start, start + pageSize);

      return {
        ok: true,
        value: {
          items: pageItems.map((rec) => ({
            evidenceId: rec.id,
            type: rec.type,
            status: rec.status,
            trustLevel: rec.trustLevel,
            subjectType: rec.subjectType,
            subjectId: rec.subjectId,
            contentHash: rec.contentHash,
            createdAt: rec.createdAt,
          })),
          pagination: {
            page,
            pageSize,
            total,
            totalPages,
            hasMore: page < totalPages,
          },
        },
      };
    }

    return { ok: false, error: "Provide evidenceId for single read, or run as a child task for listing." };
  },
};

// ── Access Control ────────────────────────────────────────────────────────

function checkEvidenceAccess(
  record: EvidenceRecord,
  ctx: ToolContext
): string | null {
  if (!ctx.taskExecution) return null; // Non-task runs: basic conversation check only

  // Same task + same attempt: always allowed (producer)
  if (record.taskId === ctx.taskExecution.taskId &&
      record.attemptId === ctx.taskExecution.attemptId) {
    return null;
  }

  // Different conductor run: deny
  if (record.conductorRunId !== ctx.taskExecution.conductorRunId) {
    return "Access denied: evidence belongs to a different conductor run.";
  }

  // Same conductor run but different task: must be a DAG downstream task
  if (isDownstreamTask(ctx.taskExecution.taskId, record.taskId, record.planId, record.conductorRunId)) {
    return null;
  }

  return "Access denied: you are not the producer nor a direct downstream task of this evidence.";
}

/**
 * P1: Check if requestorTaskId is a direct downstream of producerTaskId
 * per the DAG plan. Looks up the orchestration_plans table.
 */
function isDownstreamTask(
  requestorTaskId: string,
  producerTaskId: string,
  _planId: string,
  conductorRunId: string
): boolean {
  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        "SELECT plan_json FROM orchestration_plans WHERE orchestrator_run_id = ? ORDER BY revision DESC LIMIT 1"
      )
      .all(conductorRunId) as Array<{ plan_json: string }>;

    for (const row of rows) {
      try {
        const plan = JSON.parse(row.plan_json) as Array<{
          id: string;
          dependsOn?: string[];
        }>;
        const requestorTask = plan.find((t) => t.id === requestorTaskId);
        if (requestorTask?.dependsOn?.includes(producerTaskId)) {
          return true;
        }
      } catch {
        // Skip unparseable plans
      }
    }
  } catch {
    // DB not available — deny downstream access
  }
  return false;
}

// ── Audit Logging ─────────────────────────────────────────────────────────

function recordEvidenceRead(
  ctx: ToolContext,
  record: EvidenceRecord
) {
  if (!ctx.taskExecution) return;

  try {
    const identity = ctx.taskExecution;
    insertEvidence({
      id: newEvidenceId(),
      conversationId: ctx.conversationId,
      conductorRunId: identity.conductorRunId,
      planId: identity.planId,
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      childRunId: ctx.runId,
      contextSnapshotId: identity.contextSnapshotId,
      agentId: ctx.agentId,
      type: "evidence_read",
      status: "valid",
      trustLevel: "verified",
      sourceKind: "tool_call",
      sourceId: `read_evidence_${Date.now()}`,
      subjectType: "evidence",
      subjectId: record.id,
      payloadJson: JSON.stringify({
        readEvidenceId: record.id,
        readEvidenceType: record.type,
        readByAgentId: ctx.agentId,
      }),
      contentHash: null,
      invalidatedAt: null,
      createdAt: Date.now(),
    });
  } catch {
    // Audit logging failure must never block the read
  }
}

// ── Response Formatting ───────────────────────────────────────────────────

function formatEvidenceResponse(
  record: EvidenceRecord
): ToolResult {
  let payloadText = record.payloadJson;
  payloadText = sanitizeText(payloadText);

  if (payloadText.length > MAX_RESPONSE_LENGTH) {
    payloadText =
      payloadText.slice(0, MAX_RESPONSE_LENGTH) +
      `\n... [truncated ${payloadText.length - MAX_RESPONSE_LENGTH} chars]`;
  }

  return {
    ok: true,
    value: {
      evidenceId: record.id,
      type: record.type,
      status: record.status,
      trustLevel: record.trustLevel,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      contentHash: record.contentHash,
      createdAt: record.createdAt,
      payload: safeJsonParse(payloadText) ?? { _raw: payloadText },
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getStr(v: unknown, key: string): string {
  if (v && typeof v === "object" && key in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)[key]);
  }
  return "";
}

function getNum(v: unknown, key: string): number | null {
  if (v && typeof v === "object" && key in (v as Record<string, unknown>)) {
    const val = (v as Record<string, unknown>)[key];
    if (typeof val === "number") return val;
    const parsed = Number(val);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
