// ---------------------------------------------------------------------------
// P1: Unified Evidence Collector
//
// Called from the Tool Registry after every tool execution.
// Collects evidence regardless of success/failure — diagnostic evidence
// is as important as valid evidence.
// ---------------------------------------------------------------------------

import type { ToolContext } from "@/server/tools/types";
import { newEvidenceId } from "@/shared/ids";
import {
  insertEvidence,
  type EvidenceRecord,
} from "@/server/repositories/evidence-repository";
import { EXTRACTOR_MAP, type ExtractedEvidence } from "@/server/evidence/evidence-extractors";

export interface EvidenceCaptureInput {
  toolName: string;
  args: unknown;
  result: unknown;
  context: ToolContext;
  durationMs: number;
  /** Call ID from the LLM tool call, if available */
  callId?: string;
}

/**
 * Capture evidence for a tool execution.
 * - Only captures when taskExecution is present (child task runs).
 * - Tool failures produce diagnostic/invalid evidence, not skipped.
 * - Evidence insert failure is logged but never blocks the task.
 */
export async function captureEvidence(input: EvidenceCaptureInput): Promise<void> {
  const { toolName, args, result, context, durationMs, callId } = input;

  // Only capture for child task runs with task identity
  if (!context.taskExecution) return;

  const extractor = EXTRACTOR_MAP[toolName];
  if (!extractor) return; // No extractor for this tool — skip silently

  const identity = context.taskExecution;

  try {
    const extracted = extractor(context, args, result, durationMs);
    if (!extracted) return;

    const items = Array.isArray(extracted) ? extracted : [extracted];

    for (const item of items) {
      const evidenceId = newEvidenceId();
      const now = Date.now();

      const record: EvidenceRecord = {
        id: evidenceId,
        conversationId: context.conversationId,
        conductorRunId: identity.conductorRunId,
        planId: identity.planId,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        childRunId: context.runId,
        contextSnapshotId: identity.contextSnapshotId,
        agentId: context.agentId,
        type: item.type,
        status: extractEvidenceStatus(result),
        trustLevel: item.type === "task_reported" ? "reported" : "verified",
        sourceKind: "tool_call",
        sourceId: callId ?? `${toolName}_${now}`,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        payloadJson: JSON.stringify(item.payload),
        contentHash: item.contentHash,
        invalidatedAt: null,
        createdAt: now,
      };

      try {
        insertEvidence(record);
      } catch (err) {
        // Evidence insert failure must never propagate or block task
        console.error(`[evidence-collector] failed to persist evidence ${evidenceId} (${item.type}):`, err);
      }
    }
  } catch (err) {
    // Extractor failure must never block task execution
    console.error(`[evidence-collector] extractor failed for tool "${toolName}":`, err);
  }
}

function extractEvidenceStatus(result: unknown): "valid" | "invalid" | "diagnostic" {
  if (result && typeof result === "object" && "ok" in result) {
    return (result as { ok: boolean }).ok ? "valid" : "invalid";
  }
  return "valid";
}
