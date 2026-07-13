import type { ContextTraceEvidenceSummary } from "@/server/context-trace/context-trace-types";

import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

const TOOL_EVIDENCE_TYPES: Record<string, string[]> = {
  fs_read: ["file_read"],
  fs_write: ["file_written"],
  fs_patch: ["file_written"],
  bash: ["command_executed", "test_executed"],
  read_artifact: ["artifact_read"],
  write_artifact: ["artifact_created"],
  deploy_artifact: ["deployment_created"],
  deploy_workspace: ["deployment_created"],
  ask_user: ["user_answered"],
  report_task_result: ["task_reported"],
};

export const toolSucceededGrader: BenchmarkGrader = {
  type: "tool_succeeded",
  grade(assertion, context) {
    if (assertion.type !== "tool_succeeded") throw new Error("toolSucceededGrader received an incompatible assertion.");
    const evidenceTypes = TOOL_EVIDENCE_TYPES[assertion.toolName] ?? [assertion.toolName];
    const tasks = assertion.role ? findTasksByRole(context.trace.tasks, assertion.role) : context.trace.tasks;
    let matchedEvidence: ContextTraceEvidenceSummary | undefined;
    let matchedTaskId: string | undefined;

    for (const task of tasks) {
      matchedEvidence = task.evidence.find((evidence) =>
        evidenceTypes.includes(evidence.type) &&
        evidence.status === "valid" &&
        (!assertion.commandPattern || safePatternTest(assertion.commandPattern, evidence.excerpt))
      );
      if (matchedEvidence) {
        matchedTaskId = task.taskId;
        break;
      }
    }

    return assertionResult(
      assertion,
      !!matchedEvidence,
      matchedEvidence
        ? `Valid ${assertion.toolName} evidence was recorded.`
        : `No valid ${assertion.toolName} evidence${assertion.role ? ` for role ${assertion.role}` : ""} was found.`,
      matchedEvidence
        ? [{
            runId: context.trace.conductorRunId,
            taskId: matchedTaskId,
            evidenceId: matchedEvidence.evidenceId,
            toolCallId: matchedEvidence.sourceId,
          }]
        : [],
    );
  },
};

function safePatternTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}
