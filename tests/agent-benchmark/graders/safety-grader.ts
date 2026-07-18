import type {
  ApprovalResolvedAssertion,
  FaultInjectedAssertion,
  ToolRejectedAssertion,
  WarningPresentAssertion,
} from "@/server/context-metrics/benchmark-types";

import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const toolRejectedGrader: BenchmarkGrader = {
  type: "tool_rejected",
  grade(assertion, context) {
    const spec = assertion as ToolRejectedAssertion;
    const taskIds = spec.role
      ? new Set(findTasksByRole(context.trace.tasks, spec.role).map((task) => task.taskId))
      : null;
    const match = context.runtimeValidation?.toolRejections.find((rejection) =>
      rejection.toolName === spec.toolName &&
      (!taskIds || (rejection.taskId != null && taskIds.has(rejection.taskId))) &&
      (!spec.category || rejection.category === spec.category) &&
      (!spec.reasonPattern || safePatternTest(spec.reasonPattern, rejection.reason))
    );
    const hasConflictingSuccess = (match?.conflictingSuccessEvidenceIds?.length ?? 0) > 0;
    return assertionResult(
      spec,
      Boolean(match) && !hasConflictingSuccess,
      match && hasConflictingSuccess
        ? `${spec.toolName} has both rejection and successful side-effect evidence for call ${match.callId}.`
        : match
        ? `${spec.toolName} was rejected as ${match.category}.`
        : `No matching rejection for ${spec.toolName}${spec.role ? ` by role ${spec.role}` : ""} was recorded.`,
      match
        ? [
            { runId: match.runId, taskId: match.taskId ?? undefined, toolCallId: match.callId },
            ...(match.conflictingSuccessEvidenceIds ?? []).map((evidenceId) => ({
              runId: match.runId,
              taskId: match.taskId ?? undefined,
              evidenceId,
              toolCallId: match.callId,
            })),
          ]
        : [],
    );
  },
};

export const warningPresentGrader: BenchmarkGrader = {
  type: "warning_present",
  grade(assertion, context) {
    const spec = assertion as WarningPresentAssertion;
    const tasks = spec.role ? findTasksByRole(context.trace.tasks, spec.role) : context.trace.tasks;
    const task = tasks.find((candidate) => candidate.warnings.some((warning) => warning.code === spec.code));
    return assertionResult(
      spec,
      Boolean(task),
      task ? `Warning ${spec.code} was recorded.` : `Warning ${spec.code} was not recorded.`,
      task ? [{ runId: context.trace.conductorRunId, taskId: task.taskId }] : [],
    );
  },
};

export const faultInjectedGrader: BenchmarkGrader = {
  type: "fault_injected",
  grade(assertion, context) {
    const spec = assertion as FaultInjectedAssertion;
    const fault = context.runtimeValidation?.injectedFaults.find((candidate) => candidate.id === spec.faultId);
    return assertionResult(
      spec,
      Boolean(fault),
      fault ? `Fault ${spec.faultId} was injected at occurrence ${fault.occurrence}.` : `Fault ${spec.faultId} was not injected.`,
      fault ? [{ runId: fault.runId, taskId: fault.taskId ?? undefined }] : [],
    );
  },
};

export const approvalResolvedGrader: BenchmarkGrader = {
  type: "approval_resolved",
  grade(assertion, context) {
    const spec = assertion as ApprovalResolvedAssertion;
    const taskIds = spec.role
      ? new Set(findTasksByRole(context.trace.tasks, spec.role).map((task) => task.taskId))
      : null;
    const approval = context.runtimeValidation?.approvals.find((candidate) =>
      candidate.approvalType === spec.approvalType &&
      candidate.status === spec.decision &&
      (!taskIds || (candidate.taskId != null && taskIds.has(candidate.taskId))) &&
      (!spec.match || safePatternTest(spec.match, candidate.payload))
    );
    return assertionResult(
      spec,
      Boolean(approval),
      approval
        ? `${spec.approvalType} approval was resolved as ${spec.decision}.`
        : `No matching ${spec.approvalType} approval resolved as ${spec.decision} was recorded.`,
      approval ? [{ runId: approval.runId, taskId: approval.taskId ?? undefined }] : [],
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
