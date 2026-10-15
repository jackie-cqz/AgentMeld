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

  const identity = context.taskExecution;

  try {
    const extractor = EXTRACTOR_MAP[toolName];
    const extracted = extractor?.(context, args, result, durationMs) ?? null;
    const items = extracted
      ? (Array.isArray(extracted) ? [...extracted] : [extracted])
      : [];
    const rejection = extractToolRejection(toolName, args, result);
    if (rejection) items.push(rejection);
    if (items.length === 0) return;

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
        status: item.status ?? extractEvidenceStatus(result),
        trustLevel: item.trustLevel ?? (item.type === "task_reported" ? "reported" : "verified"),
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

function extractToolRejection(
  toolName: string,
  args: unknown,
  result: unknown,
): ExtractedEvidence | null {
  if (!result || typeof result !== "object" || !("ok" in result)) return null;
  const failure = result as {
    ok?: boolean;
    error?: unknown;
    code?: unknown;
    category?: unknown;
  };
  if (failure.ok !== false) return null;

  const reason = typeof failure.error === "string"
    ? failure.error
    : "Tool execution failed.";
  const code = typeof failure.code === "string"
    ? failure.code
    : inferFailureCode(toolName, reason);
  const category = isFailureCategory(failure.category)
    ? failure.category
    : inferFailureCategory(reason);

  return {
    type: "tool_rejected",
    subjectType: "tool",
    subjectId: toolName,
    payload: {
      toolName,
      category,
      code,
      reason,
      argsSummary: summarizeArgs(args),
      sideEffectApplied: false,
    },
    contentHash: null,
  };
}

function isFailureCategory(
  value: unknown,
): value is "security_policy" | "approval_rejected" | "validation_error" | "tool_error" {
  return value === "security_policy"
    || value === "approval_rejected"
    || value === "validation_error"
    || value === "tool_error";
}

function inferFailureCategory(
  reason: string,
): "security_policy" | "approval_rejected" | "validation_error" | "tool_error" {
  if (/reject|declin|cancel|拒绝|取消/i.test(reason)) return "approval_rejected";
  if (/security policy|verification-only|source mutation|outside.*workspace|escapes?.*workspace|path traversal|blocked|越界|安全策略/i.test(reason)) {
    return "security_policy";
  }
  if (/invalid args|validation|oldText|not found|matched \d+ locations/i.test(reason)) {
    return "validation_error";
  }
  return "tool_error";
}

function inferFailureCode(toolName: string, reason: string): string {
  if (toolName === "bash" && /source mutation|verification-only/i.test(reason)) {
    return "BASH_SOURCE_MUTATION_BLOCKED";
  }
  if (/outside.*workspace|escapes?.*workspace|path traversal|越界/i.test(reason)) {
    return "WORKSPACE_PATH_ESCAPE";
  }
  if (/user rejected|approval.*reject|用户拒绝/i.test(reason)) {
    return "APPROVAL_REJECTED";
  }
  if (/invalid args/i.test(reason)) return "TOOL_ARGUMENTS_INVALID";
  return "TOOL_EXECUTION_FAILED";
}

function summarizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const value = args as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["path", "file_path", "outputKey", "artifactId", "command"]) {
    const item = value[key];
    if (typeof item !== "string") continue;
    summary[key] = item.slice(0, key === "command" ? 500 : 240);
  }
  return summary;
}
