// ---------------------------------------------------------------------------
// P1: Task State Builder — constructs TaskState from compiler input + DB state
// ---------------------------------------------------------------------------

import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { ResolvedInput } from "@/server/child-prompt-builder";
import type { TaskState, TaskStateInput, TaskStateCriterion } from "@/server/task-state/task-state-types";
import { listCriterionVerdicts, listEvidenceForAttempt } from "@/server/repositories/evidence-repository";
import { getArtifact } from "@/server/repositories";
import type { CriterionVerdict } from "@/shared/evidence-types";
import { detectAgentRole } from "@/server/agent-contracts/role-contracts";

export interface TaskStateBuilderInput {
  task: ParsedTask;
  resolvedInputs: ResolvedInput[];
  attemptId: string;
  attempt: number;
  planId?: string;
  previousAttemptId?: string;
  previousError?: string;
  agentCapabilities: string[];
  agentName?: string;
}

export function buildTaskState(input: TaskStateBuilderInput): TaskState {
  const { task, resolvedInputs, attemptId, attempt } = input;

  // ── Inputs ──────────────────────────────────────────────────────────────
  const requiredInputs: TaskStateInput[] = [];
  const availableInputs: TaskStateInput[] = [];
  const missingInputs: TaskStateInput[] = [];
  const unreadInputs: TaskStateInput[] = [];

  for (const ri of resolvedInputs) {
    const art = ri.artifactId ? getArtifact(ri.artifactId) : null;
    const tsi: TaskStateInput = {
      key: `${ri.fromTaskId}.${ri.outputId}`,
      artifactId: ri.artifactId ?? "",
      title: art?.title ?? ri.outputId,
      available: !ri.missing,
      read: false,
    };
    requiredInputs.push(tsi);
    if (ri.missing) {
      missingInputs.push(tsi);
    } else {
      availableInputs.push(tsi);
    }
  }

  // ── Read status ─────────────────────────────────────────────────────────
  try {
    const evidence = listEvidenceForAttempt(attemptId);
    const readArtifactIds = new Set<string>();
    for (const ev of evidence) {
      if (ev.type === "artifact_read") {
        try {
          const p = JSON.parse(ev.payloadJson) as Record<string, unknown>;
          if (p.artifactId) readArtifactIds.add(p.artifactId as string);
        } catch { /* ok */ }
      }
    }
    for (const tsi of availableInputs) {
      if (tsi.artifactId && readArtifactIds.has(tsi.artifactId)) {
        tsi.read = true;
      }
    }
    for (const tsi of availableInputs) {
      if (!tsi.read) unreadInputs.push(tsi);
    }
  } catch { /* best-effort */ }

  // ── Criteria ────────────────────────────────────────────────────────────
  const passedCriteria: TaskStateCriterion[] = [];
  const failedCriteria: TaskStateCriterion[] = [];
  try {
    const rawVerdicts = listCriterionVerdicts(attemptId);
    for (const v of rawVerdicts) {
      const tsc: TaskStateCriterion = {
        criterionId: v.criterionId,
        description: v.reason || v.criterionId,
        passed: v.status === "passed",
      };
      if (v.status === "passed") passedCriteria.push(tsc);
      else failedCriteria.push(tsc);
    }
  } catch { /* best-effort */ }

  // ── Changed files / failed commands ─────────────────────────────────────
  const changedFiles: string[] = [];
  const failedCommands: TaskState["failedCommands"] = [];
  try {
    const evidence = listEvidenceForAttempt(attemptId);
    for (const ev of evidence) {
      if (ev.type === "file_written" && ev.status === "valid") {
        changedFiles.push(ev.subjectId);
      }
      if ((ev.type === "command_executed" || ev.type === "test_executed") && ev.status !== "valid") {
        try {
          const p = JSON.parse(ev.payloadJson) as Record<string, unknown>;
          failedCommands.push({
            command: (p.command as string) ?? ev.subjectId,
            exitCode: (p.exitCode as number) ?? -1,
            summary: `Command failed with exit code ${p.exitCode ?? "unknown"}`,
          });
        } catch { /* ok */ }
      }
    }
  } catch { /* best-effort */ }

  // ── Role ────────────────────────────────────────────────────────────────
  const role = detectAgentRole(input.agentCapabilities, input.agentName);

  // ── Execution status ────────────────────────────────────────────────────
  let executionStatus: TaskState["executionStatus"] = "new";
  if (attempt > 1) {
    executionStatus = "retrying";
  } else if (missingInputs.length > 0) {
    executionStatus = "blocked";
  }

  // ── Next action hint ────────────────────────────────────────────────────
  const nextActionHint = buildNextActionHint(unreadInputs, missingInputs, failedCriteria, failedCommands, attempt);

  return {
    taskId: task.id,
    planId: input.planId ?? "",
    agentId: task.agentId,
    role,
    objective: task.title || task.prompt.slice(0, 100),
    executionStatus,
    attempt,
    requiredInputs,
    availableInputs,
    missingInputs,
    unreadInputs,
    passedCriteria,
    failedCriteria,
    changedFiles,
    failedCommands,
    nextActionHint,
  };
}

function buildNextActionHint(
  unreadInputs: TaskStateInput[],
  missingInputs: TaskStateInput[],
  failedCriteria: TaskStateCriterion[],
  failedCommands: TaskState["failedCommands"],
  attempt: number,
): string {
  const hints: string[] = [];
  if (unreadInputs.length > 0) {
    hints.push(`Read ${unreadInputs.length} available but unread upstream artifact(s): ${unreadInputs.map((u) => u.key).join(", ")}`);
  }
  if (missingInputs.length > 0) {
    hints.push(`Missing ${missingInputs.length} required input(s): ${missingInputs.map((m) => m.key).join(", ")}. The task cannot proceed until upstream tasks complete.`);
  }
  if (failedCriteria.length > 0) {
    hints.push(`Fix ${failedCriteria.length} failed criterion/criteria: ${failedCriteria.map((f) => f.criterionId).join(", ")}`);
  }
  if (failedCommands.length > 0) {
    hints.push(`Failed commands: ${failedCommands.map((fc) => `${fc.command} (exit ${fc.exitCode})`).join("; ")}`);
  }
  if (attempt > 1) {
    hints.push(`This is attempt ${attempt}. Do not redo work that already passed.`);
  }
  if (hints.length === 0) {
    hints.push("All inputs available and read. Proceed with the task.");
  }
  return hints.join(" ");
}
